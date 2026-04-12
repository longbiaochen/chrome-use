#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME_ROOT="$("$SCRIPT_DIR/resolve_runtime_root.sh")"
export CHROME_INSPECT_AUTO_START_WEBAPP=1
exec "$RUNTIME_ROOT/scripts/open_url.sh" "$@"
