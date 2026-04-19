#!/usr/bin/env bash

set -euo pipefail

INSTALL_ROOT="${CHROME_USE_INSTALL_ROOT:-$HOME/.chrome-use}"
BROWSER_KIND="${CHROME_USE_BROWSER_KIND:-cft}"
CFT_CHANNEL="${CHROME_USE_CFT_CHANNEL:-stable}"
CFT_VERSION="${CHROME_USE_CFT_VERSION:-}"
BROWSERS_ROOT="${CHROME_USE_BROWSERS_ROOT:-$INSTALL_ROOT/browsers}"
CFT_ROOT="${BROWSERS_ROOT}/chrome-for-testing"
CFT_CHANNELS_ROOT="${CFT_ROOT}/channels"
PROFILE_KEY="${CFT_VERSION:-$CFT_CHANNEL}"
PROFILE_DIR="${CHROME_USE_PROFILE_DIR:-$INSTALL_ROOT/browser-data/$PROFILE_KEY}"
PROFILE_NAME="${CHROME_USE_PROFILE_NAME:-Default}"
STATE_DIR="${CHROME_USE_STATE_DIR:-$INSTALL_ROOT/state}"
DEBUG_PORT="${CHROME_USE_DEBUG_PORT:-9223}"
DEBUG_HOST="${CHROME_USE_DEBUG_HOST:-127.0.0.1}"
DEBUG_URL="http://${DEBUG_HOST}:${DEBUG_PORT}"

browser_kind() {
  printf '%s' "${CHROME_USE_BROWSER_KIND:-$BROWSER_KIND}" | tr '[:upper:]' '[:lower:]'
}

cft_channel() {
  printf '%s' "${CHROME_USE_CFT_CHANNEL:-$CFT_CHANNEL}" | tr '[:upper:]' '[:lower:]'
}

platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

cft_platform() {
  local os
  local arch
  os="$(platform)"
  arch="$(uname -m)"

  case "$os" in
    macos)
      case "$arch" in
        arm64|aarch64) echo "mac-arm64" ;;
        x86_64) echo "mac-x64" ;;
        *) echo "" ;;
      esac
      ;;
    linux)
      echo "linux64"
      ;;
    windows)
      case "$arch" in
        x86_64|amd64) echo "win64" ;;
        *) echo "win32" ;;
      esac
      ;;
    *)
      echo ""
      ;;
  esac
}

cft_archive_dir() {
  local target_platform="${1:-$(cft_platform)}"
  case "$target_platform" in
    mac-arm64) echo "chrome-mac-arm64" ;;
    mac-x64) echo "chrome-mac-x64" ;;
    linux64) echo "chrome-linux64" ;;
    win64) echo "chrome-win64" ;;
    win32) echo "chrome-win32" ;;
    *) echo "" ;;
  esac
}

cft_binary_relpath() {
  local target_platform="${1:-$(cft_platform)}"
  local archive_dir
  archive_dir="$(cft_archive_dir "$target_platform")"
  case "$target_platform" in
    mac-arm64|mac-x64)
      echo "${archive_dir}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      ;;
    linux64)
      echo "${archive_dir}/chrome"
      ;;
    win64|win32)
      echo "${archive_dir}/chrome.exe"
      ;;
    *)
      echo ""
      ;;
  esac
}

runtime_display_name() {
  case "$(browser_kind)" in
    cft) echo "Chrome for Testing runtime" ;;
    *) echo "Google Chrome runtime" ;;
  esac
}

expected_browser_owner_label() {
  case "$(browser_kind)" in
    cft) echo "Google Chrome for Testing" ;;
    *) echo "Google Chrome.app" ;;
  esac
}

default_profile_dir() {
  case "$(platform)" in
    macos) echo "$HOME/Library/Application Support/Google/Chrome" ;;
    linux) echo "$HOME/.config/google-chrome" ;;
    *) echo "" ;;
  esac
}

uses_default_chrome_profile() {
  local expected_default_dir
  expected_default_dir="$(default_profile_dir)"
  [[ -n "$expected_default_dir" ]] || return 1
  [[ "$PROFILE_NAME" == "Default" ]] || return 1
  [[ "$PROFILE_DIR" == "$expected_default_dir" ]] || return 1
  return 0
}

inspect_scope_dir() {
  echo "${STATE_DIR}/inspect/${DEBUG_HOST}-${DEBUG_PORT}"
}

count_lines() {
  local input="${1:-}"
  if [[ -z "$input" ]]; then
    echo 0
    return
  fi

  awk 'NF { count += 1 } END { print count + 0 }' <<<"$input"
}

resolve_cft_version() {
  local explicit_version="${CHROME_USE_CFT_VERSION:-$CFT_VERSION}"
  local channel_file

  if [[ -n "$explicit_version" ]]; then
    echo "$explicit_version"
    return 0
  fi

  channel_file="${CFT_CHANNELS_ROOT}/$(cft_channel)-$(cft_platform).txt"
  if [[ -f "$channel_file" ]]; then
    head -n 1 "$channel_file" | tr -d '[:space:]'
    return 0
  fi

  return 1
}

resolve_cft_binary_path() {
  local version
  local target_platform
  local relpath

  version="$(resolve_cft_version 2>/dev/null || true)"
  [[ -n "$version" ]] || return 1

  target_platform="$(cft_platform)"
  relpath="$(cft_binary_relpath "$target_platform")"
  [[ -n "$target_platform" && -n "$relpath" ]] || return 1

  echo "${CFT_ROOT}/${version}/${target_platform}/${relpath}"
}

detect_bundle_binary() {
  local app_path="$1"
  shift
  local candidate
  for candidate in "$@"; do
    if [[ -x "${app_path}/Contents/MacOS/${candidate}" ]]; then
      echo "${app_path}/Contents/MacOS/${candidate}"
      return 0
    fi
  done
  return 1
}

detect_system_chrome_bin() {
  local os
  os="$(platform)"

  if [[ -n "${CHROME_USE_CHROME_APP:-}" ]]; then
    if [[ "$os" == "macos" ]]; then
      detect_bundle_binary "${CHROME_USE_CHROME_APP}" "Google Chrome for Testing" "Google Chrome" && return 0
    fi
  fi

  case "$os" in
    macos)
      if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
        echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        return 0
      fi
      if [[ -x "/Applications/Chrome.app/Contents/MacOS/Google Chrome" ]]; then
        echo "/Applications/Chrome.app/Contents/MacOS/Google Chrome"
        return 0
      fi
      ;;
    linux)
      for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
        if command -v "$candidate" >/dev/null 2>&1; then
          command -v "$candidate"
          return 0
        fi
      done
      ;;
    windows)
      return 1
      ;;
  esac

  return 1
}

detect_chrome_bin() {
  local candidate=""
  if [[ -n "${CHROME_USE_CHROME_BIN:-}" ]]; then
    echo "$CHROME_USE_CHROME_BIN"
    return 0
  fi

  case "$(browser_kind)" in
    system)
      candidate="$(detect_system_chrome_bin || true)"
      ;;
    cft)
      candidate="$(resolve_cft_binary_path || true)"
      ;;
    *)
      candidate="$(detect_system_chrome_bin || true)"
      ;;
  esac

  if [[ -n "$candidate" && -x "$candidate" ]]; then
    echo "$candidate"
    return 0
  fi

  return 1
}

detect_chrome_app_name() {
  if [[ -n "${CHROME_USE_CHROME_APP:-}" ]]; then
    basename "${CHROME_USE_CHROME_APP}" .app
    return
  fi

  case "$(browser_kind)" in
    cft) echo "Google Chrome for Testing" ;;
    *) echo "Google Chrome" ;;
  esac
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
  [[ "$command_line" == *"Google Chrome for Testing"* || "$command_line" == *"Google Chrome"* || "$command_line" == *"Agent Profile Chrome"* || "$command_line" == *"google-chrome"* || "$command_line" == *"chromium"* ]] || return 1
  [[ "$command_line" != *" --type="* ]] || return 1
  [[ "$command_line" != *" Helper"* ]] || return 1
  [[ "$command_line" != *"chrome_crashpad_handler"* ]] || return 1
  return 0
}

uses_expected_profile() {
  local command_line="${1:-}"
  [[ -n "$command_line" ]] || return 1

  if [[ "$command_line" == *"--user-data-dir="* && "$command_line" != *"--user-data-dir=${PROFILE_DIR}"* ]]; then
    return 1
  fi

  if [[ "$command_line" == *"--profile-directory="* && "$command_line" != *"--profile-directory=${PROFILE_NAME}"* ]]; then
    return 1
  fi

  if [[ "$command_line" != *"--profile-directory="* && "$PROFILE_NAME" != "Default" ]]; then
    return 1
  fi

  return 0
}

is_profile_root_process() {
  local command_line="${1:-}"
  is_browser_root_process "$command_line" || return 1
  uses_expected_profile "$command_line" || return 1
  return 0
}

list_matching_pids() {
  local pid command_line
  while read -r pid command_line; do
    [[ -n "${pid:-}" ]] || continue
    [[ "$command_line" == *"--remote-debugging-port=${DEBUG_PORT}"* ]] || continue
    if is_profile_root_process "$command_line"; then
      echo "$pid"
    fi
  done < <(ps ax -o pid= -o command=)
}

list_profile_root_pids() {
  local pid command_line
  while read -r pid command_line; do
    [[ -n "${pid:-}" ]] || continue
    if is_profile_root_process "$command_line"; then
      echo "$pid"
    fi
  done < <(ps ax -o pid= -o command=)
}

list_profile_root_commands() {
  local pid command_line
  while read -r pid command_line; do
    [[ -n "${pid:-}" ]] || continue
    if is_profile_root_process "$command_line"; then
      echo "$command_line"
    fi
  done < <(ps ax -o pid= -o command=)
}

list_browser_root_pids() {
  local pid command_line
  while read -r pid command_line; do
    [[ -n "${pid:-}" ]] || continue
    if is_browser_root_process "$command_line"; then
      echo "$pid"
    fi
  done < <(ps ax -o pid= -o command=)
}

list_profile_pids() {
  list_profile_root_pids
}
