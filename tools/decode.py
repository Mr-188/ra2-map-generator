#!/usr/bin/env python3
"""Decode compressed RA2/YR IsoMapPack5 terrain into readable summary / grid / JSON."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from maptools.iso_pack import decode_iso_map_pack
from maptools.map_ini import extract_iso_pack_b64, load_map, parse_map_size, parse_theater
from maptools.overlay_layer import OverlayLayer
from maptools.terrain_json import enrich_cell
from maptools.tile_map import theater_ini_path
from maptools.tileset_names import classify_kind, load_tileset_ini, tile_label


GRID_CHARS = {
    "clear": ".",
    "shore": "=",
    "water": "~",
    "terrain": "#",
    "other": "?",
}


def decode_map(
    map_path: Path,
    ini_path: Path | None = None,
    *,
    roi: tuple[int, int, int] | None = None,
    kinds: set[str] | None = None,
) -> dict:
    sections = load_map(map_path)
    width, height = parse_map_size(sections)
    theater = parse_theater(sections)
    tiles = decode_iso_map_pack(extract_iso_pack_b64(sections), width, height)
    overlay = OverlayLayer.from_sections(sections)
    if ini_path is None:
        # Use the map's own theater control INI so tile names are correct for
        # non-temperate maps instead of being labelled against temperate.
        ini_path = theater_ini_path(theater)
    ini = load_tileset_ini(str(ini_path) if ini_path else None)

    cells = []
    counts: Counter[int] = Counter()
    ore_counts: Counter[int] = Counter()
    for tile in tiles:
        if roi is not None:
            cx, cy, radius = roi
            if abs(tile.rx - cx) + abs(tile.ry - cy) > radius:
                continue
        counts[tile.tile_index] += 1
        cell = enrich_cell(tile.to_dict(), ini, theater=theater)
        if kinds is not None and cell["kind"] not in kinds:
            continue
        ovl = overlay.get_overlay(tile.rx, tile.ry)
        if ovl:
            oid, oval = ovl
            cell["overlay"] = oid
            cell["overlay_value"] = oval
            if 102 <= oid <= 121:
                cell["overlay_kind"] = "ore"
                ore_counts[oid] += 1
            elif 27 <= oid <= 38:
                cell["overlay_kind"] = "gem"
            else:
                cell["overlay_kind"] = "overlay"
        cells.append(cell)

    return {
        "source": str(map_path.resolve()),
        "theater": theater,
        "width": width,
        "height": height,
        "cell_count": len(cells),
        "note": (
            "Edit tile_index / sub_tile / z / ice (and optional overlay). "
            "kind/name/shore_offset are informational. "
            "Apply with: python encode.py <this.json> -o <out.yrm>"
        ),
        "tile_index_counts": {
            str(k): {
                "count": v,
                "name": tile_label(ini, k, theater=theater),
                "kind": classify_kind(ini, k),
            }
            for k, v in sorted(counts.items())
        },
        "ore_overlay_counts": {str(k): v for k, v in sorted(ore_counts.items())},
        "cells": cells,
        "_ini": ini,
    }


def build_ascii_grid(data: dict) -> str:
    w, h = data["width"], data["height"]
    tile_map = {(c["rx"], c["ry"]): c for c in data["cells"]}
    lines = [
        f"# {data['source']}  {w}x{h}  theater={data['theater']}",
        "# legend: .=clear  ==shore  ~=water  #=terrain  o=ore  ?=other",
        "",
    ]
    for ry in range(1, h + 1):
        row = []
        for rx in range(1, w + 1):
            cell = tile_map.get((rx, ry))
            if cell is None:
                row.append(".")
            elif cell.get("overlay_kind") == "ore":
                row.append("o")
            else:
                row.append(GRID_CHARS.get(cell["kind"], "?"))
        lines.append("".join(row))
    return "\n".join(lines) + "\n"


def print_summary(data: dict) -> None:
    print(f"Map: {data['source']}")
    print(
        f"Theater: {data['theater']}  Size: {data['width']}x{data['height']}  "
        f"Cells: {data['cell_count']}"
    )
    print("\nTileIndex counts:")
    for key, info in data["tile_index_counts"].items():
        print(
            f"  {int(key):5d}  {info['kind']:8s}  {info['count']:6d}  {info['name']}"
        )
    if data.get("ore_overlay_counts"):
        print("\nOre overlay counts (TIB):")
        for key, count in data["ore_overlay_counts"].items():
            print(f"  overlay {int(key):3d}: {count}")
    print("\nTip: -f json --pretty -o terrain.json")
    print("     python encode.py terrain.json -o edited.yrm")


def _parse_roi(text: str) -> tuple[int, int, int]:
    parts = [p.strip() for p in text.replace(" ", ",").split(",") if p.strip()]
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("ROI must be rx,ry,radius")
    return int(parts[0]), int(parts[1]), int(parts[2])


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Decode compressed IsoMapPack5 terrain into readable formats"
    )
    parser.add_argument("map", type=Path, help="Path to .yrm / .map / .mpr")
    parser.add_argument(
        "-f",
        "--format",
        choices=("summary", "grid", "json"),
        default="summary",
        help="Output format (default: summary)",
    )
    parser.add_argument("-o", "--output", type=Path, help="Output file (grid/json)")
    parser.add_argument(
        "--ini",
        type=Path,
        default=None,
        help="Theater control INI for tile names (default: the map's own theater)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        default=True,
        help="Pretty-print JSON (default on)",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Compact JSON (no indent)",
    )
    parser.add_argument(
        "--roi",
        type=_parse_roi,
        default=None,
        help="Only export cells near rx,ry within manhattan radius (e.g. 24,24,6)",
    )
    parser.add_argument(
        "--kinds",
        type=str,
        default=None,
        help="Comma-separated kinds to keep: clear,shore,water,terrain,other",
    )
    args = parser.parse_args()

    map_path = args.map if args.map.is_absolute() else ROOT / args.map
    if not map_path.exists():
        parser.error(f"Map not found: {map_path}")

    ini_path = args.ini
    if ini_path is not None and not ini_path.is_absolute():
        ini_path = ROOT / ini_path

    kinds = None
    if args.kinds:
        kinds = {k.strip() for k in args.kinds.split(",") if k.strip()}

    data = decode_map(map_path, ini_path, roi=args.roi, kinds=kinds)

    if args.format == "summary":
        print_summary(data)
        return

    if args.format == "grid":
        text = build_ascii_grid(data)
        if args.output:
            out = args.output if args.output.is_absolute() else ROOT / args.output
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text, encoding="utf-8")
            print(f"Wrote {out}")
        else:
            print(text, end="")
        return

    payload = {k: v for k, v in data.items() if not k.startswith("_")}
    pretty = not args.compact
    text = json.dumps(payload, indent=2 if pretty else None, ensure_ascii=False)
    out = args.output or map_path.with_suffix(".terrain.json")
    if not out.is_absolute():
        out = ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text + "\n", encoding="utf-8")
    print(f"Wrote {out} ({payload['cell_count']} cells)")
    print("Edit tile_index/sub_tile, then: python encode.py", out.name, "-o edited.yrm")


if __name__ == "__main__":
    main()
