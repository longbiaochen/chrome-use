#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: inspect_select_element.sh <project-root> [--timeout-ms <ms>] [--url <url>]" >&2
  exit 1
fi

PROJECT_ROOT="$1"
shift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME_ROOT="$("$SCRIPT_DIR/resolve_runtime_root.sh")"
exec node "$RUNTIME_ROOT/scripts/inspect_capture.mjs" once --project-root "$PROJECT_ROOT" "$@"
