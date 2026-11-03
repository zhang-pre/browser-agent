#!/usr/bin/env python3
"""Check branding synchronization and stable macOS profile selection identity."""

import ast
import importlib.util
from pathlib import Path
import sys
import tempfile
import textwrap

sys.dont_write_bytecode = True
script = Path(__file__).resolve().parents[1] / "apply-product-branding.py"
spec = importlib.util.spec_from_file_location("product_branding", script)
branding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(branding)

with tempfile.TemporaryDirectory(prefix="web-reverse-branding-") as work:
    root = Path(work)
    configure = root / "toolkit/moz.configure"
    sidebar = root / "browser/locales/en-US/browser/sidebar.ftl"
    installer = root / "browser/installer/windows/nsis/shared.nsh"
    rules = root / "config/rules.mk"
    configure.parent.mkdir(parents=True)
    sidebar.parent.mkdir(parents=True)
    installer.parent.mkdir(parents=True)
    rules.parent.mkdir(parents=True)
    for old_label in ["Firefox-Reverse-Agent", "browser-agent-Agent", "Web Reverse"]:
        rules.write_text(branding.RC_RESOURCE_RULE + "\n")
        for relative in branding.INSTALL_PATH_FILES:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                'Name "${BrandFullName}"\nInstallDir "$PROGRAMFILES64\\${BrandFullName}\\"\n'
                '${Handler} "FirefoxHTML$5" "${AppRegName} HTML Document"\n'
            )
        configure.write_text(
            "with only_when(target_is_osx):\n"
            + textwrap.indent(branding.ORIGINAL_BUNDLE_CONFIG, "    ")
        )
        sidebar.write_text(f"sidebar-menu-agent-label =\n  .label = {old_label}\n")
        installer.write_text(
            'StrCpy $0 "Software\\Mozilla\\${BrandFullNameInternal}"\n'
            '${WriteRegStr2} $RegHive "$0" "DisplayName" "${BrandFullNameInternal}$3 (${ARCH} ${AB_CD})" 0\n'
            '${WriteRegStr2} $RegHive "$0" "Comments" "${BrandFullNameInternal} ${AppVersion}" 0\n'
            '${WriteRegStr2} ${RegKey} "$0" "DisplayName" "${BrandFullNameInternal}$1" 0\n'
            '${WriteRegStr2} $RegHive "$0" "Publisher" "Mozilla" 0\n'
        )
        branding.synchronize(root)
        path_before = [(root / p).read_bytes() for p in branding.INSTALL_PATH_FILES]
        first = (configure.read_bytes(), sidebar.read_bytes(), installer.read_bytes(), rules.read_bytes())
        branding.synchronize(root)
        assert first == (configure.read_bytes(), sidebar.read_bytes(), installer.read_bytes(), rules.read_bytes())
        assert rules.read_text() == branding.RC_CONFIG_RULE + "\n"
        assert path_before == [(root / p).read_bytes() for p in branding.INSTALL_PATH_FILES]
        for relative in branding.INSTALL_PATH_FILES:
            text = (root / relative).read_text()
            assert 'InstallDir "$PROGRAMFILES64\\${BrandFullNameInternal}\\"' in text
            assert 'Name "${BrandFullName}"' in text
            assert '${Handler} "FirefoxHTML$5" "${BrandShortName} HTML Document"' in text
        assert sidebar.read_text() == "sidebar-menu-agent-label =\n  .label = Web Reverse\n"
        assert '"DisplayName" "${BrandFullName}$3' in installer.read_text()
        assert '"DisplayName" "${BrandFullName}$1' in installer.read_text()
        assert '"Publisher" "${CompanyName}"' in installer.read_text()
        assert 'Software\\Mozilla\\${BrandFullNameInternal}' in installer.read_text()

    # Execute the actual configured bundle-name function, without configure's DSL.
    tree = ast.parse(configure.read_text())
    function = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef))
    function.decorator_list = []
    namespace = {}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(configure), "exec"), namespace)
    bundle_name = namespace["mac_bundle_name"]
    assert bundle_name("Web Reverse", None, False, ("browser-agent",)) == "Firefox Reverse.app"
    assert bundle_name("Web Reverse", ("Custom ",), True, ("browser-agent",)) == "Custom Firefox ReverseDebug.app"
    assert bundle_name("Other Browser", None, False, ("other",)) == "Other Browser.app"
    assert bundle_name("Other Browser", None, False, None) == "Other Browser.app"

    # Unexpected source layouts fail before modifying either input.
    configure.write_text("unsupported configuration\n")
    before_sidebar = sidebar.read_bytes()
    try:
        branding.synchronize(root)
    except ValueError:
        pass
    else:
        raise AssertionError("Unsupported configure input was accepted")
    assert sidebar.read_bytes() == before_sidebar

print("Product branding: idempotent labels, Windows display/registry identity, macOS bundle path passed")
