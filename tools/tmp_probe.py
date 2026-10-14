"""TMP 解码器的自校验骨架（目标③：按美术象素推崖片"对手件"）。

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
    b = path.read_bytes()
    cx, cy, cblocks, w, h = struct.unpack_from("<5i", b, 0)
    data = 20 + cx * cy * 4
    offs = struct.unpack_from("<%di" % (cx * cy), b, 20)
    print(f"{path.name}: {len(b)} 字节  cx={cx} cy={cy} cblocks={cblocks} w={w} h={h}")
    print(f"  数据区起点 {data}；偏移表 = {[hex(o) for o in offs]}"
          f"（实测是**绝对文件偏移**，不是相对数据区）")
    present = [(i, o) for i, o in enumerate(offs)]
    for i, o in enumerate(offs):
        base = o          # 绝对偏移（实测）
        if o == 0 or base + 12 > len(b):
            print(f"  块{i}: 不存在")
            continue
        x, y, extra = struct.unpack_from("<3i", b, base)
        # 下一块的起点决定这一块的实测大小
        nxt = None
        for j, o2 in enumerate(offs):
            if o2 > o and (nxt is None or o2 < nxt):
                nxt = o2
        size = (nxt - base) if nxt is not None else (len(b) - base)
        print(f"  块{i}: 起点 {base}  x={x} y={y} extra_off={hex(extra)}  实测大小 {size}")
        print(f"      候选布局: 12+24bit({12 + w * h * 3}) 12+8bit({12 + w * h}) "
              f"12+24bit+extra({12 + w * h * 3}+extra)  → 与实测差 "
              f"{size - (12 + w * h * 3)} / {size - (12 + w * h)}")
    print("\n  必须成立的检查（解码器写好后逐条过）:")
    print("   a) 每块的实测大小 == 12 + 该块解码后消耗的字节数（首尾相接，无缝隙）")
    print("   b) 解码出的 cx*cy 块能恰好拼成 w*cx × h*cy 的图，透明区连续")
    print("   c) 用生成图反查：该片实例的低侧方向应与解码出的墙朝向一致")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(probe(Path(sys.argv[1])))
