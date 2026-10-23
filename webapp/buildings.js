// Neutral tech buildings on the rendered preview: pick a cell, right-click one
// of the three, and the map gets a real [Structures] entry.
//
// Pure functions, no DOM, so tools/verify_buildings.mjs can exercise all of it
// under node.  app.js owns the canvas, the menu and the pointer handling.
//
// ---------------------------------------------------------------------------
// WHERE THE DATA COMES FROM
//
// * The three types are the neutral tech buildings from the rules INI's
//   [AI] NeutralTechBuildings list (rulesmd.ini), with the Chinese names decoded
//   from langmd.mix's ra2md.csf (CSF UTF-16 code units XOR 0xFFFF):
//       CAOILD  Tech Oil Derrick   科技钻油井     油井
//       CAMACH  Tech Machine Shop  科技机器商店   科技商店（车辆自我修复）
//       CAOUTP  Tech Outpost       科技前哨站     科技维修厂（维修坞 + 炮塔）
//   Their foundations are the art INI's [CAOILD]/[CAMACH]/[CAOUTP] Foundation=
//   values: 2x2, 3x3, 4x3.  Measured against a generated map's sidecar, the
//   [Structures] X,Y anchor covers exactly x..x+w-1, y..y+h-1.
//
// * A structure line is the writer's own shape
//   (MapGenMapFile.cpp's AppendStructure / the maps it writes):
//       INDEX=OWNER,TYPE,HEALTH,X,Y,FACING,None,0,0,1,0,0,None,None,None,1,0
//   The owner is the map's neutral house: "Neutral" on a multiplayer map,
//   "Neutral House" on a single-player one (the generator writes both layouts;
//   the section tells us which one this map is).
//
// * Placeability uses the generator's sidecar again: every foundation cell must
//   be in the map diamond, PassabilityType_Passable (no water/cliff/wall/rock),
//   not a building foundation (AltCellFlags_ContainsBuilding), and at the same
//   Level as the anchor (a building cannot sit on a slope; the generator levels
//   tech-building ground for the same reason).
//
// * Anything else on the foundation is removed, as the user asked for the
//   pillar: overlays (ore/gems included) are cleared and [Terrain] objects
//   (trees, pillars) are deleted, so the footprint is clean.  Existing
//   buildings are refused rather than removed -- a foundation is not something
//   this brush should guess at.
// ---------------------------------------------------------------------------

import {
  cellFlags, cellLevel, CELL_IN_MAP, CELL_PASSABLE, CELL_BUILDING,
} from './starts.js';
import { overlayIndex, EMPTY_OVERLAY, sectionBody, removeTerrainObject } from './ore.js';

export const BUILDING_TYPES = [
  {
    id: 'CAOILD', short: '油井', full: '科技钻油井', en: 'Tech Oil Derrick',
    width: 2, height: 2,
    role: '占领后定期给钱；被打爆会爆炸',
  },
  {
    id: 'CAMACH', short: '科技商店', full: '科技机器商店', en: 'Tech Machine Shop',
    width: 3, height: 3,
    role: '车辆自我修复（常说的科技商店 / 维修厂）',
  },
  {
    id: 'CAOUTP', short: '科技维修厂', full: '科技前哨站', en: 'Tech Outpost',
    width: 4, height: 3,
    role: '带圆形维修坞和炮塔',
  },
];

export function buildingType(id) {
  return BUILDING_TYPES.find((t) => t.id === id) || null;
}

/** The foundation cells of a building anchored at (x, y). */
export function footprintCells(type, x, y) {
  const out = [];
  for (let j = 0; j < type.height; ++j) {
    for (let i = 0; i < type.width; ++i) out.push({ x: x + i, y: y + j });
  }
  return out;
}

/** "Neutral" (multiplayer maps) or "Neutral House" (single-player maps). */
export function neutralOwnerName(text) {
  if (sectionBody(text, 'Neutral House')) return 'Neutral House';
  const houses = sectionBody(text, 'Houses');
  if (houses) {
    for (const line of houses.body.split(/\r?\n/)) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf('=');
      if (eq < 0 || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
      if (trimmed.slice(eq + 1).trim().toLowerCase() === 'neutral house') {
        return 'Neutral House';
      }
    }
  }
  return 'Neutral';
}

/** The [Structures] entries as { index, owner, type, health, x, y }. */
export function readStructures(text) {
  const out = [];
  const sec = sectionBody(text, 'Structures');
  if (!sec) return out;
  for (const line of sec.body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const index = Number(trimmed.slice(0, eq).trim());
    const fields = trimmed.slice(eq + 1).split(',');
    if (!Number.isInteger(index) || fields.length < 5) continue;
    const x = Number(fields[3].trim());
    const y = Number(fields[4].trim());
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    out.push({
      index, owner: fields[0].trim(), type: fields[1].trim(),
      health: Number(fields[2].trim()), x, y,
      fields: fields.map((f) => f.trim()),
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * What placing `type` with its anchor at (x, y) would mean.
 * Returns { ok, reason, cells, level }.
 */
export function describeBuildingPlacement({ grid, type, x, y, occupied }) {
  if (!grid || !type) return { ok: false, reason: '没有地图或建筑类型。', cells: [] };
  const cells = footprintCells(type, x, y);
  const level = cellLevel(grid, x, y);
  for (const c of cells) {
    const flags = cellFlags(grid, c.x, c.y);
    if (!(flags & CELL_IN_MAP)) {
      return { ok: false, reason: `(${c.x}, ${c.y}) 出了地图。`, cells, level };
    }
    if (!(flags & CELL_PASSABLE)) {
      return { ok: false, reason: `(${c.x}, ${c.y}) 不是可通行地面（水面/崖/墙/石头）。`, cells, level };
    }
    if (flags & CELL_BUILDING) {
      return { ok: false, reason: `(${c.x}, ${c.y}) 已经有建筑。`, cells, level };
    }
    // A building this page placed has no entry in the generator's sidecar, so
    // its foundation comes from the map's own [Structures] lines (see
    // structureOccupiedCells); the two sources are merged by the caller.
    if (occupied && occupied.has(overlayIndex(c.x, c.y))) {
      return { ok: false, reason: `(${c.x}, ${c.y}) 已经有建筑。`, cells, level };
    }
    const lv = cellLevel(grid, c.x, c.y);
    if (lv !== level) {
      return { ok: false, reason: `地基不平：(${c.x}, ${c.y}) 高 ${lv}，锚点高 ${level}。`, cells, level };
    }
  }
  return { ok: true, reason: '', cells, level };
}

/** Appends/replaces the structure line in [Structures]. */
function addStructure(text, owner, type, x, y) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `${owner},${type.id},256,${x},${y},0,None,0,0,1,0,0,None,None,None,1,0`;
  const sec = sectionBody(text, 'Structures');
  if (!sec) {
    const body = text.replace(/\s+$/, '');
    return (body ? body + eol : '') + '[Structures]' + eol + `0=${line}` + eol;
  }
  const lines = sec.body.split(/\r?\n/);
  let nextIndex = 0;
  let lastData = -1;
  for (let i = 0; i < lines.length; ++i) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    lastData = i;
    const index = Number(trimmed.slice(0, eq).trim());
    if (Number.isInteger(index) && index >= nextIndex) nextIndex = index + 1;
  }
  const entry = `${nextIndex}=${line}`;
  if (lastData >= 0) lines.splice(lastData + 1, 0, entry);
  else lines.splice(0, 0, entry);
  const body = lines.join(sec.eol).replace(/\s+$/, '')
    + sec.eol + (sec.next ? sec.eol : '');
  return text.slice(0, sec.bodyStart) + body + text.slice(sec.bodyEnd);
}

/**
 * Places a building: validates the foundation, clears overlays and [Terrain]
 * objects under it, and appends the [Structures] entry.
 *
 * `ids`/`data` are the map's overlay grids (mutated in place).  Returns
 * { ok, reason?, text, owner, cells, clearedOverlays, removedObjects }.
 */
export function placeBuilding({ grid, text, ids, data, type, x, y, occupied }) {
  const check = describeBuildingPlacement({ grid, type, x, y, occupied });
  if (!check.ok) return { ok: false, reason: check.reason };

  let nextText = text;
  let clearedOverlays = 0;
  const removedObjects = [];
  for (const c of check.cells) {
    const index = overlayIndex(c.x, c.y);
    if (ids[index] !== EMPTY_OVERLAY) {
      ids[index] = EMPTY_OVERLAY;
      data[index] = 0;
      clearedOverlays++;
    }
    const packed = 1000 * c.y + c.x;
    const removed = removeTerrainObject(nextText, packed);
    if (removed.removed !== null) removedObjects.push(removed.removed);
    nextText = removed.text;
  }

  const owner = neutralOwnerName(nextText);
  const withStructure = addStructure(nextText, owner, type, x, y);
  if (!withStructure) return { ok: false, reason: '写回 [Structures] 失败。' };
  return {
    ok: true, text: withStructure, owner,
    cells: check.cells, clearedOverlays, removedObjects,
  };
}


/**
 * The overlay indices covered by the map's [Structures].
 *
 * The generator's sidecar already marks every foundation cell of the buildings
 * it placed, but a building added by this page only exists in the map text.
 * Known types use their real footprint; an unknown type marks its anchor cell
 * (that is all the text tells us without every building's art INI).
 */
export function structureOccupiedCells(text) {
  const set = new Set();
  for (const s of readStructures(text)) {
    const type = buildingType(s.type);
    const cells = type ? footprintCells(type, s.x, s.y) : [{ x: s.x, y: s.y }];
    for (const c of cells) {
      if (c.x < 0 || c.y < 0 || c.x >= 512 || c.y >= 512) continue;
      set.add(overlayIndex(c.x, c.y));
    }
  }
  return set;
}
