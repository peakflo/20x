#!/usr/bin/env python3
"""Refresh sha512/size entries in an electron-builder update manifest.

electron-builder writes latest-mac.yml while packaging, before the workflow
staples the DMG. Stapling appends the ticket to the DMG, so its recorded
sha512 and size no longer match the file that gets published. Run this after
stapling to rewrite the entries for the given files.

Usage: ci-refresh-mac-manifest.py <manifest.yml> <file> [<file> ...]
"""
import base64
import hashlib
import os
import re
import sys


def sha512_b64(path):
    digest = hashlib.sha512()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return base64.b64encode(digest.digest()).decode("ascii")


def refresh(text, name, sha512, size):
    # File entry under `files:`:
    #   - url: <name>
    #     sha512: ...
    #     size: ...
    entry = re.compile(
        r"(^  - url: " + re.escape(name) + r"\n)((?:    .+\n)+)", re.MULTILINE
    )
    match = entry.search(text)
    if not match:
        raise SystemExit(f"{name} not found in manifest files list")
    body = match.group(2)
    body = re.sub(r"^    sha512: .*$", f"    sha512: {sha512}", body, flags=re.MULTILINE)
    body = re.sub(r"^    size: .*$", f"    size: {size}", body, flags=re.MULTILINE)
    text = text[: match.start(2)] + body + text[match.end(2) :]

    # Top-level `path:`/`sha512:` (legacy fields) describe a single file.
    if re.search(r"^path: " + re.escape(name) + r"$", text, re.MULTILINE):
        text = re.sub(r"^sha512: .*$", f"sha512: {sha512}", text, count=1, flags=re.MULTILINE)
    return text


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    manifest, files = argv[1], argv[2:]
    with open(manifest) as fh:
        text = fh.read()
    for path in files:
        name = os.path.basename(path)
        sha512, size = sha512_b64(path), os.path.getsize(path)
        text = refresh(text, name, sha512, size)
        print(f"{name}: size={size} sha512={sha512}")
    with open(manifest, "w") as fh:
        fh.write(text)


if __name__ == "__main__":
    main(sys.argv)
