#!/usr/bin/env python3
"""Acceptance for the coastline's shore art: one bad stamp must not wipe the coast.

Why this suite exists.  The reference implementation chains both shore-selection
passes through one shared `ok` flag (``ok = SelectShoreTile(...)``, loop head
``if (!ok) break;``), so the FIRST shore stamp that cannot be placed stops both
passes.  For the river/lake/GrowPatch call sites that is correct -- false is the
"this water body is invalid, roll it back" switch.  ``GenerateTerrain``'s
whole-map pass (``SmoothWaterBody(0, 0)``, MapGen.cpp:854) has no rollback, so one
unplaceable stamp used to mean "the rest of the coastline gets no shore art at
all": land meets water in a bare hard staircase, with no error and no warning.

Measured on the parameters of share code ``I4I6cmf4FJg_8KUwAGA`` (TeamContinent,
180 degrees, size 46.7, 8 players, seed 2470428836, mapSeed 2214529619), the
coast's water-adjacent land cells carried a shore piece on 233 of 886 cells (26%)
before the fix and 884 of 886 (99.8%) after it.  A second, smaller reproduction
(TeamContinent, 180, size 6, 6 players, seed 424242) went from 53/878 to 874/878.

What is checked, per case:

  1. the map generates and two runs with the same parameters are byte-identical
     (red line 3 still holds);
  2. at least 95% of the water-adjacent land cells carry a shore-family tile
     (the regression that matters; 26% / 6% before the fix);
  3. the two reproduction cases really do exercise the skip path (the engine
     prints "[shore] whole-map coast pass: N stamp(s) ... skipped");
  4. symmetry 0 / left-right / top-bottom / 180-alt maps do NOT take that path
     (no such line), i.e. the port-side exception stays scoped to the whole-map
     pass and cannot quietly change ordinary maps;
  5. the 180 reproduction does not trade the missing coast for one-sided art:
     mirrored pairs where only one cell has a tile stay under a measured bound
     (768 with the fix, 1286 with the abort).  This is the "black blocks" axis
     verify_symmetry ratchets, kept here because THIS fix is what could move it.

The shore and water tile ranges come from the theater control INI the extractor
produced (build/oracle_assets/x64/Release/temperatmd.ini), never from a copy.

Usage::

    python3 tools/verify_coast.py [--mgconsole PATH] [--assets DIR]
"""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

MGCONSOLE = ROOT / "build" / "engine" / "mgconsole"
ASSETS = ROOT / "build" / "oracle_assets"

# share code I4I6cmf4FJg_8KUwAGA, field by field (webapp/sharebits.js decodeParams).
SHARE_CODE = ["--land", "2", "--time", "1", "--size", "46.7", "--players", "8",
              "--ore", "0", "--seed", "2470428836", "--map-seed", "2214529619"]

# Cases whose whole-map shore pass hits an unplaceable stamp.  The first is the
# reported share code; the second is a smaller map that failed for the same
# reason (6% coverage), kept so the test is not one exact-seed curiosity.
REPRO_CASES = (
    ("share code I4I6cmf4FJg_8KUwAGA (180, size 46.7, 8p)",
     SHARE_CODE + ["--symmetry", "2"]),
    ("180, size 6, 6p, seed 424242",
     ["--land", "2", "--size", "6", "--players", "6", "--seed", "424242",
      "--symmetry", "2"]),
)

# Same parameters, reflections that did NOT fail: the port-side exception must
# not fire here, and their coast must stay fully painted.
SAFE_CASES = (
    ("same parameters, symmetry 0", SHARE_CODE + ["--symmetry", "0"]),
    ("same parameters, left-right", SHARE_CODE + ["--symmetry", "1"]),
    ("same parameters, top-bottom", SHARE_CODE + ["--symmetry", "3"]),
    ("same parameters, 180-alt", SHARE_CODE + ["--symmetry", "4"]),
)

WARNING = "[shore] whole-map coast pass"
MIN_COVERAGE = 0.95
MIN_BOUNDARY = 300


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def rot180_cell(width: int, height: int, x: int, y: int) -> tuple[int, int]:
    """The 180-degree cell map of engine/src/mirror.h (W' + H' + p - x/y).

    p is the parity of the diagonal, and it is what makes the map a bijection of
    the sheared diamond; dropping it drops a row.
    """
    p = (x - y + width - 1) & 1
    k = width + height + p
    return (k - x, k - y)


def one_sided_pairs(cells, width: int, height: int) -> tuple[int, int]:
    """(mirrored pairs where exactly one cell has a tile, pairs counted).

    "Has a tile" is verify_symmetry's one-sided-art test (tile index 0 = bare),
    and the pairing is counted once: only the cell that sorts before its image.
    """
    n = pairs = 0
    for (x, y), t in cells.items():
        mx, my = rot180_cell(width, height, x, y)
        if (x, y) > (mx, my):
            continue
        o = cells.get((mx, my))
        if o is None:
            continue
        pairs += 1
        if (t.tile_index == 0) != (o.tile_index == 0):
            n += 1
    return n, pairs


def run(exe: Path, assets: Path, args: list[str],
        out: Path) -> subprocess.CompletedProcess:
    return subprocess.run([str(exe), "--root", str(assets), *args, "--out", str(out)],
                          capture_output=True, text=True, timeout=900)


def load_cells(path: Path):
    from maptools.map_ini import (extract_iso_pack_b64, load_map, parse_map_size)
    from maptools.iso_pack import decode_iso_map_pack
    sections = load_map(path)
    width, height = parse_map_size(sections)
    cells = {(t.rx, t.ry): t
             for t in decode_iso_map_pack(extract_iso_pack_b64(sections), width, height)}
    return width, height, cells


def coast_coverage(cells, water_lo: int, water_hi: int,
                   shore_lo: int, shore_hi: int) -> tuple[int, int]:
    """(water-adjacent land cells carrying a shore tile, water-adjacent land cells).

    A "shore stamp" is the piece's anchor cell (the family's own TileIndex); the
    art it draws may reach into neighbouring cells, but the anchor is what the
    generator places and what the abort took away, so it is the honest unit here.
    """
    boundary = covered = 0
    for (x, y), t in cells.items():
        tile = t.tile_index
        if water_lo <= tile < water_hi:
            continue
        water_neighbour = False
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = cells.get((x + dx, y + dy))
            if n is not None and water_lo <= n.tile_index < water_hi:
                water_neighbour = True
                break
        if not water_neighbour:
            continue
        boundary += 1
        if shore_lo <= tile < shore_hi:
            covered += 1
    return covered, boundary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mgconsole", default=str(MGCONSOLE))
    ap.add_argument("--assets", default=str(ASSETS))
    args = ap.parse_args()
    exe = Path(args.mgconsole)
    assets = Path(args.assets)

    theater_ini = assets / "x64" / "Release" / "temperatmd.ini"
    if not exe.is_file() or not assets.is_dir() or not theater_ini.is_file():
        print("  (no build/engine/mgconsole or build/oracle_assets; the coast "
              "check is skipped - run tools/verify_all.sh once)")
        return 0

    from maptools.tileset_names import load_tileset_ini
    ini = load_tileset_ini(str(theater_ini))

    def set_number(key: str, fallback: int) -> int:
        raw = ini.general.get(key, str(fallback))
        return int(str(raw).split(";")[0].strip() or fallback)

    def set_base(set_no: int) -> int:
        for idx, record in ini.index_map.items():
            if record[0] == set_no and record[1] == 0:
                return idx
        raise RuntimeError(f"tile set {set_no} has no TileIndex in {theater_ini.name}")

    water_set = set_number("WaterSet", 21)
    shore_set = set_number("ShorePieces", 12)
    water_lo = set_base(water_set)
    water_hi = water_lo + int(ini.sets.get(water_set, 14))
    shore_lo = set_base(shore_set)
    shore_hi = shore_lo + int(ini.sets.get(shore_set, 42))

    failures: list[str] = []
    checks = 0
    with tempfile.TemporaryDirectory(prefix="mg_coast_") as tmp:
        tmp_path = Path(tmp)

        def check_case(label: str, params: list[str], expect_warning: bool,
                       one_sided_limit: int | None = None) -> None:
            nonlocal checks
            checks += 1
            first = tmp_path / "a.yrm"
            second = tmp_path / "b.yrm"
            proc_a = run(exe, assets, params, first)
            proc_b = run(exe, assets, params, second)
            if proc_a.returncode != 0 or not first.is_file():
                failures.append(f"{label}: generation failed "
                                f"(rc={proc_a.returncode}): "
                                f"{proc_a.stderr.strip()[-300:]}")
                return

            checks += 1
            if md5(first.read_bytes()) != md5(second.read_bytes()):
                failures.append(f"{label}: two runs with the same parameters differ")

            checks += 1
            width, height, cells = load_cells(first)
            covered, boundary = coast_coverage(cells, water_lo, water_hi,
                                               shore_lo, shore_hi)
            if boundary < MIN_BOUNDARY:
                failures.append(f"{label}: only {boundary} water-adjacent land "
                                f"cells - the map did not generate as expected")
            ratio = covered / boundary if boundary else 0.0
            if ratio < MIN_COVERAGE:
                failures.append(
                    f"{label}: only {covered}/{boundary} ({ratio:.1%}) water-adjacent "
                    f"land cells carry a shore tile; the whole-map coast pass "
                    f"skipped the rest (see MapGenRiver.cpp SmoothWaterBody)")

            checks += 1
            warned = WARNING in proc_a.stderr
            if warned != expect_warning:
                if expect_warning:
                    failures.append(
                        f"{label}: expected the port's skip path to fire, but the "
                        f"engine did not report it - this case no longer reproduces "
                        f"the abort; update verify_coast.py deliberately")
                else:
                    failures.append(
                        f"{label}: the whole-map shore-skip path fired on a map that "
                        f"must keep the reference's semantics "
                        f"(stderr: {proc_a.stderr.strip()[-300:]})")

            note = ""
            if one_sided_limit is not None:
                checks += 1
                ones, pairs = one_sided_pairs(cells, width, height)
                note = f"  one-sided {ones}/{pairs}"
                if pairs < 15000:
                    failures.append(f"{label}: only {pairs} mirrored pairs - the "
                                    f"map did not decode as expected")
                elif ones > one_sided_limit:
                    failures.append(
                        f"{label}: {ones} mirrored pairs have a tile on ONE side only "
                        f"(bound {one_sided_limit}); continuing past a failed shore "
                        f"stamp must not trade the coast for one-sided art "
                        f"(abort build measured 1286, fixed build 768)")

            print(f"  {label:52s} shore {covered:4d}/{boundary:<4d} "
                  f"({ratio:5.1%})  skip-line {'yes' if warned else 'no'}  "
                  f"deterministic yes{note}")

        print(f"  water {water_lo}..{water_hi - 1}, shore {shore_lo}..{shore_hi - 1} "
              f"(from {theater_ini.name})")
        for label, params in REPRO_CASES:
            check_case(label, params, expect_warning=True,
                       one_sided_limit=900 if label.startswith("share code") else None)
        for label, params in SAFE_CASES:
            check_case(label, params, expect_warning=False)

    print()
    if failures:
        print(f"FAILED {len(failures)} checks")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("OK -- the whole-map coast pass survives an unplaceable stamp, the two "
          "reproductions paint >=95% of their coastline, and ordinary maps stay "
          "off the skip path")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
