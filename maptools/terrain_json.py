"""Round-trip helpers: map ↔ editable terrain JSON."""

from __future__ import annotations

import json
from pathlib import Path

from .iso_pack import IsoTile, decode_iso_map_pack, encode_iso_map_pack
from .map_ini import (
    extract_iso_pack_b64,
    load_map,
    parse_map_size,
    parse_theater,
    patch_iso_map_pack,
    patch_overlay_packs,
    save_map,
)
from .overlay_layer import EMPTY_OVERLAY, OverlayLayer
from .tile_map import shore_set_number
from .tileset_names import classify_kind, resolve_tile, tile_label


EDITABLE_KEYS = ("rx", "ry", "tile_index", "sub_tile", "z", "ice")


def enrich_cell(cell: dict, ini, *, theater: str) -> dict:
    """Add kind/name/tem/shore_offset for humans; encode ignores these."""
    idx = int(cell["tile_index"])
    info = resolve_tile(ini, idx, theater=theater)
    kind = classify_kind(ini, idx)
    out = {
        **cell,
        "kind": kind,
        "name": tile_label(ini, idx, theater=theater),
    }
    if info is not None:
        if info.get("tem"):
            out["tem"] = info["tem"]
        if info["tile_set"] == shore_set_number(theater):
            out["shore_offset"] = info["offset_in_set"]
    return out


def cell_to_tile(cell: dict) -> IsoTile:
    return IsoTile(
        rx=int(cell["rx"]),
        ry=int(cell["ry"]),
        tile_index=int(cell["tile_index"]),
        sub_tile=int(cell.get("sub_tile", 0)),
        z=int(cell.get("z", 0)),
        ice=int(cell.get("ice", 0)),
    )


def load_terrain_json(path: Path | str) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if "cells" not in data or not isinstance(data["cells"], list):
        raise ValueError("terrain JSON must contain a 'cells' array")
    return data


def apply_terrain_json(
    base_map: Path | str,
    data: dict,
    output: Path | str,
    *,
    replace: bool = False,
    compress_clear: bool = False,
    apply_overlays: bool = True,
) -> dict:
    """
    Write IsoMapPack5 (and optional overlays) from JSON onto a base map.

    replace=False (default): merge JSON cells onto the base map's terrain.
    replace=True: use only JSON cells (missing cells vanish / become absent).
    """
    base_map = Path(base_map)
    output = Path(output)
    sections = load_map(base_map)
    width, height = parse_map_size(sections)
    theater = parse_theater(sections)

    json_w = data.get("width")
    json_h = data.get("height")
    if json_w is not None and int(json_w) != width:
        raise ValueError(f"JSON width {json_w} != map width {width}")
    if json_h is not None and int(json_h) != height:
        raise ValueError(f"JSON height {json_h} != map height {height}")

    if replace:
        by_coord: dict[tuple[int, int], IsoTile] = {}
    else:
        tiles = decode_iso_map_pack(extract_iso_pack_b64(sections), width, height)
        by_coord = {(t.rx, t.ry): t for t in tiles}

    updated = 0
    for cell in data["cells"]:
        tile = cell_to_tile(cell)
        key = (tile.rx, tile.ry)
        prev = by_coord.get(key)
        if prev is None or (
            prev.tile_index != tile.tile_index
            or prev.sub_tile != tile.sub_tile
            or prev.z != tile.z
            or prev.ice != tile.ice
        ):
            updated += 1
        by_coord[key] = tile

    pack_lines = encode_iso_map_pack(
        list(by_coord.values()), compress_clear=compress_clear
    )
    patch_iso_map_pack(sections, pack_lines)

    overlay_touched = 0
    if apply_overlays and any("overlay" in c for c in data["cells"]):
        overlay = OverlayLayer.from_sections(sections)
        for cell in data["cells"]:
            rx, ry = int(cell["rx"]), int(cell["ry"])
            if "overlay" not in cell:
                continue
            oid = cell.get("overlay")
            if oid is None:
                # explicit null → clear overlay
                idx = OverlayLayer._index(rx, ry)
                overlay.ids[idx] = EMPTY_OVERLAY
                overlay.data[idx] = 0
                overlay_touched += 1
            else:
                oval = int(cell.get("overlay_value", 0))
                overlay.set_overlay(rx, ry, int(oid), oval)
                overlay_touched += 1
        patch_overlay_packs(
            sections,
            overlay.to_pack_lines("ids"),
            overlay.to_pack_lines("data"),
        )

    save_map(sections, output)
    return {
        "base": str(base_map),
        "output": str(output),
        "theater": theater,
        "width": width,
        "height": height,
        "cells_in_json": len(data["cells"]),
        "cells_written": len(by_coord),
        "cells_changed": updated,
        "overlays_touched": overlay_touched,
        "mode": "replace" if replace else "merge",
    }
