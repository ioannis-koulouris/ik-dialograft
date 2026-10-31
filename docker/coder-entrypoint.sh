#!/bin/sh
# Usage: coder check <typecheck|test|build> | coder generate contracts | coder agent
set -eu
cd /work
# Dependencies come from the image; the lock file must match exactly.
(cd /opt/deps && sha256sum -c lock.sha256 >/dev/null) || { echo "image deps broken"; exit 90; }
[ "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$(cut -d' ' -f1 /opt/deps/lock.sha256)" ] || { echo "package-lock.json does not match coding image"; exit 91; }
[ -e node_modules ] || ln -s /opt/deps/node_modules node_modules
case "${1:-}" in
  check)
    case "${2:-}" in
      typecheck) exec npm run --silent typecheck ;;
      test) exec npm test --silent ;;
      build) exec sh -c 'npm run --silent build && rm -rf dist' ;;
      *) echo "unknown check"; exit 2 ;;
    esac ;;
  generate)
    # Deterministic generated files, rewritten by the runner after the agent finished.
    case "${2:-}" in
      contracts) exec npm run --silent contracts ;;
      *) echo "unknown generator"; exit 2 ;;
    esac ;;
  agent)
    QWEN_CODE_SUPPRESS_YOLO_WARNING=1 exec qwen --yolo --auth-type openai --prompt "$(cat /task/TASK.md)" ;;
  *) echo "usage: coder check <name> | coder generate contracts | coder agent"; exit 2 ;;
esac
