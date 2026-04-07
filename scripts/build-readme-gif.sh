#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/docs/media"
OUT_GIF="${OUT_DIR}/chrome-inspect-demo.gif"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chrome-use-readme-gif-XXXXXX")"
FRAMES_DIR="${TMP_DIR}/frames"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${OUT_DIR}" "${FRAMES_DIR}"

node "${ROOT_DIR}/runtime/chrome-use/scripts/inspect_visual_loop.mjs" --output-dir "${TMP_DIR}/visual"

cp "${TMP_DIR}/visual/01-initial-idle.png" "${FRAMES_DIR}/frame-01.png"
cp "${TMP_DIR}/visual/03-inspecting.png" "${FRAMES_DIR}/frame-02.png"
cp "${TMP_DIR}/visual/08-selected.png" "${FRAMES_DIR}/frame-03.png"

cat > "${TMP_DIR}/frames.txt" <<EOF
file '${FRAMES_DIR}/frame-01.png'
duration 1.0
file '${FRAMES_DIR}/frame-02.png'
duration 0.9
file '${FRAMES_DIR}/frame-03.png'
duration 1.6
file '${FRAMES_DIR}/frame-03.png'
EOF

ffmpeg -y -f concat -safe 0 -i "${TMP_DIR}/frames.txt" -vf "fps=8,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" "${OUT_GIF}" >/dev/null 2>&1

echo "wrote ${OUT_GIF}"
