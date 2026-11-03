#!/usr/bin/env python3
"""Verify that the self-extracting installer contains the exact candidate ZIP."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(package, installer, output, sevenzip, setup_output=None):
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "package_sha256": sha(package), "installer_sha256": sha(installer)}
    try:
        with tempfile.TemporaryDirectory(prefix="web-reverse-installer-") as temporary:
            work = Path(temporary).resolve()
            assert work.is_relative_to(Path(tempfile.gettempdir()).resolve())
            assert work.name.startswith("web-reverse-installer-")
            for args in (["t", str(installer)], ["x", "-y", "-o" + str(work), str(installer)]):
                result = subprocess.run([str(sevenzip), *args], capture_output=True, text=True)
                if result.returncode:
                    raise ValueError(f"7z installer validation failed: {result.stdout[-2000:]} {result.stderr[-2000:]}")
            with zipfile.ZipFile(package) as archive:
                expected = {}
                for member in archive.infolist():
                    if member.is_dir():
                        continue
                    parts = Path(member.filename).parts
                    if parts[0] != "firefox" or ".." in parts or "\\" in member.filename:
                        raise ValueError("Invalid package path")
                    relative = Path(*parts[1:])
                    with archive.open(member) as stream:
                        expected[relative.as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
                actual = {path.relative_to(work / "core").as_posix(): sha(path)
                          for path in (work / "core").rglob("*") if path.is_file()}
                if not expected or expected != actual:
                    raise ValueError("Installer payload differs from the candidate ZIP")
            setup = work / "setup.exe"
            if setup.read_bytes()[:2] != b"MZ":
                raise ValueError("Missing inner Windows installer")
            report.update(status="passed", installer_payload_matches_zip=True,
                          payload_files=len(actual), setup_sha256=sha(setup))
            if setup_output:
                setup_output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(setup, setup_output)
    except Exception as error:
        report.update(status="failed", error=str(error))
        raise
    finally:
        (output / "INSTALLER-PAYLOAD-REPORT.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("installer", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    state = Path(os.environ.get("MOZBUILD_STATE_PATH", Path.home() / ".mozbuild"))
    parser.add_argument("--sevenzip", type=Path, default=shutil.which("7zz") or state / "7zz/7zz")
    parser.add_argument("--setup-output", type=Path)
    args = parser.parse_args()
    verify(args.package.resolve(strict=True), args.installer.resolve(strict=True),
           args.output_dir.resolve(), args.sevenzip, args.setup_output)
