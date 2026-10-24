// Neutral building handover: give a neutral tech building to a multiplayer
// player SLOT, the way FinalAlert 2's "Change House" action does.
//
// Pure functions over the map text (no DOM), so tools/verify_houses.mjs can
// exercise every rewrite under node.
//
// ---------------------------------------------------------------------------
// WHY A TRIGGER AND NOT THE OWNER FIELD
//
// [Structures]' first field is a house NAME. On a multiplayer map the houses
// are the rules country list, and the players pick their country in the lobby,
// so a name cannot name a slot. The one encoding the engine understands is the
// action-14 house code 4475..4482 -- FA2's <Player @ A>..<Player @ H> (see
// MissionEditor/functions.cpp's ListHouses). The map therefore keeps the
// building owned by "Neutral" and attaches a one-shot tag; a trigger with event
// 8 ("Any Event", springs immediately) runs action 14 ("Change House") with the
// slot code.
//
// One trigger per building: action 14 changes the house of the object the tag
// is attached to, and sharing a tag across several buildings would make the
// target depend on engine internals we have not verified.
//
// The trigger shape is the one docs/TRIGGERS.md records from shipped maps:
//   [Tags]     TAG=0,NeutralBuilding1,TRIG
//   [Triggers] TRIG=Neutral,<none>,NeutralBuilding1,0,1,1,1,0
//   [Events]   TRIG=1,8,0,0
//   [Actions]  TRIG=1,14,0,4475,0,0,0,0,A
// The id prefixes (0A / 0B) are the generator's own convention, so a map that
// already carries generated handovers is recognised and edited in place.
//
// ---------------------------------------------------------------------------
// WHAT IT WILL NOT TOUCH
//
// * Single-player maps ([Neutral House] layout): there is no slot there; the
//   call is refused instead of writing a trigger whose house cannot resolve.
// * CABHUT (the bridge repair hut): it is a neutral map fixture that rebuilds
//   bridges, not a tech building a player can own.
// * Buildings owned by anyone else, or buildings that already carry a tag this
//   module does not recognise: they are reported in `skipped`, never re-tagged,
//   so a hand-edited map cannot lose a trigger it had.
// * Trigger entries that do not look like ours (name prefix + event + action
//   shape): clearing only removes entries applyHandovers could have written.

import { readStructures, neutralOwnerName } from './buildings.js';

export const SLOT_BASE = 4475;
export const MAX_SLOTS = 8;
export const NAME_PREFIX = 'NeutralBuilding';

/** Foundation WxH from the art INI (2x2, 3x3, ...), used for pick/badge only. */
export const STRUCTURE_FOOTPRINTS = {
  CAOILD: [2, 2],   // Tech Oil Derrick
  CAMACH: [3, 3],   // Tech Machine Shop
  CAOUTP: [4, 3],   // Tech Outpost
  CAPOWR: [2, 2],   // Tech Power Plant
  CAAIRP: [3, 3],   // Civilian Airport
  CATHOSP: [6, 4],  // Tech Hospital
  CABHUT: [1, 1],   // Bridge repair hut (never assignable)
};

/** [width, height] for a [Structures] type name; 1x1 when the type is unknown. */
export function footprintOf(type) {
  return STRUCTURE_FOOTPRINTS[String(type || '').toUpperCase()] || [1, 1];
}

/** Cells covered by a structure anchored at (x, y). */
export function structureCells(type, x, y) {
  const [w, h] = footprintOf(type);
  const out = [];
  for (let j = 0; j < h; ++j) for (let i = 0; i < w; ++i) out.push({ x: x + i, y: y + j });
  return out;
}

/** A multiplayer .yrm has [Houses] and no [Neutral House] section. */
export function isMultiplayerMap(text) {
  return !scanSection(text, 'Neutral House');
}

/** 2..8, from [Header] NumberStartingPoints (fallback: the start waypoints). */
export function playerSlots(text) {
  const header = scanSection(text, 'Header');
  if (header) {
    const m = /^\s*NumberStartingPoints\s*=\s*(\d+)/mi.exec(text.slice(header.bodyStart, header.bodyEnd));
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 1) return Math.min(MAX_SLOTS, Math.max(2, n));
    }
  }
  const waypoints = scanSection(text, 'Waypoints');
  if (waypoints) {
    const seen = new Set();
    for (const line of text.slice(waypoints.bodyStart, waypoints.bodyEnd).split(/\r?\n/)) {
      const t = line.trim();
      const eq = t.indexOf('=');
      if (eq < 0 || t.startsWith(';')) continue;
      const k = Number(t.slice(0, eq).trim());
      if (Number.isInteger(k) && k >= 0 && k < MAX_SLOTS) seen.add(k);
    }
    if (seen.size) return Math.min(MAX_SLOTS, Math.max(2, Math.max(...seen) + 1));
  }
  return 2;
}

// ---------------------------------------------------------------------------
// section plumbing
// ---------------------------------------------------------------------------

/**
 * Line bounds of one INI section. `bodyStart` is the first byte of the body,
 * `bodyEnd` the first byte of the next section header (or EOF), so
 * text.slice(bodyStart, bodyEnd) is exactly the body including its newlines.
 */
function scanSection(text, name) {
  const wanted = name.toLowerCase();
  const re = /^[ \t]*\[([^\]]+)\][^\r\n]*(?:\r?\n|$)/gm;
  let found = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (found) {
      found.bodyEnd = m.index;
      found.next = true;
      return found;
    }
    if (m[1].trim().toLowerCase() === wanted) {
      found = {
        headerStart: m.index,
        bodyStart: re.lastIndex,
        bodyEnd: text.length,
        next: false,
        eol: /\r\n/.test(m[0]) ? '\r\n' : '\n',
      };
    }
  }
  return found;
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Ordered [key, value] pairs of a section (values keep their inner commas). */
function readEntries(text, name) {
  const sec = scanSection(text, name);
  const out = [];
  if (!sec) return out;
  for (const line of text.slice(sec.bodyStart, sec.bodyEnd).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith(';')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out.push([t.slice(0, eq).trim(), t.slice(eq + 1).trim()]);
  }
  return out;
}

function setEntry(entries, key, value) {
  const i = entries.findIndex(([k]) => k === key);
  if (i >= 0) entries[i] = [key, value];
  else entries.push([key, value]);
}

function dropEntry(entries, key) {
  const i = entries.findIndex(([k]) => k === key);
  if (i >= 0) entries.splice(i, 1);
}

/**
 * Replace a section's body, dropping the section when `entries` is empty.
 * Every other byte of the map stays where it was.
 */
function writeSection(text, name, entries) {
  const sec = scanSection(text, name);
  const eol = sec ? sec.eol : eolOf(text);
  if (!entries.length) {
    if (!sec) return text;
    if (!sec.next) return text.slice(0, sec.headerStart).replace(/[ \t]+$/, '');
    return text.slice(0, sec.headerStart) + text.slice(sec.bodyEnd);
  }
  const body = entries.map(([k, v]) => `${k}=${v}`).join(eol) + eol;
  if (sec) {
    return text.slice(0, sec.bodyStart) + body + (sec.next ? eol : '') + text.slice(sec.bodyEnd);
  }
  const base = text.replace(/\s+$/, '');
  return (base ? base + eol + eol : '') + `[${name}]` + eol + body;
}

// ---------------------------------------------------------------------------
// reading / writing the handover
// ---------------------------------------------------------------------------

/** The next free id with `prefix` in a key set: 0A000001, 0B000001, ... */
function nextId(entries, prefix) {
  const used = new Set(entries.map(([k]) => k.toUpperCase()));
  for (let n = 1; n <= 0xFFFFFF; ++n) {
    const id = prefix + n.toString(16).toUpperCase().padStart(6, '0');
    if (!used.has(id)) return id;
  }
  throw new Error('触发器 ID 用尽');
}

function actionCode(slot) {
  return SLOT_BASE + slot - 1;
}

function tokens(value) {
  return String(value || '').split(',').map((s) => s.trim());
}

function looksOurs({ name, event, action }) {
  if (!name || !name.startsWith(NAME_PREFIX)) return false;
  if (tokens(event).join(',') !== '1,8,0,0') return false;
  const a = tokens(action);
  // count=1, action 14, six params, waypoint
  return a.length === 9 && a[0] === '1' && a[1] === '14' && a[8] === 'A';
}

/**
 * Every handover this module (or the generator's writer) put on the map:
 * structure index -> { slot, tag, trigger, name }. Entries that do not look
 * like ours are ignored, so a hand-written trigger is never mistaken for one.
 */
export function readHandovers(text) {
  const tags = new Map(readEntries(text, 'Tags'));
  const triggers = new Map(readEntries(text, 'Triggers'));
  const events = new Map(readEntries(text, 'Events'));
  const actions = new Map(readEntries(text, 'Actions'));
  const out = new Map();
  for (const s of readStructures(text)) {
    const tag = (s.fields[6] || '').trim();
    if (!tag || tag.toLowerCase() === 'none') continue;
    const t = tags.get(tag);
    if (!t) continue;
    const trigger = tokens(t)[2] || '';
    const trig = triggers.get(trigger);
    if (!trig) continue;
    const name = tokens(trig)[2] || '';
    if (!looksOurs({ name, event: events.get(trigger), action: actions.get(trigger) })) continue;
    const slot = Number(tokens(actions.get(trigger))[3]) - SLOT_BASE + 1;
    if (!(slot >= 1 && slot <= MAX_SLOTS)) continue;
    out.set(s.index, { slot, tag, trigger, name });
  }
  return out;
}

/** True when this structure is a neutral building the tool may hand over. */
export function assignable(text, structure) {
  if (!structure) return false;
  if (String(structure.type).toUpperCase() === 'CABHUT') return false;
  return String(structure.owner).trim().toLowerCase() ===
         neutralOwnerName(text).trim().toLowerCase();
}

/**
 * Give the structures at `indices` to player `slot` (1..players), or back to
 * neutral when `slot` is null.
 *
 * Returns { ok, text, changed, assigned, skipped }:
 *   assigned  structure indices actually rewritten
 *   skipped   indices that were not neutral / not present / not assignable,
 *             plus buildings that already carry an unknown tag
 */
export function applyHandovers({ text, structures, indices, slot }) {
  if (!isMultiplayerMap(text)) {
    return { ok: false, reason: '这张图是单人 .map（[Neutral House] 布局）：触发器没法按玩家号位给，只有多人 .yrm 支持。' };
  }
  const players = playerSlots(text);
  if (slot !== null && (!Number.isInteger(slot) || slot < 1 || slot > players)) {
    return { ok: false, reason: `号位 ${slot} 不在 1..${players}（这张图的开局点数）。` };
  }

  const list = structures || readStructures(text);
  const byIndex = new Map(list.map((s) => [s.index, s]));
  const neutral = neutralOwnerName(text);
  const handovers = readHandovers(text);

  const tagEntries = readEntries(text, 'Tags');
  const triggerEntries = readEntries(text, 'Triggers');
  const eventEntries = readEntries(text, 'Events');
  const actionEntries = readEntries(text, 'Actions');

  const assigned = [];
  const skipped = [];
  const tagByIndex = new Map();
  let changed = false;

  for (const raw of [...new Set((indices || []).map(Number))]) {
    const s = byIndex.get(raw);
    if (!s || !assignable(text, s)) { skipped.push(raw); continue; }
    const have = handovers.get(raw);
    const currentTag = String(s.fields[6] || '').trim();
    if (!have && currentTag && currentTag.toLowerCase() !== 'none') {
      // Somebody else's tag: leave it alone instead of orphaning a trigger.
      skipped.push(raw);
      continue;
    }

    if (slot === null) {
      if (!have) { skipped.push(raw); continue; }
      dropEntry(tagEntries, have.tag);
      dropEntry(triggerEntries, have.trigger);
      dropEntry(eventEntries, have.trigger);
      dropEntry(actionEntries, have.trigger);
      tagByIndex.set(raw, 'None');
      changed = true;
      assigned.push(raw);
      continue;
    }

    if (have && have.slot === slot) { skipped.push(raw); continue; }

    let tag;
    let trigger;
    let name;
    if (have) {
      tag = have.tag;
      trigger = have.trigger;
      name = have.name;
      // The lines should already be in place; rewrite them in case the map was
      // hand-edited between two assignments.
      setEntry(tagEntries, tag, `0,${name},${trigger}`);
      setEntry(triggerEntries, trigger, `${neutral},<none>,${name},0,1,1,1,0`);
      setEntry(eventEntries, trigger, '1,8,0,0');
    } else {
      tag = nextId(tagEntries, '0A');
      trigger = nextId(triggerEntries, '0B');
      name = `${NAME_PREFIX}${raw + 1}`;
      setEntry(tagEntries, tag, `0,${name},${trigger}`);
      setEntry(triggerEntries, trigger, `${neutral},<none>,${name},0,1,1,1,0`);
      setEntry(eventEntries, trigger, '1,8,0,0');
    }
    setEntry(actionEntries, trigger, `1,14,0,${actionCode(slot)},0,0,0,0,A`);
    tagByIndex.set(raw, tag);
    changed = true;
    assigned.push(raw);
  }

  if (!changed) return { ok: true, text, changed: false, assigned, skipped };

  let next = text;
  if (tagByIndex.size) next = rewriteStructureTags(next, tagByIndex);
  next = writeSection(next, 'Triggers', triggerEntries);
  next = writeSection(next, 'Events', eventEntries);
  next = writeSection(next, 'Actions', actionEntries);
  next = writeSection(next, 'Tags', tagEntries);
  return { ok: true, text: next, changed: true, assigned, skipped };
}

/** Put TAG (or None) in field 7 of the named [Structures] lines. */
function rewriteStructureTags(text, tagByIndex) {
  const sec = scanSection(text, 'Structures');
  if (!sec) return text;
  const eol = sec.eol;
  const body = text.slice(sec.bodyStart, sec.bodyEnd);
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; ++i) {
    const t = lines[i].trim();
    if (!t || t.startsWith(';')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const index = Number(t.slice(0, eq).trim());
    if (!tagByIndex.has(index)) continue;
    const fields = t.slice(eq + 1).split(',');
    while (fields.length < 17) fields.push('');
    fields[6] = tagByIndex.get(index);
    lines[i] = `${t.slice(0, eq)}=${fields.slice(0, 17).join(',')}`;
  }
  return text.slice(0, sec.bodyStart) + lines.join(eol) + text.slice(sec.bodyEnd);
}
