#!/usr/bin/env bash
# Creates/updates the Kubernetes secret from a local .env (never committed).
source "$(dirname "$0")/lib.sh"
ENV_FILE="${1:-.env}"
set -a; source "$ENV_FILE"; set +a
kubectl --context orbstack apply -f k8s/00-namespace.yaml
$K create secret generic dialograft-secrets \
  --from-literal=MCP_CLIENT_TOKEN="$MCP_CLIENT_TOKEN" \
  --from-literal=API_SERVICE_TOKEN="$API_SERVICE_TOKEN" \
  --from-literal=OPERATOR_TOKEN="$OPERATOR_TOKEN" \
  --from-literal=RUNNER_TOKEN="$RUNNER_TOKEN" \
  --from-literal=GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  --from-literal=MYSQL_PASSWORD="$MYSQL_PASSWORD" \
  --from-literal=MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-$MYSQL_PASSWORD-root}" \
  --from-literal=DATABASE_URL="mysql://dialograft:${MYSQL_PASSWORD}@mysql:3306/dialograft" \
  --dry-run=client -o yaml | $K apply -f -
