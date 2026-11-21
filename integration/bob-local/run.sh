#!/usr/bin/env bash
# Isolated integration: Chore Scout jobs runtime <-> real BOB (CS-3979, CS-3992).
#
# Usage: integration/bob-local/run.sh <server SHA> <BOB repo path> <BOB SHA>
#   e.g. integration/bob-local/run.sh "$(git rev-parse HEAD)" ../BOB-Bank-of-Bilgola 204ceaaa4334f0fa4fdbd9a54fefce6669770602
#
# 1. Exports each repo at its exact commit (git archive: committed files only)
#    and builds two local images: BOB from its own Dockerfile, and the harness
#    (this repo, dev dependencies). Building needs the internet.
# 2. Runs docker-compose.yml on an internal-only network and waits for the
#    harness to finish; prints the summary; tears everything down (volumes too).
# Exit code: the harness's (0 = every assertion passed).
#
# Nothing is pushed, deployed or published; no AWS credential is passed in.
set -euo pipefail
SERVER_SHA=${1:?server SHA}
BOB_REPO=${2:?BOB repo path}
BOB_SHA=${3:?BOB SHA}
[[ "$SERVER_SHA" =~ ^[0-9a-f]{40}$ && "$BOB_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "full 40-character SHAs required" >&2; exit 64; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
trap 'docker compose -f "$(cygpath -m "$here" 2>/dev/null || echo "$here")/docker-compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

echo "== exporting server $SERVER_SHA and BOB $BOB_SHA"
mkdir -p "$work/server" "$work/bob"
git -C "$root" archive "$SERVER_SHA" | tar -x -C "$work/server"
git -C "$BOB_REPO" archive "$BOB_SHA" | tar -x -C "$work/bob"

echo "== building images"
DOCKER_BUILDKIT=1 docker build -q -t "cs-it-bob:$BOB_SHA" "$work/bob" >/dev/null
DOCKER_BUILDKIT=1 docker build -q -t "cs-it-harness:$SERVER_SHA" -f "$work/server/integration/bob-local/harness.Dockerfile" "$work/server" >/dev/null
docker image inspect --format 'bob image {{.Id}}' "cs-it-bob:$BOB_SHA"
docker image inspect --format 'harness image {{.Id}}' "cs-it-harness:$SERVER_SHA"

echo "== running the isolated stack (internal network only)"
export SERVER_SHA BOB_SHA
set +e
docker compose -f "$(cygpath -m "$here" 2>/dev/null || echo "$here")/docker-compose.yml" up --abort-on-container-exit --exit-code-from harness --no-color harness 2>&1 | grep -E '^harness' | sed -E 's/^harness[^|]*\| ?//'
rc=${PIPESTATUS[0]}
set -e
echo "== BOB log lines mentioning the legacy family scheduler (expect none started):"
docker compose -f "$(cygpath -m "$here" 2>/dev/null || echo "$here")/docker-compose.yml" logs --no-color bob 2>/dev/null | grep -iE 'chorescout\.(scheduler|cycle)|ChoreScoutScheduler|family cycle' || echo "  (none)"
echo "== harness exit code: $rc"
exit "$rc"
