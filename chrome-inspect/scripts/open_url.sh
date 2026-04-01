#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CHROME_INSPECT_AUTO_START_WEBAPP=1
exec "$SCRIPT_DIR/../../chrome-use/scripts/open_url.sh" "$@"
