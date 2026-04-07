#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_if_valid_project_root() {
  local candidate="${1:-}"
  local resolved=""
  local entry_url=""

  if [[ -z "$candidate" || ! -d "$candidate" ]]; then
    return 1
  fi

  resolved="$(cd "$candidate" && pwd -P)"
  entry_url="$("$SCRIPT_DIR/project_webapp_entry.sh" "$resolved" 2>/dev/null || true)"
  if [[ -z "$entry_url" ]]; then
    return 1
  fi

  echo "$resolved"
  return 0
}

declared_project_root="${CHROME_INSPECT_PROJECT_ROOT:-}"
if print_if_valid_project_root "$declared_project_root"; then
  exit 0
fi

if [[ "${CHROME_INSPECT_AUTO_START_WEBAPP:-0}" != "1" ]]; then
  exit 0
fi

current_dir="$(pwd -P)"
if print_if_valid_project_root "$current_dir"; then
  exit 0
fi

if command -v git >/dev/null 2>&1; then
  git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if print_if_valid_project_root "$git_root"; then
    exit 0
  fi
fi

exit 0
