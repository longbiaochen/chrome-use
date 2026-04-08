#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="$REPO_ROOT/runtime/chrome-use"
SKILLS_ROOT="$REPO_ROOT/skills"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chrome-use-runtime-tests.XXXXXX")"
MOCK_BIN="$TMP_ROOT/bin"
ORIGINAL_PATH="$PATH"
mkdir -p "$MOCK_BIN"

cleanup() {
  rm -rf "$TMP_ROOT"
}

trap cleanup EXIT

cat >"$MOCK_BIN/uname" <<'EOF'
#!/usr/bin/env bash
echo "${MOCK_UNAME:-Darwin}"
EOF
chmod +x "$MOCK_BIN/uname"

cat >"$MOCK_BIN/ps" <<'EOF'
#!/usr/bin/env bash
cat "${MOCK_PS_FILE:?}"
EOF
chmod +x "$MOCK_BIN/ps"

cat >"$MOCK_BIN/seq" <<'EOF'
#!/usr/bin/env bash
start="${1:-1}"
end="${2:-$start}"
current="$start"
while [[ "$current" -le "$end" ]]; do
  echo "$current"
  current=$((current + 1))
done
EOF
chmod +x "$MOCK_BIN/seq"

cat >"$MOCK_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCK_BIN/sleep"

cat >"$MOCK_BIN/kill" <<'EOF'
#!/usr/bin/env bash
pid="${1:-}"
if [[ -n "${MOCK_KILL_LOG:-}" ]]; then
  echo "$pid" >>"$MOCK_KILL_LOG"
fi
if [[ -n "${MOCK_PS_FILE:-}" ]]; then
  : >"$MOCK_PS_FILE"
fi
exit 0
EOF
chmod +x "$MOCK_BIN/kill"

cat >"$MOCK_BIN/open" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${MOCK_OPEN_LOG:-}" ]]; then
  printf '%s\n' "$*" >>"$MOCK_OPEN_LOG"
fi
if [[ -n "${MOCK_OPEN_PS_CONTENT:-}" ]]; then
  printf '%s\n' "$MOCK_OPEN_PS_CONTENT" >"$MOCK_PS_FILE"
fi
if [[ -n "${MOCK_WINDOW_COUNT_AFTER_OPEN:-}" ]]; then
  printf '%s' "$MOCK_WINDOW_COUNT_AFTER_OPEN" >"$MOCK_WINDOW_COUNT_FILE"
fi
exit 0
EOF
chmod +x "$MOCK_BIN/open"

cat >"$MOCK_BIN/nohup" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${MOCK_NOHUP_LOG:-}" ]]; then
  printf '%s\n' "$*" >>"$MOCK_NOHUP_LOG"
fi
if [[ "${MOCK_NOHUP_BEHAVIOR:-noop}" == "exec" ]]; then
  exec "$@"
fi
exit 0
EOF
chmod +x "$MOCK_BIN/nohup"

cat >"$MOCK_BIN/osascript" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
if [[ -n "${MOCK_OSASCRIPT_FAIL:-}" ]]; then
  exit 1
fi
cat "${MOCK_WINDOW_COUNT_FILE:?}"
EOF
chmod +x "$MOCK_BIN/osascript"

cat >"$MOCK_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${MOCK_LSOF_OUTPUT_FILE:-}" && -s "${MOCK_LSOF_OUTPUT_FILE}" ]]; then
  cat "${MOCK_LSOF_OUTPUT_FILE}"
  exit 0
fi
exit "${MOCK_LSOF_STATUS:-1}"
EOF
chmod +x "$MOCK_BIN/lsof"

cat >"$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
args=("$@")
last_arg="${args[$((${#args[@]} - 1))]}"

if [[ "$last_arg" == *"/json/version" ]]; then
  count=0
  if [[ -f "${MOCK_VERSION_COUNT_FILE:?}" ]]; then
    count="$(cat "$MOCK_VERSION_COUNT_FILE")"
  fi
  count=$((count + 1))
  printf '%s' "$count" >"$MOCK_VERSION_COUNT_FILE"
  ready_after="${MOCK_ENDPOINT_READY_AFTER:-1}"
  if [[ "$count" -lt "$ready_after" ]]; then
    exit 22
  fi
  printf '{"Browser":"Chrome"}\n'
  exit 0
fi

if [[ "$last_arg" == *"/json/new?"* ]]; then
  if [[ -n "${MOCK_NEW_TAB_LOG:-}" ]]; then
    printf '%s\n' "$last_arg" >>"$MOCK_NEW_TAB_LOG"
  fi
  printf '{"id":"new-tab"}\n'
  exit 0
fi

if [[ "$last_arg" == *"/json/list" ]]; then
  if [[ -n "${MOCK_JSON_LIST_FILE:-}" && -f "${MOCK_JSON_LIST_FILE}" ]]; then
    cat "${MOCK_JSON_LIST_FILE}"
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$last_arg" == http://* || "$last_arg" == https://* ]]; then
  if [[ -n "${MOCK_HTTP_REACHABLE_URL:-}" && "$last_arg" == "$MOCK_HTTP_REACHABLE_URL" ]]; then
    printf '<html></html>\n'
    exit 0
  fi
  exit 22
fi

exit 1
EOF
chmod +x "$MOCK_BIN/curl"

failures=0

log_ok() {
  echo "OK: $1"
}

log_fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$expected" != "$actual" ]]; then
    log_fail "$label: expected '$expected', got '$actual'"
  else
    log_ok "$label"
  fi
}

assert_contains() {
  local needle="$1"
  local haystack="$2"
  local label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    log_fail "$label: expected to find '$needle'"
  else
    log_ok "$label"
  fi
}

assert_not_contains() {
  local needle="$1"
  local haystack="$2"
  local label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    log_fail "$label: did not expect to find '$needle'"
  else
    log_ok "$label"
  fi
}

assert_file_lines() {
  local file="$1"
  local expected="$2"
  local label="$3"
  local actual="0"
  if [[ -f "$file" ]]; then
    actual="$(awk 'END { print NR + 0 }' "$file")"
  fi
  assert_eq "$expected" "$actual" "$label"
}

setup_case() {
  CASE_DIR="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  export PATH="$MOCK_BIN:$ORIGINAL_PATH"
  export CHROME_USE_PROFILE_DIR="$CASE_DIR/agent-profile"
  export CHROME_USE_STATE_DIR="$CASE_DIR/state"
  export CHROME_USE_DEBUG_PORT="9223"
  export CHROME_USE_DEBUG_HOST="127.0.0.1"
  export MOCK_PS_FILE="$CASE_DIR/ps.txt"
  export MOCK_WINDOW_COUNT_FILE="$CASE_DIR/window-count.txt"
  export MOCK_VERSION_COUNT_FILE="$CASE_DIR/version-count.txt"
  export MOCK_OPEN_LOG="$CASE_DIR/open.log"
  export MOCK_NEW_TAB_LOG="$CASE_DIR/new-tab.log"
  export MOCK_KILL_LOG="$CASE_DIR/kill.log"
  export MOCK_NOHUP_LOG="$CASE_DIR/nohup.log"
  export MOCK_UNAME="Darwin"
  export MOCK_ENDPOINT_READY_AFTER="1"
  export MOCK_OPEN_PS_CONTENT=""
  export MOCK_WINDOW_COUNT_AFTER_OPEN="1"
  export MOCK_JSON_LIST_FILE="$CASE_DIR/json-list.json"
  export MOCK_LSOF_OUTPUT_FILE="$CASE_DIR/lsof.txt"
  export MOCK_LSOF_STATUS="1"
  unset MOCK_HTTP_REACHABLE_URL
  unset MOCK_NOHUP_BEHAVIOR
  unset MOCK_OSASCRIPT_FAIL

  : >"$MOCK_PS_FILE"
  printf '1' >"$MOCK_WINDOW_COUNT_FILE"
  printf '0' >"$MOCK_VERSION_COUNT_FILE"
  printf '[]\n' >"$MOCK_JSON_LIST_FILE"
  : >"$MOCK_LSOF_OUTPUT_FILE"
}

run_ensure() {
  local output_file="$CASE_DIR/ensure.out"
  local error_file="$CASE_DIR/ensure.err"
  if bash "$RUNTIME_ROOT/scripts/ensure_profile.sh" "${1:-}" >"$output_file" 2>"$error_file"; then
    ENSURE_STATUS=0
  else
    ENSURE_STATUS=$?
  fi
  ENSURE_STDOUT="$(cat "$output_file" 2>/dev/null || true)"
  ENSURE_STDERR="$(cat "$error_file" 2>/dev/null || true)"
}

run_doctor() {
  local output_file="$CASE_DIR/doctor.out"
  local error_file="$CASE_DIR/doctor.err"
  if bash "$RUNTIME_ROOT/scripts/doctor.sh" >"$output_file" 2>"$error_file"; then
    DOCTOR_STATUS=0
  else
    DOCTOR_STATUS=$?
  fi
  DOCTOR_STDOUT="$(cat "$output_file" 2>/dev/null || true)"
  DOCTOR_STDERR="$(cat "$error_file" 2>/dev/null || true)"
}

run_ensure_project_webapp() {
  local target_url="$1"
  local output_file="$CASE_DIR/ensure-project.out"
  local error_file="$CASE_DIR/ensure-project.err"
  if bash "$RUNTIME_ROOT/scripts/ensure_project_webapp_running.sh" "$target_url" >"$output_file" 2>"$error_file"; then
    ENSURE_PROJECT_STATUS=0
  else
    ENSURE_PROJECT_STATUS=$?
  fi
  ENSURE_PROJECT_STDOUT="$(cat "$output_file" 2>/dev/null || true)"
  ENSURE_PROJECT_STDERR="$(cat "$error_file" 2>/dev/null || true)"
}

test_launches_dedicated_instance() {
  setup_case
  export MOCK_ENDPOINT_READY_AFTER="2"
  export MOCK_OPEN_PS_CONTENT="123 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=$CHROME_USE_PROFILE_DIR --remote-debugging-port=9223 about:blank"

  run_ensure "https://example.com"

  assert_eq "0" "$ENSURE_STATUS" "launch case exits successfully"
  assert_eq "http://127.0.0.1:9223" "$ENSURE_STDOUT" "launch case returns debug URL"
  assert_file_lines "$MOCK_OPEN_LOG" "1" "launch case invokes Chrome open once"
  assert_file_lines "$MOCK_NEW_TAB_LOG" "0" "launch case does not open a follow-up new tab"
}

test_reuses_running_instance_with_new_tab() {
  setup_case
  printf '456 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=%s --remote-debugging-port=9223 about:blank\n' "$CHROME_USE_PROFILE_DIR" >"$MOCK_PS_FILE"

  run_ensure "https://example.com/path?q=1"

  assert_eq "0" "$ENSURE_STATUS" "reuse case exits successfully"
  assert_eq "http://127.0.0.1:9223" "$ENSURE_STDOUT" "reuse case returns debug URL"
  assert_file_lines "$MOCK_OPEN_LOG" "0" "reuse case does not relaunch Chrome"
  assert_file_lines "$MOCK_NEW_TAB_LOG" "1" "reuse case opens one new tab"
  assert_contains "/json/new?https%3A%2F%2Fexample.com%2Fpath%3Fq%3D1" "$(cat "$MOCK_NEW_TAB_LOG" 2>/dev/null || true)" "reuse case encodes tab URL"
}

test_cleans_stale_profile_process_before_launch() {
  setup_case
  export MOCK_ENDPOINT_READY_AFTER="2"
  printf '999 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=%s\n' "$CHROME_USE_PROFILE_DIR" >"$MOCK_PS_FILE"
  export MOCK_OPEN_PS_CONTENT="123 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=$CHROME_USE_PROFILE_DIR --remote-debugging-port=9223 about:blank"

  run_ensure

  assert_eq "0" "$ENSURE_STATUS" "stale cleanup case exits successfully"
  assert_file_lines "$MOCK_OPEN_LOG" "1" "stale cleanup case relaunches Chrome once"
}

test_blocks_multiple_dedicated_processes() {
  setup_case
  cat >"$MOCK_PS_FILE" <<EOF
101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=$CHROME_USE_PROFILE_DIR --remote-debugging-port=9223
202 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=$CHROME_USE_PROFILE_DIR --remote-debugging-port=9223
EOF

  run_ensure

  assert_eq "1" "$ENSURE_STATUS" "multiple process case fails"
  assert_contains "exactly one owning process" "$ENSURE_STDERR" "multiple process case explains blocker"
}

test_blocks_multiple_dedicated_windows() {
  setup_case
  printf '303 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=%s --remote-debugging-port=9223\n' "$CHROME_USE_PROFILE_DIR" >"$MOCK_PS_FILE"
  printf '2' >"$MOCK_WINDOW_COUNT_FILE"

  run_ensure

  assert_eq "1" "$ENSURE_STATUS" "multiple window case fails"
  assert_contains "exactly one window" "$ENSURE_STDERR" "multiple window case explains blocker"
}

test_blocks_wrong_endpoint_owner() {
  setup_case
  printf '404 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/other-profile --remote-debugging-port=9223\n' >"$MOCK_PS_FILE"

  run_ensure

  assert_eq "1" "$ENSURE_STATUS" "wrong owner case fails"
  assert_contains "no Chrome process is using the expected profile" "$ENSURE_STDERR" "wrong owner case explains blocker"
}

test_allows_other_profiles() {
  setup_case
  cat >"$MOCK_PS_FILE" <<EOF
505 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=$CHROME_USE_PROFILE_DIR --remote-debugging-port=9223
606 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default
EOF

  run_ensure "https://example.com/other"

  assert_eq "0" "$ENSURE_STATUS" "other profile case exits successfully"
  assert_file_lines "$MOCK_NEW_TAB_LOG" "1" "other profile case still opens one new tab on dedicated instance"
}

test_doctor_reports_ready_state() {
  setup_case
  printf '707 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=%s --remote-debugging-port=9223\n' "$CHROME_USE_PROFILE_DIR" >"$MOCK_PS_FILE"

  run_doctor

  assert_eq "0" "$DOCTOR_STATUS" "doctor ready case exits successfully"
  assert_contains "Matching PID count: 1" "$DOCTOR_STDOUT" "doctor ready case reports matching pid count"
  assert_contains "Window count: 1" "$DOCTOR_STDOUT" "doctor ready case reports window count"
  assert_contains "Status: dedicated profile is ready" "$DOCTOR_STDOUT" "doctor ready case reports success"
}

test_doctor_reports_window_blocker() {
  setup_case
  printf '808 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=%s --remote-debugging-port=9223\n' "$CHROME_USE_PROFILE_DIR" >"$MOCK_PS_FILE"
  printf '2' >"$MOCK_WINDOW_COUNT_FILE"

  run_doctor

  assert_eq "1" "$DOCTOR_STATUS" "doctor multiple window case fails"
  assert_contains "Window count: 2" "$DOCTOR_STDOUT" "doctor multiple window case reports window count"
  assert_contains "must have exactly one window" "$DOCTOR_STDOUT" "doctor multiple window case reports blocker"
}

test_allows_page_target_fallback_when_window_probe_reports_zero() {
  setup_case
  printf '909 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=%s --remote-debugging-port=9223\n' "$CHROME_USE_PROFILE_DIR" >"$MOCK_PS_FILE"
  printf '0' >"$MOCK_WINDOW_COUNT_FILE"
  printf '[{"id":"page-1","type":"page","url":"http://127.0.0.1:8000/"}]\n' >"$MOCK_JSON_LIST_FILE"

  run_ensure "https://example.com/fallback"

  assert_eq "0" "$ENSURE_STATUS" "page-target fallback case exits successfully"
  assert_file_lines "$MOCK_NEW_TAB_LOG" "1" "page-target fallback case still opens one new tab"

  run_doctor

  assert_eq "0" "$DOCTOR_STATUS" "doctor page-target fallback case exits successfully"
  assert_contains "Window count: 0" "$DOCTOR_STDOUT" "doctor page-target fallback case reports zero windows"
  assert_contains "Page target count: 1" "$DOCTOR_STDOUT" "doctor page-target fallback case reports one page target"
  assert_contains "page-target fallback" "$DOCTOR_STDOUT" "doctor page-target fallback case reports fallback readiness"
}

test_ignores_renderer_helpers_for_process_ownership() {
  setup_case
  cat >"$MOCK_PS_FILE" <<EOF
707 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=$CHROME_USE_PROFILE_DIR --remote-debugging-port=9223
708 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/146.0.7680.165/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=$CHROME_USE_PROFILE_DIR --remote-debugging-port=9223
709 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/146.0.7680.165/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process --user-data-dir=$CHROME_USE_PROFILE_DIR
EOF

  run_ensure "https://example.com/helper-test"

  assert_eq "0" "$ENSURE_STATUS" "helper process case exits successfully"
  assert_file_lines "$MOCK_NEW_TAB_LOG" "1" "helper process case still opens one new tab"

  run_doctor

  assert_eq "0" "$DOCTOR_STATUS" "doctor helper process case exits successfully"
  assert_contains "Dedicated PID count: 1" "$DOCTOR_STDOUT" "doctor helper process case reports one owner pid"
  assert_contains "Matching PID count: 1" "$DOCTOR_STDOUT" "doctor helper process case reports one matching pid"
  assert_contains "Profile owner PID(s): 707" "$DOCTOR_STDOUT" "doctor helper process case reports browser root pid"
}

test_blocks_project_webapp_restart_on_port_conflict() {
  setup_case
  local project_root="$CASE_DIR/project"
  mkdir -p "$project_root"
  cat >"$project_root/Makefile" <<'EOF'
serve:
	python -m http.server 4321
EOF
  cat >"$MOCK_LSOF_OUTPUT_FILE" <<'EOF'
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
python3  4242 user    3u  IPv4 0x0000000000000000      0t0  TCP 127.0.0.1:4321 (LISTEN)
EOF
  export CHROME_INSPECT_AUTO_START_WEBAPP="1"
  export CHROME_INSPECT_PROJECT_ROOT="$project_root"

  run_ensure_project_webapp "http://127.0.0.1:4321/"

  assert_eq "1" "$ENSURE_PROJECT_STATUS" "project webapp port conflict fails fast"
  assert_contains "Port 4321 is already listening" "$ENSURE_PROJECT_STDERR" "project webapp port conflict explains listener blocker"
  assert_contains "python3(pid=4242,127.0.0.1:4321)" "$ENSURE_PROJECT_STDERR" "project webapp port conflict reports listener summary"
  assert_file_lines "$MOCK_NOHUP_LOG" "0" "project webapp port conflict does not launch a second server"
}

test_reuses_reachable_project_webapp_listener() {
  setup_case
  local project_root="$CASE_DIR/project"
  mkdir -p "$project_root"
  cat >"$project_root/Makefile" <<'EOF'
serve:
	python -m http.server 4321
EOF
  cat >"$MOCK_LSOF_OUTPUT_FILE" <<'EOF'
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
python3  5252 user    3u  IPv4 0x0000000000000000      0t0  TCP 127.0.0.1:4321 (LISTEN)
EOF
  export CHROME_INSPECT_AUTO_START_WEBAPP="1"
  export CHROME_INSPECT_PROJECT_ROOT="$project_root"
  export MOCK_HTTP_REACHABLE_URL="http://127.0.0.1:4321/"

  run_ensure_project_webapp "http://127.0.0.1:4321/"

  assert_eq "0" "$ENSURE_PROJECT_STATUS" "project webapp reachable listener is reused"
  assert_file_lines "$MOCK_NOHUP_LOG" "0" "project webapp reachable listener does not relaunch server"
}

test_inspect_capture_wrapper_targets_shared_runtime() {
  setup_case
  local mock_node_dir="$CASE_DIR/mock-node"
  mkdir -p "$mock_node_dir"
  cat >"$mock_node_dir/node" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${MOCK_NODE_LOG:-}" ]]; then
  printf '%s\n' "$*" >>"$MOCK_NODE_LOG"
fi
exit 0
EOF
  chmod +x "$mock_node_dir/node"

  MOCK_NODE_LOG="$CASE_DIR/node.log" PATH="$mock_node_dir:$PATH" bash "$SKILLS_ROOT/chrome-inspect/scripts/inspect-capture" begin --project-root "/tmp/project" >"$CASE_DIR/inspect.out" 2>"$CASE_DIR/inspect.err" || true
  local node_args
  node_args="$(cat "$CASE_DIR/node.log" 2>/dev/null || true)"

  assert_contains "runtime/chrome-use/scripts/inspect_capture.mjs begin --project-root /tmp/project" "$node_args" "inspect-capture wrapper delegates to shared runtime"
}

test_auth_cdp_wrapper_targets_shared_runtime() {
  setup_case
  local mock_node_dir="$CASE_DIR/mock-node"
  mkdir -p "$mock_node_dir"
  cat >"$mock_node_dir/node" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${MOCK_NODE_LOG:-}" ]]; then
  printf '%s\n' "$*" >>"$MOCK_NODE_LOG"
fi
exit 0
EOF
  chmod +x "$mock_node_dir/node"

  MOCK_NODE_LOG="$CASE_DIR/node.log" PATH="$mock_node_dir:$PATH" bash "$SKILLS_ROOT/chrome-auth/scripts/auth-cdp" status >"$CASE_DIR/auth.out" 2>"$CASE_DIR/auth.err" || true
  local node_args
  node_args="$(cat "$CASE_DIR/node.log" 2>/dev/null || true)"

  assert_contains "runtime/chrome-use/scripts/auth_cdp.mjs status" "$node_args" "auth-cdp wrapper delegates to shared runtime"
}

test_auth_cdp_source_tracks_page_context_and_richer_actions() {
  local auth_source
  auth_source="$(cat "$RUNTIME_ROOT/scripts/auth_cdp.mjs")"

  assert_contains 'auth-cdp list-pages' "$auth_source" "auth-cdp usage exposes list-pages"
  assert_contains 'auth-cdp select-page --page-id <id>' "$auth_source" "auth-cdp usage exposes select-page"
  assert_contains 'auth-cdp wait-for --text <value>' "$auth_source" "auth-cdp usage exposes wait-for"
  assert_contains 'auth-cdp hover --selector <css>' "$auth_source" "auth-cdp usage exposes hover"
  assert_contains 'auth-cdp fill --selector <css> --text <text>' "$auth_source" "auth-cdp usage exposes fill"
  assert_contains 'auth-cdp press-key --key <key>' "$auth_source" "auth-cdp usage exposes press-key"
  assert_contains 'auth-cdp screenshot [--selector <css>]' "$auth_source" "auth-cdp usage exposes screenshot"
  assert_contains 'auth-cdp snapshot [--mode dom|a11y]' "$auth_source" "auth-cdp usage exposes snapshot modes"
  assert_contains 'getSelectedPagePath' "$auth_source" "auth-cdp persists selected page state"
  assert_contains 'resolvePageState' "$auth_source" "auth-cdp resolves selected page from browser state"
  assert_contains 'pages[pages.length - 1]' "$auth_source" "auth-cdp falls back to latest page instead of the first page"
  assert_contains 'Accessibility.getFullAXTree' "$auth_source" "auth-cdp uses accessibility tree snapshots"
  assert_contains 'Input.dispatchMouseEvent' "$auth_source" "auth-cdp uses mouse events for hover and click"
  assert_contains 'Input.dispatchKeyEvent' "$auth_source" "auth-cdp supports keyboard actions"
  assert_contains 'waitForSelector' "$auth_source" "auth-cdp waits for selectors before acting"
  assert_contains 'waitForText' "$auth_source" "auth-cdp waits for visible text"
}

test_inspect_capture_latest_reads_persisted_selection_without_runtime() {
  setup_case
  local scope_dir="$CHROME_USE_STATE_DIR/inspect/127.0.0.1-9223"
  mkdir -p "$scope_dir/events"
  cat >"$scope_dir/events/current-selection.json" <<'EOF'
{
  "workflowId": "wf-latest",
  "payload": {
    "observedAt": "2026-04-07T02:00:00.000Z",
    "page": {
      "url": "http://127.0.0.1:8000/next.html",
      "title": "Next"
    },
    "selectedElement": {
      "nodeName": "DIV",
      "selectorHint": "#latest-panel",
      "id": "latest-panel",
      "className": "panel current",
      "ariaLabel": "Latest panel",
      "snippet": "<div id=\"latest-panel\">Latest</div>"
    },
    "position": {
      "x": 10,
      "y": 20,
      "width": 30,
      "height": 40
    }
  }
}
EOF

  local output
  output="$(node "$RUNTIME_ROOT/scripts/inspect_capture.mjs" latest --browser-url "http://127.0.0.1:9223")"

  assert_contains '"workflowId":"wf-latest"' "$output" "inspect-capture latest returns persisted workflow id"
  assert_contains '"url":"http://127.0.0.1:8000/next.html"' "$output" "inspect-capture latest returns persisted page url"
  assert_contains '"selectorHint":"#latest-panel"' "$output" "inspect-capture latest returns persisted selector"
  assert_contains '"selectionHistoryPath":"' "$output" "inspect-capture latest exposes selection history path"
}

test_inspect_runtime_source_tracks_navigation_rearm() {
  local runtime_source
  runtime_source="$(cat "$RUNTIME_ROOT/scripts/inspect_runtime.mjs")"

  assert_contains "Page.addScriptToEvaluateOnNewDocument" "$runtime_source" "inspect runtime registers new-document bootstrap"
  assert_contains "Page.frameNavigated" "$runtime_source" "inspect runtime listens for frame navigation"
  assert_contains "Page.loadEventFired" "$runtime_source" "inspect runtime listens for load completion"
  assert_contains "Page.navigatedWithinDocument" "$runtime_source" "inspect runtime listens for same-document navigation"
  assert_contains "rearmCaptureForTargetIfActive" "$runtime_source" "inspect runtime exposes lifecycle rearm helper"
  assert_contains "Target.targetCreated" "$runtime_source" "inspect runtime attaches new page targets during capture"
  assert_contains "\"idle_selected\"" "$runtime_source" "inspect runtime exposes idle selected toolbar state"
  assert_contains "captureActive" "$runtime_source" "inspect runtime tracks active capture separate from toolbar state"
  assert_contains "applyToolbarStateToAllTargets" "$runtime_source" "inspect runtime keeps toolbar resident across workflow transitions"
  assert_contains "reconcilePageTargets" "$runtime_source" "inspect runtime reconciles page targets beyond target-created events"
  assert_contains "Target.getTargets" "$runtime_source" "inspect runtime refreshes target inventory through the target domain"
  assert_contains "toolbarState === states.idleSelected" "$runtime_source" "inspect runtime handles idle-selected toolbar state"
  assert_contains "toolbarState === states.exited" "$runtime_source" "inspect runtime handles exited toolbar state"
  assert_contains "toolbarState === states.inspecting" "$runtime_source" "inspect runtime handles inspecting toolbar state"
  assert_contains "state.toolbarToggleButton.querySelector(\"span\").textContent = isInspecting" "$runtime_source" "inspect runtime toggles primary action label by inspect state"
  assert_contains "\"Inspecting\"" "$runtime_source" "inspect runtime exposes active inspect label"
  assert_contains "\"Press this button to inspect\"" "$runtime_source" "inspect runtime exposes idle inspect action"
  assert_contains "<span data-role=\"label\">Selected</span>" "$runtime_source" "inspect runtime exposes selected summary section"
  assert_contains "<span data-role=\"label\">Content</span>" "$runtime_source" "inspect runtime exposes content section"
  assert_contains "<span data-role=\"label\">Page</span>" "$runtime_source" "inspect runtime exposes unified panel page section"
  assert_contains "<span data-role=\"label\">Element</span>" "$runtime_source" "inspect runtime exposes element path section"
  assert_contains "elementPath" "$runtime_source" "inspect runtime derives element tree paths for toolbar display"
  assert_contains "selection_ignored_for_inactive_workflow" "$runtime_source" "inspect runtime ignores stale selections from other workflows"
  assert_contains "status: \"selection_received\"" "$runtime_source" "inspect runtime persists active workflow selection immediately"
  assert_contains "selection-history.jsonl" "$runtime_source" "inspect runtime persists selection history as JSONL"
  assert_contains "\"get_latest_selection\"" "$runtime_source" "inspect runtime exposes latest persisted selection recovery"
  assert_contains "readLatestPersistedSelection" "$runtime_source" "inspect runtime reads latest persisted selection outside workflow state"
}

test_inspect_capture_await_prefers_daemon_wait() {
  local capture_source
  capture_source="$(cat "$RUNTIME_ROOT/scripts/inspect_capture.mjs")"

  assert_contains "runtime_startup_fallback" "$capture_source" "inspect capture await only falls back when daemon startup fails"
  assert_not_contains $'logSignal("runtime_reconnect_fallback", {\n        command: "await_selection"' "$capture_source" "inspect capture await no longer reconnect-falls-back after wait starts"
  assert_contains "const result = await sendRuntimeCommand(handle, \"await_selection\", args);" "$capture_source" "inspect capture await keeps a single long-lived daemon request"
}

test_visual_loop_assets_exist() {
  if [[ -f "$RUNTIME_ROOT/scripts/inspect_visual_loop.mjs" ]]; then
    log_ok "inspect visual loop script exists"
  else
    log_fail "inspect visual loop script is missing"
  fi

  if [[ -f "$RUNTIME_ROOT/fixtures/inspect-visual/index.html" ]]; then
    log_ok "inspect visual fixture index exists"
  else
    log_fail "inspect visual fixture index is missing"
  fi

  if [[ -f "$RUNTIME_ROOT/fixtures/inspect-visual/next.html" ]]; then
    log_ok "inspect visual fixture next page exists"
  else
    log_fail "inspect visual fixture next page is missing"
  fi
}

test_auth_visual_assets_exist() {
  if [[ -f "$RUNTIME_ROOT/scripts/auth_visual_loop.mjs" ]]; then
    log_ok "auth visual loop script exists"
  else
    log_fail "auth visual loop script is missing"
  fi

  local build_script
  build_script="$(cat "$REPO_ROOT/scripts/build-readme-gif.sh")"
  assert_contains "auth_visual_loop.mjs" "$build_script" "README gif build uses auth visual loop"
  assert_contains "inspect_visual_loop.mjs" "$build_script" "README gif build uses inspect visual loop"
  assert_contains "chrome-auth-demo.gif" "$build_script" "README gif build outputs chrome-auth demo gif"
  assert_contains "chrome-inspect-demo.gif" "$build_script" "README gif build outputs chrome-inspect demo gif"

  if [[ -f "$REPO_ROOT/docs/releases/chrome-auth-release.md" ]]; then
    log_ok "chrome-auth release note exists"
  else
    log_fail "chrome-auth release note is missing"
  fi

  if [[ -f "$REPO_ROOT/docs/releases/chrome-auth-x-draft.md" ]]; then
    log_ok "chrome-auth X draft exists"
  else
    log_fail "chrome-auth X draft is missing"
  fi
}

main() {
  test_launches_dedicated_instance
  test_reuses_running_instance_with_new_tab
  test_cleans_stale_profile_process_before_launch
  test_blocks_multiple_dedicated_processes
  test_blocks_multiple_dedicated_windows
  test_blocks_wrong_endpoint_owner
  test_allows_other_profiles
  test_doctor_reports_ready_state
  test_doctor_reports_window_blocker
  test_allows_page_target_fallback_when_window_probe_reports_zero
  test_ignores_renderer_helpers_for_process_ownership
  test_blocks_project_webapp_restart_on_port_conflict
  test_reuses_reachable_project_webapp_listener
  test_inspect_capture_wrapper_targets_shared_runtime
  test_auth_cdp_wrapper_targets_shared_runtime
  test_auth_cdp_source_tracks_page_context_and_richer_actions
  test_inspect_capture_latest_reads_persisted_selection_without_runtime
  test_inspect_runtime_source_tracks_navigation_rearm
  test_inspect_capture_await_prefers_daemon_wait
  test_visual_loop_assets_exist
  test_auth_visual_assets_exist

  if [[ "$failures" -gt 0 ]]; then
    echo "Runtime tests failed with $failures issue(s)." >&2
    exit 1
  fi

  echo "Runtime tests passed."
}

main "$@"
