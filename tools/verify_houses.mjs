// Contract test for the editor's neutral-building handover (webapp/houses.js).
//
//   node tools/verify_houses.mjs
//
// What it pins:
//   1. the map rewrite: one [Structures] tag + one trigger/event/action per
//      building, action code 4475+slot-1, every other section byte-identical;
//   2. multiplayer only, slots from the map, CABHUT/foreign-owned skipped;
//   3. re-assign reuses the ids, clear removes exactly our four lines, and both
//      operations are idempotent;
//   4. a foreign trigger/tag on the same map is never touched or removed;
//   5. CRLF maps stay CRLF.
import assert from 'node:assert/strict';
import {
  SLOT_BASE, playerSlots, isMultiplayerMap, readHandovers, applyHandovers,
  assignable, structureCells, footprintOf, buildingScreenRect, structureAtScreenPoint,
  ART_LIFT_TILES,
} from '../webapp/houses.js';
import { readStructures } from '../webapp/buildings.js';

const failures = [];
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { failures.push(label); console.log(`  FAIL ${label}\n       ${err.message}`); }
}

const MP = [
  '[Header]',
  'NumberStartingPoints=3',
  '',
  '[Map]',
  'Size=0,0,60,60',
  '',
  '[Waypoints]',
  '0=100100',
  '1=100101',
  '2=100102',
  '',
  '[Structures]',
  '0=Neutral,CAOILD,256,10,10,0,None,0,0,1,0,0,None,None,None,1,0',
  '1=Neutral,CAMACH,256,20,20,0,None,0,0,1,0,0,None,None,None,1,0',
  '2=Neutral,CABHUT,256,30,30,0,None,0,0,1,0,0,None,None,None,1,0',
  '3=Russians,CAOILD,256,40,40,0,None,0,0,1,0,0,None,None,None,1,0',
  '',
].join('\n');

const section = (text, name) => {
  const re = new RegExp(`\\[${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'i');
  const m = re.exec(text);
  return m ? m[1].split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith(';')) : null;
};
const keys = (text, name) => (section(text, name) || []).map((l) => l.split('=')[0].trim());
const structTag = (text, index) => {
  const line = (section(text, 'Structures') || []).find((l) => Number(l.split('=')[0]) === index);
  return line ? line.slice(line.indexOf('=') + 1).split(',')[6].trim() : null;
};

console.log('  basics');
check('multiplayer layout is recognised', () => {
  assert.equal(isMultiplayerMap(MP), true);
  assert.equal(isMultiplayerMap(MP + '\n[Neutral House]\nIQ=5\n'), false);
});
check('slot count comes from the header', () => assert.equal(playerSlots(MP), 3));
check('slot count falls back to the waypoints', () => {
  const noHeader = MP.replace('[Header]\nNumberStartingPoints=3\n\n', '');
  assert.equal(playerSlots(noHeader), 3);
});
check('foundations come from the art table', () => {
  assert.deepEqual(footprintOf('CAOILD'), [2, 2]);
  assert.deepEqual(footprintOf('CAOUTP'), [4, 3]);
  assert.deepEqual(footprintOf('NOPE'), [1, 1]);
  assert.deepEqual(structureCells('CAOILD', 5, 7), [
    { x: 5, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 8 }, { x: 6, y: 8 },
  ]);
});
check('CABHUT and foreign-owned buildings are not assignable', () => {
  const list = readStructures(MP);
  assert.equal(assignable(MP, list.find((s) => s.index === 0)), true);
  assert.equal(assignable(MP, list.find((s) => s.index === 2)), false);
  assert.equal(assignable(MP, list.find((s) => s.index === 3)), false);
});

console.log('  assign / reassign / clear');
check('assigning one building writes the four sections', () => {
  const res = applyHandovers({ text: MP, structures: readStructures(MP), indices: [0], slot: 2 });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  const tag = structTag(res.text, 0);
  assert.match(tag, /^0A[0-9A-F]{6}$/);
  assert.equal(keys(res.text, 'Tags').includes(tag), true);
  const trig = (section(res.text, 'Tags')[0].split('=')[1].split(',')[2] || '').trim();
  assert.match(trig, /^0B[0-9A-F]{6}$/);
  assert.equal(section(res.text, 'Events')[0], `${trig}=1,8,0,0`);
  assert.equal(section(res.text, 'Actions')[0], `${trig}=1,14,0,${SLOT_BASE + 1},0,0,0,0,A`);
  assert.equal(section(res.text, 'Triggers')[0],
    `${trig}=Neutral,<none>,NeutralBuilding1,0,1,1,1,0`);
  const back = readHandovers(res.text);
  assert.equal(back.get(0).slot, 2);
  assert.equal(structTag(res.text, 1), 'None', 'the neighbour is untouched');
});
check('assigning the same slot twice is a no-op', () => {
  const a = applyHandovers({ text: MP, structures: readStructures(MP), indices: [0], slot: 2 });
  const b = applyHandovers({ text: a.text, structures: readStructures(a.text), indices: [0], slot: 2 });
  assert.equal(b.changed, false);
  assert.equal(b.text, a.text);
});
check('reassigning keeps the ids and only changes the action code', () => {
  const a = applyHandovers({ text: MP, structures: readStructures(MP), indices: [0], slot: 1 });
  const tagA = structTag(a.text, 0);
  const b = applyHandovers({ text: a.text, structures: readStructures(a.text), indices: [0], slot: 3 });
  assert.equal(b.changed, true);
  assert.equal(structTag(b.text, 0), tagA);
  assert.match(section(b.text, 'Actions')[0], new RegExp(`=1,14,0,${SLOT_BASE + 2},0,0,0,0,A$`));
  assert.equal(section(b.text, 'Triggers').length, 1);
  assert.equal(section(b.text, 'Tags').length, 1);
});
check('bulk assign gives every building its own tag/trigger', () => {
  const res = applyHandovers({ text: MP, structures: readStructures(MP), indices: [0, 1], slot: 3 });
  assert.equal(res.assigned.length, 2);
  assert.notEqual(structTag(res.text, 0), structTag(res.text, 1));
  assert.equal(section(res.text, 'Tags').length, 2);
  assert.equal(section(res.text, 'Triggers').length, 2);
  assert.deepEqual(keys(res.text, 'Triggers'), ['0B000001', '0B000002']);
});
check('clear removes our four lines and restores None', () => {
  const a = applyHandovers({ text: MP, structures: readStructures(MP), indices: [0, 1], slot: 1 });
  const b = applyHandovers({ text: a.text, structures: readStructures(a.text), indices: [0, 1], slot: null });
  assert.equal(b.ok, true);
  assert.equal(b.changed, true);
  assert.equal(structTag(b.text, 0), 'None');
  assert.equal(structTag(b.text, 1), 'None');
  assert.equal(section(b.text, 'Triggers'), null);
  assert.equal(section(b.text, 'Tags'), null);
  assert.equal(section(b.text, 'Events'), null);
  assert.equal(section(b.text, 'Actions'), null);
  // everything else is where it was
  assert.equal(b.text.replace(/\s+$/, ''), MP.replace(/\s+$/, ''));
});
check('clearing a building that was never assigned is a no-op', () => {
  const res = applyHandovers({ text: MP, structures: readStructures(MP), indices: [1], slot: null });
  assert.equal(res.changed, false);
  assert.equal(res.text, MP);
});

console.log('  refusals / untouched neighbours');
check('CABHUT is skipped', () => {
  const res = applyHandovers({ text: MP, structures: readStructures(MP), indices: [2], slot: 1 });
  assert.equal(res.changed, false);
  assert.deepEqual(res.skipped, [2]);
});
check('a foreign-owned building is skipped', () => {
  const res = applyHandovers({ text: MP, structures: readStructures(MP), indices: [3], slot: 1 });
  assert.equal(res.changed, false);
  assert.deepEqual(res.skipped, [3]);
});
check('single-player maps are refused', () => {
  const sp = MP + '\n[Neutral House]\nIQ=5\nCountry=Neutral\n';
  const res = applyHandovers({ text: sp, structures: readStructures(sp), indices: [0], slot: 1 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /单人/);
});
check('out-of-range slots are refused', () => {
  assert.equal(applyHandovers({ text: MP, structures: readStructures(MP), indices: [0], slot: 0 }).ok, false);
  assert.equal(applyHandovers({ text: MP, structures: readStructures(MP), indices: [0], slot: 4 }).ok, false);
});
check('a foreign tag on the same building is not overwritten', () => {
  const text = MP.replace(
    '0=Neutral,CAOILD,256,10,10,0,None,',
    '0=Neutral,CAOILD,256,10,10,0,0C000001,')
    + '\n[Tags]\n0C000001=0,SomeoneElse,0D000001\n'
    + '\n[Triggers]\n0D000001=Neutral,<none>,SomeoneElse,0,1,1,1,0\n'
    + '\n[Events]\n0D000001=1,13,0,5\n'
    + '\n[Actions]\n0D000001=1,16,0,0,0,0,0,0,A\n';
  const res = applyHandovers({ text, structures: readStructures(text), indices: [0], slot: 1 });
  assert.equal(res.changed, false);
  assert.deepEqual(res.skipped, [0]);
  assert.match(res.text, /0C000001=0,SomeoneElse,0D000001/);
});
check('our assignment leaves a foreign trigger alone', () => {
  const text = MP + '\n[Tags]\n0C000001=0,SomeoneElse,0D000001\n'
    + '\n[Triggers]\n0D000001=Neutral,<none>,SomeoneElse,0,1,1,1,0\n'
    + '\n[Events]\n0D000001=1,13,0,5\n'
    + '\n[Actions]\n0D000001=1,16,0,0,0,0,0,0,A\n';
  const res = applyHandovers({ text, structures: readStructures(text), indices: [0], slot: 2 });
  assert.match(res.text, /0C000001=0,SomeoneElse,0D000001/);
  assert.match(res.text, /0D000001=1,13,0,5/);
  const back = applyHandovers({ text: res.text, structures: readStructures(res.text), indices: [0], slot: null });
  assert.match(back.text, /0C000001=0,SomeoneElse,0D000001/);
  assert.match(back.text, /0D000001=1,16,0,0,0,0,0,0,A/);
});

console.log('  screen hit test (clicking the tower, not the base)');
check('a building\'s art box covers the space above its footprint', () => {
  const project = (x, y) => ({ x: x * 40, y: (x + y) * 20 });
  const anchor = project(10, 10);
  const r = buildingScreenRect({ type: 'CAOILD', x: 10, y: 10 }, project, 60, 30, 1);
  assert.equal(ART_LIFT_TILES, 4.2);
  assert(r.y0 <= anchor.y - 100, `lift only ${anchor.y - r.y0} px`);
  assert(r.y1 >= anchor.y);
  const opts = { project, tileWidth: 60, tileHeight: 30, scale: 1 };
  const derrick = { type: 'CAOILD', x: 10, y: 10 };
  assert.equal(structureAtScreenPoint([derrick], anchor.x, anchor.y - 80, opts), derrick);
  assert.equal(structureAtScreenPoint([derrick], anchor.x, anchor.y - 100, opts), derrick);
  assert.equal(structureAtScreenPoint([derrick], anchor.x, anchor.y - 200, opts), null);
  assert.equal(structureAtScreenPoint([derrick], anchor.x + 500, anchor.y, opts), null);
});
check('overlapping art boxes resolve to the nearest centre', () => {
  const project = (x, y) => ({ x: x * 10, y: (x + y) * 5 });
  const opts = { project, tileWidth: 60, tileHeight: 30, scale: 1 };
  const a = { type: 'CAOILD', x: 0, y: 0 };
  const b = { type: 'CAOILD', x: 2, y: 2 };
  const pa = project(0, 0);
  const pb = project(2, 2);
  assert.equal(structureAtScreenPoint([a, b], pa.x, pa.y, opts), a);
  assert.equal(structureAtScreenPoint([a, b], pb.x, pb.y, opts), b);
});
check('the drawing lift can be tightened independently of the hit box', () => {
  const project = (x, y) => ({ x: x * 40, y: (x + y) * 20 });
  const st = { type: 'CAOILD', x: 10, y: 10 };
  const hit = buildingScreenRect(st, project, 60, 30, 1);          // 4.2 tiles
  const frame = buildingScreenRect(st, project, 60, 30, 1, 2.6);   // drawing
  assert(frame.y0 > hit.y0);
  assert.equal(Math.round(hit.y0 - frame.y0), Math.round((4.2 - 2.6) * 30));
  assert.equal(frame.y1, hit.y1, 'the bottom edge is the same');
});

check('scale is applied to the box as well as the point', () => {
  const project = (x, y) => ({ x: x * 40, y: (x + y) * 20 });
  const opts = { project, tileWidth: 60, tileHeight: 30, scale: 0.5 };
  const st = { type: 'CAOILD', x: 10, y: 10 };
  const anchor = project(10, 10);
  assert.equal(structureAtScreenPoint([st], anchor.x * 0.5, anchor.y * 0.5 - 40, opts), st);
});

console.log('  line endings');
check('CRLF maps stay CRLF', () => {
  const crlf = MP.replace(/\n/g, '\r\n');
  const res = applyHandovers({ text: crlf, structures: readStructures(crlf), indices: [0], slot: 2 });
  const stripped = res.text.replace(/\r\n/g, '');
  assert.equal(stripped.includes('\n'), false, 'a bare LF was introduced');
  assert.equal(res.text.includes('\r\n'), true);
});

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
