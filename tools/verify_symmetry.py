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
)
# The bit convention for IsoFootprint::mask - "bit (row * w + col)"
# (MapGenRiver.cpp:3830) - is what makes a reflection a bit permutation.
MASK_BIT_ORDER = "row-major: bit (row * w + col), MapGenRiver.cpp:3830"
# What the product relies on, pinned: left-right is closed for every family except
# the two irregular shore pieces, and 180 degrees additionally misses four
# WaterCliffs pieces (which is phase 2's problem, recorded here so it is not
# discovered on a map).
LR_GAP_SIZES = {"kShoreFootprints": 2}
R180_GAP_SIZES = {"kShoreFootprints": 2, "kCliffWaterFootprints": 4}


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
        return (w, h, pack([(h - 1 - r, c) for r, c in cells(m, w, h)], w))
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
    if gaps["top-bottom"]["kCliffFootprints"] == 0:
        failures.append("top-bottom is closed now; MapSymmetry could offer it "
                        "(see engine/src/mirror.h)")

    # The residual gaps, pinned.  Left-right is what the product ships, so its gaps
    # are what a mirrored map may have to report; if a family gains or loses one,
    # the pass's "no piece for this orientation" warning changes meaning.
    for want, kind in ((LR_GAP_SIZES, "left-right"), (R180_GAP_SIZES, "rotational-180")):
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
    if kind == 1:
        return y, x
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
                failures.append(f"{kind_name}: {unmatched} cells have no mirrored "
                                "cell, so the map cannot be symmetric")
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
        for land, label in ((3, "Inland"), (4, "Mountainous")):
            proc_sp0, map_sp0 = generate(0, f"{label.lower()}_plain.yrm",
                                         ["--land", str(land)])
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

        want_top = {"none": 5, "left-right": 5, "rotational-180": 6}
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

        checks += render_cleanliness(failures, map_none, map_lr, tmp_path, "lr")
        for tag, map_plain, map_sym in special_renders:
            checks += render_cleanliness(failures, map_plain, map_sym, tmp_path, tag)

    return checks


def render_cleanliness(failures: list[str], map_none: Path, map_sym: Path,
                       tmp_path: Path, tag: str = "",
                       bound: float | None = None) -> int:
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
    """The same mapping engine/src/mirror.h uses, written out independently here."""
    p = (x - y + Wp - 1) & 1
    k = Wp + Hp + p
    return k - x, k - y


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
        if {rot180_cell(Wp, Hp, *c) for c in u5} != u6:
            failures.append(f"180 degrees is supposed to move the usable rect down "
                            f"exactly one row, and does not for {visW}x{visH}")
    print("  band    left-right keeps the usable rect; 180 needs top 5 -> 6 "
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

        off_by_one = 0
        for (x, y) in cells:
            mx, my = rot180_cell(Wp, Hp, x, y)
            k = Wp + Hp + ((x - y + Wp - 1) & 1)
            reflected = {(k - X, k - Y) for (X, Y) in block(x, y)}
            if reflected != block(mx, my):
                off_by_one += 1
        checks += 1
        if off_by_one != len(cells):
            failures.append(f"the point reflection of a cell's corner block was "
                            f"expected to miss the image cell's block for every cell "
                            f"({off_by_one} of {len(cells)} miss at {visW}x{visH})")

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


def score_matrix(lands=(0, 1, 2, 3, 4), kinds=(1, 2)) -> int:
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
    """
    if not MGCONSOLE.is_file() or not ASSETS.is_dir():
        print("--score needs build/engine/mgconsole and build/oracle_assets; "
              "run tools/verify_all.sh once")
        return 2
    sys.path.insert(0, str(ROOT))
    from maptools.map_ini import parse_map_size

    names = {0: "archipelago", 1: "continent", 2: "team continent",
             3: "inland", 4: "mountainous"}
    kind_names = {1: "left-right", 2: "rotational-180"}
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
    return 0


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

    print()
    if failures:
        print(f"FAILED {len(failures)} check(s)")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"OK -- the mirror mapping holds on {cells_checked} cells, the reflections "
          f"the product offers are closed ({closure_checks} closure checks), the 180 "
          f"corner lattice is incompatible with the cell map ({lattice_checks} checks), "
          f"and a symmetric map decodes back symmetric ({generation_checks} generation "
          f"checks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
