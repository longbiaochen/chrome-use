#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: inspect_select_element.sh <project-root> [--timeout-ms <ms>] [--url <url>]" >&2
  exit 1
fi

PROJECT_ROOT="$1"
shift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/../../../runtime/chrome-use/scripts/inspect_capture.mjs" once --project-root "$PROJECT_ROOT" "$@"
