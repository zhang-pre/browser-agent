#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
upstream=${UPSTREAM_DIR:-"$repo_root/upstream"}
objdir="$upstream/obj-x86_64-pc-windows-msvc"

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 || ! -x "$upstream/mach" ]]; then
  echo "A Linux x86_64 host and prepared Firefox source tree are required." >&2
  exit 1
fi

for tool in node npm python3 msiextract makensis; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
if [[ ! -e /lib/ld-linux.so.2 ]]; then
  echo "The bootstrapped Wine tools need a 32-bit libc runtime (Ubuntu: libc6-i386 lib32gcc-s1 lib32stdc++6)." >&2
  exit 1
fi

npm --prefix "$repo_root/additions/browser/components/agent-sidebar" run build
bash "$repo_root/scripts/sync-additions.sh"
python3 "$repo_root/scripts/apply-fingerprint-config.py" "$upstream"
python3 "$repo_root/scripts/apply-phase-b.py" "$upstream"
node "$repo_root/scripts/check-branding-assets.mjs" "$upstream"

export MOZCONFIG="$repo_root/configs/mozconfig.windows-x64"
export MOZ_BUILD_DATE=${MOZ_BUILD_DATE:-$(date -u +%Y%m%d%H%M%S)}
export MOZ_SOURCE_REPO=${MOZ_SOURCE_REPO:-$(git -C "$repo_root" remote get-url origin | sed 's/\.git$//')}
export MOZ_SOURCE_CHANGESET=${MOZ_SOURCE_CHANGESET:-$(git -C "$repo_root" rev-parse HEAD)}

cd "$upstream"
./mach --no-interactive configure
bash "$repo_root/scripts/force-build-id-relink.sh" "$objdir"
./mach build -j "${BUILD_JOBS:-6}"
./mach build --allow-subdirectory-build -C browser/installer make-package-internal

mapfile -t archives < <(find "$objdir/dist" -maxdepth 4 -type f -name 'firefox-*.win64.zip')
if [[ ${#archives[@]} != 1 ]]; then
  echo "Expected exactly one Windows ZIP." >&2
  exit 1
fi
python3 "$repo_root/scripts/bundle-windows-runtimes.py" "${archives[0]}"
ZIP_IN="${archives[0]}" ./mach build --allow-subdirectory-build -C browser/installer/windows installer

mapfile -t installers < <(find "$objdir/dist" -maxdepth 4 -type f -name 'firefox-*.win64.installer.exe')
if [[ ${#installers[@]} != 1 ]]; then
  echo "Expected exactly one Windows installer EXE." >&2
  exit 1
fi

output=${DIST_DIR:-"$repo_root/dist/windows/$MOZ_BUILD_DATE"}
python3 "$repo_root/scripts/prepare-windows-release.py" "${archives[0]}" "${installers[0]}" --output-dir "$output"
echo "Windows packages: $output"
