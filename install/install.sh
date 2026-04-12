#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${REPO_ROOT}/runtime/chrome-use/scripts/runtime_lib.sh"

INSTALL_ROOT="${CHROME_USE_INSTALL_ROOT:-$HOME/.chrome-use}"
MANAGED_RUNTIME_ROOT="${INSTALL_ROOT}/runtime/chrome-use"
MANAGED_SKILLS_ROOT="${INSTALL_ROOT}/skills"
BIN_ROOT="${INSTALL_ROOT}/bin"
MANIFEST_PATH="${INSTALL_ROOT}/install-manifest.json"

TARGET_SPEC=""
NON_INTERACTIVE=0
ASSUME_YES=0
INSTALL_CHROME_APP="auto"
SKIP_PREFLIGHT="${CHROME_USE_INSTALL_SKIP_PREFLIGHT:-0}"
CHROME_APP_INSTALLER="${CHROME_USE_INSTALL_CHROME_APP_SCRIPT:-${REPO_ROOT}/scripts/install-agent-profile-chrome-app.sh}"

TARGETS=()
INSTALLED_TARGETS=()
INSTALL_WARNINGS=()
CHROME_APP_STATUS="skipped"
CHROME_APP_PATH=""

usage() {
  cat <<'EOF'
Usage: bash install/install.sh [options]

Options:
  --target codex|generic|claude|all
  --install-chrome-app
  --skip-chrome-app
  --non-interactive
  --yes
  --help
EOF
}

has_target() {
  local wanted="$1"
  local current
  for current in "${TARGETS[@]:-}"; do
    if [[ "$current" == "$wanted" ]]; then
      return 0
    fi
  done
  return 1
}

append_target() {
  local value="$1"
  if ! has_target "$value"; then
    TARGETS+=("$value")
  fi
}

resolve_target_root() {
  case "$1" in
    codex) echo "${CODEX_SKILLS_ROOT:-$HOME/.codex/skills}" ;;
    generic) echo "${AGENT_SKILLS_ROOT:-$HOME/.agents/skills}" ;;
    claude) echo "${CLAUDE_SKILLS_ROOT:-$HOME/.claude/skills}" ;;
    *)
      echo "Unknown install target: $1" >&2
      exit 1
      ;;
  esac
}

supports_codex() {
  [[ -n "${CODEX_HOME:-}" || -d "$HOME/.codex" || -d "$HOME/.codex/skills" ]]
}

default_target_spec() {
  if supports_codex; then
    echo "codex,generic"
  else
    echo "generic"
  fi
}

parse_target_spec() {
  local spec="$1"
  local item
  IFS=',' read -r -a items <<<"$spec"
  for item in "${items[@]}"; do
    case "$item" in
      codex|generic|claude) append_target "$item" ;;
      all)
        append_target "codex"
        append_target "generic"
        append_target "claude"
        ;;
      "")
        ;;
      *)
        echo "Unsupported target: $item" >&2
        exit 1
        ;;
    esac
  done
}

prompt_yes_no() {
  local message="$1"
  local default_answer="${2:-y}"
  local reply

  if [[ "$ASSUME_YES" == "1" ]]; then
    [[ "$default_answer" != "n" ]]
    return
  fi

  while true; do
    if [[ "$default_answer" == "n" ]]; then
      printf "%s [y/N] " "$message" >&2
    else
      printf "%s [Y/n] " "$message" >&2
    fi
    read -r reply || true
    reply="${reply:-$default_answer}"
    case "$reply" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
    esac
  done
}

choose_targets_interactively() {
  local recommended
  recommended="$(default_target_spec)"

  if [[ "$NON_INTERACTIVE" == "1" || "$ASSUME_YES" == "1" ]]; then
    TARGET_SPEC="$recommended"
    return
  fi

  echo "Install `chrome-use` skills into:"
  if supports_codex; then
    echo "  1) Codex + generic (.agents/skills) [recommended]"
    echo "  2) Codex only"
    echo "  3) Generic only"
    echo "  4) Claude-compatible only"
    echo "  5) All supported targets"
    printf "Choose an option [1]: " >&2
    local choice
    read -r choice || true
    case "${choice:-1}" in
      1) TARGET_SPEC="codex,generic" ;;
      2) TARGET_SPEC="codex" ;;
      3) TARGET_SPEC="generic" ;;
      4) TARGET_SPEC="claude" ;;
      5) TARGET_SPEC="all" ;;
      *)
        echo "Unknown option: ${choice}" >&2
        exit 1
        ;;
    esac
  else
    echo "  1) Generic (.agents/skills) [recommended]"
    echo "  2) Claude-compatible only"
    echo "  3) All supported targets"
    printf "Choose an option [1]: " >&2
    local choice
    read -r choice || true
    case "${choice:-1}" in
      1) TARGET_SPEC="generic" ;;
      2) TARGET_SPEC="claude" ;;
      3) TARGET_SPEC="all" ;;
      *)
        echo "Unknown option: ${choice}" >&2
        exit 1
        ;;
    esac
  fi
}

ensure_dirs() {
  mkdir -p "${INSTALL_ROOT}" "${BIN_ROOT}" "${INSTALL_ROOT}/runtime" "${MANAGED_SKILLS_ROOT}" "${INSTALL_ROOT}/agent-profile" "${INSTALL_ROOT}/state"
}

ensure_chrome_available() {
  local chrome_bin
  local os
  os="$(platform)"

  if [[ "$SKIP_PREFLIGHT" == "1" ]]; then
    return 0
  fi

  chrome_bin="$(detect_chrome_bin)"
  if [[ -n "$chrome_bin" ]]; then
    return 0
  fi

  case "$os" in
    macos)
      echo "Google Chrome.app was not found."
      echo "chrome-use is macOS-first and needs Chrome to create the dedicated agent profile."
      if command -v brew >/dev/null 2>&1; then
        echo "Recommended install command:"
        echo "  brew install --cask google-chrome"
      else
        echo "Install Chrome from:"
        echo "  https://www.google.com/chrome/"
      fi

      if [[ "$NON_INTERACTIVE" == "1" ]]; then
        exit 1
      fi

      while true; do
        printf "Install Chrome, then press Enter to continue or type q to quit: " >&2
        local reply
        read -r reply || true
        if [[ "${reply:-}" == "q" || "${reply:-}" == "Q" ]]; then
          exit 1
        fi
        chrome_bin="$(detect_chrome_bin)"
        if [[ -n "$chrome_bin" ]]; then
          return 0
        fi
        echo "Chrome is still not available. Re-run the install step, then continue."
      done
      ;;
    windows)
      echo "Windows is not yet tested for chrome-use installation." >&2
      exit 1
      ;;
    *)
      echo "Could not find a supported Chrome binary. Set CHROME_USE_CHROME_BIN explicitly." >&2
      exit 1
      ;;
  esac
}

install_managed_payload() {
  rm -rf "${INSTALL_ROOT}/dist" "${MANAGED_RUNTIME_ROOT}" "${MANAGED_SKILLS_ROOT}/chrome-inspect" "${MANAGED_SKILLS_ROOT}/chrome-auth"
  mkdir -p "${INSTALL_ROOT}/runtime" "${MANAGED_SKILLS_ROOT}"
  cp -R "${REPO_ROOT}/runtime/chrome-use" "${INSTALL_ROOT}/runtime/"
  cp -R "${REPO_ROOT}/skills/chrome-inspect" "${MANAGED_SKILLS_ROOT}/"
  cp -R "${REPO_ROOT}/skills/chrome-auth" "${MANAGED_SKILLS_ROOT}/"
}

create_bin_wrappers() {
  mkdir -p "${BIN_ROOT}"

  cat >"${BIN_ROOT}/chrome-use-doctor" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${CHROME_USE_INSTALL_ROOT:-$HOME/.chrome-use}"
exec "${INSTALL_ROOT}/runtime/chrome-use/scripts/doctor.sh" "$@"
EOF
  chmod +x "${BIN_ROOT}/chrome-use-doctor"

  cat >"${BIN_ROOT}/chrome-use-open-agent-profile-chrome" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${CHROME_USE_INSTALL_ROOT:-$HOME/.chrome-use}"
exec "${INSTALL_ROOT}/runtime/chrome-use/scripts/open_agent_profile_chrome.sh" "$@"
EOF
  chmod +x "${BIN_ROOT}/chrome-use-open-agent-profile-chrome"
}

install_skill_dir() {
  local source_dir="$1"
  local target_dir="$2"
  local include_codex_metadata="$3"

  rm -rf "${target_dir}"
  mkdir -p "$(dirname "${target_dir}")"
  cp -R "${source_dir}" "${target_dir}"
  if [[ "${include_codex_metadata}" != "1" ]]; then
    rm -rf "${target_dir}/agents"
  fi
}

install_target() {
  local target="$1"
  local target_root
  local include_codex_metadata="0"

  target_root="$(resolve_target_root "$target")"
  mkdir -p "${target_root}"

  if [[ "$target" == "codex" ]]; then
    include_codex_metadata="1"
  fi

  install_skill_dir "${MANAGED_SKILLS_ROOT}/chrome-inspect" "${target_root}/chrome-inspect" "${include_codex_metadata}"
  install_skill_dir "${MANAGED_SKILLS_ROOT}/chrome-auth" "${target_root}/chrome-auth" "${include_codex_metadata}"
  INSTALLED_TARGETS+=("${target}:${target_root}")
}

bootstrap_profile() {
  local bootstrap_output=""
  if [[ "$SKIP_PREFLIGHT" == "1" ]]; then
    return 0
  fi

  if bootstrap_output="$("${MANAGED_RUNTIME_ROOT}/scripts/ensure_profile.sh" "about:blank" 2>&1)"; then
    if bootstrap_output="$("${MANAGED_RUNTIME_ROOT}/scripts/doctor.sh" 2>&1)"; then
      return 0
    fi
  fi

  INSTALL_WARNINGS+=("Runtime bootstrap check could not verify the dedicated profile automatically. Install completed successfully; retry later with \`${BIN_ROOT}/chrome-use-doctor\` or \`${BIN_ROOT}/chrome-use-open-agent-profile-chrome\`.")
  INSTALL_WARNINGS+=("Bootstrap check output: $(printf '%s' "$bootstrap_output" | tr '\n' ' ' | sed 's/  */ /g')")
  return 0
}

maybe_install_chrome_app() {
  if [[ "$(platform)" != "macos" ]]; then
    CHROME_APP_STATUS="unsupported"
    return 0
  fi

  if [[ "$INSTALL_CHROME_APP" == "auto" ]]; then
    if has_target "codex"; then
      INSTALL_CHROME_APP="1"
    else
      INSTALL_CHROME_APP="0"
    fi
  fi

  if [[ "$INSTALL_CHROME_APP" != "1" ]]; then
    CHROME_APP_STATUS="skipped"
    return 0
  fi

  if app_path="$(bash "${CHROME_APP_INSTALLER}" 2>&1)"; then
    CHROME_APP_STATUS="installed"
    CHROME_APP_PATH="$(printf '%s\n' "$app_path" | tail -n 1)"
    return 0
  fi

  CHROME_APP_STATUS="failed"
  INSTALL_WARNINGS+=("Could not install Agent Profile Chrome.app automatically. Skills/runtime were installed successfully. Retry with \`bash scripts/install-agent-profile-chrome-app.sh\`.")
  INSTALL_WARNINGS+=("App installer output: $(printf '%s' "$app_path" | tr '\n' ' ' | sed 's/  */ /g')")
  return 0
}

detect_source_kind() {
  if [[ -d "${REPO_ROOT}/.git" ]]; then
    echo "git-repo"
  else
    echo "local-package"
  fi
}

write_manifest() {
  local joined_targets
  joined_targets="$(printf '%s\n' "${INSTALLED_TARGETS[@]:-}")"

  node - "${MANIFEST_PATH}" "${INSTALL_ROOT}" "${MANAGED_RUNTIME_ROOT}" "${MANAGED_SKILLS_ROOT}" "${REPO_ROOT}" "$(detect_source_kind)" "${joined_targets}" <<'NODE'
const fs = require("fs");
const [manifestPath, installRoot, runtimeRoot, skillsRoot, sourceRoot, sourceKind, installedTargets] = process.argv.slice(2);
const targets = String(installedTargets || "")
  .split("\n")
  .filter(Boolean)
  .map((entry) => {
    const separator = entry.indexOf(":");
    return separator === -1
      ? { target: entry, path: null }
      : { target: entry.slice(0, separator), path: entry.slice(separator + 1) };
  });
const payload = {
  installRoot,
  runtimeRoot,
  skillsRoot,
  sourceRoot,
  sourceKind,
  installedAt: new Date().toISOString(),
  publicSkills: ["chrome-inspect", "chrome-auth"],
  targets,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
NODE
}

print_summary() {
  echo
  echo "Installed chrome-use to ${INSTALL_ROOT}"
  local entry
  for entry in "${INSTALLED_TARGETS[@]:-}"; do
    echo "  - ${entry%%:*}: ${entry#*:}"
  done
  echo
  echo "Public skills:"
  echo "  - chrome-inspect"
  echo "  - chrome-auth"
  echo
  if has_target "codex"; then
    echo "Codex usage:"
    echo "  - Explicit: /chrome-inspect or /chrome-auth"
    echo "  - Implicit: browser QA, auth, and live-page inspection requests"
  fi
  echo "Login-state preparation:"
  if [[ "$CHROME_APP_STATUS" == "installed" ]]; then
    echo "  - Agent Profile Chrome installed at \`${CHROME_APP_PATH}\`"
  elif [[ "$CHROME_APP_STATUS" == "failed" ]]; then
    echo "  - Agent Profile Chrome app install failed; see warning below"
  else
    echo "  - Use \`Agent Profile Chrome\` if you installed the app"
  fi
  echo "  - Or run \`${BIN_ROOT}/chrome-use-open-agent-profile-chrome\`"
  if (( ${#INSTALL_WARNINGS[@]} > 0 )); then
    echo
    echo "Warnings:"
    local warning
    for warning in "${INSTALL_WARNINGS[@]}"; do
      echo "  - ${warning}"
    done
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET_SPEC="${2:-}"
      shift 2
      ;;
    --install-chrome-app)
      INSTALL_CHROME_APP="1"
      shift
      ;;
    --skip-chrome-app)
      INSTALL_CHROME_APP="0"
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET_SPEC" ]]; then
  choose_targets_interactively
fi

if [[ -z "$TARGET_SPEC" ]]; then
  TARGET_SPEC="$(default_target_spec)"
fi

parse_target_spec "$TARGET_SPEC"
ensure_dirs
ensure_chrome_available
install_managed_payload
create_bin_wrappers
bootstrap_profile
maybe_install_chrome_app

for target in "${TARGETS[@]}"; do
  install_target "$target"
done

write_manifest
print_summary
