#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ROOT="${CODEX_SKILLS_ROOT:-$HOME/.codex/skills}"

mkdir -p "$TARGET_ROOT"
rm -rf "$TARGET_ROOT/chrome-inspect" "$TARGET_ROOT/chrome-auth" "$TARGET_ROOT/chrome-use"

for name in chrome-inspect chrome-auth; do
  ln -s "$REPO_ROOT/$name" "$TARGET_ROOT/$name"
  echo "Installed $name to $TARGET_ROOT/$name"
done
