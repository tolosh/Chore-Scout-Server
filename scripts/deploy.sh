#!/usr/bin/env bash
# Digest-pinned dev deploy of chore-scout-server (CS-3992).
#
# Follows the verified moroku-dsl pattern (CS-3927, CS-3933) with the CS-3991
# lessons built in:
#   - the image is tagged with the FULL commit SHA and every task definition is
#     pinned to repo@sha256:<digest>, never to a tag;
#   - the rollback image is recorded BY DIGEST, resolved from the task
#     definition the service runs now; a tag there is refused before anything
#     is built, pushed or changed;
#   - after update-service the script waits for the service to be stable
#     whenever desiredCount > 0, and fails otherwise.
#
# Order: guards -> rollback point -> build and push -> register the API and
# migrate task definitions -> run the migrate task and wait for exit 0 ->
# update the service -> stable wait -> summary. A failure before the
# update-service step leaves the running service untouched.
#
# The service must be ACTIVE. Any other state fails the run, with one opt-in
# exception: DEPLOY_BOOTSTRAP=1 (the workflow's bootstrap input) allows a first
# run when the service is MISSING (runbook A6 not done yet). A bootstrap run
# pushes the image and registers both task definitions, then stops: nothing is
# deployed and nothing is migrated, and it says so as a ::warning:: and in the
# job summary. DRAINING or INACTIVE always fail, bootstrap or not, and so does
# bootstrap against an ACTIVE service.
#
# The service must have assignPublicIp DISABLED (D48: internal only); the
# migrate task uses the same networking.
#
# Usage: DEPLOY_BOOTSTRAP=0|1 scripts/deploy.sh <full 40-character commit SHA>
# Run by .github/workflows/deploy.yml with short-lived OIDC credentials. No
# credentials or secret values appear here: the containers read
# chore-scout-server/api at run time through CS_SECRETS_ID.
set -euo pipefail
shopt -s inherit_errexit

ACCOUNT=932027117528
REGION=ap-southeast-2
REGISTRY=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com
REPO_NAME=chore-scout-server
REPO=$REGISTRY/$REPO_NAME
CLUSTER=moroku-dsl-dev
SERVICE=chore-scout-api
API_CONTAINER=chore-scout-api
MIGRATE_CONTAINER=chore-scout-migrate
API_TEMPLATE=infra/ecs-task-definition.api.json
MIGRATE_TEMPLATE=infra/ecs-task-definition.migrate.json
PLACEHOLDER=__IMAGE_PINNED_AT_DEPLOY__

die() {
  echo "deploy: ERROR: $*" >&2
  exit 1
}

# The full 40-character lowercase commit SHA. Short SHAs and tags are refused.
require_full_sha() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || die "a full 40-character commit SHA is required, got '${1:-}'"
}

# An ECR image digest: sha256: followed by 64 lowercase hex characters.
require_digest() {
  [[ "${1:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "not an image digest: '${1:-}'"
}

# An image reference in this repo pinned by digest (repo@sha256:...). A tag
# (repo:tag), a digest in another repo or anything else is refused.
require_digest_ref() {
  local ref=${1:-}
  [[ "$ref" == "$REPO@sha256:"* && "${ref#"$REPO@"}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "image is not pinned by digest in $REPO: '$ref' (refusing a tag)"
}

# Render a task definition template with the pinned image into a temp file.
render_task_definition() {
  local template=$1 image=$2 out
  require_digest_ref "$image"
  [[ "$(jq -r '.containerDefinitions[0].image' "$template")" == "$PLACEHOLDER" ]] \
    || die "$template must carry the image placeholder $PLACEHOLDER"
  out=$(mktemp)
  jq --arg image "$image" '.containerDefinitions[0].image = $image' "$template" >"$out"
  echo "$out"
}

register_task_definition() {
  local template=$1 image=$2 rendered arn registered_image
  local out rc=0
  rendered=$(render_task_definition "$template" "$image")
  out=$(aws ecs register-task-definition \
    --cli-input-json "file://$rendered" --region "$REGION" \
    --query '[taskDefinition.taskDefinitionArn, taskDefinition.containerDefinitions[0].image]' \
    --output text) || rc=$?
  rm -f "$rendered"
  [[ "$rc" == 0 ]] || die "register-task-definition failed for $template (exit $rc)"
  read -r arn registered_image <<<"$out"
  [[ "$registered_image" == "$image" ]] || die "registered $arn pins '$registered_image', expected '$image'"
  echo "$arn"
}

summary() {
  local lines=(
    "sha: $SHA"
    "digest: ${DIGEST:-none}"
    "image: ${IMAGE:-none}"
    "task definition (api): ${API_TD:-none}"
    "task definition (migrate): ${MIGRATE_TD:-none}"
    "migrate exit code: $MIGRATE_EXIT"
    "stable wait: $STABLE"
    "rollback digest: $ROLLBACK_DIGEST"
    "rollback task definition: $PREV_TD"
  )
  if [[ "${BOOTSTRAP_RUN:-0}" == 1 ]]; then
    lines+=("BOOTSTRAP: nothing deployed, no migration")
  fi
  echo "== deploy summary =="
  printf '  %s\n' "${lines[@]}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    { echo "### chore-scout-server deploy"; printf -- '- %s\n' "${lines[@]}"; } >>"$GITHUB_STEP_SUMMARY"
  fi
}

main() {
  SHA=${1:-}
  require_full_sha "$SHA"
  local want_bootstrap=${DEPLOY_BOOTSTRAP:-0}
  [[ "$want_bootstrap" == 0 || "$want_bootstrap" == 1 ]] || die "DEPLOY_BOOTSTRAP must be 0 or 1, got '$want_bootstrap'"
  BOOTSTRAP_RUN=0
  cd "$(dirname "${BASH_SOURCE[0]}")/.."

  local head
  head=$(git rev-parse HEAD)
  [[ "$head" == "$SHA" ]] || die "checked-out HEAD $head is not $SHA"
  for cmd in aws docker jq; do
    command -v "$cmd" >/dev/null || die "$cmd is required"
  done
  [[ -f "$API_TEMPLATE" && -f "$MIGRATE_TEMPLATE" ]] || die "task definition templates missing"

  DIGEST="" IMAGE="" API_TD="" MIGRATE_TD="" MIGRATE_EXIT="not run" STABLE="not run"
  ROLLBACK_DIGEST="" PREV_TD=""

  # 1. The rollback point, before anything changes.
  echo "Reading $CLUSTER/$SERVICE (rollback point)..."
  local svc status desired netcfg
  svc=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" --output json)
  # ACTIVE, DRAINING or INACTIVE come back in services[]; a service that was
  # never created comes back as failures[].reason == MISSING.
  status=$(jq -r '
    if (.services | length) > 0 then .services[0].status
    elif ([.failures[]?.reason] | index("MISSING")) != null then "MISSING"
    else "UNKNOWN" end' <<<"$svc")
  if [[ "$status" == "ACTIVE" && "$want_bootstrap" == 1 ]]; then
    die "bootstrap was requested but $CLUSTER/$SERVICE is ACTIVE; run again without bootstrap"
  fi
  if [[ "$status" == "ACTIVE" ]]; then
    PREV_TD=$(jq -r '.services[0].taskDefinition' <<<"$svc")
    netcfg=$(jq -c '.services[0].networkConfiguration' <<<"$svc")
    [[ "$(jq -r '.awsvpcConfiguration.subnets | length' <<<"$netcfg")" -gt 0 ]] \
      || die "$SERVICE has no awsvpc subnets; cannot place the migrate task"
    [[ "$(jq -r '.awsvpcConfiguration.assignPublicIp' <<<"$netcfg")" == DISABLED ]] \
      || die "$SERVICE must have assignPublicIp DISABLED (D48: internal only)"
    local prev_image
    prev_image=$(aws ecs describe-task-definition --task-definition "$PREV_TD" --region "$REGION" \
      --query "taskDefinition.containerDefinitions[?name=='$API_CONTAINER'].image | [0]" --output text)
    require_digest_ref "$prev_image"
    ROLLBACK_DIGEST=${prev_image#"$REPO@"}
    echo "Rollback task definition: $PREV_TD"
    echo "Rollback digest:          $ROLLBACK_DIGEST"
  elif [[ "$status" == "MISSING" && "$want_bootstrap" == 1 ]]; then
    BOOTSTRAP_RUN=1
    PREV_TD="none (service $SERVICE does not exist)"
    ROLLBACK_DIGEST="none (service $SERVICE does not exist)"
    echo "::warning::BOOTSTRAP: $CLUSTER/$SERVICE does not exist. Registering task definitions only; nothing deployed, no migration."
  elif [[ "$status" == "MISSING" ]]; then
    die "$CLUSTER/$SERVICE does not exist. For the first run only, run the workflow with bootstrap, create the service (runbook A6), then run it again without bootstrap"
  else
    die "$CLUSTER/$SERVICE status is $status; refusing to deploy (only ACTIVE deploys; bootstrap applies only to MISSING)"
  fi

  # 2. Build and push :<full SHA>, then resolve the digest. The repo is
  #    immutable, so a SHA already pushed by an earlier run is reused as is.
  echo "Authenticating to ECR..."
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

  local existing err
  err=$(mktemp)
  if existing=$(aws ecr describe-images --repository-name "$REPO_NAME" --image-ids imageTag="$SHA" \
    --region "$REGION" --query 'imageDetails[0].imageDigest' --output text 2>"$err"); then
    echo "Image $REPO:$SHA already exists (immutable tag); reusing it."
  elif grep -q ImageNotFoundException "$err"; then
    echo "Building $REPO:$SHA for linux/amd64..."
    docker build --platform linux/amd64 --build-arg GIT_SHA="$SHA" -t "$REPO:$SHA" .
    docker push "$REPO:$SHA"
    existing=$(aws ecr describe-images --repository-name "$REPO_NAME" --image-ids imageTag="$SHA" \
      --region "$REGION" --query 'imageDetails[0].imageDigest' --output text)
  else
    cat "$err" >&2
    die "could not look up $REPO:$SHA"
  fi
  rm -f "$err"
  DIGEST=$existing
  require_digest "$DIGEST"
  IMAGE="$REPO@$DIGEST"
  echo "Pinned image: $IMAGE"

  # 3. Register both task definitions pinned to the digest.
  API_TD=$(register_task_definition "$API_TEMPLATE" "$IMAGE")
  MIGRATE_TD=$(register_task_definition "$MIGRATE_TEMPLATE" "$IMAGE")
  echo "Registered: $API_TD"
  echo "Registered: $MIGRATE_TD"

  if [[ "$BOOTSTRAP_RUN" == 1 ]]; then
    MIGRATE_EXIT="not run (bootstrap)"
    summary
    echo "BOOTSTRAP: create $CLUSTER/$SERVICE at desired 0 on $API_TD (runbook A6), then run the workflow again without bootstrap."
    return 0
  fi

  # 4. The one-shot migrate task, on the service's own networking.
  echo "Running the migrate task..."
  local run task_arn tasks reason
  run=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$MIGRATE_TD" --launch-type FARGATE \
    --count 1 --started-by "deploy-${SHA:0:12}" --network-configuration "$netcfg" \
    --region "$REGION" --output json)
  [[ "$(jq '.failures | length' <<<"$run")" == 0 ]] || die "run-task failed: $(jq -c '.failures' <<<"$run")"
  task_arn=$(jq -r '.tasks[0].taskArn' <<<"$run")
  [[ -n "$task_arn" && "$task_arn" != null ]] || die "run-task returned no task"
  echo "Migrate task: $task_arn"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn" --region "$REGION" \
    || die "migrate task $task_arn did not stop in time; service not updated"
  tasks=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" --region "$REGION" --output json)
  MIGRATE_EXIT=$(jq -r --arg n "$MIGRATE_CONTAINER" \
    '[.tasks[0].containers[] | select(.name == $n) | .exitCode][0] // "none"' <<<"$tasks")
  reason=$(jq -r '.tasks[0].stoppedReason // ""' <<<"$tasks")
  if [[ "$MIGRATE_EXIT" != 0 ]]; then
    summary
    die "migrate task exit code $MIGRATE_EXIT ($reason); service not updated"
  fi

  # 5. Update the service, then wait for it to be stable if anything runs.
  echo "Updating $CLUSTER/$SERVICE to $API_TD..."
  local updated
  updated=$(aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$API_TD" \
    --region "$REGION" --output json)
  desired=$(jq -r '.service.desiredCount' <<<"$updated")
  if [[ "$desired" -gt 0 ]]; then
    echo "Waiting for services-stable (desired $desired)..."
    if aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION"; then
      STABLE="passed (desired $desired)"
    else
      STABLE="FAILED (desired $desired)"
      summary
      die "service did not become stable. Roll back with: aws ecs update-service --cluster $CLUSTER --service $SERVICE --task-definition $PREV_TD --region $REGION"
    fi
  else
    STABLE="not needed (desired 0, nothing started)"
  fi

  summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
