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

detect_package_manager() {
  if [[ -f "$PROJECT_ROOT/pnpm-lock.yaml" ]]; then
    echo "pnpm"
    return 0
  fi

  if [[ -f "$PROJECT_ROOT/yarn.lock" ]]; then
    echo "yarn"
    return 0
  fi

  if [[ -f "$PROJECT_ROOT/package-lock.json" || -f "$PROJECT_ROOT/package.json" ]]; then
    echo "npm"
    return 0
  fi

  echo ""
}

read_package_script() {
  local package_dir="$1"
  local script_name="$2"

  node - "$package_dir" "$script_name" <<'NODE' 2>/dev/null || true
const fs = require("fs");
const path = require("path");

const [packageDir, scriptName] = process.argv.slice(2);
try {
  const packageJsonPath = path.join(packageDir, "package.json");
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const value = parsed?.scripts?.[scriptName];
  if (typeof value === "string") {
    process.stdout.write(value);
  }
} catch {}
NODE
}

resolve_runner_command() {
  local package_dir="$1"
  local script_name="$2"
  local package_manager="$3"

  case "$package_manager" in
    pnpm)
      if [[ "$package_dir" == "$PROJECT_ROOT" ]]; then
        printf 'pnpm run %s\n' "$script_name"
      else
        printf 'pnpm --dir %q run %s\n' "$package_dir" "$script_name"
      fi
      ;;
    yarn)
      if [[ "$package_dir" == "$PROJECT_ROOT" ]]; then
        printf 'yarn %s\n' "$script_name"
      else
        printf 'yarn --cwd %q %s\n' "$package_dir" "$script_name"
      fi
      ;;
    *)
      if [[ "$package_dir" == "$PROJECT_ROOT" ]]; then
        printf 'npm run %s\n' "$script_name"
      else
        printf 'npm --prefix %q run %s\n' "$package_dir" "$script_name"
      fi
      ;;
  esac
}

resolve_node_start_command() {
  local package_manager=""
  local script_body=""
  local package_dir=""
  local script_name=""

  package_manager="$(detect_package_manager)"
  if [[ -z "${package_manager:-}" ]]; then
    return 1
  fi

  if [[ -f "$PROJECT_ROOT/package.json" ]]; then
    for script_name in dev:web dev start:web start; do
      script_body="$(read_package_script "$PROJECT_ROOT" "$script_name")"
      if [[ -n "${script_body:-}" ]]; then
        resolve_runner_command "$PROJECT_ROOT" "$script_name" "$package_manager"
        return 0
      fi
    done
  fi

  for package_dir in "$PROJECT_ROOT/apps/web" "$PROJECT_ROOT/web" "$PROJECT_ROOT/frontend"; do
    if [[ ! -f "$package_dir/package.json" ]]; then
      continue
    fi

    for script_name in dev start; do
      script_body="$(read_package_script "$package_dir" "$script_name")"
      if [[ -n "${script_body:-}" ]]; then
        resolve_runner_command "$package_dir" "$script_name" "$package_manager"
        return 0
      fi
    done
  done

  return 1
}

spawn_detached() {
  local command="$1"
  local cwd="$2"
  local log_path="$3"

  PROJECT_ROOT_ENV="$cwd" START_COMMAND_ENV="$command" LOG_FILE_ENV="$log_path" python3 - <<'PY'
import os
import subprocess

cwd = os.environ["PROJECT_ROOT_ENV"]
command = os.environ["START_COMMAND_ENV"]
log_path = os.environ["LOG_FILE_ENV"]

with open(log_path, "ab", buffering=0) as log_file, open(os.devnull, "rb") as devnull:
    subprocess.Popen(
        ["bash", "-lc", command],
        cwd=cwd,
        stdin=devnull,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )
PY
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
  start_command="$(resolve_node_start_command || true)"
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
spawn_detached "$start_command" "$PROJECT_ROOT" "$log_file"

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
