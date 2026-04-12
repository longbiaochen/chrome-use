#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BASE="${HOME}/Applications"
APP_NAME="Agent Profile Chrome"
APP_DIR="${APP_BASE}/${APP_NAME}.app"
APP_BUNDLE_ID="ai.crowdverse.chrome-use.agent-profile-chrome"
PROFILE_DIR="${CHROME_USE_PROFILE_DIR:-$HOME/.chrome-use/agent-profile}"
DEBUG_PORT="${CHROME_USE_DEBUG_PORT:-9223}"
SOURCE_APP="${CHROME_USE_CHROME_APP:-/Applications/Google Chrome.app}"
LAUNCHER_EXECUTABLE="${APP_DIR}/Contents/MacOS/agent-profile-launcher"
REAL_EXECUTABLE="${APP_DIR}/Contents/MacOS/${APP_NAME}"
INFO_PLIST="${APP_DIR}/Contents/Info.plist"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [[ ! -d "${SOURCE_APP}" ]]; then
  echo "Chrome app bundle not found at ${SOURCE_APP}." >&2
  exit 1
fi

if [[ ! -x "${SOURCE_APP}/Contents/MacOS/Google Chrome" ]]; then
  echo "Chrome executable not found in ${SOURCE_APP}." >&2
  exit 1
fi

mkdir -p "${APP_BASE}"
rm -rf "${APP_DIR}"
ditto "${SOURCE_APP}" "${APP_DIR}"

mv "${APP_DIR}/Contents/MacOS/Google Chrome" "${REAL_EXECUTABLE}"
cat > "${LAUNCHER_EXECUTABLE}" <<SH
#!/bin/zsh
set -euo pipefail

filtered_args=()
for arg in "\$@"; do
  case "\$arg" in
    -psn_*)
      ;;
    --user-data-dir=*|--remote-debugging-port=*|--no-first-run|--no-default-browser-check)
      ;;
    *)
      filtered_args+=("\$arg")
      ;;
  esac
done

if [[ "\${#filtered_args[@]}" -eq 0 ]]; then
  filtered_args=("about:blank")
fi

exec "${REAL_EXECUTABLE}" \
  --user-data-dir="${PROFILE_DIR}" \
  --remote-debugging-port="${DEBUG_PORT}" \
  --no-first-run \
  --no-default-browser-check \
  "\${filtered_args[@]}"
SH
chmod +x "${LAUNCHER_EXECUTABLE}"

plutil -replace CFBundleDisplayName -string "${APP_NAME}" "${INFO_PLIST}"
plutil -replace CFBundleName -string "${APP_NAME}" "${INFO_PLIST}"
plutil -replace CFBundleIdentifier -string "${APP_BUNDLE_ID}" "${INFO_PLIST}"
plutil -replace CFBundleExecutable -string "agent-profile-launcher" "${INFO_PLIST}"

if [[ -x "${LSREGISTER}" ]]; then
  "${LSREGISTER}" -f "${APP_DIR}" >/dev/null 2>&1 || true
fi

xattr -cr "${APP_DIR}" >/dev/null 2>&1 || true
codesign --force --deep -s - "${APP_DIR}" >/dev/null 2>&1

tmp_before="$(mktemp "${TMPDIR:-/tmp}/chrome-use-dock-before.XXXXXX.plist")"
tmp_after="$(mktemp "${TMPDIR:-/tmp}/chrome-use-dock-after.XXXXXX.plist")"
defaults export com.apple.dock - > "${tmp_before}"

python3 - "${tmp_before}" "${tmp_after}" "${APP_DIR}" "${APP_BUNDLE_ID}" "${APP_NAME}" <<'PY'
import plistlib
import sys
import urllib.parse
from pathlib import Path

before_path = Path(sys.argv[1])
after_path = Path(sys.argv[2])
app_dir = Path(sys.argv[3])
bundle_id = sys.argv[4]
app_name = sys.argv[5]
app_url = "file://" + urllib.parse.quote(f"{app_dir}/")

with before_path.open("rb") as handle:
    payload = plistlib.load(handle)

apps = payload.get("persistent-apps", [])
filtered = []
for item in apps:
    tile_data = item.get("tile-data", {}) if isinstance(item, dict) else {}
    file_data = tile_data.get("file-data", {}) if isinstance(tile_data, dict) else {}
    existing_bundle = tile_data.get("bundle-identifier", "")
    existing_label = tile_data.get("file-label", "")
    existing_url = file_data.get("_CFURLString", "") if isinstance(file_data, dict) else ""
    if existing_bundle == bundle_id:
        continue
    if existing_label == app_name:
        continue
    if existing_url == app_url:
        continue
    filtered.append(item)

new_item = {
    "tile-data": {
        "bundle-identifier": bundle_id,
        "dock-extra": False,
        "file-data": {
            "_CFURLString": app_url,
            "_CFURLStringType": 15,
        },
        "file-label": app_name,
        "file-type": 41,
    },
    "tile-type": "file-tile",
}

result = []
inserted = False
for item in filtered:
    tile_data = item.get("tile-data", {}) if isinstance(item, dict) else {}
    if not inserted and tile_data.get("file-label") == "Google Chrome":
        result.append(new_item)
        inserted = True
    result.append(item)

if not inserted:
    result.append(new_item)

payload["persistent-apps"] = result
with after_path.open("wb") as handle:
    plistlib.dump(payload, handle)
PY

defaults import com.apple.dock "${tmp_after}"
killall Dock >/dev/null 2>&1 || true

rm -f "${tmp_before}" "${tmp_after}"

echo "${APP_DIR}"
