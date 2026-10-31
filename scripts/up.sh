#!/usr/bin/env bash
# Builds the image and starts base services. No automatic reset, no automatic seed.
source "$(dirname "$0")/lib.sh"
docker build -t dialograft:local .
kubectl --context orbstack apply -f k8s/00-namespace.yaml -f k8s/10-config.yaml -f k8s/20-mysql.yaml -f k8s/30-mailpit.yaml
$K rollout status statefulset/mysql --timeout=180s
kubectl --context orbstack apply -f k8s/40-app.yaml
echo "Base services up. Run scripts/migrate-seed.sh explicitly, then scripts/port-forward.sh."
