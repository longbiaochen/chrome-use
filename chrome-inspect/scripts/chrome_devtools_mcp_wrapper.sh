#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/../../chrome-use/scripts/chrome_devtools_mcp_wrapper_inspect.sh" "$@"
