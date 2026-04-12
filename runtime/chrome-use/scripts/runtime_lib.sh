#!/usr/bin/env bash

set -euo pipefail

PROFILE_DIR="${CHROME_USE_PROFILE_DIR:-$HOME/.chrome-use/agent-profile}"
STATE_DIR="${CHROME_USE_STATE_DIR:-$HOME/.chrome-use/state}"
DEBUG_PORT="${CHROME_USE_DEBUG_PORT:-9223}"
DEBUG_HOST="${CHROME_USE_DEBUG_HOST:-127.0.0.1}"
DEBUG_URL="http://${DEBUG_HOST}:${DEBUG_PORT}"

inspect_scope_dir() {
  echo "${STATE_DIR}/inspect/${DEBUG_HOST}-${DEBUG_PORT}"
}

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

debug_page_target_count() {
  local payload
  payload="$(curl -fsS "${DEBUG_URL}/json/list" 2>/dev/null || true)"
  if [[ -z "$payload" ]]; then
    echo 0
    return
  fi
  node -e '
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const count = Array.isArray(parsed)
          ? parsed.filter((item) => item && item.type === "page").length
          : 0;
        process.stdout.write(String(count));
      } catch {
        process.stdout.write("0");
      }
    });
  ' <<<"$payload"
}

is_browser_root_process() {
  local command_line="${1:-}"
  [[ -n "$command_line" ]] || return 1
  [[ "$command_line" == *"$PROFILE_DIR"* ]] || return 1
  [[ "$command_line" == *"Google Chrome"* || "$command_line" == *"Agent Profile Chrome"* || "$command_line" == *"google-chrome"* || "$command_line" == *"chromium"* ]] || return 1
  [[ "$command_line" != *" --type="* ]] || return 1
  [[ "$command_line" != *" Helper"* ]] || return 1
  return 0
}

list_matching_pids() {
  local pid command_line
  while read -r pid command_line; do
    [[ -n "${pid:-}" ]] || continue
    [[ "$command_line" == *"$PROFILE_DIR"* ]] || continue
    [[ "$command_line" == *"--remote-debugging-port=${DEBUG_PORT}"* ]] || continue
    if is_browser_root_process "$command_line"; then
      echo "$pid"
    fi
  done < <(ps ax -o pid= -o command=)
}

list_profile_root_pids() {
  local pid command_line
  while read -r pid command_line; do
    [[ -n "${pid:-}" ]] || continue
    if is_browser_root_process "$command_line"; then
      echo "$pid"
    fi
  done < <(ps ax -o pid= -o command=)
}

list_profile_root_commands() {
  local pid command_line
  while read -r pid command_line; do
    [[ -n "${pid:-}" ]] || continue
    if is_browser_root_process "$command_line"; then
      echo "$command_line"
    fi
  done < <(ps ax -o pid= -o command=)
}

list_profile_pids() {
  ps ax -o pid= -o command= \
    | awk -v profile="$PROFILE_DIR" '
        index($0, profile) { print $1 }
      '
}
