#!/usr/bin/env python3
"""Is there a ramp on BOTH sides of the mirror?  (User's criterion, 2026-10-23.)

    python3 tools/verify_ramp_presence.py <map.yrm> [...]

Piece identity does not matter here: the requirement is that every mirrored position
that carries ramp art on one side carries ramp art on the other side too, so both halves
can be climbed.  A "ramp cell" is any tile of the three slope families:

    [Ramps]              29..48    (slope01..20)
    [Slope Set Pieces]  384..393   (ramp01..10)
    [Ramp edge fixup]   510..521   (rmpfx01..12)

Counts, per mirrored pair (only pairs inside the diamond):
    both   - both cells carry ramp art
    one    - exactly one side does  (listed, these are the ones to fill in)
    none   - neither side does      (not a ramp, nothing to compare)

Exit 0 when there are no one-sided pairs, 1 otherwise.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from maptools.iso_pack import decode_iso_map_pack
from maptools.map_ini import extract_iso_pack_b64, load_map, parse_map_size


def is_ramp(tile):
    return 29 <= tile < 49 or 384 <= tile < 394 or 510 <= tile < 522


def check(path):
    sections = load_map(path)
    w, h = parse_map_size(sections)
    cells = {(t.rx, t.ry): t for t in decode_iso_map_pack(extract_iso_pack_b64(sections), w, h)}
    both = none = 0
    one = []
    for (x, y), t in cells.items():
        if x >= y:
            continue
        m = cells.get((y, x))
        if m is None:
            continue
        a, b = is_ramp(t.tile_index), is_ramp(m.tile_index)
        if a and b:
            both += 1
        elif a or b:
            one.append(((x, y), t.tile_index if a else None,
                        (y, x), m.tile_index if b else None))
        else:
            none += 1
    return both, one, none


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    failed = False
    for name in argv:
        both, one, none = check(Path(name))
        total = both + len(one) + none
        print(f"{name}: mirrored pairs {total}  both-ramp {both}  one-sided {len(one)}  neither {none}")
        for w_cell, w_tile, e_cell, e_tile in one[:15]:
            side = "west" if w_tile is not None else "east"
            tile = w_tile if w_tile is not None else e_tile
            print(f"   {side} has tile {tile} at {w_cell} / {e_cell}: the other side has none")
        if one:
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
