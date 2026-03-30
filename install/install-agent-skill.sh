#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$REPO_ROOT/chrome-use"
TARGET_ROOT="${AGENT_SKILLS_ROOT:-$HOME/.agents/skills}"
TARGET_DIR="$TARGET_ROOT/chrome-use"

mkdir -p "$TARGET_ROOT"
rm -rf "$TARGET_DIR"
ln -s "$SOURCE_DIR" "$TARGET_DIR"

echo "Installed chrome-use to $TARGET_DIR"
