"""Format5 chunked compression used by IsoMapPack5 and OverlayPack."""

from __future__ import annotations

from . import format80, minilzo


def decode(data: bytes, out_size: int, fmt: int = 5) -> bytes:
    """Decompress Format5 chunks into a fixed-size buffer.

    fmt=5  → miniLZO (IsoMapPack5)
    fmt=80 → Format80 (OverlayPack / OverlayDataPack)
    """
    out = bytearray(out_size)
    pos = 0
    out_pos = 0
    while pos + 4 <= len(data) and out_pos < out_size:
        size_in = int.from_bytes(data[pos : pos + 2], "little")
        size_out = int.from_bytes(data[pos + 2 : pos + 4], "little")
        pos += 4
        if size_in == 0 or size_out == 0:
            break
        chunk = data[pos : pos + size_in]
        pos += size_in
        if fmt == 80:
            decoded = format80.decode_into(chunk, size_out)
        else:
            decoded = minilzo.decompress(chunk, size_out)
        out[out_pos : out_pos + len(decoded)] = decoded
        out_pos += len(decoded)
    return bytes(out)


def encode(source: bytes, fmt: int = 5) -> bytes:
    """Compress bytes into Format5 chunks.

    fmt=5 uses miniLZO; fmt=80 uses Format80. Do not pad miniLZO input — padding
    can make our pure-Python compressor emit streams that fail to decompress.
    """
    dest = bytearray()
    pos = 0
    while pos < len(source):
        cb_in = min(len(source) - pos, 8192)
        chunk_in = source[pos : pos + cb_in]
        if fmt == 80:
            chunk_out = format80.encode(chunk_in)
        else:
            chunk_out = minilzo.compress(chunk_in)
        dest += len(chunk_out).to_bytes(2, "little")
        dest += cb_in.to_bytes(2, "little")
        dest += chunk_out
        pos += cb_in
    return bytes(dest)


def decompressed_size(raw: bytes) -> int:
    """Sum of Format5 chunk output sizes (without actually decompressing)."""
    pos = 0
    total = 0
    while pos + 4 <= len(raw):
        size_in = int.from_bytes(raw[pos : pos + 2], "little")
        size_out = int.from_bytes(raw[pos + 2 : pos + 4], "little")
        pos += 4
        if size_in == 0 or size_out == 0:
            break
        total += size_out
        pos += size_in
    return total
