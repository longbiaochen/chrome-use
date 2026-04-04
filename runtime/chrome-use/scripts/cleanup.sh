#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${CHROME_USE_STATE_DIR:-$HOME/.chrome-use/state}"

mkdir -p "$STATE_DIR"
find "$STATE_DIR" -type f -name '*.log' -mtime +7 -delete >/dev/null 2>&1 || true
echo "chrome-use helper artifacts cleaned up."
