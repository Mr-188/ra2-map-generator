"""OverlayPack / OverlayDataPack grid (262144 bytes, index = ry * 512 + rx).

The size is the engine's own map dimension, not a choice made here: ``0x40000`` is the
bound the cell code rejects at (``0x578482`` in the level query, round 244/256, and the
same 512x512 reach the RNG cursor table assumes).  ``EMPTY_OVERLAY`` is the ``-1`` the
cell's overlay field carries (``+0x44``, ``rmg_ts.py:183``'s reading of ``0x47d2b0``,
rounds 154/230/256).  This module is the file-format container for that grid -- it does
not decide any map-generation logic.
"""

from __future__ import annotations

import base64

from . import format5
from .map_ini import get_section, parse_key_value

PACK_SIZE = 1 << 18
EMPTY_OVERLAY = 0xFF


class OverlayLayer:
    def __init__(self) -> None:
        self.ids = bytearray([EMPTY_OVERLAY] * PACK_SIZE)
        self.data = bytearray(PACK_SIZE)

    @staticmethod
    def _index(rx: int, ry: int) -> int:
        return ry * 512 + rx

    def set_overlay(self, rx: int, ry: int, overlay_id: int, overlay_value: int = 0) -> None:
        idx = self._index(rx, ry)
        self.ids[idx] = overlay_id & 0xFF
        self.data[idx] = overlay_value & 0xFF

    def get_overlay(self, rx: int, ry: int) -> tuple[int, int] | None:
        idx = self._index(rx, ry)
        if self.ids[idx] == EMPTY_OVERLAY:
            return None
        return self.ids[idx], self.data[idx]

    @classmethod
    def blank(cls) -> "OverlayLayer":
        return cls()

    @classmethod
    def from_sections(cls, sections: list[tuple[str, list[str]]]) -> "OverlayLayer":
        layer = cls()
        for section_name, attr in (("OverlayPack", "ids"), ("OverlayDataPack", "data")):
            sec = get_section(sections, section_name)
            if not sec:
                continue
            parts: list[str] = []
            for line in sec[1:]:
                kv = parse_key_value(line)
                if kv:
                    parts.append(kv[1])
            if not parts:
                continue
            raw = base64.b64decode("".join(parts))
            decoded = format5.decode(raw, PACK_SIZE, fmt=80)
            setattr(layer, attr, bytearray(decoded))
        return layer

    def to_pack_lines(self, which: str) -> list[str]:
        payload = bytes(self.ids if which == "ids" else self.data)
        encoded = format5.encode(payload, fmt=80)
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
