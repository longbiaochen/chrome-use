#!/usr/bin/env bash
set -euo pipefail

explicit_url="${1:-}"

if [[ -n "$explicit_url" ]]; then
  echo "$explicit_url"
  exit 0
fi

if [[ -n "${CHROME_USE_DEFAULT_WEBAPP_URL:-}" ]]; then
  echo "$CHROME_USE_DEFAULT_WEBAPP_URL"
  exit 0
fi

echo "about:blank"
