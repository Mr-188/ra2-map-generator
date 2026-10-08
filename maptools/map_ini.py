"""Read RA2 / YR .yrm / .map INI sections.

**Classification: class D -- format IO, not map logic** (rounds 101, 177, 197/256).  This module
reads and writes the parts of a ``.yrm``/``.map`` file that are plain INI text (waypoints, terrain
object lists, and the like); the four importers are the reader/writer side of the pipeline
(``maptools.__init__``, ``overlay_layer``, ``slope_connect`` and one more).  Its basis is therefore
the **file format and the corpus** -- retail maps decode and re-encode through it -- and, by the
class-D criterion, it needs no ``gamemd.exe`` address: there is no engine routine that "is" an INI
parser.  It should be checked against real files, not against the disassembly.
"""

from __future__ import annotations

import re
from pathlib import Path


SECTION_RE = re.compile(r"^\[(.+?)\]$")


def read_sections(text: str) -> list[tuple[str, list[str]]]:
    lines = text.splitlines()
    sections: list[tuple[str, list[str]]] = []
    current_name: str | None = None
    current_lines: list[str] = []

    for line in lines:
        match = SECTION_RE.match(line.strip())
        if match:
            if current_name is not None:
                sections.append((current_name, current_lines))
            current_name = match.group(1)
            current_lines = [line]
        elif current_name is not None:
            current_lines.append(line)

    if current_name is not None:
        sections.append((current_name, current_lines))
    return sections


def get_section(sections: list[tuple[str, list[str]]], name: str) -> list[str] | None:
    for sec_name, lines in sections:
        if sec_name == name:
            return lines
    return None


def parse_key_value(line: str) -> tuple[str, str] | None:
    if "=" not in line or line.strip().startswith(";"):
        return None
    key, value = line.split("=", 1)
    return key.strip(), value.strip()


def load_map(path: Path | str) -> list[tuple[str, list[str]]]:
    path = Path(path)
    return read_sections(path.read_text(encoding="utf-8", errors="replace"))


def parse_map_size(sections: list[tuple[str, list[str]]]) -> tuple[int, int]:
    map_sec = get_section(sections, "Map")
    if not map_sec:
        raise ValueError("Map section missing")
    for line in map_sec:
        if line.startswith("Size="):
            parts = line.strip().split("=", 1)[1].split(",")
            if len(parts) != 4:
                raise ValueError(f"Invalid Size format: {line.strip()}")
            _, _, w, h = parts
            return int(w), int(h)
    raise ValueError("Size= not found in [Map]")


def parse_theater(sections: list[tuple[str, list[str]]]) -> str:
    map_sec = get_section(sections, "Map")
    if not map_sec:
        return "TEMPERATE"
    for line in map_sec:
        if line.startswith("Theater="):
            return line.strip().split("=", 1)[1].strip().upper()
    return "TEMPERATE"


def extract_iso_pack_b64(sections: list[tuple[str, list[str]]]) -> str:
    sec = get_section(sections, "IsoMapPack5")
    if not sec:
        raise ValueError("IsoMapPack5 missing")
    parts: list[str] = []
    for line in sec[1:]:
        kv = parse_key_value(line)
        if kv:
            parts.append(kv[1])
    return "".join(parts)


def replace_section(sections: list[tuple[str, list[str]]], name: str, new_lines: list[str]) -> None:
    for i, (sec_name, _) in enumerate(sections):
        if sec_name == name:
            sections[i] = (name, new_lines)
            return
    sections.append((name, new_lines))


def sections_to_text(sections: list[tuple[str, list[str]]]) -> str:
    parts: list[str] = []
    for _, lines in sections:
        parts.extend(lines)
        if lines and lines[-1].strip():
            parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def save_map(sections: list[tuple[str, list[str]]], path: Path | str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(sections_to_text(sections), encoding="utf-8", newline="\n")


def patch_iso_map_pack(sections: list[tuple[str, list[str]]], pack_lines: list[str]) -> None:
    replace_section(sections, "IsoMapPack5", ["[IsoMapPack5]", *pack_lines, ""])


def patch_basic_name(sections: list[tuple[str, list[str]]], name: str) -> None:
    basic = get_section(sections, "Basic")
    if not basic:
        raise ValueError("[Basic] missing")
    out = [basic[0]]
    for line in basic[1:]:
        kv = parse_key_value(line)
        if kv and kv[0] == "Name":
            out.append(f"Name={name}")
        else:
            out.append(line)
    replace_section(sections, "Basic", out)


def patch_map_size(
    sections: list[tuple[str, list[str]]],
    width: int,
    height: int,
    theater: str | None = None,
) -> None:
    """Set [Map] Size / LocalSize (/ Theater) and [Header] Width/Height."""
    map_sec = get_section(sections, "Map")
    if not map_sec:
        raise ValueError("[Map] missing")

    # ``width``/``height`` are the **scene** rectangle (``Map/Size``); the playable rect sits
    # inside at (2, 5) with ``Size = local + (4, 12)`` -- the relation every shipped
    # ``reference_maps/multimd/*.map`` satisfies (rounds 388-410/256).
    local_x = 2 if width > 4 else 0
    local_y = 5 if height > 4 else 0
    local_w = max(1, width - 4) if width > 4 else max(1, width)
    local_h = max(1, height - 12) if height > 4 else max(1, height)
    theater_val = theater.upper() if theater else None

    out_map = [map_sec[0]]
    saw_theater = False
    for line in map_sec[1:]:
        if line.startswith("Size="):
            out_map.append(f"Size=0,0,{width},{height}")
        elif line.startswith("LocalSize="):
            out_map.append(f"LocalSize={local_x},{local_y},{local_w},{local_h}")
        elif line.startswith("Theater=") and theater_val:
            out_map.append(f"Theater={theater_val}")
            saw_theater = True
        else:
            out_map.append(line)
    if theater_val and not saw_theater:
        # Keep Theater near Size / LocalSize
        insert_at = 1
        for i, line in enumerate(out_map):
            if line.startswith("Size=") or line.startswith("LocalSize="):
                insert_at = i + 1
        out_map.insert(insert_at, f"Theater={theater_val}")
    replace_section(sections, "Map", out_map)

    header = get_section(sections, "Header")
    if not header:
        return
    out_h = [header[0]]
    for line in header[1:]:
        kv = parse_key_value(line)
        if not kv:
            out_h.append(line)
            continue
        key, _ = kv
        if key == "Width":
            out_h.append(f"Width={max(1, local_w - 1)}")
        elif key == "Height":
            out_h.append(f"Height={local_h}")
        else:
            out_h.append(line)
    replace_section(sections, "Header", out_h)


def patch_spawns(sections: list[tuple[str, list[str]]], spawns: list[tuple[int, int]]) -> None:
    """Write [Header] WaypointN / NumberStartingPoints and [Waypoints], set MaxPlayer."""
    header = get_section(sections, "Header")
    if not header:
        raise ValueError("[Header] missing")

    out_h = [header[0]]
    for line in header[1:]:
        kv = parse_key_value(line)
        if not kv:
            out_h.append(line)
            continue
        key, _ = kv
        if key.startswith("Waypoint") and key[8:].isdigit():
            idx = int(key[8:]) - 1
            if 0 <= idx < len(spawns):
                rx, ry = spawns[idx]
                out_h.append(f"{key}={rx},{ry}")
            elif idx < 8:
                out_h.append(f"{key}=0,0")
            else:
                out_h.append(line)
        elif key == "NumberStartingPoints":
            out_h.append(f"NumberStartingPoints={len(spawns)}")
        else:
            out_h.append(line)
    replace_section(sections, "Header", out_h)

    wp_lines = ["[Waypoints]"]
    for i, (rx, ry) in enumerate(spawns):
        wp_lines.append(f"{i}={ry * 1000 + rx}")
    wp_lines.append("")
    replace_section(sections, "Waypoints", wp_lines)

    basic = get_section(sections, "Basic")
    if basic:
        out_b = [basic[0]]
        for line in basic[1:]:
            kv = parse_key_value(line)
            if kv and kv[0] == "MaxPlayer":
                out_b.append(f"MaxPlayer={max(2, len(spawns))}")
            elif kv and kv[0] == "MinPlayer":
                out_b.append("MinPlayer=2")
            else:
                out_b.append(line)
        replace_section(sections, "Basic", out_b)


def patch_overlay_packs(
    sections: list[tuple[str, list[str]]],
    overlay_pack_lines: list[str],
    overlay_data_lines: list[str],
) -> None:
    replace_section(sections, "OverlayPack", ["[OverlayPack]", *overlay_pack_lines, ""])
    replace_section(sections, "OverlayDataPack", ["[OverlayDataPack]", *overlay_data_lines, ""])


def patch_terrain(
    sections: list[tuple[str, list[str]]],
    trees: list[tuple[int, int, str]],
) -> None:
    """
    Write [Terrain] as cell=TYPE lines.

    cell is Y*1000+X (same encoding as [Waypoints]). types are TerrainTypes e.g. TREE01.
    """
    lines = ["[Terrain]"]
    for rx, ry, tree_type in trees:
        lines.append(f"{ry * 1000 + rx}={tree_type}")
    lines.append("")
    replace_section(sections, "Terrain", lines)


def patch_structures(
    sections: list[tuple[str, list[str]]],
    buildings: list[tuple[int, int, str, int]],
) -> None:
    """
    Write [Structures] entries.

    buildings: (rx, ry, building_id, facing)
    Format: INDEX=OWNER,ID,HEALTH,X,Y,FACING,TAG,AI_SELLABLE,AI_REBUILDABLE,
            POWERED_ON,UPGRADES,SPOTLIGHT,UPGRADE_1,UPGRADE_2,UPGRADE_3,
            AI_REPAIRABLE,NOMINAL
    """
    lines = ["[Structures]"]
    for i, (rx, ry, building_id, facing) in enumerate(buildings):
        lines.append(
            f"{i}=Neutral,{building_id},256,{rx},{ry},{facing},"
            "None,0,0,1,0,0,none,none,none,0,0"
        )
    lines.append("")
    replace_section(sections, "Structures", lines)


def patch_smudges(
    sections: list[tuple[str, list[str]]],
    smudges: list[tuple[int, int, str]],
) -> None:
    """Write real RA2 [Smudge] crater/scorch entries."""
    lines = ["[Smudge]"]
    for index, (rx, ry, smudge_type) in enumerate(smudges):
        lines.append(f"{index}={smudge_type},{rx},{ry},0")
    lines.append("")
    replace_section(sections, "Smudge", lines)


def patch_random_map(sections: list[tuple[str, list[str]]], values: dict) -> None:
    """Write the ``[RandomMap]`` block the saved map carries.

    The objective's acceptance compares an officially saved random map's
    ``[RandomMap]`` section together with its map file, so this project's output
    has to carry the same block: without it there is nothing on our side to
    compare the settings against (§11914 measured that this project's ``.yrm``
    had **no** such section at all).

    The key order is ``randmap_seed.KEY_ORDER`` -- the same order the seed writer
    uses -- so the block is byte-comparable with a seed file.  Values are written
    as given, and any existing block is replaced rather than merged, since a map
    records one set of settings.
    """
    from .randmap_seed import KEY_ORDER, SECTION

    wanted = {key: str(values[key]) for key in values}
    # ``replace_section`` takes the section's **whole** body, header included --
    # that is what ``patch_iso_map_pack`` passes (``["[IsoMapPack5]", ...]``).
    # Omitting the header writes the keys under no section at all, which is what
    # §11914 first measured: the block's bytes were there but the name was not.
    lines = [f"[{SECTION}]"]
    for key in KEY_ORDER:
        if key in wanted:
            lines.append(f"{key}={wanted.pop(key)}")
    for key in sorted(wanted):
        lines.append(f"{key}={wanted[key]}")
    lines.append("")
    replace_section(sections, SECTION, lines)


def patch_lighting(
    sections: list[tuple[str, list[str]]], ambient: float
) -> None:
    """Set the scenario's ambient light level.

    The reference writes ``[Lighting] Ambient = tod * scale`` where ``tod`` comes
    from the Time setting (0.75 / 1.0 / 0.75 / 0.5 for morning / afternoon /
    dusk / night) and ``scale`` dims arctic theaters to 0.75.  The rest of the
    block is left as the template had it, except that the red/green/blue tints
    and the ground level are pinned the way the reference pins them, so a night
    map is genuinely darker rather than merely tinted.

    A template with no ``[Lighting]`` section is left alone rather than having
    one invented.
    """
    existing = get_section(sections, "Lighting")
    if not existing:
        return
    wanted = {
        "Ambient": f"{ambient:.6f}",
        "Red": "1.000000",
        "Green": "1.000000",
        "Blue": "1.000000",
        "Ground": "0.000000",
        "Level": "0.010000",
    }
    out = [existing[0]]
    seen: set[str] = set()
    for line in existing[1:]:
        kv = parse_key_value(line)
        if kv and kv[0] in wanted:
            out.append(f"{kv[0]}={wanted[kv[0]]}")
            seen.add(kv[0])
        else:
            out.append(line)
    for key, value in wanted.items():
        if key not in seen:
            out.append(f"{key}={value}")
    replace_section(sections, "Lighting", out)


def patch_units(
    sections: list[tuple[str, list[str]]],
    units: list[tuple[int, int, str, int]],
    infantry: list[tuple[int, int, str, int]],
) -> None:
    """Write the scenario's neutral civilians.

    ``units`` become ``[Units]`` entries and ``infantry`` ``[Infantry]``; both
    use the same numbered ``OWNER,ID,HEALTH,X,Y,FACING,...`` shape as
    ``[Structures]``.  Ownership is ``Neutral`` -- the reference creates these
    with the Neutral house, so they are scenery rather than opposition.

    ``[Infantry]`` is appended when the template has no such section, which the
    bundled template does not.
    """
    def render(name: str, entries: list[tuple[int, int, str, int]]) -> list[str]:
        lines = [f"[{name}]"]
        for index, (rx, ry, unit_id, facing) in enumerate(entries):
            lines.append(
                f"{index}=Neutral,{unit_id},256,{rx},{ry},{facing},"
                "None,0,0,1,0,0,none,none,none,0,0"
            )
        lines.append("")
        return lines

    if units or get_section(sections, "Units"):
        replace_section(sections, "Units", render("Units", units))
    if infantry:
        replace_section(sections, "Infantry", render("Infantry", infantry))
