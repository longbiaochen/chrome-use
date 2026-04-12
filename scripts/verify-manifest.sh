#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="$REPO_ROOT/runtime/chrome-use"
SKILLS_ROOT="$REPO_ROOT/skills"
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
  if ! rg -q "^name: \"$expected\"$" "$SKILLS_ROOT/$dir/SKILL.md"; then
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
  local project_root="$TMP_ROOT/project-root"
  local expected_default="about:blank"
  local expected_env="https://fallback.example"
  local expected_explicit="https://example.com/login"
  local expected_project_entry="http://127.0.0.1:4321/"
  local resolved_default
  local resolved_env
  local resolved_explicit
  local resolved_project
  local resolved_project_with_env
  local resolved_inferred_from_cwd

  resolved_default="$($RUNTIME_ROOT/scripts/resolve_startup_url.sh)"
  assert_eq "$expected_default" "$resolved_default" "Startup URL default fallback"

  resolved_env="$(CHROME_USE_DEFAULT_WEBAPP_URL="$expected_env" "$RUNTIME_ROOT/scripts/resolve_startup_url.sh")"
  assert_eq "$expected_env" "$resolved_env" "Startup URL env fallback"

  resolved_explicit="$(CHROME_USE_DEFAULT_WEBAPP_URL="$expected_env" "$RUNTIME_ROOT/scripts/resolve_startup_url.sh" "$expected_explicit")"
  assert_eq "$expected_explicit" "$resolved_explicit" "Startup URL explicit URL takes precedence"

  mkdir -p "$project_root"
  cat >"$project_root/Makefile" <<'EOF'
PORT ?= 4321

serve:
	python -m http.server $(PORT)
EOF

  expected_project_entry="$("$RUNTIME_ROOT/scripts/project_webapp_entry.sh" "$project_root")"
  resolved_project="$(CHROME_INSPECT_PROJECT_ROOT="$project_root" "$RUNTIME_ROOT/scripts/resolve_startup_url.sh")"
  if [[ -n "$expected_project_entry" ]]; then
    assert_eq "$expected_project_entry" "$resolved_project" "Startup URL resolves docs webapp entry before env"
  else
    log_fail "Could not detect docs webapp entry for $project_root"
  fi

  resolved_project_with_env="$(CHROME_INSPECT_PROJECT_ROOT="$project_root" CHROME_USE_DEFAULT_WEBAPP_URL="$expected_env" "$RUNTIME_ROOT/scripts/resolve_startup_url.sh")"
  if [[ -n "$expected_project_entry" ]]; then
    assert_eq "$expected_project_entry" "$resolved_project_with_env" "Project root entry overrides env fallback"
  fi

  resolved_inferred_from_cwd="$(cd "$project_root" && CHROME_INSPECT_AUTO_START_WEBAPP=1 "$RUNTIME_ROOT/scripts/resolve_startup_url.sh")"
  if [[ -n "$expected_project_entry" ]]; then
    assert_eq "$expected_project_entry" "$resolved_inferred_from_cwd" "Inspect startup infers project root from cwd"
  fi
}

check_wrapper_targets() {
  if [[ -x "$RUNTIME_ROOT/scripts/resolve_project_root.sh" ]]; then
    log_ok "resolve_project_root helper is executable"
  else
    log_fail "resolve_project_root helper must be executable"
  fi

  if rg -Fq 'resolve_runtime_root.sh' "$SKILLS_ROOT/chrome-inspect/scripts/open_url.sh" && rg -Fq 'exec "$RUNTIME_ROOT/scripts/open_url.sh" "$@"' "$SKILLS_ROOT/chrome-inspect/scripts/open_url.sh"; then
    log_ok "chrome-inspect open_url wrapper resolves shared runtime"
  else
    log_fail "chrome-inspect open_url wrapper target is incorrect"
  fi

  if rg -Fq 'resolve_runtime_root.sh' "$SKILLS_ROOT/chrome-inspect/scripts/inspect-capture" && rg -Fq 'exec node "$RUNTIME_ROOT/scripts/inspect_capture.mjs" "$@"' "$SKILLS_ROOT/chrome-inspect/scripts/inspect-capture"; then
    log_ok "chrome-inspect inspect-capture target"
  else
    log_fail "chrome-inspect inspect-capture target is incorrect"
  fi

  if rg -Fq 'resolve_runtime_root.sh' "$SKILLS_ROOT/chrome-auth/scripts/open_url.sh" && rg -Fq 'exec "$RUNTIME_ROOT/scripts/open_url.sh" "$@"' "$SKILLS_ROOT/chrome-auth/scripts/open_url.sh"; then
    log_ok "chrome-auth open_url wrapper target"
  else
    log_fail "chrome-auth open_url wrapper target is incorrect"
  fi

  if rg -Fq 'resolve_runtime_root.sh' "$SKILLS_ROOT/chrome-auth/scripts/auth-cdp" && rg -Fq 'exec node "$RUNTIME_ROOT/scripts/auth_cdp.mjs" "$@"' "$SKILLS_ROOT/chrome-auth/scripts/auth-cdp"; then
    log_ok "chrome-auth auth-cdp target"
  else
    log_fail "chrome-auth auth-cdp target is incorrect"
  fi
}

check_codex_prompt_entrypoints() {
  local inspect_prompt="$SKILLS_ROOT/chrome-inspect/agents/openai.yaml"
  local auth_prompt="$SKILLS_ROOT/chrome-auth/agents/openai.yaml"

  if rg -q '`bash scripts/open_url\.sh ".*"' "$inspect_prompt" || rg -q '`scripts/inspect-capture (begin|await|apply|latest)' "$inspect_prompt"; then
    log_fail "chrome-inspect Codex prompt must not assume repo-root scripts/ entrypoints"
  else
    log_ok "chrome-inspect Codex prompt avoids repo-root scripts/ entrypoints"
  fi

  if rg -q '`bash scripts/open_url\.sh ".*"' "$auth_prompt" || rg -q '`scripts/auth-cdp (status|navigate|snapshot|find|click|type)' "$auth_prompt"; then
    log_fail "chrome-auth Codex prompt must not assume repo-root scripts/ entrypoints"
  else
    log_ok "chrome-auth Codex prompt avoids repo-root scripts/ entrypoints"
  fi

  if rg -Fq "<skill-dir>/scripts/open_url.sh" "$inspect_prompt" && rg -Fq "<skill-dir>/scripts/inspect-capture" "$inspect_prompt"; then
    log_ok "chrome-inspect Codex prompt points at skill-local scripts"
  else
    log_fail "chrome-inspect Codex prompt must point at skill-local scripts"
  fi

  if rg -Fq "<skill-dir>/scripts/open_url.sh" "$auth_prompt" && rg -Fq "<skill-dir>/scripts/auth-cdp" "$auth_prompt"; then
    log_ok "chrome-auth Codex prompt points at skill-local scripts"
  else
    log_fail "chrome-auth Codex prompt must point at skill-local scripts"
  fi
}

check_forbidden_references() {
  local forbidden=(
    "chrome-devtools-mcp"
    "CHROME_USE_MCP_MODE"
    "inspect_selected_element"
    "chrome_devtools_mcp_wrapper"
    "chrome_devtools_inspect_mcp"
  )
  local search_paths=(
    "$REPO_ROOT/README.md"
    "$REPO_ROOT/docs"
    "$RUNTIME_ROOT"
    "$SKILLS_ROOT/chrome-inspect"
    "$SKILLS_ROOT/chrome-auth"
  )

  for needle in "${forbidden[@]}"; do
    if rg -n "$needle" "${search_paths[@]}" >/dev/null 2>&1; then
      log_fail "Forbidden MCP reference remains: $needle"
    else
      log_ok "No forbidden MCP reference: $needle"
    fi
  done
}

check_install_layout() {
  local install_script="$1"
  local target_kind="$2"
  local home_root="$TMP_ROOT/home-${target_kind}"
  local install_root="$home_root/.chrome-use"
  local target_root

  rm -rf "$home_root"
  mkdir -p "$home_root"

  case "$target_kind" in
    generic) target_root="$home_root/.agents/skills" ;;
    codex) target_root="$home_root/.codex/skills" ;;
    *)
      log_fail "Unknown target kind for $install_script: $target_kind"
      return
      ;;
  esac

  local mock_app_installer="$home_root/mock-install-agent-profile-chrome-app.sh"
  cat >"$mock_app_installer" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/Applications"
app_dir="$HOME/Applications/Agent Profile Chrome.app"
mkdir -p "$app_dir"
echo "$app_dir"
EOF
  chmod +x "$mock_app_installer"

  HOME="$home_root" \
    CHROME_USE_INSTALL_ROOT="$install_root" \
    CHROME_USE_INSTALL_CHROME_APP_SCRIPT="$mock_app_installer" \
    CHROME_USE_INSTALL_SKIP_PREFLIGHT=1 \
    bash "$REPO_ROOT/$install_script" --non-interactive --yes >/dev/null

  installed=()
  while IFS= read -r -d '' entry; do
    installed+=("${entry##*/}")
  done < <(find "$target_root" -mindepth 1 -maxdepth 1 -type d -name 'chrome-*' -print0)

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

  if [[ -e "$target_root/chrome-use" ]]; then
    log_fail "$install_script must not install a public chrome-use skill"
  else
    log_ok "$install_script does not install a public chrome-use skill"
  fi

  if [[ -L "$target_root/chrome-inspect" || -L "$target_root/chrome-auth" ]]; then
    log_fail "$install_script must materialize copied skill dirs, not symlinks"
  else
    log_ok "$install_script materializes copied skill dirs"
  fi

  if [[ ! -f "$install_root/install-manifest.json" ]]; then
    log_fail "$install_script must write install-manifest.json"
  else
    log_ok "$install_script writes install-manifest.json"
  fi

  if [[ ! -d "$install_root/runtime/chrome-use" ]]; then
    log_fail "$install_script must install shared runtime under install root"
  else
    log_ok "$install_script installs shared runtime under install root"
  fi

  if [[ ! -d "$install_root/skills/chrome-inspect" || ! -d "$install_root/skills/chrome-auth" ]]; then
    log_fail "$install_script must install managed skills under install root"
  else
    log_ok "$install_script installs managed skills under install root"
  fi

  if [[ -e "$install_root/dist/runtime/chrome-use" ]]; then
    log_fail "$install_script must not keep legacy dist runtime layout"
  else
    log_ok "$install_script removes legacy dist runtime layout"
  fi

  if [[ "$target_kind" == "codex" ]]; then
    if [[ -f "$target_root/chrome-inspect/agents/openai.yaml" && -f "$target_root/chrome-auth/agents/openai.yaml" ]]; then
      log_ok "$install_script keeps Codex metadata for codex target"
    else
      log_fail "$install_script must keep Codex metadata for codex target"
    fi

    if [[ -d "$home_root/Applications/Agent Profile Chrome.app" ]]; then
      log_ok "$install_script auto-installs Agent Profile Chrome app for codex target"
    else
      log_fail "$install_script must auto-install Agent Profile Chrome app for codex target"
    fi
  else
    if [[ -d "$target_root/chrome-inspect/agents" || -d "$target_root/chrome-auth/agents" ]]; then
      log_fail "$install_script must omit Codex metadata for non-codex targets"
    else
      log_ok "$install_script omits Codex metadata for non-codex targets"
    fi

    if [[ -d "$home_root/Applications/Agent Profile Chrome.app" ]]; then
      log_fail "$install_script must not auto-install Agent Profile Chrome app for non-codex targets"
    else
      log_ok "$install_script does not auto-install Agent Profile Chrome app for non-codex targets"
    fi
  fi
}

check_chrome_app_installer_flags() {
  local home_root="$TMP_ROOT/home-flags"
  local install_root="$home_root/.chrome-use"
  local output_file="$home_root/install.out"
  mkdir -p "$home_root"

  local mock_app_installer="$home_root/mock-install-agent-profile-chrome-app.sh"
  cat >"$mock_app_installer" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${MOCK_APP_INSTALL_FAIL:-0}" == "1" ]]; then
  echo "mock install failure" >&2
  exit 1
fi
mkdir -p "$HOME/Applications"
app_dir="$HOME/Applications/Agent Profile Chrome.app"
mkdir -p "$app_dir"
echo "$app_dir"
EOF
  chmod +x "$mock_app_installer"

  HOME="$home_root" \
    CHROME_USE_INSTALL_ROOT="$install_root" \
    CHROME_USE_INSTALL_CHROME_APP_SCRIPT="$mock_app_installer" \
    CHROME_USE_INSTALL_SKIP_PREFLIGHT=1 \
    bash "$REPO_ROOT/install/install.sh" --target codex --skip-chrome-app --non-interactive --yes >"$output_file"

  if [[ -d "$home_root/Applications/Agent Profile Chrome.app" ]]; then
    log_fail "install/install.sh must respect --skip-chrome-app for codex target"
  else
    log_ok "install/install.sh respects --skip-chrome-app for codex target"
  fi

  rm -rf "$home_root/Applications" "$install_root"
  mkdir -p "$home_root"
  HOME="$home_root" \
    CHROME_USE_INSTALL_ROOT="$install_root" \
    CHROME_USE_INSTALL_CHROME_APP_SCRIPT="$mock_app_installer" \
    CHROME_USE_INSTALL_SKIP_PREFLIGHT=1 \
    bash "$REPO_ROOT/install/install.sh" --target generic --install-chrome-app --non-interactive --yes >"$output_file"

  if [[ -d "$home_root/Applications/Agent Profile Chrome.app" ]]; then
    log_ok "install/install.sh respects --install-chrome-app for generic target"
  else
    log_fail "install/install.sh must respect --install-chrome-app for generic target"
  fi

  rm -rf "$home_root/Applications" "$install_root"
  mkdir -p "$home_root"
  HOME="$home_root" \
    CHROME_USE_INSTALL_ROOT="$install_root" \
    CHROME_USE_INSTALL_CHROME_APP_SCRIPT="$mock_app_installer" \
    CHROME_USE_INSTALL_SKIP_PREFLIGHT=1 \
    MOCK_APP_INSTALL_FAIL=1 \
    bash "$REPO_ROOT/install/install.sh" --target codex --non-interactive --yes >"$output_file"

  if rg -Fq "Agent Profile Chrome app install failed; see warning below" "$output_file" && rg -Fq "Could not install Agent Profile Chrome.app automatically" "$output_file"; then
    log_ok "install/install.sh degrades cleanly when Agent Profile Chrome app install fails"
  else
    log_fail "install/install.sh must warn and continue when Agent Profile Chrome app install fails"
  fi
}

check_skill_metadata() {
  for skill in "${EXPECTED_SKILLS[@]}"; do
    contains_expected_name "$skill" "$skill"
    contains_no_direct_chrome_prompt "$SKILLS_ROOT/$skill/agents/openai.yaml"
    if rg -q 'allow_implicit_invocation:\s*true' "$SKILLS_ROOT/$skill/agents/openai.yaml"; then
      log_ok "$skill implicit invocation enabled"
    else
      log_fail "$skill must enable implicit invocation"
    fi
  done

  if [[ ! -e "$RUNTIME_ROOT/SKILL.md" && ! -e "$RUNTIME_ROOT/agents/openai.yaml" ]]; then
    log_ok "runtime/chrome-use has no public skill metadata"
  else
    log_fail "runtime/chrome-use must not expose public skill metadata"
  fi
}

main() {
  require_dir "$RUNTIME_ROOT"
  require_dir "$SKILLS_ROOT/chrome-auth"
  require_dir "$SKILLS_ROOT/chrome-inspect"

  check_install_layout "install/install-agent-skill.sh" generic
  check_install_layout "install/install-codex-skill.sh" codex
  check_chrome_app_installer_flags
  check_skill_metadata
  check_startup_url_resolution
  check_wrapper_targets
  check_codex_prompt_entrypoints
  check_forbidden_references

  if (( failures > 0 )); then
    log_fail "Manifest verification failed with $failures issue(s)."
    exit 1
  fi

  log_ok "Manifest verification passed."
}

main "$@"
