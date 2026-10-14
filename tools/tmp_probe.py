"""TMP 结构解析（权威结构见 ModEnc 的 TMP 页）（目标③：按美术象素推崖片"对手件"）。

用法（写好解码器后）：

    python3 build/ro-sym/tmp_probe.py build/oracle_assets/Tile资源/温和/Cliff01.tem

它不解码，只把"文档格式 vs 实测文件"之间必须成立的关系摆出来，让解码器的每一步都能立刻
被证伪——避免再一次"拿脚本输出当事实"（本会话已经因此更正过三次口径）：

  1. 偏移表（0x14 起，cx*cy 项）的值是**相对数据区**的偏移；相邻非零项之差 = 块大小；
     本文件块大小实测 2516 / 4756 / 3576 / 3564，而 "12 + w*h*3 = 4812" 对不上 ✗
     → 块内除 24 位图之外还有**变长段**（或压缩），这是要试出来的东西；
  2. 各块 12 字节头的 `x/y` 应当把块摆成 cx*cy 的网格（本文件 x ∈ {0,-30}、y ∈ {0,15,30,45}）；
  3. `extra_off`（第 3 个 dword）在本文件三块里**恒等于 0x73C** → 它不是"逐块的额外数据偏移"，
     更像固定字段/共享偏移，解码器不能按"每块自己的 extra 段"去算长度；
  4. 30x40 的块共 1200 象素：24 位图 = 3600 字节；8 位索引 = 1200 字节。两种都与实测块大小
     不全匹配 → 需要判断是不是 RLE。

把它和 tools/verify_symmetry.py 的朝向口径配合用：解码器一旦能把某片解出来，就用
"该片的低侧方向"是否与它被引擎用到的位置一致来自校验（数据在校验里，不在猜测里）。
"""
from __future__ import annotations
import struct
import sys
from pathlib import Path


def probe(path: Path) -> int:
    """按 ModEnc 的权威结构解析（https://modenc.renegadeprojects.com/TMP，2025-05 修订）。

    FileHeader: uint BlockWidth, BlockHeight, BlockImageWidth, BlockImageHeight   (16 字节)
    随后 BlockWidth*BlockHeight 个 uint 指针（指向各 TileCellHeader；0 = 该格不存在）
    TileCellHeader (52 字节):
        int X, Y; uint ExtraDataOffset, ZDataoffset, ExtraZDataoffset;
        int ExtraX, ExtraY; uint ExtraWidth, ExtraHeight;
        uchar Bitfield; BYTE pad[3]; uchar Height, LandType, SlopeType;
        RGB TL, RGB BR; BYTE pad2[3];
    图形数据在各自 cell header 之后。
    """
    b = path.read_bytes()
    bw, bh, biw, bih = struct.unpack_from("<4I", b, 0)
    cells = bw * bh
    ptrs = struct.unpack_from("<%dI" % cells, b, 16)
    print(f"{path.name}: {len(b)} 字节  BlockWidth={bw} BlockHeight={bh} "
          f"BlockImage={biw}x{bih}  格数={cells}")
    print(f"  指针表 = {[hex(p) for p in ptrs]}")
    n = 0
    for i, o in enumerate(ptrs):
        if o == 0 or o + 52 > len(b):
            continue
        (x, y, extra, zoff, extraz, ex, ey, ew, eh,
         bitfield) = struct.unpack_from("<9iB", b, o)
        pad = b[o + 37:o + 40]
        height, land, slope = b[o + 40], b[o + 41], b[o + 42]
        tl = tuple(b[o + 43:o + 46]); br = tuple(b[o + 46:o + 49])
        print(f"  格{i} @{o}: X={x} Y={y} Extra=(off {extra}, {ex},{ey} {ew}x{eh}) "
              f"Z={zoff} ExtraZ={extraz}")
        print(f"        Bitfield=0x{bitfield:02X} (extra={bitfield & 1} z={(bitfield >> 1) & 1} "
              f"damaged={(bitfield >> 2) & 1}) pad={pad.hex(' ')} "
              f"Height={height} LandType={land} Slope={slope} TL={tl} BR={br}")
        n += 1
    print(f"  解析到 {n} 个存在的格")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(probe(Path(sys.argv[1])))
