#!/usr/bin/env python3
"""Brand an unsigned, unpacked Mozilla 7z SFX stub before adding its payload.

Only version/icon resources and PE size/checksum fields are changed. Code,
imports, manifests and all other resources retain their original bytes.
PE layout: https://learn.microsoft.com/windows/win32/debug/pe-format
Version layout: https://learn.microsoft.com/windows/win32/menurc/vs-versioninfo
"""

import argparse
from pathlib import Path
import struct


def align(value, boundary=4):
    return (value + boundary - 1) // boundary * boundary


def version_block(key, value=b"", kind=0, children=()):
    data = bytearray(b"\0" * 6 + (key + "\0").encode("utf-16le"))
    data.extend(b"\0" * (align(len(data)) - len(data)))
    data.extend(value)
    for child in children:
        data.extend(b"\0" * (align(len(data)) - len(data)))
        data.extend(child)
    struct.pack_into("<HHH", data, 0, len(data), len(value) // 2 if kind else len(value), kind)
    return bytes(data)


def brand_stub(source, icon=None):
    data = bytearray(source)
    if data[:2] != b"MZ":
        raise ValueError("Expected a PE stub")
    pe = struct.unpack_from("<I", data, 60)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise ValueError("Invalid PE signature")
    count, optional_size = (struct.unpack_from("<H", data, pe + offset)[0] for offset in (6, 20))
    optional = pe + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    if magic not in (0x10B, 0x20B):
        raise ValueError("Unsupported PE optional header")
    directories = optional + (96 if magic == 0x10B else 112)
    if any(struct.unpack_from("<II", data, directories + 4 * 8)):
        raise ValueError("Refusing to modify a signed stub")
    sections = []
    for index in range(count):
        header = optional + optional_size + index * 40
        virtual_size, rva, raw_size, raw = struct.unpack_from("<IIII", data, header + 8)
        sections.append((header, virtual_size, rva, raw_size, raw))
    resource_rva, resource_size = struct.unpack_from("<II", data, directories + 2 * 8)
    section = next(s for s in sections if s[2] <= resource_rva < s[2] + s[1])
    header, virtual_size, rva, raw_size, raw = section
    if section != sections[-1] or raw + raw_size != len(data):
        raise ValueError("Expected an unpacked stub with its resource section last; no overlay allowed")
    if resource_rva != rva or resource_size != virtual_size:
        raise ValueError("Unsupported resource section layout")

    def entries(relative):
        base = raw + relative
        named, ids = struct.unpack_from("<HH", data, base + 12)
        return [struct.unpack_from("<II", data, base + 16 + i * 8) for i in range(named + ids)]

    def leaves(resource_type):
        types = [value for key, value in entries(0) if key == resource_type]
        if len(types) != 1 or not types[0] & 0x80000000:
            raise ValueError(f"Expected one resource type {resource_type}")
        result = []
        for name, directory in entries(types[0] & 0x7FFFFFFF):
            if name & 0x80000000 or not directory & 0x80000000:
                raise ValueError("Unsupported resource name")
            for language, leaf in entries(directory & 0x7FFFFFFF):
                if leaf & 0x80000000:
                    raise ValueError("Unsupported resource language")
                result.append((name, language, leaf))
        return result

    versions = leaves(16)
    if len(versions) != 1:
        raise ValueError("Expected one version resource")
    _, language, leaf = versions[0]
    entry = raw + leaf
    old_rva, old_size = struct.unpack_from("<II", data, entry)
    old = bytes(data[raw + old_rva - rva:raw + old_rva - rva + old_size])
    key = ("VS_VERSION_INFO\0").encode("utf-16le")
    if old[6:6 + len(key)] != key:
        raise ValueError("Invalid version resource")
    fixed_offset = align(6 + len(key))
    fixed = old[fixed_offset:fixed_offset + 52]
    if len(fixed) != 52 or struct.unpack_from("<I", fixed)[0] != 0xFEEF04BD:
        raise ValueError("Invalid fixed version information")
    # Preserve the 7z stub's actual binary version and copyright attribution.
    version = struct.unpack_from("<II", fixed, 8)
    version_text = ".".join(str(part) for word in version for part in (word >> 16, word & 65535))
    strings = {
        "CompanyName": "Web Reverse", "FileDescription": "Web Reverse Installer",
        "FileVersion": version_text, "InternalName": "7zS.sfx",
        "LegalCopyright": "Mozilla", "OriginalFilename": "web-reverse-setup.exe",
        "ProductName": "Web Reverse", "ProductVersion": version_text,
    }
    table = version_block(f"{language:04x}04b0", kind=1, children=[
        version_block(key, (value + "\0").encode("utf-16le"), 1)
        for key, value in strings.items()
    ])
    branded = version_block("VS_VERSION_INFO", fixed, children=[
        version_block("StringFileInfo", kind=1, children=[table]),
        version_block("VarFileInfo", kind=1, children=[
            version_block("Translation", struct.pack("<HH", language, 1200))
        ]),
    ])
    # Append within the final section and point the existing leaf at the new
    # value. No existing resource's RVA or contents are moved.
    replacements = [(leaf, branded)]
    if icon is not None:
        reserved, kind, count = struct.unpack_from("<HHH", icon)
        if (reserved, kind) != (0, 1) or not count:
            raise ValueError("Expected an ICO image")
        images = {}
        for index in range(count):
            descriptor = icon[6 + index * 16:6 + (index + 1) * 16]
            size, offset = struct.unpack_from("<II", descriptor, 8)
            image = icon[offset:offset + size]
            if len(image) != size:
                raise ValueError("Truncated ICO image")
            images[descriptor[:2]] = (descriptor[:12], image)
        groups = leaves(14)
        if len(groups) != 1:
            raise ValueError("Expected one installer icon group")
        _, icon_language, group_leaf = groups[0]
        group_rva, group_size = struct.unpack_from("<II", data, raw + group_leaf)
        group = bytearray(data[raw + group_rva - rva:raw + group_rva - rva + group_size])
        icon_count = struct.unpack_from("<H", group, 4)[0]
        icon_leaves = {(name, lang): leaf for name, lang, leaf in leaves(3)}
        for index in range(icon_count):
            offset = 6 + index * 14
            descriptor, image = images[bytes(group[offset:offset + 2])]
            name = struct.unpack_from("<H", group, offset + 12)[0]
            replacements.append((icon_leaves[(name, icon_language)], image))
            group[offset:offset + 12] = descriptor
        replacements.append((group_leaf, group))
    new_size = align(virtual_size)
    for leaf, value in replacements:
        position = align(new_size)
        new_size = position + len(value)
        if raw + new_size > len(data):
            data.extend(b"\0" * (raw + new_size - len(data)))
        data[raw + position:raw + new_size] = value
        struct.pack_into("<II", data, raw + leaf, rva + position, len(value))
    section_alignment, file_alignment = struct.unpack_from("<II", data, optional + 32)
    new_raw_size = align(new_size, file_alignment)
    data.extend(b"\0" * (raw + new_raw_size - len(data)))
    struct.pack_into("<I", data, header + 8, new_size)
    struct.pack_into("<I", data, header + 16, new_raw_size)
    struct.pack_into("<II", data, directories + 2 * 8, resource_rva, new_size)
    initialized = struct.unpack_from("<I", data, optional + 8)[0]
    struct.pack_into("<I", data, optional + 8, initialized + new_raw_size - raw_size)
    struct.pack_into("<I", data, optional + 56, align(rva + new_size, section_alignment))
    struct.pack_into("<I", data, optional + 64, 0)
    checksum = 0
    padded = data if len(data) % 2 == 0 else data + b"\0"
    for (word,) in struct.iter_unpack("<H", padded):
        checksum += word
        checksum = (checksum & 65535) + (checksum >> 16)
    checksum = (checksum & 65535) + (checksum >> 16)
    struct.pack_into("<I", data, optional + 64, checksum + len(data))
    return bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--icon", type=Path, help="Use product artwork for the existing installer icon sizes")
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error("The original stub must be preserved; choose a separate output")
    branded = brand_stub(args.source.read_bytes(), args.icon.read_bytes() if args.icon else None)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(branded)
    print(f"Branded Web Reverse SFX: {args.output}")


if __name__ == "__main__":
    main()
