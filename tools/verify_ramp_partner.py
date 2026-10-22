#!/usr/bin/env python3
"""The user's left-right RAMP partner table, checked on a generated map.

    python3 tools/verify_ramp_partner.py <map.yrm> [<map2.yrm> ...]

For every RAMP cell (SlopeSetPieces, the ten `rampNN` pieces) whose (x, y) has x < y, the
cell at the transpose (y, x) must hold the TABLE PARTNER of that piece:

    ramp01 <-> ramp04   ramp02 <-> ramp03   ramp05 <-> ramp08
    ramp06 <-> ramp09   ramp07 <-> ramp10

The table is the user's reading of the art (2026-10-22).  Before the fix the two halves
each carried the SAME piece (R8/R8), which is what this suite fails on.

Exit 0 when every pair matches, 1 otherwise (with the offending cells printed).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from maptools.iso_pack import decode_iso_map_pack
from maptools.map_ini import extract_iso_pack_b64, load_map, parse_map_size

RAMP_BASE = 384                      # SlopeSetPieces: tiles 384..393 = ramp01..10
PARTNER = {1: 4, 2: 3, 3: 2, 4: 1, 5: 8, 6: 9, 7: 10, 8: 5, 9: 6, 10: 7}


def check(path: Path) -> tuple[int, list]:
    sections = load_map(path)
    width, height = parse_map_size(sections)
    cells = {(t.rx, t.ry): t for t in decode_iso_map_pack(extract_iso_pack_b64(sections), width, height)}
    checked = bad = 0
    offenders = []
    for (x, y), t in cells.items():
        if not (RAMP_BASE <= t.tile_index < RAMP_BASE + 10):
            continue
        if x >= y:                   # the low side of the drawn axis is the source
            continue
        mirror = cells.get((y, x))
        want = PARTNER[t.tile_index - RAMP_BASE + 1]
        got = None
        if mirror is not None and RAMP_BASE <= mirror.tile_index < RAMP_BASE + 10:
            got = mirror.tile_index - RAMP_BASE + 1
        checked += 1
        if got != want:
            offenders.append(((x, y), t.tile_index - RAMP_BASE + 1, (y, x), got, want))
    return checked, offenders


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    failed = False
    for name in argv:
        path = Path(name)
        checked, offenders = check(path)
        if not checked:
            print(f"SKIP {path.name}: no ramp pieces (nothing to pair)")
            continue
        if offenders:
            failed = True
            print(f"FAIL {path.name}: {len(offenders)} of {checked} ramp cells lack their table partner")
            for src, sk, dst, got, want in offenders[:10]:
                print(f"   {src} ramp{sk:02d} -> {dst} holds "
                      + (f"ramp{got:02d}" if got else "no ramp") + f", want ramp{want:02d}")
        else:
            print(f"ok   {path.name}: {checked}/{checked} ramp cells mirrored to their table partner")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
