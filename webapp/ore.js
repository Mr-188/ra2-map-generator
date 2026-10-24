// Mineral painting on the rendered preview: drag a box and drop green ore or
// colored gems on every placeable cell inside it; right-click a single cell to
// put down or remove a 矿柱 (a TIBTRE [Terrain] decoration).
//
// Pure functions, no DOM, so tools/verify_ore.mjs can exercise all of it under
// node.  app.js owns the canvas, the menu and the pointer handling.
//
// ---------------------------------------------------------------------------
// WHERE EVERY NUMBER COMES FROM
//
// The project's rule is that generated/edited map logic points at its source.
// The ore grid is not re-derived here; it is the map file's own two sections:
//
//   * [OverlayPack] / [OverlayDataPack] are a fixed 512 x 512 byte grid,
//     index = X + 512 * Y, 0xFF = no overlay.  The writer fixes the size, the
//     index and the 0xFF sentinel in MapGenMapFile.cpp (lines 57-60, 776-805).
//   * Each section is 32 chunks of 8192 bytes: a 3-byte little-endian packed
//     length, the literal byte 0x20, then that many Format80 bytes
//     (MapGenMapFile.cpp 35-37, 365-460, 494-508).
//   * The lines are numbered INI lines of base64, 70 characters each
//     (MapGenMapFile.cpp AppendPackedSection, 561-581).  We re-emit the same
//     shape so the next reader (CNCMaps, FA2, the game) sees the usual file.
//
// The ore overlay ids are the generator's own bases:
//
//   * ore   = 102..113   (overlayBase 102 + 0..11, MapGenTiberium.cpp 276, 420-430)
//   * gems  =  27..38    (overlayBase 27, same place; those are NOT ore)
//   * the other tiberium families are 127..138 and 147..158, from
//     [Tiberiums] Image -> OverlayTypeClass::Array (MapGenRecalc.cpp
//     kImageToOverlayStart, 601-660).
//
// OverlayData is the growth stage.  The generator starts new ore at 0 and grows
// it to at most 11 (MapGenTiberium.cpp 426-428); a mature field measures as 11
// in the oracle map (build/oracle_assets/oracle.map: 241 of 363 ore cells are
// 11, and the shipped maps render them).  Painting a mature field therefore
// writes 11, which is also the frame the renderer already draws for a full ore
// tile.
//
// "Placeable" is the generator's own vocabulary, not a colour guess:
//
//   * the cell has to exist in the map diamond and be PassabilityType_Passable.
//     Both come from the <out>.cells sidecar that mg_generate writes from the
//     final cells (wasm_entry.cpp, after SaveMapFile; PassabilityType in
//     MapGen.h 678-688, computed by RecalcCellPassability MapGenRecalc.cpp
//     706-799).  Water, beach, cliffs, walls and rocks are all excluded there.
//   * a building foundation is out too.  The sidecar's third flag bit is
//     AltCellFlags_ContainsBuilding, which is the only way to know the cells a
//     multi-cell foundation covers: [Structures] names the anchor cell only, so
//     the text side cannot see the rest.
//   * the overlay slot must be empty.  Trees/rocks/crates keep their cell: they
//     are overlays too, and overwriting one with ore would delete the object.
//   * [Terrain] and [Structures] objects have no overlay of their own, so their
//     cells are read out of those sections and excluded as well.  Cell keys are
//     X + 1000 * Y -- the same packing [Waypoints] uses (starts.js).
//
// The variant within 102..113 is picked from the cell coordinates, so painting
// the same box twice yields the same bytes.  The generator itself rolls that
// number from its RNG; a manual edit has no RNG to continue, and a deterministic
// variant keeps the result reproducible.
// ---------------------------------------------------------------------------

import {
  cellFlags, projectCell, CELL_IN_MAP, CELL_PASSABLE, CELL_BUILDING,
} from './starts.js';

export const EMPTY_OVERLAY = 0xFF;
export const ORE_OVERLAY_START = 102;    // Riparius, the green ore floor
export const GEM_OVERLAY_START = 27;     // Cruentus, the gem ("彩矿") floor
export const ORE_VARIANTS = 12;
export const ORE_OVERLAY_END = ORE_OVERLAY_START + ORE_VARIANTS - 1;   // 113
export const GEM_OVERLAY_END = GEM_OVERLAY_START + ORE_VARIANTS - 1;   // 38
export const ORE_DATA = 11;              // mature field (see the header)
export const GEM_DATA = 11;

/** The overlay grid is 512 x 512 bytes, fixed by the writer. */
export const OVERLAY_SIDE = 512;
export const OVERLAY_BYTES = OVERLAY_SIDE * OVERLAY_SIDE;
const CHUNK = 8192;

/** The four tiberium families the engine knows (kImageToOverlayStart). */
const TIBERIUM_STARTS = [27, ORE_OVERLAY_START, 127, 147];

export function isOreOverlay(id) {
  return id >= ORE_OVERLAY_START && id <= ORE_OVERLAY_END;
}

export function isGemOverlay(id) {
  return id >= GEM_OVERLAY_START && id <= GEM_OVERLAY_END;
}

export function isTiberiumOverlay(id) {
  for (const start of TIBERIUM_STARTS) {
    if (id >= start && id < start + ORE_VARIANTS) return true;
  }
  return false;
}

/** A tiberium family is a contiguous run of 12 overlay ids starting at `start`. */
export function isMineralFamily(id, family) {
  return id >= family && id < family + ORE_VARIANTS;
}

/** The image variant for a mineral family -- deterministic, like the edit itself. */
export function mineralVariant(family, x, y) {
  return family + ((x * 7 + y * 13) % ORE_VARIANTS);
}

export function oreVariant(x, y) {
  return mineralVariant(ORE_OVERLAY_START, x, y);
}

export function gemVariant(x, y) {
  return mineralVariant(GEM_OVERLAY_START, x, y);
}

export function overlayIndex(x, y) {
  return x + OVERLAY_SIDE * y;
}

// ---------------------------------------------------------------------------
// Format80 (the OverlayPack codec)
//
// Ported from the project's verified Python implementation
// (maptools/format80.py) and XCC's encode80 (shp_decode.cpp), which is what
// MapGenMapFile.cpp ports to write these sections.  The encoder here emits the
// literal/fill subset only: legal Format80 that every reader accepts, and plenty
// for a grid that is 0xFF except where the player painted.  The test suite
// cross-checks both directions against maptools/format80.py.
// ---------------------------------------------------------------------------

export function decodeFormat80(src, outSize) {
  const dest = new Uint8Array(outSize);
  let rp = 0;
  let wp = 0;

  while (rp < src.length) {
    const code = src[rp++];
    if ((code & 0x80) === 0) {
      if (rp >= src.length) return null;
      const second = src[rp++];
      const count = ((code & 0x70) >> 4) + 3;
      const rpos = ((code & 0x0F) << 8) + second;
      const from = wp - rpos;
      if (from < 0 || wp + count > outSize) return null;
      // Byte-by-byte on purpose: LZ copies may overlap their own output
      // (the Python reference does the same; copyWithin's memmove semantics
      // would not reproduce a distance-1 repeat).
      for (let i = 0; i < count; ++i) dest[wp + i] = dest[from + i];
      wp += count;
    } else if ((code & 0x40) === 0) {
      const count = code & 0x3F;
      if (count === 0) break;                       // end of stream
      if (rp + count > src.length || wp + count > outSize) return null;
      dest.set(src.subarray(rp, rp + count), wp);
      rp += count;
      wp += count;
    } else {
      const sub = code & 0x3F;
      if (sub === 0x3E) {                           // fill
        if (rp + 3 > src.length) return null;
        const count = src[rp] | (src[rp + 1] << 8);
        const colour = src[rp + 2];
        rp += 3;
        if (wp + count > outSize) return null;
        dest.fill(colour, wp, wp + count);
        wp += count;
      } else if (sub === 0x3F) {                    // long back-reference
        if (rp + 4 > src.length) return null;
        const count = src[rp] | (src[rp + 1] << 8);
        const from = src[rp + 2] | (src[rp + 3] << 8);
        rp += 4;
        if (from + count > outSize || wp + count > outSize) return null;
        for (let i = 0; i < count; ++i) dest[wp + i] = dest[from + i];
        wp += count;
      } else {                                      // short back-reference
        if (rp + 2 > src.length) return null;
        const count = sub + 3;
        const from = src[rp] | (src[rp + 1] << 8);
        rp += 2;
        if (from + count > outSize || wp + count > outSize) return null;
        for (let i = 0; i < count; ++i) dest[wp + i] = dest[from + i];
        wp += count;
      }
    }
  }
  return dest;
}

function runLength(src, offset, limit) {
  const max = Math.min(src.length - offset, limit);
  if (max <= 0) return 0;
  const value = src[offset];
  let count = 1;
  while (count < max && src[offset + count] === value) count++;
  return count;
}

function writeLiterals(out, src, start, length) {
  let pos = start;
  let left = length;
  while (left > 0) {
    const now = Math.min(left, 0x3F);
    out.push(0x80 | now);
    for (let i = 0; i < now; ++i) out.push(src[pos + i]);
    left -= now;
    pos += now;
  }
}

export function encodeFormat80(src) {
  const out = [];
  let offset = 0;
  let blockStart = 0;
  while (offset < src.length) {
    const repeat = runLength(src, offset, 0xFFFF);
    if (repeat >= 4) {
      writeLiterals(out, src, blockStart, offset - blockStart);
      out.push(0xFE, repeat & 0xFF, (repeat >> 8) & 0xFF, src[offset]);
      offset += repeat;
      blockStart = offset;
    } else {
      offset += 1;
    }
  }
  writeLiterals(out, src, blockStart, offset - blockStart);
  out.push(0x80);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// base64 and the INI section that carries a packed blob
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(256).fill(-1);
for (let i = 0; i < B64.length; ++i) B64_INDEX[B64.charCodeAt(i)] = i;

export function base64Encode(bytes) {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(v >> 18) & 0x3F] + B64[(v >> 12) & 0x3F]
         + B64[(v >> 6) & 0x3F] + B64[v & 0x3F];
  }
  if (bytes.length - i === 1) {
    const v = bytes[i] << 16;
    out += B64[(v >> 18) & 0x3F] + B64[(v >> 12) & 0x3F] + '==';
  } else if (bytes.length - i === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(v >> 18) & 0x3F] + B64[(v >> 12) & 0x3F]
         + B64[(v >> 6) & 0x3F] + '=';
  }
  return out;
}

export function base64Decode(text) {
  const clean = text.replace(/[\s=]/g, '');
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; ++i) {
    const v = B64_INDEX[clean.charCodeAt(i)];
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xFF;
    }
  }
  return out.slice(0, o);
}

/** Line bounds of one INI section, with the file's own line ending. */
function findSection(text, name) {
  const wanted = name.toLowerCase();
  let lineStart = 0;
  let found = null;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    const atEof = lineEnd < 0;
    if (atEof) lineEnd = text.length;
    const raw = text.slice(lineStart, lineEnd);
    const m = /^\s*\[([^\]]+)\]/.exec(raw);
    if (m) {
      if (found) { found.bodyEnd = lineStart; break; }
      if (m[1].trim().toLowerCase() === wanted) {
        found = {
          bodyStart: lineEnd + 1,
          bodyEnd: text.length,
          eol: raw.endsWith('\r') ? '\r\n' : '\n',
          next: lineEnd + 1 < text.length,
        };
      }
    }
    if (atEof) break;
    lineStart = lineEnd + 1;
  }
  return found;
}

export function sectionBody(text, name) {
  const found = findSection(text, name);
  if (!found) return null;
  return { ...found, body: text.slice(found.bodyStart, found.bodyEnd) };
}

function sectionValues(body) {
  const values = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    values.push(trimmed.slice(eq + 1).trim());
  }
  return values;
}

function formatPackedLines(bytes, eol) {
  const b64 = base64Encode(bytes);
  const lines = [];
  let number = 1;
  for (let i = 0; i < b64.length; i += 70) {
    lines.push(`${number++}=${b64.slice(i, i + 70)}`);
  }
  return lines.join(eol);
}

/** 32 chunks of `[u24 length][0x20][format80 payload]`. */
function packChunks(bytes) {
  let total = 0;
  const encoded = [];
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const raw = encodeFormat80(bytes.subarray(off, off + CHUNK));
    encoded.push({ raw, size: Math.min(CHUNK, bytes.length - off) });
    total += 4 + raw.length;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const { raw } of encoded) {
    const len = raw.length;
    out[pos++] = len & 0xFF;
    out[pos++] = (len >>> 8) & 0xFF;
    out[pos++] = (len >>> 16) & 0xFF;
    out[pos++] = 0x20;
    out.set(raw, pos);
    pos += len;
  }
  return out;
}

function unpackChunks(bytes, outSize) {
  const out = new Uint8Array(outSize);
  let pos = 0;
  let wrote = 0;
  while (wrote < outSize) {
    if (pos + 4 > bytes.length) return null;
    const len = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16);
    if (bytes[pos + 3] !== 0x20 || len === 0 || pos + 4 + len > bytes.length) return null;
    pos += 4;
    const decoded = decodeFormat80(bytes.subarray(pos, pos + len), CHUNK);
    if (!decoded) return null;
    const take = Math.min(CHUNK, outSize - wrote);
    out.set(decoded.subarray(0, take), wrote);
    pos += len;
    wrote += take;
  }
  return out;
}

/** One packed section (the full 262144-byte overlay grid), or null. */
export function decodeOverlaySection(text, name) {
  const sec = sectionBody(text, name);
  if (!sec) return null;
  const values = sectionValues(sec.body);
  if (!values.length) return null;
  const bytes = base64Decode(values.join(''));
  if (!bytes) return null;
  return unpackChunks(bytes, OVERLAY_BYTES);
}

/** Rewrites one section from a full 262144-byte grid.  Only that section moves. */
export function rewriteOverlaySection(text, name, bytes) {
  const sec = sectionBody(text, name);
  if (!sec) return null;
  const packed = packChunks(bytes);
  const body = formatPackedLines(packed, sec.eol)
    + sec.eol + (sec.next ? sec.eol : '');
  return text.slice(0, sec.bodyStart) + body + text.slice(sec.bodyEnd);
}

/** The map's two overlay grids as { ids, data }, or null. */
export function readOverlayGrids(text) {
  const ids = decodeOverlaySection(text, 'OverlayPack');
  const data = decodeOverlaySection(text, 'OverlayDataPack');
  if (!ids || !data) return null;
  return { ids, data };
}

/** Writes both grids back.  Returns the new text, or null if a section is gone. */
export function writeOverlayGrids(text, ids, data) {
  let out = rewriteOverlaySection(text, 'OverlayDataPack', data);
  if (out === null) return null;
  out = rewriteOverlaySection(out, 'OverlayPack', ids);
  return out;
}

// ---------------------------------------------------------------------------
// Cells that already carry an object (no overlay slot to paint into)
// ---------------------------------------------------------------------------

function packedToOverlayIndex(packed) {
  const x = packed % 1000;
  const y = Math.floor(packed / 1000);
  if (x < 0 || y < 0 || x >= OVERLAY_SIDE || y >= OVERLAY_SIDE) return -1;
  return overlayIndex(x, y);
}

/**
 * The overlay indices occupied by [Terrain] and [Structures] objects.
 *
 * [Terrain] keys are packed cells (X + 1000 * Y); [Structures] rows put X and Y
 * in fields 4 and 5 of `Owner,Type,Health,X,Y,...`.  The layouts are the ones
 * the Python format layer writes and reads (maptools/map_ini.py
 * patch_terrain / patch_structures), which is the project's own map-format
 * oracle.
 */
export function readOccupiedCells(text) {
  const occupied = new Set();

  const terrain = sectionBody(text, 'Terrain');
  if (terrain) {
    for (const line of terrain.body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const packed = Number(trimmed.slice(0, eq).trim());
      if (!Number.isInteger(packed) || packed < 0) continue;
      const index = packedToOverlayIndex(packed);
      if (index >= 0) occupied.add(index);
    }
  }

  const structures = sectionBody(text, 'Structures');
  if (structures) {
    for (const line of structures.body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const fields = trimmed.slice(eq + 1).split(',');
      if (fields.length < 5) continue;
      const x = Number(fields[3].trim());
      const y = Number(fields[4].trim());
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      if (x < 0 || y < 0 || x >= OVERLAY_SIDE || y >= OVERLAY_SIDE) continue;
      occupied.add(overlayIndex(x, y));
    }
  }

  return occupied;
}

// ---------------------------------------------------------------------------
// Selection and painting
// ---------------------------------------------------------------------------

/**
 * The cells whose drawn centre falls inside `rect`, in the image's natural
 * pixels.  `rect` is { x0, y0, x1, y1 } in any corner order.
 *
 * The projection is starts.js's projectCell, the inverse of the transform the
 * renderer publishes -- the same one the start-point editor uses, so a box drawn
 * on the image means the same cells to both tools.
 */
export function cellsInRect(grid, meta, rect) {
  if (!grid || !meta) return [];
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1);
  const y1 = Math.max(rect.y0, rect.y1);
  const out = [];
  for (let y = 0; y < grid.height; ++y) {
    for (let x = 0; x < grid.width; ++x) {
      if (!(cellFlags(grid, x, y) & CELL_IN_MAP)) continue;
      const p = projectCell(grid, meta, x, y);
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      out.push({ x, y });
    }
  }
  return out;
}

export const CELL_EMPTY = 'empty';
export const CELL_ORE = 'ore';        // the target mineral family is already here
export const CELL_OTHER = 'other';    // a different tiberium family
export const CELL_BLOCKED = 'blocked';

/**
 * What a cell offers to a mineral brush of `family` (102 = green ore, 27 = gems):
 *   blocked -- not in the map / not passable / building foundation / other
 *              overlay or [Terrain] object
 *   other   -- a DIFFERENT tiberium family (not overwritten by this brush)
 *   ore     -- the target family is already here (a no-op for painting)
 *   empty   -- free ground; the brush writes the target family there
 */
export function classifyCell(grid, ids, occupied, x, y, family = ORE_OVERLAY_START) {
  const flags = cellFlags(grid, x, y);
  if (!(flags & CELL_IN_MAP) || !(flags & CELL_PASSABLE)) return CELL_BLOCKED;
  if (flags & CELL_BUILDING) return CELL_BLOCKED;
  const index = overlayIndex(x, y);
  const id = ids[index];
  if (isMineralFamily(id, family)) return CELL_ORE;
  if (isTiberiumOverlay(id)) return CELL_OTHER;
  if (id !== EMPTY_OVERLAY) return CELL_BLOCKED;      // trees, props...
  if (occupied && occupied.has(index)) return CELL_BLOCKED;
  return CELL_EMPTY;
}

/** Counts a selection for one mineral family (the menu's labels). */
export function countSelection(grid, ids, occupied, cells, family = ORE_OVERLAY_START) {
  const counts = { empty: 0, ore: 0, other: 0, blocked: 0, total: cells.length };
  for (const c of cells) {
    const kind = classifyCell(grid, ids, occupied, c.x, c.y, family);
    if (kind === CELL_EMPTY) counts.empty++;
    else if (kind === CELL_ORE) counts.ore++;
    else if (kind === CELL_OTHER) counts.other++;
    else counts.blocked++;
  }
  return counts;
}

/**
 * Writes one mineral family into every empty cell of the selection.  Existing
 * minerals of the SAME family are left alone; a different family is not touched
 * either (the brush is additive -- 清除矿 is the way to change a field's type).
 */
export function paintMineralCells({
  grid, cells, ids, data, occupied,
  family = ORE_OVERLAY_START, stage = ORE_DATA,
}) {
  const result = { painted: 0, existing: 0, other: 0, blocked: 0 };
  for (const c of cells) {
    const kind = classifyCell(grid, ids, occupied, c.x, c.y, family);
    if (kind === CELL_BLOCKED) { result.blocked++; continue; }
    if (kind === CELL_ORE) { result.existing++; continue; }
    if (kind === CELL_OTHER) { result.other++; continue; }
    const index = overlayIndex(c.x, c.y);
    ids[index] = mineralVariant(family, c.x, c.y);
    data[index] = stage;
    result.painted++;
  }
  return result;
}

/** Green ore, the original brush (kept as a name the page already imports). */
export function paintOreCells({ grid, cells, ids, data, occupied }) {
  return paintMineralCells({
    grid, cells, ids, data, occupied,
    family: ORE_OVERLAY_START, stage: ORE_DATA,
  });
}

/** The gem ("彩矿") brush. */
export function paintGemCells({ grid, cells, ids, data, occupied }) {
  return paintMineralCells({
    grid, cells, ids, data, occupied,
    family: GEM_OVERLAY_START, stage: GEM_DATA,
  });
}

/** Removes any tiberium (ore or gems) from the selected cells. */
export function clearMineralCells({ cells, ids, data }) {
  const result = { cleared: 0, kept: 0, packed: new Set() };
  for (const c of cells) {
    const index = overlayIndex(c.x, c.y);
    if (!isTiberiumOverlay(ids[index])) { result.kept++; continue; }
    ids[index] = EMPTY_OVERLAY;
    data[index] = 0;
    result.packed.add(1000 * c.y + c.x);
    result.cleared++;
  }
  return result;
}

/** Backwards-compatible name (the first version of the brush only knew ore). */
export function clearOreCells({ cells, ids, data }) {
  return clearMineralCells({ cells, ids, data });
}

/**
 * Drops the ore decoration trees ([Terrain] TIBTRE01..03) that sit on the cells
 * we just cleared.
 *
 * The generator puts those trees on ore cells (MapGenTiberium.cpp's decoration
 * branch) and prunes them with the ore; a manual 清除 that only rewrote the
 * overlay would leave them standing on bare ground.  Only TIBTRE entries on the
 * cleared cells are removed -- every other [Terrain] object (and every other
 * section) is left byte-identical.
 *
 * `packed` is the set of 1000 * Y + X keys, the same packing [Terrain] uses.
 */
export function removeOreDecorations(text, packed) {
  if (!packed || packed.size === 0) return text;
  const sec = sectionBody(text, 'Terrain');
  if (!sec) return text;
  const kept = [];
  let changed = false;
  for (const line of sec.body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) {
      kept.push(line);
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq < 0) { kept.push(line); continue; }
    const key = Number(trimmed.slice(0, eq).trim());
    const value = trimmed.slice(eq + 1).trim();
    if (Number.isInteger(key) && packed.has(key) && /^TIBTRE/i.test(value)) {
      changed = true;
      continue;
    }
    kept.push(line);
  }
  if (!changed) return text;
  const body = kept.join(sec.eol).replace(/\s+$/, '')
    + sec.eol + (sec.next ? sec.eol : '');
  return text.slice(0, sec.bodyStart) + body + text.slice(sec.bodyEnd);
}

// ---------------------------------------------------------------------------
// 矿柱 (the TIBTRE decoration)
//
// A pillar is not an overlay: it is a [Terrain] object, which is why it can sit
// on an ore tile (the generator's "矿树") or on bare ground ("裸矿柱").  The
// generator writes the three names TIBTRE01..03 (MapGenTiberium.cpp 397-409 and
// PlaceArchipelagoOrePillars 484-510); the map's [Terrain] section carries one
// `X + 1000*Y=NAME` line per object.
//
// Placing one by hand is allowed on any passable, non-building cell.  Whatever
// else is on that cell is removed first, as the user asked: an existing
// [Terrain] object is replaced, and a non-mineral overlay is cleared.  Ore/gems
// are kept -- a pillar on a mineral tile is exactly the decoration the generator
// produces.  Water, cliffs and building foundations are refused.
// ---------------------------------------------------------------------------

export const PILLAR_NAMES = ['TIBTRE01', 'TIBTRE02', 'TIBTRE03'];

export function isPillarName(name) {
  return PILLAR_NAMES.includes(name);
}

/** The pillar image for a cell -- deterministic, like the mineral variant. */
export function pillarName(x, y) {
  return PILLAR_NAMES[((x * 5 + y * 11) >>> 0) % PILLAR_NAMES.length];
}

/** The [Terrain] object name at a packed cell, or null. */
export function findTerrainObject(text, packed) {
  const sec = sectionBody(text, 'Terrain');
  if (!sec) return null;
  for (const line of sec.body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (Number(trimmed.slice(0, eq).trim()) !== packed) continue;
    return trimmed.slice(eq + 1).trim();
  }
  return null;
}

/** Writes `packed=name` into [Terrain], replacing that cell's object if present. */
export function setTerrainObject(text, packed, name) {
  const sec = sectionBody(text, 'Terrain');
  if (!sec) return null;
  const lines = sec.body.split(/\r?\n/);
  let replaced = false;
  let lastData = -1;
  for (let i = 0; i < lines.length; ++i) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    lastData = i;
    if (Number(trimmed.slice(0, eq).trim()) !== packed) continue;
    lines[i] = `${packed}=${name}`;
    replaced = true;
  }
  if (!replaced) {
    if (lastData >= 0) lines.splice(lastData + 1, 0, `${packed}=${name}`);
    else lines.unshift(`${packed}=${name}`);
  }
  const body = lines.join(sec.eol).replace(/\s+$/, '')
    + sec.eol + (sec.next ? sec.eol : '');
  return text.slice(0, sec.bodyStart) + body + text.slice(sec.bodyEnd);
}

/** Removes the [Terrain] object at a packed cell. Returns { text, removed }. */
export function removeTerrainObject(text, packed) {
  const sec = sectionBody(text, 'Terrain');
  if (!sec) return { text, removed: null };
  const kept = [];
  let removed = null;
  for (const line of sec.body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) {
      kept.push(line);
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq < 0) { kept.push(line); continue; }
    if (Number(trimmed.slice(0, eq).trim()) === packed) {
      removed = trimmed.slice(eq + 1).trim();
      continue;
    }
    kept.push(line);
  }
  if (removed === null) return { text, removed: null };
  const body = kept.join(sec.eol).replace(/\s+$/, '')
    + sec.eol + (sec.next ? sec.eol : '');
  return { text: text.slice(0, sec.bodyStart) + body + text.slice(sec.bodyEnd), removed };
}

/**
 * Whether a pillar may be placed on a cell, and what is already there.
 * Returns { ok, reason, existing, isPillar }.
 */
export function describePillarTarget({ grid, text, x, y }) {
  const flags = cellFlags(grid, x, y);
  const existing = findTerrainObject(text, 1000 * y + x);
  const isPillar = !!existing && isPillarName(existing);
  if (!(flags & CELL_IN_MAP)) {
    return { ok: false, reason: `(${x}, ${y}) 不在地图里。`, existing, isPillar };
  }
  if (!(flags & CELL_PASSABLE)) {
    return { ok: false, reason: `(${x}, ${y}) 不是可通行地面（水面/崖/墙/石头）。`, existing, isPillar };
  }
  if (flags & CELL_BUILDING) {
    return { ok: false, reason: `(${x}, ${y}) 是建筑地基，不能放。`, existing, isPillar };
  }
  if (!sectionBody(text, 'Terrain')) {
    return { ok: false, reason: '这张地图没有 [Terrain] 段。', existing, isPillar };
  }
  return { ok: true, reason: '', existing, isPillar };
}

/**
 * Places a pillar.  Replaces any existing [Terrain] object on the cell and
 * clears a non-mineral overlay; ore/gems stay.  An existing pillar is a no-op.
 */
export function placePillar({ grid, text, ids, data, x, y }) {
  const target = describePillarTarget({ grid, text, x, y });
  if (!target.ok) return { ok: false, reason: target.reason };
  if (target.isPillar) {
    return { ok: true, changed: false, already: true, name: target.existing,
             removedObject: null, removedOverlay: null, text };
  }

  const index = overlayIndex(x, y);
  let removedOverlay = null;
  if (ids[index] !== EMPTY_OVERLAY && !isTiberiumOverlay(ids[index])) {
    removedOverlay = ids[index];
    ids[index] = EMPTY_OVERLAY;
    data[index] = 0;
  }

  const name = pillarName(x, y);
  const next = setTerrainObject(text, 1000 * y + x, name);
  if (next === null) return { ok: false, reason: '这张地图没有 [Terrain] 段。' };
  return {
    ok: true, changed: true, name, text: next,
    removedObject: target.existing, removedOverlay,
  };
}

/** Removes a pillar (only TIBTRE; other [Terrain] objects are left alone). */
export function removePillar({ text, x, y }) {
  const packed = 1000 * y + x;
  if (!isPillarName(findTerrainObject(text, packed))) {
    return { ok: true, changed: false, reason: `(${x}, ${y}) 没有矿柱。`, text };
  }
  const { text: next, removed } = removeTerrainObject(text, packed);
  return { ok: true, changed: true, removed, text: next };
}
