#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEBUG_URL="$("$SCRIPT_DIR/ensure_profile.sh")"

exec npm exec --yes --package=chrome-devtools-mcp@latest chrome-devtools-mcp -- --browser-url="$DEBUG_URL"
