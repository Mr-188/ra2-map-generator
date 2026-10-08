#!/usr/bin/env python3
"""Acceptance test for the Phase 2 oracle pipeline.

Proves, end to end and against the real install, that

  1. `mgextract` materialises the layout the reference implementation expects
  2. `mgconsole` -- the reference's own core linked against this repository's
     Win32 shim and console driver -- runs to completion on it
  3. the map it writes is structurally rich: it decodes with the project's own
     reader and carries more than just clear tiles
  4. the run is DETERMINISTIC: the same seed produces a byte-identical map

Point 4 is what makes the oracle usable as ground truth for the port.  Point 3
guards the failure this test exists to catch -- an empty or all-clear map, which
is what the reference produces when its `Tile资源` folder is absent.

Usage::

    sh engine/build_oracle.sh          # first
    python3 tools/verify_oracle.py
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from maptools.game_dir import find_game_dir  # noqa: E402

# Set by main() once the extraction has produced the theater control INI.
THEATER_INI_DIR: list[Path] = []

TILE_LINE = re.compile(r"^\s*(\d+)\s+(\w+)\s+(\d+)\s+(\S+)")


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def decode_families(map_path: Path) -> collections.Counter:
    # tools/decode.py is the one piece of the old Python project kept as an
    # oracle: it reads the written .map back through an independent path, which
    # is what catches "the Tile resource folder was missing, so the map is flat
    # sand" -- a failure the generator reports no error for.
    # decode.py lives under tools/, so the project root has to be on the import
    # path for its `from maptools...` imports to resolve.
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    # The theater INIs come from the extraction, not from a committed copy.
    env["MG_THEATER_DIR"] = str(THEATER_INI_DIR[0])
    proc = subprocess.run([sys.executable, str(ROOT / "tools" / "decode.py"), str(map_path)],
                          capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"decode.py failed: {proc.stderr.strip()}")
    fams: collections.Counter = collections.Counter()
    for line in proc.stdout.splitlines():
        m = TILE_LINE.match(line)
        if m:
            fams[m.group(2)] += int(m.group(3))
    return fams


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mgconsole", default=str(ROOT / "build" / "engine" / "mgconsole"))
    ap.add_argument("--mgextract", default=str(ROOT / "build" / "engine" / "mgextract"))
    ap.add_argument("--game-dir", default=None)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--theater", type=int, default=0)
    args = ap.parse_args()

    for tool in (args.mgconsole, args.mgextract):
        if not Path(tool).is_file():
            print(f"not built: {tool}\n  run: sh engine/build_oracle.sh", file=sys.stderr)
            return 2
    game = Path(args.game_dir) if args.game_dir else find_game_dir()
    if not game or not Path(game).is_dir():
        print(f"game dir not found: {game}", file=sys.stderr)
        return 2
    game = Path(game)

    failures: list[str] = []
    work = Path(tempfile.mkdtemp(prefix="mg_oracle_"))
    try:
        # ---- 1. extraction ------------------------------------------------
        proc = run([args.mgextract, "--game-dir", str(game), "--out", str(work),
                    "--theater", str(args.theater)])
        if proc.returncode != 0:
            print(proc.stdout)
            print(proc.stderr, file=sys.stderr)
            return 1
        # The decoder needs the theater control INI; take the one the extractor
        # just pulled out of the player's archives rather than a committed copy.
        THEATER_INI_DIR.clear()
        THEATER_INI_DIR.append(work / "x64" / "Release")

        tiles = list((work / "Tile资源").rglob("*.tem")) + \
                list((work / "Tile资源").rglob("*.sno"))
        print(f"  extract  {len(tiles)} theater tiles, "
              f"{sum(p.stat().st_size for p in tiles) / 1e6:.1f} MB")
        if len(tiles) < 100:
            failures.append(f"only {len(tiles)} tiles extracted")

        # ---- 2/4. run twice, same seed ------------------------------------
        maps = []
        for i in (1, 2):
            out = work / f"run{i}.map"
            proc = run([args.mgconsole, "--root", str(work), "--land", "1",
                        "--theater", str(args.theater), "--size", "1", "--players", "2",
                        "--seed", "20260913", "--out", str(out)])
            if proc.returncode != 0:
                print(proc.stdout)
                print(proc.stderr, file=sys.stderr)
                return 1
            if not out.is_file():
                failures.append(f"run {i}: mgconsole reported success but wrote no map")
                break
            maps.append(out)

        if len(maps) == 2:
            digests = [hashlib.md5(p.read_bytes()).hexdigest() for p in maps]
            print(f"  run      {maps[0].stat().st_size} B  md5={digests[0][:16]}")
            if digests[0] != digests[1]:
                failures.append(f"not deterministic: {digests[0]} vs {digests[1]}")
            else:
                print(f"  determ.  same seed, byte-identical map")

        # ---- 3. structure -------------------------------------------------
        if maps:
            fams = decode_families(maps[0])
            total = sum(fams.values())
            print(f"  decode   {total} cells: " +
                  ", ".join(f"{k}={v}" for k, v in fams.most_common()))
            if total == 0:
                failures.append("the map decoded to zero cells")
            non_clear = total - fams.get("clear", 0)
            if non_clear < total // 10:
                failures.append(
                    f"only {non_clear}/{total} cells are non-clear -- the reference "
                    f"produces this when its Tile资源 folder is missing")
            if fams.get("terrain", 0) == 0:
                failures.append("no terrain tiles (slopes/cliffs) in the output")

        print()
        if failures:
            print(f"FAILED {len(failures)} checks")
            for f in failures:
                print(f"  - {f}")
            return 1
        print("OK -- the oracle pipeline generates a rich, deterministic map")
        return 0
    finally:
        if args.keep:
            print(f"(kept {work})")
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
