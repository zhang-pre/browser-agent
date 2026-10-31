#!/usr/bin/env python3
"""Add pinned, checksum-verified private runtimes to a Firefox Windows ZIP."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "configs/windows-runtimes.json"
PREFIX = "firefox/runtimes/"
SITE_CUSTOMIZE = """import os
import sys
workspace = os.getcwd()
dependencies = os.path.join(workspace, '.python-packages')
sys.path[:0] = [workspace, dependencies]
if sys.argv and os.path.isfile(sys.argv[0]):
    sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[0])))
os.environ.setdefault('PIP_TARGET', dependencies)
os.environ.setdefault('PYTHONUTF8', '1')
os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
for stream in (sys.stdin, sys.stdout, sys.stderr):
    if stream is not None and hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')
"""


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def downloads(cache):
    cache.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text())
    result = {}
    for name, entry in manifest.items():
        path = cache / entry["url"].rsplit("/", 1)[-1]
        if not path.exists() or sha(path) != entry["sha256"]:
            print(f"Downloading {name} {entry['version']}", flush=True)
            temporary = path.with_suffix(path.suffix + ".part")
            with urllib.request.urlopen(entry["url"], timeout=120) as source, temporary.open("wb") as target:
                shutil.copyfileobj(source, target)
            if sha(temporary) != entry["sha256"]:
                raise ValueError(f"Checksum mismatch for {name}")
            temporary.replace(path)
        result[name] = path
    return manifest, result


def member_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name:
        raise ValueError(f"Invalid runtime archive path: {name}")
    return path


def add_runtime(target, source, prefix, *, strip_root=False):
    with zipfile.ZipFile(source) as archive:
        if archive.testzip():
            raise ValueError(f"Corrupt runtime archive: {source.name}")
        for entry in archive.infolist():
            relative = member_name(entry.filename)
            if strip_root:
                relative = PurePosixPath(*relative.parts[1:])
            if entry.is_dir() or not relative.parts:
                continue
            if prefix == "python" and relative.suffix == "._pth":
                continue
            name = PREFIX + prefix + "/" + relative.as_posix()
            with archive.open(entry) as stream, target.open(name, "w") as output:
                shutil.copyfileobj(stream, output, 1024 * 1024)


def bundle(package, cache):
    manifest, files = downloads(cache)
    with tempfile.NamedTemporaryFile(prefix=package.stem + "-", suffix=".zip", dir=package.parent, delete=False) as stream:
        temporary = Path(stream.name)
    try:
        with zipfile.ZipFile(package) as source, zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
            for entry in source.infolist():
                if entry.filename.startswith(PREFIX):
                    continue
                with source.open(entry) as data, output.open(entry, "w") as copied:
                    shutil.copyfileobj(data, copied, 1024 * 1024)
            add_runtime(output, files["node"], "node", strip_root=True)
            add_runtime(output, files["python"], "python")
            with zipfile.ZipFile(files["python"]) as python:
                output.writestr(PREFIX + "python/python3.exe", python.read("python.exe"))
            add_runtime(output, files["pip"], "python/Lib/site-packages")
            python_tag = "".join(manifest["python"]["version"].split(".")[:2])
            output.writestr(PREFIX + f"python/python{python_tag}._pth",
                            f"python{python_tag}.zip\n.\nLib/site-packages\nimport site\n")
            output.writestr(PREFIX + "python/Lib/site-packages/sitecustomize.py", SITE_CUSTOMIZE)
            output.writestr(PREFIX + "MANIFEST.json", json.dumps(manifest, indent=2) + "\n")
        temporary.replace(package)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Bundled Node.js, Python and pip: {package}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path, nargs="?")
    parser.add_argument("--cache-dir", type=Path, default=ROOT / ".tmp/windows-runtime-cache")
    args = parser.parse_args()
    if args.package:
        bundle(args.package.resolve(strict=True), args.cache_dir.resolve())
    else:
        downloads(args.cache_dir.resolve())


if __name__ == "__main__":
    main()
