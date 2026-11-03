#!/usr/bin/env python3
"""Synchronize display branding while retaining existing installation identities."""

import argparse
from pathlib import Path
import re
import textwrap


ORIGINAL_BUNDLE_CONFIG = textwrap.dedent('''\
    @depends(moz_app_displayname, "--with-macbundlename-prefix", moz_debug)
    def mac_bundle_name(moz_app_displayname, mac_bundle_name_prefix, moz_debug):
        suffix = "Debug" if moz_debug else ""
        prefix = mac_bundle_name_prefix[0] if mac_bundle_name_prefix else ""
        app_displayname = moz_app_displayname if moz_app_displayname else ""
        return f"{prefix}{app_displayname}{suffix}.app"
''')

STABLE_BUNDLE_CONFIG = textwrap.dedent('''\
    @depends(
        moz_app_displayname, "--with-macbundlename-prefix", moz_debug, "MOZ_MACBUNDLE_ID"
    )
    def mac_bundle_name(
        moz_app_displayname, mac_bundle_name_prefix, moz_debug, macbundle_id
    ):
        suffix = "Debug" if moz_debug else ""
        prefix = mac_bundle_name_prefix[0] if mac_bundle_name_prefix else ""
        # Firefox binds its default profile to a hash of the installation path.
        # Keep this product's bundle path through display-name changes.
        app_displayname = (
            "Firefox Reverse"
            if macbundle_id and macbundle_id[0] == "browser-agent"
            else moz_app_displayname or ""
        )
        return f"{prefix}{app_displayname}{suffix}.app"
''')

INSTALL_PATH_FILES = (
    "browser/installer/windows/nsis/installer.nsi",
    "browser/installer/windows/nsis/uninstaller.nsi",
    "browser/installer/windows/nsis/postupdate_helper.nsh",
    "browser/installer/windows/nsis/stub.nsh",
    "toolkit/mozapps/installer/windows/nsis/common.nsh",
)

RC_RESOURCE_RULE = "$(notdir $(addsuffix .rc,$(PROGRAM) $(SHARED_LIBRARY) $(SIMPLE_PROGRAMS) module)): %.rc: $(RCINCLUDE) $(MOZILLA_DIR)/config/create_rc.py"
RC_CONFIG_RULE = RC_RESOURCE_RULE + " $(DEPTH)/config.status"


def handler_display_names(text):
    for label in ("HTML Document", "PDF Document", "URL"):
        text = text.replace(f'"${{AppRegName}} {label}"', f'"${{BrandShortName}} {label}"')
    return text


def synchronize(upstream):
    configure = upstream / "toolkit/moz.configure"
    sidebar = upstream / "browser/locales/en-US/browser/sidebar.ftl"
    installer = upstream / "browser/installer/windows/nsis/shared.nsh"
    rules = upstream / "config/rules.mk"
    original = configure.read_text(encoding="utf-8")
    before = textwrap.indent(ORIGINAL_BUNDLE_CONFIG, "    ")
    after = textwrap.indent(STABLE_BUNDLE_CONFIG, "    ")
    if after in original:
        updated = original
    elif original.count(before) == 1:
        updated = original.replace(before, after)
    else:
        raise ValueError("Unsupported macOS bundle configuration; refusing to rewrite it.")

    sidebar_original = sidebar.read_text(encoding="utf-8")
    sidebar_updated, count = re.subn(
        r"(?m)^(sidebar-menu-agent-label\s*=\s*\n[ \t]*\.label\s*=)[^\n]*$",
        r"\1 Web Reverse",
        sidebar_original,
    )
    if count != 1:
        raise ValueError("Agent sidebar registration is missing or ambiguous.")

    installer_original = installer.read_text(encoding="utf-8")
    installer_updated = re.sub(
        r'("(?:DisplayName|Comments|Description)"\s+")\$\{BrandFullNameInternal\}',
        r'\1${BrandFullName}',
        installer_original,
    ).replace('"Publisher" "Mozilla"', '"Publisher" "${CompanyName}"')
    installer_updated = handler_display_names(installer_updated)
    if '"DisplayName" "${BrandFullName}$3' not in installer_updated:
        raise ValueError("Unsupported Windows uninstall display-name registration.")

    install_paths = []
    for relative in INSTALL_PATH_FILES:
        target = upstream / relative
        old = target.read_text(encoding="utf-8")
        # Folder names participate in Firefox's install hash/profile selection.
        # Display labels can change without moving an existing installation.
        new = old.replace(r'\${BrandFullName}\"', r'\${BrandFullNameInternal}\"')
        new = new.replace(r'\${BrandFullName}"', r'\${BrandFullNameInternal}"')
        new = handler_display_names(new)
        install_paths.append((target, old, new))

    rules_original = rules.read_text(encoding="utf-8")
    if RC_CONFIG_RULE in rules_original:
        rules_updated = rules_original
    elif rules_original.count(RC_RESOURCE_RULE) == 1:
        rules_updated = rules_original.replace(RC_RESOURCE_RULE, RC_CONFIG_RULE)
    else:
        raise ValueError("Unsupported Windows version-resource generation rule")

    # Validate every input before modifying any source file.
    for target, old, new in [
        (configure, original, updated),
        (sidebar, sidebar_original, sidebar_updated),
        (installer, installer_original, installer_updated),
        (rules, rules_original, rules_updated),
    ] + install_paths:
        if old != new:
            target.write_text(new, encoding="utf-8")
    print("[branding] Web Reverse labels synchronized; install identities preserved")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("upstream", type=Path)
    args = parser.parse_args()
    try:
        synchronize(args.upstream.resolve(strict=True))
    except (OSError, ValueError) as error:
        parser.exit(1, f"[branding] {error}\n")


if __name__ == "__main__":
    main()
