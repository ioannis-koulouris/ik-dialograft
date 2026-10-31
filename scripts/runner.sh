#!/usr/bin/env bash
# Starts the native runner controller on the Mac (foreground). Reads RUNNER_TOKEN from .env.
# The runner clones from the local checkout, so it needs no Git credentials; keep it on main.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
export RUNNER_REPO_URL="${RUNNER_REPO_URL:-$PWD}"
export RUNNER_WORK_DIR="${RUNNER_WORK_DIR:-$HOME/.dialograft-runner}"
export OLLAMA_MODEL="${RUNNER_MODEL:-qwen3-coder-next:q8_0}"
export RUNNER_HOST=127.0.0.1
[ -f dist/src/runner/main.js ] || npm run build
docker image inspect dialograft-coder:local >/dev/null 2>&1 || docker build -f docker/coder.Dockerfile -t dialograft-coder:local .
exec node dist/src/runner/main.js
