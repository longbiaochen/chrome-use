#!/usr/bin/env bash
set -euo pipefail

explicit_url="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$("$SCRIPT_DIR/resolve_project_root.sh" 2>/dev/null || true)"

PROJECT_ENTRY=""

if [[ -n "$explicit_url" ]]; then
  echo "$explicit_url"
  exit 0
fi

if [[ -z "$explicit_url" && -n "$project_root" && -d "$project_root" ]]; then
  PROJECT_ENTRY="$("$SCRIPT_DIR/project_webapp_entry.sh" "$project_root" 2>/dev/null || true)"
fi

if [[ -n "$PROJECT_ENTRY" ]]; then
  echo "$PROJECT_ENTRY"
  exit 0
fi

if [[ -n "${CHROME_USE_DEFAULT_WEBAPP_URL:-}" ]]; then
  echo "$CHROME_USE_DEFAULT_WEBAPP_URL"
  exit 0
fi

echo "about:blank"
