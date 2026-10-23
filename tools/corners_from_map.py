#!/usr/bin/env python3
"""Recover each slope cell's four corner heights from the map alone.

    python3 tools/corners_from_map.py <map.yrm> [...]

A slope tile is the ramp piece whose RampType says which corners are low (measured:
`slopeNN.tem`'s own header carries RampType = NN, so the tile number IS the RampType).
The corner table the generator matches against is `kSlopeCorners[19][4]` in
MapGenHills.cpp (0 / 15 / 30 per corner).  So for a cell holding `slopeNN`:

    corner heights (relative) = kSlopeCorners[NN]

and the cell's own Level is the base.  A cell whose four corner values are ALL equal
has nothing to climb - that is the definition of a "fake slope" this check looks for.

Also reports the same statistic using the orthogonal-neighbour levels, so the two
readings can be compared side by side.
"""
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from maptools.iso_pack import decode_iso_map_pack
from maptools.map_ini import extract_iso_pack_b64, load_map, parse_map_size

# MapGenHills.cpp kSlopeCorners[19][4]: corner order e(x,y), e(x+1,y), e(x+1,y+1), e(x,y+1)
SLOPE_CORNERS = {
    0: (0, 0, 0, 0), 1: (0, 15, 15, 0), 2: (0, 0, 15, 15), 3: (15, 0, 0, 15),
    4: (15, 15, 0, 0), 5: (0, 0, 15, 0), 6: (0, 0, 0, 15), 7: (15, 0, 0, 0),
    8: (0, 15, 0, 0), 9: (0, 15, 15, 15), 10: (15, 0, 15, 15), 11: (15, 15, 0, 15),
    12: (15, 15, 15, 0), 13: (0, 15, 30, 15), 14: (15, 0, 15, 30),
    15: (30, 15, 0, 15), 16: (15, 30, 15, 0), 17: (0, 15, 0, 15), 18: (15, 0, 15, 0),
}
RAMP_BASE = 29          # slope01..20 at 29..48; SlopeIndex = tile - 28


def check(path):
    sections = load_map(path)
    w, h = parse_map_size(sections)
    cells = {(t.rx, t.ry): t for t in decode_iso_map_pack(extract_iso_pack_b64(sections), w, h)}
    total = flat = 0
    flat_by_slope = Counter()
    for (x, y), t in cells.items():
        if not (RAMP_BASE <= t.tile_index < RAMP_BASE + 20):
            continue
        total += 1
        pattern = SLOPE_CORNERS.get(t.tile_index - RAMP_BASE + 1)
        if pattern is None:
            continue
        if len(set(pattern)) == 1:              # all four corners the same height
            flat += 1
            flat_by_slope[t.tile_index - RAMP_BASE + 1] += 1
    # the weaker, neighbour-based reading, for comparison
    neighbour_flat = 0
    for (x, y), t in cells.items():
        if not (RAMP_BASE <= t.tile_index < RAMP_BASE + 20):
            continue
        nb = [cells[(x + dx, y + dy)].z for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
              if (x + dx, y + dy) in cells]
        if nb and len(set(nb + [t.z])) == 1:
            neighbour_flat += 1
    return total, flat, flat_by_slope, neighbour_flat


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    for name in argv:
        total, flat, by_slope, nb_flat = check(Path(name))
        print(f"{name}: slope cells {total}")
        print(f"   corner-pattern flat (fake slope): {flat}" + (f"  by piece {dict(sorted(by_slope.items()))}" if flat else ""))
        print(f"   orthogonal-neighbour flat        : {nb_flat}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
