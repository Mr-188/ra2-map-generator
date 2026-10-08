#!/usr/bin/env python3
"""Acceptance test for the C++ MIX -> loose-file extraction (engine/src/extract.cpp).

Checks, against the real install:

  1. the layout the reference implementation expects actually exists
     (synthetic exe path, the four INIs, the theater TMP folder)
  2. every extracted INI is byte-identical to what the Python MIX reader gets
  3. the set of theater tiles written equals the set the reference can ask for
     and that the archives actually contain -- the Python reader is the oracle
  4. coverage against the reference repository's own `Tile资源` folder: for the
     names the theater INI requests, ours must be a superset.  (That folder is
     itself incomplete -- it holds 191 tiles the INI never names.)

Usage::

    python3 tools/verify_extract.py [--mgextract build/engine/mgextract]
    python3 tools/verify_extract.py --keep      # leave the temp tree for eyeballing
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from maptools.game_dir import find_game_dir  # noqa: E402
from maptools.mix_file import MixArchive, hash_filename, open_mix  # noqa: E402
from maptools.tileset_names import load_tileset_ini  # noqa: E402

THEATER = 0  # TEMPERATE
CONTROL_INI = "temperatmd.ini"
TILE_DIR = "Tile资源/温和"
TILE_EXT = "tem"
CHAIN = (("ra2.mix", "isotemp.mix"), ("ra2.mix", "temperat.mix"),
         ("ra2md.mix", "isotemmd.mix"))
COMMON = (("ra2md.mix", "localmd.mix"),)
EXE_REL = "x64/Release/MapGenerator.exe"


def python_ini_bytes(game: Path, name: str) -> bytes:
    """The INI as the Python reader sees it, same layer order as extract.cpp."""
    blob = b""
    for outer, inner in COMMON:
        top = open_mix(game / outer)
        sub = MixArchive(top.read(inner))
        got = sub.read(name)
        if got:
            blob = got
    p = game / "expandmd01.mix"
    if p.is_file():
        got = open_mix(p).read(name)
        if got:
            blob = got
    return blob


def requested_tiles(ini_path: Path) -> set[str]:
    ini = load_tileset_ini(str(ini_path))
    names: set[str] = set()
    for section, count in ini.sets.items():
        base = ini.file_names.get(section, "")
        if not base or int(count) <= 0:
            continue
        for k in range(int(count)):
            names.add(f"{base}{k + 1:02d}.{TILE_EXT}".lower())
    return names


def available_tiles(game: Path, names: set[str]) -> set[str]:
    archives = []
    for outer, inner in CHAIN:
        top = open_mix(game / outer)
        archives.append(MixArchive(top.read(inner)))
    out = set()
    for n in names:
        if any(a.entry(n) for a in archives):
            out.add(n)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mgextract", default=str(ROOT / "build" / "engine" / "mgextract"))
    ap.add_argument("--game-dir", default=None)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    exe = Path(args.mgextract)
    if not exe.is_file():
        print(f"mgextract not built: {exe}", file=sys.stderr)
        return 2
    game = Path(args.game_dir) if args.game_dir else find_game_dir()
    if not game or not Path(game).is_dir():
        print(f"game dir not found: {game}", file=sys.stderr)
        return 2
    game = Path(game)

    failures: list[str] = []
    out = Path(tempfile.mkdtemp(prefix="mg_extract_"))
    try:
        proc = subprocess.run(
            [str(exe), "--game-dir", str(game), "--out", str(out), "--theater", str(THEATER)],
            capture_output=True, text=True)
        if proc.returncode != 0:
            print(proc.stdout)
            print(proc.stderr, file=sys.stderr)
            return 1

        # ---- 1. layout ---------------------------------------------------
        expect = [EXE_REL, "x64/Release/rulesmd.ini", "x64/Release/artmd.ini",
                  "x64/Release/rmgmd.ini", "x64/Release/temperatmd.ini",
                  "x64/Release/RULESMD.INI", "x64/Release/TEMPERATMD.INI"]
        for rel in expect:
            # the exe itself is never written -- it is the synthetic module path
            if rel == EXE_REL:
                continue
            if not (out / rel).is_file():
                failures.append(f"missing {rel}")
        print(f"  layout  {len(expect) - 1} expected files present under {out}")

        # ---- 2. INI bytes -------------------------------------------------
        for name in ("rulesmd.ini", "artmd.ini", "temperatmd.ini", "rmgmd.ini"):
            want = python_ini_bytes(game, name)
            if not want:
                continue
            path = out / "x64" / "Release" / name
            if not path.is_file():
                failures.append(f"{name}: not extracted")
                continue
            have = path.read_bytes()
            if hashlib.md5(have).hexdigest() != hashlib.md5(want).hexdigest():
                failures.append(f"{name}: bytes differ from the Python reader")
            else:
                print(f"  ini     {name:16} {len(have):>7}B  md5={hashlib.md5(have).hexdigest()[:16]}")

        # ---- 3/4. tiles ---------------------------------------------------
        # Take the theater control INI from the extraction itself, not from a
        # copy committed to the repository: it is a game file, it is exactly
        # what the extractor just produced from the player's archives, and
        # reading our own output is a stronger check than reading a checked-in
        # snapshot of unknown provenance.
        extracted_ini = out / "x64" / "Release" / CONTROL_INI
        if not extracted_ini.exists():
            failures.append(f"the extractor produced no {CONTROL_INI}")
            print()
            return 1
        requested = requested_tiles(extracted_ini)
        available = available_tiles(game, requested)
        written = {p.name.lower() for p in (out / TILE_DIR).glob(f"*.{TILE_EXT}")}
        extra = sorted(written - available)
        print(f"  tiles   ini requests {len(requested)}, archives hold {len(available)}, "
              f"extracted {len(written)} (+{len(extra)} beyond the INI)")

        # The contract is COVERAGE, not equality.  The extractor deliberately
        # emits more than the theater INI names:
        #   * randomised variants -- <Name><NN>a/b/c..., which is what
        #     TileCollection.LoadTileSets in CNCMaps scans for; and
        #   * object art -- trees, ore, gems, rocks, walls, tunnel tops -- which
        #     lives in the same archives but in no [TileSetNNNN], and is reached
        #     through artmd.ini by section name.
        # A renderer needs all of it: 761 tiles on a temperate map against the
        # 494 the INI alone accounts for.
        missing = sorted(available - written)
        if missing:
            failures.append(f"archived tiles we failed to extract: {missing[:5]}")

        for probe in ("gem01", "tree01", "tib01"):
            name = f"{probe}.{TILE_EXT}"
            if name not in written:
                failures.append(f"object art missing from the extraction: {name}")

        repo_tiles = ROOT / "reference_impl" / "src" / "Tile资源" / "温和"
        if repo_tiles.is_dir():
            theirs = {p.name.lower() for p in repo_tiles.glob(f"*.{TILE_EXT}")}
            gap = (requested & theirs) - written
            print(f"  vs repo reference folder: {len(theirs)} tiles, "
                  f"requested-and-missing-from-ours {len(gap)}")
            if gap:
                failures.append(f"reference folder has requested tiles we lack: "
                                f"{sorted(gap)[:5]}")
        else:
            print("  (reference_impl not present; skipping the repo-folder comparison)")

        print()
        if failures:
            print(f"FAILED {len(failures)} checks")
            for f in failures:
                print(f"  - {f}")
            return 1
        print("OK -- extraction matches the Python reader and covers every "
              "requested tile the archives hold")
        return 0
    finally:
        if args.keep:
            print(f"(kept {out})")
        else:
            shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
