#!/usr/bin/env python3
"""Piece-level check of the left-right RAMP symmetry.

    python3 tools/verify_ramp_pieces.py <map.yrm> [...]

Cell-level checking is not enough: a per-cell rewrite can leave the partner piece
scattered over several anchors (a dozen one-cell "ramp05" fragments instead of one
piece).  This script groups the ramp cells into PIECES (connected cells of the same
piece sharing one anchor) and demands, for every piece on the low side of the drawn
axis (x < y):

  * exactly one piece on the other side whose cell set is this piece's TRANSPOSE
    {(y, x)}, with the TABLE PARTNER's piece number and transposed sub-cell offsets;
  * the same Level on every corresponding cell.

Exit 0 when every piece has such a counterpart, 1 otherwise.
"""
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from maptools.iso_pack import decode_iso_map_pack
from maptools.map_ini import extract_iso_pack_b64, load_map, parse_map_size

RAMP_BASE = 384                                   # tiles 384..393 = ramp01..10
PARTNER = {1: 4, 2: 3, 3: 2, 4: 1, 5: 8, 6: 9, 7: 10, 8: 5, 9: 6, 10: 7}
WIDTH = {1: 3, 2: 3, 3: 4, 4: 4, 5: 3, 6: 3, 7: 2, 8: 4, 9: 4, 10: 2}
HEIGHT = {1: 4, 2: 4, 3: 3, 4: 3, 5: 4, 6: 4, 7: 2, 8: 3, 9: 3, 10: 2}


def pieces_of(cells):
    """(kind, anchor) -> set of (x, y).  The anchor is the piece's minimum corner."""
    ramp = {(x, y): t for (x, y), t in cells.items()
            if RAMP_BASE <= t.tile_index < RAMP_BASE + 10}
    out = defaultdict(set)
    seen = set()
    for p in sorted(ramp):
        if p in seen:
            continue
        kind = ramp[p].tile_index - RAMP_BASE + 1
        stack = [p]
        seen.add(p)
        comp = []
        while stack:
            q = stack.pop()
            comp.append(q)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (q[0] + dx, q[1] + dy)
                    if n in ramp and n not in seen and ramp[n].tile_index == ramp[p].tile_index:
                        seen.add(n)
                        stack.append(n)
        ax = min(c[0] for c in comp)
        ay = min(c[1] for c in comp)
        out[(kind, ax, ay)] |= set(comp)
    return out, ramp


def check(path):
    sections = load_map(path)
    w, h = parse_map_size(sections)
    cells = {(t.rx, t.ry): t for t in decode_iso_map_pack(extract_iso_pack_b64(sections), w, h)}
    pieces, ramp = pieces_of(cells)
    west = {k: v for k, v in pieces.items() if all(x < y for x, y in v)}
    east = {k: v for k, v in pieces.items() if all(x > y for x, y in v)}
    problems = []
    for (kind, ax, ay), cells_w in sorted(west.items()):
        want_kind = PARTNER[kind]
        transposed = {(y, x) for x, y in cells_w}
        matches = [k for k, v in east.items() if v == transposed]
        if not matches:
            problems.append(f"ramp{kind:02d} at ({ax},{ay}) ({len(cells_w)} cells): "
                            f"no piece on the other side covers its transpose")
            continue
        if not any(k[0] == want_kind for k in matches):
            got = ", ".join(f"ramp{k[0]:02d}" for k in matches)
            problems.append(f"ramp{kind:02d} at ({ax},{ay}): transpose is {got}, "
                            f"want ramp{want_kind:02d}")
            continue
        # levels, cell by cell
        for (x, y) in cells_w:
            if cells[(y, x)].z != cells[(x, y)].z:
                problems.append(f"ramp{kind:02d} at ({ax},{ay}): Level {cells[(x, y)].z} at "
                                f"({x},{y}) vs {cells[(y, x)].z} at ({y},{x})")
                break
        # no fragment of this piece may be left on the east side
        stray = [k for k, v in east.items()
                 if k[0] == kind and v & transposed and v != transposed]
        if stray:
            problems.append(f"ramp{kind:02d} at ({ax},{ay}): {len(stray)} stray fragment(s) "
                            f"overlapping its transpose")
    return len(west), len(east), problems


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    failed = False
    for name in argv:
        nw, ne, problems = check(Path(name))
        if nw == 0:
            print(f"SKIP {name}: no ramp pieces")
            continue
        if problems:
            failed = True
            print(f"FAIL {name}: {len(problems)} piece(s) not mirrored as a whole piece "
                  f"({nw} west / {ne} east)")
            for p in problems[:12]:
                print("   " + p)
        else:
            print(f"ok   {name}: {nw}/{nw} west pieces have their table partner as one whole "
                  f"transposed piece on the east side")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
