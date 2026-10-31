# Shared guard: only ever operate on the local OrbStack cluster.
set -euo pipefail
CTX="$(kubectl config current-context)"
if [ "$CTX" != "orbstack" ]; then
  echo "Refusing to run: kube context is '$CTX', expected 'orbstack'." >&2
  exit 1
fi
K="kubectl --context orbstack -n dialograft"
