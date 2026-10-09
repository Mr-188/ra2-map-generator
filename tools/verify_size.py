#!/usr/bin/env python3
"""The sizeSlider limits are the engine's, it enforces them, and it is fractional.

This is the acceptance test for the "one definition" rule.  Three things used to
disagree, or not exist:

  * the page hard-coded "past 4 nothing changes" -- a hand transcription of
    ``kSizeFractionMax`` that would have gone stale silently;
  * the 512-cell [OverlayPack] wall was not written down anywhere: it existed
    only as a ``continue`` in the writer, so an oversized map came out missing
    ore and objects with no error at all;
  * nothing validated the size at either entry point.

And a fourth thing was simply missing: ``sizeSlider`` was an ``int``, so the
engine's own arithmetic -- ``W = Wmin*(1-f) + Wmax*f`` with ``f = size/3`` --
could only ever land on every third of the way from Wmin to Wmax, and the useful
stop (``kSizeFractionMax`` = 1.2, i.e. size 3.6) was unreachable.

Now ``RandomMapGenerator::SizeSliderRange`` is the only place the bounds exist,
``mgconsole --size-range`` and ``mg_size_*`` are the only ways to read them,
``SaveMapFile`` refuses rather than truncates, and the parameter is a double.

This suite pins all of it:

  1. the reported range is self-consistent (0 <= useful <= legal)
  2. the useful bound is real: at useful the map generates, and one step further
     produces the same map size
  3. FRACTIONS WORK: 1.5 lands strictly between 1 and 2, and the useful stop on a
     clamped land type (3.6) is reachable and larger than 3
  4. the legal bound fits the overlay grid, and legal+step is REFUSED -- non-zero
     exit and no map written
  5. the wasm build reports the same bounds as the native one, so the page cannot
     be shown a different range than the generator enforces

Usage::

    python3 tools/verify_size.py [--game-dir PATH]
"""

from __future__ import annotations

import argparse
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

MGCONSOLE = ROOT / "build" / "engine" / "mgconsole"
MGEXTRACT = ROOT / "build" / "engine" / "mgextract"
WASM_JS = ROOT / "build" / "engine-wasm" / "mgconsole.js"

# The overlay layer is a fixed 512x512 grid; this is the wall the writer used to
# fall through silently.  Kept here only to sanity-check the reported bound --
# the suite never uses it to decide what is legal.
OVERLAY_GRID = 512

RANGE_LINE = re.compile(
    r"land=(\d+) players=(\d+) useful=([0-9.]+) legal=([0-9.]+) step=([0-9.]+)")
SIZE_LINE = re.compile(r"^\s*Size\s*=\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*,\s*(\d+)", re.M)

TOL = 1e-6


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def size_range(mg: str, land: int, players: int) -> tuple[float, float, float]:
    """Ask the engine itself for the bounds and the step it scans at."""
    proc = run([mg, "--size-range", "--land", str(land), "--players", str(players)])
    if proc.returncode != 0:
        raise RuntimeError(f"--size-range failed: {proc.stderr.strip()}")
    m = RANGE_LINE.search(proc.stdout)
    if not m:
        raise RuntimeError(f"--size-range printed nothing parseable: {proc.stdout!r}")
    return float(m.group(3)), float(m.group(4)), float(m.group(5))


def dimensions(map_path: Path) -> tuple[int, int] | None:
    if not map_path.is_file():
        return None
    m = SIZE_LINE.search(map_path.read_text(encoding="latin-1", errors="replace"))
    return (int(m.group(1)), int(m.group(2))) if m else None


def generate(mg: str, assets: Path, land: int, players: int, size: float,
             out: Path) -> subprocess.CompletedProcess:
    return run([mg, "--root", str(assets), "--land", str(land), "--theater", "0",
                "--time", "0", "--size", f"{size:.3f}", "--players", str(players),
                "--ore", "1", "--water", "30", "--seed", "20260913",
                "--out", str(out)])


def dims_at(mg: str, assets: Path, work: Path, land: int, players: int,
            size: float, tag: str) -> tuple[int, int] | None:
    out = work / f"l{land}p{players}_{tag}.map"
    if out.exists():
        out.unlink()
    generate(mg, assets, land, players, size, out)
    return dimensions(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mgconsole", default=str(MGCONSOLE))
    ap.add_argument("--mgextract", default=str(MGEXTRACT))
    ap.add_argument("--wasm", default=str(WASM_JS))
    ap.add_argument("--game-dir", default=None)
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
    checks = 0

    work = Path(tempfile.mkdtemp(prefix="mg_size_"))
    assets = work / "assets"
    try:
        proc = run([args.mgextract, "--game-dir", str(game), "--out", str(assets),
                    "--theater", "0"])
        if proc.returncode != 0:
            print(proc.stdout)
            print(proc.stderr, file=sys.stderr)
            return 1

        # ---- 1-4. per (land, players) ---------------------------------------
        # Land 3 (Inland) and 4 (Mountainous) are the ones with no clamp, i.e. the
        # only ones whose legal bound is finite; the other three clamp, so their
        # legal bound is the grid itself and can never be reached.
        for land in range(5):
            for players in (2, 4, 8):
                useful, legal, step = size_range(args.mgconsole, land, players)

                checks += 1
                if not (0.0 <= useful <= legal + TOL):
                    failures.append(f"land={land} players={players}: "
                                    f"useful={useful} legal={legal} is not 0<=useful<=legal")
                    continue
                checks += 1
                if step <= 0:
                    failures.append(f"land={land} players={players}: step={step}")
                    continue

                clamped = useful < legal - TOL

                # (2) at the useful bound the map generates, and one step further
                #     changes nothing.
                here = dims_at(args.mgconsole, assets, work, land, players, useful,
                               f"u{useful:.1f}")
                checks += 1
                if here is None:
                    failures.append(f"land={land} players={players}: "
                                    f"size {useful} (the useful max) wrote no map")
                    continue
                if useful + step <= legal + TOL:
                    nxt = dims_at(args.mgconsole, assets, work, land, players,
                                  round(useful + step, 3), f"u{useful + step:.1f}")
                    checks += 1
                    if nxt is not None and nxt != here:
                        failures.append(
                            f"land={land} players={players}: size {useful + step} "
                            f"changed the size to {nxt}, so useful={useful} is not "
                            f"the useful max")

                # (3) fractions must actually do something.  Two ways: 1.5 lands
                #     between 1 and 2, and on a clamped land type the useful stop
                #     (3.6) is reachable and bigger than 3.
                d1 = dims_at(args.mgconsole, assets, work, land, players, 1.0, "f1")
                d15 = dims_at(args.mgconsole, assets, work, land, players, 1.5, "f15")
                d2 = dims_at(args.mgconsole, assets, work, land, players, 2.0, "f2")
                checks += 1
                if None in (d1, d15, d2):
                    failures.append(f"land={land} players={players}: fractional sizes "
                                    f"did not all generate ({d1} {d15} {d2})")
                elif not (d1[0] < d15[0] < d2[0]):
                    failures.append(
                        f"land={land} players={players}: 1.5 gave {d15}, which is not "
                        f"strictly between 1.0 ({d1}) and 2.0 ({d2}) -- fractions are "
                        f"not reaching CalcMapSize")

                if clamped:
                    checks += 1
                    d3 = dims_at(args.mgconsole, assets, work, land, players, 3.0, "f3")
                    if d3 is None or here[0] <= d3[0]:
                        failures.append(
                            f"land={land} players={players}: the useful stop {useful} "
                            f"({here}) is not larger than 3.0 ({d3}); the fractional "
                            f"head-room is not being used")

                # (4) the legal bound fits the grid, and one step past it is refused.
                top = dims_at(args.mgconsole, assets, work, land, players, legal,
                              f"top{legal:.1f}")
                checks += 1
                if top is None:
                    failures.append(f"land={land} players={players}: "
                                    f"size {legal} (the legal max) wrote no map")
                elif top[0] + top[1] + 1 > OVERLAY_GRID:
                    failures.append(f"land={land} players={players}: size {legal} needs "
                                    f"workSide {top[0] + top[1] + 1} > {OVERLAY_GRID}")

                if legal < OVERLAY_GRID:
                    over = work / f"over_l{land}p{players}.map"
                    if over.exists():
                        over.unlink()
                    proc = generate(args.mgconsole, assets, land, players,
                                    round(legal + step, 3), over)
                    checks += 1
                    if proc.returncode == 0 or over.exists():
                        failures.append(
                            f"land={land} players={players}: size {legal + step} "
                            f"(one step past legal) was accepted "
                            f"(rc={proc.returncode}, map written={over.exists()})")

            print(f"  land={land}  checked")

        # ---- 5. the wasm build must report the same bounds -------------------
        # build_wasm.sh compiles this same mgconsole.cpp, so the wasm console
        # answers --size-range too.  Comparing it against the native binary is what
        # makes "the page is shown the range the generator enforces" true rather
        # than assumed.
        if Path(args.wasm).is_file():
            node = shutil.which("node")
            if node:
                for land in (0, 1, 3):
                    for players in (2, 8):
                        checks += 1
                        try:
                            nat = size_range(args.mgconsole, land, players)
                        except RuntimeError as exc:
                            failures.append(f"native --size-range land={land} "
                                            f"players={players}: {exc}")
                            continue
                        proc = run([node, str(args.wasm), "--size-range",
                                    "--land", str(land), "--players", str(players)])
                        m = RANGE_LINE.search(proc.stdout)
                        if proc.returncode != 0 or not m:
                            failures.append(
                                f"wasm --size-range land={land} players={players} "
                                f"failed: rc={proc.returncode} {proc.stderr.strip()[:80]}")
                            continue
                        wasm = (float(m.group(3)), float(m.group(4)), float(m.group(5)))
                        if any(abs(a - b) > TOL for a, b in zip(wasm, nat)):
                            failures.append(
                                f"wasm and native disagree on the size range for "
                                f"land={land} players={players}: "
                                f"wasm useful={wasm[0]} legal={wasm[1]} step={wasm[2]} vs "
                                f"native useful={nat[0]} legal={nat[1]} step={nat[2]}")
                print("  wasm     compared against native")
            else:
                print("  wasm     (skipped: node not on PATH)")
        else:
            print("  wasm     (skipped: build/engine-wasm/mgconsole.js absent)")

        print()
        if failures:
            print(f"FAILED {len(failures)} of {checks} checks")
            for f in failures:
                print(f"  - {f}")
            return 1
        print(f"OK -- {checks} checks, the size limits are the engine's, it enforces "
              f"them, and the parameter is fractional")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
