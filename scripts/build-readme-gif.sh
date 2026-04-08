#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/docs/media"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chrome-use-readme-gif-XXXXXX")"
AUTH_FRAMES_DIR="${TMP_DIR}/auth-frames"
INSPECT_FRAMES_DIR="${TMP_DIR}/inspect-frames"
AUTH_GIF="${OUT_DIR}/chrome-auth-demo.gif"
INSPECT_GIF="${OUT_DIR}/chrome-inspect-demo.gif"
INSPECT_SOURCE_DIR="${TMP_INSPECT_VISUAL_DIR:-/tmp/chrome-inspect-visual-check-final}"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${OUT_DIR}" "${AUTH_FRAMES_DIR}" "${INSPECT_FRAMES_DIR}"

node "${ROOT_DIR}/runtime/chrome-use/scripts/auth_visual_loop.mjs" --output-dir "${TMP_DIR}/auth-visual"

if [[ -f "${INSPECT_SOURCE_DIR}/01-initial-idle.png" && -f "${INSPECT_SOURCE_DIR}/03-inspecting.png" && -f "${INSPECT_SOURCE_DIR}/08-selected.png" ]]; then
  cp "${INSPECT_SOURCE_DIR}/01-initial-idle.png" "${INSPECT_FRAMES_DIR}/frame-01.png"
  cp "${INSPECT_SOURCE_DIR}/03-inspecting.png" "${INSPECT_FRAMES_DIR}/frame-02.png"
  cp "${INSPECT_SOURCE_DIR}/08-selected.png" "${INSPECT_FRAMES_DIR}/frame-03.png"
else
  node "${ROOT_DIR}/runtime/chrome-use/scripts/inspect_visual_loop.mjs" --demo-only --output-dir "${TMP_DIR}/inspect-visual"
  cp "${TMP_DIR}/inspect-visual/01-initial-idle.png" "${INSPECT_FRAMES_DIR}/frame-01.png"
  cp "${TMP_DIR}/inspect-visual/03-inspecting.png" "${INSPECT_FRAMES_DIR}/frame-02.png"
  cp "${TMP_DIR}/inspect-visual/08-selected.png" "${INSPECT_FRAMES_DIR}/frame-03.png"
fi

cp "${TMP_DIR}/auth-visual/01-home-sign-up-highlight.png" "${AUTH_FRAMES_DIR}/frame-01.png"
cp "${TMP_DIR}/auth-visual/02-sign-up-submit-highlight.png" "${AUTH_FRAMES_DIR}/frame-02.png"
cp "${TMP_DIR}/auth-visual/03-log-in-submit-highlight.png" "${AUTH_FRAMES_DIR}/frame-03.png"
cp "${TMP_DIR}/auth-visual/04-dashboard-success.png" "${AUTH_FRAMES_DIR}/frame-04.png"

cat > "${TMP_DIR}/auth-frames.txt" <<EOF
file '${AUTH_FRAMES_DIR}/frame-01.png'
duration 1.0
file '${AUTH_FRAMES_DIR}/frame-02.png'
duration 1.0
file '${AUTH_FRAMES_DIR}/frame-03.png'
duration 1.0
file '${AUTH_FRAMES_DIR}/frame-04.png'
duration 1.5
file '${AUTH_FRAMES_DIR}/frame-04.png'
EOF

cat > "${TMP_DIR}/inspect-frames.txt" <<EOF
file '${INSPECT_FRAMES_DIR}/frame-01.png'
duration 0.9
file '${INSPECT_FRAMES_DIR}/frame-02.png'
duration 1.0
file '${INSPECT_FRAMES_DIR}/frame-03.png'
duration 1.5
file '${INSPECT_FRAMES_DIR}/frame-03.png'
EOF

ffmpeg -y -f concat -safe 0 -i "${TMP_DIR}/auth-frames.txt" -vf "fps=8,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" "${AUTH_GIF}" >/dev/null 2>&1
ffmpeg -y -f concat -safe 0 -i "${TMP_DIR}/inspect-frames.txt" -vf "fps=8,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" "${INSPECT_GIF}" >/dev/null 2>&1

echo "wrote ${AUTH_GIF}"
echo "wrote ${INSPECT_GIF}"
