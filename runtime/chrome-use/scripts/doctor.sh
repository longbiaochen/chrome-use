#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/runtime_lib.sh"

echo "Profile: $PROFILE_DIR"
echo "Debug URL: $DEBUG_URL"

if is_endpoint_ready; then
  echo "Endpoint: ready"
else
  echo "Endpoint: unavailable"
fi

matching_pids="$(list_matching_pids || true)"
profile_pids="$(list_profile_pids || true)"
profile_root_pids="$(list_profile_root_pids || true)"
profile_root_commands="$(list_profile_root_commands || true)"
matching_count="$(count_lines "$matching_pids")"
profile_count="$(count_lines "$profile_root_pids")"
page_target_count="0"
if is_endpoint_ready; then
  page_target_count="$(debug_page_target_count)"
fi

echo "Dedicated PID count: $profile_count"
echo "Matching PID count: $matching_count"
echo "Matching PID(s): ${matching_pids:-none}"
echo "Profile PID(s): ${profile_pids:-none}"
echo "Profile owner PID(s): ${profile_root_pids:-none}"
echo "Profile owner command(s): ${profile_root_commands:-none}"
echo "Page target count: ${page_target_count}"

if [[ "$matching_count" -gt 1 ]]; then
  echo "Status: blocker; multiple dedicated-profile Chrome processes are exposing the canonical debug port"
  exit 1
fi

if [[ "$matching_count" -eq 1 ]]; then
  echo "Status: dedicated profile is ready"
  exit 0
fi

if is_endpoint_ready; then
  echo "Status: blocker; debug endpoint is not owned by the expected profile"
  exit 1
fi

echo "Status: blocker; dedicated profile is not exposing the debug endpoint"
exit 1
