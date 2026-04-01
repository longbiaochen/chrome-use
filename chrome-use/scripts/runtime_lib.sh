#!/usr/bin/env bash

set -euo pipefail

PROFILE_DIR="${CHROME_USE_PROFILE_DIR:-$HOME/.chrome-use/agent-profile}"
STATE_DIR="${CHROME_USE_STATE_DIR:-$HOME/.chrome-use/state}"
DEBUG_PORT="${CHROME_USE_DEBUG_PORT:-9223}"
DEBUG_HOST="${CHROME_USE_DEBUG_HOST:-127.0.0.1}"
DEBUG_URL="http://${DEBUG_HOST}:${DEBUG_PORT}"

platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

count_lines() {
  local input="${1:-}"
  if [[ -z "$input" ]]; then
    echo 0
    return
  fi

  awk 'NF { count += 1 } END { print count + 0 }' <<<"$input"
}

detect_chrome_bin() {
  local os
  os="$(platform)"

  if [[ -n "${CHROME_USE_CHROME_BIN:-}" ]]; then
    echo "$CHROME_USE_CHROME_BIN"
    return
  fi

  case "$os" in
    macos)
      if [[ -n "${CHROME_USE_CHROME_APP:-}" ]]; then
        echo "${CHROME_USE_CHROME_APP}/Contents/MacOS/Google Chrome"
        return
      fi
      if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
        echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        return
      fi
      if [[ -x "/Applications/Chrome.app/Contents/MacOS/Google Chrome" ]]; then
        echo "/Applications/Chrome.app/Contents/MacOS/Google Chrome"
        return
      fi
      ;;
    linux)
      for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
        if command -v "$candidate" >/dev/null 2>&1; then
          command -v "$candidate"
          return
        fi
      done
      ;;
    windows)
      echo ""
      return
      ;;
  esac

  echo ""
}

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

window_count_for_pid() {
  local pid="$1"
  local os
  os="$(platform)"

  case "$os" in
    macos)
      osascript <<EOF
tell application "System Events"
  set targetPid to ${pid}
  set matchingProcesses to every process whose unix id is targetPid
  if (count of matchingProcesses) is 0 then
    return "0"
  end if
  set targetProcess to item 1 of matchingProcesses
  return (count of windows of targetProcess) as string
end tell
EOF
      ;;
    *)
      echo "unsupported"
      ;;
  esac
}

validate_dedicated_window_invariant() {
  local pid="$1"
  local os
  local window_count

  os="$(platform)"
  if [[ "$os" != "macos" ]]; then
    return 0
  fi

  if ! window_count="$(window_count_for_pid "$pid" 2>/dev/null)"; then
    echo "Unable to inspect Chrome windows for the dedicated profile process ${pid}." >&2
    return 1
  fi

  if [[ "$window_count" != "1" ]]; then
    echo "Dedicated profile Chrome must have exactly one window; found ${window_count} window(s) for process ${pid}." >&2
    return 1
  fi

  return 0
}
