"""Decode / encode IsoMapPack5 terrain."""

from __future__ import annotations

import base64
import struct
from dataclasses import asdict, dataclass

from . import format5


RECORD_SIZE = 11  # <hhiBBB: rx, ry, tile_num, sub_tile, z, ice
CLEAR_TILE = 0


@dataclass
class IsoTile:
    rx: int
    ry: int
    tile_index: int = 0
    sub_tile: int = 0
    z: int = 0
    ice: int = 0

    def to_bytes(self) -> bytes:
        return struct.pack(
            "<hhiBBB",
            self.rx,
            self.ry,
            self.tile_index,
            self.sub_tile,
            self.z,
            self.ice,
        )

    def to_dict(self) -> dict:
        return asdict(self)


def _record_count(decompressed_size: int) -> int:
    if decompressed_size <= 0:
        return 0
    if decompressed_size % RECORD_SIZE == 0:
        return decompressed_size // RECORD_SIZE
    return max(0, (decompressed_size - 4) // RECORD_SIZE)


def iter_clear_cells(width: int, height: int):
    """Yield IsoTiles for the full isometric storage grid (all Clear)."""
    grid_w = width * 2 - 1
    for y in range(height):
        for x in range(grid_w):
            dy = y * 2 + (x % 2)
            rx = (x + dy) // 2 + 1
            ry = dy - rx + width + 1
            yield IsoTile(rx=rx, ry=ry, tile_index=CLEAR_TILE)


def decode_iso_map_pack(pack_b64: str, width: int, height: int) -> list[IsoTile]:
    """
    Decompress IsoMapPack5 Base64 into a list of IsoTile cells.

    Records with out-of-range coordinates or sentinel (512,512) are skipped.
    Duplicate (rx, ry) keeps the last record (matching FA2 overwrite order).
    """
    raw = base64.b64decode("".join(pack_b64.split()))
    cells = (width * 2 - 1) * height
    full_size = cells * RECORD_SIZE + 4
    decomp_size = format5.decompressed_size(raw)
    decode_size = decomp_size if 0 < decomp_size <= full_size else full_size
    decoded = format5.decode(raw, decode_size)
    count = min(cells, _record_count(len(decoded)))

    by_coord: dict[tuple[int, int], IsoTile] = {}
    for i in range(count):
        off = i * RECORD_SIZE
        rx, ry, tile_num, sub_tile, z, ice = struct.unpack_from("<hhiBBB", decoded, off)
        if tile_num >= 65535:
            tile_num = 0
        if rx > 511 or ry > 511:
            continue
        if rx < 1 or ry < 1:
            continue
        by_coord[(rx, ry)] = IsoTile(rx, ry, tile_num, sub_tile, z, ice)

    return sorted(by_coord.values(), key=lambda t: (t.ry, t.rx))


def encode_iso_map_pack(tiles: list[IsoTile], compress_clear: bool = False) -> list[str]:
    """
    Encode tiles to IsoMapPack5 INI lines (`1=...`, `2=...`).

    If compress_clear is True, skip flat Clear (tile 0, z/sub/ice 0) cells the way FA2
    does. A trailing sentinel (512,512) is always appended so miniLZO cannot corrupt
    the last real record.
    """
    work = list(tiles)
    if compress_clear:
        work = [t for t in work if t.tile_index > 0 or t.z > 0 or t.sub_tile > 0 or t.ice > 0]
        if not work:
            work = [IsoTile(1, 1, CLEAR_TILE)]

    # Sentinel outside valid map coords — stripped on decode (rx/ry > 511)
    work.append(IsoTile(512, 512, 0))

    payload = bytearray(len(work) * RECORD_SIZE + 4)
    for i, tile in enumerate(work):
        payload[i * RECORD_SIZE : (i + 1) * RECORD_SIZE] = tile.to_bytes()

    encoded = format5.encode(bytes(payload))
    b64 = base64.b64encode(encoded).decode("ascii")
    lines: list[str] = []
    idx = 0
    line_no = 1
    while idx < len(b64):
        chunk = b64[idx : idx + 74]
        lines.append(f"{line_no}={chunk}")
        idx += 74
        line_no += 1
    return lines


def tiles_to_grid(tiles: list[IsoTile], width: int, height: int) -> list[list[IsoTile | None]]:
    """Build a height x width grid indexed by [ry-1][rx-1]. Missing cells are None."""
    grid: list[list[IsoTile | None]] = [[None] * width for _ in range(height)]
    for tile in tiles:
        if 1 <= tile.rx <= width and 1 <= tile.ry <= height:
            grid[tile.ry - 1][tile.rx - 1] = tile
    return grid
