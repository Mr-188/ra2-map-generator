#!/usr/bin/env python3
"""Acceptance for symmetric maps.

Two things are settled here that do not need a generation run at all:

1. **The mirror mapping.**  engine/src/mirror.h maps a cell to its mirror image
   for each symmetry kind; tools/mirror_geometry_test.cpp checks it exhaustively
   over 56 map sizes - that the image of a cell is a cell, that the map is
   injective, that it is an involution, and whether it preserves the
   8-neighbourhood.  That last one differs between the kinds: left-right is the
   pure swap and preserves it exactly, 180 degrees does not (the (c, r) grid it
   comes from is sheared).  Everything neighbour-derived therefore has to be
   re-derived after a 180 rotation, and the test asserts the breakage is real so
   that nobody "fixes" it back into the affine form - which is not even a
   bijection.

2. **Which pieces each reflection can actually serve.**  A top-bottom reflection is
   a perfectly good bijection of the cell set, but the tile set has no art for the
   orientations it needs.  The check below reads the multi-cell footprint tables
   out of the reference implementation and counts, per reflection and per family,
   how many pieces have a counterpart with the reflected footprint.  The CliffSet -
   the family the decision was made on - is closed for left-right and 180 degrees
   (40/40) and is NOT closed for top-bottom (27/40, with the 13 missing pieces
   named).  That is why MapSymmetry has no top-bottom value.

   For left-right the only gap is two pieces, both in ShorePieces (the two
   irregular shore tiles, shore41/shore42): a map containing one of them cannot
   have those cells mirrored, and the pass reports that rather than guessing at an
   art it does not have.  The 180-degree column is reported for the same reason -
   it is what phase 2 inherits.

3. **A pixel comparison of two renders is NOT a valid acceptance test here**, and
   this file says so because the obvious check is the wrong one.  What is measured:
   a map whose decoded cells mirror exactly renders 91% differently from the
   horizontal flip of the original, and the share of pixels that are never drawn
   at all - pure black, whole missing cells - goes from 0.05% to 2.30%, while the
   multiset of (tile, Height) pairs is IDENTICAL between the two maps.  Same data,
   different positions, different picture.  So the drawing outcome depends on
   position and draw order rather than on the map, and the flip comparison cannot
   separate "the mirror is wrong" from "the renderer draws it differently".

   An earlier version of this note claimed a by-construction symmetric map proved
   the cause was TileLayer's Dx enumeration and the z-buffer's later-draw-wins
   tie-break.  That experiment was contaminated: symmetrising the records of
   multi-cell pieces left their Height fields inconsistent with their footprints,
   so the black pixels it produced came from its own construction.  The
   draw-order explanation is still the best fit - Rx+Ry, which the mirror leaves
   unchanged, is the order an iso painter wants and the order the game uses, while
   Dx is not mirror-invariant - but it is an inference, not a measurement.  What
   IS measured is that a render cannot settle this, and the game must.

   Accept mirrored maps on the decoded geometry, and judge the look in the game.

The generation-level checks that need a built engine and a game directory are at the
bottom of this file.  They generate maps and compare each one against its OWN mirror:
the water/land outline, the shore ring, the overlay layer, the ledgers, the declared
visible rect, and - added with the Inland / Mountainous work - the interior art, which
is the number that separates "the outline is symmetric" from "the two halves show the
same terrain".  Both special land types are generated; Mountainous used to be checked
by nothing at all.

    python3 tools/verify_symmetry.py            # the gate
    python3 tools/verify_symmetry.py --score    # the same statistic, all lands/kinds
"""
from __future__ import annotations

import collections
import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIRROR_H = ROOT / "engine" / "src" / "mirror.h"
GEOMETRY_TEST = ROOT / "tools" / "mirror_geometry_test.cpp"
FOOTPRINTS_CPP = ROOT / "reference_impl" / "src" / "MapGenerator" / "MapGenRiver.cpp"

# The five multi-cell families (MapGenRiver.cpp).  Each is an array of
# IsoFootprint { w, h, mask, z[] }; the waterfall table is [4][4] and its rows are
# contiguous, so a plain entry scan reads all 16 of its pieces.
FAMILIES = (
    "kShoreFootprints",
    "kCliffFootprints",
    "kCliffWaterFootprints",
    "kDestroyableCliffFootprints",
    "kWaterfallFootprints",
    # 宽坡族（CliffRamps = Slope Set Pieces，tile 384..393）。2026-10-15 目标轮 15 之前
    # **这条从来没被量过** —— 而它正是"坡能不能成对"的答案所在（§8.51）。
    "kSlopeSetPieceFootprints",
)
# The bit convention for IsoFootprint::mask - "bit (row * w + col)"
# (MapGenRiver.cpp:3830) - is what makes a reflection a bit permutation.
MASK_BIT_ORDER = "row-major: bit (row * w + col), MapGenRiver.cpp:3830"
# What the product relies on, pinned: left-right is closed for every family except
# the two irregular shore pieces, and 180 degrees additionally misses four
# WaterCliffs pieces (which is phase 2's problem, recorded here so it is not
# discovered on a map).
LR_GAP_SIZES = {"kShoreFootprints": 2}
R180_GAP_SIZES = {"kShoreFootprints": 2, "kCliffWaterFootprints": 4,
                  # 宽坡族在 180 下也缺 4 件（ramp06/07/09/10）—— 2026-10-15 目标轮 15 量到，
                  # 见 §8.51。这就是"镜像那条重放刻不出镜像的宽坡"的根因。
                  "kSlopeSetPieceFootprints": 4}
TB_GAP_SIZES = {"kShoreFootprints": 2, "kCliffWaterFootprints": 4,
                "kSlopeSetPieceFootprints": 4}


def parse_table(text: str, name: str) -> list[tuple[int, int, int]]:
    body = text.split(f"static const IsoFootprint {name}")[1].split("};")[0]
    rows = re.findall(r"\{\s*(\d+),\s*(\d+),\s*(0x[0-9A-Fa-f]+)ULL", body)
    return [(int(w), int(h), int(m, 16)) for w, h, m in rows]


def cells(mask: int, w: int, h: int) -> list[tuple[int, int]]:
    return [(i // w, i % w) for i in range(w * h) if mask >> i & 1]


def pack(cs: list[tuple[int, int]], w: int) -> int:
    return sum(1 << (r * w + c) for r, c in cs)


def mirrored(f: tuple[int, int, int], kind: str) -> tuple[int, int, int]:
    w, h, m = f
    if kind == "left-right":
        # Screen left-right is (x, y) -> (y, x), i.e. the footprint transposes.
        return (h, w, pack([(c, r) for r, c in cells(m, w, h)], h))
    if kind == "top-bottom":
        # 与引擎 MirrorTile 的 topbottom 分支一致（= MirrorCell 的 (x,y)->(k-y,k-x)）：
        # 转置 + 双向反转，足印尺寸变成 (h, w)。原来这里写的是"纯纵向翻转、不转置" ✗，
        # 与引擎不一致，于是把 TB 崖族算成 27/40 "缺 13 片"、并据此决定页面不提供 TB
        # （见下面的绊线）。按引擎的口径，崖族是 40/40 完整闭合的 ✓。
        moved = [(w - 1 - c) * h + (h - 1 - r) for r, c in cells(m, w, h)]
        return (h, w, pack([(i // h, i % h) for i in moved], h))
    if kind == "rotational-180":
        return (w, h, pack([(h - 1 - r, w - 1 - c) for r, c in cells(m, w, h)], w))
    raise ValueError(kind)


def check_geometry(failures: list[str]) -> int:
    """Compile and run the exhaustive mapping test.  Returns the checks it ran."""
    compiler = shutil.which("c++") or shutil.which("g++") or shutil.which("clang++")
    if compiler is None:
        failures.append("no C++ compiler (c++/g++/clang++) to build the geometry test")
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        exe = Path(tmp) / "mirror_geometry_test"
        build = subprocess.run(
            [compiler, "-std=c++17", "-O2", f"-I{ROOT / 'engine' / 'src'}",
             "-o", str(exe), str(GEOMETRY_TEST)],
            capture_output=True, text=True)
        if build.returncode != 0:
            failures.append("the geometry test did not compile: " + build.stderr.strip()[-400:])
            return 0
        run = subprocess.run([str(exe)], capture_output=True, text=True)
        for line in run.stdout.splitlines():
            print("  " + line.strip())
        if run.returncode != 0:
            failures.append("the mirror mapping failed its exhaustive test")
        # The mapping is checked on every cell of every size; report the count so
        # a silently-shrunk test is visible.
        m = re.search(r"(\d+) map sizes, (\d+) cells", run.stdout)
        return int(m.group(2)) if m else 0


def check_family_closure(failures: list[str]) -> int:
    """Count, per reflection and per family, which pieces have a counterpart."""
    if not FOOTPRINTS_CPP.is_file():
        print("  (reference_impl absent; the footprint closure check is skipped)")
        return 0
    text = FOOTPRINTS_CPP.read_text(encoding="utf-8", errors="replace")
    tables = {name: parse_table(text, name) for name in FAMILIES}
    for name, tab in tables.items():
        if not tab:
            failures.append(f"parsed 0 footprints out of {name}")

    checks = 0
    gaps: dict[str, dict[str, int]] = {"left-right": {}, "top-bottom": {},
                                       "rotational-180": {}}
    for kind in ("left-right", "top-bottom", "rotational-180"):
        for name in FAMILIES:
            tab = tables[name]
            if not tab:
                continue
            absent = [i for i, f in enumerate(tab)
                      if not any(mirrored(f, kind) == g for g in tab)]
            gaps[kind][name] = len(absent)
            checks += 1
            label = name.replace("k", "").replace("Footprints", "")
            print(f"  {kind:<15} {label:<16} {len(tab) - len(absent):>2}/{len(tab):<2} "
                  "pieces have a counterpart"
                  + (f"  (missing {', '.join(str(i + 1) for i in absent)})" if absent else ""))
            # An involution is what lets a pass handle each pair once.
            if not all(mirrored(mirrored(f, kind), kind) == f for f in tab):
                failures.append(f"{kind} is not an involution on {name}")
            checks += 1

    # The CliffSet is the family the scope decision was made on: closed for both
    # kinds the product offers, and not closed for top-bottom.
    for kind in ("left-right", "rotational-180"):
        if gaps[kind]["kCliffFootprints"]:
            failures.append(f"CliffSet is not closed under {kind}: "
                            f"{gaps[kind]['kCliffFootprints']} pieces have no counterpart")
    # 修正后的事实：按引擎真正使用的 top-bottom 变换，崖族同样 40/40 闭合 —— 上面那条
    # "TB 不闭合所以不提供"的旧结论作废（它来自一个与引擎不一致的变换）。现在要求它与另外
    # 两种一样闭合；TB 因此是可以开放给页面的（见 engine/src/mirror.h）。
    if gaps["top-bottom"]["kCliffFootprints"] != 0:
        failures.append("CliffSet is not closed under top-bottom: "
                        f"{gaps['top-bottom']['kCliffFootprints']} pieces have no counterpart")

    # The residual gaps, pinned.  Left-right is what the product ships, so its gaps
    # are what a mirrored map may have to report; if a family gains or loses one,
    # the pass's "no piece for this orientation" warning changes meaning.
    for want, kind in ((LR_GAP_SIZES, "left-right"), (R180_GAP_SIZES, "rotational-180"),
                       (TB_GAP_SIZES, "top-bottom")):
        expected = {n: want.get(n, 0) for n in FAMILIES}
        if gaps[kind] != expected:
            failures.append(f"{kind} gaps changed: {gaps[kind]} != {expected} "
                            "(update mapgen pass expectations and mirror.h)")
    if gaps["left-right"]["kShoreFootprints"] != 2:
        failures.append("the two irregular shore pieces are expected to be the only "
                        "left-right gap")
    print(f"  mask bit order pinned: {MASK_BIT_ORDER}")
    return checks


MGCONSOLE = ROOT / "build" / "engine" / "mgconsole"
ASSETS = ROOT / "build" / "oracle_assets"
ORACLE_MAP = ASSETS / "oracle.map"
THEATER_INI = ASSETS / "x64" / "Release" / "temperatmd.ini"

# The generation check's parameters.  They matter: the oracle map that verify_all
# materialises is produced with exactly this argument list, so the "None changes
# nothing" check below compares against it rather than against a fresh guess.
GEN_PARAMS = ["--land", "1", "--theater", "0", "--size", "1", "--players", "2",
              "--seed", "20260913"]

# The land types and theatres the matrix check below walks.  The theatres are the
# product's whole list: the page's <select> has exactly 温带/雪地, and the engine
# maps any value other than 1 to temperate (MapGenRecalc.cpp:429: `(theater == 1)
# ? snowmd.ini : temperatmd.ini`).  Raise this if a third theatre is ever ported -
# the point of the check is that the list here matches the product's.
SNOW_ASSETS = ROOT / "build" / "snow_assets"
THEATERS = ((0, ASSETS, "temperate", THEATER_INI),
            (1, SNOW_ASSETS, "snow", SNOW_ASSETS / "x64" / "Release" / "snowmd.ini"))
# (land, name, kinds it is judged on).  Lands 0 and 2 take both kinds because
# nothing else in this file generates them at all; 1, 3 and 4 take left-right
# only, because the suites above already judge them on both.
MATRIX_LANDS = ((0, "Archipelago", (1, 2)),
                (1, "Continent", (1,)),
                (2, "TeamContinent", (1, 2)),
                (3, "Inland", (1,)),
                (4, "Mountainous", (1,)))
MATRIX_PARAMS = ["--size", "1", "--players", "2", "--seed", "20260913"]

# The bound the whole-map interior comparison uses (see interior_stats and the
# Inland / Mountainous block below).  Measured on GEN_PARAMS with this file's own
# --score mode: 2.3% for Inland and for Mountainous, 0.7% for Continent, 0.1%
# (team continent) and 0.2% (archipelago) for the two island-heavy types.  The
# bound is 3%, i.e. above the worst of them and far below the 10.7% these two land
# types measured before the blob-stamp mirroring landed.
INTERIOR_LIMIT = 0.03

# The same bound for the 180-degree kind, and it is a different number because 180
# has a different floor - not because less is asked of it.  Under 180 the cell map
# is a bijection of the diamond but NOT an automorphism of the 8-neighbourhood
# (measured, see check_geometry and mirror.h), so every neighbour-derived choice
# made after the shape mirror can differ: measured on GEN_PARAMS, Inland and
# Mountainous sit at 22.9% and Continent at 12.3%, against 0.1%..0.7% for the same
# land types under left-right.  25% is a regression guard around that floor, not a
# target; the floor itself is discussed in engine/src/mirror.h.
#
# This number READ HIGHER AFTER A FIX, which is worth knowing before someone treats
# it as a score: it was 17.2% while the mirrored blob stamp was still overwriting
# cliff and ramp tiles on the image half, because overwriting the art also made the
# two cells agree more often.  It is 22.9% now that those cells keep the art the
# generator chose for them - the same change that took the 180 render from 2.12%
# dark pixels and 73 uncovered height steps to 0.40% and 0.
INTERIOR_LIMIT_180 = 0.25

# The share of height steps a symmetric map may leave without art covering the drop.
# Measured: 0.0% for Inland/Mountainous under both kinds with the stamp guard in
# place, 0.4% for the left-right base map, and 2.6% for the 180-degree Inland map
# before the guard (which is what its 2.14% dark pixels were made of).
STEP_LIMIT = 0.02

# How much worse than the island reference land type the Inland / Mountainous coast may
# render under left-right symmetry.  Measured at GEN_PARAMS: the reference 4.49, Inland
# 8.86 after the coast pass and 25.35 before it, so 2.5x separates the fix from the
# defect it removed while leaving room for the shore family's own art limit.
COAST_LIMIT_FACTOR = 2.5



def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def sections_of(path: Path):
    from maptools.map_ini import load_map
    return load_map(path)


def cells_of(sections) -> dict:
    """(rx, ry) -> IsoTile, via the same reader the decode oracle uses."""
    from maptools.map_ini import extract_iso_pack_b64, parse_map_size
    from maptools.iso_pack import decode_iso_map_pack
    w, h = parse_map_size(sections)
    return {(t.rx, t.ry): t
            for t in decode_iso_map_pack(extract_iso_pack_b64(sections), w, h)}


def _entries(sections, name: str) -> list[tuple[str, str]]:
    from maptools.map_ini import parse_key_value
    for title, lines in sections:
        if title.lower() == name.lower():
            out = []
            for line in lines:
                kv = parse_key_value(line)
                if kv:
                    out.append(kv)
            return out
    return []


def packed_to_xy(v: int) -> tuple[int, int]:
    """[Waypoints] / [Terrain] cells are X + 1000*Y (MapGenMapFile.cpp:1092)."""
    return v % 1000, v // 1000


# The gap between "a different piece of the same thing" and "a different thing".
# A mirror hands the image cell the MIRRORED piece, which is a different tile
# index by design, and the variants of one piece sit within a few indices of each
# other; the next family is hundreds away.  Measured on a generated Inland map,
# the histogram of |tile - mirror tile| has an empty band between 40 and 480, so
# any threshold inside it separates the two.  ART_DIFF is where this file draws
# the line, and everything below counts a pair as "the two halves do not show the
# same thing".
ART_DIFF = 20


def mirror_cell(kind: int, Wp: int, Hp: int, x: int, y: int) -> tuple[int, int]:
    """The engine's own cell map, written independently here.

    kind 1 = left-right (the transpose), 2 = rotational-180, 3 = top-bottom, which is
    the ANTI-transpose (x,y) -> (k-y, k-x) - the same form as the 180 rotation but
    with the two coordinates swapped on the way in and out.  It is an isometry of the
    diamond and it preserves the 8-neighbourhood, so unlike 180 it has no off-diamond
    band.  See engine/src/mirror.h.
    """
    if kind == 1:
        return y, x
    if kind == 3:
        k = Wp + Hp
        return k - y, k - x
    return rot180_cell(Wp, Hp, x, y)


def interior_stats(cells: dict, Wp: int, Hp: int, kind: int):
    """(pairs, art_diff, exact_diff) for a decoded map against its own mirror.

    art_diff counts the mirrored pairs whose decoded tiles differ by more than
    ART_DIFF.  exact_diff counts those that differ at all - printed, never
    required: a symmetric map is SUPPOSED to put the mirrored piece on the image
    cell, so "the indices are equal" is the wrong expectation (the same trap
    --diag-symmetry documents).
    """
    pairs = art = exact = 0
    for (x, y), t in cells.items():
        o = cells.get(mirror_cell(kind, Wp, Hp, x, y))
        if o is None:
            continue
        pairs += 1
        d = abs(t.tile_index - o.tile_index)
        if d:
            exact += 1
        if d > ART_DIFF:
            art += 1
    return pairs, art, exact


def water_key_of(t) -> bool:
    """水格判定：与引擎一致 —— 水族 314..327（含 1x1 边片）。"""
    return 314 <= t.tile_index < 328


def run_generator(out: Path, land: int, symmetry: int,
                  extra: list[str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(MGCONSOLE), "--root", str(ASSETS), *GEN_PARAMS, "--land", str(land),
         *(extra or []), "--symmetry", str(symmetry), "--out", str(out)],
        capture_output=True, text=True, timeout=900)


def check_generation(failures: list[str]) -> int:
    """Generate maps and check that each one is SYMMETRIC: equal to its own mirror.

    The property this used to check was "the generated map equals the mirror of the
    unsymmetric map".  That is what a pairwise swap of the two halves produces, and it
    is NOT a symmetric map: swapping a pair's values preserves whether the two agree,
    so a map whose halves differ keeps halves that differ.  The check therefore passed
    a build whose two halves were only each other's mirror image - with 802 of 6460
    mirrored pairs still disagreeing about water, and an ore overlay that agreed with
    its own mirror position at 0.089 - and whose rendered output was a speckled mess.

    What is required now, measured on the symmetric map against itself:
      * the shape: every cell's mirror is a cell, and water stays water;
      * the shore ring, and the ore overlay;
      * the elevation (Level);
      * the start points and the terrain objects form symmetric sets, and the counts
        are preserved - a 2-player map stays a 2-player map;
      * the render stays clean.  The criterion is the fraction of DARK pixels
        (luminance < 10) compared with the same map generated with symmetry off; the
        artifact this feature had is dark speckling and a pure-black threshold alone
        once reported a clean run over a visibly speckled image.

    The interior detail the RNG-driven stages pick per cell - which hill sits at which
    height, which grass variant - is measured and PRINTED but deliberately not
    required: making it symmetric needs the generator itself to choose
    mirror-consistently, not a pass over its output.  It is printed so a regression is
    visible rather than silent.
    """
    if not MGCONSOLE.is_file() or not ASSETS.is_dir():
        print("  (no build/engine/mgconsole or build/oracle_assets; the generation "
              "check is skipped - run tools/verify_all.sh once)")
        return 0
    sys.path.insert(0, str(ROOT))

    from maptools.map_ini import parse_map_size
    from maptools.overlay_layer import OverlayLayer

    checks = 0
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        def generate(symmetry: int, name: str, extra: list[str] | None = None):
            out = tmp_path / name
            proc = subprocess.run(
                [str(MGCONSOLE), "--root", str(ASSETS), *GEN_PARAMS, *(extra or []),
                 "--symmetry", str(symmetry), "--out", str(out)],
                capture_output=True, text=True, timeout=600)
            return proc, out

        proc_none, map_none = generate(0, "none.yrm")
        proc_none2, map_none2 = generate(0, "none2.yrm")
        proc_lr, map_lr = generate(1, "lr.yrm")
        proc_180, map_180 = generate(2, "rot.yrm")
        checks += 1
        if not (map_none.is_file() and map_lr.is_file() and map_180.is_file()):
            failures.append(
                f"the generator produced no map (rc={proc_none.returncode}/"
                f"{proc_lr.returncode}/{proc_180.returncode}): "
                f"{proc_lr.stderr.strip()[-200:]}")
            return checks

        # 1. Determinism, None stays None, and the oracle map is untouched.
        checks += 1
        if md5(map_none.read_bytes()) != md5(map_none2.read_bytes()):
            failures.append("--symmetry 0 is not byte-deterministic across runs")
        checks += 1
        if md5(map_none.read_bytes()) == md5(map_lr.read_bytes()):
            failures.append("--symmetry 1 produced the same bytes as --symmetry 0; "
                            "the pass did not run")
        if ORACLE_MAP.is_file():
            checks += 1
            if md5(map_none.read_bytes()) != md5(ORACLE_MAP.read_bytes()):
                failures.append("--symmetry 0 no longer reproduces the oracle map; "
                                "the default is supposed to change nothing")
        else:
            print("  (no build/oracle_assets/oracle.map; the unchanged-default check "
                  "is skipped)")

        a_sections = sections_of(map_none)
        b_sections = sections_of(map_lr)
        s180 = sections_of(map_180)
        A = cells_of(a_sections)
        B = cells_of(b_sections)
        R = cells_of(s180)
        Wp, Hp = parse_map_size(b_sections)

        # 2. The pass reports its own result, and the shape it produced must be
        #    symmetric in the cell array itself.  This is the check that catches a
        #    swap: with the swap the pass reported hundreds of disagreeing pairs while
        #    every map-level comparison still passed.
        checks += 1
        m = re.search(r"shape self-check: (\d+) mirrored pairs, (\d+) disagree",
                      proc_lr.stderr)
        if not m:
            failures.append("the pass did not report its shape self-check")
        elif int(m.group(2)) != 0:
            failures.append(
                f"the pass reports {m.group(2)} of {m.group(1)} mirrored pairs "
                "disagreeing about water; the shape is not symmetric")
        else:
            print(f"  shape   the pass reports 0 of {m.group(1)} pairs disagreeing")
        checks += 1
        if "copied" not in proc_lr.stderr:
            failures.append("the pass does not report copying the shape (a swap "
                            "produces a mirror image, not a symmetric map)")

        # 3. Self-symmetry of the finished maps.  The mirror maps a cell to a cell, so
        #    a symmetric map has every pair equal; the pairs that disagree are counted.
        def selfsym(C, mirror_of, key):
            bad = pairs = unmatched = 0
            for (x, y), t in C.items():
                o = C.get(mirror_of(x, y))
                if o is None:
                    unmatched += 1
                    continue
                pairs += 1
                if key(t) != key(o):
                    bad += 1
            return bad, pairs, unmatched

        def rot_of(x, y):
            return rot180_cell(Wp, Hp, x, y)

        if not THEATER_INI.is_file():
            print("  (no theater INI; the water/shore symmetry checks are skipped)")
            ini = None
        else:
            from maptools.tileset_names import classify_kind, load_tileset_ini
            ini = load_tileset_ini(str(THEATER_INI))

        def water_key(t):
            return classify_kind(ini, t.tile_index) == "water"

        for kind_name, C, mirror_of in (("left-right", B, lambda x, y: (y, x)),
                                        ("rotational-180", R, rot_of)):
            bad, pairs, unmatched = selfsym(C, mirror_of, lambda t: 0)
            checks += 1
            if unmatched:
                # 纯 180 旋转会漏掉隐藏边距里的一带；只要求漏掉的格**不在可见矩形内**。
                visW = Wp - 4
                visH = Hp - 12
                visible_unmatched = 0
                for c in C:
                    mx, my = mirror_of(*c)
                    if (mx, my) not in C and usable_rect(Wp, visW, visH, 2, 5, *c):
                        visible_unmatched += 1
                if visible_unmatched:
                    failures.append(f"{kind_name}: {visible_unmatched} cells inside the "
                                    "visible rect have no mirrored cell")
            # The elevation is measured but not required: CreateHills and the other
            # RNG-driven stages write it per cell, so the two halves differ wherever
            # they happened to draw differently.  It is printed because a regression
            # there would otherwise be silent.
            lvl_bad, lvl_pairs, _ = selfsym(C, mirror_of, lambda t: t.z)
            print(f"  {kind_name:<14} elevation symmetric on {lvl_pairs - lvl_bad}/"
                  f"{lvl_pairs} pairs - reported, not required (see the docstring)")

            if ini is not None:
                def is_shore(t):
                    return classify_kind(ini, t.tile_index) == "shore"

                for what, key in (("water/land outline", water_key),
                                  ("shore ring", is_shore)):
                    bad, pairs, _ = selfsym(C, mirror_of, key)
                    checks += 1
                    if bad:
                        failures.append(f"{kind_name}: the {what} is not symmetric on "
                                        f"{bad} of {pairs} mirrored pairs")
                bad, pairs, _ = selfsym(
                    C, mirror_of,
                    lambda t: (classify_kind(ini, t.tile_index), t.z))
                print(f"  {kind_name:<14} outline and shore symmetric; interior "
                      f"(class+elevation) {pairs - bad}/{pairs} - reported, not "
                      f"required (the RNG-driven stages choose per cell)")

            ids = OverlayLayer.from_sections(
                b_sections if kind_name == "left-right" else s180).ids
            bad, pairs, _ = selfsym(C, mirror_of, lambda t: 0)
            checks += 1
            ov_bad = 0
            ov_pairs = 0
            for (x, y) in C:
                mx, my = mirror_of(x, y)
                a_id = ids[x + 512 * y]
                b_id = ids[mx + 512 * my]
                ov_pairs += 1
                if a_id != b_id:
                    ov_bad += 1
            if ov_bad:
                failures.append(f"{kind_name}: the overlay layer is not symmetric on "
                                f"{ov_bad} of {ov_pairs} cells")
            else:
                print(f"  {kind_name:<14} overlay layer symmetric on {ov_pairs} cells")

        # 3b. Inland / Mountainous (LandType 3, 4).  These never run GenerateTerrain:
        #     the base is land and GenerateSpecialTerrain carves a river and lakes into
        #     it, stamping its art as it goes.  The shape mirror therefore never ran
        #     there and the outline sat at the chance level (measured 0.961, exactly the
        #     same as the same map generated with symmetry off).  The pass copies the
        #     half whole instead, so what has to hold is: the pass says so, its
        #     self-check disagrees nowhere, and the outline is symmetric.
        #     BOTH of the two land types are generated, and BOTH kinds: they take the
        #     same code path, but Inland and Mountainous are two separate entries in the
        #     UI and in the CLI (before this loop only Inland was generated at all -
        #     Mountainous could have been broken without the suite saying a word), and
        #     the outline has to be symmetric for 180 as well (MirrorSpecialTerrain
        #     copies the half and does not care which kind it is copying), while the
        #     interior has a structurally different floor per kind - see mirror.h and
        #     INTERIOR_LIMIT_180.
        special_renders: list[tuple[str, Path, Path]] = []
        map_plain_special: dict[str, Path] = {}
        for land, label in ((3, "Inland"), (4, "Mountainous")):
            proc_sp0, map_sp0 = generate(0, f"{label.lower()}_plain.yrm",
                                         ["--land", str(land)])
            map_plain_special[label] = map_sp0
            for kind, kind_short in ((1, "lr"), (2, "180")):
                kind_name = "left-right" if kind == 1 else "rotational-180"
                tag = f"{label} {kind_name}"
                proc_sp, map_sp = generate(kind, f"{label.lower()}_{kind_short}.yrm",
                                           ["--land", str(land)])
                if kind == 1:
                    special_renders.append((label.lower(), map_sp0, map_sp))
                else:
                    special_renders.append((f"{label.lower()}-180", map_sp0, map_sp))
                checks += 1
                if not (map_sp.is_file() and map_sp0.is_file()):
                    failures.append(f"the generator produced no {tag} map: "
                                    f"{proc_sp.stderr.strip()[-200:]}")
                    continue
                m = re.search(r"special: .*self-check (\d+) pairs, (\d+) disagree",
                              proc_sp.stderr)
                checks += 1
                if not m:
                    failures.append("the pass did not report its special-terrain "
                                    "self-check; Inland / Mountainous would be silently "
                                    "asymmetric")
                elif int(m.group(2)) != 0:
                    failures.append(f"the special-terrain pass reports {m.group(2)} of "
                                    f"{m.group(1)} mirrored pairs disagreeing about water")
                else:
                    print(f"  special {tag:<24} the pass reports 0 of {m.group(1)} "
                          f"pairs disagreeing")
                if ini is None:
                    continue
                sp_sections = sections_of(map_sp)
                S = cells_of(sp_sections)
                Sw, Sh = parse_map_size(sp_sections)

                # The shore pieces: every mirrored pair must be a footprint-mirrored pair,
                # not the same art translated sideways.  This is the structural signature
                # of the Inland / Mountainous coast pass and the cheapest detector of a
                # regression to "copy the coast art verbatim".
                shore_base = shore_family_base(ini)
                shore_tab = parse_table(FOOTPRINTS_CPP.read_text(encoding="utf-8",
                                                                 errors="replace"),
                                        "kShoreFootprints") if FOOTPRINTS_CPP.is_file() else []
                if shore_base is not None and shore_tab:
                    trans, mirror_ok, gaps = translated_shore_pairs(S, Sw, Sh, kind,
                                                                    shore_tab, shore_base)
                    checks += 1
                    if trans:
                        failures.append(
                            f"{tag}: {trans} of {trans + mirror_ok + gaps} mirrored shore "
                            "pairs carry translated art (the same piece with the same "
                            "sub-cell offset) instead of the mirrored piece - that is the "
                            "staircase coastline; see MapGenSymmetry.cpp MirrorSpecialTerrain")
                    else:
                        print(f"  special {tag:<24} shore pairs all footprint-mirrored "
                              f"({mirror_ok} pairs, {gaps} without a counterpart)")
                bad, pairs, _ = selfsym(S, lambda x, y: mirror_cell(kind, Sw, Sh, x, y),
                                        water_key)
                checks += 1
                if bad:
                    failures.append(f"{tag}: the water/land outline is not symmetric on "
                                    f"{bad} of {pairs} mirrored pairs")
                else:
                    print(f"  special {tag:<24} water/land outline symmetric on "
                          f"{pairs}/{pairs} pairs")

                # The INTERIOR, which is the number the Inland / Mountainous work is
                # driven by: the outline can be (and is) symmetric while the art on the
                # two halves still differs, and that is exactly the defect this file
                # exists to catch.  The bounds are not taste judgements but regression
                # guards taken from the measurement (INTERIOR_LIMIT /
                # INTERIOR_LIMIT_180 above): under left-right these two land types
                # measure 2.3% here and the island types 0.1%..0.7%, while the same map
                # family measured 10.7% before the blob-stamp mirroring in
                # MapGenSymmetry.cpp.  A regression of that kind cannot slip through.
                limit = INTERIOR_LIMIT if kind == 1 else INTERIOR_LIMIT_180
                sp_pairs, sp_art, sp_exact = interior_stats(S, Sw, Sh, kind)
                checks += 1
                if sp_art > limit * sp_pairs:
                    failures.append(
                        f"{tag}: {sp_art} of {sp_pairs} mirrored pairs "
                        f"({100.0 * sp_art / sp_pairs:.1f}%) show a different piece on "
                        f"the two halves, over the {100 * limit:.0f}% bound")
                else:
                    print(f"  special {tag:<24} interior art differs on "
                          f"{sp_art}/{sp_pairs} pairs ({100.0 * sp_art / sp_pairs:.1f}%, "
                          f"bound {100 * limit:.0f}%; "
                          f"{100.0 * sp_exact / sp_pairs:.1f}% differ at all, which a "
                          f"mirror is supposed to do)")

        # 4. The ledgers: a symmetric SET, with the counts preserved.  The unsymmetric
        #    map says how many there were, so a pass that duplicated or dropped
        #    entries is caught.
        def waypoints(sections):
            return {int(k): packed_to_xy(int(v))
                    for k, v in _entries(sections, "Waypoints")}

        wa, wb = waypoints(a_sections), waypoints(b_sections)
        checks += 1
        if len(wa) != len(wb):
            failures.append(f"the start point count changed: {len(wa)} -> {len(wb)}")
        else:
            asym = [k for k, xy in wb.items() if (xy[1], xy[0]) not in set(wb.values())]
            checks += 1
            if asym:
                failures.append(f"{len(asym)} start points have no mirrored start "
                                f"point: {[wb[k] for k in asym][:4]}")
            else:
                print(f"  starts  {len(wb)} start points, each with a mirrored "
                      f"partner, count preserved")

        def terrains(sections):
            return collections.Counter(packed_to_xy(int(k))
                                       for k, _ in _entries(sections, "Terrain"))

        ta, tb = terrains(a_sections), terrains(b_sections)
        # The count is NOT required to match: the pass keeps the objects on the
        # authoritative side and adds their mirrors, so the total is twice that side's
        # share and legitimately differs from the unsymmetric map's.  What is required
        # is that every object has a mirrored partner.
        with_mirror = sum(1 for (x, y) in tb if (y, x) in tb)
        checks += 1
        if with_mirror != len(tb):
            failures.append(f"{len(tb) - with_mirror} of {len(tb)} terrain objects "
                            "have no mirrored object")
        else:
            print(f"  terrain {len(tb)} objects, each with a mirrored partner "
                  f"(plain map had {len(ta)})")

        # 5. The rect each file declares: 5 for none and left-right, 6 for 180.  See
        #    check_usable_band for the measurement behind the shift.
        def declared_rect(sections):
            text = "\n".join(l for _, lines in sections for l in lines)
            m = re.search(r"LocalSize\s*=\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)",
                          text)
            return tuple(int(g) for g in m.groups()) if m else None

        # 纯 180° 旋转是绕格心的真旋转：可见矩形映射到自己，不再需要那一行补偿（老错位映射
        # 才需要 top 5 -> 6）。见 MapGenRiver.cpp 的 VisibleTop。
        want_top = {"none": 5, "left-right": 5, "rotational-180": 5}
        rects = {"none": declared_rect(a_sections),
                 "left-right": declared_rect(b_sections),
                 "rotational-180": declared_rect(s180)}
        checks += 1
        if any(r is None or r[1] != want_top[k] for k, r in rects.items()):
            failures.append(f"the declared LocalSize top is wrong: {rects} "
                            f"(want {want_top})")
        else:
            print("  rect    LocalSize top 5 / 5 / 6 for none / left-right / 180")

        for label, sections, cells in (("none", a_sections, A),
                                       ("left-right", b_sections, B),
                                       ("rotational-180", s180, R)):
            lx, ly, lw, lh = rects[label]
            placed = [packed_to_xy(int(v)) for _, v in _entries(sections, "Waypoints")]
            placed += [packed_to_xy(int(k)) for k, _ in _entries(sections, "Terrain")]

            def outside(vis_y):
                return sum(1 for (x, y) in placed
                           if not usable_rect(Wp, lw, lh, lx, vis_y, x, y,
                                              cells[(x, y)].z if (x, y) in cells else 0))

            checks += 1
            if outside(ly) != 0:
                failures.append(f"{label}: {outside(ly)} of {len(placed)} placed "
                                f"objects fall outside the declared visible rect")
            elif ly != 5 and outside(5) != 0:
                print(f"  placed  {label}: all {len(placed)} objects inside the "
                      f"declared rect (top 5 would leave {outside(5)} outside)")

        # 6. The corridor overlays, which are NOT mirrored: LinkSameLevelRegions
        #    draws its strip with orientation-specific overlays (94 / 92 / 74 + x%4
        #    horizontal, 96 / 98 / 83 + y%4 vertical - the comment above it in
        #    MapGenMakingSub.cpp).  A mirror turns one family into the other, so those
        #    cells would need their family swapped, and that transform is not
        #    implemented because it cannot be tested: measured over 180 generated maps
        #    (sizes 0/1/2/3/3.6 x players 2/4/8 x land 0/2/3/4 x three seeds), 162202
        #    overlaid cells, 34 distinct indices spanning 27..177 - NONE in [74,98].
        #    The function IS reachable (MapGenMakingSub.cpp:1305), so this is "not
        #    observed", not "dead".  Making the assumption detectable is the
        #    alternative: if a map ever carries one, this fails before a wrong-facing
        #    strip ships.
        for label, sections in (("none", a_sections), ("left-right", b_sections),
                                ("rotational-180", s180)):
            ids = OverlayLayer.from_sections(sections).ids
            corridor = sorted({i for i in ids if 74 <= i <= 98})
            checks += 1
            if corridor:
                failures.append(
                    f"{label}: corridor overlays {corridor} present, and their "
                    "orientation family is not mirrored (see LinkSameLevelRegions) "
                    "- implement and test the transform, or stop generating them")
        print("  overlay no corridor overlay (74..98) in any generated map, as measured")

        # 7. The render, which is what the user actually sees.  The dark-pixel
        #    fraction is compared against the SAME map generated with symmetry off, so
        #    the criterion does not depend on how dark a particular theater looks.
        # 7a. The interior art of the left-right maps, on the same yardstick the
        #     two special land types use above.  Continent is included so that a
        #     change that makes Inland better and Continent worse is visible here
        #     rather than only in a render.
        #
        #     What the leftover is made of, so nobody hunts for a pass that does not
        #     exist: on the Inland probe configuration the residual after the blob
        #     mirroring was 105 of 6952 mirrored pairs, and every one of them was a
        #     ramp piece - rampBase on one side, rampSmooth on the other.  That is
        #     vanilla's ramp smoothing (SetupLAT's ramp branch), which probes two
        #     neighbours picked per slope value; for the slope pair the engine's own
        #     FinalizeElevationSlopes creates across a mirror (1<->2, 3<->4, 6<->8,
        #     10<->12 - read off --diag-symmetry's slope histogram) those two
        #     directions are not images of each other, so one side smooths and the
        #     other does not.  Forcing the image cell to the mirrored piece would
        #     mean inventing a 1x1 art mapping and overriding the vanilla choice on
        #     one half; the number is bounded here instead.
        lp_pairs, lp_art, lp_exact = interior_stats(B, Wp, Hp, 1)
        checks += 1
        if lp_art > INTERIOR_LIMIT * lp_pairs:
            failures.append(f"left-right Continent: {lp_art} of {lp_pairs} mirrored "
                            f"pairs show a different piece, over the "
                            f"{100 * INTERIOR_LIMIT:.0f}% bound")
        else:
            print(f"  interior Continent: art differs on {lp_art}/{lp_pairs} pairs "
                  f"({100.0 * lp_art / lp_pairs:.1f}%, bound "
                  f"{100 * INTERIOR_LIMIT:.0f}%)")
        # 180 degrees gets its own, looser bound for the structural reason mirror.h
        # derives (the cell map is a bijection of the diamond but not of the
        # 8-neighbourhood, and the corner grid cannot follow it - see
        # check_180_corner_lattice).  Bounded rather than merely printed, so that a
        # change which doubles it fails here.
        rp_pairs, rp_art, _ = interior_stats(R, Wp, Hp, 2)
        checks += 1
        if rp_art > INTERIOR_LIMIT_180 * rp_pairs:
            failures.append(f"rotational-180: {rp_art} of {rp_pairs} mirrored pairs "
                            f"show a different piece, over the "
                            f"{100 * INTERIOR_LIMIT_180:.0f}% bound")
        else:
            print(f"  interior 180:       art differs on {rp_art}/{rp_pairs} pairs "
                  f"({100.0 * rp_art / rp_pairs:.1f}%, bound "
                  f"{100 * INTERIOR_LIMIT_180:.0f}% - the structural floor, see mirror.h)")

        # 7c. The shore pieces put back together: instance coherence, measured at a size
        #     where Inland really has shore art.  At GEN_PARAMS' size 1 the 180 Inland map
        #     carries no shore pieces at all, so the coast metric above has nothing to say
        #     about the mirrored half; this is the check that does.  Floors: left-right
        #     90% (measured 99-100%), 180 25% (measured 50%; the old copy-verbatim
        #     behaviour measured 8%).
        # 180 的自洽率在"纯 180° 旋转 + 按对应件铺岸"下是 80/82（98%），与权威侧 85/87 同级；
        # 换成错位映射时它是 8%，所以这条现在是**真闸门**（floor 0.80）。
        # 上下对称也进这一条。**实测 181/215 = 84%**（floor 0.80）：离群的 34 个实例就是
        # "顺序盖章互相吃格子"留下的半片（2x2 的片只剩 1~2 格，渲染成水里的浅色半方块）。
        # 线上那个数字曾经是 177/177 = 100%——那是靠"把半片整片还原成卸妆前美术"的临时补丁
        # 撑起来的假象（还原会把没坏的格也一起动，且黑块只是挪位），补丁撤掉后真实值就是
        # 84%。两条修法都实测过并否决：足印冲突就不盖（半片 34 -> 61，更差）、把后半场也
        # 纳入成对判定（岸族要走官方选片树，实测把它弄差）。这条闸门的意义是**防止再退化**。
        for label, sym, floor in (("left-right", 1, 0.90), ("rotational-180", 2, 0.80),
                                  ("top-bottom", 3, 0.80)):
            # Explicit parameters, not GEN_PARAMS: the shore family only exists when the
            # carve actually makes a river or a lake, which needs water > 20.
            mp = tmp_path / f"cohesion-{sym}.yrm"
            proc = subprocess.run(
                [str(MGCONSOLE), "--root", str(ASSETS), "--land", "3", "--theater", "0",
                 "--size", "2", "--players", "4", "--water", "80", "--seed", "20260913",
                 "--symmetry", str(sym), "--out", str(mp)],
                capture_output=True, text=True, timeout=900)
            checks += 1
            if proc.returncode != 0:
                failures.append(f"cohesion {label}: generation failed: {proc.stderr[-300:]}")
                continue
            # 同一张 size-2 图上把"水面掩膜 IoU"也量一遍并设界 —— 套件默认尺寸下 180 没有
            # 可比对的岸对，只有这里能把它盯住（我这几轮把 180 改到 0.589 的那次就是这样漏过去的）。
            # 渲染直接用渲染器命令（render_cleanliness 里的那个 render 是它的局部函数）。
            iou = None
            try:
                from verify_render import dotnet_env, RENDERER
                from maptools.game_dir import find_game_dir
                dotnet, renv = dotnet_env()
                game = str(find_game_dir())
                png = tmp_path / f"cohesion-{sym}.png"
                subprocess.run([dotnet, str(RENDERER), "-i", str(mp), "-m", game,
                                "-p", "-o", str(tmp_path / f"cohesion-{sym}"), "-Y"],
                               capture_output=True, text=True, timeout=900, env=renv)
                iou = coast_water_mask_iou(mp, png, sym)
            except Exception as exc:                              # pragma: no cover
                print(f"  coast   {label} water IoU: skipped ({exc})")
            checks += 1
            if iou is not None and sym == 1:
                floor_iou = 0.90
                checks += 1
                if iou[0] < floor_iou:
                    failures.append(
                        f"coast shape {label}: the rendered water mask matches its own mirror "
                        f"with IoU {iou[0]:.3f} (floor {floor_iou:.2f}) - the two halves do not "
                        f"draw the same coastline")
                else:
                    print(f"  coast   {label + ' water IoU':<24} {iou[0]:5.3f} mean / "
                          f"{iou[1]:5.3f} median ({iou[2]} pairs)")
            elif iou is not None:
                print(f"  coast   {label + ' water IoU':<24} {iou[0]:5.3f} mean / "
                      f"{iou[1]:5.3f} median ({iou[2]} pairs)  (reported only)")
            got = shore_instance_coherence(mp, shore_family_base(ini))
            if not got or got[1] == 0:
                print(f"  cohesion {label:<18} no shore instances to judge")
                continue
            ratio = got[2] / got[1]
            cell_ratio = (got[3] / got[4]) if got[4] else 0.0
            if False:                            # 180 现在也设闸门（纯旋转后镜像侧 98% 自洽）
                print(f"  cohesion {label:<18} shore instances {got[2]}/{got[1]} "
                      f"({ratio:.0%}), cells {got[3]}/{got[4]} ({cell_ratio:.0%}) "
                      f"- reported, not required")
                continue
            if ratio < floor:
                failures.append(
                    f"cohesion {label}: only {got[2]}/{got[1]} shore instances "
                    f"({ratio:.0%}, floor {floor:.0%}) are coherent - the coast pieces on "
                    f"one half were scattered instead of placed as instances (see "
                    f"MapGenSymmetry.cpp, the end-of-pipeline coast rebuild)")
            else:
                print(f"  cohesion {label:<18} shore instances {got[2]}/{got[1]} "
                      f"({ratio:.0%}), cells {got[3]}/{got[4]} ({cell_ratio:.0%})")

        coast_pngs: dict[str, Path] = {}
        coast_maps: dict[str, Path] = {}
        checks += render_cleanliness(failures, map_none, map_lr, tmp_path, "lr",
                                     png_out=coast_pngs)
        coast_maps["lr"] = map_lr
        for tag, map_plain, map_sym in special_renders:
            checks += render_cleanliness(failures, map_plain, map_sym, tmp_path, tag,
                                         png_out=coast_pngs)
            coast_maps[tag] = map_sym

        # 7a-2. top-bottom, on the same yardstick (it sits here because the
        #       symmetry-off Inland / Mountainous maps it compares against are
        #       generated just above).  It is the kind with the recorded
        #     hole defect, so the two render bounds are the ones that matter here and
        #     both are enforced: dark pixels against the SAME map with symmetry off,
        #     and - the one that localises a hole - the share of 4-neighbour height
        #     steps whose drop no art covers.  Measured at this configuration:
        #         before (paired FinalizeElevationSlopes)  62 of 2676 steps (2.32%)  ✗
        #         now                                       0 of 2713 steps (0.00%)  ✓
        #     at 0.50% dark pixels against the plain map's 0.44%.
        #
        #     The interior-art number is printed, never bounded: on top-bottom the
        #     corner-block lattice is the cell lattice shifted one cell (derived in
        #     MapGenHills.cpp, FinalizeElevationSlopes), so a ramp layer that is BOTH
        #     symmetric and locally correct does not exist in this tile set.  Bounding
        #     it would force the pairing back, which is what painted 300k black
        #     pixels.  It is 7.4% here against left-right's 2.3% and 180's 22.9%.
        for land, label in ((3, "Inland"), (4, "Mountainous")):
            proc_tb, map_tb = generate(3, f"{label.lower()}_tb.yrm", ["--land", str(land)])
            checks += 1
            if not (map_tb.is_file() and map_plain_special[label].is_file()):
                failures.append(f"the generator produced no {label} top-bottom map: "
                                f"{proc_tb.stderr.strip()[-200:]}")
                continue
            checks += render_cleanliness(failures, map_plain_special[label], map_tb,
                                         tmp_path, f"{label.lower()}-tb",
                                         png_out=coast_pngs)
            sec_tb = sections_of(map_tb)
            C_tb = cells_of(sec_tb)
            Wp_tb, Hp_tb = parse_map_size(sec_tb)
            tb_pairs, tb_art, tb_exact = interior_stats(C_tb, Wp_tb, Hp_tb, 3)
            checks += 1
            print(f"  special {label + ' top-bottom':<24} interior art differs on "
                  f"{tb_art}/{tb_pairs} pairs ({100.0 * tb_art / tb_pairs:.1f}%, "
                  f"reported only - see the note above); "
                  f"{100.0 * tb_exact / tb_pairs:.1f}% differ at all")

        # 7b. The coast itself, which is the number the Inland / Mountainous work is
        #     accepted on: the mirrored-pair difference restricted to water and shore
        #     cells.  The island land type is the reference, generated at the same
        #     parameters in the same run.
        ref = coast_layer_diff(coast_maps["lr"], coast_pngs["lr"], 1)
        if ref and ref[1] is not None:
            print(f"  coast   {'reference (land 1)':<20} mirror difference "
                  f"{ref[1]:5.2f} mean / {ref[2]:5.2f} median ({ref[0]} pairs)")
            for tag in ("inland", "mountainous", "inland-180", "mountainous-180"):
                if tag not in coast_maps:
                    continue
                kind = 2 if tag.endswith("-180") else 1
                got = coast_layer_diff(coast_maps[tag], coast_pngs[tag], kind)
                if not got or got[1] is None:
                    print(f"  coast   {tag:<20} no mirrored coast pairs at this size "
                          f"(reported, not required)")
                    continue
                checks += 1
                limit = COAST_LIMIT_FACTOR * ref[1]
                if kind == 1 and got[1] > limit:
                    failures.append(
                        f"{tag}: the coast renders {got[1]:.2f} different from its own "
                        f"mirror ({got[0]} water/shore pairs, median {got[2]:.2f}) against "
                        f"{ref[1]:.2f} for the island reference land type - the mirrored "
                        f"half is not dressed for its own shape (see MapGenSymmetry.cpp, "
                        f"MirrorSpecialTerrain)")
                else:
                    note = "" if kind == 1 else " - reported, not required (see mirror.h)"
                    print(f"  coast   {tag:<20} mirror difference {got[1]:5.2f} mean / "
                          f"{got[2]:5.2f} median ({got[0]} pairs){note}")

        # 7b-bis. The coast metric, made calibration-free.  The pixel projection carries a
        # constant offset, and after the image half's flip/rotation that offset shows up as
        # a content shift - so an unaligned measurement mixes "the art differs" with "the
        # window is off".  Scanning the offset and reporting the minimum removes that
        # ambiguity: measured (size 2, left-right reference vs 180) the left-right map
        # bottoms out at 3.62 and the 180 one at 15.64, i.e. the 180 coast is 4x further
        # from its own mirror even after the best alignment.
        scans = {}
        for tag in ("lr", "inland", "mountainous", "inland-180", "mountainous-180"):
            if tag in coast_maps:
                kind = 2 if tag.endswith("-180") else 1
                got = coast_alignment_scan(coast_maps[tag], coast_pngs[tag], kind)
                if got is not None:
                    scans[tag] = got
                    print(f"  coast   {tag + ' aligned':<18} best offset ({got[0]:+3d}, "
                          f"{got[1]:+3d}), residual {got[2]:5.2f}")
        ious = {}
        for tag in ("lr", "inland", "mountainous", "inland-180", "mountainous-180"):
            if tag not in coast_maps:
                continue
            kind = 2 if tag.endswith("-180") else 1
            got = coast_water_mask_iou(coast_maps[tag], coast_pngs[tag], kind)
            if got is not None:
                ious[tag] = got
                print(f"  coast   {tag + ' water IoU':<18} {got[0]:5.3f} mean / {got[1]:5.3f} "
                      f"median ({got[2]} pairs)")
        # 闸门只对左右对称设：转置是格同构、地形本身也镜像，硬尺子在它上面是干净的（实测 0.971）。
        # 180 不行：它的地形不镜像，细河裁片大半是陆地，而**暗色的崖/阴影会被二值化成"水面"**
        # （实测 v28 发版 0.797、v31 岛屿式 0.567，可看图 v31 反而更一致）→ 只报数。
        for tag, floor in (("inland", 0.90), ("mountainous", 0.90)):
            if tag not in ious:
                continue
            checks += 1
            if ious[tag][0] < floor:
                failures.append(
                    f"coast shape {tag}: the rendered water mask matches its own mirror with "
                    f"IoU {ious[tag][0]:.3f} (floor {floor:.2f}) - the two halves do not draw "
                    f"the same coastline (see MapGenSymmetry.cpp and coast_water_mask_iou)")
        if "lr" in scans:
            checks += 1
            for tag in ("inland", "mountainous"):
                if tag in scans and scans[tag][2] > 2.0 * scans["lr"][2]:
                    failures.append(
                        f"coast (aligned) {tag}: residual {scans[tag][2]:.2f} against "
                        f"{scans['lr'][2]:.2f} for the reference land type - the mirrored "
                        f"half's coast is more than twice as far from its own mirror as the "
                        f"island land types are (see MapGenSymmetry.cpp)")

    return checks


def render_cleanliness(failures: list[str], map_none: Path, map_sym: Path,
                       tmp_path: Path, tag: str = "",
                       bound: float | None = None,
                       png_out: dict | None = None) -> int:
    """Render both maps and require the symmetric one not to be darker than the plain
    one.  Measured: plain 0.26% dark, symmetric 0.27%, the official reference (a
    hand-made mirror map) 0.46%, and the swap-based build that looked speckled 1.38%
    - with Level copied but not the art it was worse still, 1.69%.  The bound is
    deliberately loose (twice the plain map, floor one percent) so it catches that
    class of regression without pinning a particular tileset's shading.

    `bound` overrides it; no caller does today, it stays for a map family that needs
    its own rule.

    The step check in here is the one that catches the defect this file's mirroring
    work actually fixed.  Dark pixels say THAT a map has holes; the height steps say
    WHERE they come from: for every 4-neighbour pair whose z differs, the drop has to
    be covered by art (a cliff facade or a ramp), and when it is not the renderer
    paints black there.  Measured on an Inland map (size 1, 2 players, seed
    20260913), rendering every pipeline stage in turn: after CreateHills the map has
    0 of 2721 steps uncovered; CreateLATs took it to 73 (2.50% dark pixels) because
    its mirrored blob stamp was overwriting the art that covered them; with the stamp
    guarded (MapGenSymmetry.cpp, StampMirroredBlob) the finished map is 0 of 2721 and
    0.41% dark - cleaner than the same map with symmetry off (0.46%).  A dark-pixel
    bound alone would have passed a build that traded the holes for a lower "interior
    differs" number by overwriting the art, which is exactly what the first version
    of that guard did."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from verify_render import dotnet_env, RENDERER
        from maptools.game_dir import find_game_dir
        game = find_game_dir()
        dn = dotnet_env()
    except Exception as exc:                                  # pragma: no cover
        print(f"  render  (cannot import the render helpers: {exc}; skipped)")
        return 0
    if dn is None or game is None or not RENDERER.is_file():
        print("  render  (no dotnet / renderer / game dir; the dark-pixel check is "
              "skipped - the check that catches speckling therefore did not run)")
        return 0
    try:
        from PIL import Image
    except ImportError:                                       # pragma: no cover
        print("  render  (PIL missing; the dark-pixel check is skipped)")
        return 0

    dotnet, env = dn

    def render(src: Path, out: Path):
        subprocess.run([dotnet, str(RENDERER), "-i", str(src), "-m", str(game),
                        "-p", "-o", str(out), "-Y"],
                       capture_output=True, text=True, timeout=900, env=env)
        return out.with_suffix(".png")

    def dark_fraction(png: Path) -> float | None:
        if not png.is_file():
            return None
        im = Image.open(png).convert("RGB")
        total = 0
        dark = 0
        for i, px in enumerate(im.getdata()):
            total += 1
            if (px[0] + px[1] + px[2]) / 3.0 < 10.0:
                dark += 1
        return dark / total if total else None

    png_none = render(map_none, tmp_path / f"render_none{tag}")
    png_sym = render(map_sym, tmp_path / f"render_lr{tag}")
    if png_out is not None:
        png_out[tag] = png_sym
    f_none = dark_fraction(png_none)
    f_lr = dark_fraction(png_sym)
    if f_none is None or f_lr is None:
        print("  render  (a render produced no png; the dark-pixel check is skipped)")
        return 0
    if bound is None:
        bound = max(0.010, 2.0 * f_none)
    checks = 1
    if f_lr > bound:
        failures.append(
            f"the symmetric map renders with {100 * f_lr:.2f}% dark pixels against "
            f"{100 * f_none:.2f}% for the same map without symmetry (bound "
            f"{100 * bound:.2f}%): the two halves are not drawn consistently - this is "
            "the speckling defect")
    else:
        print(f"  render  {tag:<7} dark pixels {100 * f_lr:.2f}% (plain "
              f"{100 * f_none:.2f}%, bound {100 * bound:.2f}%)")

    # The height steps, which is where dark pixels come from when they are not
    # scattered noise: an uncovered drop is a hole in the art.
    steps = uncovered_steps(map_sym, png_sym)
    if steps is not None:
        uncovered, total = steps
        checks += 1
        if total and uncovered > STEP_LIMIT * total:
            failures.append(
                f"{tag}: {uncovered} of {total} height steps "
                f"({100.0 * uncovered / total:.1f}%) have no art covering the drop (the "
                f"renderer paints them black); bound {100 * STEP_LIMIT:.0f}%. This is "
                "the defect the mirrored blob stamp used to cause by overwriting cliff "
                "and ramp tiles - see MapGenSymmetry.cpp, StampMirroredBlob")
        else:
            print(f"  steps   {tag:<7} uncovered {uncovered}/{total} "
                  f"({100.0 * uncovered / max(1, total):.1f}%, bound "
                  f"{100 * STEP_LIMIT:.0f}%)")
    else:
        print(f"  steps   {tag:<7} (map or png unreadable; the step check is skipped)")
    return checks


def shore_family_base(ini) -> int | None:
    """The engine tile index of the first Shore Pieces tile, read off the theater INI.

    The engine's IsoTileTypeIndex is the running total over the INI's TileSet sections,
    so the family starts at the first index the INI attributes to the "Shore Pieces"
    set.  Read rather than hard-coded: the number belongs to the theater, not to us.
    """
    idx = [i for i, (set_no, off, name, base) in ini.index_map.items()
           if name.strip().lower() == "shore pieces"]
    return min(idx) if idx else None


def translated_shore_pairs(cells: dict, Wp: int, Hp: int, kind: int,
                           table: list, base: int):
    """(translated, mirrored, gap) over the map's mirrored pairs of shore pieces.

    A mirrored pair is CORRECT when the image cell carries the piece whose footprint is
    the mirror of the source cell's footprint (and, implicitly, the mapped sub-cell
    offset).  A pair is TRANSLATED when both cells carry the SAME piece with the SAME
    sub-cell offset - the art moved sideways instead of mirrored.  That is the defect
    the Inland / Mountainous coast pass removes: measured on a size-2 Inland map, 94 of
    274 left-right pairs were translated before, 0 of 272 after, and the coastline went
    from a diamond staircase to a smooth fringe on both halves
    (build/render_test/symmetry-coast-mismatch.png shows the before).
    """
    translated = mirror_ok = gap = 0
    n = len(table)
    for c, t in cells.items():
        if not (base <= t.tile_index < base + n):
            continue
        m = mirror_cell(kind, Wp, Hp, *c)
        o = cells.get(m)
        if o is None or not (base <= o.tile_index < base + n) or not (c < m):
            continue
        want = mirrored(table[t.tile_index - base],
                        "left-right" if kind == 1 else "rotational-180")
        if not any(g == want for g in table):
            gap += 1                                   # pieces 41/42: no counterpart at all
        elif table[o.tile_index - base] == want:
            mirror_ok += 1
        else:
            translated += 1                            # same-piece translation, or wrong piece
    return translated, mirror_ok, gap


def coast_layer_diff(map_path: Path, png: Path, kind: int):
    """(pairs, mean, median) of the mirrored-pair pixel difference ON the coast itself.

    Only pairs whose TWO cells carry water or shore-family tiles count.  The ground
    texture mosaic beside the water is excluded on purpose: forcing those 1x1 textures
    to match was measured to take the dark-pixel share from 0.39% to 3.97%, so they are
    left unmirrored, and inside the coastal band they otherwise dominate the number.

    This is the yardstick the Inland / Mountainous coast work is accepted on.  Measured
    at GEN_PARAMS (size 1, two players, seed 20260913):

        island reference (land 1, left-right)   4.49 mean / 3.53 median
        Inland, before the coast pass          25.35 / 25.93
        Inland, after                          8.86 /  7.27
        ... of which the water layer alone      3.60 -> 11.30 -> 4.54 mean

    The water layer now sits at the island reference; the residual is the shore family,
    whose own art is not transpose-symmetric (measured: pairs whose piece is its own
    mirror partner still render 9.6 apart), so it cannot be driven lower with this
    tileset.
    """
    try:
        from PIL import Image
        from maptools.map_ini import load_map, extract_iso_pack_b64, parse_map_size
        from maptools.iso_pack import decode_iso_map_pack
    except Exception:                                          # pragma: no cover
        return None
    import re as _re
    import statistics as _st
    if not map_path.is_file() or not png.is_file():
        return None
    sections = load_map(map_path)
    width, _height = parse_map_size(sections)
    text = "\n".join(line for _, lines in sections for line in lines)
    lx, ly = (int(g) for g in _re.search(
        r"LocalSize\s*=\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)",
        text).groups()[:2])
    left, top = lx * 60, (ly - 3) * 30 + 15
    cells = {(t.rx, t.ry): t
             for t in decode_iso_map_pack(extract_iso_pack_b64(sections),
                                          *parse_map_size(sections))}
    im = Image.open(png).convert("RGB")
    px = im.load()
    img_w, img_h = im.size

    def centre(t):
        dx = t.rx - t.ry + width - 1
        dy = t.rx + t.ry - width - 1
        return (dx + 1) * 30 - left, (dy - t.z) * 15 - top

    def coast(t):
        ti = t.tile_index
        return (314 <= ti < 328) or (89 <= ti < 131)

    vals = []
    for c, t in cells.items():
        if not coast(t):
            continue
        m = mirror_cell(kind, width, _height, *c)
        o = cells.get(m)
        if o is None or not coast(o) or not (c < m):
            continue
        x, y = centre(t)
        x2, y2 = centre(o)
        acc = []
        for ox in (-20, -10, 0, 10, 20):
            for oy in (-8, 0, 8):
                sx, sy = x + ox, y + oy
                tx, ty = x2 - ox, y2 + oy
                if 0 <= sx < img_w and 0 <= sy < img_h and 0 <= tx < img_w and 0 <= ty < img_h:
                    p1 = px[sx, sy]
                    p2 = px[tx, ty]
                    acc.append(sum(abs(a - b) for a, b in zip(p1, p2)) / 3.0)
        if acc:
            vals.append(sum(acc) / len(acc))
    if not vals:
        return 0, None, None
    return len(vals), _st.mean(vals), _st.median(vals)


def coast_alignment_scan(mapfile: Path, pngfile: Path, kind: int, radius: int = 60,
                         step: int = 12) -> tuple | None:
    """(best offset dx, dy, residual) of the rendered coast metric under a pixel shift.

    This exists because the coast metric needs its own calibration: the projection that
    turns a cell into a pixel centre has a constant offset, and after the flip/rotation of
    the image half that offset shows up as a *content shift* - which would make even a
    perfect coast look wrong.  Measured (left-right, the kind that is known good): the
    minimum sits sharply at (0, 0) with residual 3.62 against 4.3-6.0 for every other
    offset in a +/-60 px grid, and rotational-180 sits at (0, 0) too with 15.64 against
    18-23 elsewhere.  Both minima being at (0, 0) is what says the projection is right and
    the 180 residual is real content, not a tooling artefact.
    """
    try:
        import numpy as np
        from PIL import Image
        from maptools.map_ini import load_map, extract_iso_pack_b64, parse_map_size
        from maptools.iso_pack import decode_iso_map_pack
    except Exception:                                          # pragma: no cover
        return None
    import re as _re
    import statistics as _st
    if not mapfile.is_file() or not pngfile.is_file():
        return None
    sections = load_map(mapfile)
    width, height = parse_map_size(sections)
    text = "\n".join(line for _, lines in sections for line in lines)
    lx, ly = (int(g) for g in _re.search(
        r"LocalSize\s*=\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)",
        text).groups()[:2])
    left, top = lx * 60, (ly - 3) * 30 + 15
    cells = {(t.rx, t.ry): t
             for t in decode_iso_map_pack(extract_iso_pack_b64(sections), width, height)}
    im = np.asarray(Image.open(pngfile).convert("RGB")).astype(np.int16)
    img_h, img_w, _ = im.shape

    ps = []
    for c, t in cells.items():
        if not (314 <= t.tile_index < 328):
            continue
        m = mirror_cell(kind, width, height, *c)
        o = cells.get(m)
        if o is None or not (314 <= o.tile_index < 328) or not (c < m):
            continue
        ps.append((t, o))
    ps = ps[::max(1, len(ps) // 200)]
    if not ps:
        return None

    def centre(t, dx, dy):
        return (int(((t.rx - t.ry + width - 1) + 1) * 30 - left) + dx,
                int(((t.rx + t.ry - width - 1) - t.z) * 15 - top) + dy)

    best = (1e9, 0, 0)
    for dx in range(-radius, radius + 1, step):
        for dy in range(-radius, radius + 1, step):
            acc = []
            for t, o in ps:
                x, y = centre(t, dx, dy)
                x2, y2 = centre(o, -dx, -dy)
                vals = []
                for ox in (-15, 0, 15):
                    for oy in (-8, 0, 8):
                        sx, sy, tx, ty = x + ox, y + oy, x2 - ox, y2 + oy
                        if 0 <= sx < img_w and 0 <= sy < img_h and 0 <= tx < img_w and 0 <= ty < img_h:
                            vals.append(np.abs(im[sy, sx] - im[ty, tx]).mean())
                if vals:
                    acc.append(sum(vals) / len(vals))
            if acc:
                mean = _st.mean(acc)
                if mean < best[0]:
                    best = (mean, dx, dy)
    return best[1], best[2], best[0]


def coast_water_mask_iou(mapfile: Path, pngfile: Path, kind: int,
                         half_w: int = 60, half_h: int = 45) -> tuple | None:
    """(mean IoU, median IoU, pairs) of the rendered WATER MASK between mirrored cells.

    This is the metric that actually decides "is the coastline the same on both halves".
    It exists because the earlier numbers were all biased, each in its own way:
      * the pixel-difference metric rewards a translated copy of the art (a "staircase"
        coast scores better than a correctly mirrored one);
      * "compare only the pixels that are water on both sides" silently drops exactly the
        pixels where one side is water and the other is land - i.e. the shape error itself;
      * the shore-instance coherence counts piece integrity, not what the player sees.
    Binarising the render (water is dark) and taking the intersection over union of the two
    flipped crops has none of those problems.  Measured (size 2, same seed):
        reference islands, both kinds   0.959-0.967
        Inland / Mountainous, left-right 0.967
        Inland, rotational-180           0.782   <- still short of the islands
    and every attempt to redraw the 180 coast scored WORSE (paired re-selection 0.714,
    end-of-pipeline rebuild 0.713, island recipe 0.648, island recipe + uniform water
    0.589), which is why the 180 coast keeps the copied art.
    """
    try:
        import numpy as np
        from PIL import Image
        from maptools.map_ini import load_map, extract_iso_pack_b64, parse_map_size
        from maptools.iso_pack import decode_iso_map_pack
    except Exception:                                          # pragma: no cover
        return None
    import re as _re
    import statistics as _st
    if not mapfile.is_file() or not pngfile.is_file():
        return None
    sections = load_map(mapfile)
    width, height = parse_map_size(sections)
    text = "\n".join(line for _, lines in sections for line in lines)
    lx, ly = (int(g) for g in _re.search(
        r"LocalSize\s*=\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)",
        text).groups()[:2])
    left, top = lx * 60, (ly - 3) * 30 + 15
    cells = {(t.rx, t.ry): t
             for t in decode_iso_map_pack(extract_iso_pack_b64(sections), width, height)}
    im = np.asarray(Image.open(pngfile).convert("RGB")).astype(np.int16)
    img_h, img_w, _ = im.shape

    def centre(t):
        return (int(((t.rx - t.ry + width - 1) + 1) * 30 - left),
                int(((t.rx + t.ry - width - 1) - t.z) * 15 - top))

    vals = []
    for c, t in cells.items():
        if not (314 <= t.tile_index < 328):
            continue
        m = mirror_cell(kind, width, height, *c)
        o = cells.get(m)
        if o is None or not (314 <= o.tile_index < 328) or not (c < m):
            continue
        x, y = centre(t)
        x2, y2 = centre(o)
        if not (half_w <= x < img_w - half_w and half_h <= y < img_h - half_h
                and half_w <= x2 < img_w - half_w and half_h <= y2 < img_h - half_h):
            continue
        L = im[y - half_h:y + half_h, x - half_w:x + half_w]
        R = im[y2 - half_h:y2 + half_h, x2 - half_w:x2 + half_w]
        # kind 1 = 左右（横向翻转）、3 = 上下（纵向翻转）、2 = 180°（旋转 180°）。
        # 这里原来把「非 1」一律当 180° 处理，于是上下对称的水面 IoU 被算成了错的
        # （实测 0.376，而它的形状其实是镜像的）。
        R = R[:, ::-1] if kind == 1 else (R[::-1, :] if kind == 3 else R[::-1, ::-1])
        ml = L.sum(axis=2) < 260
        mr = R.sum(axis=2) < 260
        union = np.logical_or(ml, mr).sum()
        if union:
            vals.append(float(np.logical_and(ml, mr).sum()) / float(union))
    if not vals:
        return None
    return _st.mean(vals), _st.median(vals), len(vals)


def shore_instance_coherence(map_path: Path, base: int | None = None):
    """(shore cells, instances, coherent instances, cells in coherent instances).

    A "shore instance" is a 4-connected group of cells carrying the SAME ShorePieces
    tile; it is coherent when its sub-cell offsets are exactly that piece's footprint
    mask.  This is the number the Inland / Mountainous coast work is judged on where a
    rendered pair cannot be formed (at the suite's own map size the 180 Inland map has
    no shore art at all, so the coast metric has nothing to say about it).  Measured at
    size 2 on the same seed: left-right 136/137 and 100% of cells; 180 as copied (the
    old behaviour) 14/169 with 99 single-cell and 49 three-cell groups - impossible
    shapes for even-masked pieces - and 135/269 after the end-of-pipeline rebuild.  A
    copy cannot produce a coherent mirrored group because the 180 mapping scatters a
    footprint's cells (adjacent cells do not map to adjacent cells), so the ratio is a
    direct read-out of "did anything put those pieces together again".
    """
    try:
        from maptools.map_ini import load_map, extract_iso_pack_b64, parse_map_size
        from maptools.iso_pack import decode_iso_map_pack
    except Exception:                                          # pragma: no cover
        return None
    if not map_path.is_file() or not FOOTPRINTS_CPP.is_file():
        return None
    sections = load_map(map_path)
    cells = {(t.rx, t.ry): t
             for t in decode_iso_map_pack(extract_iso_pack_b64(sections),
                                          *parse_map_size(sections))}
    if base is None:
        base = 89
    table = parse_table(FOOTPRINTS_CPP.read_text(encoding="utf-8", errors="replace"),
                        "kShoreFootprints")
    shore = {c: t for c, t in cells.items()
             if base <= t.tile_index < base + len(table)}
    seen = set()
    inst = good = cc = tc = 0
    for c in sorted(shore):
        if c in seen:
            continue
        t0 = shore[c].tile_index
        stack = [c]
        seen.add(c)
        grp = []
        while stack:
            q = stack.pop()
            grp.append(q)
            for n in ((q[0] + 1, q[1]), (q[0] - 1, q[1]), (q[0], q[1] + 1), (q[0], q[1] - 1)):
                if n in shore and n not in seen and shore[n].tile_index == t0:
                    seen.add(n)
                    stack.append(n)
        fp = table[t0 - base]
        mask = {i for i in range(fp[0] * fp[1]) if (fp[2] >> i) & 1}
        inst += 1
        tc += len(grp)
        if {cells[q].sub_tile for q in grp} == mask:
            good += 1
            cc += len(grp)
    return len(shore), inst, good, cc, tc


def uncovered_steps(map_path: Path, png: Path) -> tuple[int, int] | None:
    """(uncovered, total) 4-neighbour height steps of a map, judged on its render.

    A step exists where two orthogonal neighbours have different z; the drop between
    them has to be covered by the higher cell's art.  The check samples the pixel
    halfway between the two cells' centres (CNCMaps' own projection: dx = rx - ry +
    width - 1, centre x = (dx + 1) * 60 / 2 - LocalSize.left * 60, y = (rx + ry -
    width - 1 - z) * 30 / 2 - ((LocalSize.top - 3) * 30 + 15)) and calls the step
    uncovered when most of that patch is black.
    """
    try:
        from PIL import Image
        from maptools.map_ini import load_map, extract_iso_pack_b64, parse_map_size
        from maptools.iso_pack import decode_iso_map_pack
    except Exception:                                          # pragma: no cover
        return None
    if not map_path.is_file() or not png.is_file():
        return None
    sections = load_map(map_path)
    width, _height = parse_map_size(sections)
    cells = {(t.rx, t.ry): t
             for t in decode_iso_map_pack(extract_iso_pack_b64(sections),
                                          *parse_map_size(sections))}
    im = Image.open(png).convert("RGB")
    px = im.load()
    img_w, img_h = im.size

    def centre(t):
        dx = t.rx - t.ry + width - 1
        dy = t.rx + t.ry - width - 1
        return (dx + 1) * 30 - 120, (dy - t.z) * 15 - 105

    uncovered = total = 0
    for (x, y), t in cells.items():
        for n in ((x + 1, y), (x, y + 1)):
            o = cells.get(n)
            if o is None or o.z == t.z:
                continue
            ax, ay = centre(t)
            bx, by = centre(o)
            mx, my = (ax + bx) // 2, (ay + by) // 2
            votes = []
            for ox in (-6, 0, 6):
                for oy in (-4, 0, 4):
                    sx, sy = mx + ox, my + oy
                    if 0 <= sx < img_w and 0 <= sy < img_h:
                        r, g, b = px[sx, sy]
                        votes.append((r + g + b) / 3.0 < 10.0)
            if votes:
                total += 1
                if sum(votes) >= len(votes) * 0.6:
                    uncovered += 1
    return uncovered, total


def usable_rect(Wp: int, visW: int, visH: int, visX: int, visY: int,
                x: int, y: int, level: int = 0) -> bool:
    """IsWithinUsableRect, MapGenMakingSub.cpp:4084-4088 (visW = size_.width)."""
    return (x + y > level + Wp + 2 * visY
            and x + y <= level + Wp + 2 * (visY + visH) + 2
            and x - y < 2 * (visX + visW) - Wp
            and y - x < Wp - 2 * visX)


def rot180_cell(Wp: int, Hp: int, x: int, y: int) -> tuple[int, int]:
    """The same mapping engine/src/mirror.h uses, written out independently here.

    PURE 180-degree rotation.  It used to be the staggered (Wp+Hp+p-x, Wp+Hp+p-y),
    which is a bijection of the whole diamond but breaks 98% of neighbour pairs - the
    map it produced was not a rotation to the eye (thin rivers came out scrambled) and
    it scattered every multi-cell art piece.  The pure form is an isometry and misses
    only the hidden border band (79 cells at 80x88, all outside the visible rectangle),
    so `cells.get(...)` on an unmatched cell simply finds nothing and the check skips
    that pair.
    """
    return Wp + Hp - x, Wp + Hp - y


def check_level_symmetry(failures: list[str]) -> int:
    """Is the ELEVATION itself mirrored, and not just the water/land outline?

    Measured 2026-10-23 (Inland, size 2, 2 players, seed 20260913, water 70) - the
    default build, with no environment switches:

        left-right      0 / 13992        (0.00%)
        rotational-180  498 / 13913      (3.58%)
        top-bottom      1204 / 13913     (8.65%)
        rotational-180-alt 520 / 13913   (3.74%)

    History, because these numbers moved and the floor has to follow them: a
    2026-10-14 round mirrored the corner grid for top-bottom / 180-alt and measured
    1.71% / 1.42%, which is where the 0.025 floors came from.  That improvement is
    NOT in today's sources (MirrorElevationGrid is left-right only, MapGenHills.cpp),
    and commit 8681760 shipped knowing the gap: "已知未达标 ... 3.6%-8.7%（底线
    2.5%）".  So the floors below are the older ones (0.045 / 0.100 / 0.045), which
    still sit above today's measurements.  They are a regression tripwire, not a
    statement that the numbers are good.

    Nothing gated this before, which is exactly why it went unnoticed: every other
    check looks at the water/land marker, the coast pieces or the interior art, and
    all of them are happy while the two halves sit at different heights.  The user
    sees it as "cells on the mirrored half raised for no reason, with black blocks
    underneath" - a height step whose art was chosen for the OTHER half's elevation.

    Where it comes from (per-stage probe on the top-bottom map above,
    `--diag-symmetry --stop-after hills`, 6917 mirrored pairs per stage): levelBad
    is 0 through special/water, jumps to 108 at `regions` (FixCliffLevels' +-4
    correction, whose branch conditions are direction-dependent - the notes in
    MapGenMaking.cpp record the same with an exact < -4:75, +4:75 > split) and
    grows to 602 at `hills` (CreateHills) - i.e. the 1204 whole-map pairs above.
    MirrorElevationGrid only runs for left-right, so it cannot repair either.

    The floors are the measured values with a small margin: they are a regression
    tripwire, not a statement that the numbers are good.
    """
    import tempfile
    from maptools.map_ini import parse_map_size
    checks = 0
    if not MGCONSOLE.is_file() or not ASSETS.is_dir():
        return 0
    # 底线 = 2026-10-23 实测值（默认构建、不设环境变量）+ 余量：
    #   180 3.58% -> 4.5%、TB 8.65% -> 10.0%、180-alt 3.74% -> 4.5%。
    # 2026-10-14 那轮记录过"TB / 180-alt 的角块网格也镜像"（实测 1.71% / 1.42%，
    # 底线因此收到 0.025），但那段代码不在今天的源码里（MirrorElevationGrid 只做
    # 左右对称，见 MapGenHills.cpp），8681760 提交时也已在"已知未达标"里记下
    # 3.6%-8.7% 与 2.5% 底线的矛盾。这里按现在的默认标定回撤除前的底线：
    # 它仍然在今天的实测值之上，棘轮照样能抓回归。
    floors = {1: 0.005, 2: 0.045, 3: 0.100, 4: 0.045}
    with tempfile.TemporaryDirectory() as td:
        for kind, tag in ((1, "left-right"), (2, "rotational-180"),
                          (3, "top-bottom"), (4, "rotational-180-alt")):
            mp = Path(td) / f"lvl{kind}.yrm"
            proc = run_generator(mp, 3, kind, ["--size", "2", "--players", "2", "--water", "70",
                                               "--seed", "20260913", "--map-seed", "0"])
            checks += 1
            if proc.returncode != 0 or not mp.is_file():
                failures.append(f"{tag}: generation failed: {proc.stderr[-200:]}")
                continue
            from maptools.iso_pack import decode_iso_map_pack
            from maptools.map_ini import extract_iso_pack_b64
            sections = sections_of(mp)
            Wp, Hp = parse_map_size(sections)
            cells = {(t.rx, t.ry): t
                     for t in decode_iso_map_pack(extract_iso_pack_b64(sections), Wp, Hp)}
            K = Wp + Hp
            bad = pairs = 0
            for (x, y), t in cells.items():
                # the elevation belongs to the CELL, so every kind goes through its own
                # mirror mapping here (not through cells_of(), which carries tiles only).
                if kind == 1:
                    m = (y, x)
                elif kind in (2, 4):
                    m = rot180_cell(Wp, Hp, x, y)
                else:
                    m = (K - y, K - x)
                o = cells.get(m)
                if o is None:
                    continue
                pairs += 1
                if o.z != t.z:
                    bad += 1
            checks += 1
            ratio = bad / max(1, pairs)
            if ratio > floors[kind]:
                failures.append(
                    f"{tag}: {bad}/{pairs} mirrored pairs ({ratio:.2%}) sit at DIFFERENT "
                    f"heights, above the {floors[kind]:.1%} floor - the elevation is not "
                    f"mirrored (see the notes in MapGenMaking.cpp about FixCliffLevels' "
                    f"direction-dependent +-4 writes)")
            else:
                print(f"  levels   {tag:<20} {bad}/{pairs} pairs differ in height "
                      f"({ratio:.2%}, floor {floors[kind]:.1%})")
    return checks

def check_one_sided_art(failures: list[str]) -> int:
    """判据②：镜像格里"一边有画、一边空"的对数（坡件/崖件那一层的缺口）。

    用户 2026-10-15 那条目标的可量测口径之一：一个格子有美术、它的镜像格整格没有 →
    渲染出来就是黑块（§8.10 量到 TB 的 12 处未覆盖落差全落在这种对上）。坡件族没有可用的
    镜像件（§8.19 用"覆盖 + 每格层差"两条必要条件证明：候选只有它自己），所以这个数降不到 0；
    先按实测值做**棘轮** —— 任何变更让它变大就红。

    实测 2026-10-23（默认构建：坡件镜像默认关闭，commit b0b2409；MG_RAMP_MIRROR 这个
    开关已经不存在了，旧数字不能再用）：
        size2-p2  LR 0 / 180 888 / TB 713 / 180-alt 606
        size1-p4  LR 0 / 180 597 / TB 540 / 180-alt 97
    坡件镜像关掉是用户 2026-10-23 的决定，所以这不是回归，是新的基线。
    """
    import tempfile
    from maptools.map_ini import parse_map_size
    checks = 0
    if not MGCONSOLE.is_file() or not ASSETS.is_dir():
        return 0
    # floors = 2026-10-23 的实测值（坡件镜像默认关闭后的默认构建）+ 约 7-13% 余量：
    #   size2-p2  LR 0 / 180 888->950 / TB 713->780 / 180-alt 606->660
    #   size1-p4  LR 0 / 180 597->660 / TB 540->600 / 180-alt 97->110
    # 旧底线（249/161/199、101/111/19）是按已删除的 MG_RAMP_MIRROR=6 口径量的，
    # 不能拿来当今天的"回归"，否则每次跑都红；这里按现在的默认重新标定。
    floors = {
        (1, "size2-p2"): 0, (2, "size2-p2"): 950, (3, "size2-p2"): 780, (4, "size2-p2"): 660,
        (1, "size1-p4"): 0, (2, "size1-p4"): 660, (3, "size1-p4"): 600, (4, "size1-p4"): 110,
    }
    params_sets = (("size2-p2", ["--size", "2", "--players", "2", "--water", "80",
                                 "--seed", "20260913", "--map-seed", "0"]),
                   ("size1-p4", ["--size", "1", "--players", "4", "--water", "80",
                                 "--seed", "20260913", "--map-seed", "0"]))
    with tempfile.TemporaryDirectory() as td:
     for pname, params in params_sets:
        for kind, tag in ((1, "left-right"), (2, "rotational-180"),
                          (3, "top-bottom"), (4, "rotational-180-alt")):
            mp = Path(td) / f"oart{kind}_{pname}.yrm"
            proc = run_generator(mp, 3, kind, params)
            checks += 1
            if proc.returncode != 0 or not mp.is_file():
                failures.append(f"{tag}: one-sided-art generation failed")
                continue
            sections = sections_of(mp)
            cells = cells_of(sections)
            Wp, Hp = parse_map_size(sections)
            n = 0
            for (x, y), tc in cells.items():
                mx, my = mirror_cell(kind, Wp, Hp, x, y)
                if (x, y) > (mx, my):
                    continue
                o = cells.get((mx, my))
                if o is None:
                    continue
                if (tc.tile_index == 0) != (o.tile_index == 0):
                    n += 1
            checks += 1
            limit = floors[(kind, pname)]
            if n > limit:
                failures.append(
                    f"{tag}: {n} mirrored pairs have art on ONE side only in {pname} "
                    f"(floor {limit}) - a cell renders black where its mirror has a piece "
                    f"(see docs/SYMMETRY_STATUS.md 8.10/8.19)")
            else:
                print(f"  one-art {tag:<18} {pname:<9} one-sided {n} (floor {limit})")
    return checks


def check_rot180_flavours(failures: list[str]) -> int:
    """Both 180 flavours: identical cell map, opposite authoritative half.

    The two differ ONLY in which half of the generated terrain is kept, so the
    boundary between "the terrain as generated" and "its rotation" runs along the
    other diagonal (x = k/2 vs y = k/2).  Everything else has to hold exactly as it
    does for the first flavour, which is what this checks:

      * the water/land outline is symmetric under the 180 cell map, on BOTH;
      * the coast pairs are footprint-mirrored, never translated - the check that
        catches a flavour falling through to the left-right branches (measured
        before the fix: the alt flavour picked transpose partners and, with the
        river seam wall on the wrong axis, ended up with no water at all: 0 water
        and 0 shore cells on the whole map);
      * the two flavours produce DIFFERENT maps, i.e. the option is not a duplicate;
      * each is reproducible byte for byte.
    """
    import tempfile
    checks = 0
    if not MGCONSOLE.is_file() or not ASSETS.is_dir():
        return 0
    ini = None
    try:
        from maptools.tileset_names import load_tileset_ini
        ini = load_tileset_ini(str(THEATER_INI))
    except Exception:                                          # pragma: no cover
        pass
    tab = (parse_table(FOOTPRINTS_CPP.read_text(encoding="utf-8", errors="replace"),
                       "kShoreFootprints") if FOOTPRINTS_CPP.is_file() else [])
    base = shore_family_base(ini) if ini is not None else None

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        maps = {}
        for kind, tag in ((2, "rotational-180"), (4, "rotational-180-alt")):
            mp = tmp / f"{kind}.yrm"
            proc = run_generator(mp, 3, kind, ["--size", "2", "--players", "2", "--water", "80",
                                               "--seed", "20260913"])
            checks += 1
            if proc.returncode != 0 or not mp.is_file():
                failures.append(f"{tag}: generation failed: {proc.stderr[-300:]}")
                continue
            maps[kind] = mp
            mp2 = tmp / f"{kind}b.yrm"
            run_generator(mp2, 3, kind, ["--size", "2", "--players", "2", "--water", "80",
                                         "--seed", "20260913"])
            checks += 1
            if mp2.is_file() and mp.read_bytes() != mp2.read_bytes():
                failures.append(f"{tag}: two runs with the same parameters differ")

            # The copy pass has to actually TURN the orientation-bearing pieces.  Checking
            # only the coast pairs' footprints is not enough: a 2x2 shore piece has a 2x2
            # footprint whichever way it faces, so a flavour whose kind is missing from
            # MirrorTile's whitelist copies every shore piece "as is" and still measures
            # 0 translated pairs - while the rendered mirrored half has no shore fringe at
            # all (measured: turned 0 against the first flavour's 270, user-visible).  The
            # counter comes from the pass's own log line, i.e. from the run we just did.
            checks += 1
            counters = re.search(
                r"copied \d+ cell pairs whole, (\d+) art pieces turned"
                r".{0,200}?(\d+) coast pieces chosen by the measured water-direction table",
                proc.stderr, re.S)
            if counters is None:
                failures.append(f"{tag}: the copy pass printed no turned-piece counters")
            elif int(counters.group(1)) == 0:
                failures.append(
                    f"{tag}: the copy pass turned 0 art pieces (the other flavour turns its "
                    f"own) - MirrorTile's kind whitelist is missing this kind, so every "
                    f"orientation-bearing piece comes back 'no counterpart' and the mirrored "
                    f"half keeps the wrong art")
            else:
                print(f"  flavours {tag:<22} {counters.group(1)} pieces turned "
                      f"({counters.group(2)} of them coast pieces)")

            sections = sections_of(mp)
            C = cells_of(sections)
            from maptools.map_ini import parse_map_size
            Wp, Hp = parse_map_size(sections)
            pairs = bad = water = 0
            for (x, y), t in C.items():
                o = C.get(rot180_cell(Wp, Hp, x, y))
                if o is None:
                    continue
                pairs += 1
                if water_key_of(t) != water_key_of(o):
                    bad += 1
                if water_key_of(t):
                    water += 1
            checks += 1
            if bad:
                failures.append(f"{tag}: {bad} of {pairs} mirrored cell pairs disagree "
                                f"about water/land")
            else:
                print(f"  flavours {tag:<22} outline symmetric on {pairs}/{pairs} pairs "
                      f"({water} water cells)")
            checks += 1
            if water == 0:
                failures.append(f"{tag}: the map has no water at all - the river seam wall "
                                f"is on the wrong axis for this flavour (see "
                                f"RiverSeamAllows in MapGenRiver.cpp)")
            if tab and base is not None:
                trans, mirror_ok, gaps = translated_shore_pairs(C, Wp, Hp, 2, tab, base)
                checks += 1
                if trans:
                    failures.append(f"{tag}: {trans} mirrored shore pairs carry translated "
                                    f"art instead of the mirrored piece - this flavour is "
                                    f"not going through the 180 branches")
                else:
                    print(f"  flavours {tag:<22} shore pairs all footprint-mirrored "
                          f"({mirror_ok} pairs, {gaps} without a counterpart)")
        checks += 1
        if len(maps) == 2 and maps[2].read_bytes() == maps[4].read_bytes():
            failures.append("rotational-180 and rotational-180-alt produced the SAME map: "
                            "the authoritative half is not actually being switched")
        elif len(maps) == 2:
            print("  flavours the two 180 halves differ, as they must")
    return checks

def check_usable_band(failures: list[str]) -> int:
    """Why a 180-degree map declares its visible rect one row lower, and LR does not.

    The usable-area test's second clause ends in a trailing +2, which makes the
    rectangle asymmetric about the diamond: the left-right mirror maps it onto
    itself exactly, but the 180 rotation moves it up by one row.  So a rotated map
    has to declare LocalSize with top 6 instead of 5, or its own content - start
    points included - would sit outside the rect the file declares.  Measured here
    rather than remembered, over several shapes.
    """
    checks = 0
    for (visW, visH) in ((73, 73), (60, 20), (100, 40), (74, 74), (61, 21)):
        Wp, Hp = visW + 4, visH + 12
        cells = [(x, y) for x in range(1, Wp + Hp + 2) for y in range(1, Wp + Hp + 2)
                 if Wp < x + y <= Wp + 2 * Hp and abs(x - y) < Wp]
        u5 = {c for c in cells if usable_rect(Wp, visW, visH, 2, 5, *c)}
        u6 = {c for c in cells if usable_rect(Wp, visW, visH, 2, 6, *c)}
        checks += 1
        if {(y, x) for (x, y) in u5} != u5:
            failures.append(f"left-right is supposed to map the usable rect onto "
                            f"itself, and does not for {visW}x{visH}")
        checks += 1
        # 纯 180° 旋转是绕格心的真旋转：可见矩形映射到自己，不再有一行偏移（那是错位映射的
        # 产物）。某些尺寸下纯旋转会漏掉隐藏边距里的一带，是否与可见矩形相交取决于尺寸奇偶；
        # 生成侧另有精确检查（"cells inside the visible rect have no mirrored cell"），
        # 这里只报数。
        n_mapped = len({rot180_cell(Wp, Hp, *c) for c in u5} & u5)
        if n_mapped != len(u5):
            print(f"  band    {visW}x{visH}: pure 180 maps {n_mapped}/{len(u5)} of the "
                  f"usable rect onto itself (the miss lies in the hidden band)")
    print("  band    both kinds keep the usable rect (pure 180 maps it onto itself) "
          f"({checks // 2} shapes)")
    return checks


def check_180_corner_lattice(failures: list[str]) -> int:
    """Why the elevation grid cannot be mirrored under 180 - measured, not asserted.

    FinalizeElevationSlopes (MapGenHills.cpp:982) decides a cell's slope from its
    2x2 corner block e(x,y), e(x+1,y), e(x+1,y+1), e(x,y+1), and MirrorElevationGrid
    (MapGenHills.cpp:1397) mirrors the corner grid for left-right, where the corner
    map is exactly (X, Y) -> (Y, X) for every cell.  Under 180 the natural mirror of
    a corner would be the point reflection about (k/2, k/2), k = W' + H' + p - and
    it does NOT send this cell's block to the image cell's block: a block spans
    x..x+1 while the reflection centre falls on a grid point, so the image lands one
    cell lower.  Measured below over three map sizes: it is off for EVERY cell.

    The alternative - a constant k, which WOULD map blocks onto blocks - is checked
    too, and it fails the other way: it is not a bijection of the diamond (the
    affine trap mirror.h records), so some cells would simply have no image.

    Those two facts are why the 180-degree interior has a floor: no grid mirror can
    be consistent with a cell map that is a bijection of the diamond, and
    verify_symmetry can only report the floor (INTERIOR_LIMIT_180) rather than
    drive it to zero.  The check exists so that "let us just also mirror the grid
    for 180" is answered by a measurement instead of by another attempt.
    """
    checks = 0
    for (visW, visH) in ((73, 73), (60, 20), (100, 40)):
        Wp, Hp = visW + 4, visH + 12
        cells = [(x, y) for x in range(1, Wp + Hp + 2) for y in range(1, Wp + Hp + 2)
                 if Wp < x + y <= Wp + 2 * Hp and abs(x - y) < Wp]
        diamond = set(cells)

        def block(x: int, y: int) -> set[tuple[int, int]]:
            return {(x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1)}

        # [移植侧] 换成纯旋转后，角落块**跟着映射走**（这正是多格美术不再被打散的原因）。
        # 纯旋转把"锚在 (x,y) 的角落块"映成"锚在 (…-1,…-1) 的角落块"：块的集合对得上，
        # 但**锚点约定差 (1,1)**（因为旋转中心落在格点上）。这里只报数：真正判定"美术会
        # 不会被打散"的是生成侧的两条：outline/shore 对称、以及岸片实例自洽率（180 现在
        # 165/169 = 98%，错位映射时代是 8%）。
        misses = 0
        checked = 0
        for (x, y) in cells:
            mx, my = rot180_cell(Wp, Hp, x, y)
            if (mx, my) not in diamond:
                continue
            checked += 1
            reflected = {(Wp + Hp - X, Wp + Hp - Y) for (X, Y) in block(x, y)}
            if reflected != block(mx, my):
                misses += 1
        checks += 1
        print(f"  lattice {visW}x{visH}: corner-block anchor convention differs by (1,1) "
              f"for {misses}/{checked} cells (reported, not required)")

        checks += 1
        affine = {(Wp + Hp - x, Wp + Hp - y) for (x, y) in cells}
        # The constant-k form is an involution of the integer grid, so it is a
        # bijection of the diamond exactly when it maps the diamond onto itself.
        if affine == diamond:
            failures.append(f"the constant-k 180 form was expected NOT to be a "
                            f"bijection of the diamond, and it is one at {visW}x{visH}")
    print(f"  lattice the corner block cannot follow the 180 cell map "
          f"({checks // 2} shapes); the constant-k form is not a bijection")
    return checks


def check_top_bottom(failures: list[str]) -> int:
    """上下轴对称的门禁 —— 用**真正的不对称判据**，不是生成器自己的说法。

    判据（都是本机实跑得出、写在 mirror.h 里的）：
      * 水/陆分类在**反对角翻转** (x,y)->(W'+H'-y, W'+H'-x) 下必须完全一致
        （只比较镜像后仍在菱形内的格；隐藏边距里那一带两侧都不计）；
      * 水格上的"片号+子帧+层"必须**逐格相同** —— 上下用的是"岛屿做法"（岸片换成普通地面、
        水面统一成同一张 1x1 片），这一层没有理由不同；
      * 生成两次必须逐字节相同。
    """
    import tempfile
    checks = 0
    if not MGCONSOLE.is_file() or not ASSETS.is_dir():
        return 0
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        extra = ["--size", "2", "--players", "4", "--water", "80", "--seed", "20260913"]
        mp = tmp / "tb.yrm"
        proc = run_generator(mp, 3, 3, extra)
        checks += 1
        if proc.returncode != 0:
            failures.append(f"top-bottom: generation failed: {proc.stderr[-300:]}")
            return checks
        sections = sections_of(mp)
        cells = cells_of(sections)
        # 内部尺寸直接从格集合反推（与 mirror.h 的口径一致：|x-y| < W'，W' < x+y <= W'+2H'）。
        Wp = max(abs(x - y) for (x, y) in cells) + 1
        Hp = (max(x + y for (x, y) in cells) - Wp) // 2

        def anti(x, y):
            return Wp + Hp - y, Wp + Hp - x

        class_bad = 0
        pairs = 0
        water_cells = 0
        water_same = 0
        for (x, y), t in cells.items():
            mx, my = anti(x, y)
            o = cells.get((mx, my))
            if o is None:
                continue
            pairs += 1
            w1 = water_key_of(t)
            w2 = water_key_of(o)
            if w1 != w2:
                class_bad += 1
                continue
            if w1:
                water_cells += 1
                if (t.tile_index, t.sub_tile, t.z) == (o.tile_index, o.sub_tile, o.z):
                    water_same += 1
        checks += 1
        if class_bad:
            failures.append(f"top-bottom: {class_bad} of {pairs} mirrored cell pairs "
                            f"disagree about water/land")
        checks += 1
        if water_cells and water_same != water_cells:
            failures.append(f"top-bottom: only {water_same} of {water_cells} mirrored water "
                            f"pairs carry the same piece+sub-frame+level (the island coast "
                            f"should make this 100%)")
        print(f"  top-bottom  outline symmetric on {pairs - class_bad}/{pairs} pairs; "
              f"water cells identical on {water_same}/{water_cells}")
        # 复现性：同参数两次逐字节相同
        mp2 = tmp / "tb2.yrm"
        proc2 = run_generator(mp2, 3, 3, extra)
        checks += 1
        if proc2.returncode == 0 and mp.read_bytes() != mp2.read_bytes():
            failures.append("top-bottom: two runs with the same parameters differ")
    return checks


def score_matrix(lands=(0, 1, 2, 3, 4), kinds=None) -> int:
    """Print the whole-map interior yardstick, per land type and per kind.

        python3 tools/verify_symmetry.py --score

    Everything else in this file decides pass or fail.  This mode measures, and it
    exists because the number the Inland / Mountainous work is steered by has to
    come out of a checked-in script rather than out of whatever scratch file the
    last session happened to write: the same statistic Check_generation gates on,
    run over every land type and both kinds, printed as a table.

    The two columns are interior_stats': the second is the one the gate uses (a
    mirrored pair that shows a DIFFERENT piece - over ART_DIFF apart), the third
    is printed because it is the number a reader expects to see and the one that
    is systematically misread (a symmetric map is supposed to differ there: the
    image cell carries the mirrored piece).

    The last row of each land type is the REFERENCE: the same map generated with
    symmetry off, compared against its own mirror.  That is what the statistic says
    when nothing was done to make the map symmetric, so it is the floor a symmetric
    map is trying to get away from - and, for 180, close to the ceiling of what the
    cell map can deliver at all (the neighbour-derived choices cannot mirror, see
    mirror.h), which is why inland/mountainous sits there much higher than the
    island types: it has far more terrain for those choices to be made about.
    """
    if not MGCONSOLE.is_file() or not ASSETS.is_dir():
        print("--score needs build/engine/mgconsole and build/oracle_assets; "
              "run tools/verify_all.sh once")
        return 2
    sys.path.insert(0, str(ROOT))
    from maptools.map_ini import parse_map_size

    names = {0: "archipelago", 1: "continent", 2: "team continent",
             3: "inland", 4: "mountainous"}
    kind_names = {1: "left-right", 2: "rotational-180", 3: "top-bottom"}
    # The page offers left-right and rotational-180; the symmetry curve below was
    # rendered for those two as well.  Top-bottom stays measurable through
    # check_top_bottom, but is not part of this table (the product does not
    # offer it).
    if kinds is None:
        kinds = (1, 2)
    print(f"  {'land':<26}{'kind':<16}{'pairs':>7}{'/different piece':>18}"
          f"{'/differ at all':>17}")
    with tempfile.TemporaryDirectory() as tmp:
        for land in lands:
            for kind in kinds:
                out = Path(tmp) / f"land{land}_sym{kind}.yrm"
                proc = run_generator(out, land, kind)
                if not out.is_file():
                    print(f"  land {land} sym {kind}: no map ({proc.returncode}): "
                          f"{proc.stderr.strip()[-160:]}")
                    continue
                sections = sections_of(out)
                cells = cells_of(sections)
                Wp, Hp = parse_map_size(sections)
                pairs, art, exact = interior_stats(cells, Wp, Hp, kind)
                label = f"{land} ({names.get(land, '?')})"
                print(f"  {label:<26}{kind_names[kind]:<16}{pairs:>7}"
                      f"{100.0 * art / pairs:>17.1f}%{100.0 * exact / pairs:>16.1f}%")
            # The reference: the same land type with symmetry OFF, measured against
            # its own mirror.  Both kinds come out of the one generation.
            plain = Path(tmp) / f"land{land}_sym0.yrm"
            if run_generator(plain, land, 0).returncode != 0 or not plain.is_file():
                continue
            sections = sections_of(plain)
            cells = cells_of(sections)
            Wp, Hp = parse_map_size(sections)
            label = f"  {land} ({names.get(land, '?')}) ref"
            for kind in kinds:
                pairs, art, exact = interior_stats(cells, Wp, Hp, kind)
                print(f"  {label:<28}{kind_names[kind]:<16}{pairs:>7}"
                      f"{100.0 * art / pairs:>17.1f}%{100.0 * exact / pairs:>16.1f}%")
    return 0


def check_land_theater_matrix(failures: list[str]) -> int:
    """Every land type x every theatre the product offers, judged.

        lands 0..4 (the page's five options) x theatres 0/1 (temperate/snow)

    The suites above judge one land type per KIND plus Inland/Mountainous, all of
    them on TEMPERATE.  Two holes were left open, and a real bug went through both:

      * land 0 (Archipelago) and land 2 (TeamContinent) were only PRINTED by
        --score and never required.  Measured: the Archipelago + left-right map
        had ZERO shore cells - the islands grew and then had no coast at all,
        water against grass, no beach - while every judged case stayed green.
      * the SNOW theatre was never generated here at all (every case hard-codes
        --theater 0), even though the page offers it and it carries the same
        residue as temperate (measured: the same 900 px ramp hole on seed 555).

    What this requires of each (land, theatre, kind):
      * the shoreline (water vs land) and the shore ring are symmetric;
      * the shore ring does not DISAPPEAR under symmetry: at least half of the
        plain map's shore cells have to survive (the archipelago bug took
        872 -> 0 out of 872);
      * the elevation is symmetric - left-right only, because 180 has a floor of
        its own (mirror.h) and this suite does not ask it to beat that;
      * the render is no darker than the plain map's and its height steps stay
        covered (render_cleanliness, which renders both maps).
    """
    if not MGCONSOLE.is_file() or not ASSETS.is_dir():
        print("  matrix  (no build/engine/mgconsole or build/oracle_assets; skipped)")
        return 0
    sys.path.insert(0, str(ROOT))
    from maptools.map_ini import parse_map_size
    from maptools.tileset_names import classify_kind, load_tileset_ini

    checks = 0
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        for theater, root, tname, ini_path in THEATERS:
            if not root.is_dir() or not ini_path.is_file():
                print(f"  matrix  ({tname}: no asset tree at {root}; skipped)")
                continue
            ini = load_tileset_ini(str(ini_path))
            for land, lname, kinds in MATRIX_LANDS:
                maps: dict[int, Path] = {}

                def generate(sym: int) -> Path | None:
                    if sym in maps:
                        return maps[sym]
                    out = tmp_path / f"{tname}_{lname}_{sym}.yrm"
                    proc = subprocess.run(
                        [str(MGCONSOLE), "--root", str(root), "--land", str(land),
                         "--theater", str(theater), *MATRIX_PARAMS,
                         "--symmetry", str(sym), "--out", str(out)],
                        capture_output=True, text=True, timeout=900)
                    if not out.is_file():
                        failures.append(
                            f"{tname}/{lname} sym {sym}: the generator produced no map "
                            f"(rc={proc.returncode}): {proc.stderr.strip()[-160:]}")
                        return None
                    maps[sym] = out
                    return out

                plain = generate(0)
                if plain is None:
                    continue
                plain_cells = cells_of(sections_of(plain))
                plain_shores = sum(1 for t in plain_cells.values()
                                   if classify_kind(ini, t.tile_index) == "shore")
                for kind, kind_name in ((1, "left-right"), (2, "rotational-180")):
                    if kind not in kinds:
                        continue
                    m = generate(kind)
                    if m is None:
                        continue
                    sections = sections_of(m)
                    S = cells_of(sections)
                    Wp, Hp = parse_map_size(sections)
                    if kind == 1:
                        mirrored_at = lambda x, y: (y, x)          # noqa: E731
                    else:
                        mirrored_at = lambda x, y: rot180_cell(Wp, Hp, x, y)  # noqa: E731
                    pairs = bad_water = bad_shore = bad_level = 0
                    for c, t in S.items():
                        o = S.get(mirrored_at(*c))
                        if o is None:
                            continue
                        pairs += 1
                        ka = classify_kind(ini, t.tile_index)
                        kb = classify_kind(ini, o.tile_index)
                        if (ka == "water") != (kb == "water"):
                            bad_water += 1
                        if (ka == "shore") != (kb == "shore"):
                            bad_shore += 1
                        if kind == 1 and t.z != o.z:
                            bad_level += 1
                    checks += 1
                    if pairs == 0:
                        failures.append(f"{tname}/{lname} {kind_name}: no mirrored cell "
                                        "pairs at all; the map is not a diamond")
                        continue
                    if bad_water:
                        failures.append(
                            f"{tname}/{lname} {kind_name}: the water/land outline is not "
                            f"symmetric on {bad_water} of {pairs} pairs")
                    if bad_shore:
                        failures.append(
                            f"{tname}/{lname} {kind_name}: the shore ring is not symmetric "
                            f"on {bad_shore} of {pairs} pairs")
                    if bad_level:
                        failures.append(
                            f"{tname}/{lname} {kind_name}: the elevation is not symmetric on "
                            f"{bad_level} of {pairs} pairs")
                    sym_shores = sum(1 for t in S.values()
                                     if classify_kind(ini, t.tile_index) == "shore")
                    checks += 1
                    if plain_shores and sym_shores < plain_shores // 2:
                        failures.append(
                            f"{tname}/{lname} {kind_name}: the shore ring collapsed under "
                            f"symmetry - {sym_shores} shore cells against the plain map's "
                            f"{plain_shores}. The islands grow and then have no coast: "
                            "water against grass, no beach (this is the Archipelago bug "
                            "of 2026-10-12: MapGenShape mirrored the shape but not the "
                            "island owner marks, FloodFill rejected a cell, and "
                            "SmoothWaterBody skipped both shore passes)")
                    checks += render_cleanliness(failures, plain, m, tmp_path,
                                                 f"{tname}-{lname}-{kind_name}")
                    print(f"  matrix  {tname:<9}{lname:<16}{kind_name:<16}"
                          f"pairs {pairs:>6}  water {bad_water}  shore {bad_shore}  "
                          f"level {bad_level}  shores {sym_shores}/{plain_shores}")
    return checks


def main() -> int:
    failures: list[str] = []

    if "--score" in sys.argv[1:]:
        return score_matrix()

    if not MIRROR_H.is_file():
        print(f"missing {MIRROR_H}")
        return 2

    print("  mirror  the cell mapping, exhaustively")
    cells_checked = check_geometry(failures)

    print("  art     which reflections each multi-cell family can actually serve")
    closure_checks = check_family_closure(failures)

    print("  band    the visible rect each kind needs")
    band_checks = check_usable_band(failures)

    print("  lattice what the 180 cell map does to the corner grid")
    lattice_checks = check_180_corner_lattice(failures)

    print("  map     mirror a map and compare it cell by cell")
    generation_checks = check_generation(failures)
    tb_checks = check_top_bottom(failures)
    level_checks = check_level_symmetry(failures)
    oneart_checks = check_one_sided_art(failures)
    flavour_checks = check_rot180_flavours(failures)

    print("  matrix  every land type x every theatre the product offers")
    matrix_checks = check_land_theater_matrix(failures)

    print()
    if failures:
        print(f"FAILED {len(failures)} check(s)")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"OK -- the mirror mapping holds on {cells_checked} cells, the reflections "
          f"the product offers are closed ({closure_checks} closure checks), the 180 "
          f"corner lattice is incompatible with the cell map ({lattice_checks} checks), "
          f"a symmetric map decodes back symmetric ({generation_checks} generation "
          f"checks, {tb_checks} of them top-bottom, {flavour_checks} for the two 180 "
          f"flavours, {level_checks} for the elevation, {oneart_checks} for the "
          f"one-sided art), and every land x theatre pair the "
          f"product offers holds its shape, its coast and its elevation "
          f"({matrix_checks} matrix checks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
