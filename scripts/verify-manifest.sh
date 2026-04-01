#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_SKILLS=(chrome-auth chrome-inspect)
TMP_ROOT="$REPO_ROOT/.tmp-verify-manifest"
failures=0

cleanup() {
  rm -rf "$TMP_ROOT"
}

trap cleanup EXIT

log_fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

log_ok() {
  echo "OK: $1"
}

require_dir() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    log_fail "missing directory: $dir"
  fi
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

contains_expected_name() {
  local dir="$1"
  local expected="$2"
  if ! rg -q "^name: \"$expected\"$" "$REPO_ROOT/$dir/SKILL.md"; then
    log_fail "$dir/SKILL.md must declare name: \"$expected\""
  else
    log_ok "$dir/SKILL.md name=$expected"
  fi
}

contains_no_direct_chrome_prompt() {
  local file="$1"
  if rg -q 'When `/chrome`' "$file" || rg -q 'When `/inspect`' "$file"; then
    log_fail "$file must not register /chrome or /inspect"
  else
    log_ok "$file has no deprecated /chrome or /inspect selectors"
  fi
}

check_startup_url_resolution() {
  local expected_default="about:blank"
  local expected_env="https://fallback.example"
  local expected_explicit="https://example.com/login"
  local resolved_default
  local resolved_env
  local resolved_explicit

  resolved_default="$($REPO_ROOT/chrome-use/scripts/resolve_startup_url.sh)"
  assert_eq "$expected_default" "$resolved_default" "Startup URL default fallback"

  resolved_env="$(CHROME_USE_DEFAULT_WEBAPP_URL="$expected_env" "$REPO_ROOT/chrome-use/scripts/resolve_startup_url.sh")"
  assert_eq "$expected_env" "$resolved_env" "Startup URL env fallback"

  resolved_explicit="$(CHROME_USE_DEFAULT_WEBAPP_URL="$expected_env" "$REPO_ROOT/chrome-use/scripts/resolve_startup_url.sh" "$expected_explicit")"
  assert_eq "$expected_explicit" "$resolved_explicit" "Startup URL explicit URL takes precedence"
}

check_install_layout() {
  local install_script="$1"
  local env_var_name="$2"
  local target_root="$TMP_ROOT/$install_script"

  rm -rf "$target_root"
  mkdir -p "$target_root"

  if [[ "$env_var_name" == AGENT_SKILLS_ROOT ]]; then
    AGENT_SKILLS_ROOT="$target_root" bash "$REPO_ROOT/$install_script" >/dev/null
  else
    CODEX_SKILLS_ROOT="$target_root" bash "$REPO_ROOT/$install_script" >/dev/null
  fi

  installed=()
  while IFS= read -r -d '' entry; do
    installed+=("${entry##*/}")
  done < <(find "$target_root" -mindepth 1 -maxdepth 1 -type l -name 'chrome-*' -print0)

  if (( ${#installed[@]} != 2 )); then
    log_fail "$install_script installs ${#installed[@]} command dirs, expected 2"
    return
  fi

  for expected in "${EXPECTED_SKILLS[@]}"; do
    local found=0
    for name in "${installed[@]}"; do
      if [[ "$name" == "$expected" ]]; then
        found=1
      fi
    done
    if (( found == 0 )); then
      log_fail "$install_script did not install required command '$expected'"
    else
      log_ok "$install_script installs '$expected'"
    fi
  done

  for name in "${installed[@]}"; do
    local found=0
    for expected in "${EXPECTED_SKILLS[@]}"; do
      if [[ "$name" == "$expected" ]]; then
        found=1
      fi
    done
    if (( found == 0 )); then
      log_fail "$install_script has unexpected installed command '$name'"
    fi
  done
}

check_skill_metadata() {
  for skill in "${EXPECTED_SKILLS[@]}"; do
    contains_expected_name "$skill" "$skill"
    contains_no_direct_chrome_prompt "$REPO_ROOT/$skill/agents/openai.yaml"
  done

  if rg -q '^name:\s*"chrome-use"$' "$REPO_ROOT/chrome-use/SKILL.md"; then
    log_ok 'chrome-use SKILL is shared base metadata only'
  else
    log_fail 'chrome-use/SKILL.md should retain shared package name metadata'
  fi

  contains_no_direct_chrome_prompt "$REPO_ROOT/chrome-use/agents/openai.yaml"
}

main() {
  require_dir "$REPO_ROOT/chrome-use"
  require_dir "$REPO_ROOT/chrome-auth"
  require_dir "$REPO_ROOT/chrome-inspect"

  check_install_layout "install/install-agent-skill.sh" AGENT_SKILLS_ROOT
  check_install_layout "install/install-codex-skill.sh" CODEX_SKILLS_ROOT
  check_skill_metadata
  check_startup_url_resolution

  if (( failures > 0 )); then
    log_fail "Manifest verification failed with $failures issue(s)."
    exit 1
  fi

  log_ok "Manifest verification passed."
}

main "$@"
