#!/usr/bin/env bash
# 打包构建产物。多端打包请用 ../browser-agent-build/。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_DIR="${UPSTREAM_DIR:-$REPO_ROOT/upstream}"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/dist}"

cd "$UPSTREAM_DIR"

if [[ "$(uname -s)" == "Darwin" ]]; then
  "$REPO_ROOT/scripts/macos-adhoc-sign-apps.sh" "$UPSTREAM_DIR"
fi

./mach package

if [[ "$(uname -s)" == "Darwin" ]]; then
  shopt -s nullglob
  dmg_files=(obj-*/dist/firefox-*.mac.dmg)
  shopt -u nullglob
  if [[ ${#dmg_files[@]} -gt 0 ]]; then
    "$REPO_ROOT/scripts/macos-verify-dmg.sh" "${dmg_files[@]}"
  fi
fi

mkdir -p "$DIST_DIR"
shopt -s nullglob
for artifact in obj-*/dist/firefox-*.{tar.xz,dmg,zip,exe,deb}; do
  name="${artifact##*/}"
  if [[ "$name" == *.dmg ]]; then
    name="web-reverse-${name#firefox-}"
  fi
  cp -v "$artifact" "$DIST_DIR/$name"
done

echo "[package] artifacts → $DIST_DIR"
