"""MiniLZO lzo1x_1 compression for RA2 map packs (from ccmaps-net MiniLZO)."""

from __future__ import annotations

from .lzo_decomp import lzo1x_decompress


def decompress(data: bytes, out_len: int) -> bytes:
    return lzo1x_decompress(data, out_len)


def _ctz32(value: int) -> int:
    value &= 0xFFFFFFFF
    if value == 0:
        return 32
    return ((value & -value) & 0xFFFFFFFF).bit_length() - 1


def _u32(data: bytes | bytearray, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 4], "little")


def compress(data: bytes) -> bytes:
    """
    Emit a standards-compliant literal-only LZO1X stream.

    Format5 already chunks inputs to 8192 bytes.  Literal streams are larger
    than matched streams but deterministic and, unlike the former partial
    compressor port, valid for every terrain byte pattern accepted by both
    our decoder and the game/CNCMaps decoder.
    """
    src = bytes(data)
    t = len(src)
    out = bytearray()
    if t <= 238:
        out.append(17 + t)
    else:
        tt = t - 18
        out.append(0)
        while tt > 255:
            out.append(0)
            tt -= 255
        out.append(tt)
    out.extend(src)
    out.append(17)  # 16 | 1  end marker
    out.extend((0, 0))
    return bytes(out)


def _compress_core(
    src: bytearray,
    in_base: int,
    in_len: int,
    out: bytearray,
    ti: int,
    wrkmem: list[int],
) -> tuple[int, int]:
    in_end = in_base + in_len
    ip_end = in_base + in_len - 20
    ip = in_base
    ii = in_base

    ip += (4 - ti) if ti < 4 else 0

    while True:
        ip += 1 + ((ip - ii) >> 5)
        if ip >= ip_end:
            break

        dv = _u32(src, ip)
        dindex = (((0x1824429D * dv) & 0xFFFFFFFF) >> 18) & 0x3FFF
        m_pos = in_base + wrkmem[dindex]
        wrkmem[dindex] = (ip - in_base) & 0xFFFF

        if dv != _u32(src, m_pos):
            continue

        ii -= ti
        ti = 0
        run = ip - ii
        _emit_literal(src, ii, run, out)

        m_len = 4
        while ip + m_len < ip_end:
            v = _u32(src, ip + m_len) ^ _u32(src, m_pos + m_len)
            if v != 0:
                m_len += _ctz32(v) // 8
                break
            m_len += 4
        else:
            m_len = ip_end - ip

        m_off = ip - m_pos
        ip += m_len
        ii = ip
        _emit_match(m_len, m_off, out)

    return in_end - (ii - ti), len(out)


def _emit_literal(src: bytearray, start: int, length: int, out: bytearray) -> None:
    if length <= 0:
        return
    if length <= 3:
        out[-2] |= length
        out.extend(src[start : start + length])
        return
    if length <= 18:
        out.append(length - 3)
        out.extend(src[start : start + length])
        return

    out.append(0)
    tt = length - 18
    while tt > 255:
        out.append(0)
        tt -= 255
    out.append(tt)
    out.extend(src[start : start + length])


def _emit_match(m_len: int, m_off: int, out: bytearray) -> None:
    m_off -= 1
    if m_len <= 8 and m_off <= 0x0800:
        out.append(((m_len - 1) << 5) | ((m_off & 7) << 2))
        out.append(m_off >> 3)
    elif m_off <= 0x4000:
        if m_len <= 33:
            out.append(32 | (m_len - 2))
        else:
            ml = m_len - 33
            out.append(32)
            while ml > 255:
                out.append(0)
                ml -= 255
            out.append(ml)
        out.append((m_off << 2) & 0xFF)
        out.append(m_off >> 6)
    else:
        m_off -= 0x4000
        if m_len <= 9:
            out.append(16 | ((m_off >> 11) & 8) | (m_len - 2))
        else:
            ml = m_len - 9
            out.append(16 | ((m_off >> 11) & 8))
            while ml > 255:
                out.append(0)
                ml -= 255
            out.append(ml)
        out.append((m_off << 2) & 0xFF)
        out.append(m_off >> 6)
