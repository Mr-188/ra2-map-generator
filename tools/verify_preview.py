#!/usr/bin/env python3
"""Acceptance for the map-list preview writer (webapp/preview-pack.js).

The page embeds [Preview]/[PreviewPack] into every generated map so the game can
show a thumbnail -- and so a map never ships without the two sections that the
editor's writer always supplies.  The bytes have to be exactly what the game's
decoder expects, so this suite does not trust the writer's own idea of LZO:

  * a synthetic map with a leading comment block is patched by the real JS
    module;
  * Python parses the result as an INI map and decodes the pack with the same
    LZO implementation the other oracles use (maptools.minilzo, a real LZO1X
    decoder), then compares every BGR byte against the input;
  * [Preview]/[PreviewPack] must be the first two sections and Size must be
    the 120x60 the writer promises;
  * re-patching must be byte-identical (no duplicated sections) and must keep
    the comment block that followed the pack;
  * the dummy preview written at generation time must also decode.

Needs node and nothing from the game.  Exits non-zero on any failure.
"""
from __future__ import annotations

import base64
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE = ROOT / "webapp" / "preview-pack.js"
sys.path.insert(0, str(ROOT))

from maptools import map_ini, minilzo  # noqa: E402

W, H = 120, 60


def decode_pack(sections) -> bytes:
    pack = None
    size = None
    for name, lines in sections:
        if name.lower() == "preview":
            for line in lines:
                if line.lower().startswith("size="):
                    size = line.split("=", 1)[1].strip()
        elif name.lower() == "previewpack":
            pack = lines
    if size is None or pack is None:
        raise AssertionError("map has no [Preview]/[PreviewPack]")
    if size != f"0,0,{W},{H}":
        raise AssertionError(f"[Preview] Size is {size!r}, expected 0,0,{W},{H}")

    b64 = "".join(line.split("=", 1)[1].strip() for line in pack if "=" in line)
    b64 += "=" * ((4 - len(b64) % 4) % 4)
    data = base64.b64decode(b64)

    out = bytearray()
    off = 0
    while off + 4 <= len(data):
        clen, olen = struct.unpack_from("<HH", data, off)
        if olen == 0 or off + 4 + clen > len(data):
            break
        out += minilzo.decompress(data[off + 4:off + 4 + clen], olen)
        off += 4 + clen
    return bytes(out)


def main() -> int:
    node = shutil.which("node")
    if node is None:
        print("node not found", file=sys.stderr)
        return 2
    if not MODULE.is_file():
        print(f"missing {MODULE}", file=sys.stderr)
        return 2

    failures: list[str] = []
    work = Path(tempfile.mkdtemp(prefix="mg_preview_"))
    try:
        base = work / "base.map"
        base.write_text("; synthetic map\n; keep this comment\n[Header]\nWidth=1\n"
                        "[Basic]\nName=preview-test\n", encoding="utf-8")

        js = work / "make.mjs"
        js.write_text(f"""
import fs from 'node:fs';
import {{ buildPreviewSections, dummyPreviewSections, rgbaToBgr,
         withPreviewSections, PREVIEW_WIDTH, PREVIEW_HEIGHT }} from {json.dumps(MODULE.as_uri())};
const w = PREVIEW_WIDTH, h = PREVIEW_HEIGHT;
const rgba = new Uint8Array(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {{
  const o = (y * w + x) * 4;
  rgba[o] = x * 2 & 255; rgba[o + 1] = y * 4 & 255; rgba[o + 2] = 128; rgba[o + 3] = 255;
}}
const bgr = rgbaToBgr(rgba, w, h);
const sections = buildPreviewSections(bgr, w, h);
const base = new Uint8Array(fs.readFileSync({json.dumps(str(base))}));
fs.writeFileSync({json.dumps(str(work / 'patched.map'))}, withPreviewSections(base, sections));
fs.writeFileSync({json.dumps(str(work / 'patched2.map'))}, withPreviewSections(withPreviewSections(base, sections), sections));
fs.writeFileSync({json.dumps(str(work / 'dummy.map'))}, withPreviewSections(base, dummyPreviewSections()));
fs.writeFileSync({json.dumps(str(work / 'expected.bin'))}, bgr);
""", encoding="utf-8")

        proc = subprocess.run([node, str(js)], capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            print(proc.stdout[-2000:], proc.stderr[-2000:], file=sys.stderr)
            return 1

        expected = (work / "expected.bin").read_bytes()
        patched = map_ini.load_map(str(work / "patched.map"))
        names = [n for n, _ in patched]
        if names[:2] != ["Preview", "PreviewPack"]:
            failures.append(f"sections are {names[:3]}, expected Preview/PreviewPack first")
        decoded = decode_pack(patched)
        if len(decoded) != len(expected):
            failures.append(f"decoded {len(decoded)} bytes, expected {len(expected)}")
        elif decoded != expected:
            failures.append("decoded BGR bytes do not match the input pixels")

        if (work / "patched2.map").read_bytes() != (work / "patched.map").read_bytes():
            failures.append("re-patching is not idempotent")
        patched2 = map_ini.load_map(str(work / "patched2.map"))
        text2 = "\n".join(line for _, lines in patched2 for line in lines)
        if "; keep this comment" not in text2:
            failures.append("re-patching deleted the comment block after the pack")

        dummy = decode_pack(map_ini.load_map(str(work / "dummy.map")))
        if len(dummy) != W * H * 3:
            failures.append(f"dummy preview decodes to {len(dummy)} bytes")

        if failures:
            print("FAILED", len(failures), "check(s)", file=sys.stderr)
            for f in failures:
                print("  -", f, file=sys.stderr)
            return 1
        print(f"OK -- {1 + 3 + 1} checks, preview pack survives a real LZO decoder")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
