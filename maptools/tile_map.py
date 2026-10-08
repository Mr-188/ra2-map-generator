"""Resolve Clear / Water TileIndex from theater control INI."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from .tileset_names import load_tileset_ini

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

# The theater control INIs are game files.  They used to sit in data/theaters/,
# committed; MG_THEATER_DIR lets the acceptance suites point at a directory the
# extractor just produced instead, so no game file has to live in the tree.
import os as _os

THEATER_DIR = Path(_os.environ.get("MG_THEATER_DIR") or (DATA / "theaters"))

# Theater -> vanilla Yuri's Revenge control INI, stored under data/theaters/
# with its authentic in-archive name.  YR ships the "*md.ini" set (inside
# ra2md.mix -> localmd.mix); the unsuffixed names are the base-RA2 files and
# `urbann.ini`/`desert.ini`/`lunar.ini` do not exist in YR at all.
_THEATER_INI = {
    "TEMPERATE": "temperatmd.ini",
    "SNOW": "snowmd.ini",
    "URBAN": "urbanmd.ini",
    "NEWURBAN": "urbannmd.ini",
    "DESERT": "desertmd.ini",
    "LUNAR": "lunarmd.ini",
}


@lru_cache(maxsize=8)
def theater_ini_path(theater: str) -> Path | None:
    """Control INI for *theater*, or None when no theater INI is available."""
    name = _THEATER_INI.get(theater.strip().upper())
    if not name:
        return None
    path = THEATER_DIR / name
    return path if path.is_file() else None


@lru_cache(maxsize=8)
def _ini_for_theater(theater: str) -> object:
    path = theater_ini_path(theater)
    if path is None:
        path = THEATER_DIR / _THEATER_INI["TEMPERATE"]
    return load_tileset_ini(str(path))


@lru_cache(maxsize=8)
def theater_control_ini(theater: str) -> str:
    """Control INI actually used for `theater` (temperate when unavailable)."""
    path = theater_ini_path(theater)
    return path.name if path else _THEATER_INI["TEMPERATE"]


@lru_cache(maxsize=8)
def has_native_theater_tiles(theater: str) -> bool:
    """True when a theater-specific control INI exists instead of the fallback."""
    return theater_ini_path(theater) is not None


@lru_cache(maxsize=128)
def has_tile_set(theater: str, general_key: str) -> bool:
    """True when *theater* defines a non-empty tile set for `general_key`.

    The control INIs name sets by purpose ("BridgeSet", "DirtRoadStraight", …),
    and theaters genuinely differ: LUNAR ships no cliff or road sets at all, and
    DESERT has no WaterCliffs or waterfalls.  Feature code must ask this instead
    of assuming a set exists.
    """
    ini = _ini_for_theater(theater)
    raw = ini.general.get(general_key)
    if raw is None:
        return False
    number = int(str(raw).split(";")[0].strip() or 0)
    return ini.sets.get(number, 0) > 0


@lru_cache(maxsize=32)
def clear_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of ClearTile set (usually 0)."""
    ini = _ini_for_theater(theater)
    clear_set = int(ini.general.get("ClearTile", "0"))
    for idx, (set_no, offset, *_rest) in ini.index_map.items():
        if set_no == clear_set and offset == 0:
            return idx
    return 0


def black_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of the explicit BlackTile set."""
    return _first_of_set(theater, "BlackTile", 6)


@lru_cache(maxsize=32)
def water_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of WaterSet — open water (no shore pieces)."""
    ini = _ini_for_theater(theater)
    water_set = int(ini.general.get("WaterSet", "21"))
    for idx, (set_no, offset, *_rest) in ini.index_map.items():
        if set_no == water_set and offset == 0:
            return idx
    # Temperate fallback if set missing
    return 314


@lru_cache(maxsize=32)
def shore_base_index(theater: str = "TEMPERATE") -> int:
    """First TileIndex of ShorePieces set (temperate shore01 = 89)."""
    ini = _ini_for_theater(theater)
    shore_set = int(ini.general.get("ShorePieces", "12"))
    for idx, (set_no, offset, *_rest) in ini.index_map.items():
        if set_no == shore_set and offset == 0:
            return idx
    return 89


def shore_tile_index(theater: str, offset_in_set: int) -> int:
    """ShorePieces TileIndex = base + offset (shore01 offset 0, shore04 offset 3, …)."""
    return shore_base_index(theater) + offset_in_set


@lru_cache(maxsize=64)
def _first_of_set(theater: str, general_key: str, fallback_set: int) -> int:
    ini = _ini_for_theater(theater)
    set_no = int(ini.general.get(general_key, str(fallback_set)))
    for idx, (s, offset, *_rest) in ini.index_map.items():
        if s == set_no and offset == 0:
            return idx
    return 0


def sand_tile_index(theater: str = "TEMPERATE") -> int:
    """SandTile fill (LAT Rough/Sandy, set 33) — not the coastal beach ring."""
    return _first_of_set(theater, "SandTile", 33) or 418


def clear_to_sand_lat_base(theater: str = "TEMPERATE") -> int:
    """ClearToSandLat base (set 34) — Rough sand LAT, not coastal beach."""
    return _first_of_set(theater, "ClearToSandLat", 34) or 419


def beach_sand_tile_index(theater: str = "TEMPERATE") -> int:
    """
    Coastal sand fill used next to ShorePieces.

    Reference b.yrm uses GreenTile (set 41, 'LAT Sand'), not SandTile (33).
    """
    return _first_of_set(theater, "GreenTile", 41) or 493


def clear_to_beach_lat_base(theater: str = "TEMPERATE") -> int:
    """
    Clear↔coastal-sand LAT transitions (16 tiles).

    Reference b.yrm uses ClearToGreenLat (set 42, 'LAT Sand Transitions').
    """
    return _first_of_set(theater, "ClearToGreenLat", 42) or 494


def shore_set_number(theater: str = "TEMPERATE") -> int:
    ini = _ini_for_theater(theater)
    return int(ini.general.get("ShorePieces", "12"))


def water_set_number(theater: str = "TEMPERATE") -> int:
    ini = _ini_for_theater(theater)
    return int(ini.general.get("WaterSet", "21"))


def sand_set_number(theater: str = "TEMPERATE") -> int:
    ini = _ini_for_theater(theater)
    return int(ini.general.get("SandTile", "33"))


def clear_to_sand_set_number(theater: str = "TEMPERATE") -> int:
    ini = _ini_for_theater(theater)
    return int(ini.general.get("ClearToSandLat", "34"))


def cliff_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of CliffSet (grass/rock cliff pieces)."""
    return _first_of_set(theater, "CliffSet", 10)


def ramp_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of RampBase (slope01)."""
    return _first_of_set(theater, "RampBase", 9)


def water_cliff_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of WaterCliffs."""
    return _first_of_set(theater, "WaterCliffs", 15)


def cliff_ramp_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of the multi-cell CliffRamps set."""
    return _first_of_set(theater, "CliffRamps", 25)


def ramp_smooth_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of RampSmooth (Rmpfx edge-fix pieces)."""
    return _first_of_set(theater, "RampSmooth", 43)


def rough_tile_index(theater: str = "TEMPERATE") -> int:
    """RoughTile fill for forest / rough ground."""
    return _first_of_set(theater, "RoughTile", 13) or clear_tile_index(theater)


def clear_to_rough_lat_base(theater: str = "TEMPERATE") -> int:
    return _first_of_set(theater, "ClearToRoughLat", 14)


def green_tile_index(theater: str = "TEMPERATE") -> int:
    """Dense green grass fill used by the Green/glat LAT pair."""
    return _first_of_set(theater, "GreenTile", 41)


def clear_to_green_lat_base(theater: str = "TEMPERATE") -> int:
    return _first_of_set(theater, "ClearToGreenLat", 42)


def pavement_tile_index(theater: str = "TEMPERATE") -> int:
    return _first_of_set(theater, "PaveTile", 46)


def clear_to_pave_lat_base(theater: str = "TEMPERATE") -> int:
    return _first_of_set(theater, "ClearToPaveLat", 39)


def pave_bits_base(theater: str = "TEMPERATE") -> int:
    return _first_of_set(theater, "MiscPaveTile", 38)


def is_buildable_ground_index(
    tile_index: int,
    theater: str = "TEMPERATE",
) -> bool:
    """Ground families that may legally support resources/structures."""
    # A theater can name a set and define nothing for it -- LUNAR names numbers
    # for both ``RoughGround`` and ``MiscPaveTile`` and ships no tiles for either
    # -- and ``_first_of_set`` reports that as index 0.  Left alone, Tiles 0..13
    # (clear, the ``Blank`` slot and the ZMM ramps) would count as ground and ore
    # and structures would be placed on them.  An absent set is dropped, not
    # aliased to 0.
    def span(key: str, fallback: int, count: int) -> tuple[int, int]:
        if not has_tile_set(theater, key):
            return (0, 0)
        return (_first_of_set(theater, key, fallback), count)

    ranges = [
        (clear_tile_index(theater), 1),
        (rough_tile_index(theater), 1),
        (clear_to_rough_lat_base(theater), 16),
        (sand_tile_index(theater), 1),
        (clear_to_sand_lat_base(theater), 16),
        span("RoughGround", 35, 10),
        span("MiscPaveTile", 38, 14),
        (clear_to_pave_lat_base(theater), 16),
        (pavement_tile_index(theater), 1),
    ]
    return any(base <= int(tile_index) < base + count for base, count in ranges)


def bridge_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of BridgeSet (used as simple deck over narrow water)."""
    return _first_of_set(theater, "BridgeSet", 19)


@lru_cache(maxsize=64)
def _first_of_named_set(theater: str, set_name: str, fallback_set: int) -> int:
    """First TileIndex of the set the theater INI calls *set_name*.

    Set numbers move between theaters -- SNOW keeps ``Paved Road Slopes`` at 44
    where every other theater has it at 47 -- so the name is the stable key.

    **Cached**: the answer depends only on ``(theater, set_name, fallback_set)`` and the
    theater INI is immutable for a run, while the road layer asks for it **inside its retry
    loop** -- ``cProfile`` counted **12308** calls for one 50x50 generation, 0.545 s of
    ``tottime`` (the single largest entry after the fix recorded in ledger §12500).
    ``lru_cache`` is already this module's idiom for the same kind of lookup
    (``theater_control_ini`` above), so this is the existing pattern rather than a new one.
    """
    ini = _ini_for_theater(theater)
    wanted = set_name.strip().lower()
    for set_no, name in ini.set_names.items():
        if name.strip().lower() != wanted:
            continue
        for idx, (s, offset, *_rest) in ini.index_map.items():
            if s == set_no and offset == 0:
                return idx
    return _first_of_set(theater, set_name.replace(" ", ""), fallback_set)


def paved_road_slope_index(theater: str = "TEMPERATE") -> int:
    """First tile of the ``Prslpe`` set -- the paved road's four slopes.

    ``SetName = Paved Road Slopes``, four tiles, one per head direction, and
    what ``PavedRoadEnds``/``BridgeSet`` cannot do on a level crossing: the
    corpus plants them on the approach of a ``BRIDGE1``/``BRIDGE2`` crossing.
    """
    return _first_of_named_set(theater, "Paved Road Slopes", 47)


def paved_road_index(theater: str = "TEMPERATE") -> int:
    """First tile of the ``Proad`` set -- the paved road surface itself."""
    return _first_of_named_set(theater, "Paved Roads", 20)


def water_bridge_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of the ``Water bridge`` (``wbrdge``) set, 0 where absent.

    Resolved by *set name*, not by number: the same set is 76 in TEMPERATE and
    DESERT, 72 in SNOW and 90 in URBAN/NEWURBAN, and set 76 in those three
    theaters is a cliff set -- numbering it would pave a bridge out of cliffs.
    LUNAR declares the set but ships no art, so it resolves to 0.
    """
    return _first_of_named_set(theater, "Water bridge", 0)


def destroyable_cliff_tile_index(theater: str = "TEMPERATE") -> int:
    # TEMPERATE contains a later duplicate Set 103 whose indices render as
    # black in CNCMaps. The original, playable Rubble/Destroyable Cliff set is
    # Set 56 (TileIndex 572..573), also used by the shipped assets INI.
    ini = _ini_for_theater(theater)
    for idx, (set_no, offset, *_rest) in ini.index_map.items():
        if set_no == 56 and offset == 0:
            return idx
    return _first_of_set(theater, "DestroyableCliffs", 56)


@lru_cache(maxsize=32)
def misc_pave_tile_index(theater: str = "TEMPERATE") -> int:
    """First tile of the miscellaneous pavement set (``MiscPaveTile``).

    The reference stamps urban decoration from ``MiscPaveTile + 8``, so this is
    the base rather than the tile itself.
    """
    return _first_of_set(theater, "MiscPaveTile", 38)


@lru_cache(maxsize=32)
def pave_tile_index(theater: str = "TEMPERATE") -> int:
    """The plain pavement fill tile (``PaveTile``).

    In RA2's Theater INIs this set holds a single tile; the reference's
    compile-time count of 16 belongs to Tiberian Sun and would swallow the
    paved-road slopes and waterfalls that follow it.
    """
    return _first_of_set(theater, "PaveTile", 46)
