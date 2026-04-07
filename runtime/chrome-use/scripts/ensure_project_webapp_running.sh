#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_URL="${1:-}"
PROJECT_ROOT="$("$SCRIPT_DIR/resolve_project_root.sh" 2>/dev/null || true)"
STATE_DIR="${CHROME_USE_STATE_DIR:-$HOME/.chrome-use/state}"

if [[ "${CHROME_INSPECT_AUTO_START_WEBAPP:-0}" != "1" ]]; then
  exit 0
fi

if [[ -z "$PROJECT_ROOT" || ! -d "$PROJECT_ROOT" ]]; then
  exit 0
fi

if [[ -z "$TARGET_URL" ]]; then
  exit 0
fi

if [[ "$TARGET_URL" != http://* && "$TARGET_URL" != https://* ]]; then
  exit 0
fi

if [[ ! "$TARGET_URL" == http://localhost* && ! "$TARGET_URL" == https://localhost* && ! "$TARGET_URL" == http://127.0.0.1* && ! "$TARGET_URL" == https://127.0.0.1* ]]; then
  exit 0
fi

is_http_reachable() {
  curl -fsS --max-time 2 "$1" >/dev/null 2>&1
}

host_port_from_url() {
  local url="$1"
  url="${url#http://}"
  url="${url#https://}"
  url="${url%%/*}"
  if [[ "$url" == *:* ]]; then
    echo "$url"
  else
    echo "$url:80"
  fi
}

list_port_listeners() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  lsof -iTCP:"$port" -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR > 1 {
    printf "%s(pid=%s,%s)\n", $1, $2, $9;
  }'
}

entry_url="$($SCRIPT_DIR/project_webapp_entry.sh "$PROJECT_ROOT")"
if [[ -z "$entry_url" ]]; then
  exit 0
fi

if [[ "$(host_port_from_url "$TARGET_URL")" != "$(host_port_from_url "$entry_url")" ]]; then
  exit 0
fi

if is_http_reachable "$TARGET_URL"; then
  exit 0
fi

start_command=""
if [[ -f "$PROJECT_ROOT/build.sh" ]]; then
  if grep -qE "make[[:space:]]+devserver" "$PROJECT_ROOT/build.sh"; then
    start_command="make devserver"
  elif grep -qE "make[[:space:]]+serve" "$PROJECT_ROOT/build.sh"; then
    start_command="make serve"
  elif grep -qE "python[[:space:]].* -m http\\.server" "$PROJECT_ROOT/build.sh"; then
    start_command="$(grep -Eo "python[^\\n]* -m http\\.server[^\\n]*" "$PROJECT_ROOT/build.sh" | head -n 1)"
  fi
fi

if [[ -z "$start_command" && -f "$PROJECT_ROOT/Makefile" ]]; then
  if rg -q '^devserver:' "$PROJECT_ROOT/Makefile"; then
    start_command="make devserver"
  elif rg -q '^serve:' "$PROJECT_ROOT/Makefile"; then
    start_command="make serve"
  elif rg -q '^serve-global:' "$PROJECT_ROOT/Makefile"; then
    start_command="make serve-global"
  fi
fi

if [[ -z "$start_command" ]]; then
  exit 0
fi

host_port="$(host_port_from_url "$TARGET_URL")"
listen_port="${host_port##*:}"

if command -v lsof >/dev/null 2>&1; then
  if lsof -iTCP:"$listen_port" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    for attempt in $(seq 1 5); do
      if is_http_reachable "$TARGET_URL"; then
        exit 0
      fi
      sleep 1
    done

    listener_summary="$(list_port_listeners "$listen_port" | paste -sd '; ' -)"
    cat >&2 <<EOF
Port ${listen_port} is already listening, but ${TARGET_URL} is still not reachable.
chrome-use did not start another local web server because the existing listener would conflict with the expected project preview.
${listener_summary:+Listeners: ${listener_summary}}
EOF
    exit 1
  fi
else
  if is_http_reachable "$TARGET_URL"; then
    exit 0
  fi
fi

mkdir -p "$STATE_DIR"
log_file="${STATE_DIR}/project-webapp.log"
( cd "$PROJECT_ROOT" && nohup bash -lc "$start_command" >>"$log_file" 2>&1 & ) >/dev/null 2>&1

for attempt in $(seq 1 60); do
  if is_http_reachable "$TARGET_URL"; then
    exit 0
  fi
  sleep 1
done

cat >&2 <<EOF
Failed to start project web app at ${TARGET_URL} with: ${start_command}
EOF
exit 1
