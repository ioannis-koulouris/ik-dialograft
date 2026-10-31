#!/usr/bin/env bash
# Operator actions (third token). Usage:
#   scripts/operator.sh requeue <FR-number> <assess|implement> "<documented reason>"
#   scripts/operator.sh approve-merge <FR-number> <merged-commit-sha>
#   scripts/operator.sh request-changes <FR-number> <review-notes-file>
source "$(dirname "$0")/lib.sh"
set -a; source .env; set +a
$K port-forward --address 127.0.0.1 svc/api 18080:8080 >/dev/null & PF=$!; trap 'kill $PF' EXIT; sleep 2
case "$1" in
  requeue) BODY="$(jq -n --arg s "$3" --arg r "$4" '{stage:$s, reason:$r}')"; PATH_="requeue" ;;
  request-changes) BODY="$(jq -n --rawfile n "$3" '{notes:$n}')"; PATH_="request-changes" ;;
  approve-merge) BODY="$(jq -n --arg c "$3" '{commit:$c}')"; PATH_="approve-merge" ;;
  *) echo "unknown action"; exit 1 ;;
esac
curl -fsS -X POST "http://127.0.0.1:18080/v1/operator/feature-requests/$2/$PATH_" -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' -d "$BODY"; echo
