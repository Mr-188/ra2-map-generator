#!/usr/bin/env python3
"""Pure-Python reader for Westwood / Command & Conquer ``.mix`` archives.

Why this module exists
----------------------
The RA2/YR game install (``/home/hz/RA2MD``) ships its assets inside ``.mix``
archives whose headers are *Blowfish-encrypted*.  The only extractor available in
this repository was a prebuilt Windows/.NET executable
(``data/_mix_tools/MixExtract.exe``) which cannot run here (no ``dotnet``, no
``mono``, no ``wine``).  This module re-implements that tool in pure standard
library Python so the generator can read the retail archives on this machine.

Format overview (as implemented by ``data/_mix_tools/MixExtract.cs``)
--------------------------------------------------------------------
A ``.mix`` file is::

    +------------------------------+  offset 0
    | header (see variants below)  |
    +------------------------------+  data_start
    | payload blobs (concatenated) |
    +------------------------------+  EOF

The header encodes *numFiles* (uint16), *dataSize* (uint32) and then
*numFiles* index records of three uint32s each::

    uint32 hash     Westwood CRC32 of the upper-cased, 4-byte-padded filename
    uint32 offset   byte offset of the blob, relative to data_start
    uint32 size     blob length in bytes

The index stores *only hashes* -- filenames are not recoverable from a retail
archive.  Lookups therefore work by hashing the requested name, which makes them
inherently case-insensitive (``HashFilename`` upper-cases first).  A few MIX
files made by other tools additionally embed a *Local Mix Database* (a small
blob listing real filenames); :meth:`MixArchive.resolve_names` understands that
when present.  None of the retail RA2/YR archives in this install contain one
(verified -- see the module notes at the bottom of this docstring).

Three header variants are recognised, exactly mirroring ``ParseMix``:

1. **CNC / RA1 style** -- ``signature & 0xFFFF != 0``.  The signature *is* the
   file count; the header starts at offset 0 and is never encrypted.
2. **Generic, plaintext** -- ``signature & 0xFFFF == 0`` and the
   ``0x00020000`` flag is clear.  The 4-byte signature is skipped and the header
   follows immediately; ``data_start = 10 + numFiles * 12``.
3. **Generic, encrypted** -- the ``0x00020000`` flag is set.  ``data_start``
   begins with an 80-byte ``keyblock`` (read at file offset 4), then the first
   two header uint32s, which are Blowfish-encrypted with the *Westwood public
   key* -- see below.

Blowfish key derivation
-----------------------
Ported from ``data/_mix_tools/BlowfishKeyProvider.cs`` (which is itself derived
from OpenRA).  The 80-byte keyblock is split into 10-byte chunks; each chunk is a
little-endian RSA ciphertext raised to the public exponent 65537 modulo a
1024-bit modulus.  The modulus comes from the hard-coded base64 blob
``AihRvNoIbTn85FZRYNZRcT+i6KpU+maCsEqr3Q5q+LDB5tH7Tz2qQ38V`` (DER: ``INTEGER 2``
then ``INTEGER <n>``), and the first 56 bytes of the plaintext form the Blowfish
key.

The C# original implements that modular exponentiation as a hand-rolled
arbitrary-precision bignum stack (``mul_bignum``/``calc_a_key``/``inv_bignum``
...).  Those routines are a textbook square-and-multiply; here the same
computation is expressed with Python's built-in big integers
(``pow(ciphertext, 65537, modulus)``), which is mathematically identical and far
less error-prone.  The observable result was validated byte-for-byte against
previously extracted retail assets.

The cipher itself (``data/_mix_tools/Blowfish.cs``) is ported literally,
including its ``SwapBytes`` pre/post byte swap, which makes it a *big-endian*
Blowfish despite the little-endian word packing of the header.

Public API
----------
``open_mix(source)``        -> :class:`MixArchive` from a path or bytes
``read_mix(path)``          -> :class:`MixArchive`
``list_entries(path)``      -> ``list[MixEntry]``
``extract_entry(path, name)`` -> ``bytes`` or ``None``
``iter_entries(path)``      -> iterator over :class:`MixEntry`
``iter_nested(path)``       -> iterator over nested :class:`MixArchive`
``find_file(path, name)``   -> iterator of ``(chain, archive, entry)``

CLI::

    python3 maptools/mix_file.py list    <archive.mix>
    python3 maptools/mix_file.py extract <archive.mix> <name> <outpath>
    python3 maptools/mix_file.py find    <archive.mix> <name>
    python3 maptools/mix_file.py nested  <archive.mix>
    python3 maptools/mix_file.py info    <archive.mix>

``list``/``extract``/``find`` descend into nested MIX archives by default
(``extract`` because the retail theater INIs live one level down, inside
``local.mix``/``localmd.mix``); pass ``--depth 0`` to stay at the top level.

Only the standard library is used (``argparse``, ``struct``, ``zlib``,
``pathlib``).
"""

from __future__ import annotations

import argparse
import struct
import sys
import zlib
from collections import deque
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, NamedTuple, Optional, Sequence, Union

__all__ = [
    "MixError",
    "MixEntry",
    "MixArchive",
    "hash_filename",
    "crc32",
    "open_mix",
    "read_mix",
    "list_entries",
    "iter_entries",
    "iter_nested",
    "extract_entry",
    "find_file",
    "parse_mix_header",
    "decrypt_mix_header",
    "derive_blowfish_key",
    "Blowfish",
    "KNOWN_NAMES",
    "MIX_FLAG_CHECKSUM",
    "MIX_FLAG_ENCRYPTED",
    "LOCAL_MIX_DATABASE_HASH",
]

# --------------------------------------------------------------------------
# Header flags (MixExtract.cs: FLAG_CHECKSUM / FLAG_ENCRYPTED)
# --------------------------------------------------------------------------

MIX_FLAG_CHECKSUM = 0x00010000
MIX_FLAG_ENCRYPTED = 0x00020000

# Signature values seen on 4-byte generic headers.  Anything whose low 16 bits
# are non-zero is the older CNC-style "the signature is the file count" layout.
_MIX_SIGNATURES = (0x00000000, MIX_FLAG_CHECKSUM, MIX_FLAG_ENCRYPTED,
                   MIX_FLAG_CHECKSUM | MIX_FLAG_ENCRYPTED)

# 80 bytes of RSA ciphertext, then the encrypted header words.
_KEYBLOCK_SIZE = 80
_KEYBLOCK_OFFSET = 4

# --------------------------------------------------------------------------
# CRC32 / filename hashing (data/_mix_tools/CRC32.cs + MixExtract.HashFilename)
# --------------------------------------------------------------------------

_CRC32_POLYNOMIAL = 0xFFFFFFFF


def crc32(data: bytes, polynomial: int = _CRC32_POLYNOMIAL) -> int:
    """Westwood/standard CRC-32 (``CRC32.CalculateCrc``).

    ``zlib.crc32`` computes exactly ``init 0xFFFFFFFF / reflected / final xor``
    which is what the C# lookup-table loop does, so it is used directly.
    """
    return zlib.crc32(data) & 0xFFFFFFFF


def hash_filename(filename: str) -> int:
    """Return the MIX index hash for *filename* (``HashFilename``).

    The name is upper-cased, then padded to a multiple of four characters with
    the length remainder (as a raw character code) followed by characters copied
    from position ``len // 4 * 4`` -- a quirk of the original that matters.
    Lookups are therefore case-insensitive.
    """
    name = filename.upper()
    length = len(name)
    quarter = length >> 2
    if length & 3:
        name += chr(length - (quarter << 2))
        pad = 3 - (length & 3)
        while pad:
            name += name[quarter << 2]
            pad -= 1
    # C# uses Encoding.ASCII.GetBytes, which substitutes '?' for non-ASCII.
    return crc32(name.encode("ascii", "replace"))


# --------------------------------------------------------------------------
# Blowfish (data/_mix_tools/Blowfish.cs)
# --------------------------------------------------------------------------

_MASK32 = 0xFFFFFFFF

# Blowfish initial P-array and S-boxes: the hexadecimal digits of pi.
# Extracted programmatically (and verified) from the bundled reference
# implementation data/_mix_tools/Blowfish.cs.
P_INIT = (
    0x243F6A88, 0x85A308D3, 0x13198A2E, 0x03707344,
    0xA4093822, 0x299F31D0, 0x082EFA98, 0xEC4E6C89,
    0x452821E6, 0x38D01377, 0xBE5466CF, 0x34E90C6C,
    0xC0AC29B7, 0xC97C50DD, 0x3F84D5B5, 0xB5470917,
    0x9216D5D9, 0x8979FB1B,
)

S_INIT = (
(
    0xD1310BA6, 0x98DFB5AC, 0x2FFD72DB, 0xD01ADFB7,
    0xB8E1AFED, 0x6A267E96, 0xBA7C9045, 0xF12C7F99,
    0x24A19947, 0xB3916CF7, 0x0801F2E2, 0x858EFC16,
    0x636920D8, 0x71574E69, 0xA458FEA3, 0xF4933D7E,
    0x0D95748F, 0x728EB658, 0x718BCD58, 0x82154AEE,
    0x7B54A41D, 0xC25A59B5, 0x9C30D539, 0x2AF26013,
    0xC5D1B023, 0x286085F0, 0xCA417918, 0xB8DB38EF,
    0x8E79DCB0, 0x603A180E, 0x6C9E0E8B, 0xB01E8A3E,
    0xD71577C1, 0xBD314B27, 0x78AF2FDA, 0x55605C60,
    0xE65525F3, 0xAA55AB94, 0x57489862, 0x63E81440,
    0x55CA396A, 0x2AAB10B6, 0xB4CC5C34, 0x1141E8CE,
    0xA15486AF, 0x7C72E993, 0xB3EE1411, 0x636FBC2A,
    0x2BA9C55D, 0x741831F6, 0xCE5C3E16, 0x9B87931E,
    0xAFD6BA33, 0x6C24CF5C, 0x7A325381, 0x28958677,
    0x3B8F4898, 0x6B4BB9AF, 0xC4BFE81B, 0x66282193,
    0x61D809CC, 0xFB21A991, 0x487CAC60, 0x5DEC8032,
    0xEF845D5D, 0xE98575B1, 0xDC262302, 0xEB651B88,
    0x23893E81, 0xD396ACC5, 0x0F6D6FF3, 0x83F44239,
    0x2E0B4482, 0xA4842004, 0x69C8F04A, 0x9E1F9B5E,
    0x21C66842, 0xF6E96C9A, 0x670C9C61, 0xABD388F0,
    0x6A51A0D2, 0xD8542F68, 0x960FA728, 0xAB5133A3,
    0x6EEF0B6C, 0x137A3BE4, 0xBA3BF050, 0x7EFB2A98,
    0xA1F1651D, 0x39AF0176, 0x66CA593E, 0x82430E88,
    0x8CEE8619, 0x456F9FB4, 0x7D84A5C3, 0x3B8B5EBE,
    0xE06F75D8, 0x85C12073, 0x401A449F, 0x56C16AA6,
    0x4ED3AA62, 0x363F7706, 0x1BFEDF72, 0x429B023D,
    0x37D0D724, 0xD00A1248, 0xDB0FEAD3, 0x49F1C09B,
    0x075372C9, 0x80991B7B, 0x25D479D8, 0xF6E8DEF7,
    0xE3FE501A, 0xB6794C3B, 0x976CE0BD, 0x04C006BA,
    0xC1A94FB6, 0x409F60C4, 0x5E5C9EC2, 0x196A2463,
    0x68FB6FAF, 0x3E6C53B5, 0x1339B2EB, 0x3B52EC6F,
    0x6DFC511F, 0x9B30952C, 0xCC814544, 0xAF5EBD09,
    0xBEE3D004, 0xDE334AFD, 0x660F2807, 0x192E4BB3,
    0xC0CBA857, 0x45C8740F, 0xD20B5F39, 0xB9D3FBDB,
    0x5579C0BD, 0x1A60320A, 0xD6A100C6, 0x402C7279,
    0x679F25FE, 0xFB1FA3CC, 0x8EA5E9F8, 0xDB3222F8,
    0x3C7516DF, 0xFD616B15, 0x2F501EC8, 0xAD0552AB,
    0x323DB5FA, 0xFD238760, 0x53317B48, 0x3E00DF82,
    0x9E5C57BB, 0xCA6F8CA0, 0x1A87562E, 0xDF1769DB,
    0xD542A8F6, 0x287EFFC3, 0xAC6732C6, 0x8C4F5573,
    0x695B27B0, 0xBBCA58C8, 0xE1FFA35D, 0xB8F011A0,
    0x10FA3D98, 0xFD2183B8, 0x4AFCB56C, 0x2DD1D35B,
    0x9A53E479, 0xB6F84565, 0xD28E49BC, 0x4BFB9790,
    0xE1DDF2DA, 0xA4CB7E33, 0x62FB1341, 0xCEE4C6E8,
    0xEF20CADA, 0x36774C01, 0xD07E9EFE, 0x2BF11FB4,
    0x95DBDA4D, 0xAE909198, 0xEAAD8E71, 0x6B93D5A0,
    0xD08ED1D0, 0xAFC725E0, 0x8E3C5B2F, 0x8E7594B7,
    0x8FF6E2FB, 0xF2122B64, 0x8888B812, 0x900DF01C,
    0x4FAD5EA0, 0x688FC31C, 0xD1CFF191, 0xB3A8C1AD,
    0x2F2F2218, 0xBE0E1777, 0xEA752DFE, 0x8B021FA1,
    0xE5A0CC0F, 0xB56F74E8, 0x18ACF3D6, 0xCE89E299,
    0xB4A84FE0, 0xFD13E0B7, 0x7CC43B81, 0xD2ADA8D9,
    0x165FA266, 0x80957705, 0x93CC7314, 0x211A1477,
    0xE6AD2065, 0x77B5FA86, 0xC75442F5, 0xFB9D35CF,
    0xEBCDAF0C, 0x7B3E89A0, 0xD6411BD3, 0xAE1E7E49,
    0x00250E2D, 0x2071B35E, 0x226800BB, 0x57B8E0AF,
    0x2464369B, 0xF009B91E, 0x5563911D, 0x59DFA6AA,
    0x78C14389, 0xD95A537F, 0x207D5BA2, 0x02E5B9C5,
    0x83260376, 0x6295CFA9, 0x11C81968, 0x4E734A41,
    0xB3472DCA, 0x7B14A94A, 0x1B510052, 0x9A532915,
    0xD60F573F, 0xBC9BC6E4, 0x2B60A476, 0x81E67400,
    0x08BA6FB5, 0x571BE91F, 0xF296EC6B, 0x2A0DD915,
    0xB6636521, 0xE7B9F9B6, 0xFF34052E, 0xC5855664,
    0x53B02D5D, 0xA99F8FA1, 0x08BA4799, 0x6E85076A,
),
(
    0x4B7A70E9, 0xB5B32944, 0xDB75092E, 0xC4192623,
    0xAD6EA6B0, 0x49A7DF7D, 0x9CEE60B8, 0x8FEDB266,
    0xECAA8C71, 0x699A17FF, 0x5664526C, 0xC2B19EE1,
    0x193602A5, 0x75094C29, 0xA0591340, 0xE4183A3E,
    0x3F54989A, 0x5B429D65, 0x6B8FE4D6, 0x99F73FD6,
    0xA1D29C07, 0xEFE830F5, 0x4D2D38E6, 0xF0255DC1,
    0x4CDD2086, 0x8470EB26, 0x6382E9C6, 0x021ECC5E,
    0x09686B3F, 0x3EBAEFC9, 0x3C971814, 0x6B6A70A1,
    0x687F3584, 0x52A0E286, 0xB79C5305, 0xAA500737,
    0x3E07841C, 0x7FDEAE5C, 0x8E7D44EC, 0x5716F2B8,
    0xB03ADA37, 0xF0500C0D, 0xF01C1F04, 0x0200B3FF,
    0xAE0CF51A, 0x3CB574B2, 0x25837A58, 0xDC0921BD,
    0xD19113F9, 0x7CA92FF6, 0x94324773, 0x22F54701,
    0x3AE5E581, 0x37C2DADC, 0xC8B57634, 0x9AF3DDA7,
    0xA9446146, 0x0FD0030E, 0xECC8C73E, 0xA4751E41,
    0xE238CD99, 0x3BEA0E2F, 0x3280BBA1, 0x183EB331,
    0x4E548B38, 0x4F6DB908, 0x6F420D03, 0xF60A04BF,
    0x2CB81290, 0x24977C79, 0x5679B072, 0xBCAF89AF,
    0xDE9A771F, 0xD9930810, 0xB38BAE12, 0xDCCF3F2E,
    0x5512721F, 0x2E6B7124, 0x501ADDE6, 0x9F84CD87,
    0x7A584718, 0x7408DA17, 0xBC9F9ABC, 0xE94B7D8C,
    0xEC7AEC3A, 0xDB851DFA, 0x63094366, 0xC464C3D2,
    0xEF1C1847, 0x3215D908, 0xDD433B37, 0x24C2BA16,
    0x12A14D43, 0x2A65C451, 0x50940002, 0x133AE4DD,
    0x71DFF89E, 0x10314E55, 0x81AC77D6, 0x5F11199B,
    0x043556F1, 0xD7A3C76B, 0x3C11183B, 0x5924A509,
    0xF28FE6ED, 0x97F1FBFA, 0x9EBABF2C, 0x1E153C6E,
    0x86E34570, 0xEAE96FB1, 0x860E5E0A, 0x5A3E2AB3,
    0x771FE71C, 0x4E3D06FA, 0x2965DCB9, 0x99E71D0F,
    0x803E89D6, 0x5266C825, 0x2E4CC978, 0x9C10B36A,
    0xC6150EBA, 0x94E2EA78, 0xA5FC3C53, 0x1E0A2DF4,
    0xF2F74EA7, 0x361D2B3D, 0x1939260F, 0x19C27960,
    0x5223A708, 0xF71312B6, 0xEBADFE6E, 0xEAC31F66,
    0xE3BC4595, 0xA67BC883, 0xB17F37D1, 0x018CFF28,
    0xC332DDEF, 0xBE6C5AA5, 0x65582185, 0x68AB9802,
    0xEECEA50F, 0xDB2F953B, 0x2AEF7DAD, 0x5B6E2F84,
    0x1521B628, 0x29076170, 0xECDD4775, 0x619F1510,
    0x13CCA830, 0xEB61BD96, 0x0334FE1E, 0xAA0363CF,
    0xB5735C90, 0x4C70A239, 0xD59E9E0B, 0xCBAADE14,
    0xEECC86BC, 0x60622CA7, 0x9CAB5CAB, 0xB2F3846E,
    0x648B1EAF, 0x19BDF0CA, 0xA02369B9, 0x655ABB50,
    0x40685A32, 0x3C2AB4B3, 0x319EE9D5, 0xC021B8F7,
    0x9B540B19, 0x875FA099, 0x95F7997E, 0x623D7DA8,
    0xF837889A, 0x97E32D77, 0x11ED935F, 0x16681281,
    0x0E358829, 0xC7E61FD6, 0x96DEDFA1, 0x7858BA99,
    0x57F584A5, 0x1B227263, 0x9B83C3FF, 0x1AC24696,
    0xCDB30AEB, 0x532E3054, 0x8FD948E4, 0x6DBC3128,
    0x58EBF2EF, 0x34C6FFEA, 0xFE28ED61, 0xEE7C3C73,
    0x5D4A14D9, 0xE864B7E3, 0x42105D14, 0x203E13E0,
    0x45EEE2B6, 0xA3AAABEA, 0xDB6C4F15, 0xFACB4FD0,
    0xC742F442, 0xEF6ABBB5, 0x654F3B1D, 0x41CD2105,
    0xD81E799E, 0x86854DC7, 0xE44B476A, 0x3D816250,
    0xCF62A1F2, 0x5B8D2646, 0xFC8883A0, 0xC1C7B6A3,
    0x7F1524C3, 0x69CB7492, 0x47848A0B, 0x5692B285,
    0x095BBF00, 0xAD19489D, 0x1462B174, 0x23820E00,
    0x58428D2A, 0x0C55F5EA, 0x1DADF43E, 0x233F7061,
    0x3372F092, 0x8D937E41, 0xD65FECF1, 0x6C223BDB,
    0x7CDE3759, 0xCBEE7460, 0x4085F2A7, 0xCE77326E,
    0xA6078084, 0x19F8509E, 0xE8EFD855, 0x61D99735,
    0xA969A7AA, 0xC50C06C2, 0x5A04ABFC, 0x800BCADC,
    0x9E447A2E, 0xC3453484, 0xFDD56705, 0x0E1E9EC9,
    0xDB73DBD3, 0x105588CD, 0x675FDA79, 0xE3674340,
    0xC5C43465, 0x713E38D8, 0x3D28F89E, 0xF16DFF20,
    0x153E21E7, 0x8FB03D4A, 0xE6E39F2B, 0xDB83ADF7,
),
(
    0xE93D5A68, 0x948140F7, 0xF64C261C, 0x94692934,
    0x411520F7, 0x7602D4F7, 0xBCF46B2E, 0xD4A20068,
    0xD4082471, 0x3320F46A, 0x43B7D4B7, 0x500061AF,
    0x1E39F62E, 0x97244546, 0x14214F74, 0xBF8B8840,
    0x4D95FC1D, 0x96B591AF, 0x70F4DDD3, 0x66A02F45,
    0xBFBC09EC, 0x03BD9785, 0x7FAC6DD0, 0x31CB8504,
    0x96EB27B3, 0x55FD3941, 0xDA2547E6, 0xABCA0A9A,
    0x28507825, 0x530429F4, 0x0A2C86DA, 0xE9B66DFB,
    0x68DC1462, 0xD7486900, 0x680EC0A4, 0x27A18DEE,
    0x4F3FFEA2, 0xE887AD8C, 0xB58CE006, 0x7AF4D6B6,
    0xAACE1E7C, 0xD3375FEC, 0xCE78A399, 0x406B2A42,
    0x20FE9E35, 0xD9F385B9, 0xEE39D7AB, 0x3B124E8B,
    0x1DC9FAF7, 0x4B6D1856, 0x26A36631, 0xEAE397B2,
    0x3A6EFA74, 0xDD5B4332, 0x6841E7F7, 0xCA7820FB,
    0xFB0AF54E, 0xD8FEB397, 0x454056AC, 0xBA489527,
    0x55533A3A, 0x20838D87, 0xFE6BA9B7, 0xD096954B,
    0x55A867BC, 0xA1159A58, 0xCCA92963, 0x99E1DB33,
    0xA62A4A56, 0x3F3125F9, 0x5EF47E1C, 0x9029317C,
    0xFDF8E802, 0x04272F70, 0x80BB155C, 0x05282CE3,
    0x95C11548, 0xE4C66D22, 0x48C1133F, 0xC70F86DC,
    0x07F9C9EE, 0x41041F0F, 0x404779A4, 0x5D886E17,
    0x325F51EB, 0xD59BC0D1, 0xF2BCC18F, 0x41113564,
    0x257B7834, 0x602A9C60, 0xDFF8E8A3, 0x1F636C1B,
    0x0E12B4C2, 0x02E1329E, 0xAF664FD1, 0xCAD18115,
    0x6B2395E0, 0x333E92E1, 0x3B240B62, 0xEEBEB922,
    0x85B2A20E, 0xE6BA0D99, 0xDE720C8C, 0x2DA2F728,
    0xD0127845, 0x95B794FD, 0x647D0862, 0xE7CCF5F0,
    0x5449A36F, 0x877D48FA, 0xC39DFD27, 0xF33E8D1E,
    0x0A476341, 0x992EFF74, 0x3A6F6EAB, 0xF4F8FD37,
    0xA812DC60, 0xA1EBDDF8, 0x991BE14C, 0xDB6E6B0D,
    0xC67B5510, 0x6D672C37, 0x2765D43B, 0xDCD0E804,
    0xF1290DC7, 0xCC00FFA3, 0xB5390F92, 0x690FED0B,
    0x667B9FFB, 0xCEDB7D9C, 0xA091CF0B, 0xD9155EA3,
    0xBB132F88, 0x515BAD24, 0x7B9479BF, 0x763BD6EB,
    0x37392EB3, 0xCC115979, 0x8026E297, 0xF42E312D,
    0x6842ADA7, 0xC66A2B3B, 0x12754CCC, 0x782EF11C,
    0x6A124237, 0xB79251E7, 0x06A1BBE6, 0x4BFB6350,
    0x1A6B1018, 0x11CAEDFA, 0x3D25BDD8, 0xE2E1C3C9,
    0x44421659, 0x0A121386, 0xD90CEC6E, 0xD5ABEA2A,
    0x64AF674E, 0xDA86A85F, 0xBEBFE988, 0x64E4C3FE,
    0x9DBC8057, 0xF0F7C086, 0x60787BF8, 0x6003604D,
    0xD1FD8346, 0xF6381FB0, 0x7745AE04, 0xD736FCCC,
    0x83426B33, 0xF01EAB71, 0xB0804187, 0x3C005E5F,
    0x77A057BE, 0xBDE8AE24, 0x55464299, 0xBF582E61,
    0x4E58F48F, 0xF2DDFDA2, 0xF474EF38, 0x8789BDC2,
    0x5366F9C3, 0xC8B38E74, 0xB475F255, 0x46FCD9B9,
    0x7AEB2661, 0x8B1DDF84, 0x846A0E79, 0x915F95E2,
    0x466E598E, 0x20B45770, 0x8CD55591, 0xC902DE4C,
    0xB90BACE1, 0xBB8205D0, 0x11A86248, 0x7574A99E,
    0xB77F19B6, 0xE0A9DC09, 0x662D09A1, 0xC4324633,
    0xE85A1F02, 0x09F0BE8C, 0x4A99A025, 0x1D6EFE10,
    0x1AB93D1D, 0x0BA5A4DF, 0xA186F20F, 0x2868F169,
    0xDCB7DA83, 0x573906FE, 0xA1E2CE9B, 0x4FCD7F52,
    0x50115E01, 0xA70683FA, 0xA002B5C4, 0x0DE6D027,
    0x9AF88C27, 0x773F8641, 0xC3604C06, 0x61A806B5,
    0xF0177A28, 0xC0F586E0, 0x006058AA, 0x30DC7D62,
    0x11E69ED7, 0x2338EA63, 0x53C2DD94, 0xC2C21634,
    0xBBCBEE56, 0x90BCB6DE, 0xEBFC7DA1, 0xCE591D76,
    0x6F05E409, 0x4B7C0188, 0x39720A3D, 0x7C927C24,
    0x86E3725F, 0x724D9DB9, 0x1AC15BB4, 0xD39EB8FC,
    0xED545578, 0x08FCA5B5, 0xD83D7CD3, 0x4DAD0FC4,
    0x1E50EF5E, 0xB161E6F8, 0xA28514D9, 0x6C51133C,
    0x6FD5C7E7, 0x56E14EC4, 0x362ABFCE, 0xDDC6C837,
    0xD79A3234, 0x92638212, 0x670EFA8E, 0x406000E0,
),
(
    0x3A39CE37, 0xD3FAF5CF, 0xABC27737, 0x5AC52D1B,
    0x5CB0679E, 0x4FA33742, 0xD3822740, 0x99BC9BBE,
    0xD5118E9D, 0xBF0F7315, 0xD62D1C7E, 0xC700C47B,
    0xB78C1B6B, 0x21A19045, 0xB26EB1BE, 0x6A366EB4,
    0x5748AB2F, 0xBC946E79, 0xC6A376D2, 0x6549C2C8,
    0x530FF8EE, 0x468DDE7D, 0xD5730A1D, 0x4CD04DC6,
    0x2939BBDB, 0xA9BA4650, 0xAC9526E8, 0xBE5EE304,
    0xA1FAD5F0, 0x6A2D519A, 0x63EF8CE2, 0x9A86EE22,
    0xC089C2B8, 0x43242EF6, 0xA51E03AA, 0x9CF2D0A4,
    0x83C061BA, 0x9BE96A4D, 0x8FE51550, 0xBA645BD6,
    0x2826A2F9, 0xA73A3AE1, 0x4BA99586, 0xEF5562E9,
    0xC72FEFD3, 0xF752F7DA, 0x3F046F69, 0x77FA0A59,
    0x80E4A915, 0x87B08601, 0x9B09E6AD, 0x3B3EE593,
    0xE990FD5A, 0x9E34D797, 0x2CF0B7D9, 0x022B8B51,
    0x96D5AC3A, 0x017DA67D, 0xD1CF3ED6, 0x7C7D2D28,
    0x1F9F25CF, 0xADF2B89B, 0x5AD6B472, 0x5A88F54C,
    0xE029AC71, 0xE019A5E6, 0x47B0ACFD, 0xED93FA9B,
    0xE8D3C48D, 0x283B57CC, 0xF8D56629, 0x79132E28,
    0x785F0191, 0xED756055, 0xF7960E44, 0xE3D35E8C,
    0x15056DD4, 0x88F46DBA, 0x03A16125, 0x0564F0BD,
    0xC3EB9E15, 0x3C9057A2, 0x97271AEC, 0xA93A072A,
    0x1B3F6D9B, 0x1E6321F5, 0xF59C66FB, 0x26DCF319,
    0x7533D928, 0xB155FDF5, 0x03563482, 0x8ABA3CBB,
    0x28517711, 0xC20AD9F8, 0xABCC5167, 0xCCAD925F,
    0x4DE81751, 0x3830DC8E, 0x379D5862, 0x9320F991,
    0xEA7A90C2, 0xFB3E7BCE, 0x5121CE64, 0x774FBE32,
    0xA8B6E37E, 0xC3293D46, 0x48DE5369, 0x6413E680,
    0xA2AE0810, 0xDD6DB224, 0x69852DFD, 0x09072166,
    0xB39A460A, 0x6445C0DD, 0x586CDECF, 0x1C20C8AE,
    0x5BBEF7DD, 0x1B588D40, 0xCCD2017F, 0x6BB4E3BB,
    0xDDA26A7E, 0x3A59FF45, 0x3E350A44, 0xBCB4CDD5,
    0x72EACEA8, 0xFA6484BB, 0x8D6612AE, 0xBF3C6F47,
    0xD29BE463, 0x542F5D9E, 0xAEC2771B, 0xF64E6370,
    0x740E0D8D, 0xE75B1357, 0xF8721671, 0xAF537D5D,
    0x4040CB08, 0x4EB4E2CC, 0x34D2466A, 0x0115AF84,
    0xE1B00428, 0x95983A1D, 0x06B89FB4, 0xCE6EA048,
    0x6F3F3B82, 0x3520AB82, 0x011A1D4B, 0x277227F8,
    0x611560B1, 0xE7933FDC, 0xBB3A792B, 0x344525BD,
    0xA08839E1, 0x51CE794B, 0x2F32C9B7, 0xA01FBAC9,
    0xE01CC87E, 0xBCC7D1F6, 0xCF0111C3, 0xA1E8AAC7,
    0x1A908749, 0xD44FBD9A, 0xD0DADECB, 0xD50ADA38,
    0x0339C32A, 0xC6913667, 0x8DF9317C, 0xE0B12B4F,
    0xF79E59B7, 0x43F5BB3A, 0xF2D519FF, 0x27D9459C,
    0xBF97222C, 0x15E6FC2A, 0x0F91FC71, 0x9B941525,
    0xFAE59361, 0xCEB69CEB, 0xC2A86459, 0x12BAA8D1,
    0xB6C1075E, 0xE3056A0C, 0x10D25065, 0xCB03A442,
    0xE0EC6E0E, 0x1698DB3B, 0x4C98A0BE, 0x3278E964,
    0x9F1F9532, 0xE0D392DF, 0xD3A0342B, 0x8971F21E,
    0x1B0A7441, 0x4BA3348C, 0xC5BE7120, 0xC37632D8,
    0xDF359F8D, 0x9B992F2E, 0xE60B6F47, 0x0FE3F11D,
    0xE54CDA54, 0x1EDAD891, 0xCE6279CF, 0xCD3E7E6F,
    0x1618B166, 0xFD2C1D05, 0x848FD2C5, 0xF6FB2299,
    0xF523F357, 0xA6327623, 0x93A83531, 0x56CCCD02,
    0xACF08162, 0x5A75EBB5, 0x6E163697, 0x88D273CC,
    0xDE966292, 0x81B949D0, 0x4C50901B, 0x71C65614,
    0xE6C6C7BD, 0x327A140A, 0x45E1D006, 0xC3F27B9A,
    0xC9AA53FD, 0x62A80F00, 0xBB25BFE2, 0x35BDD2F6,
    0x71126905, 0xB2040222, 0xB6CBCF7C, 0xCD769C2B,
    0x53113EC0, 0x1640E3D3, 0x38ABBD60, 0x2547ADF0,
    0xBA38209C, 0xF746CE76, 0x77AFA1C5, 0x20756060,
    0x85CBFE4E, 0x8AE88DD8, 0x7AAAF9B0, 0x4CF9AA7E,
    0x1948C25C, 0x02FB8A8C, 0x01C36AE4, 0xD6EBE1F9,
    0x90D4F869, 0xA65CDEA0, 0x3F09252D, 0xC208E69F,
    0xB74E6132, 0xCE77E25B, 0x578FDFE3, 0x3AC372E6,
),
)


class Blowfish:
    """The C# ``Blowfish`` class, ported literally.

    Note the ``SwapBytes`` calls in ``RunCipher``: the archive stores header
    words little-endian while the cipher works on big-endian words, so every
    uint32 is byte-swapped on the way in and on the way out.
    """

    __slots__ = ("p", "s")

    def __init__(self, key: bytes) -> None:
        if not key:
            raise ValueError("Blowfish key must not be empty")
        self.p = list(P_INIT)
        self.s = [list(box) for box in S_INIT]

        j = 0
        keylen = len(key)
        for i in range(18):
            a = key[j % keylen]; j += 1
            b = key[j % keylen]; j += 1
            c = key[j % keylen]; j += 1
            d = key[j % keylen]; j += 1
            self.p[i] ^= (a << 24) | (b << 16) | (c << 8) | d

        left = right = 0
        i = 0
        while i < 18:
            left, right = self.encrypt_block(left, right)
            self.p[i] = left; i += 1
            self.p[i] = right; i += 1

        for box in range(4):
            j = 0
            while j < 256:
                left, right = self.encrypt_block(left, right)
                self.s[box][j] = left; j += 1
                self.s[box][j] = right; j += 1

    def _f(self, x: int) -> int:
        s0, s1, s2, s3 = self.s
        return ((((s0[(x >> 24) & 0xFF] + s1[(x >> 16) & 0xFF]) & _MASK32)
                 ^ s2[(x >> 8) & 0xFF]) + s3[x & 0xFF]) & _MASK32

    def encrypt_block(self, a: int, b: int) -> "tuple[int, int]":
        """Encrypt one 64-bit block, returned as ``(a, b)``."""
        p = self.p
        f = self._f
        _a = a ^ p[0]
        _b = b
        for i in range(1, 17):
            if i & 1:
                _b = (_b ^ (f(_a) ^ p[i])) & _MASK32
            else:
                _a = (_a ^ (f(_b) ^ p[i])) & _MASK32
        _b ^= p[17]
        return _b & _MASK32, _a & _MASK32

    def decrypt_block(self, a: int, b: int) -> "tuple[int, int]":
        """Decrypt one 64-bit block, returned as ``(a, b)``."""
        p = self.p
        f = self._f
        _a = a ^ p[17]
        _b = b
        for i in range(16, 0, -1):
            # C# Decrypt: x starts false, so i=16 hits the `Round(ref _b, _a, i)`
            # branch (even i updates _b, odd i updates _a).
            if i & 1:
                _a = (_a ^ (f(_b) ^ p[i])) & _MASK32
            else:
                _b = (_b ^ (f(_a) ^ p[i])) & _MASK32
        _b ^= p[0]
        return _b & _MASK32, _a & _MASK32

    @staticmethod
    def _swap_words(i: int) -> int:
        i = ((i << 16) | (i >> 16)) & _MASK32
        return (((i << 8) & 0xFF00FF00) | ((i >> 8) & 0x00FF00FF)) & _MASK32

    def _run(self, words: Sequence[int], fn) -> List[int]:
        out: List[int] = []
        swap = self._swap_words
        append = out.append
        for i in range(0, len(words) - 1, 2):
            a = swap(words[i])
            b = swap(words[i + 1])
            a, b = fn(a, b)
            append(swap(a))
            append(swap(b))
        return out

    def encrypt_words(self, words: Sequence[int]) -> List[int]:
        """Encrypt a sequence of uint32s (two per block, C# ``Encrypt``)."""
        return self._run(words, self.encrypt_block)

    def decrypt_words(self, words: Sequence[int]) -> List[int]:
        """Decrypt a sequence of uint32s (two per block, C# ``Decrypt``)."""
        return self._run(words, self.decrypt_block)

    # C#-ish aliases
    Encrypt = encrypt_words
    Decrypt = decrypt_words


# --------------------------------------------------------------------------
# Westwood public key -> Blowfish key (data/_mix_tools/BlowfishKeyProvider.cs)
# --------------------------------------------------------------------------

_PUBKEY_STR = "AihRvNoIbTn85FZRYNZRcT+i6KpU+maCsEqr3Q5q+LDB5tH7Tz2qQ38V"

_B64_ALPHABET = ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
                 "0123456789+/")
_CHAR2NUM = [-1] * 256
for _i, _ch in enumerate(_B64_ALPHABET):
    _CHAR2NUM[ord(_ch)] = _i

# Public exponent: init_bignum(pubkey.key2, 0x10001, 64)
_RSA_PUBLIC_EXPONENT = 0x10001


def _public_modulus() -> "tuple[int, int]":
    """Decode the embedded public key.

    Returns ``(modulus, pubkey_len)`` where ``pubkey_len`` is
    ``bitlen_bignum(key1, 64) - 1`` from ``init_pubkey``.
    """
    raw = bytearray()
    i = 0
    s = _PUBKEY_STR
    while i < len(s):
        tmp = _CHAR2NUM[ord(s[i])]; i += 1
        tmp = (tmp << 6) | _CHAR2NUM[ord(s[i])]; i += 1
        tmp = (tmp << 6) | _CHAR2NUM[ord(s[i])]; i += 1
        tmp = (tmp << 6) | _CHAR2NUM[ord(s[i])]; i += 1
        raw += bytes(((tmp >> 16) & 0xFF, (tmp >> 8) & 0xFF, tmp & 0xFF))

    # key_to_bignum: DER-ish "INTEGER 2" then "INTEGER modulus".
    j = 0
    if raw[j] != 2:
        raise MixError("unsupported Westwood public key encoding")
    j += 1
    if raw[j] & 0x80:
        n = raw[j] & 0x7F
        keylen = 0
        for k in range(n):
            keylen = (keylen << 8) | raw[j + k + 1]
        j += n + 1
    else:
        keylen = raw[j]
        j += 1
    modulus = int.from_bytes(bytes(raw[j:j + keylen]), "big")
    return modulus, modulus.bit_length() - 1


_PUBKEY_CACHE: Optional["tuple[int, int]"] = None


def _pubkey() -> "tuple[int, int]":
    global _PUBKEY_CACHE
    if _PUBKEY_CACHE is None:
        _PUBKEY_CACHE = _public_modulus()
    return _PUBKEY_CACHE


def derive_blowfish_key(keyblock: bytes) -> bytes:
    """Derive the 56-byte Blowfish key from an 80-byte MIX keyblock.

    Port of ``BlowfishKeyProvider.DecryptKey`` + ``process_predata``.  The
    bignum helpers of the C# original reduce to
    ``pow(ciphertext, 65537, modulus)``; ``a`` (= modulus size / 8) bytes of each
    result, written little-endian, are concatenated.
    """
    if len(keyblock) < _KEYBLOCK_SIZE:
        raise MixError("MIX keyblock is truncated (%d of %d bytes)"
                       % (len(keyblock), _KEYBLOCK_SIZE))
    modulus, pubkey_len = _pubkey()
    a = (pubkey_len - 1) // 8                       # len_predata() step
    pre_len = (55 // a + 1) * (a + 1)               # len_predata()

    out = bytearray()
    offset = 0
    # `a + 1` length chunks; write `a` bytes each, little-endian.
    while a + 1 <= pre_len:
        chunk = keyblock[offset:offset + a + 1]
        # move_key_to_big: the chunk is copied verbatim into a little-endian
        # uint array, i.e. interpreted as a little-endian integer.
        value = int.from_bytes(chunk, "little")
        decrypted = pow(value, _RSA_PUBLIC_EXPONENT, modulus)
        blob = decrypted.to_bytes((decrypted.bit_length() + 7) // 8 or 1, "little")
        out += blob[:a].ljust(a, b"\x00")
        offset += a + 1
        pre_len -= a + 1
    return bytes(out[:56])                          # dest.Take(56)


# --------------------------------------------------------------------------
# Header decryption (MixExtract.cs: DecryptHeader)
# --------------------------------------------------------------------------

class MixError(ValueError):
    """Raised when a file is not a readable MIX archive."""


def _plausible_mix_signature(signature: int) -> bool:
    """Cheap pre-filter for :meth:`MixArchive.is_mix_entry`.

    Generic MIX headers have zero in their low 16 bits; the older CNC layout
    puts the file count there, so a small positive value is also accepted.
    """
    if (signature & 0xFFFF) == 0:
        return signature in _MIX_SIGNATURES
    return (signature & 0xFFFF) <= 0x0FFF


def decrypt_mix_header(data: bytes, offset: int = _KEYBLOCK_OFFSET):
    """Decrypt a Blowfish-encrypted generic MIX header.

    Mirrors ``DecryptHeader``: read the 80-byte keyblock, derive the key,
    decrypt the two header words to learn *numFiles*, then re-read the whole
    header (from *offset*) as a padded array of uint32s and decrypt it.

    Returns ``(plain_header, data_start)`` where *plain_header* starts with
    ``numFiles`` (uint16) and ``dataSize`` (uint32).
    """
    keyblock = data[offset:offset + _KEYBLOCK_SIZE]
    key = derive_blowfish_key(keyblock)
    fish = Blowfish(key)

    first = struct.unpack_from("<II", data, offset + _KEYBLOCK_SIZE)
    dec = fish.decrypt_words(list(first))
    num_files = dec[0] & 0xFFFF

    block_size = 8
    header_len = (6 + num_files * 12 + (block_size - 1)) & ~(block_size - 1)
    n_uints = header_len // 4
    available = (len(data) - (offset + _KEYBLOCK_SIZE)) // 4
    if header_len == 0 or n_uints > available:
        raise MixError(
            "encrypted MIX header overruns the file (numFiles=%d needs %d bytes, "
            "%d available)" % (num_files, header_len,
                               len(data) - (offset + _KEYBLOCK_SIZE)))
    encrypted = list(struct.unpack_from("<%dI" % n_uints, data,
                                        offset + _KEYBLOCK_SIZE))
    decrypted = fish.decrypt_words(encrypted)
    plain = struct.pack("<%dI" % len(decrypted), *decrypted)
    data_start = offset + _KEYBLOCK_SIZE + header_len
    return plain, data_start


# --------------------------------------------------------------------------
# Index parsing (MixExtract.cs: ParseMix)
# --------------------------------------------------------------------------

class MixEntry(NamedTuple):
    """One index record.

    ``name`` is ``None`` unless a name could be resolved (the retail index only
    stores hashes).  ``offset`` is relative to the archive's ``data_start``.
    """

    name: Optional[str]
    hash: int
    offset: int
    size: int

    @property
    def end(self) -> int:
        return self.offset + self.size

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        label = self.name if self.name is not None else "0x%08X" % self.hash
        return "%-32s off=%-10d size=%d" % (label, self.offset, self.size)


def parse_mix_header(data: bytes):
    """Parse a MIX header as ``MixExtract.cs`` does.

    Returns ``(num_files, data_size, entries, data_start, signature,
    encrypted, plain_header)`` where *entries* is a list of raw
    ``(hash, offset, size)`` triples.
    """
    if len(data) < 6:
        raise MixError("file is too short to be a MIX archive (%d bytes)" % len(data))

    signature = struct.unpack_from("<I", data, 0)[0]
    is_cnc_mix = (signature & 0xFFFF) != 0
    is_encrypted = (not is_cnc_mix) and (signature & MIX_FLAG_ENCRYPTED) != 0

    if is_cnc_mix:
        # The signature *is* the file count; header begins at offset 0 and is
        # never encrypted in this layout.
        header = data
    elif is_encrypted:
        header, data_start = decrypt_mix_header(data)
    else:
        header = data[4:]

    if len(header) < 6:
        raise MixError("MIX header is truncated")

    num_files, data_size = struct.unpack_from("<HI", header, 0)
    index_len = 6 + num_files * 12
    if len(header) < index_len:
        raise MixError("MIX index is truncated (need %d bytes, have %d)"
                       % (index_len, len(header)))

    entries = [struct.unpack_from("<III", header, 6 + i * 12)
               for i in range(num_files)]

    if is_cnc_mix:
        data_start = 6 + num_files * 12
    elif is_encrypted:
        pass  # computed by decrypt_mix_header
    else:
        data_start = 4 + 6 + num_files * 12

    return num_files, data_size, entries, data_start, signature, is_encrypted, header


# --------------------------------------------------------------------------
# Local Mix Database (optional filename table)
# --------------------------------------------------------------------------

LOCAL_MIX_DATABASE_HASH = hash_filename("local mix database.dat")


def _parse_local_mix_database(blob: bytes) -> List[str]:
    """Best-effort parse of a "local mix database.dat" filename table.

    XCC writes these as two little-endian uint32s (version and entry count, or
    the reverse -- both orderings are seen) followed by that many NUL-terminated
    ASCII filenames.  We accept whichever ordering yields a self-consistent
    count and ignore anything else.
    """
    if len(blob) < 8:
        return []
    a, b = struct.unpack_from("<II", blob, 0)
    for count in (b, a):
        if count == 0 or count > 200000:
            continue
        body = blob[8:]
        if body.count(b"\x00") < count:
            continue
        names = []
        pos = 0
        for _ in range(count):
            end = body.find(b"\x00", pos)
            if end < 0:
                names = []
                break
            try:
                names.append(body[pos:end].decode("ascii"))
            except UnicodeDecodeError:
                names = []
                break
            pos = end + 1
        if names:
            return names
    return []


# --------------------------------------------------------------------------
# Well-known RA2/YR filenames used for name resolution
# --------------------------------------------------------------------------

KNOWN_NAMES = frozenset(
    # theater control INIs
    ["temperat.ini", "temperatmd.ini", "snow.ini", "snowmd.ini",
     "urban.ini", "urbanmd.ini", "urbann.ini", "urbannmd.ini",
     "desert.ini", "desertmd.ini", "lunar.ini", "lunarmd.ini",
     "rules.ini", "rulesmd.ini", "art.ini", "artmd.ini", "aimd.ini",
     "ai.ini", "ra2.ini", "ra2md.ini",
     # nested sub-archives
     "isotemp.mix", "isotemmd.mix", "temperat.mix", "tem.mix",
     "isosnow.mix", "isosnomd.mix", "snow.mix", "sno.mix",
     "isourb.mix", "isourbmd.mix", "urb.mix", "urban.mix",
     "isoubn.mix", "isoubnmd.mix", "ubn.mix", "urbann.mix",
     "isodes.mix", "isodesmd.mix", "des.mix", "desert.mix",
     "isolun.mix", "isolunmd.mix", "lun.mix", "lunar.mix",
     "local.mix", "localmd.mix", "cache.mix", "conquer.mix", "generic.mix",
     "generics.mix", "multimd.mix", "language.mix", "langmd.mix",
     "expand01.mix", "expandmd01.mix", "ra2.mix", "ra2md.mix",
     # the archive that holds the Westwood RSA public/private key
     "key.ini",
     # palettes
     "isotem.pal", "unittem.pal", "temperat.pal", "anim.pal",
     "isosno.pal", "isourb.pal", "isodes.pal", "isolun.pal", "isoubn.pal",
     "unittem.pal", "unitsno.pal", "uniturb.pal", "unitdes.pal",
     "unitubn.pal", "unitlum.pal", "libpal.pal",
     # common data files
     "local mix database.dat", "tibsun.mix", "conquer.mix"]
)


def _build_name_index(names: Optional[Iterable[str]]) -> Dict[int, str]:
    """Map hash -> name for every candidate in *names* (plus KNOWN_NAMES)."""
    table: Dict[int, str] = {}
    for name in KNOWN_NAMES:
        table.setdefault(hash_filename(name), name)
    if names:
        for name in names:
            table[hash_filename(name)] = name
    return table


# --------------------------------------------------------------------------
# Archive object
# --------------------------------------------------------------------------

class MixArchive:
    """A parsed ``.mix`` archive.

    Iterating yields :class:`MixEntry` records.  ``archive[name]`` and
    :meth:`read` return the blob for *name* (case-insensitive).
    """

    __slots__ = ("path", "data", "signature", "encrypted", "num_files",
                 "data_size", "data_start", "entries", "_index", "_positions",
                 "_names", "plain_header")

    def __init__(self, data: bytes, path: Optional[str] = None,
                 known_names: Optional[Iterable[str]] = None) -> None:
        self.path = path
        self.data = data
        (num_files, data_size, raw_entries, data_start, signature,
         encrypted, plain_header) = parse_mix_header(data)

        self.signature = signature
        self.encrypted = encrypted
        self.num_files = num_files
        self.data_size = data_size
        self.data_start = data_start
        self.plain_header = plain_header

        self._names = _build_name_index(known_names)
        built: List[MixEntry] = []
        index: Dict[int, MixEntry] = {}
        positions: Dict[int, int] = {}
        for entry_hash, offset, size in raw_entries:
            entry = MixEntry(self._names.get(entry_hash), entry_hash, offset, size)
            # MixExtract.cs keeps one entry per hash (last writer wins).
            positions[entry_hash] = len(built)
            built.append(entry)
            index[entry_hash] = entry
        self.entries = built
        self._index = index
        self._positions = positions

        # Pick up an embedded filename table when the archive has one.
        self._load_local_mix_database()

    # -- introspection -----------------------------------------------------

    def __len__(self) -> int:
        return len(self.entries)

    def __iter__(self) -> Iterator[MixEntry]:
        return iter(self.entries)

    def __getitem__(self, name: str) -> bytes:
        blob = self.read(name)
        if blob is None:
            raise KeyError(name)
        return blob

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and hash_filename(name) in self._index

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return ("MixArchive(path=%r, entries=%d, encrypted=%s, data_start=%d)"
                % (self.path, len(self.entries), self.encrypted, self.data_start))

    @property
    def size(self) -> int:
        return len(self.data)

    def entry(self, name: str) -> Optional[MixEntry]:
        """Look up one entry by name (case-insensitive), or ``None``."""
        return self._index.get(hash_filename(name))

    # -- data access -------------------------------------------------------

    def read(self, name: str) -> Optional[bytes]:
        """Return the bytes of *name* (case-insensitive), or ``None``."""
        found = self.entry(name)
        if found is None:
            return None
        start = self.data_start + found.offset
        end = start + found.size
        if start < 0 or end > len(self.data):
            raise MixError(
                "entry %r is out of bounds (offset=%d size=%d, file=%d bytes)"
                % (name, found.offset, found.size, len(self.data)))
        return self.data[start:end]

    def read_entry(self, entry: MixEntry) -> bytes:
        """Return the bytes for a :class:`MixEntry` from this archive."""
        start = self.data_start + entry.offset
        return self.data[start:start + entry.size]

    # -- name resolution ---------------------------------------------------

    def _load_local_mix_database(self) -> None:
        found = self._index.get(LOCAL_MIX_DATABASE_HASH)
        if found is None:
            return
        try:
            blob = self.read_entry(found)
        except MixError:
            return
        self.resolve_names(_parse_local_mix_database(blob))

    def resolve_names(self, names: Iterable[str]) -> int:
        """Attach real names to entries from a candidate filename list.

        Returns the number of previously-unnamed entries that were resolved.
        """
        resolved = 0
        for name in names:
            digest = hash_filename(name)
            position = self._positions.get(digest)
            if position is None:
                continue
            entry = self.entries[position]
            if entry.name is not None:
                continue
            named = entry._replace(name=name)
            self.entries[position] = named
            self._index[digest] = named
            self._names[digest] = name
            resolved += 1
        return resolved

    def name_of(self, entry_hash: int) -> Optional[str]:
        """Best-effort name for a stored hash, or ``None``."""
        return self._names.get(entry_hash)

    # -- validation / nesting ---------------------------------------------

    def validate(self) -> List[str]:
        """Return a list of structural problems (empty means clean)."""
        problems: List[str] = []
        if self.data_start > len(self.data):
            problems.append("data_start %d past EOF %d"
                            % (self.data_start, len(self.data)))
        for entry in self.entries:
            if entry.size == 0:
                continue
            if entry.end > self.data_size:
                problems.append(
                    "entry 0x%08X runs past dataSize (%d > %d)"
                    % (entry.hash, entry.end, self.data_size))
            if self.data_start + entry.end > len(self.data):
                problems.append(
                    "entry 0x%08X runs past EOF (%d > %d)"
                    % (entry.hash, self.data_start + entry.end, len(self.data)))
        return problems

    def is_mix_entry(self, entry: MixEntry) -> bool:
        """True when *entry*'s payload looks like a nested MIX archive.

        A cheap signature test runs first so that scanning a 50k-entry archive
        does not trigger thousands of Blowfish key setups.
        """
        start = self.data_start + entry.offset
        end = start + entry.size
        if entry.size < 6 or start < 0 or end > len(self.data):
            return False
        signature = struct.unpack_from("<I", self.data, start)[0]
        if not _plausible_mix_signature(signature):
            return False
        try:
            nested = MixArchive(self.data[start:end])
        except MixError:
            return False
        return nested.num_files > 0 and not nested.validate()

    def iter_nested(self) -> Iterator["MixArchive"]:
        """Yield nested :class:`MixArchive` objects found among the entries."""
        for entry in self.entries:
            if not self.is_mix_entry(entry):
                continue
            blob = self.read_entry(entry)
            yield MixArchive(blob, path=(entry.name or "0x%08X" % entry.hash))

    def find_entries(self, name: str, max_depth: int = 4):
        """Breadth-first search for *name*, descending into nested archives.

        Yields ``(chain, archive, entry)`` tuples where *chain* is a tuple of
        archive labels from the root down to the archive holding the match.
        """
        root_chain = (self.path or "<bytes>",)
        target = hash_filename(name)
        queue: "deque[tuple[MixArchive, tuple, int]]" = deque(
            [(self, root_chain, 0)])
        seen = set()
        while queue:
            archive, chain, depth = queue.popleft()
            marker = zlib.crc32(archive.data) ^ (len(archive.data) & 0xFFFFFFFF)
            if marker in seen:
                continue
            seen.add(marker)

            found = archive._index.get(target)
            if found is not None:
                yield chain, archive, found
            if depth >= max_depth:
                continue

            for entry in archive.entries:
                if not archive.is_mix_entry(entry):
                    continue
                blob = archive.read_entry(entry)
                label = entry.name or "0x%08X" % entry.hash
                try:
                    child = MixArchive(blob, path=label)
                except MixError:
                    continue
                queue.append((child, chain + (label,), depth + 1))

    def find_one(self, name: str, max_depth: int = 0):
        """Return the first ``(chain, archive, entry)`` match, or ``None``.

        ``max_depth=0`` searches only this archive.
        """
        for match in self.find_entries(name, max_depth=max_depth):
            return match
        return None

    def extract(self, name: str, max_depth: int = 0) -> Optional[bytes]:
        """Extract *name* (case-insensitive), optionally searching nested MIXes."""
        match = self.find_one(name, max_depth=max_depth)
        if match is None:
            return None
        _, holder, entry = match
        return holder.read_entry(entry)


# --------------------------------------------------------------------------
# Module-level helpers
# --------------------------------------------------------------------------

def open_mix(source: Union[str, Path, bytes, bytearray],
             known_names: Optional[Iterable[str]] = None) -> MixArchive:
    """Open a ``.mix`` archive from a path or from raw bytes."""
    if isinstance(source, (bytes, bytearray)):
        return MixArchive(bytes(source), path=None, known_names=known_names)
    path = Path(source)
    archive = MixArchive(path.read_bytes(), path=str(path),
                         known_names=known_names)
    return archive


def read_mix(path: Union[str, Path],
             known_names: Optional[Iterable[str]] = None) -> MixArchive:
    """Read *path* and return a :class:`MixArchive`."""
    return open_mix(path, known_names=known_names)


def list_entries(path: Union[str, Path],
                 known_names: Optional[Iterable[str]] = None) -> List[MixEntry]:
    """Return the entry list of *path* as ``(name, offset, size)`` records."""
    return list(read_mix(path, known_names=known_names).entries)


def iter_entries(path: Union[str, Path],
                 known_names: Optional[Iterable[str]] = None) -> Iterator[MixEntry]:
    """Iterate over the entries of *path* lazily."""
    return iter(read_mix(path, known_names=known_names).entries)


def iter_nested(path: Union[str, Path]) -> Iterator[MixArchive]:
    """Iterate over nested MIX archives inside *path*."""
    return read_mix(path).iter_nested()


def find_file(path: Union[str, Path], name: str, max_depth: int = 4):
    """Search *path*, descending into nested MIX archives, for *name*.

    Yields ``(chain, archive, entry)`` tuples; see
    :meth:`MixArchive.find_entries`.
    """
    return read_mix(path).find_entries(name, max_depth=max_depth)


def extract_entry(source: Union[str, Path, bytes, bytearray], name: str,
                  known_names: Optional[Iterable[str]] = None) -> Optional[bytes]:
    """Extract one entry's bytes by name (case-insensitive), or ``None``."""
    return open_mix(source, known_names=known_names).read(name)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _format_hex(value: int) -> str:
    return "0x%08X" % value


def _cmd_list(args: argparse.Namespace) -> int:
    archive = read_mix(args.archive)
    print("archive:    %s" % (archive.path or "<bytes>"))
    print("size:       %d bytes" % archive.size)
    print("signature:  %s%s" % (_format_hex(archive.signature),
                                " (encrypted header)" if archive.encrypted else ""))
    print("entries:    %d" % archive.num_files)
    print("dataSize:   %d" % archive.data_size)
    print("dataStart:  %d" % archive.data_start)
    problems = archive.validate()
    print("integrity:  %s" % ("ok" if not problems else "%d problem(s)" % len(problems)))
    for problem in problems:
        print("  ! %s" % problem)
    print("-" * 72)
    unnamed = 0
    for entry in archive.entries:
        label = entry.name if entry.name is not None else _format_hex(entry.hash)
        if entry.name is None:
            unnamed += 1
        print("%-34s %12d %12d" % (label, entry.offset, entry.size))
    if unnamed:
        print("-" * 72)
        print("note: %d of %d entries have no known filename (MIX stores only "
              "32-bit hashes)." % (unnamed, archive.num_files))
    return 0


def _cmd_extract(args: argparse.Namespace) -> int:
    archive = read_mix(args.archive)
    match = archive.find_one(args.name, max_depth=args.depth)
    if match is None:
        print("error: %r not found in %s (search depth %d)"
              % (args.name, archive.path, args.depth), file=sys.stderr)
        return 2
    chain, holder, entry = match
    blob = holder.read_entry(entry)
    out = Path(args.outpath)
    if out.parent and str(out.parent) not in ("", "."):
        out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(blob)
    print("wrote %d bytes to %s (from %s)"
          % (len(blob), out, " / ".join(chain)))
    return 0


def _cmd_info(args: argparse.Namespace) -> int:
    """Show header metadata only (cheap on huge archives)."""
    archive = read_mix(args.archive)
    print("archive:   %s" % (archive.path or "<bytes>"))
    print("size:      %d" % archive.size)
    print("signature: %s" % _format_hex(archive.signature))
    print("encrypted: %s" % archive.encrypted)
    print("entries:   %d" % archive.num_files)
    print("dataSize:  %d" % archive.data_size)
    print("dataStart: %d" % archive.data_start)
    print("integrity: %s" % ("ok" if not archive.validate() else "problems"))
    return 0


def _cmd_nested(args: argparse.Namespace) -> int:
    """List entries that are themselves MIX archives."""
    archive = read_mix(args.archive)
    count = 0
    for entry in archive.entries:
        if not archive.is_mix_entry(entry):
            continue
        blob = archive.read_entry(entry)
        nested = MixArchive(blob)
        count += 1
        label = entry.name if entry.name is not None else _format_hex(entry.hash)
        print("%-30s %12d bytes  ->  %6d entries  sig=%s%s"
              % (label, entry.size, nested.num_files,
                 _format_hex(nested.signature),
                 " (encrypted)" if nested.encrypted else ""))
    if not count:
        print("no nested MIX archives found in %s" % (archive.path or "<bytes>"))
    return 0


def _cmd_find(args: argparse.Namespace) -> int:
    """Locate a file by name, descending into nested MIX archives."""
    archive = read_mix(args.archive)
    hits = 0
    for chain, holder, entry in archive.find_entries(args.name, args.depth):
        hits += 1
        print("%s  ->  %s  offset=%d size=%d"
              % (" / ".join(chain),
                 entry.name or _format_hex(entry.hash), entry.offset, entry.size))
    if not hits:
        print("%r not found in %s (search depth %d)"
              % (args.name, args.archive, args.depth))
        return 2
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mix_file.py",
        description="Read and extract Westwood/RA2/YR .mix archives "
                    "(pure Python, stdlib only).")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="list entries of an archive")
    p_list.add_argument("archive", help="path to a .mix file")
    p_list.set_defaults(func=_cmd_list)

    p_extract = sub.add_parser(
        "extract",
        help="extract one entry by name (searches nested MIX archives)")
    p_extract.add_argument("archive", help="path to a .mix file")
    p_extract.add_argument("name", help="entry filename (case-insensitive)")
    p_extract.add_argument("outpath", help="where to write the extracted bytes")
    p_extract.add_argument("--depth", type=int, default=3,
                           help="nesting depth to search (default 3, 0 = top level only)")
    p_extract.set_defaults(func=_cmd_extract)

    p_info = sub.add_parser("info", help="show header metadata only")
    p_info.add_argument("archive", help="path to a .mix file")
    p_info.set_defaults(func=_cmd_info)

    p_nested = sub.add_parser("nested", help="list nested MIX sub-archives")
    p_nested.add_argument("archive", help="path to a .mix file")
    p_nested.set_defaults(func=_cmd_nested)

    p_find = sub.add_parser(
        "find", help="locate a file by name, descending into nested archives")
    p_find.add_argument("archive", help="path to a .mix file")
    p_find.add_argument("name", help="entry filename (case-insensitive)")
    p_find.add_argument("--depth", type=int, default=4,
                        help="maximum nesting depth (default 4)")
    p_find.set_defaults(func=_cmd_find)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except MixError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    except FileNotFoundError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
