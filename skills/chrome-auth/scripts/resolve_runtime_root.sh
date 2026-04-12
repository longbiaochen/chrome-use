#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
INSTALL_ROOT="${CHROME_USE_INSTALL_ROOT:-$HOME/.chrome-use}"

CANDIDATES=(
  "${INSTALL_ROOT}/dist/runtime/chrome-use"
  "$(cd "${SCRIPT_DIR}/../../.." && pwd -P)/runtime/chrome-use"
)

for candidate in "${CANDIDATES[@]}"; do
  if [[ -f "${candidate}/scripts/open_url.sh" ]]; then
    echo "$candidate"
    exit 0
  fi
done

echo "Could not resolve shared chrome-use runtime. Checked ${CANDIDATES[*]}." >&2
exit 1
