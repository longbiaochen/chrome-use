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
BROWSER_SPEC="${CHROME_USE_BROWSER_KIND:-}"
NON_INTERACTIVE=0
ASSUME_YES=0
INSTALL_CHROME_APP="0"
SKIP_BROWSER_DOWNLOAD=0
SKIP_PREFLIGHT="${CHROME_USE_INSTALL_SKIP_PREFLIGHT:-0}"

TARGETS=()
INSTALLED_TARGETS=()
INSTALL_WARNINGS=()
PRUNED_TARGETS=()
CHROME_APP_STATUS="skipped"
CHROME_APP_PATH=""
BROWSER_STATUS="pending"
BROWSER_KIND_RESOLVED=""
BROWSER_CHANNEL_RESOLVED=""
BROWSER_VERSION_RESOLVED=""
BROWSER_PLATFORM_RESOLVED=""
BROWSER_BINARY_RESOLVED=""

usage() {
  cat <<'EOF'
Usage: bash install/install.sh [options]

Options:
  --target codex|generic|claude|all
  --browser cft|system
  --skip-browser-download
  --install-chrome-app   (legacy no-op)
  --skip-chrome-app      (legacy no-op)
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
    echo "codex"
  else
    echo "generic"
  fi
}

resolve_browser_kind() {
  local raw="${BROWSER_SPEC:-${CHROME_USE_BROWSER_KIND:-cft}}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    ""|cft|system)
      echo "${raw:-cft}"
      ;;
    *)
      echo "Unsupported browser kind: $raw" >&2
      exit 1
      ;;
  esac
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
    echo "  1) Codex only [recommended]"
    echo "  2) Generic only"
    echo "  3) Codex + generic (.agents/skills)"
    echo "  4) Claude-compatible only"
    echo "  5) All supported targets"
    printf "Choose an option [1]: " >&2
    local choice
    read -r choice || true
    case "${choice:-1}" in
      1) TARGET_SPEC="codex" ;;
      2) TARGET_SPEC="generic" ;;
      3) TARGET_SPEC="codex,generic" ;;
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
  mkdir -p "${INSTALL_ROOT}" "${BIN_ROOT}" "${INSTALL_ROOT}/runtime" "${MANAGED_SKILLS_ROOT}" "${INSTALL_ROOT}/state" "${INSTALL_ROOT}/browser-data" "${INSTALL_ROOT}/browsers"
}

ensure_system_chrome_available() {
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
      echo "chrome-use can use Google Chrome.app as an explicit system-browser override."
      echo "The default public path is managed Chrome for Testing; use --browser system only when you intentionally want a user-supplied browser."
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

ensure_browser_download_dependencies() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=("curl")
  command -v node >/dev/null 2>&1 || missing+=("node")
  if [[ "$(platform)" == "macos" ]]; then
    command -v ditto >/dev/null 2>&1 || missing+=("ditto")
  else
    command -v unzip >/dev/null 2>&1 || missing+=("unzip")
  fi
  if (( ${#missing[@]} > 0 )); then
    echo "Missing required tools for Chrome for Testing download: ${missing[*]}" >&2
    exit 1
  fi
}

extract_cft_archive() {
  local archive_path="$1"
  local destination="$2"

  if [[ "$(platform)" == "macos" ]]; then
    ditto -x -k "$archive_path" "$destination"
  else
    unzip -q "$archive_path" -d "$destination"
  fi
}

validate_cft_extract() {
  local browser_binary="$1"
  local version="$2"
  local platform_root="$3"
  local app_root
  local helper_binary

  if [[ ! -x "$browser_binary" ]]; then
    echo "Extracted Chrome for Testing binary is missing or not executable: $browser_binary" >&2
    exit 1
  fi

  if [[ "$(platform)" != "macos" ]]; then
    return 0
  fi

  app_root="${platform_root}/$(cft_archive_dir)/Google Chrome for Testing.app"
  helper_binary="${app_root}/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/${version}/Helpers/Google Chrome for Testing Helper.app/Contents/MacOS/Google Chrome for Testing Helper"
  if [[ ! -x "$helper_binary" ]]; then
    echo "Extracted Chrome for Testing app bundle is incomplete: missing helper app at $helper_binary" >&2
    exit 1
  fi
}

resolve_cft_metadata_url() {
  if [[ -n "${CHROME_USE_CFT_METADATA_URL:-}" ]]; then
    echo "${CHROME_USE_CFT_METADATA_URL}"
    return
  fi

  if [[ -n "${CHROME_USE_CFT_VERSION:-}" ]]; then
    echo "https://googlechromelabs.github.io/chrome-for-testing/${CHROME_USE_CFT_VERSION}.json"
    return
  fi

  echo "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
}

resolve_cft_download_info() {
  local metadata_url="$1"
  local requested_channel
  local requested_version
  local requested_platform
  requested_channel="$(cft_channel)"
  requested_version="${CHROME_USE_CFT_VERSION:-}"
  requested_platform="$(cft_platform)"
  [[ -n "$requested_platform" ]] || {
    echo "Unsupported platform for Chrome for Testing download." >&2
    exit 1
  }

  node -e '
const fs = require("fs");
const [metadataUrl, requestedChannel, requestedVersion, requestedPlatform] = process.argv.slice(1);
const input = fs.readFileSync(0, "utf8");
const payload = JSON.parse(input);

function findChannel(channels, wanted) {
  if (!channels || typeof channels !== "object") return null;
  const needle = String(wanted || "").toLowerCase();
  for (const [key, value] of Object.entries(channels)) {
    if (String(key).toLowerCase() === needle) {
      return value;
    }
  }
  return null;
}

let version = requestedVersion || "";
let downloads = null;
if (payload && payload.channels) {
  const channelInfo = findChannel(payload.channels, requestedChannel);
  if (!channelInfo) {
    throw new Error(`Missing channel ${requestedChannel} in ${metadataUrl}`);
  }
  version = version || channelInfo.version || "";
  downloads = channelInfo.downloads?.chrome || null;
} else {
  version = version || payload.version || "";
  downloads = payload.downloads?.chrome || null;
}

if (!version) {
  throw new Error(`Could not resolve Chrome for Testing version from ${metadataUrl}`);
}
if (!Array.isArray(downloads)) {
  throw new Error(`Could not resolve Chrome for Testing downloads from ${metadataUrl}`);
}

const match = downloads.find((entry) => entry && entry.platform === requestedPlatform);
if (!match?.url) {
  throw new Error(`Could not find Chrome for Testing download for ${requestedPlatform} in ${metadataUrl}`);
}

process.stdout.write(`${version}\t${match.url}\n`);
' "$metadata_url" "$requested_channel" "$requested_version" "$requested_platform"
}

install_managed_cft_browser() {
  local metadata_url
  local download_info
  local version
  local download_url
  local version_root
  local platform_root
  local relpath
  local tmp_zip

  BROWSER_KIND_RESOLVED="cft"
  BROWSER_CHANNEL_RESOLVED="$(cft_channel)"
  BROWSER_PLATFORM_RESOLVED="$(cft_platform)"
  relpath="$(cft_binary_relpath "$BROWSER_PLATFORM_RESOLVED")"
  [[ -n "$BROWSER_PLATFORM_RESOLVED" && -n "$relpath" ]] || {
    echo "Unsupported platform for Chrome for Testing runtime." >&2
    exit 1
  }

  metadata_url="$(resolve_cft_metadata_url)"
  if ! download_info="$(curl -fsSL "$metadata_url" | resolve_cft_download_info "$metadata_url")"; then
    echo "Could not resolve Chrome for Testing download metadata from $metadata_url" >&2
    exit 1
  fi
  version="${download_info%%$'\t'*}"
  download_url="${download_info#*$'\t'}"
  version_root="${INSTALL_ROOT}/browsers/chrome-for-testing/${version}"
  platform_root="${version_root}/${BROWSER_PLATFORM_RESOLVED}"
  BROWSER_VERSION_RESOLVED="$version"
  BROWSER_BINARY_RESOLVED="${platform_root}/${relpath}"

  if [[ -x "$BROWSER_BINARY_RESOLVED" ]]; then
    BROWSER_STATUS="present"
  else
    if [[ "$SKIP_BROWSER_DOWNLOAD" == "1" ]]; then
      INSTALL_WARNINGS+=("Managed Chrome for Testing download was skipped, and no installed browser was found at ${BROWSER_BINARY_RESOLVED}. Re-run install without --skip-browser-download or set CHROME_USE_CHROME_BIN explicitly.")
      BROWSER_STATUS="missing"
      return 0
    fi

    ensure_browser_download_dependencies
    mkdir -p "${platform_root}" "${CFT_CHANNELS_ROOT}"
    tmp_zip="$(mktemp "${TMPDIR:-/tmp}/chrome-for-testing.XXXXXX")"
    rm -rf "${platform_root}"
    mkdir -p "${platform_root}"
    if ! curl -fsSL "$download_url" -o "$tmp_zip"; then
      rm -f "$tmp_zip"
      echo "Could not download Chrome for Testing from $download_url" >&2
      exit 1
    fi
    if ! extract_cft_archive "$tmp_zip" "${platform_root}"; then
      rm -f "$tmp_zip"
      echo "Could not extract Chrome for Testing archive $tmp_zip" >&2
      exit 1
    fi
    rm -f "$tmp_zip"
    validate_cft_extract "$BROWSER_BINARY_RESOLVED" "$version" "$platform_root"
    if [[ "$(platform)" == "macos" ]]; then
      xattr -cr "${platform_root}" >/dev/null 2>&1 || true
    fi
    BROWSER_STATUS="downloaded"
  fi

  mkdir -p "${CFT_CHANNELS_ROOT}"
  printf '%s\n' "$version" >"${CFT_CHANNELS_ROOT}/${BROWSER_CHANNEL_RESOLVED}-${BROWSER_PLATFORM_RESOLVED}.txt"
}

ensure_browser_available() {
  BROWSER_KIND_RESOLVED="$(resolve_browser_kind)"
  case "$BROWSER_KIND_RESOLVED" in
    system)
      BROWSER_STATUS="system"
      BROWSER_CHANNEL_RESOLVED=""
      BROWSER_VERSION_RESOLVED=""
      BROWSER_PLATFORM_RESOLVED="$(cft_platform)"
      ensure_system_chrome_available
      BROWSER_BINARY_RESOLVED="$(detect_system_chrome_bin || true)"
      ;;
    cft)
      install_managed_cft_browser
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

  cat >"${BIN_ROOT}/chrome-use-open-google-chrome" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${CHROME_USE_INSTALL_ROOT:-$HOME/.chrome-use}"
exec "${INSTALL_ROOT}/runtime/chrome-use/scripts/open_agent_profile_chrome.sh" "$@"
EOF
  chmod +x "${BIN_ROOT}/chrome-use-open-google-chrome"
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

prune_unselected_targets() {
  local target
  local target_root
  for target in codex generic claude; do
    if has_target "$target"; then
      continue
    fi

    target_root="$(resolve_target_root "$target")"
    if [[ -d "${target_root}/chrome-inspect" || -d "${target_root}/chrome-auth" ]]; then
      rm -rf "${target_root}/chrome-inspect" "${target_root}/chrome-auth"
      PRUNED_TARGETS+=("${target}:${target_root}")
    fi
  done

  if has_target "codex" && has_target "generic"; then
    INSTALL_WARNINGS+=("Both codex and generic targets were selected. Codex may surface duplicate \`chrome-inspect\` and \`chrome-auth\` entries when both \`~/.codex/skills\` and \`~/.agents/skills\` contain these skills.")
  fi
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

  INSTALL_WARNINGS+=("Runtime bootstrap check could not verify the managed browser attach automatically. Install completed successfully; retry later with \`${BIN_ROOT}/chrome-use-doctor\` or \`${BIN_ROOT}/chrome-use-open-google-chrome\`.")
  INSTALL_WARNINGS+=("Bootstrap check output: $(printf '%s' "$bootstrap_output" | tr '\n' ' ' | sed 's/  */ /g')")
  return 0
}

maybe_install_chrome_app() {
  if [[ "$INSTALL_CHROME_APP" == "1" ]]; then
    CHROME_APP_STATUS="deprecated"
    INSTALL_WARNINGS+=("--install-chrome-app is deprecated. chrome-use now uses a managed Chrome for Testing runtime by default and no separate Chrome app shim is installed.")
    return 0
  fi

  CHROME_APP_STATUS="skipped"
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
  browserKind: process.env.CHROME_USE_INSTALL_BROWSER_KIND || "",
  browserChannel: process.env.CHROME_USE_INSTALL_BROWSER_CHANNEL || "",
  browserVersion: process.env.CHROME_USE_INSTALL_BROWSER_VERSION || "",
  browserPlatform: process.env.CHROME_USE_INSTALL_BROWSER_PLATFORM || "",
  browserBinary: process.env.CHROME_USE_INSTALL_BROWSER_BINARY || "",
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
  if (( ${#PRUNED_TARGETS[@]} > 0 )); then
    echo
    echo "Removed duplicate installs from unselected targets:"
    for entry in "${PRUNED_TARGETS[@]:-}"; do
      echo "  - ${entry%%:*}: ${entry#*:}"
    done
  fi
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
  echo "Browser runtime:"
  echo "  - kind: ${BROWSER_KIND_RESOLVED:-unknown}"
  if [[ -n "$BROWSER_VERSION_RESOLVED" ]]; then
    echo "  - version: ${BROWSER_VERSION_RESOLVED}"
  fi
  if [[ -n "$BROWSER_PLATFORM_RESOLVED" ]]; then
    echo "  - platform: ${BROWSER_PLATFORM_RESOLVED}"
  fi
  if [[ -n "$BROWSER_BINARY_RESOLVED" ]]; then
    echo "  - binary: ${BROWSER_BINARY_RESOLVED}"
  fi
  echo "Browser preparation:"
  echo "  - Run \`${BIN_ROOT}/chrome-use-open-google-chrome\` to bootstrap CDP attach"
  echo "  - Legacy compatibility alias remains at \`${BIN_ROOT}/chrome-use-open-agent-profile-chrome\`"
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
    --browser)
      BROWSER_SPEC="${2:-}"
      shift 2
      ;;
    --skip-browser-download)
      SKIP_BROWSER_DOWNLOAD=1
      shift
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
ensure_browser_available
install_managed_payload
create_bin_wrappers
for target in "${TARGETS[@]}"; do
  install_target "$target"
done
prune_unselected_targets
bootstrap_profile
maybe_install_chrome_app
export CHROME_USE_INSTALL_BROWSER_KIND="${BROWSER_KIND_RESOLVED}"
export CHROME_USE_INSTALL_BROWSER_CHANNEL="${BROWSER_CHANNEL_RESOLVED}"
export CHROME_USE_INSTALL_BROWSER_VERSION="${BROWSER_VERSION_RESOLVED}"
export CHROME_USE_INSTALL_BROWSER_PLATFORM="${BROWSER_PLATFORM_RESOLVED}"
export CHROME_USE_INSTALL_BROWSER_BINARY="${BROWSER_BINARY_RESOLVED}"
write_manifest
print_summary
