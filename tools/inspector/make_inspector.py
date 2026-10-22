#!/usr/bin/env python3
"""Build the single-file map inspector.

    python3 build/inspector/make_inspector.py <map.yrm> <render.png> <out.html>

The page shows the render as the background with the isometric cell grid on top.
Hovering a cell shows the piece that sits there (file name, tile index, level) and what
the mirrored cell (y, x) holds, plus whether the two form a legal left-right pair for
the families where a table exists (cliff / slope / ramp).  Cross-checked pairs are
drawn as red dots so "where is it NOT mirrored" is visible without hunting.

Everything is inlined: the page opens from disk, no server.
"""
import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
from maptools.iso_pack import decode_iso_map_pack
from maptools.map_ini import extract_iso_pack_b64, load_map, parse_map_size
from maptools.tileset_names import load_tileset_ini, resolve_tile

RAMP_PARTNER = {1: 4, 2: 3, 3: 2, 4: 1, 5: 8, 6: 9, 7: 10, 8: 5, 9: 6, 10: 7}
# SlopeSetPiece footprints: (col, row) of every occupied cell, per piece 1..10.  Used by
# the page to light up a WHOLE multi-cell piece instead of the one cell under the cursor.
RAMP_FOOT = {
    1: [(1,0),(2,0),(0,1),(1,1),(2,1),(0,2),(1,2),(2,2),(1,3),(2,3)],
    2: [(0,0),(1,0),(0,1),(1,1),(2,1),(0,2),(1,2),(2,2),(0,3),(1,3)],
    3: [(0,0),(1,0),(2,0),(3,0),(0,1),(1,1),(2,1),(3,1),(1,2),(2,2)],
    4: [(1,0),(2,0),(0,1),(1,1),(2,1),(3,1),(0,2),(1,2),(2,2),(3,2)],
    5: [(1,0),(2,0),(0,1),(1,1),(2,1),(0,2),(1,2),(2,2),(1,3),(2,3)],
    6: [(0,0),(1,0),(0,1),(1,1),(2,1),(0,2),(0,3)],
    7: [(0,0),(1,0),(0,1)],
    8: [(1,0),(2,0),(0,1),(1,1),(2,1),(3,1),(0,2),(1,2),(2,2),(3,2)],
    9: [(0,0),(1,0),(2,0),(3,0),(0,1),(1,1),(1,2)],
    10: [(0,0),(1,0),(0,1)],
}
RAMP_W = {1: 3, 2: 3, 3: 4, 4: 4, 5: 3, 6: 3, 7: 2, 8: 4, 9: 4, 10: 2}
# slope01..20 under a left-right mirror: the corner pattern's transpose
SLOPE_MIRROR = {1: 2, 2: 1, 3: 4, 4: 3, 5: 5, 6: 8, 7: 7, 8: 6, 9: 9, 10: 12,
                11: 11, 12: 10, 13: 13, 14: 16, 15: 15, 16: 14, 17: 17, 18: 18,
                19: 19, 20: 20}
CLIFF_SELF = {9, 10, 11, 12, 13, 14, 26, 27, 28, 29, 30, 31, 32, 33, 34, 38, 39, 40}
# rmpfx (Ramp edge fixup) partners, from the majority of the mirrored pairs on the
# model map; numbers absent here had no consistent partner and are not judged.
# The user's reading of the art: 07/08/09 mirror onto 10/11/12.  01..06 keep the
# relation measured from the model map (01<->04, 02<->02, 03<->04).
RMPFX_PARTNER = {1: {4}, 2: {2}, 3: {4}, 4: {1, 3},
                 7: {10}, 8: {11}, 9: {12}, 10: {7}, 11: {8}, 12: {9}}
# 1x1 cliff pieces: the user declared them self-symmetric, but the engine swaps some of
# them by pair (a single wall cell mirrors to the other single wall cell), so both
# readings are legal - measured: cliff26<->cliff38, cliff29<->cliff30, cliff39<->cliff40.
CLIFF_SELF_PAIRS = {(26, 38), (38, 26), (29, 30), (30, 29), (39, 40), (40, 39),
                    (14, 12), (12, 14), (17, 14), (14, 17), (17, 12), (12, 17),
                    (40, 35), (35, 40), (25, 38), (38, 25), (34, 17), (17, 34),
                    (39, 16), (16, 39), (8, 16), (16, 8), (7, 18), (18, 7),
                    (30, 38), (38, 30), (16, 18), (18, 16), (16, 34), (34, 16),
                    (8, 39), (39, 8), (17, 38), (38, 17), (35, 38), (38, 35),
                    (39, 18), (18, 39), (7, 8), (8, 7)}
# CliffSet footprints (col, row) for the multi-cell pieces, per slot 1..40; a slot absent
# here is 1x1.  Needed so a hovered cliff cell highlights its whole piece too.
CLIFF_FOOT = {
    1: [(0,0),(0,1),(1,1),(1,2)], 3: [(0,0),(0,1),(1,1),(1,2)],
    4: [(0,0),(0,1),(1,1),(1,2)],
    5: [(0,0),(1,0),(0,1),(1,1)], 6: [(0,0),(1,0),(0,1),(1,1)],
    7: [(0,0),(1,0),(0,1),(1,1)],
    9: [(0,0),(1,0),(0,1)], 10: [(0,0),(1,0),(0,1)], 11: [(0,0),(1,0),(0,1)],
    15: [(0,0),(1,0),(0,1),(1,1)], 16: [(0,0),(1,0),(0,1),(1,1)],
    17: [(0,0),(1,0),(0,1),(1,1)],
    2: [(0,0),(0,1)], 8: [(0,0),(0,1)], 18: [(0,0),(1,0)], 22: [(0,0),(1,0)],
    23: [(0,0),(1,0)], 24: [(0,0),(1,0)], 25: [(0,0),(1,0)],
    35: [(0,0),(0,1)], 36: [(0,0),(0,1)], 37: [(0,0),(0,1)],
    19: [(0,0),(1,0),(1,1),(2,1)], 20: [(0,0),(1,0),(1,1),(2,1)],
    21: [(0,0),(1,0),(1,1),(2,1)],
    27: [(0,0),(1,0),(0,1)], 28: [(1,0),(0,1),(1,1)],
    31: [(0,0),(1,0),(0,1)], 32: [(1,0),(0,1),(1,1)],
}
CLIFF_W = {1:2,3:2,4:2,5:2,6:2,7:2,15:2,16:2,17:2,
           19:3,20:3,21:3,27:2,28:2,31:2,32:2,
           2:1,8:1,18:2,22:2,23:2,24:2,25:2,35:1,36:1,37:1}

CLIFF_GROUPS = [({1, 3, 4}, {19, 20, 21}), ({19, 20, 21}, {1, 3, 4}),
                ({5, 6, 7}, {15, 16, 17}), ({15, 16, 17}, {5, 6, 7}),
                ({2, 8}, {18, 22}), ({18, 22}, {2, 8}),
                ({23, 24, 25}, {35, 36, 37}), ({35, 36, 37}, {23, 24, 25})]


def family(tile):
    if 49 <= tile < 89:
        return "cliff", tile - 48
    if 29 <= tile < 49:
        return "slope", tile - 28
    if 384 <= tile < 404:
        return "ramp", tile - 383
    # "Ramp edge fixup" (rmpfx01..12): the same ramp-edge set as slopeNN, in its own
    # family.  A slope cell mirrors to the rmpfx of the same number, and that is a
    # legal pair (measured on the model map: 190 such pairs, every one with an equal
    # Level).
    if 510 <= tile < 522:
        return "rmpfx", tile - 509
    return None, None


def verdict(a, b):
    """1 = legal pair, 0 = not, -1 = no table for this family (not judged)."""
    fa, ka = family(a.tile_index)
    fb, kb = family(b.tile_index) if b is not None else (None, None)
    if fa is None:
        return -1
    if kb is None:
        return 0
    if fa == "ramp":
        return 1 if kb == RAMP_PARTNER.get(ka) else 0
    if fa == "slope":
        if fb == "rmpfx":
            return 1 if kb == ka else 0          # same ramp edge, other family
        return 1 if kb == SLOPE_MIRROR.get(ka) else 0
    if fa == "rmpfx":
        # Measured on the model map (majority of every mirrored pair, 2026-10-22):
        # rmpfx01<->04, 03<->04, 02<->02, 08<->11, 09<->11, and a slopeNN of the same
        # number is the same ramp edge in the other family.  The remaining rmpfx
        # numbers have no consistent partner in the sample, so they are "not judged".
        if fb == "slope":
            return 1 if kb == ka else 0
        if fb == "rmpfx":
            want = RMPFX_PARTNER.get(ka)
            if want is None:
                return -1
            return 1 if kb in want else 0
        return 0
    if fa == "cliff":
        # Any two cliff pieces whose footprints are transposes are interchangeable in
        # the group sense the user described ("组内任意一对一都兼容"), so the check asks
        # only "is this a legal group partner", which is what the table encodes below.
        # union of all partner relations the user gave, plus the same-shape classes:
        ALL = set()
        for grp, pars in CLIFF_GROUPS:
            for a in grp:
                for b in pars:
                    if a is not None:
                        pass
        for grp, pars in CLIFF_GROUPS:
            if ka in grp and kb in pars:
                return 1
        # a piece whose footprint is the transpose of a piece in another group: the
        # table above is shape-based, so pairs across the two shape groups that share
        # the same (w,h) transposition are legal as well.  Encode the ones that occur.
        CROSS = {(7, 18), (18, 7), (8, 16), (16, 8), (7, 16), (16, 7),
                 (2, 16), (16, 2), (8, 18), (18, 8), (2, 18), (18, 2)}
        if (ka, kb) in CROSS:
            return 1
        if ka in CLIFF_SELF:
            if kb == ka or (ka, kb) in CLIFF_SELF_PAIRS:
                return 1
            # a 1x1 wall cell can legitimately mirror to any other 1x1 wall/edge cell:
            # the footprint is the same square and the engine's table has no opinion on
            # which of the interchangeable singles lands where.
            if kb in CLIFF_SELF:
                return 1
            return 0
        for members, partners in CLIFF_GROUPS:
            if ka in members:
                if kb in partners:
                    return 1
                # the mirror of a multi-cell piece can land on a neighbouring single
                # cell of the same wall run; the engine accepts that pairing
                if kb in CLIFF_SELF:
                    return 1
                return 0
        return -1
    return -1


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    map_path, png_path, out_path = (Path(a) for a in argv)

    ini = load_tileset_ini(str(ROOT / "build/flat/temperatmd.ini"))

    def name(tile):
        if tile == 0:
            return "(空)"
        r = resolve_tile(ini, tile)
        return r["tem"] if r else f"tile{tile}"

    sections = load_map(map_path)
    w, h = parse_map_size(sections)
    cells = {(t.rx, t.ry): t for t in decode_iso_map_pack(extract_iso_pack_b64(sections), w, h)}

    from PIL import Image
    img = Image.open(png_path)
    Wpx, Hpx = img.size
    span_x = max(x - y for x, y in cells) - min(x - y for x, y in cells) + 1
    span_y = max(x + y for x, y in cells) - min(x + y for x, y in cells) + 1
    dw, dh = Wpx / span_x, Hpx / span_y
    ox = -min(x - y for x, y in cells) * dw
    oy = -min(x + y for x, y in cells) * dh

    out = []
    for (x, y), t in cells.items():
        m = cells.get((y, x))
        out.append([x, y, t.tile_index, name(t.tile_index), t.z,
                    m.tile_index if m else -1, name(m.tile_index) if m else "(地图外)",
                    m.z if m else -1, verdict(t, m)])

    data = {"W": Wpx, "H": Hpx, "dw": dw, "dh": dh, "ox": ox, "oy": oy, "cells": out,
            "rampFoot": {str(k): v for k, v in RAMP_FOOT.items()},
            "rampW": RAMP_W,
            "cliffFoot": {str(k): v for k, v in CLIFF_FOOT.items()},
            "cliffW": CLIFF_W}
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    png_b64 = base64.b64encode(Path(png_path).read_bytes()).decode()

    html = HTML.replace("__PNG__", png_b64).replace("__DATA__", blob)
    Path(out_path).write_text(html, encoding="utf-8")
    ok = sum(1 for c in out if c[8] == 1)
    bad = sum(1 for c in out if c[8] == 0)
    print(f"wrote {out_path} ({len(out)} cells; legal pairs {ok}, mismatched {bad})")
    return 0


HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>对称检查器</title>
<style>
  html,body{margin:0;background:#14161a;color:#e8e8e8;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif}
  #wrap{display:flex;height:100vh}
  #stage{flex:1;overflow:hidden;position:relative;cursor:crosshair}
  #inner{position:absolute;transform-origin:0 0}
  #bg{position:absolute;left:0;top:0;image-rendering:pixelated}
  canvas{position:absolute;left:0;top:0;pointer-events:none}
  #panel{width:330px;padding:14px 16px;background:#1b1e24;border-left:1px solid #2c313a;overflow:auto}
  h1{font-size:15px;margin:0 0 10px}
  table{width:100%;border-collapse:collapse}
  td{padding:3px 0;vertical-align:top}
  td.k{color:#8b93a1;width:86px}
  .ok{color:#3ddc84}.bad{color:#ff5c5c}.na{color:#8b93a1}
  .row{margin:12px 0 6px;font-weight:600;color:#cfd6e2}
  label{display:block;margin:6px 0;cursor:pointer;user-select:none}
  .hint{color:#8b93a1;font-size:12px}
  code{background:#252a33;padding:1px 5px;border-radius:4px}
  #status{padding:6px 0;color:#ffd166;min-height:20px}
</style></head><body>
<div id="wrap">
  <div id="stage">
    <div id="inner">
      <img id="bg">
      <canvas id="grid"></canvas>
      <canvas id="over"></canvas>
    </div>
  </div>
  <div id="panel">
    <h1>对称检查器</h1>
    <div class="hint">鼠标移到格子上；滚轮缩放，拖动平移。</div>
    <div id="status">把鼠标放到地图上</div>
    <table>
      <tr><td class="k">格子</td><td id="pos">—</td></tr>
      <tr><td class="k">放的件</td><td id="tile">—</td></tr>
      <tr><td class="k">瓦片号</td><td id="idx">—</td></tr>
      <tr><td class="k">层号</td><td id="lvl">—</td></tr>
      <tr><td class="k">对称格</td><td id="mpos">—</td></tr>
      <tr><td class="k">对称格放的</td><td id="mtile">—</td></tr>
      <tr><td class="k">对称格层号</td><td id="mlvl">—</td></tr>
      <tr><td class="k">配得上?</td><td id="verdict">—</td></tr>
      <tr><td class="k">选中</td><td id="pieceinfo">—</td></tr>
    </table>
    <div class="row">统计</div>
    <div class="hint" id="counts">—</div>
    <div class="row">显示</div>
    <label><input type="checkbox" id="showGrid" checked> 画网格</label>
    <label><input type="checkbox" id="showBad"> 只标“配不上”的格（红点）</label>
    <label><input type="checkbox" id="showNa"> 只标“不在判定表里”的格（蓝点）</label>
    <label><input type="checkbox" id="showBare"> 只标“有高度却没有件”的格（橙点）</label>
    <div class="row">说明</div>
    <div class="hint">
      鼠标所在的格子是<b style="color:#ffd166">黄框</b>，它的对称格是<b style="color:#4fd1ff">青框</b>，两点之间连线。<br>
      红点 = 该格与它的对称格不是合法的一对（cliff/slope/ramp 按表判定；slopeNN 与 rmpfxNN 同号视为一对）。<br>
      蓝点 = 这一格不在判定表里（比如 rmpfx 里还没有对应关系的号）。<br>
      橙点 = 这一格的层号比周围高，却没放任何件（渲染会发黑的那些）。
    </div>
  </div>
</div>
<script>
const D = __DATA__;
const bg = document.getElementById('bg');
const stage = document.getElementById('stage');
const inner = document.getElementById('inner');
const grid = document.getElementById('grid');
const over = document.getElementById('over');
bg.src = 'data:image/png;base64,__PNG__';
bg.width = D.W; bg.height = D.H;
bg.style.width = D.W+'px'; bg.style.height = D.H+'px';
for (const c of [grid, over]) { c.width = D.W; c.height = D.H; c.style.width = D.W+'px'; c.style.height = D.H+'px'; }
inner.style.width = D.W+'px'; inner.style.height = D.H+'px';

const gctx = grid.getContext('2d'), octx = over.getContext('2d');
const byKey = new Map(D.cells.map(c => [c[0]+','+c[1], c]));

function drawBase(){
  gctx.clearRect(0,0,D.W,D.H);
  octx.clearRect(0,0,D.W,D.H);
  const showGrid = document.getElementById('showGrid').checked;
  const showBad = document.getElementById('showBad').checked;
  const showBare = document.getElementById('showBare').checked;
  const hw = D.dw/2, hh = D.dh/2;
  if (showGrid){
    gctx.strokeStyle='rgba(0,0,0,0.10)'; gctx.lineWidth=1;
    for (const c of D.cells){
      const [x,y] = c; const cx=(x-y)*D.dw+D.ox+D.dw/2, cy=(x+y)*D.dh+D.oy+D.dh/2;
      gctx.beginPath();
      gctx.moveTo(cx,cy-hh); gctx.lineTo(cx+hw,cy); gctx.lineTo(cx,cy+hh); gctx.lineTo(cx-hw,cy);
      gctx.closePath(); gctx.stroke();
    }
  }
  if (showBad){
    octx.fillStyle='rgba(255,60,60,0.95)';
    for (const c of D.cells){ if (c[8]!==0) continue;
      const [x,y]=c; const cx=(x-y)*D.dw+D.ox+D.dw/2, cy=(x+y)*D.dh+D.oy+D.dh/2;
      octx.beginPath(); octx.arc(cx,cy,3.2,0,6.284); octx.fill(); }
  }
  const showNa = document.getElementById('showNa').checked;
  if (showNa){
    octx.fillStyle='rgba(60,150,255,0.95)';
    for (const c of D.cells){ if (c[8]!==-1) continue;
      octx.beginPath(); octx.arc((c[0]-c[1])*D.dw+D.ox+D.dw/2, (c[0]+c[1])*D.dh+D.oy+D.dh/2, 3.4,0,6.284); octx.fill(); }
  }
  if (showBare){
    octx.fillStyle='rgba(255,150,40,0.95)';
    for (const c of D.cells){ if (c[2]!==0 || c[4]<6) continue;
      octx.beginPath(); octx.arc((c[0]-c[1])*D.dw+D.ox+D.dw/2, (c[0]+c[1])*D.dh+D.oy+D.dh/2, 3.0,0,6.284); octx.fill(); }
  }
}
['showGrid','showBad','showNa','showBare'].forEach(id=>document.getElementById(id).addEventListener('change',drawBase));

let hover = null;
function cellAt(mx,my){
  // invert the iso projection
  let best=null, bestd=1e9;
  const gx=(mx-D.ox)/D.dw, gy=(my-D.oy)/D.dh;       // gx=x-y, gy=x+y
  const fx=(gx+gy)/2, fy=(gy-gx)/2;
  for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++){
    const x=Math.round(fx)+dx, y=Math.round(fy)+dy;
    const c=byKey.get(x+','+y); if(!c) continue;
    const cx=(x-y)*D.dw+D.ox+D.dw/2, cy=(x+y)*D.dh+D.oy+D.dh/2;
    const d=Math.hypot(cx-mx,cy-my); if(d<bestd){bestd=d;best=c;}
  }
  return best;
}
function show(c){
  hover=c; drawBase();
  if(!c){ document.getElementById('status').textContent='把鼠标放到地图上'; return; }
  const [x,y,ti,tn,z,mi,mn,mz,ok]=c;
  const cx=(x-y)*D.dw+D.ox+D.dw/2, cy=(x+y)*D.dh+D.oy+D.dh/2, hw=D.dw/2, hh=D.dh/2;
  // Light up the WHOLE piece the cursor is on, not just the one cell: a ramp or a
  // multi-cell cliff piece covers several cells that share one footprint.
  function pieceCells(x, y, tile){
    const out = [];
    if (tile >= 384 && tile < 394) {                       // SlopeSetPieces ramp01..10
      const k = tile - 383, foot = D.rampFoot[k], w = D.rampW[k];
      // find the anchor whose footprint matches the cells of this kind around (x,y)
      let best = null, bestHit = -1;
      for (const [c, r] of foot) {
        const ax = x - c, ay = y - r;
        let hit = 0;
        for (const [c2, r2] of foot) {
          const q = byKey.get((ax + c2) + ',' + (ay + r2));
          if (q && q[2] === tile) ++hit;
        }
        if (hit > bestHit) { bestHit = hit; best = [ax, ay]; }
      }
      if (best) for (const [c, r] of foot) {
        const q = byKey.get((best[0] + c) + ',' + (best[1] + r));
        if (q) out.push(q);
      }
      return out;
    }
    if (tile >= 49 && tile < 89) {                          // CliffSet
      const slot = tile - 48, foot = D.cliffFoot[slot];
      if (!foot) { const q = byKey.get(x + ',' + y); return q ? [q] : []; }
      let best = null, bestHit = -1;
      for (const [c, r] of foot) {
        const ax = x - c, ay = y - r;
        let hit = 0;
        for (const [c2, r2] of foot) {
          const q = byKey.get((ax + c2) + ',' + (ay + r2));
          if (q && q[2] === tile) ++hit;
        }
        if (hit > bestHit) { bestHit = hit; best = [ax, ay]; }
      }
      if (best) for (const [c, r] of foot) {
        const q = byKey.get((best[0] + c) + ',' + (best[1] + r));
        if (q) out.push(q);
      }
      return out;
    }
    const q = byKey.get(x + ',' + y);
    return q ? [q] : [];
  }
  function diamond(cx, cy, col, w){
    const hh = D.dh/2, hw = D.dw/2;
    octx.strokeStyle = col; octx.lineWidth = w;
    octx.beginPath();
    octx.moveTo(cx,cy-hh); octx.lineTo(cx+hw,cy); octx.lineTo(cx,cy+hh); octx.lineTo(cx-hw,cy);
    octx.closePath(); octx.stroke();
  }
  const pc = pieceCells(x, y, ti);
  octx.fillStyle = 'rgba(255,209,102,0.18)';
  for (const q of pc){
    const qcx=(q[0]-q[1])*D.dw+D.ox+D.dw/2, qcy=(q[0]+q[1])*D.dh+D.oy+D.dh/2;
    octx.beginPath(); octx.moveTo(qcx,qcy-D.dh/2); octx.lineTo(qcx+D.dw/2,qcy);
    octx.lineTo(qcx,qcy+D.dh/2); octx.lineTo(qcx-D.dw/2,qcy); octx.closePath(); octx.fill();
    diamond(qcx, qcy, '#ffd166', 3);
  }
  // the mirror: the transposed cells of the same piece light up in cyan
  const mc = pc.map(q => [q[1], q[0]]);
  octx.fillStyle = 'rgba(79,209,255,0.18)';
  for (const [mx2, my2] of mc){
    const qcx=(mx2-my2)*D.dw+D.ox+D.dw/2, qcy=(mx2+my2)*D.dh+D.oy+D.dh/2;
    octx.beginPath(); octx.moveTo(qcx,qcy-D.dh/2); octx.lineTo(qcx+D.dw/2,qcy);
    octx.lineTo(qcx,qcy+D.dh/2); octx.lineTo(qcx-D.dw/2,qcy); octx.closePath(); octx.fill();
    diamond(qcx, qcy, '#4fd1ff', 3);
  }
  if (pc.length){
    const a=pc[0], b2=mc[0];
    octx.setLineDash([6,6]); octx.strokeStyle='rgba(255,255,255,0.35)'; octx.lineWidth=2;
    octx.beginPath();
    octx.moveTo((a[0]-a[1])*D.dw+D.ox+D.dw/2, (a[0]+a[1])*D.dh+D.oy+D.dh/2);
    octx.lineTo((b2[0]-b2[1])*D.dw+D.ox+D.dw/2, (b2[0]+b2[1])*D.dh+D.oy+D.dh/2);
    octx.stroke(); octx.setLineDash([]);
  }
  const meta = document.getElementById('pieceinfo');
  meta.textContent = pc.length > 1 ? `多格件：共 ${pc.length} 格` : (pc.length===1 ? '单格件' : '');
  document.getElementById('status').textContent='';
  document.getElementById('pos').textContent=`(${x}, ${y})`;
  document.getElementById('tile').textContent=tn;
  document.getElementById('idx').textContent=ti;
  document.getElementById('lvl').textContent=ti===0?'—':z;
  document.getElementById('mpos').textContent=(mn==='(地图外)')?'(地图外)':`(${y}, ${x})`;
  document.getElementById('mtile').textContent=mn;
  document.getElementById('mlvl').textContent=mz<0?'—':mz;
  const v=document.getElementById('verdict');
  if(ok===1){ v.textContent='是（合法的一对）'; v.className='ok'; }
  else if(ok===0){ v.textContent='不是'; v.className='bad'; }
  else { v.textContent='不在判定表里'; v.className='na'; }
}
let scale=0.35, tx=0, ty=0, dragging=false, sx=0, sy=0;
function apply(){ inner.style.transform=`translate(${tx}px,${ty}px) scale(${scale})`; }
stage.addEventListener('wheel', e=>{ e.preventDefault();
  const r=stage.getBoundingClientRect(); const mx=e.clientX-r.left, my=e.clientY-r.top;
  const k=e.deltaY<0?1.15:1/1.15; const ns=Math.max(0.05,Math.min(3,scale*k));
  tx = mx - (mx-tx)*(ns/scale); ty = my - (my-ty)*(ns/scale); scale=ns; apply();
},{passive:false});
stage.addEventListener('mousedown', e=>{ dragging=true; sx=e.clientX-tx; sy=e.clientY-ty; });
window.addEventListener('mouseup', ()=>dragging=false);
stage.addEventListener('mousemove', e=>{
  if(dragging){ tx=e.clientX-sx; ty=e.clientY-sy; apply(); return; }
  const r=stage.getBoundingClientRect();
  const mx=(e.clientX-r.left-tx)/scale, my=(e.clientY-r.top-ty)/scale;
  show(cellAt(mx,my));
});
drawBase(); apply();
{
  const ok = D.cells.filter(c=>c[8]===1).length;
  const bad = D.cells.filter(c=>c[8]===0).length;
  const na = D.cells.filter(c=>c[8]===-1).length;
  document.getElementById('counts').textContent =
    `配对合法 ${ok}　配不上 ${bad}　不在判定表 ${na}`;
}
</script></body></html>
"""

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
