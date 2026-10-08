#!/usr/bin/env python3
"""Prove the WebAssembly build is faithful, before any browser code exists.

Compiled with `-sNODERAWFS=1`, the wasm build reads the same extraction tree the
native oracle does, so the two must produce a byte-identical map.  If they do,
the later browser front end only has to swap the filesystem backend -- the
algorithm and the whole MIX/INI layer are already known good in wasm.

Usage::

    sh engine/build_oracle.sh
    sh engine/build_wasm.sh          # needs em++ on PATH
    python3 tools/verify_wasm.py
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from maptools.game_dir import find_game_dir  # noqa: E402

# One fixed argument set.  Determinism is already covered by verify_oracle.py;
# what matters here is that both builds agree on the bytes.
ARGS = ["--land", "1", "--theater", "0", "--size", "1", "--players", "2",
        "--seed", "20260913"]


def run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, cwd=cwd,
                          env={**os.environ})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--native", default=str(ROOT / "build" / "engine" / "mgconsole"))
    ap.add_argument("--wasm-js", default=str(ROOT / "build" / "engine-wasm" / "mgconsole.js"))
    ap.add_argument("--mgextract", default=str(ROOT / "build" / "engine" / "mgextract"))
    ap.add_argument("--game-dir", default=None)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    native = Path(args.native)
    wasm_js = Path(args.wasm_js)
    if not native.is_file():
        print(f"native oracle not built: {native}\n  run: sh engine/build_oracle.sh",
              file=sys.stderr)
        return 2
    if not wasm_js.is_file():
        print(f"wasm build not found: {wasm_js}\n  run: sh engine/build_wasm.sh",
              file=sys.stderr)
        return 2

    node = shutil.which("node")
    if not node:
        print("node not on PATH", file=sys.stderr)
        return 2

    game = Path(args.game_dir) if args.game_dir else find_game_dir()
    if not game or not Path(game).is_dir():
        print(f"game dir not found: {game}", file=sys.stderr)
        return 2
    game = Path(game)

    work = Path(tempfile.mkdtemp(prefix="mg_wasm_"))
    failures: list[str] = []
    try:
        assets = work / "assets"
        proc = run([args.mgextract, "--game-dir", str(game), "--out", str(assets),
                    "--theater", "0"])
        if proc.returncode != 0:
            print(proc.stderr, file=sys.stderr)
            return 1

        results: dict[str, Path] = {}
        for label, cmd in (
            ("native", [str(native), "--root", str(assets)] + ARGS),
            ("wasm", [node, str(wasm_js), "--root", str(assets)] + ARGS),
        ):
            out = work / f"{label}.map"
            proc = run(cmd + ["--out", str(out)])
            if proc.returncode != 0 or not out.is_file():
                tail = (proc.stdout + proc.stderr).strip().splitlines()[-6:]
                failures.append(f"{label}: exit {proc.returncode}; " + " | ".join(tail))
                continue
            results[label] = out
            digest = hashlib.md5(out.read_bytes()).hexdigest()
            print(f"  {label:6} {out.stat().st_size:>9} B  md5={digest}")

        if len(results) == 2:
            a = hashlib.md5(results["native"].read_bytes()).hexdigest()
            b = hashlib.md5(results["wasm"].read_bytes()).hexdigest()
            if a != b:
                failures.append(f"byte mismatch: native {a} vs wasm {b}")

        print()
        if failures:
            print(f"FAILED {len(failures)} checks")
            for f in failures:
                print(f"  - {f}")
            return 1
        print("OK -- the WebAssembly build is byte-identical to the native build")
        return 0
    finally:
        if args.keep:
            print(f"(kept {work})")
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
