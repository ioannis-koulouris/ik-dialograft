#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
$K delete job migrate-seed --ignore-not-found
kubectl --context orbstack apply -f k8s/50-migrate-job.yaml
$K wait --for=condition=complete job/migrate-seed --timeout=180s
$K logs job/migrate-seed
