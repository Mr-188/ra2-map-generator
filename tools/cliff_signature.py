import struct, sys
sys.path.insert(0,'tools'); sys.path.insert(0,'.')
from pathlib import Path
from maptools.map_ini import load_map, parse_map_size
from verify_symmetry import parse_table, FOOTPRINTS_CPP
D = Path('build/oracle_assets/Tile资源/温和')
UNSET = 0xCDCDCDCD - (1 << 32)          # 0xCDCDCDCD 作为有符号 int32

def sig(i):
    """(block_w, block_h, cells{(row,col): (ex,ey,ew,eh) or None}, cell_xy{(row,col):(X,Y)})"""
    b = (D / ('Cliff%02d.tem' % (i+1))).read_bytes()
    bw, bh, biw, bih = struct.unpack_from('<4I', b, 0)
    ptrs = struct.unpack_from('<%dI' % (bw*bh), b, 16)
    cells = {}
    for k, o in enumerate(ptrs):
        if o == 0 or o + 52 > len(b): continue
        (x, y, extra, zoff, extraz, ex, ey, ew, eh) = struct.unpack_from('<9i', b, o)
        row, col = k // bw, k % bw
        has = not (ex == UNSET or ew <= 0 or ew > 256 or eh <= 0 or eh > 256)
        cells[(row, col)] = ((ex, ey, ew, eh) if has else None, x, y)
    return bw, bh, cells

def tb_key(bw, bh, cells):
    """TB（反对角翻转）镜像后的签名：格 (row,col) -> (bw-1-col, bh-1-row)，尺寸换轴；
    Extra 在格内做**屏幕竖直翻转** y' = 30 - ey - eh（x 不变）。"""
    out = {}
    for (row, col), (ex, x, y) in cells.items():
        nrow, ncol = bw - 1 - col, bh - 1 - row
        if ex is None:
            out[(nrow, ncol)] = None
        else:
            e = (ex[0], 30 - ex[1] - ex[3], ex[2], ex[3])
            out[(nrow, ncol)] = e
    return out

def match(a, b):
    """两个签名（同格集合）的差异：格不符 + Extra 几何差异"""
    if set(a) != set(b): return None
    d = 0
    for k in a:
        if (a[k] is None) != (b[k] is None): d += 1
        elif a[k] is not None:
            d += sum(1 for u, v in zip(a[k], b[k]) if abs(u - v) > 1) + \
                 (0 if a[k] == b[k] else 0.5)
    return d

tab = parse_table(FOOTPRINTS_CPP.read_text(errors='replace'), 'kCliffFootprints')
sigs = {i: sig(i) for i in range(40)}
def footprint(i):
    bw, bh, cells = sigs[i]
    m = 0
    for (row, col) in cells: m |= 1 << (row * bw + col)
    return bw, bh, m
def tb_fp(bw, bh, m):
    """反对角翻转后的足印：新网格 = (bh 行 x bw 列)? 不 —— 新尺寸 = bw 行 x bh 列，
    与引擎的 tw=bh/th=bw 一致；线性索引用新行宽 tw=bh。"""
    tw, th = bh, bw
    out = 0
    for row in range(bh):
        for col in range(bw):
            if (m >> (row * bw + col)) & 1:
                nr, nc = bw - 1 - col, bh - 1 - row
                out |= 1 << (nr * tw + nc)
    return out
for p in (21, 38, 39, 34):
    bw, bh, cells = sigs[p]
    bw2, bh2, m2 = footprint(p); want = tb_fp(bw2, bh2, m2)
    cands = [q for q in range(40) if footprint(q)[2] == want
             and footprint(q)[:2] == (bh2, bw2)]
    pk = tb_key(bw2, bh2, cells)
    print('片%2d（%dx%d，%d 格）同足印候选 %s' % (p, bw2, bh2, len(cells), cands))
    res = []
    for q in cands:
        qbw, qbh, qcells = sigs[q]
        qk = {k: v[0] for k, v in qcells.items()}
        # 候选自身的格集合要按"未镜像"对比：pk 的格已镜像到同尺寸
        d = match(pk, qk)
        if d is not None: res.append((d, q))
    print('   签名差异（小=更像）:', sorted(res)[:6])
