#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/runtime_lib.sh"

START_URL="${1:-}"
START_URL="$("$SCRIPT_DIR/resolve_startup_url.sh" "$START_URL")"
LOG_FILE="${STATE_DIR}/chrome.log"

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

url_encode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "$1"
}

open_tab_on_dedicated_instance() {
  local target_url="$1"
  local encoded_url

  [[ -n "$target_url" ]] || return 0

  encoded_url="$(url_encode "$target_url")"
  curl -fsS -X PUT "${DEBUG_URL}/json/new?${encoded_url}" >/dev/null
}

wait_for_dedicated_instance() {
  local matching_pids
  local matching_count
  local pid

  for _ in $(seq 1 40); do
    sleep 1

    if ! is_endpoint_ready; then
      continue
    fi

    matching_pids="$(list_matching_pids || true)"
    matching_count="$(count_lines "$matching_pids")"
    if [[ "$matching_count" -gt 1 ]]; then
      echo "Dedicated profile Chrome must have exactly one owning process; found ${matching_count} process(es) on ${DEBUG_URL}." >&2
      return 1
    fi

    if [[ "$matching_count" -eq 0 ]]; then
      continue
    fi

    pid="$(awk 'NF { print; exit }' <<<"$matching_pids")"
    if validate_dedicated_window_invariant "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  done

  return 1
}

ensure_endpoint_owned_by_dedicated_profile() {
  local matching_pids
  local matching_count
  local pid

  if ! is_endpoint_ready; then
    return 1
  fi

  matching_pids="$(list_matching_pids || true)"
  matching_count="$(count_lines "$matching_pids")"

  if [[ "$matching_count" -gt 1 ]]; then
    echo "Dedicated profile Chrome must have exactly one owning process; found ${matching_count} process(es) on ${DEBUG_URL}." >&2
    exit 1
  fi

  if [[ "$matching_count" -eq 0 ]]; then
    echo "A Chrome debug endpoint is listening on ${DEBUG_URL}, but no Chrome process is using the expected profile ${PROFILE_DIR}." >&2
    exit 1
  fi

  pid="$(awk 'NF { print; exit }' <<<"$matching_pids")"
  if ! validate_dedicated_window_invariant "$pid"; then
    exit 1
  fi

  echo "$pid"
  return 0
}

mkdir -p "$PROFILE_DIR" "$STATE_DIR"

chrome_bin="$(detect_chrome_bin)"
if [[ -z "$chrome_bin" && "$(platform)" != "windows" ]]; then
  echo "Could not find a Chrome binary. Set CHROME_USE_CHROME_BIN explicitly." >&2
  exit 1
fi

if ensure_endpoint_owned_by_dedicated_profile >/dev/null; then
  open_tab_on_dedicated_instance "$START_URL"
  echo "$DEBUG_URL"
  exit 0
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

if wait_for_dedicated_instance >/dev/null; then
  echo "$DEBUG_URL"
  exit 0
fi

echo "Timed out waiting for the dedicated profile to expose ${DEBUG_URL}." >&2
exit 1
