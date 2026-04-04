#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unset CHROME_INSPECT_AUTO_START_WEBAPP
unset CHROME_INSPECT_PROJECT_ROOT
exec "$SCRIPT_DIR/../../../runtime/chrome-use/scripts/open_url.sh" "$@"
