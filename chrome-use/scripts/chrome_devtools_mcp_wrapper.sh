#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSPECT_SCRIPT="${SCRIPT_DIR}/chrome_devtools_inspect_mcp.mjs"
INSPECT_MODE="${CHROME_USE_MCP_MODE:-default}"
STARTUP_URL=""

for arg in "$@"; do
  case "$arg" in
    inspect|--inspect|--mode=inspect|--mode=element-inspect|element-inspect)
      INSPECT_MODE="inspect"
      ;;
    --*)
      ;;
    *)
      if [[ -z "$STARTUP_URL" ]]; then
        STARTUP_URL="$arg"
      fi
      ;;
  esac
done

if [[ "$INSPECT_MODE" == "inspect" || "$INSPECT_MODE" == "element-inspect" ]]; then
  if [[ ! -x "$INSPECT_SCRIPT" ]]; then
    echo "inspect MCP entrypoint missing: $INSPECT_SCRIPT" >&2
    exit 1
  fi

  if [[ -z "${CHROME_INSPECT_AUTO_START_WEBAPP-}" ]]; then
    export CHROME_INSPECT_AUTO_START_WEBAPP=1
  fi

  if [[ -n "$STARTUP_URL" ]]; then
    DEBUG_URL="$("$SCRIPT_DIR/open_url.sh" "$STARTUP_URL")"
  else
    DEBUG_URL="$("$SCRIPT_DIR/open_url.sh")"
  fi

  exec node "$INSPECT_SCRIPT" --browser-url="$DEBUG_URL"
fi

DEBUG_URL="$("$SCRIPT_DIR/ensure_profile.sh")"
exec npm exec --yes --package=chrome-devtools-mcp@latest chrome-devtools-mcp -- --browser-url="$DEBUG_URL"
