#!/usr/bin/env bash
# Explicit deployment of a reviewed and approved commit. Usage: scripts/deploy-approved.sh <FR-number> <commit-sha>
source "$(dirname "$0")/lib.sh"
FR="$1"; SHA="$2"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "full commit sha required"; exit 1; }
git fetch origin
git merge-base --is-ancestor "$SHA" origin/main || { echo "$SHA is not on origin/main (not merged)"; exit 1; }
WT="$(mktemp -d)"; trap 'git worktree remove --force "$WT"' EXIT
git worktree add --detach "$WT" "$SHA"
docker build -t "dialograft:$SHA" -t dialograft:local "$WT"
# Schema changes are applied forward only; no blind rollback of data migrations.
"$(dirname "$0")/migrate-seed.sh"
$K rollout restart deployment/api deployment/mcp deployment/worker
$K rollout status deployment/api --timeout=180s
set -a; source .env; set +a
$K port-forward --address 127.0.0.1 svc/api 18080:8080 & PF=$!; sleep 2
curl -fsS -X POST "http://127.0.0.1:18080/v1/operator/feature-requests/$FR/deployed" \
  -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' -d "{\"commit\":\"$SHA\"}"
kill $PF
echo; echo "Deployed $SHA. Refresh the MCP tool list in the client and test the feature."
