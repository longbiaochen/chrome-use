#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="${CHROME_USE_PROFILE_DIR:-$HOME/.chrome-use/agent-profile}"
STATE_DIR="${CHROME_USE_STATE_DIR:-$HOME/.chrome-use/state}"
DEBUG_PORT="${CHROME_USE_DEBUG_PORT:-9223}"
DEBUG_HOST="${CHROME_USE_DEBUG_HOST:-127.0.0.1}"
DEBUG_URL="http://${DEBUG_HOST}:${DEBUG_PORT}"
START_URL="${1:-}"
START_URL="$("$SCRIPT_DIR/resolve_startup_url.sh" "$START_URL")"
LOG_FILE="${STATE_DIR}/chrome.log"

platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
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

open_existing_profile_url() {
  local chrome_bin="$1"
  local os
  os="$(platform)"

  case "$os" in
    macos)
      [[ -n "$START_URL" ]] || return 0
      if [[ -n "${CHROME_USE_CHROME_APP:-}" ]]; then
        open -g -a "$CHROME_USE_CHROME_APP" "$START_URL" >/dev/null 2>&1 || true
      else
        open -g -a "Google Chrome" "$START_URL" >/dev/null 2>&1 || true
      fi
      ;;
    linux)
      "$chrome_bin" --user-data-dir="$PROFILE_DIR" "$START_URL" >/dev/null 2>&1 &
      ;;
    *)
      ;;
  esac
}

launch_chrome() {
  local chrome_bin="$1"
  local os
  os="$(platform)"

  case "$os" in
    macos)
      local args=(
        --user-data-dir="$PROFILE_DIR"
        --remote-debugging-port="$DEBUG_PORT"
        --no-first-run
        --no-default-browser-check
      )
    if [[ -n "$START_URL" ]]; then
      args+=("$START_URL")
    fi
      if [[ -n "${CHROME_USE_CHROME_APP:-}" ]]; then
        open -g -na "$CHROME_USE_CHROME_APP" --args "${args[@]}" >>"$LOG_FILE" 2>&1
      else
        open -g -na "Google Chrome" --args "${args[@]}" >>"$LOG_FILE" 2>&1
      fi
      ;;
    linux)
      local args=(
        --user-data-dir="$PROFILE_DIR"
        --remote-debugging-port="$DEBUG_PORT"
        --no-first-run
        --no-default-browser-check
      )
      if [[ -n "$START_URL" ]]; then
        args+=("$START_URL")
      fi
      "$chrome_bin" "${args[@]}" >>"$LOG_FILE" 2>&1 &
      ;;
    windows)
      echo "Windows is not yet tested for chrome-use. Set CHROME_USE_CHROME_BIN and adapt the launcher before claiming support." >&2
      exit 1
      ;;
    *)
      echo "Unsupported platform: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

mkdir -p "$PROFILE_DIR" "$STATE_DIR"

chrome_bin="$(detect_chrome_bin)"
if [[ -z "$chrome_bin" && "$(platform)" != "windows" ]]; then
  echo "Could not find a Chrome binary. Set CHROME_USE_CHROME_BIN explicitly." >&2
  exit 1
fi

if is_endpoint_ready; then
  if [[ -n "$(list_matching_pids)" ]]; then
    open_existing_profile_url "$chrome_bin"
    echo "$DEBUG_URL"
    exit 0
  fi

  echo "A Chrome debug endpoint is listening on ${DEBUG_URL}, but no Chrome process is using the expected profile ${PROFILE_DIR}." >&2
  exit 1
fi

profile_pids="$(list_profile_pids || true)"
if [[ -n "$profile_pids" ]]; then
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done <<< "$profile_pids"
  sleep 2
fi

launch_chrome "$chrome_bin"

for _ in $(seq 1 40); do
  sleep 1
  if is_endpoint_ready && [[ -n "$(list_matching_pids)" ]]; then
    echo "$DEBUG_URL"
    exit 0
  fi
done

echo "Timed out waiting for the dedicated profile to expose ${DEBUG_URL}." >&2
exit 1
