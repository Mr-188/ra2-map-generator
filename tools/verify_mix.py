#!/usr/bin/env python3
"""Byte-for-byte verification of the C++ MIX layer against the Python reader.

The C++ reader in ``engine/`` was written from ``maptools/mix_file.py`` as its
spec.  This script is the acceptance test for that layer: it drives both sides
over the same real game archives and compares

  1. header facts  -- signature / encrypted / numFiles / dataStart
  2. filename hashes
  3. extracted bytes -- size AND md5, for files reached through nested archives

Anything the Python side cannot parse is skipped rather than reported, so a
green run means "the C++ side agrees wherever the verified side has an answer".

Usage::

    python3 tools/verify_mix.py                 # uses the detected game dir
    python3 tools/verify_mix.py --game-dir PATH
    python3 tools/verify_mix.py --mixinfo build/engine/mixinfo

Exit status is 0 only when every comparison passes.
"""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from maptools.game_dir import find_game_dir  # noqa: E402
from maptools.mix_file import MixArchive, hash_filename, open_mix  # noqa: E402

# (outer archive, inner member, file) triples the generator actually needs.
# Established against the retail install; see docs/external_mapgenerator_yaoyaojiang.md.
LAYERED_TARGETS = (
    ("ra2md.mix", "localmd.mix", "rulesmd.ini"),
    ("ra2md.mix", "localmd.mix", "artmd.ini"),
    ("ra2md.mix", "localmd.mix", "temperatmd.ini"),
    ("ra2md.mix", "localmd.mix", "rmgmd.ini"),
    ("ra2.mix", "cache.mix", "temperat.pal"),
)

HEADER_TARGETS = (
    "ra2.mix", "ra2md.mix", "language.mix", "langmd.mix", "expandmd01.mix",
)

HASH_TARGETS = (
    "rulesmd.ini", "artmd.ini", "temperatmd.ini", "rmgmd.ini", "temperat.pal",
    "localmd.mix", "cache.mix", "local mix database.dat",
    # Deliberately absent: the negative control.  The C++ side must agree with
    # Python here too, and a lookup for it must find nothing.
    "zzz_definitely_absent_xyz.ini",
)


def run(cmd: list[str]) -> tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode, (proc.stdout + proc.stderr)


def parse_info(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            out[key.strip()] = value.strip()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-dir", default=None)
    ap.add_argument("--mixinfo", default=str(ROOT / "build" / "engine" / "mixinfo"))
    args = ap.parse_args()

    mixinfo = Path(args.mixinfo)
    if not mixinfo.is_file():
        print(f"mixinfo not built: {mixinfo}", file=sys.stderr)
        print("  build it with: g++ -std=c++17 -O2 -Iengine/src -o build/engine/mixinfo "
              "engine/src/blowfish.cpp engine/src/mix.cpp engine/tools/mixinfo.cpp",
              file=sys.stderr)
        return 2

    game = Path(args.game_dir) if args.game_dir else find_game_dir()
    if not game or not Path(game).is_dir():
        print(f"game dir not found: {game}", file=sys.stderr)
        return 2
    game = Path(game)

    failures: list[str] = []
    checks = 0

    # ---- 1. header facts -------------------------------------------------
    for name in HEADER_TARGETS:
        path = game / name
        if not path.is_file():
            continue
        rc, text = run([str(mixinfo), "info", str(path)])
        if rc != 0:
            failures.append(f"{name}: mixinfo info failed: {text.strip()}")
            continue
        got = parse_info(text)

        data = path.read_bytes()
        try:
            num, data_size, _entries, data_start, sig, enc, _hdr = _python_header(data)
        except Exception as exc:  # pragma: no cover - defensive
            print(f"  skip {name}: python reader refused ({type(exc).__name__})")
            continue

        for label, want, have in (
            ("signature", f"0x{sig:08X}", got.get("signature")),
            ("encrypted", "1" if enc else "0", got.get("encrypted")),
            ("numFiles", str(num), got.get("numFiles")),
            ("dataStart", str(data_start), got.get("dataStart")),
        ):
            checks += 1
            if want != have:
                failures.append(f"{name}: {label} python={want} cpp={have}")
        print(f"  header {name:18} numFiles={got.get('numFiles'):>4} dataStart={got.get('dataStart')}")

    # ---- 2. filename hashes ---------------------------------------------
    for name in HASH_TARGETS:
        rc, text = run([str(mixinfo), "hash", name])
        want = "0x%08X" % hash_filename(name)
        have = text.strip()
        checks += 1
        if rc != 0 or want != have:
            failures.append(f"hash {name}: python={want} cpp={have}")
    print(f"  hashes  {len(HASH_TARGETS)} names compared (incl. 1 negative control)")

    # ---- 3. extracted bytes through nested archives ----------------------
    tmp = ROOT / "build" / "verify_mix"
    tmp.mkdir(parents=True, exist_ok=True)
    for outer, inner, name in LAYERED_TARGETS:
        outer_path = game / outer
        if not outer_path.is_file():
            continue
        try:
            top = open_mix(outer_path)
            sub = MixArchive(top.read(inner))
            want = sub.read(name)
        except Exception as exc:
            print(f"  skip {outer}:{inner}:{name}: python reader refused ({type(exc).__name__})")
            continue
        if not want:
            continue

        out = tmp / name
        rc, text = run([str(mixinfo), "layered", str(outer_path), inner, name, str(out)])
        checks += 1
        if rc != 0:
            failures.append(f"{outer}:{inner}:{name}: mixinfo failed: {text.strip()}")
            continue
        have = out.read_bytes()
        want_md5 = hashlib.md5(want).hexdigest()
        have_md5 = hashlib.md5(have).hexdigest()
        if len(want) != len(have) or want_md5 != have_md5:
            failures.append(
                f"{outer}:{inner}:{name}: python {len(want)}B/{want_md5} "
                f"cpp {len(have)}B/{have_md5}")
            continue
        print(f"  bytes  {outer}:{inner}:{name:16} {len(have):>8}B  md5={have_md5[:16]}")

    # ---- negative control: a name that must NOT resolve -------------------
    rc, text = run([str(mixinfo), "layered", str(game / "ra2md.mix"), "localmd.mix",
                    "zzz_definitely_absent_xyz.ini", str(tmp / "absent.bin")])
    checks += 1
    if rc == 0:
        failures.append("negative control: an absent member was reported as extracted")

    print()
    if failures:
        print(f"FAILED {len(failures)} of {checks} checks")
        for line in failures:
            print(f"  - {line}")
        return 1
    print(f"OK -- {checks} checks, C++ MIX layer matches the Python reader")
    return 0


def _python_header(data: bytes):
    """Thin wrapper so the import surface stays in one place."""
    from maptools.mix_file import parse_mix_header

    return parse_mix_header(data[: 1 << 22])


if __name__ == "__main__":
    raise SystemExit(main())
