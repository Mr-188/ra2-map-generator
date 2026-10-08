"""Format80 compression used by OverlayPack / OverlayDataPack."""

from __future__ import annotations


def decode_into(src: bytes, dest_size: int) -> bytes:
    dest = bytearray(dest_size)
    readp = 0
    writep = 0

    while readp < len(src):
        code = src[readp]
        readp += 1

        if (code & 0x80) == 0:
            second = src[readp]
            readp += 1
            count = ((code & 0x70) >> 4) + 3
            rpos = ((code & 0x0F) << 8) + second
            _replicate(dest, writep, writep - rpos, count)
            writep += count
        elif (code & 0x40) == 0:
            count = code & 0x3F
            if count == 0:
                return bytes(dest)
            dest[writep : writep + count] = src[readp : readp + count]
            readp += count
            writep += count
        else:
            count3 = code & 0x3F
            if count3 == 0x3E:
                count = int.from_bytes(src[readp : readp + 2], "little")
                readp += 2
                color = src[readp]
                readp += 1
                dest[writep : writep + count] = bytes([color]) * count
                writep += count
            elif count3 == 0x3F:
                count = int.from_bytes(src[readp : readp + 2], "little")
                readp += 2
                src_index = int.from_bytes(src[readp : readp + 2], "little")
                readp += 2
                for i in range(count):
                    dest[writep + i] = dest[src_index + i]
                writep += count
            else:
                count = count3 + 3
                src_index = int.from_bytes(src[readp : readp + 2], "little")
                readp += 2
                for i in range(count):
                    dest[writep + i] = dest[src_index + i]
                writep += count

    return bytes(dest)


def encode(src: bytes) -> bytes:
    """Quick Format80 encoder (raw copy + RLE), matching ccmaps-net."""
    out = bytearray()
    offset = 0
    left = len(src)
    block_start = 0

    while offset < left:
        repeat = _count_same(src, offset)
        if repeat >= 4:
            _write_copy_blocks(src, block_start, offset - block_start, out)
            out.append(0xFE)
            out.append(repeat & 0xFF)
            out.append((repeat >> 8) & 0xFF)
            out.append(src[offset])
            offset += repeat
            block_start = offset
        else:
            offset += 1

    _write_copy_blocks(src, block_start, offset - block_start, out)
    out.append(0x80)
    return bytes(out)


def _count_same(src: bytes, offset: int, limit: int = 0xFFFF) -> int:
    max_count = min(len(src) - offset, limit)
    if max_count <= 0:
        return 0
    first = src[offset]
    count = 1
    while count < max_count and src[offset + count] == first:
        count += 1
    return count


def _write_copy_blocks(src: bytes, start: int, length: int, out: bytearray) -> None:
    pos = start
    remaining = length
    while remaining > 0:
        write_now = min(remaining, 0x3F)
        out.append(0x80 | write_now)
        out.extend(src[pos : pos + write_now])
        remaining -= write_now
        pos += write_now


def _replicate(dest: bytearray, dest_index: int, src_index: int, count: int) -> None:
    if dest_index - src_index == 1:
        value = dest[dest_index - 1]
        for i in range(count):
            dest[dest_index + i] = value
    else:
        for i in range(count):
            dest[dest_index + i] = dest[src_index + i]
