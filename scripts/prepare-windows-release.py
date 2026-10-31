#!/usr/bin/env python3
"""Verify and collect a locally built Windows release candidate."""

import argparse
import configparser
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def git(*args, check=True):
    return subprocess.run(["git", "-C", str(ROOT), *args], check=check, stdout=subprocess.PIPE).stdout


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(archive):
    with zipfile.ZipFile(archive) as package:
        for name in package.namelist():
            parts = PurePosixPath(name).parts
            if not parts or parts[0] != "firefox" or ".." in parts or "\\" in name:
                raise ValueError(f"Invalid package path: {name}")
        if package.testzip():
            raise ValueError("Corrupt ZIP archive")
        binary = package.read("firefox/firefox.exe")
        if binary[:2] != b"MZ":
            raise ValueError("firefox.exe is not a Windows executable")
        pe = struct.unpack_from("<I", binary, 60)[0]
        if binary[pe:pe + 4] != b"PE\0\0" or struct.unpack_from("<H", binary, pe + 4)[0] != 0x8664:
            raise ValueError("Expected an x86_64 PE executable")
        ini = configparser.ConfigParser()
        ini.read_string(package.read("firefox/application.ini").decode("utf-8"))
        build = ini["App"]["BuildID"]
        if not re.fullmatch(r"[0-9]{14}", build):
            raise ValueError("Invalid BuildID")
        for name in ["msvcp140.dll", "msvcp140_atomic_wait.dll", "vcruntime140.dll", "vcruntime140_1.dll"]:
            if not package.getinfo("firefox/" + name).file_size:
                raise ValueError(f"Missing browser runtime: {name}")
        with zipfile.ZipFile(io.BytesIO(package.read("firefox/browser/omni.ja"))) as omni:
            for relative in [
                "runtime/AgentLoop.sys.mjs", "backends/LedgerBackend.sys.mjs", "backends/Backends.sys.mjs",
                "backends/EnvironmentBackend.sys.mjs", "llm/ReasoningEffort.sys.mjs",
                "host/BundledRuntimes.sys.mjs",
            ]:
                source = ROOT / "additions/browser/components/agent-sidebar/modules" / relative
                if omni.read("modules/agentsidebar/" + relative) != source.read_bytes():
                    raise ValueError(f"Stale module in package: {relative}")
            if omni.read("chrome/browser/content/branding/about-logo.png") != (ROOT / "additions/browser/branding/unofficial/content/about-logo.png").read_bytes():
                raise ValueError("Stale browser logo")
        runtimes = json.loads(package.read("firefox/runtimes/MANIFEST.json"))
        if runtimes != json.loads((ROOT / "configs/windows-runtimes.json").read_text()):
            raise ValueError("Runtime versions do not match the pinned manifest")
        for name in ["node/node.exe", "node/node_modules/npm/bin/npm-cli.js", "python/python.exe", "python/python3.exe", "python/Lib/site-packages/pip/__main__.py"]:
            if not package.getinfo("firefox/runtimes/" + name).file_size:
                raise ValueError(f"Missing bundled runtime: {name}")
        return dict(ini["App"])


def prepare(archive, installer, output, native_report=None):
    app = verify(archive)
    report = json.loads(native_report.read_text(encoding="utf-8")) if native_report else None
    if report and (report.get("status") != "passed" or report.get("package_sha256") != sha(archive)
                   or report.get("runtime_build_id") != app["buildid"]):
        raise ValueError("Native report does not verify this exact candidate")
    version = json.loads((ROOT / "additions/browser/components/agent-sidebar/package.json").read_text())["version"]
    with installer.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("Installer is not a Windows executable")
    output.mkdir(parents=True, exist_ok=True)
    prefix = f"browser-agent-v{version}-windows-x86_64"
    for source, extension in [(archive, ".zip"), (installer, ".exe")]:
        target = output / (prefix + extension)
        if source.resolve() != target.resolve():
            shutil.copyfile(source, target)

    patch = git("diff", "--binary", "HEAD")
    for name in git("ls-files", "--others", "--exclude-standard", "-z").decode().split("\0"):
        if name.startswith(("additions/", "configs/", "scripts/", "docs/", "tests/")) and (ROOT / name).is_file():
            patch += git("diff", "--no-index", "--binary", "--", "/dev/null", name, check=False)
    if patch:
        (output / "SOURCE-CHANGES.patch").write_bytes(patch)
    else:
        (output / "SOURCE-CHANGES.patch").unlink(missing_ok=True)

    metadata = {
        "version": version, "platform": "windows-x86_64", "application": app,
        "source_repository": git("remote", "get-url", "origin").decode().strip(),
        "source_base_commit": git("rev-parse", "HEAD").decode().strip(),
        "source_modified": bool(patch),
        "upstream_commit": subprocess.check_output(["git", "-C", str(ROOT / "upstream"), "rev-parse", "HEAD"], text=True).strip(),
        "checks": ["ZIP integrity", "PE x86_64", "BuildID", "VC runtime DLLs", "current AgentLoop and backend modules", "current browser logo", "pinned bundled runtimes"],
        "native_windows_validation": "passed" if report else "pending",
        "runtimes": json.loads((ROOT / "configs/windows-runtimes.json").read_text()),
    }
    if report:
        (output / "WINDOWS-NATIVE-REPORT.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (output / "BUILD-INFO.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    validation = "已通过本机原生 Windows 启动与运行时验证，详情见 WINDOWS-NATIVE-REPORT.json。" if report else "GitHub 发布前应完成原生 Windows 启动验证。"
    (output / "README-WINDOWS.md").write_text(f"""# Browser Agent MCP / Firefox Reverse v{version}

适用于 Windows 10/11 x64。无需编译源码。

- 安装版：运行 `{prefix}.exe`，按向导安装，然后从开始菜单启动 Firefox Reverse。
- 便携版：解压 `{prefix}.zip`，保留完整 firefox 目录，运行 firefox.exe。
- 首次使用：打开 Agent 侧栏，在设置中配置模型 Provider、API Key 或支持的订阅登录。
- 已内置 VC 运行库、Node.js/npm、Python/pip，Agent 自动识别，无需另装运行时或设置系统 PATH。
- Python 额外依赖默认安装到当前工作目录的 .python-packages，避免写入应用安装目录。
- 此候选版包含新图标和全自动模式续跑修复，尚未进行数字签名。
- 沿用项目 Phase B 原生追踪配置：Windows 内容进程沙箱会关闭，以允许追踪写入临时文件；这是专用分析浏览器的构建取舍。

BuildID：{app['buildid']}。SHA256SUMS 提供文件校验值。
BUILD-INFO.json 记录源码版本与验证情况；若有 SOURCE-CHANGES.patch，它记录相对源码基线的未提交改动。
此目录为本地候选包，尚未上传 GitHub。{validation} 发布前应把源码改动提交到对应发布版本。
""", encoding="utf-8")
    (output / "SHA256SUMS").write_text("".join(
        f"{sha(path)}  {path.name}\n" for path in sorted(output.iterdir())
        if path.is_file() and path.name != "SHA256SUMS"
    ), encoding="utf-8")
    print(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("installer", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--native-report", type=Path)
    args = parser.parse_args()
    prepare(args.archive.resolve(strict=True), args.installer.resolve(strict=True), args.output_dir.resolve(), args.native_report)


if __name__ == "__main__":
    main()
