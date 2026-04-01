#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEBUG_URL="$("$SCRIPT_DIR/ensure_profile.sh")"
INSPECT_SCRIPT="${SCRIPT_DIR}/chrome_devtools_inspect_mcp.mjs"
INSPECT_MODE="${CHROME_USE_MCP_MODE:-default}"
for arg in "$@"; do
  case "$arg" in
    inspect|--inspect|--mode=inspect|--mode=element-inspect|element-inspect)
      INSPECT_MODE="inspect"
      ;;
  esac
done

if [[ "$INSPECT_MODE" == "inspect" || "$INSPECT_MODE" == "element-inspect" ]]; then
  if [[ ! -x "$INSPECT_SCRIPT" ]]; then
    echo "inspect MCP entrypoint missing: $INSPECT_SCRIPT" >&2
    exit 1
  fi

  exec node "$INSPECT_SCRIPT" --browser-url="$DEBUG_URL"
fi

exec npm exec --yes --package=chrome-devtools-mcp@latest chrome-devtools-mcp -- --browser-url="$DEBUG_URL"
