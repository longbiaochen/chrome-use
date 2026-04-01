#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CHROME_USE_MCP_MODE="inspect"

exec "$SCRIPT_DIR/chrome_devtools_mcp_wrapper.sh" "$@"
