"""Map IsoMapPack5 TileIndex → tileset name / .tem filename via theater control INI."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path


SECTION_RE = re.compile(r"^\[(.+?)\]$")
TILESET_RE = re.compile(r"^TileSet(\d+)$", re.IGNORECASE)

DEFAULT_INI = (
    Path(__file__).resolve().parents[1] / "data" / "theaters" / "temperatmd.ini"
)

# Theater → TMP file extension (isotemp.mix etc.)
THEATER_EXT = {
    "TEMPERATE": ".tem",
    "SNOW": ".sno",
    "URBAN": ".urb",
    "NEWURBAN": ".ubn",
    "DESERT": ".des",
    "LUNAR": ".lun",
}


@dataclass
class TilesetIni:
    general: dict[str, str] = field(default_factory=dict)
    sets: dict[int, int] = field(default_factory=dict)
    set_names: dict[int, str] = field(default_factory=dict)
    file_names: dict[int, str] = field(default_factory=dict)
    # tile_index -> (set_number, offset, set_name, file_base)
    index_map: dict[int, tuple[int, int, str, str]] = field(default_factory=dict)


def theater_extension(theater: str | None = None) -> str:
    key = (theater or "TEMPERATE").strip().upper()
    return THEATER_EXT.get(key, ".tem")


def parse_tileset_ini(text: str) -> TilesetIni:
    result = TilesetIni()
    current_section: str | None = None
    current_set: int | None = None

    for raw_line in text.splitlines():
        line = raw_line.split(";", 1)[0].strip()
        if not line:
            continue

        section_match = SECTION_RE.match(line)
        if section_match:
            current_section = section_match.group(1)
            tileset_match = TILESET_RE.match(current_section)
            current_set = int(tileset_match.group(1)) if tileset_match else None
            continue

        if "=" not in line:
            continue

        key, value = (part.strip() for part in line.split("=", 1))
        if current_section == "General":
            result.general[key] = value
        elif current_set is not None:
            if key == "TilesInSet":
                # The shipped Theater INIs contain real typos, e.g. the vanilla
                # urbannmd.ini has "TilesInSet = o" (letter o) for TileSet0105
                # "RA2 Busch Rubble". The engine treats a non-numeric count as
                # an empty set, so degrade to 0 instead of failing the whole
                # theater.
                result.sets[current_set] = int(value) if value.lstrip("-").isdigit() else 0
            elif key == "SetName":
                result.set_names[current_set] = value
            elif key == "FileName":
                result.file_names[current_set] = value

    # Global TileIndex = sum of TilesInSet for all lower set numbers + offset
    # TMP file = FileName + (offset+1) as 2 digits + theater ext  (starts at 01)
    cursor = 0
    max_set = max(result.sets) if result.sets else -1
    for set_number in range(max_set + 1):
        count = result.sets.get(set_number, 0)
        name = result.set_names.get(set_number, "?")
        file_base = result.file_names.get(set_number, "")
        for offset in range(count):
            result.index_map[cursor + offset] = (set_number, offset, name, file_base)
        cursor += count

    return result


@lru_cache(maxsize=4)
def load_tileset_ini(path: str | None = None) -> TilesetIni:
    ini_path = Path(path) if path else DEFAULT_INI
    # bust cache identity when file content matters — path string is the key
    return parse_tileset_ini(ini_path.read_text(encoding="utf-8", errors="replace"))


def tem_filename(
    file_base: str,
    offset_in_set: int,
    *,
    theater: str | None = None,
) -> str | None:
    """Build e.g. shore20.tem from FileName=Shore and offset 19."""
    base = (file_base or "").strip()
    if not base or base.lower() == "blank":
        return None
    ext = theater_extension(theater)
    return f"{base}{offset_in_set + 1:02d}{ext}".lower()


def resolve_tile(
    ini: TilesetIni,
    tile_index: int,
    *,
    theater: str | None = None,
) -> dict | None:
    info = ini.index_map.get(tile_index)
    if info is None:
        return None
    set_number, offset, set_name, file_base = info
    tem = tem_filename(file_base, offset, theater=theater)
    label = tem if tem else f"TileSet{set_number:04d}/{set_name}+{offset}"
    return {
        "tile_index": tile_index,
        "tile_set": set_number,
        "offset_in_set": offset,
        "set_name": set_name,
        "file_base": file_base,
        "tem": tem,
        "label": label,
    }


def tile_label(
    ini: TilesetIni,
    tile_index: int,
    *,
    theater: str | None = None,
) -> str:
    info = resolve_tile(ini, tile_index, theater=theater)
    if info is None:
        return f"TileIndex {tile_index}"
    if info["tem"]:
        return info["tem"]
    return f"TileSet{info['tile_set']:04d}/{info['set_name']}+{info['offset_in_set']}"


def classify_kind(ini: TilesetIni, tile_index: int) -> str:
    """Rough terrain kind for ASCII grids."""
    info = resolve_tile(ini, tile_index)
    if tile_index == 0 or (info and info["set_name"].lower() == "clear"):
        return "clear"
    if info is None:
        return "other"

    name = info["set_name"].lower()
    file_base = (info.get("file_base") or "").lower()
    water_set = int(ini.general.get("WaterSet", "21"))
    if info["tile_set"] == water_set or name == "water":
        return "water"
    if "water" in name and "cliff" in name:
        return "shore"
    if any(h in name for h in ("shore", "beach")) or file_base == "shore":
        return "shore"
    if "sand" in name:
        return "terrain"
    return "terrain"
