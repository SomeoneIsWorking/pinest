#!/usr/bin/env bash
# remote-code launcher: run an interactive pi host with the remote-code
# extension. Requires: node >= 22, pi (or the devDependency install), and a
# Firebase service account at <PI_AGENT_DIR>/remote-code/serviceAccountKey.json
# (legacy: <PI_AGENT_DIR>/pinest-serviceAccountKey.json).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$ROOT/server/node_modules" ]; then
  (cd "$ROOT/server" && npm install)
fi

# Use pi from PATH if present, else the devDependency copy.
if command -v pi >/dev/null 2>&1; then
  PI=pi
elif [ -x "$ROOT/server/node_modules/.bin/pi" ]; then
  PI="$ROOT/server/node_modules/.bin/pi"
else
  echo "error: pi not found on PATH and not installed in server/node_modules" >&2
  echo "  install with: npm install -g @earendil-works/pi-coding-agent" >&2
  exit 1
fi

cd "${RC_START_DIR:-$PWD}"
exec "$PI" -e "$ROOT/server/src/index.ts" "$@"
