#!/usr/bin/env bash
# remote-code launcher + installer.
#
#   ./run.sh            launch an interactive pi host with the extension (-e)
#   ./run.sh install    symlink the extension into pi's global discovery dir
#                       (PI_AGENT_DIR/extensions/remote-code) so EVERY `pi`
#                       start loads it — no -e flag needed
#   ./run.sh uninstall  remove that symlink
#
# Requires: node >= 22, pi on PATH (or the devDependency copy), and for the
# remote link: a Firebase service account at
# PI_AGENT_DIR/remote-code/serviceAccountKey.json (legacy pinest path works).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$ROOT/server"
DISCOVERY="$HOME/.pi/agent/extensions"
LINK="$DISCOVERY/remote-code"

if [ ! -d "$EXT_DIR/node_modules" ]; then
  (cd "$EXT_DIR" && npm install)
fi

case "${1:-}" in
  install|uninstall)
    if [ "$1" = "install" ]; then
      if [ -e "$LINK" ] || [ -L "$LINK" ]; then
        if [ "$(readlink "$LINK")" = "$EXT_DIR" ]; then
          echo "remote-code: already installed at $LINK"
        else
          echo "error: $LINK exists and is not our symlink — inspect and remove it manually" >&2
          exit 1
        fi
      else
        mkdir -p "$DISCOVERY"
        ln -s "$EXT_DIR" "$LINK"
        echo "remote-code: installed — pi will load it from every directory"
      fi
      echo "Try: pi   (then /rc-sessions)"
    else
      if [ -L "$LINK" ]; then
        rm "$LINK"
        echo "remote-code: uninstalled"
      else
        echo "remote-code: not installed (no symlink at $LINK)"
      fi
    fi
    exit 0
    ;;
esac

if [ "${1:-}" != "" ]; then
  echo "usage: ./run.sh [install|uninstall]  (extra args are passed to pi)" >&2
  exit 1
fi

# Use pi from PATH if present, else the devDependency copy.
if command -v pi >/dev/null 2>&1; then
  PI=pi
elif [ -x "$EXT_DIR/node_modules/.bin/pi" ]; then
  PI="$EXT_DIR/node_modules/.bin/pi"
else
  echo "error: pi not found on PATH and not installed in server/node_modules" >&2
  echo "  install with: npm install -g @earendil-works/pi-coding-agent" >&2
  exit 1
fi

cd "${RC_START_DIR:-$PWD}"
exec "$PI" -e "$EXT_DIR/src/index.ts" "$@"
