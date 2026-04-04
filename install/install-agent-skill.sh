#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ROOT="${AGENT_SKILLS_ROOT:-$HOME/.agents/skills}"

mkdir -p "$TARGET_ROOT"
rm -rf "$TARGET_ROOT/chrome-inspect" "$TARGET_ROOT/chrome-auth"

for name in chrome-inspect chrome-auth; do
  ln -s "$REPO_ROOT/skills/$name" "$TARGET_ROOT/$name"
  echo "Installed $name to $TARGET_ROOT/$name"
done
