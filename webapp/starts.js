// Start-point editing on the rendered preview: click a pixel -> the map cell it
// belongs to -> rewrite that start in the map's [Waypoints] block.
//
// Pure functions, no DOM, so tools/verify_starts.mjs can exercise all of it under
// node.  app.js owns the canvas and the pointer handling.
//
// ---------------------------------------------------------------------------
// WHERE THE PROJECTION COMES FROM
//
// Not reimplemented here.  The renderer resolves the cell -> pixel transform for
// itself and writes it next to the image (`--meta-json`, switched on in
// engine/render/WebEntry.cs).  Its own comment states the rule:
//
//   Dx = Rx - Ry + fullSize.width - 1     Dy = Rx + Ry - fullSize.width - 1
//   x  = (Dx + 1) * tileWidth  / 2 - saveRect.x
//   y  = (Dy - z + 1) * tileHeight / 2 - saveRect.y
//
// (The transform comment in RenderEngine.cs writes those last two without the
// +1; Map.cs GetStartPositionPixels has it, and the published metadata agrees
// with Map.cs -- see the check in tools/verify_starts.mjs.)
//
// This module only inverts that.  The height `z` is what the inversion needs and
// what a pixel alone cannot give -- one pixel column is a whole stack of cells --
// so the generator exports a per-cell level grid with the map (mg_generate,
// "<out>.cells").  Both halves are the engine's own numbers; nothing here guesses.
// ---------------------------------------------------------------------------

/** The generator's sidecar: u32 width, u32 height, then [level][flags] per cell. */
export function parseCellGrid(bytes) {
  if (!bytes || bytes.byteLength < 8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(0, true);
  const height = dv.getUint32(4, true);
  if (!width || !height) return null;
  if (bytes.byteLength < 8 + width * height * 2) return null;
  const level = new Uint8Array(width * height);
  const flags = new Uint8Array(width * height);
  for (let i = 0, o = 8; i < level.length; ++i, o += 2) {
    level[i] = bytes[o];
    flags[i] = bytes[o + 1];
  }
  return { width, height, level, flags };
}

/** flags bits, as written by mg_generate. */
export const CELL_IN_MAP = 1;
export const CELL_PASSABLE = 2;

export function cellFlags(grid, x, y) {
  if (!grid || x < 0 || y < 0 || x >= grid.width || y >= grid.height) return 0;
  return grid.flags[y * grid.width + x];
}

export function cellLevel(grid, x, y) {
  if (!grid || x < 0 || y < 0 || x >= grid.width || y >= grid.height) return 0;
  return grid.level[y * grid.width + x];
}

/**
 * The same round trip `projectCell` makes, in reverse.
 *
 * A pixel fixes Dx exactly but only fixes `Dy - z`, so every cell on that
 * diagonal is a candidate; the pixel is inside exactly one of their diamonds
 * (they do not overlap) unless height stacking hides it, in which case the
 * front-most -- highest z -- wins, which is what the renderer drew there.
 */
export function pickCell(grid, meta, px, py) {
  if (!grid || !meta || !meta.fullSize || !meta.saveRect) return null;
  const tw = meta.tileWidth;
  const th = meta.tileHeight;
  if (!tw || !th) return null;
  const fullW = meta.fullSize.width;
  const dx = Math.round((px + meta.saveRect.x) * 2 / tw) - 1;
  const cx = (dx + 1) * tw / 2 - meta.saveRect.x;
  const halfW = tw / 2;
  const offX = Math.abs(px - cx);
  if (offX > halfW) return null;
  const halfH = (th / 2) * (1 - offX / halfW);
  const d = dx - fullW + 1;                    // x - y for every candidate
  const xLo = Math.max(0, d);
  const xHi = Math.min(grid.width - 1, grid.height - 1 + d);
  let best = null;
  for (let x = xLo; x <= xHi; ++x) {
    const y = x - d;
    const z = grid.level[y * grid.width + x];
    const cy = (x + y - fullW - 1 - z + 1) * th / 2 - meta.saveRect.y;
    if (Math.abs(py - cy) > halfH + 1e-6) continue;
    if (best === null || z > best.z) best = { x, y, z };
  }
  return best;
}

/** Where the centre of cell (x, y) lands in the saved image, in natural pixels. */
export function projectCell(grid, meta, x, y) {
  const z = cellLevel(grid, x, y);
  const tw = meta.tileWidth;
  const th = meta.tileHeight;
  const fullW = meta.fullSize.width;
  const dx = x - y + fullW - 1;
  const dy = x + y - fullW - 1;
  // +1 on both: the renderer's own centre is (Dx + 1) * tw/2, (Dy - z + 1) * th/2
  // (Map.cs GetStartPositionPixels).  The transform comment in RenderEngine.cs
  // omits that +1; the code is the authority, and the metadata below agrees with
  // the code.
  return {
    x: (dx + 1) * tw / 2 - meta.saveRect.x,
    y: (dy - z + 1) * th / 2 - meta.saveRect.y,
  };
}

/**
 * Replaces one entry of the map's [Waypoints] block.
 *
 * The writer packs a cell as `X + 1000 * Y` (MapGenMapFile.cpp), which is also
 * what the renderer and FA2 decode, so the edit is that one number.  Only
 * [Waypoints] is touched: the file also carries [Terrain] and [Structures]
 * blocks whose keys are packed cells, and a blind search/replace would move a
 * tree or a building instead of a start.
 *
 * Returns the new text, or null when there is no such waypoint.
 */
export function rewriteWaypoint(text, number, x, y) {
  const packed = x + 1000 * y;
  const lines = text.split('\n');
  let section = '';
  for (let i = 0; i < lines.length; ++i) {
    const raw = lines[i];
    const cr = raw.endsWith('\r') ? '\r' : '';
    const body = cr ? raw.slice(0, -1) : raw;
    const trimmed = body.trim();
    if (trimmed.startsWith('[')) { section = trimmed.toLowerCase(); continue; }
    if (section !== '[waypoints]') continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() !== String(number)) continue;
    const lead = body.match(/^\s*/)[0];
    lines[i] = `${lead}${number}=${packed}${cr}`;
    return lines.join('\n');
  }
  return null;
}

/** The [Waypoints] entries as { number, x, y }. */
export function readWaypoints(text) {
  const out = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) { section = trimmed.toLowerCase(); continue; }
    if (section !== '[waypoints]') continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const number = Number(trimmed.slice(0, eq).trim());
    const packed = Number(trimmed.slice(eq + 1).trim());
    if (!Number.isInteger(number) || !Number.isInteger(packed)) continue;
    out.push({ number, x: packed % 1000, y: Math.floor(packed / 1000) });
  }
  return out.sort((a, b) => a.number - b.number);
}
