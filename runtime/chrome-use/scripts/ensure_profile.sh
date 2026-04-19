#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/runtime_lib.sh"

START_URL="${1:-}"
START_URL="$("$SCRIPT_DIR/resolve_startup_url.sh" "$START_URL")"
LOG_FILE="${STATE_DIR}/chrome.log"
INSPECT_SCOPE_DIR="$(inspect_scope_dir)"
PREFERRED_TARGET_FILE="${INSPECT_SCOPE_DIR}/preferred-target.json"

launch_chrome() {
  local chrome_bin="$1"
  local os
  os="$(platform)"

  case "$os" in
    macos)
      local args=(
        --user-data-dir="$PROFILE_DIR"
        --profile-directory="$PROFILE_NAME"
        --remote-debugging-port="$DEBUG_PORT"
        --no-first-run
        --no-default-browser-check
      )
      if [[ -n "$START_URL" ]]; then
        args+=("$START_URL")
      fi
      "$chrome_bin" "${args[@]}" >>"$LOG_FILE" 2>&1 &
      ;;
    linux)
      local args=(
        --user-data-dir="$PROFILE_DIR"
        --profile-directory="$PROFILE_NAME"
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

quit_running_chrome() {
  local os
  local app_name
  local browser_pids
  os="$(platform)"
  browser_pids="$(list_profile_root_pids || true)"

  [[ -n "$browser_pids" ]] || return 0

  if [[ "$os" == "macos" ]]; then
    app_name="$(detect_chrome_app_name)"
    osascript -e "tell application \"$app_name\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      sleep 1
      browser_pids="$(list_browser_root_pids || true)"
      [[ -z "$browser_pids" ]] && return 0
    done
  fi

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done <<<"$browser_pids"

  sleep 2
}

url_encode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "$1"
}

open_tab_on_dedicated_instance() {
  local target_url="$1"
  local encoded_url
  local response

  [[ -n "$target_url" ]] || return 0

  encoded_url="$(url_encode "$target_url")"
  response="$(curl -fsS -X PUT "${DEBUG_URL}/json/new?${encoded_url}" 2>/dev/null || true)"
  if [[ -n "$response" ]]; then
    mkdir -p "$INSPECT_SCOPE_DIR"
    node - "$response" "$PREFERRED_TARGET_FILE" "$target_url" <<'NODE'
const [response, filePath, targetUrl] = process.argv.slice(2);
try {
  const parsed = JSON.parse(response);
  const payload = {
    targetId: parsed.id || null,
    url: parsed.url || targetUrl || null,
    recordedAt: new Date().toISOString(),
  };
  require("fs").writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
} catch {}
NODE
  fi
}

find_matching_target_for_url() {
  local target_url="$1"
  local payload

  [[ -n "$target_url" ]] || return 0

  payload="$(curl -fsS "${DEBUG_URL}/json/list" 2>/dev/null || true)"
  [[ -n "$payload" ]] || return 0

  node - "$payload" "$target_url" <<'NODE'
const [payload, targetUrl] = process.argv.slice(2);
function normalize(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value || "";
  }
}
try {
  const items = JSON.parse(payload);
  const pages = Array.isArray(items) ? items.filter((item) => item && item.type === "page") : [];
  const normalizedTarget = normalize(targetUrl);
  const match = pages.find((item) => normalize(item.url) === normalizedTarget);
  if (match?.id) {
    process.stdout.write(String(match.id));
  }
} catch {}
NODE
}

close_duplicate_targets_for_url() {
  local target_url="$1"
  local keep_target_id="$2"
  local payload

  [[ -n "$target_url" ]] || return 0

  payload="$(curl -fsS "${DEBUG_URL}/json/list" 2>/dev/null || true)"
  [[ -n "$payload" ]] || return 0

  node - "$payload" "$target_url" "$keep_target_id" <<'NODE' | while IFS= read -r target_id; do
const [payload, targetUrl, keepTargetId] = process.argv.slice(2);
function normalize(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value || "";
  }
}
try {
  const items = JSON.parse(payload);
  const pages = Array.isArray(items) ? items.filter((item) => item && item.type === "page") : [];
  const normalizedTarget = normalize(targetUrl);
  for (const item of pages) {
    if (!item?.id || item.id === keepTargetId) continue;
    if (normalize(item.url) === normalizedTarget) {
      process.stdout.write(`${item.id}\n`);
    }
  }
} catch {}
NODE
    [[ -n "$target_id" ]] || continue
    curl -fsS "http://127.0.0.1:${DEBUG_PORT}/json/close/${target_id}" >/dev/null 2>&1 || true
  done
}

activate_existing_target() {
  local target_id="$1"
  [[ -n "$target_id" ]] || return 1
  curl -fsS "http://127.0.0.1:${DEBUG_PORT}/json/activate/${target_id}" >/dev/null 2>&1 || return 1
  return 0
}

should_activate_existing_target() {
  [[ "${CHROME_USE_ACTIVATE_EXISTING_TARGET:-0}" == "1" ]]
}

record_preferred_target_for_url() {
  local target_url="$1"
  local payload

  [[ -n "$target_url" ]] || return 0

  payload="$(curl -fsS "${DEBUG_URL}/json/list" 2>/dev/null || true)"
  [[ -n "$payload" ]] || return 0

  mkdir -p "$INSPECT_SCOPE_DIR"
  node - "$payload" "$PREFERRED_TARGET_FILE" "$target_url" <<'NODE'
const [payload, filePath, targetUrl] = process.argv.slice(2);
const fs = require("fs");
function normalize(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value || "";
  }
}
try {
  const items = JSON.parse(payload);
  const pages = Array.isArray(items) ? items.filter((item) => item && item.type === "page") : [];
  const normalizedTarget = normalize(targetUrl);
  const preferred = pages.find((item) => normalize(item.url) === normalizedTarget) || null;
  if (!preferred) process.exit(0);
  const record = {
    targetId: preferred.id || null,
    url: preferred.url || targetUrl || null,
    recordedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
} catch {}
NODE
}

wait_for_browser_instance() {
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
      echo "$(expected_browser_owner_label) must expose ${DEBUG_URL} from exactly one owner process; found ${matching_count} process(es)." >&2
      return 1
    fi

    if [[ "$matching_count" -eq 0 ]]; then
      continue
    fi

    pid="$(awk 'NF { print; exit }' <<<"$matching_pids")"
    echo "$pid"
    return 0
  done

  return 1
}

ensure_endpoint_owned_by_profile() {
  local matching_pids
  local matching_count
  local pid

  if ! is_endpoint_ready; then
    return 1
  fi

  matching_pids="$(list_matching_pids || true)"
  matching_count="$(count_lines "$matching_pids")"

  if [[ "$matching_count" -gt 1 ]]; then
    echo "$(expected_browser_owner_label) must expose ${DEBUG_URL} from exactly one owner process; found ${matching_count} process(es)." >&2
    exit 1
  fi

  if [[ "$matching_count" -eq 0 ]]; then
    echo "A Chrome debug endpoint is listening on ${DEBUG_URL}, but it is not owned by $(expected_browser_owner_label) with profile ${PROFILE_NAME}." >&2
    exit 1
  fi

  pid="$(awk 'NF { print; exit }' <<<"$matching_pids")"
  echo "$pid"
  return 0
}

mkdir -p "$STATE_DIR"
mkdir -p "$PROFILE_DIR"

chrome_bin="$(detect_chrome_bin)"
if [[ -z "$chrome_bin" && "$(platform)" != "windows" ]]; then
  if [[ "$(browser_kind)" == "cft" ]]; then
    echo "Could not find a managed Chrome for Testing binary." >&2
    echo "Re-run the installer so it downloads Chrome for Testing, or set CHROME_USE_CHROME_BIN explicitly." >&2
  else
    echo "Could not find a Chrome binary. Set CHROME_USE_CHROME_BIN explicitly." >&2
  fi
  exit 1
fi

if ensure_endpoint_owned_by_profile >/dev/null; then
  existing_target_id="$(find_matching_target_for_url "$START_URL")"
  if [[ -n "${existing_target_id:-}" ]]; then
    if should_activate_existing_target; then
      activate_existing_target "$existing_target_id" || true
    fi
    close_duplicate_targets_for_url "$START_URL" "$existing_target_id"
  else
    open_tab_on_dedicated_instance "$START_URL"
  fi
  record_preferred_target_for_url "$START_URL"
  echo "$DEBUG_URL"
  exit 0
fi

quit_running_chrome

launch_chrome "$chrome_bin"

if wait_for_browser_instance >/dev/null; then
  record_preferred_target_for_url "$START_URL"
  echo "$DEBUG_URL"
  exit 0
fi

if [[ "$(browser_kind)" == "system" ]] && uses_default_chrome_profile; then
  echo "Google Chrome launched with --remote-debugging-port=${DEBUG_PORT}, but ${DEBUG_URL} never came up." >&2
  echo "Chrome 136+ ignores remote debugging switches on the default Chrome data directory." >&2
  echo "Direct CDP attach to Google Chrome.app Default is blocked; use a non-standard --user-data-dir if you need CDP." >&2
  exit 1
fi

echo "Timed out waiting for $(expected_browser_owner_label) profile ${PROFILE_NAME} to expose ${DEBUG_URL}." >&2
exit 1
