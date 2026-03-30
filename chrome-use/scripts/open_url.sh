#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_url="${1:-about:blank}"

"$SCRIPT_DIR/ensure_profile.sh" "$target_url" >/dev/null
