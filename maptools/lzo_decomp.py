"""Pure-Python LZO1X decompressor (adapted from tohojo/pylzo, GPLv3)."""

from __future__ import annotations

import io
import struct


class LZOError(Exception):
    pass


class _EOFError(LZOError):
    pass


class _FormatError(LZOError):
    pass


class LZODecompressor:
    def __init__(self, instream: io.BufferedReader):
        self.instream = instream
        self.pos = 0
        self.output = bytearray()
        self.read_buf = b""
        self.trailing_bytes = 0

    def read_bytes(self, length: int) -> bytes:
        while len(self.read_buf) < length:
            chunk = self.instream.read(length - len(self.read_buf))
            if not chunk:
                raise _EOFError(f"EOF at pos {self.pos + len(self.read_buf)}")
            self.read_buf += chunk

        output = self.read_buf[:length]
        self.read_buf = self.read_buf[length:]
        self.pos += len(output)
        return output

    def read_1(self) -> int:
        return struct.unpack("B", self.read_bytes(1))[0]

    def read_le16(self) -> int:
        return struct.unpack("<H", self.read_bytes(2))[0]

    def copy_literal(self, length: int) -> None:
        if length:
            self.output += self.read_bytes(length)

    def copy_block(self, length: int, distance: int, trailing: int) -> None:
        if distance > len(self.output):
            raise LZOError(f"Distance {distance} > bufsize {len(self.output)}")

        orig_len = length
        block = bytes(self.output[-distance:])
        length -= len(block)
        while length > 0:
            add = block[:length]
            length -= len(add)
            block += add

        self.output += block[:orig_len]
        self.copy_literal(trailing)
        self.trailing_bytes = trailing

    def count_zeroes(self) -> int:
        length = 0
        val = self.read_1()
        while val == 0:
            length += 255
            val = self.read_1()
        if length > 2**20:
            raise LZOError("Too many zeroes")
        return length + val

    def process_instruction(self, val: int) -> bool:
        if val <= 0x0F:
            if not self.trailing_bytes:
                if val == 0:
                    self.copy_literal(self.count_zeroes() + 18)
                else:
                    self.copy_literal(val + 3)
            else:
                h = self.read_1()
                dist = (h << 2) + (val >> 2) + 1
                self.copy_block(2, dist, val & 3)
        elif val <= 0x1F:
            if val & 7 == 0:
                length = 9 + self.count_zeroes()
            else:
                length = (val & 7) + 2
            ds = self.read_le16()
            dist = 16384 + ((val & 8) >> 3) + (ds >> 2)
            if dist == 16384:
                return False
            self.copy_block(length, dist, ds & 3)
        elif val <= 0x3F:
            length = val & 31
            if length == 0:
                length = self.count_zeroes() + 31
            length += 2
            ds = self.read_le16()
            dist = 1 + (ds >> 2)
            self.copy_block(length, dist, ds & 3)
        else:
            if val <= 0x7F:
                length = 3 + ((val >> 5) & 1)
            else:
                length = 5 + ((val >> 5) & 3)
            h = self.read_1()
            dist = (h << 3) + ((val >> 2) & 7) + 1
            self.copy_block(length, dist, val & 3)
        return True

    def process_first_byte(self) -> bool:
        val = self.read_1()
        if val == 0x10:
            raise _FormatError("LZOv1")
        if val < 0x12:
            return self.process_instruction(val)
        # LZO1X initial literal run is encoded as 17 + literal_length.
        # 0x17 was an off-by-six error that truncated every such stream.
        self.copy_literal(val - 0x11)
        return True

    def decompress(self) -> bytes:
        if self.process_first_byte():
            while self.process_instruction(self.read_1()):
                pass
        return bytes(self.output)


def lzo1x_decompress(data: bytes, out_len: int | None = None) -> bytes:
    result = LZODecompressor(io.BytesIO(data)).decompress()
    if out_len is not None and len(result) < out_len:
        result += b"\x00" * (out_len - len(result))
    if out_len is not None:
        return result[:out_len]
    return result
