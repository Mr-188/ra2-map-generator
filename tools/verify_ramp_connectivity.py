#!/usr/bin/env python3
"""Connectivity check for ramps (the original game's rule, see docs/RAMPS_REFERENCE.md).

    python3 tools/verify_ramp_connectivity.py <map.yrm> [...]

`gamemd.exe`'s height gate (`FUN_004D9B70`, reverse-engineered in omarelarab/ra2-engine's
docs/re/movement-height.md) only allows a one-level step when the LOWER cell carries a
ramp (`SlopeIndex != 0`); any other height difference is a cliff.  So for every pair of
orthogonally adjacent cells whose Level differs by exactly 1, the lower cell must hold a
slope tile.

Slope tiles, on the tile index scale this project decodes to:
    [Ramps]              29..48   (slope01..20)
    [Slope Set Pieces]  384..393  (ramp01..10)
    [Ramp edge fixup]   510..521  (rmpfx01..12)

Exit 0 when every such step has a slope, 1 otherwise.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from maptools.iso_pack import decode_iso_map_pack
from maptools.map_ini import extract_iso_pack_b64, load_map, parse_map_size


def is_slope(tile):
    return 29 <= tile < 49 or 384 <= tile < 394 or 510 <= tile < 522


def check(path):
    sections = load_map(path)
    w, h = parse_map_size(sections)
    cells = {(t.rx, t.ry): t for t in decode_iso_map_pack(extract_iso_pack_b64(sections), w, h)}
    steps = 0
    bad = []
    for (x, y), t in cells.items():
        for dx, dy in ((1, 0), (0, 1)):          # each edge once
            n = cells.get((x + dx, y + dy))
            if n is None or abs(t.z - n.z) != 1:
                continue
            steps += 1
            low = t if t.z < n.z else n
            if not is_slope(low.tile_index):
                bad.append(((low.rx, low.ry), low.z, low.tile_index))
    return steps, bad


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    failed = False
    for name in argv:
        steps, bad = check(Path(name))
        if bad:
            failed = True
            print(f"FAIL {name}: {len(bad)} of {steps} one-level steps have no ramp on the lower cell")
            for cell, level, tile in bad[:10]:
                print(f"   {cell} level {level} holds tile {tile}")
        else:
            print(f"ok   {name}: all {steps} one-level steps have a ramp on the lower cell")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
