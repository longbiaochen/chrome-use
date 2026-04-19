#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/runtime_lib.sh"

START_URL="${1:-about:blank}"
INSPECT_SCOPE_DIR="$(inspect_scope_dir)"
PREFERRED_TARGET_FILE="${INSPECT_SCOPE_DIR}/preferred-target.json"

read_preferred_target_id() {
  local file_path="$1"
  [[ -f "$file_path" ]] || return 0
  node - "$file_path" <<'NODE'
const fs = require("fs");
const filePath = process.argv[2];
try {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (payload && typeof payload.targetId === "string" && payload.targetId.trim()) {
    process.stdout.write(payload.targetId.trim());
  }
} catch {}
NODE
}

activate_target() {
  local debug_url="$1"
  local target_id="$2"
  [[ -n "$target_id" ]] || return 0
  curl -fsS "${debug_url}/json/activate/${target_id}" >/dev/null 2>&1 || true
}

debug_url="$("$SCRIPT_DIR/open_url.sh" "$START_URL")"

matching_pids="$(list_matching_pids || true)"
matching_count="$(count_lines "$matching_pids")"
if [[ "$matching_count" -ne 1 ]]; then
  echo "Expected exactly one $(expected_browser_owner_label) owner process for profile ${PROFILE_NAME} on ${DEBUG_URL}; found ${matching_count}." >&2
  exit 1
fi

target_id="$(read_preferred_target_id "$PREFERRED_TARGET_FILE")"
activate_target "$debug_url" "$target_id"

echo "$debug_url"
