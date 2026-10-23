#!/usr/bin/env python3
"""Corner-height check for the left-right slope mirror (docs/RAMPS_REFERENCE.md).

    python3 tools/verify_slope_corners.py <map.yrm> [...]

A slope tile's identity is its four corner heights, not its number (OpenRA's RampTiler
keys pieces by `tl | (tr << 2) | (br << 4) | (bl << 6)`).  This project keeps the same
relation in `kSlopeCornerMirror` (MapGenHills.cpp): a left-right mirror swaps corners 1
and 3, so a cell and its transposed partner must hold slopes whose corner patterns are
each other's transpose.

The check, per mirrored pair of cells that BOTH hold a slope-family tile:
  * corner pattern of the east cell == transpose of the west cell's pattern;
  * and the cell's Level matches.
Cells where only one side holds a slope are reported separately (they cannot form a
pair by construction).

Exit 0 when no pair disagrees, 1 otherwise.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from maptools.iso_pack import decode_iso_map_pack
from maptools.map_ini import extract_iso_pack_b64, load_map, parse_map_size

# SlopeIndex -> four corner heights, from MapGenHills.cpp's kSlopeCorners (the table the
# generator itself matches the elevation grid against).
SLOPE_CORNERS = {
    0: (0, 0, 0, 0), 1: (0, 15, 15, 0), 2: (0, 0, 15, 15), 3: (15, 0, 0, 15),
    4: (15, 15, 0, 0), 5: (0, 0, 15, 0), 6: (0, 0, 0, 15), 7: (15, 0, 0, 0),
    8: (0, 15, 0, 0), 9: (0, 15, 15, 15), 10: (15, 0, 15, 15), 11: (15, 15, 0, 15),
    12: (15, 15, 15, 0), 13: (0, 15, 30, 15), 14: (15, 0, 15, 30), 15: (30, 15, 0, 15),
    16: (15, 30, 15, 0), 17: (0, 15, 0, 15), 18: (15, 0, 15, 0),
}


def slope_of(tile):
    """SlopeIndex of a decoded tile, or None when it is not a slope tile.

    The [Ramps] family is slope01..20 at 29..48, so SlopeIndex = tile - 28 (slope01 is
    index 1).  rmpfx / SlopeSetPieces cells carry no per-cell corner pattern here; they
    are reported as their own kind and skipped.
    """
    if 29 <= tile < 49:
        return tile - 28
    return None


def transpose(corners):
    # left-right mirror: (c0, c1, c2, c3) -> (c0, c3, c2, c1)
    return (corners[0], corners[3], corners[2], corners[1])


def check(path):
    sections = load_map(path)
    w, h = parse_map_size(sections)
    cells = {(t.rx, t.ry): t for t in decode_iso_map_pack(extract_iso_pack_b64(sections), w, h)}
    pairs = 0
    mismatched = []
    one_sided = 0
    for (x, y), t in cells.items():
        if x >= y:
            continue
        m = cells.get((y, x))
        if m is None:
            continue
        sw, se = slope_of(t.tile_index), slope_of(m.tile_index)
        if sw is None and se is None:
            continue
        if sw is None or se is None:
            one_sided += 1
            continue
        pairs += 1
        want = transpose(SLOPE_CORNERS[sw])
        got = SLOPE_CORNERS[se]
        if want != got or t.z != m.z:
            mismatched.append(((x, y), sw, (y, x), se, t.z, m.z))
    return pairs, one_sided, mismatched


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    failed = False
    for name in argv:
        pairs, one_sided, bad = check(Path(name))
        if bad:
            failed = True
            print(f"FAIL {name}: {len(bad)} of {pairs} mirrored slope pairs disagree "
                  f"({one_sided} pairs have a slope on one side only)")
            for src, sw, dst, se, lw, le in bad[:10]:
                print(f"   {src} slope{sw:02d} L{lw} -> {dst} slope{se:02d} L{le}")
        else:
            print(f"ok   {name}: {pairs}/{pairs} mirrored slope pairs have transposed "
                  f"corner patterns and equal levels ({one_sided} one-sided)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
