#!/usr/bin/env python3
"""Acceptance for the render path: the loose-file tree we extract must be enough.

CNCMaps reads loose files from a directory (`VirtualFileSystem.AddItem` builds a
`DirArchive` when the path is a directory, and `DirArchive` is non-recursive).
That is the only way it can work in a browser, where the game's `ra2.mix` is
269 MB and cannot be materialised into MEMFS.

So the question this suite answers is: **does our extraction actually cover what
the renderer asks for?**  It renders the same map twice -- once against the
game's own .mix files, once against our extracted directory -- and requires the
two PNGs to be pixel-identical.  If the extraction is short of even one tile,
palette or INI, the images differ.

    python3 tools/verify_render.py [--game-dir DIR] [--keep]

Exits non-zero on any failure.
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

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

BUILD = ROOT / "build"
RENDERER = (ROOT / "reference_impl" / "ccmaps-net" / "CNCMaps.Renderer"
            / "bin" / "Release" / "net10.0" / "CNCMaps.Renderer.dll")
CCMAPS_SRC = ROOT / "reference_impl" / "ccmaps-net" / "CNCMaps.Renderer" / "CNCMaps.Renderer.csproj"


def dotnet_env() -> tuple[str, dict] | None:
    """Locate the privately installed .NET SDK and the env it needs."""
    root = Path(os.environ.get("DOTNET_ROOT") or (Path.home() / "opt" / "dotnet-apt" / "usr" / "lib" / "dotnet"))
    exe = Path(os.environ.get("DOTNET_EXE") or (Path.home() / "opt" / "dotnet-apt" / "usr" / "bin" / "dotnet"))
    if not exe.exists():
        found = shutil.which("dotnet")
        if not found:
            return None
        exe = Path(found)
        root = Path(os.environ.get("DOTNET_ROOT", "/usr/lib/dotnet"))
    env = dict(os.environ)
    env["DOTNET_ROOT"] = str(root)
    env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
    env["DOTNET_NOLOGO"] = "1"
    # The extracted libunwind lives beside the SDK, not on the loader's path.
    unwind = Path.home() / "opt" / "dotnet-apt" / "usr" / "lib" / "x86_64-linux-gnu"
    if unwind.is_dir():
        env["LD_LIBRARY_PATH"] = f"{unwind}:{env.get('LD_LIBRARY_PATH', '')}"
    return str(exe), env


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=900, **kw)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-dir")
    ap.add_argument("--theater", type=int, default=0)
    ap.add_argument("--keep", action="store_true", help="keep the scratch tree")
    args = ap.parse_args()

    if not args.game_dir:
        from maptools.game_dir import find_game_dir
        args.game_dir = find_game_dir()
    if not args.game_dir:
        print("no game directory; pass --game-dir")
        return 2
    game = Path(args.game_dir)

    dn = dotnet_env()
    if dn is None:
        print("dotnet not found; run the SDK fetch first (see AGENTS.md)")
        return 2
    dotnet, env = dn

    if not RENDERER.exists():
        print(f"building the renderer ({CCMAPS_SRC.name}) ...")
        rc = run([dotnet, "build", str(CCMAPS_SRC), "-c", "Release", "-v", "q", "--nologo"], env=env)
        if rc.returncode != 0:
            print(rc.stdout[-2000:], rc.stderr[-2000:])
            return 2

    failures: list[str] = []
    scratch = ROOT / "build" / "render_acceptance"
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir(parents=True)

    # ---- 1. extract, then flatten ----------------------------------------
    print("  extract  materialising the loose-file tree")
    rc = run([str(BUILD / "engine" / "mgextract"),
              "--game-dir", str(game), "--out", str(scratch / "assets"),
              "--theater", str(args.theater)])
    if rc.returncode != 0:
        print(rc.stdout[-1500:], rc.stderr[-1500:])
        return 2
    tail = [l for l in rc.stdout.splitlines() if "Tile资源" in l]
    if tail:
        print(f"           {tail[-1].strip()}")

    flat = scratch / "flat"          # DirArchive is non-recursive, so one level
    flat.mkdir()
    exe_dir = scratch / "assets" / "x64" / "Release"
    tile_dir = next((scratch / "assets" / "Tile资源").iterdir())
    for src in list(exe_dir.glob("*")) + list(tile_dir.glob("*")):
        if src.is_file():
            shutil.copy2(src, flat / src.name)
    n_tem = len(list(flat.glob("*.tem")))
    print(f"  flat     {len(list(flat.iterdir()))} files ({n_tem} .tem)")

    # ---- 2. a map to render ----------------------------------------------
    out_map = scratch / "probe.map"
    rc = run([str(BUILD / "engine" / "mgconsole"),
              "--root", str(scratch / "assets"), "--land", "1",
              "--theater", str(args.theater), "--size", "1", "--players", "2",
              "--seed", "20260913", "--out", str(out_map)])
    if rc.returncode != 0 or not out_map.exists():
        print("map generation failed:", rc.stdout[-800:], rc.stderr[-800:])
        return 2

    # ---- 3. render twice, once per asset source --------------------------
    def render(mixdir: Path, out: Path) -> Path:
        rc = run([dotnet, str(RENDERER), "-i", str(out_map), "-m", str(mixdir),
                  "-p", "-o", str(out), "-Y"], env=env, cwd=str(scratch))
        png = out.with_suffix(".png")
        if rc.returncode != 0 or not png.exists():
            raise RuntimeError(f"render against {mixdir} failed:\n"
                               + rc.stderr[-1500:] + rc.stdout[-1500:])
        return png

    print("  render   against the game's own .mix files")
    try:
        png_game = render(game, scratch / "from_game")
        print("  render   against our extracted directory (no .mix involved)")
        png_flat = render(flat, scratch / "from_flat")
    except RuntimeError as exc:
        print(f"FAILED: {exc}")
        return 1

    # ---- 4. compare -------------------------------------------------------
    try:
        from PIL import Image
        a = Image.open(png_game).convert("RGB")
        b = Image.open(png_flat).convert("RGB")
        same_size = a.size == b.size
        same_pixels = same_size and a.tobytes() == b.tobytes()
        detail = f"{a.size[0]}x{a.size[1]}"
    except ImportError:                                    # pragma: no cover
        same_size = png_game.stat().st_size == png_flat.stat().st_size
        same_pixels = (hashlib.md5(png_game.read_bytes()).digest()
                       == hashlib.md5(png_flat.read_bytes()).digest())
        detail = f"{png_game.stat().st_size} B"

    print(f"  compare  {detail}  game={png_game.stat().st_size} B  "
          f"loose={png_flat.stat().st_size} B")
    if not same_size:
        failures.append("the two renders differ in size")
    elif not same_pixels:
        failures.append("the loose-file tree does not reproduce the .mix render")

    if not args.keep:
        shutil.rmtree(scratch, ignore_errors=True)
    else:
        print(f"  (kept {scratch})")

    print()
    if failures:
        print(f"FAILED {len(failures)} checks")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("OK -- the extracted loose-file tree renders identically to the game's .mix files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
