#!/usr/bin/env bash
# Digest-pinned deploy of ONE bank's allowance jobs service (CS-3992, CS-3979).
#
# What it does, for bank <tenant> (bank_bilgola or bank_manly):
#   - refuses anything but the full SHA of the checked-out commit;
#   - NEVER builds: the image chore-scout-server:<SHA> must already be in ECR,
#     pushed by the API deploy (scripts/deploy.sh) for the same SHA, and the API
#     service must already run that digest. So the database is migrated for this
#     code before any jobs task can use it, and API and jobs run one image;
#   - reads the jobs service chore-scout-jobs-<tenant> and records its rollback
#     task definition and digest (a tag is refused);
#   - requires the agreed jobs networking: public IP ENABLED (no NAT in dev,
#     D48 as amended) with exactly one security group, chore-scout-jobs-sg,
#     which has no inbound rules (outbound to BOB and DocumentDB only);
#   - registers chore-scout-jobs-<tenant> pinned to repo@sha256:<digest>, with
#     that bank's task role, secret and ALLOWANCE_TENANT_ID filled in;
#   - updates the service's task definition ONLY. It never sets a desired count,
#     so a stopped jobs service stays stopped (desired 0). Starting jobs is a
#     separate, explicit activation step in the runbook, never a deploy.
#   - A jobs service already running (desired > 0) is refused unless
#     JOBS_RUNNING_ACK=1: replacing a running allowance runner is a release
#     decision made after activation, not a side effect.
#
# The service must be ACTIVE. DEPLOY_BOOTSTRAP=1 is accepted only when it is
# MISSING: it registers the task definition and stops, so the operator can
# create the service at desired 0 on it (runbook J4).
#
# Usage: DEPLOY_BOOTSTRAP=0|1 JOBS_RUNNING_ACK=0|1 scripts/deploy-jobs.sh <full SHA> <tenant>
# No credentials or secret values appear here: the task reads
# chore-scout-server/jobs-<tenant> at run time through CS_SECRETS_ID.
set -euo pipefail
shopt -s inherit_errexit

# Shared constants and guards (require_full_sha, require_digest_ref,
# require_agreed_network, register_task_definition, die, ...). Sourcing does
# not run deploy.sh's main.
# shellcheck source=deploy.sh
source "$(dirname "${BASH_SOURCE[0]}")/deploy.sh"

API_SERVICE=chore-scout-api
JOBS_CONTAINER=chore-scout-jobs
JOBS_TEMPLATE=infra/ecs-task-definition.jobs.json
TENANT_PLACEHOLDER=__TENANT_ID__
# The banks a jobs service exists for. Add one only with a new decision.
KNOWN_TENANTS=(bank_bilgola bank_manly)
# Agreed jobs networking: same subnets and public IP as the API (no NAT in dev),
# but its own security group with no inbound rules.
EXPECTED_SECURITY_GROUP_NAME=chore-scout-jobs-sg

require_tenant() {
  local t
  for t in "${KNOWN_TENANTS[@]}"; do [[ "${1:-}" == "$t" ]] && return 0; done
  die "unknown bank '${1:-}'; expected one of: ${KNOWN_TENANTS[*]}"
}

# The jobs template with the bank filled in, written to a temp file.
render_jobs_template() {
  local tenant=$1 out
  out=$(mktemp)
  jq --arg t "$tenant" --arg p "$TENANT_PLACEHOLDER" 'walk(if type == "string" then gsub($p; $t) else . end)' "$JOBS_TEMPLATE" >"$out"
  ! grep -q "$TENANT_PLACEHOLDER" "$out" || die "jobs template still carries $TENANT_PLACEHOLDER after rendering"
  [[ "$(jq -r '.containerDefinitions[0].environment[] | select(.name == "ALLOWANCE_TENANT_ID") | .value' "$out")" == "$tenant" ]] \
    || die "rendered jobs task definition is not for $tenant"
  echo "$out"
}

jobs_summary() {
  local lines=(
    "bank: $TENANT"
    "service: $CLUSTER/$SERVICE"
    "sha: $SHA"
    "digest: ${DIGEST:-none}"
    "image: ${IMAGE:-none}"
    "task definition (jobs): ${JOBS_TD:-none}"
    "desired count: $DESIRED (unchanged by this deploy)"
    "stable wait: $STABLE"
    "rollback digest: $ROLLBACK_DIGEST"
    "rollback task definition: $PREV_TD"
  )
  if [[ "${BOOTSTRAP_RUN:-0}" == 1 ]]; then lines+=("BOOTSTRAP: nothing deployed; create the service at desired 0 (runbook J4)"); fi
  echo "== jobs deploy summary =="
  printf '  %s\n' "${lines[@]}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    { echo "### chore-scout jobs deploy ($TENANT)"; printf -- '- %s\n' "${lines[@]}"; } >>"$GITHUB_STEP_SUMMARY"
  fi
}

jobs_main() {
  SHA=${1:-}
  TENANT=${2:-}
  require_full_sha "$SHA"
  require_tenant "$TENANT"
  local want_bootstrap=${DEPLOY_BOOTSTRAP:-0} running_ack=${JOBS_RUNNING_ACK:-0}
  [[ "$want_bootstrap" == 0 || "$want_bootstrap" == 1 ]] || die "DEPLOY_BOOTSTRAP must be 0 or 1, got '$want_bootstrap'"
  [[ "$running_ack" == 0 || "$running_ack" == 1 ]] || die "JOBS_RUNNING_ACK must be 0 or 1, got '$running_ack'"
  SERVICE=chore-scout-jobs-$TENANT
  BOOTSTRAP_RUN=0
  cd "$(dirname "${BASH_SOURCE[0]}")/.."

  local head
  head=$(git rev-parse HEAD)
  [[ "$head" == "$SHA" ]] || die "checked-out HEAD $head is not $SHA"
  for cmd in aws jq; do command -v "$cmd" >/dev/null || die "$cmd is required"; done
  [[ -f "$JOBS_TEMPLATE" ]] || die "jobs task definition template missing"

  DIGEST="" IMAGE="" JOBS_TD="" STABLE="not run" DESIRED="n/a" ROLLBACK_DIGEST="" PREV_TD=""

  # 1. The image for this SHA must already exist (pushed by the API deploy). Never build here.
  local err
  err=$(mktemp)
  if DIGEST=$(aws ecr describe-images --repository-name "$REPO_NAME" --image-ids imageTag="$SHA" \
    --region "$REGION" --query 'imageDetails[0].imageDigest' --output text 2>"$err"); then
    :
  elif grep -q ImageNotFoundException "$err"; then
    rm -f "$err"
    die "$REPO:$SHA is not in ECR. Deploy the API for this SHA first (scripts/deploy.sh); the jobs deploy never builds"
  else
    cat "$err" >&2
    rm -f "$err"
    die "could not look up $REPO:$SHA"
  fi
  rm -f "$err"
  require_digest "$DIGEST"
  IMAGE="$REPO@$DIGEST"

  # 2. The API must run this digest already: its deploy ran the migrations for this code.
  local api api_td api_image
  api=$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SERVICE" --region "$REGION" --output json)
  [[ "$(jq -r '.services[0].status // "MISSING"' <<<"$api")" == ACTIVE ]] || die "$CLUSTER/$API_SERVICE is not ACTIVE; deploy the API first"
  api_td=$(jq -r '.services[0].taskDefinition' <<<"$api")
  api_image=$(aws ecs describe-task-definition --task-definition "$api_td" --region "$REGION" \
    --query "taskDefinition.containerDefinitions[?name=='$API_CONTAINER'].image | [0]" --output text)
  [[ "$api_image" == "$IMAGE" ]] \
    || die "$API_SERVICE runs '$api_image', not $IMAGE. Deploy the API (and its migrations) for $SHA first"
  echo "API runs $IMAGE ($api_td): migrations for this code are in place."

  # 3. The jobs service and its rollback point, before anything changes.
  local svc status netcfg prev_image
  svc=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" --output json)
  status=$(jq -r '
    if (.services | length) > 0 then .services[0].status
    elif ([.failures[]?.reason] | index("MISSING")) != null then "MISSING"
    else "UNKNOWN" end' <<<"$svc")
  if [[ "$status" == ACTIVE && "$want_bootstrap" == 1 ]]; then
    die "bootstrap was requested but $CLUSTER/$SERVICE is ACTIVE; run again without bootstrap"
  fi
  if [[ "$status" == ACTIVE ]]; then
    DESIRED=$(jq -r '.services[0].desiredCount' <<<"$svc")
    [[ "$DESIRED" =~ ^[0-9]+$ ]] || die "$SERVICE desiredCount is unreadable: '$DESIRED'"
    if [[ "$DESIRED" -gt 0 && "$running_ack" != 1 ]]; then
      die "$SERVICE is running (desired $DESIRED). Jobs stay stopped until activation; replacing a running runner needs JOBS_RUNNING_ACK=1 (runbook J7)"
    fi
    PREV_TD=$(jq -r '.services[0].taskDefinition' <<<"$svc")
    netcfg=$(jq -c '.services[0].networkConfiguration' <<<"$svc")
    require_agreed_network "$netcfg"
    prev_image=$(aws ecs describe-task-definition --task-definition "$PREV_TD" --region "$REGION" \
      --query "taskDefinition.containerDefinitions[?name=='$JOBS_CONTAINER'].image | [0]" --output text)
    require_digest_ref "$prev_image"
    ROLLBACK_DIGEST=${prev_image#"$REPO@"}
  elif [[ "$status" == MISSING && "$want_bootstrap" == 1 ]]; then
    BOOTSTRAP_RUN=1
    PREV_TD="none (service $SERVICE does not exist)"
    ROLLBACK_DIGEST="none (service $SERVICE does not exist)"
    echo "::warning::BOOTSTRAP: $CLUSTER/$SERVICE does not exist. Registering its task definition only; nothing deployed."
  elif [[ "$status" == MISSING ]]; then
    die "$CLUSTER/$SERVICE does not exist. Run with bootstrap, create it at desired 0 (runbook J4), then run again without bootstrap"
  else
    die "$CLUSTER/$SERVICE status is $status; refusing to deploy"
  fi

  # 4. Register this bank's task definition, pinned by digest.
  local rendered
  rendered=$(render_jobs_template "$TENANT")
  JOBS_TD=$(register_task_definition "$rendered" "$IMAGE")
  rm -f "$rendered"
  echo "Registered: $JOBS_TD"

  if [[ "$BOOTSTRAP_RUN" == 1 ]]; then
    jobs_summary
    echo "BOOTSTRAP: create $CLUSTER/$SERVICE with --desired-count 0 on $JOBS_TD (runbook J4)."
    return 0
  fi

  # 5. Point the service at it. The desired count is not touched.
  local updated after
  updated=$(aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$JOBS_TD" \
    --region "$REGION" --output json)
  after=$(jq -r '.service.desiredCount' <<<"$updated")
  [[ "$after" == "$DESIRED" ]] || die "desired count changed from $DESIRED to $after during the deploy; stop and investigate (runbook J8)"
  if [[ "$DESIRED" -gt 0 ]]; then
    if aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION"; then
      STABLE="passed (desired $DESIRED)"
    else
      STABLE="FAILED (desired $DESIRED)"
      jobs_summary
      die "jobs service did not become stable. Stop it with: aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 0 --region $REGION (runbook J8)"
    fi
  else
    STABLE="not needed (desired 0, nothing started)"
  fi
  jobs_summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  jobs_main "$@"
fi
