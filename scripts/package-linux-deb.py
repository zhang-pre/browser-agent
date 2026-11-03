#!/usr/bin/env python3
"""Wrap a mach-produced Linux archive as a native Ubuntu/Debian application."""

import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile


# Keep dpkg's package identity, installation path, desktop ID and profile path
# stable so this is an upgrade of the installed application.
PACKAGE = "browser-agent-mcp"
PRODUCT_SLUG = "web-reverse"
ROOT = Path(__file__).resolve().parent.parent


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def write(path, content, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(mode)


def launcher_script(binary="/opt/browser-agent-mcp/firefox"):
    return '''#!/bin/sh
set -eu
export MOZ_APP_REMOTINGNAME=browser-agent-mcp
if [ "${BROWSER_AGENT_PROFILE+x}" = x ]; then
    profile=$BROWSER_AGENT_PROFILE
else
    profile="${XDG_CONFIG_HOME:-$HOME/.config}/browser-agent-mcp/profile"
fi
explicit_profile=false
for arg in "$@"; do
    case "$arg" in
        -profile|--profile|-P|-ProfileManager|--ProfileManager) explicit_profile=true ;;
    esac
done
if [ "$explicit_profile" = true ]; then
    exec @FIREFOX@ "$@"
fi
mkdir -p "$profile"
exec @FIREFOX@ -profile "$profile" "$@"
'''.replace("@FIREFOX@", shlex.quote(str(binary)))


def build(archive, output):
    for tool in ("dpkg-deb", "dpkg-shlibdeps", "dpkg-architecture", "objdump"):
        if not shutil.which(tool):
            raise ValueError(f"Missing {tool}; install dpkg-dev and binutils first.")
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="browser-agent-deb-") as work:
        work = Path(work)
        stage = work / "debian" / PACKAGE
        app = stage / "opt" / PACKAGE
        unpack = work / "unpack"
        # data filtering rejects traversal, special files and escaping links.
        with tarfile.open(archive) as source:
            source.extractall(unpack, filter="data")
        if sorted(p.name for p in unpack.iterdir()) != ["firefox"]:
            raise ValueError("Expected a mach archive containing only firefox/.")
        app.parent.mkdir(parents=True)
        shutil.move(unpack / "firefox", app)
        binary = app / "firefox"
        with binary.open("rb") as source:
            header = source.read(20)
        if header[:4] != b"\x7fELF" or header[4:6] != b"\x02\x01":
            raise ValueError("Expected a 64-bit little-endian Linux ELF executable.")
        arch = {62: "amd64", 183: "arm64"}.get(struct.unpack("<H", header[18:20])[0])
        if not arch or arch != run("dpkg-architecture", "-qDEB_HOST_ARCH"):
            raise ValueError("Package on an Ubuntu/Debian host matching the binary architecture.")
        if not os.access(binary, os.X_OK):
            raise ValueError("firefox is not executable.")
        ini = configparser.ConfigParser()
        ini.read(app / "application.ini")
        # Use the actual engine/build identity, rather than the current source
        # package.json version, which may differ from the compiled resources.
        version = ini["App"]["Version"] + "+build" + ini["App"]["BuildID"]
        if not re.fullmatch(r"[0-9][A-Za-z0-9.+~]*", version):
            raise ValueError(f"Invalid Debian package version: {version!r}")
        with zipfile.ZipFile(app / "browser" / "omni.ja") as omni:
            for module in ("ReasoningEffort.sys.mjs", "EnvironmentBackend.sys.mjs"):
                if not any(name.endswith("/" + module) for name in omni.namelist()):
                    raise ValueError(f"Agent module missing from archive: {module}")
        # The default profile belongs to this app. Explicit -profile arguments
        # remain supported for isolated environments and automated validation.
        write(stage / "usr/bin" / PACKAGE, launcher_script(), 0o755)
        (stage / "usr/bin" / PRODUCT_SLUG).symlink_to(PACKAGE)
        write(stage / "usr/share/applications" / f"{PACKAGE}.desktop", """[Desktop Entry]
Version=1.0
Type=Application
Name=Web Reverse
Name[zh_CN]=Web Reverse 浏览器
Comment=Firefox browser with a built-in analysis agent
Comment[zh_CN]=内置分析 Agent 的 Firefox 浏览器
Exec=web-reverse %u
TryExec=web-reverse
Icon=browser-agent-mcp
Terminal=false
Categories=Network;WebBrowser;Development;
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
StartupNotify=true
StartupWMClass=browser-agent-mcp
""")
        for size in (16, 32, 48, 64, 128):
            icon = app / f"browser/chrome/icons/default/default{size}.png"
            target = stage / f"usr/share/icons/hicolor/{size}x{size}/apps/{PACKAGE}.png"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(icon, target)
            target.chmod(0o644)
        # Updates must come from a new custom package, not Mozilla's updater.
        policy = app / "distribution/policies.json"
        policies = json.loads(policy.read_text()) if policy.exists() else {}
        policies.setdefault("policies", {})["DisableAppUpdate"] = True
        write(policy, json.dumps(policies, indent=2) + "\n")
        write(app / "is-packaged-app", "This is a packaged app.\n")
        write(work / "debian/control", f"""Source: {PACKAGE}
Section: web
Priority: optional
Maintainer: Web Reverse contributors <noreply@users.noreply.github.com>

Package: {PACKAGE}
Architecture: {arch}
Description: Firefox browser with a built-in analysis agent
""")
        (stage / "DEBIAN").mkdir()
        # Scan all ELF files, including helper executables and libraries loaded
        # through dlopen. Bundled libraries belong to this package (-x excludes
        # self-dependencies); missing system library information remains fatal.
        elf_args = []
        lib_dirs = set()
        for path in sorted(app.rglob("*")):
            if path.is_file():
                with path.open("rb") as source:
                    if source.read(4) == b"\x7fELF":
                        elf_args.append("-e" + str(path))
                        lib_dirs.add(path.parent)
        deps = run("dpkg-shlibdeps", "-O", "-x" + PACKAGE,
                   "-S" + str(stage), *("-l" + str(p) for p in sorted(lib_dirs)),
                   *elf_args, cwd=work)
        if not deps.startswith("shlibs:Depends="):
            raise ValueError(f"Unexpected dependency result: {deps}")
        dependencies = deps.removeprefix("shlibs:Depends=")
        size = sum(p.stat().st_size for p in stage.rglob("*") if p.is_file()) // 1024
        write(stage / "DEBIAN/control", f"""Package: {PACKAGE}
Version: {version}
Architecture: {arch}
Maintainer: Web Reverse contributors <noreply@users.noreply.github.com>
Section: web
Priority: optional
Installed-Size: {size}
Depends: {dependencies}
Recommends: ca-certificates, libasound2t64 | libasound2, libpulse0
Suggests: nodejs, npm, python3
Homepage: https://github.com/zhang-pre/browser-agent
Description: Firefox browser with a built-in analysis agent
 Web Reverse provides an agent sidebar and isolated browser environments.
 Packaged from an existing Firefox build with a dedicated application profile.
""")
        desktop = stage / "usr/share/applications" / f"{PACKAGE}.desktop"
        if shutil.which("desktop-file-validate"):
            subprocess.run(["desktop-file-validate", desktop], check=True)
        filename = f"{PRODUCT_SLUG}_{version}_{arch}.deb"
        # Build in the temporary directory so interrupted runs do not leave a
        # partial .deb at the published output path.
        subprocess.run(["dpkg-deb", "--root-owner-group", "-Zxz", "-z3",
                        "--build", stage, work / filename], check=True)
        result = output / filename
        shutil.move(work / filename, result)
        with result.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        write(output / (filename + ".sha256"), f"{digest}  {filename}\n")
        print(f"[package] {result}")
        print(f"[install] sudo apt install {result}")
        print(f"[launch] {PRODUCT_SLUG}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="Linux tar.xz produced by mach package")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    try:
        if sys.platform != "linux":
            raise ValueError("Run this script inside Ubuntu/Debian (including WSL).")
        build(args.archive.resolve(strict=True), args.output_dir.resolve())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"[package] {error}\n")


if __name__ == "__main__":
    main()
