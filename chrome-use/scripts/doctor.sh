#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${CHROME_USE_PROFILE_DIR:-$HOME/.chrome-use/agent-profile}"
DEBUG_PORT="${CHROME_USE_DEBUG_PORT:-9223}"
DEBUG_HOST="${CHROME_USE_DEBUG_HOST:-127.0.0.1}"
DEBUG_URL="http://${DEBUG_HOST}:${DEBUG_PORT}"

is_endpoint_ready() {
  curl -fsS "${DEBUG_URL}/json/version" >/dev/null 2>&1
}

list_matching_pids() {
  ps ax -o pid= -o command= \
    | awk -v profile="$PROFILE_DIR" -v port="--remote-debugging-port=${DEBUG_PORT}" '
        index($0, profile) && index($0, port) { print $1 }
      '
}

list_profile_pids() {
  ps ax -o pid= -o command= \
    | awk -v profile="$PROFILE_DIR" '
        index($0, profile) { print $1 }
      '
}

echo "Profile: $PROFILE_DIR"
echo "Debug URL: $DEBUG_URL"

if is_endpoint_ready; then
  echo "Endpoint: ready"
else
  echo "Endpoint: unavailable"
fi

matching_pids="$(list_matching_pids || true)"
profile_pids="$(list_profile_pids || true)"

if [[ -n "$matching_pids" ]]; then
  echo "Matching PID(s): $matching_pids"
  echo "Status: dedicated profile is ready for Chrome DevTools MCP"
  exit 0
fi

if is_endpoint_ready; then
  echo "Matching PID(s): none"
  echo "Profile PID(s): ${profile_pids:-none}"
  echo "Status: blocker; debug endpoint is not owned by the expected profile"
  exit 1
fi

echo "Matching PID(s): none"
echo "Profile PID(s): ${profile_pids:-none}"
echo "Status: blocker; dedicated profile is not exposing the debug endpoint"
exit 1
