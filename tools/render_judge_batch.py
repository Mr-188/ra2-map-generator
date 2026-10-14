"""批量版"渲染器当裁判"：给崖片定镜像对手件（带缓存、可断点续跑）。

用法：
    python3 tools/render_judge_batch.py --map <TB图.yrm> --pieces 0-4 --samples 1

思路（每一步都有实测判据，见 docs/SYMMETRY_STATUS.md 新目标轮 3/4）：
  * 样例 = TB 图里"两侧都是崖族(CliffSet)且 8 邻局部地形垂直镜像"的镜像对；
  * 邻居对应关系是 (dx,dy) <-> (-dy,-dx)（写反了一个样例都找不到）；
  * 该件自己的象素用**渲染差分**隔离：同一张图渲染两次，只差目标格的 IsoTileTypeIndex；
  * 打分 = |flipud(contribA) - contribB(候选)| 在并集掩膜上的平均绝对差；
  * 每片取它所有样例的**平均**（单样例噪声大：瓦片集里的对手件是手绘近似，不是逐象素翻转）。

渲染结果按"网格变动的哈希"缓存到 build/ro-sym/rj_cache/，重跑不会重复渲染。
"""
from __future__ import annotations
import argparse
import hashlib
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / 'tools')); sys.path.insert(0, str(ROOT / 'build/ro-sym'))
import numpy as np                                    # noqa: E402
from PIL import Image                                 # noqa: E402
from harness import records, write_records            # noqa: E402
from maptools.map_ini import load_map, parse_map_size  # noqa: E402
from verify_symmetry import parse_table, FOOTPRINTS_CPP  # noqa: E402
from verify_render import dotnet_env, RENDERER        # noqa: E402
from maptools.game_dir import find_game_dir           # noqa: E402

CLIFF = 49          # CliffSet base
CACHE = ROOT / 'build/ro-sym/rj_cache'
EMPTY = 0xFFFF


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--map', default='build/tb_review/matrix/sym3_t0_l3.yrm')
    ap.add_argument('--pieces', default='0-3', help='片号区间，如 0-4')
    ap.add_argument('--samples', type=int, default=1, help='每片最多用几个样例')
    args = ap.parse_args()

    lo, hi = (int(v) for v in args.pieces.split('-'))
    src = Path(args.map)
    sections, recs = records(src)
    Wp, Hp = parse_map_size(load_map(src))
    K = Wp + Hp
    cells = {(r[0], r[1]): r for r in recs}
    tab = parse_table(FOOTPRINTS_CPP.read_text(errors='replace'), 'kCliffFootprints')
    offsets = {r[0] * 100000 + r[1]: i for i, r in enumerate(recs)}
    CACHE.mkdir(parents=True, exist_ok=True)
    dn, denv = dotnet_env(); game = find_game_dir()

    map_fp = hashlib.md5(src.read_bytes()).hexdigest()[:8]   # 缓存键必须带地图指纹

    def render(mods: dict, tag: str) -> np.ndarray:
        key = hashlib.md5((map_fp + repr(sorted(mods.items()))).encode()).hexdigest()[:12]
        png = CACHE / f'{key}.png'
        if not png.is_file():
            out = [list(t) for t in recs]
            for (cx, cy), tile in mods.items():
                out[offsets[cx * 100000 + cy]][2] = tile
            dst = CACHE / f'{key}.yrm'
            write_records(sections, [tuple(r) for r in out], dst)
            p = dst.with_suffix('')
            for attempt in (1, 2):
                subprocess.run([dn, str(RENDERER), '-i', str(dst), '-m', str(game),
                                '-p', '-o', str(p), '-Y'],
                               capture_output=True, text=True, timeout=900, env=denv)
                if png.is_file():
                    break
                print(f'    [warn] 渲染 {key} 第 {attempt} 次没产出 PNG，重试')
                time.sleep(2)
        return np.asarray(Image.open(png).convert('RGB')).astype(np.int16)


    def box(x: int, y: int, z: int) -> tuple[int, int]:
        return ((x - y + Wp) * 30 - 120, (x + y - Wp - 1 - z) * 15 - 75)

    # 样例：两侧崖族 + 8 邻局部地形垂直镜像
    samples = defaultdict(list)
    for (x, y), r in cells.items():
        if not (CLIFF <= r[2] < CLIFF + 40):
            continue
        m = (K - y, K - x)
        o = cells.get(m)
        if o is None or not (CLIFF <= o[2] < CLIFF + 40) or (x, y) > m:
            continue
        ok = True
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                p1 = cells.get((x + dx, y + dy)); p2 = cells.get((m[0] - dy, m[1] - dx))
                if (p1 is None) != (p2 is None) or (p1 and p2 and p1[4] != p2[4]):
                    ok = False; break
            if not ok:
                break
        if ok:
            ax, ay = box(x, y, r[4]); bx, by = box(m[0], m[1], o[4])
            if ax < 0 or ay < 0 or bx < 0 or by < 0:
                continue                    # 裁剪越界（菱形边缘），无法比对
            samples[r[2] - CLIFF].append(((x, y), r, m, o))
    print('样例分布（片号: 对数）:', {k: len(v) for k, v in sorted(samples.items())})

    for piece in range(lo, hi + 1):
        picked = samples.get(piece, [])[:args.samples]
        if not picked:
            continue
        # 同足印候选
        w0, h0, mask0 = tab[piece]
        tw, th = h0, w0
        want = 0
        for row in range(h0):
            for col in range(w0):
                if (mask0 >> (row * w0 + col)) & 1:
                    want |= 1 << ((w0 - 1 - col) * tw + (h0 - 1 - row))
        cands = [i for i, (w, h, mk) in enumerate(tab) if (w, h, mk) == (tw, th, want)]
        print(f'片{piece:2d}: {len(picked)} 个样例，候选 {cands}')
        score = defaultdict(list)
        for (x, y), r, m, o in picked:
            ax, ay = box(x, y, r[4]); bx, by = box(m[0], m[1], o[4])
            base = render({}, 'base')
            noA = render({(x, y): EMPTY}, 'noA')
            noB = render({m: EMPTY}, 'noB')
            cA = np.abs(base[ay:ay+30, ax:ax+60] - noA[ay:ay+30, ax:ax+60]).sum(2)
            fA = np.flipud(cA) > 20
            for q in cands:
                w = render({m: CLIFF + q}, f'q{q}')
                cB = np.abs(w[by:by+30, bx:bx+60] - noB[by:by+30, bx:bx+60]).sum(2)
                mB = cB > 20
                union = fA | mB
                if not union.any():
                    continue
                d = float(np.abs((fA * 1.0) - (mB * 1.0))[union].sum()) / union.sum()
                iou = float((fA & mB).sum()) / max(1, int((fA | mB).sum()))
                score[q].append((d, iou))
        for q in sorted(score):
            ds = [v[0] for v in score[q]]; io = [v[1] for v in score[q]]
            print(f'    候选 {q:2d}: 平均掩膜差 {sum(ds)/len(ds):.3f}  平均 IoU {sum(io)/len(io):.3f}')
        if score:
            best = min(score, key=lambda q: sum(v[0] for v in score[q]) / len(score[q]))
            print(f'  → 片{piece} 判定对手件 = {best}（当前引擎用的是另一片）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
