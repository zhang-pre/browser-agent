"""Validate local Windows artifacts without installing or opening a user profile."""

import argparse
import configparser
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import platform
import runpy
import shutil
import struct
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def version_info(path):
    api = ctypes.WinDLL("version", use_last_error=True)
    api.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    api.GetFileVersionInfoSizeW.restype = wintypes.DWORD
    api.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    api.GetFileVersionInfoW.restype = wintypes.BOOL
    api.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    api.VerQueryValueW.restype = wintypes.BOOL
    size = api.GetFileVersionInfoSizeW(str(path), None)
    if not size:
        raise ctypes.WinError(ctypes.get_last_error())
    data = ctypes.create_string_buffer(size)
    if not api.GetFileVersionInfoW(str(path), 0, size, data):
        raise ctypes.WinError(ctypes.get_last_error())
    pointer = ctypes.c_void_p()
    length = wintypes.UINT()
    assert api.VerQueryValueW(data, "\\VarFileInfo\\Translation", ctypes.byref(pointer), ctypes.byref(length))
    translations = (ctypes.c_ushort * (length.value // 2)).from_address(pointer.value)
    result = {}
    for index in range(0, len(translations), 2):
        table = f"{translations[index]:04x}{translations[index + 1]:04x}"
        for name in ["ProductName", "FileDescription", "CompanyName", "OriginalFilename"]:
            query = f"\\StringFileInfo\\{table}\\{name}"
            if api.VerQueryValueW(data, query, ctypes.byref(pointer), ctypes.byref(length)) and length.value:
                result.setdefault(name, ctypes.wstring_at(pointer.value))
    return result


def installer_icons(path):
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
    api.LoadLibraryExW.restype = wintypes.HMODULE
    api.FindResourceW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p]
    api.FindResourceW.restype = wintypes.HANDLE
    api.SizeofResource.argtypes = [wintypes.HMODULE, wintypes.HANDLE]
    api.SizeofResource.restype = wintypes.DWORD
    api.LoadResource.argtypes = [wintypes.HMODULE, wintypes.HANDLE]
    api.LoadResource.restype = wintypes.HANDLE
    api.LockResource.argtypes = [wintypes.HANDLE]
    api.LockResource.restype = ctypes.c_void_p
    api.FreeLibrary.argtypes = [wintypes.HMODULE]
    module = api.LoadLibraryExW(str(path), None, 2)  # Load resources without executing code.
    if not module:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        def resource(kind, name):
            found = api.FindResourceW(module, name, kind)
            if not found:
                raise ctypes.WinError(ctypes.get_last_error())
            pointer = api.LockResource(api.LoadResource(module, found))
            return ctypes.string_at(pointer, api.SizeofResource(module, found))
        group = resource(14, 1)
        result = {}
        for index in range(struct.unpack_from("<H", group, 4)[0]):
            row = group[6 + index * 14:20 + index * 14]
            name = struct.unpack_from("<H", row, 12)[0]
            result[row[:2]] = resource(3, name)
        return result
    finally:
        api.FreeLibrary(module)


def run(package, installer, output, setup=None):
    assert platform.system() == "Windows", "Run this check with native Windows Python"
    package = package.resolve(strict=True)
    installer = installer.resolve(strict=True)
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(package) as archive:
        app = configparser.ConfigParser()
        app.read_string(archive.read("firefox/application.ini").decode("utf-8"))
    tag = "v" + json.loads((ROOT / "additions/browser/components/agent-sidebar/package.json").read_text(encoding="utf-8"))["version"]
    assert package.name == f"web-reverse-{tag}-windows-x86_64.zip"
    with package.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    work = Path(tempfile.mkdtemp(prefix="web-reverse-windows-qa-")).resolve()
    temporary_root = Path(tempfile.gettempdir()).resolve()
    assert work.is_relative_to(temporary_root) and work.name.startswith("web-reverse-windows-qa-")
    with installer.open("rb") as source:
        installer_digest = hashlib.file_digest(source, "sha256").hexdigest()
    report = {"status": "failed", "local_validation": True, "installer_sha256": installer_digest}
    previous_directory = Path.cwd()
    try:
        scan = work / "pe-properties"
        scan.mkdir()
        properties = {"installer": version_info(installer)}
        if setup:
            setup = setup.resolve(strict=True)
            properties["setup.exe"] = version_info(setup)
            with setup.open("rb") as source:
                report["setup_sha256"] = hashlib.file_digest(source, "sha256").hexdigest()
        with zipfile.ZipFile(package) as archive:
            for relative in ["firefox.exe", "private_browsing.exe", "desktop-launcher/desktop-launcher.exe", "uninstall/helper.exe"]:
                name = "firefox/" + relative
                if name not in archive.namelist():
                    continue
                target = scan / relative.replace("/", "-")
                target.write_bytes(archive.read(name))
                properties[relative] = version_info(target)
        for name, values in properties.items():
            assert values.get("ProductName") == "Web Reverse", (name, values)
            description = values.get("FileDescription", "")
            # Upstream's desktop launcher has no module.ver and intentionally
            # uses create_rc.py's empty description; its product name is branded.
            if name != "desktop-launcher/desktop-launcher.exe" or description:
                assert "Web Reverse" in description, (name, values)
        ico = (ROOT / "additions/browser/branding/unofficial/firefox.ico").read_bytes()
        expected_icons = {}
        for index in range(struct.unpack_from("<H", ico, 4)[0]):
            row = ico[6 + index * 16:22 + index * 16]
            size, offset = struct.unpack_from("<II", row, 8)
            expected_icons[row[:2]] = ico[offset:offset + size]
        icons = installer_icons(installer)
        assert len(icons) == 4
        assert all(value == expected_icons[size] for size, value in icons.items()), "Stale installer icon"
        report["installer_icon_sizes"] = [f"{size[0] or 256}x{size[1] or 256}" for size in icons]
        report["file_properties"] = properties
        (output / "WINDOWS-FILE-PROPERTIES.json").write_text(json.dumps(properties, indent=2) + "\n", encoding="utf-8")
        candidate = work / "candidate"
        candidate.mkdir()
        shutil.copyfile(package, candidate / package.name)
        os.environ.update({
            "RELEASE_TAG": tag, "PACKAGE_SHA256": digest,
            "SOURCE_COMMIT": app["App"]["SourceStamp"],
            "EXPECTED_BUILD_ID": app["App"]["BuildID"], "EXPECTED_UI_LOCALE": "en-US",
            "MOZ_FRX_ENVS_ROOT": str(work / "environments"),
            "FRX_WORKSPACE_ROOT": str(work / "workspace"), "FRX_DATA_DIR": str(work / "data"),
            "GIT_DIR": str(ROOT / ".git"), "GIT_WORK_TREE": str(ROOT),
            "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "safe.directory",
            "GIT_CONFIG_VALUE_0": str(ROOT).replace("\\", "/"),
        })
        os.chdir(work)
        verifier = runpy.run_path(str(ROOT / "scripts/verify-windows-package.py"))
        verifier["validate"](report, output)
        portable = work / "portable"
        with zipfile.ZipFile(package) as archive:
            archive.extractall(portable)
        product = runpy.run_path(str(ROOT / "scripts/tests/selftest-product-firefox.py"))
        report["product_compatibility"] = product["run"](
            portable / "firefox/firefox.exe", output / "product-compatibility",
            node=portable / "firefox/runtimes/node/node.exe",
            python=portable / "firefox/runtimes/python/python.exe",
        )
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        os.chdir(previous_directory)
        (output / "WINDOWS-NATIVE-REPORT.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report), flush=True)
        assert work.is_relative_to(temporary_root) and work.name.startswith("web-reverse-windows-qa-")
        shutil.rmtree(work)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("installer", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--installer-setup", type=Path, help="Inner setup.exe extracted by verify-windows-installer.py")
    args = parser.parse_args()
    run(args.package, args.installer, args.output_dir, args.installer_setup)
