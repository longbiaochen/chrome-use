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
echo "Page target count: ${page_target_count}"

if [[ "$matching_count" -gt 1 ]]; then
  echo "Window count: unknown"
  echo "Status: blocker; multiple dedicated-profile Chrome processes are exposing the canonical debug port"
  exit 1
fi

if [[ "$matching_count" -eq 1 ]]; then
  pid="$(awk 'NF { print; exit }' <<<"$matching_pids")"
  if [[ "$(platform)" == "macos" ]]; then
    if ! window_count="$(window_count_for_pid "$pid" 2>/dev/null)"; then
      echo "Window count: unavailable"
      echo "Status: blocker; unable to inspect dedicated-profile Chrome windows"
      exit 1
    fi

    echo "Window count: $window_count"
    if [[ "$window_count" == "0" && "$page_target_count" -gt 0 ]]; then
      echo "Status: dedicated profile is ready for Chrome DevTools MCP (page-target fallback)"
      exit 0
    fi
    if [[ "$window_count" != "1" ]]; then
      echo "Status: blocker; dedicated-profile Chrome must have exactly one window"
      exit 1
    fi
  else
    echo "Window count: unsupported"
  fi

  echo "Status: dedicated profile is ready for Chrome DevTools MCP"
  exit 0
fi

if is_endpoint_ready; then
  echo "Window count: unknown"
  echo "Status: blocker; debug endpoint is not owned by the expected profile"
  exit 1
fi

echo "Window count: unknown"
echo "Status: blocker; dedicated profile is not exposing the debug endpoint"
exit 1
