#!/usr/bin/env bash
# Log metric filters and alarms for one bank's allowance jobs (CS-3979, CS-3992),
# from infra/monitoring/jobs-monitoring.json. Operator-run (runbook J6); the
# GitHub deploy role cannot run it (it has no logs/cloudwatch write).
#
# Usage: scripts/jobs-alarms.sh <bank> <sns-topic-arn> [--apply] [--with-heartbeat]
#   Dry run by default: prints every aws command and changes nothing.
#   --apply           runs them.
#   --with-heartbeat  also creates the no-heartbeat alarm. Only once the bank's
#                     jobs service is meant to run (activation): while jobs are
#                     stopped (desired 0) that alarm would always be in ALARM.
# The SNS topic belongs to the named alarm owner; there is no default.
set -euo pipefail

SPEC=infra/monitoring/jobs-monitoring.json
REGION=ap-southeast-2
KNOWN_TENANTS=(bank_bilgola bank_manly)

die() { echo "jobs-alarms: ERROR: $*" >&2; exit 1; }

main() {
  local tenant=${1:-} topic=${2:-} apply=0 heartbeat=0
  shift 2 || true
  for a in "$@"; do
    case "$a" in
      --apply) apply=1 ;;
      --with-heartbeat) heartbeat=1 ;;
      *) die "unknown option $a" ;;
    esac
  done
  local ok=0 t
  for t in "${KNOWN_TENANTS[@]}"; do [[ "$tenant" == "$t" ]] && ok=1; done
  [[ "$ok" == 1 ]] || die "unknown bank '$tenant'; expected one of: ${KNOWN_TENANTS[*]}"
  [[ "$topic" =~ ^arn:aws:sns:$REGION:[0-9]{12}:[A-Za-z0-9_-]{1,256}$ ]] || die "an SNS topic ARN in $REGION is required (the alarm owner's topic), got '$topic'"
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  command -v jq >/dev/null || die "jq is required"
  [[ -f "$SPEC" ]] || die "$SPEC missing"

  local group ns
  group=$(jq -r .logGroup "$SPEC")
  ns=$(jq -r .namespace "$SPEC")
  local cmds=()
  while IFS=$'\t' read -r metric field value; do
    cmds+=("aws logs put-metric-filter --region $REGION --log-group-name $group --filter-name chore-scout-jobs-$tenant-$metric --filter-pattern '{ (\$.$field = \"$value\") && (\$.tenantId = \"$tenant\") }' --metric-transformations metricName=$metric,metricNamespace=$ns,metricValue=1,dimensions={TenantId=\$.tenantId}")
  done < <(jq -r '.filters[] | [.metric, .field, .value] | @tsv' "$SPEC")
  while IFS=$'\t' read -r name metric stat period evals threshold cmp missing running; do
    if [[ "$running" == true && "$heartbeat" != 1 ]]; then
      echo "skipped alarm $name (only with --with-heartbeat, once jobs run)"
      continue
    fi
    cmds+=("aws cloudwatch put-metric-alarm --region $REGION --alarm-name chore-scout-jobs-$tenant-$name --namespace $ns --metric-name $metric --dimensions Name=TenantId,Value=$tenant --statistic $stat --period $period --evaluation-periods $evals --threshold $threshold --comparison-operator $cmp --treat-missing-data $missing --alarm-actions $topic --ok-actions $topic")
  done < <(jq -r '.alarms[] | [.name, .metric, .statistic, (.periodSeconds|tostring), (.evaluationPeriods|tostring), (.threshold|tostring), .comparison, .treatMissingData, ((.runningOnly // false)|tostring)] | @tsv' "$SPEC")

  local c
  for c in "${cmds[@]}"; do
    if [[ "$apply" == 1 ]]; then
      echo "+ $c"
      eval "$c"
    else
      echo "DRY RUN: $c"
    fi
  done
  [[ "$apply" == 1 ]] || echo "Dry run only: nothing changed. Re-run with --apply."
}

main "$@"
