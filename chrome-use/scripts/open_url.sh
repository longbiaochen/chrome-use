#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
explicit_url="${1:-}"
target_url="$("$SCRIPT_DIR/resolve_startup_url.sh" "$explicit_url")"

"$SCRIPT_DIR/ensure_project_webapp_running.sh" "$target_url"
"$SCRIPT_DIR/ensure_profile.sh" "$target_url"
