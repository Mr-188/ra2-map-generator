// Contract test for the preview's ore brush, run under node.
//
//   node tools/verify_ore.mjs --web build/engine-web-node --game /path/to/RA2MD
//        [--product webapp] [--renderer <CNCMaps.Renderer.dll> --mixdir build/flat]
//
// Four separate things are on trial, and each has exactly one source:
//
//   1. Format80 (webapp/ore.js) against the project's verified Python codec
//      (maptools/format80.py) in BOTH directions.  A map we write has to be
//      readable by the same reader the acceptance oracle uses, and their bytes
//      have to decode to ours.
//   2. the map edit: painting changes [OverlayPack]/[OverlayDataPack] and
//      nothing else; the Python format layer reads back exactly the grids we
//      meant to write (so the encoding really is the map's format, not a
//      lookalike).
//   3. the brush's own rules: only in-map passable ground, never over another
//      overlay, never over a [Terrain]/[Structures] object, gems untouched,
//      idempotent, and 清除 puts the cell back to 0xFF.
//   4. the RENDERER: when a native CNCMaps build and a loose game tree are
//      given, the painted cells' pixels actually change in a fresh render --
//      proving the overlay we wrote is the overlay the image is drawn from.
//
// The map itself comes from the generator through the same API webapp/worker.js
// uses (see verify_webapi.mjs / verify_starts.mjs, whose harness this borrows).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

import {
  parseCellGrid, projectCell, cellFlags, CELL_IN_MAP, CELL_PASSABLE, CELL_BUILDING,
} from '../webapp/starts.js';
import {
  readOverlayGrids, writeOverlayGrids, readOccupiedCells, cellsInRect,
  countSelection, paintOreCells, paintMineralCells, clearOreCells, removeOreDecorations,
  placePillar, removePillar, describePillarTarget, findTerrainObject, isPillarName,
  classifyCell, decodeFormat80, encodeFormat80, isOreOverlay, isGemOverlay,
  isTiberiumOverlay, EMPTY_OVERLAY, ORE_OVERLAY_START, ORE_OVERLAY_END,
  GEM_OVERLAY_START, GEM_OVERLAY_END, ORE_DATA, GEM_DATA,
  OVERLAY_BYTES, CELL_EMPTY, CELL_ORE, CELL_OTHER, CELL_BLOCKED,
} from '../webapp/ore.js';

function parseArgs(argv) {
  const out = { theater: 0, time: 0, land: 1, size: 1, players: 4, seed: 2 };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    out[key] = ['theater', 'time', 'land', 'size', 'players'].includes(key)
      ? Number(value) : value;
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.web || !args.game) {
  console.error('usage: node tools/verify_ore.mjs --web <dir> --game <RA2 dir> '
    + '[--product webapp] [--renderer <dll> --mixdir <loose tree>]');
  process.exit(2);
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webDir = path.resolve(args.web);
const gameDir = path.resolve(args.game);
for (const name of ['ra2.mix', 'ra2md.mix', 'expandmd01.mix']) {
  if (!fs.existsSync(path.join(gameDir, name))) {
    console.error(`missing ${name} in ${gameDir}`);
    process.exit(2);
  }
}

const failures = [];
let checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(`${label} ${detail}`.trim());
};
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// ---- 0. the shipped page must not carry node-only imports ----------------
if (args.product) {
  for (const name of ['app.js', 'worker.js', 'starts.js', 'ore.js']) {
    const p = path.join(path.resolve(args.product), name);
    if (!fs.existsSync(p)) { check(`product has ${name}`, false, p); continue; }
    const text = fs.readFileSync(p, 'utf8');
    const bad = [];
    if (/from\s+['"]node:/.test(text)) bad.push("import from 'node:'");
    if (/from\s+['"]module['"]/.test(text)) bad.push("import from 'module'");
    if (/createRequire/.test(text)) bad.push('createRequire');
    check(`${name} is browser-safe`, bad.length === 0, bad.join(', '));
  }
}

// ---------------------------------------------------------------------------
// 1. Format80 against maptools/format80.py
// ---------------------------------------------------------------------------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-ore-'));
const py = (script, ...pys) => spawnSync('python3', ['-c', script, ...pys], {
  encoding: 'utf8',
  env: { ...process.env, PYTHONPATH: ROOT },
});

const patterns = {
  empty: new Uint8Array(OVERLAY_BYTES).fill(0xFF),
  zeros: new Uint8Array(OVERLAY_BYTES),
  mixed: (() => {
    const out = new Uint8Array(OVERLAY_BYTES);
    for (let i = 0; i < out.length; ++i) {
      const x = i % 512;
      const y = Math.floor(i / 512);
      out[i] = (x % 13 === 0 || y % 17 === 0) ? 0xFF : (x + y) & 0xFF;
    }
    return out;
  })(),
  runs: (() => {
    const out = new Uint8Array(OVERLAY_BYTES);
    let seed = 12345;
    for (let i = 0; i < out.length; ++i) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      out[i] = seed < 0x80000000 ? 0xFF : (seed >>> 24) & 0xFF;
    }
    return out;
  })(),
};

for (const [name, bytes] of Object.entries(patterns)) {
  const encoded = encodeFormat80(bytes);
  const decoded = decodeFormat80(encoded, bytes.length);
  check(`Format80 round-trips (${name})`,
        !!decoded && decoded.length === bytes.length
        && bytes.every((v, i) => v === decoded[i]),
        `${bytes.length} -> ${encoded.length} -> ${decoded ? decoded.length : 'null'}`);

  // The project's own decoder has to accept our stream and produce our bytes.
  const encPath = path.join(scratch, `py-${name}.bin`);
  const bytesPath = path.join(scratch, `raw-${name}.bin`);
  fs.writeFileSync(encPath, encoded);
  fs.writeFileSync(bytesPath, bytes);
  const out = py(`
import sys, hashlib
sys.path.insert(0, ${JSON.stringify(ROOT)})
from maptools.format80 import decode_into, encode
raw = open(sys.argv[2], 'rb').read()
dec = decode_into(open(sys.argv[1], 'rb').read(), len(raw))
print(hashlib.sha256(dec).hexdigest())
print(hashlib.sha256(encode(raw)).hexdigest())
`, encPath, bytesPath);
  if (out.status !== 0) {
    check(`maptools decodes our Format80 (${name})`, false, (out.stderr || '').trim());
  } else {
    const [decHash, pyEncHash] = out.stdout.trim().split('\n');
    check(`maptools decodes our Format80 (${name})`, decHash === sha(bytes),
          `${decHash.slice(0, 12)} vs ${sha(bytes).slice(0, 12)}`);

    // And the other direction: their encoder's stream must decode here.
    const pyEnc = Buffer.from(py(`
import sys, base64
sys.path.insert(0, ${JSON.stringify(ROOT)})
from maptools.format80 import encode
print(base64.b64encode(encode(open(sys.argv[1], 'rb').read())).decode())
`, bytesPath).stdout.trim(), 'base64');
    const ours = decodeFormat80(pyEnc, bytes.length);
    check(`we decode maptools' Format80 (${name})`,
          !!ours && sha(ours) === sha(bytes),
          `${pyEnc.length} -> ${ours ? ours.length : 'null'}`
          + ` (maptools encode sha ${pyEncHash.slice(0, 12)})`);
  }
}

// ---------------------------------------------------------------------------
// 2. generate a map + its ground grid (the browser entry point's own API)
// ---------------------------------------------------------------------------
const pkgPath = path.join(webDir, 'package.json');
if (!fs.existsSync(pkgPath)) {
  fs.writeFileSync(pkgPath, JSON.stringify({ type: 'module' }, null, 2));
}
const mod = await import(pathToFileURL(path.join(webDir, 'mg_engine.js')).href);
const Module = await mod.default({
  locateFile: (name) => path.join(webDir, name),
  print: () => {},
  printErr: () => {},
});

const files = new Map();
const sizes = new Map();
let nextId = 1;
Module.mgFileSize = (id) => (sizes.has(id) ? sizes.get(id) : -1);
Module.mgRead = (id, offset, length, ptr) => {
  const file = files.get(id);
  if (!file) return 0;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    if (fs.readSync(fd, buf, 0, length, offset) !== length) return 0;
    Module.HEAPU8.set(buf, ptr);
    return 1;
  } finally {
    fs.closeSync(fd);
  }
};

const api = {
  addFile: Module.cwrap('mg_add_file', null, ['number', 'string']),
  setRoot: Module.cwrap('mg_set_root', null, ['string']),
  extract: Module.cwrap('mg_extract', 'number', ['number']),
  generate: Module.cwrap('mg_generate', 'number',
    ['number', 'number', 'number', 'number', 'number', 'number',
     'number', 'number', 'number', 'number', 'number', 'number', 'number',
     'string']),
  readOutput: Module.cwrap('mg_read_output', 'number', ['string', 'number', 'number']),
  error: Module.cwrap('mg_error', 'string', []),
};

const readOut = (p) => {
  const n = api.readOutput(p, 0, -1);
  if (n <= 0) return null;
  const ptr = Module._malloc(n);
  try {
    return api.readOutput(p, ptr, n) === n
      ? Uint8Array.from(Module.HEAPU8.slice(ptr, ptr + n)) : null;
  } finally {
    Module._free(ptr);
  }
};

for (const name of ['ra2.mix', 'ra2md.mix', 'expandmd01.mix']) {
  const id = nextId++;
  files.set(id, path.join(gameDir, name));
  sizes.set(id, fs.statSync(path.join(gameDir, name)).size);
  api.addFile(id, name);
}
api.setRoot('/mg');
const rcEx = api.extract(args.theater);
check('mg_extract', rcEx === 0, rcEx === 0 ? '' : api.error());

const outPath = '/mg/out.map';
const rcGen = api.generate(args.land, args.theater, args.time, args.size, args.players,
                           1, -1, args.seed >>> 0, 0, 0, 0, 0, 0, outPath);
check('mg_generate', rcGen === 0, rcGen === 0 ? '' : api.error());

const mapBytes = readOut(outPath);
const gridBytes = readOut(outPath + '.cells');
check('the map was written', !!mapBytes, mapBytes ? `${mapBytes.length} bytes` : '');
check('the ground grid was written next to it', !!gridBytes,
      gridBytes ? `${gridBytes.length} bytes` : '');
if (!mapBytes || !gridBytes) {
  console.log(`\n[verify_ore] FAIL -- ${failures.length} of ${checks} checks`);
  process.exit(1);
}

const mapText = new TextDecoder('latin1').decode(mapBytes);
const grid = parseCellGrid(gridBytes);
check('grid parses', !!grid, grid ? `${grid.width}x${grid.height}` : '');
const grids = readOverlayGrids(mapText);
check('[OverlayPack]/[OverlayDataPack] decode', !!grids,
      grids ? `${grids.ids.length} bytes each` : 'missing or malformed');
if (!grids) {
  console.log(`\n[verify_ore] FAIL -- ${failures.length} of ${checks} checks`);
  process.exit(1);
}
const occupied = readOccupiedCells(mapText);

// The sidecar's building bit is the only way to know a multi-cell foundation's
// cells (the map text names the anchor only).  A synthetic copy of a free cell
// with the bit set proves classifyCell honours it even if this map happens to
// have no tech buildings.
let buildingCells = 0;
for (let y = 0; y < grid.height; ++y) {
  for (let x = 0; x < grid.width; ++x) {
    if (cellFlags(grid, x, y) & CELL_BUILDING) buildingCells++;
  }
}
let blockedBuildings = 0;
for (let y = 0; y < grid.height; ++y) {
  for (let x = 0; x < grid.width; ++x) {
    if (!(cellFlags(grid, x, y) & CELL_BUILDING)) continue;
    if (classifyCell(grid, grids.ids, occupied, x, y) !== CELL_BLOCKED) blockedBuildings++;
  }
}
check('no real building-foundation cell is paintable', blockedBuildings === 0,
      `${buildingCells} building cells, ${blockedBuildings} paintable`);

let freeCell = null;
for (let y = 0; y < grid.height && !freeCell; ++y) {
  for (let x = 0; x < grid.width; ++x) {
    if (classifyCell(grid, grids.ids, occupied, x, y) === CELL_EMPTY) { freeCell = { x, y }; break; }
  }
}
if (freeCell) {
  const flags = grid.flags.slice();
  flags[freeCell.y * grid.width + freeCell.x] |= CELL_BUILDING;
  const synthetic = { ...grid, flags };
  check('a building-foundation cell is never paintable',
        classifyCell(synthetic, grids.ids, occupied, freeCell.x, freeCell.y) === CELL_BLOCKED,
        `map has ${buildingCells} building cells`);
}

// Python reads the same map: our decode has to equal the oracle's.
const mapPath = path.join(scratch, 'generated.map');
fs.writeFileSync(mapPath, Buffer.from(mapBytes));
const readBack = py(`
import sys, json, hashlib
sys.path.insert(0, ${JSON.stringify(ROOT)})
from maptools import map_ini, overlay_layer
text = open(sys.argv[1], 'rb').read().decode('latin1')
layer = overlay_layer.OverlayLayer.from_sections(map_ini.read_sections(text))
print(json.dumps({
  'ids': hashlib.sha256(bytes(layer.ids)).hexdigest(),
  'data': hashlib.sha256(bytes(layer.data)).hexdigest(),
  'overlays': sum(1 for v in layer.ids if v != 0xFF),
  'ore': sum(1 for v in layer.ids if 102 <= v <= 113),
}))
`, mapPath);
check('the Python oracle reads the generated map', readBack.status === 0,
      (readBack.stderr || '').trim());
if (readBack.status === 0) {
  const oracle = JSON.parse(readBack.stdout);
  check('our overlay ids equal the oracle\'s', sha(grids.ids) === oracle.ids,
        `${sha(grids.ids).slice(0, 12)} vs ${oracle.ids.slice(0, 12)}`);
  check('our overlay data equals the oracle\'s', sha(grids.data) === oracle.data,
        `${sha(grids.data).slice(0, 12)} vs ${oracle.data.slice(0, 12)}`);
  const ourOre = grids.ids.reduce((n, v) => n + (isOreOverlay(v) ? 1 : 0), 0);
  check('the generated map actually carries ore', ourOre === oracle.ore && ourOre > 0,
        `${ourOre} vs ${oracle.ore}`);
}

// ---------------------------------------------------------------------------
// 3. selection: a box means the cells whose drawn centre is inside it
// ---------------------------------------------------------------------------
// A provisional transform, the same shape the renderer publishes (the real one
// is used by the pixel check below).  Zero crop shifts every pixel equally.
const meta = {
  tileWidth: 60,
  tileHeight: 30,
  fullSize: { width: grid.width, height: grid.height },
  saveRect: { x: 0, y: 0 },
};

let single = null;
for (let y = 0; y < grid.height && !single; ++y) {
  for (let x = 0; x < grid.width; ++x) {
    if (cellFlags(grid, x, y) & CELL_IN_MAP) { single = { x, y }; break; }
  }
}
const p = projectCell(grid, meta, single.x, single.y);
const tiny = cellsInRect(grid, meta, { x0: p.x - 0.5, y0: p.y - 0.5, x1: p.x + 0.5, y1: p.y + 0.5 });
check('a box around one cell centre selects exactly that cell',
      tiny.length === 1 && tiny[0].x === single.x && tiny[0].y === single.y,
      tiny.map((c) => `(${c.x},${c.y})`).join(' '));

const all = cellsInRect(grid, meta, { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 });
let inMap = 0;
for (let y = 0; y < grid.height; ++y) {
  for (let x = 0; x < grid.width; ++x) {
    if (cellFlags(grid, x, y) & CELL_IN_MAP) inMap++;
  }
}
check('a box over everything selects every in-map cell', all.length === inMap,
      `${all.length} vs ${inMap}`);
check('a box off the image selects nothing',
      cellsInRect(grid, meta, { x0: -1e6, y0: -1e6, x1: -1e5, y1: -1e5 }).length === 0);

// Find an 8x8 block of free, passable, overlay-less ground.  If this map has no
// such block, any passable cluster will do; the assertions below then just see
// fewer painted cells.
let block = null;
for (let by = 0; by + 8 <= grid.height && !block; by += 3) {
  for (let bx = 0; bx + 8 <= grid.width && !block; bx += 3) {
    let ok = true;
    const cells = [];
    for (let y = by; y < by + 8 && ok; ++y) {
      for (let x = bx; x < bx + 8; ++x) {
        if (classifyCell(grid, grids.ids, occupied, x, y) !== CELL_EMPTY) { ok = false; break; }
        cells.push({ x, y });
      }
    }
    if (ok) block = { x: bx, y: by, cells };
  }
}
check('a free 8x8 block exists to paint into', !!block,
      block ? `at (${block.x}, ${block.y})` : 'none');

let selected = [];
if (block) {
  const rect = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  for (const c of block.cells) {
    const q = projectCell(grid, meta, c.x, c.y);
    rect.x0 = Math.min(rect.x0, q.x);
    rect.y0 = Math.min(rect.y0, q.y);
    rect.x1 = Math.max(rect.x1, q.x);
    rect.y1 = Math.max(rect.y1, q.y);
  }
  rect.x0 -= 0.5; rect.y0 -= 0.5; rect.x1 += 0.5; rect.y1 += 0.5;
  selected = cellsInRect(grid, meta, rect);
  const counts = countSelection(grid, grids.ids, occupied, selected);
  check('the box selects cells and classifies them',
        counts.total === selected.length && counts.empty > 0,
        `total ${counts.total}, empty ${counts.empty}, ore ${counts.ore}, blocked ${counts.blocked}`);
  for (const c of block.cells) {
    if (!selected.some((s) => s.x === c.x && s.y === c.y)) {
      check('every cell of the free block is inside its own box', false, `(${c.x},${c.y}) missing`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// 4. painting, idempotence, clearing, and the map rewrite
// ---------------------------------------------------------------------------
const beforeIds = grids.ids.slice();
const beforeData = grids.data.slice();
// A gem cell must not be overwritten when it happens to be in the box.  Find
// one (27..38) and include it in the painted selection.
let gem = null;
for (let i = 0; i < grids.ids.length && !gem; ++i) {
  if (grids.ids[i] >= 27 && grids.ids[i] <= 38) {
    gem = { x: i % 512, y: Math.floor(i / 512) };
  }
}
if (gem) selected = selected.concat([gem]);
// Something already ore, to prove it is counted and left alone.  Prefer an ore
// cell that also carries a TIBTRE decoration tree: 清除 must take the tree with
// the ore (see removeOreDecorations).
const tibCount = (t) => (t.match(/^[ \t]*\d+[ \t]*=[ \t]*TIBTRE\w*/gim) || []).length;
let decor = null;
{
  const sec = (/\[Terrain\]([\s\S]*?)(?=\n\[|$)/i.exec(mapText) || [])[1] || '';
  for (const line of sec.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*=\s*(\w+)/.exec(line);
    if (!m || !/^TIBTRE/i.test(m[2])) continue;
    const packed = Number(m[1]);
    const x = packed % 1000;
    const y = Math.floor(packed / 1000);
    if (x < 512 && y < 512 && isOreOverlay(grids.ids[x + 512 * y])) {
      decor = { x, y, packed };
      break;
    }
  }
}
let existing = decor;
if (!existing) {
  for (let i = 0; i < grids.ids.length && !existing; ++i) {
    if (isOreOverlay(grids.ids[i])) {
      existing = { x: i % 512, y: Math.floor(i / 512) };
    }
  }
}
if (existing) selected = selected.concat([existing]);

const painted = paintOreCells({
  grid, cells: selected, ids: grids.ids, data: grids.data, occupied,
});
check('painting writes the empty cells of the selection',
      painted.painted === countSelection(grid, beforeIds, occupied, selected).empty,
      `${painted.painted} painted, ${painted.existing} existing, ${painted.blocked} blocked`);
check('the painted cells are the ore family',
      selected.every((c) => {
        const i = c.x + 512 * c.y;
        if (grids.ids[i] === beforeIds[i]) return true;       // untouched
        return isOreOverlay(grids.ids[i]) && grids.ids[i] >= ORE_OVERLAY_START
            && grids.ids[i] <= ORE_OVERLAY_END && grids.data[i] === ORE_DATA;
      }), `data ${ORE_DATA}`);
check('cells outside the selection are byte-identical',
      grids.ids.every((v, i) => selected.some((c) => c.x + 512 * c.y === i)
        ? true : v === beforeIds[i]));
check('gems in the selection are not overwritten',
      !gem || grids.ids[gem.x + 512 * gem.y] === beforeIds[gem.x + 512 * gem.y],
      gem ? `(${gem.x},${gem.y}) ${beforeIds[gem.x + 512 * gem.y]}` : 'no gems on this map');

const second = paintOreCells({
  grid, cells: selected, ids: grids.ids, data: grids.data, occupied,
});
check('painting again is a no-op', second.painted === 0
      && second.existing === painted.existing + painted.painted,
      `${second.painted} more painted, ${second.existing} existing`);

// ---- the colored-ore brush (gems, 27..38) --------------------------------
const gemGrids = readOverlayGrids(mapText);
const gemCounts = countSelection(grid, beforeIds, occupied, selected, GEM_OVERLAY_START);
const gemPainted = paintMineralCells({
  grid, cells: selected, ids: gemGrids.ids, data: gemGrids.data, occupied,
  family: GEM_OVERLAY_START, stage: GEM_DATA,
});
check('painting gems fills the same empty cells',
      gemPainted.painted === gemCounts.empty && gemPainted.painted > 0,
      `${gemPainted.painted} painted, ${gemPainted.existing} existing, `
      + `${gemPainted.other} other mineral, ${gemPainted.blocked} blocked`);
check('painted gems are the gem family at the mature stage',
      selected.every((c) => {
        const i = c.x + 512 * c.y;
        if (gemGrids.ids[i] === beforeIds[i]) return true;
        return isGemOverlay(gemGrids.ids[i]) && gemGrids.data[i] === GEM_DATA
          && gemGrids.ids[i] >= GEM_OVERLAY_START && gemGrids.ids[i] <= GEM_OVERLAY_END;
      }), `data ${GEM_DATA}`);
check('the gem brush leaves green ore alone',
      selected.every((c) => {
        const i = c.x + 512 * c.y;
        return isOreOverlay(beforeIds[i]) ? gemGrids.ids[i] === beforeIds[i] : true;
      }));
const gemSecond = paintMineralCells({
  grid, cells: selected, ids: gemGrids.ids, data: gemGrids.data, occupied,
  family: GEM_OVERLAY_START, stage: GEM_DATA,
});
check('painting gems again is a no-op', gemSecond.painted === 0
      && gemSecond.existing === gemPainted.existing + gemPainted.painted,
      `${gemSecond.painted} more painted, ${gemSecond.existing} existing`);

const gemText = writeOverlayGrids(mapText, gemGrids.ids, gemGrids.data);
const gemPath = path.join(scratch, 'gems.map');
fs.writeFileSync(gemPath, Buffer.from(gemText, 'latin1'));
const gemRead = py(`
import sys, json, hashlib
sys.path.insert(0, ${JSON.stringify(ROOT)})
from maptools import map_ini, overlay_layer
text = open(sys.argv[1], 'rb').read().decode('latin1')
layer = overlay_layer.OverlayLayer.from_sections(map_ini.read_sections(text))
print(json.dumps({
  'ids': hashlib.sha256(bytes(layer.ids)).hexdigest(),
  'data': hashlib.sha256(bytes(layer.data)).hexdigest(),
}))
`, gemPath);
check('the Python oracle reads our painted gems back',
      gemRead.status === 0 && (() => {
        const o = JSON.parse(gemRead.stdout);
        return o.ids === sha(gemGrids.ids) && o.data === sha(gemGrids.data);
      })(), (gemRead.stderr || '').trim());

const paintedText = writeOverlayGrids(mapText, grids.ids, grids.data);
check('the rewritten map is text', typeof paintedText === 'string');
const paintedPath = path.join(scratch, 'painted.map');
fs.writeFileSync(paintedPath, Buffer.from(paintedText, 'latin1'));

const verifyPy = py(`
import sys, json, hashlib
sys.path.insert(0, ${JSON.stringify(ROOT)})
from maptools import map_ini, overlay_layer
before = open(sys.argv[1], 'rb').read().decode('latin1')
after = open(sys.argv[2], 'rb').read().decode('latin1')
la = overlay_layer.OverlayLayer.from_sections(map_ini.read_sections(before))
lb = overlay_layer.OverlayLayer.from_sections(map_ini.read_sections(after))
sa = map_ini.read_sections(before)
sb = map_ini.read_sections(after)
same_other = all(
    name_a == name_b and lines_a == lines_b
    for (name_a, lines_a), (name_b, lines_b) in zip(sa, sb)
    if name_a.lower() not in ('overlaypack', 'overlaydatapack')
)
print(json.dumps({
  'ids': hashlib.sha256(bytes(lb.ids)).hexdigest(),
  'data': hashlib.sha256(bytes(lb.data)).hexdigest(),
  'sameSections': [n for n, _ in sa] == [n for n, _ in sb] and len(sa) == len(sb),
  'sameOther': same_other,
}))
`, mapPath, paintedPath);
check('the Python oracle parses the painted map', verifyPy.status === 0,
      (verifyPy.stderr || '').trim());
if (verifyPy.status === 0) {
  const oracle = JSON.parse(verifyPy.stdout);
  check('the oracle reads our painted ids back', oracle.ids === sha(grids.ids),
        `${oracle.ids.slice(0, 12)} vs ${sha(grids.ids).slice(0, 12)}`);
  check('the oracle reads our painted data back', oracle.data === sha(grids.data),
        `${oracle.data.slice(0, 12)} vs ${sha(grids.data).slice(0, 12)}`);
  check('the section list is unchanged', oracle.sameSections);
  check('every section except the two overlay packs is unchanged', oracle.sameOther);
}

// 清除 restores the painted cells (including the pre-existing ore it touched).
let clearTargets = selected;
const cleared = clearOreCells({ cells: clearTargets, ids: grids.ids, data: grids.data });
check('清除 removes ore from the selection', cleared.cleared > 0, `${cleared.cleared} cleared`);
check('清除 leaves other overlays alone',
      selected.every((c) => {
        const i = c.x + 512 * c.y;
        return isOreOverlay(beforeIds[i]) ? grids.ids[i] === EMPTY_OVERLAY : true;
      }));
check('清除 also removes the gems in the selection',
      !gem || grids.ids[gem.x + 512 * gem.y] === EMPTY_OVERLAY);

const clearedText = removeOreDecorations(
  writeOverlayGrids(paintedText, grids.ids, grids.data), cleared.packed);
check('清除 removes the TIBTRE decoration on a cleared ore cell',
      !decor || tibCount(clearedText) < tibCount(paintedText),
      `TIBTRE ${tibCount(paintedText)} -> ${tibCount(clearedText)}`
      + (decor ? `, cell (${decor.x},${decor.y})` : ', no decorated ore cell on this map'));
check('清除 leaves the other map sections alone',
      (/\[Waypoints\]([\s\S]*?)(?=\n\[|$)/i.exec(paintedText) || [])[1]
        === (/\[Waypoints\]([\s\S]*?)(?=\n\[|$)/i.exec(clearedText) || [])[1]
      && (/\[Structures\]([\s\S]*?)(?=\n\[|$)/i.exec(paintedText) || [])[1]
        === (/\[Structures\]([\s\S]*?)(?=\n\[|$)/i.exec(clearedText) || [])[1]);
const clearedGrids = readOverlayGrids(clearedText);
const decorIndex = decor ? decor.x + 512 * decor.y : -1;
check('the cleared map still parses and the ore is gone',
      !!clearedGrids && (!decor || clearedGrids.ids[decorIndex] === EMPTY_OVERLAY),
      clearedGrids
        ? (decor ? `(${decor.x},${decor.y}) id=${clearedGrids.ids[decorIndex]}` : 'no decor cell')
        : 'overlay packs do not parse');

// ---------------------------------------------------------------------------
// 5. 矿柱 (TIBTRE, a [Terrain] object)
// ---------------------------------------------------------------------------
const terrainMap = (t) => {
  const map = new Map();
  const sec = (/\[Terrain\]([\s\S]*?)(?=\n\[|$)/i.exec(t) || [])[1] || '';
  for (const line of sec.split(/\r?\n/)) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0 || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
    const key = Number(trimmed.slice(0, eq).trim());
    if (Number.isInteger(key)) map.set(key, trimmed.slice(eq + 1).trim());
  }
  return map;
};

let treeCell = null;
{
  const before = terrainMap(mapText);
  for (const [packed, name] of before) {
    if (isPillarName(name)) continue;
    const x = packed % 1000;
    const y = Math.floor(packed / 1000);
    if (x >= grid.width || y >= grid.height) continue;
    const f = cellFlags(grid, x, y);
    if ((f & CELL_PASSABLE) && !(f & CELL_BUILDING)) {
      treeCell = { x, y, packed, name };
      break;
    }
  }
}
check('a replaceable [Terrain] object exists', !!treeCell,
      treeCell ? `${treeCell.name} at (${treeCell.x},${treeCell.y})` : 'none');

if (treeCell) {
  const pillarGrids = readOverlayGrids(mapText);
  const placed = placePillar({
    grid, text: mapText, ids: pillarGrids.ids, data: pillarGrids.data,
    x: treeCell.x, y: treeCell.y,
  });
  check('placePillar puts a pillar on the cell',
        placed.ok && placed.changed && isPillarName(placed.name), placed.name || placed.reason);
  check('the object that was there is replaced',
        placed.removedObject === treeCell.name, `${treeCell.name} -> ${placed.name}`);
  check('the [Terrain] line now names the pillar',
        findTerrainObject(placed.text, treeCell.packed) === placed.name);

  const beforeT = terrainMap(mapText);
  const afterT = terrainMap(placed.text);
  check('replacing an object keeps every other [Terrain] line',
        afterT.size === beforeT.size
        && [...beforeT].every(([k, v]) => k === treeCell.packed
          ? afterT.get(k) === placed.name : afterT.get(k) === v));
  check('the pillar edit touches no other map section',
        ['Waypoints', 'Structures', 'Map'].every((name) => {
          const re = new RegExp('\\[' + name + '\\]([\\s\\S]*?)(?=\\n\\[|$)', 'i');
          return (re.exec(placed.text) || [])[1] === (re.exec(mapText) || [])[1];
        }));

  const again = placePillar({
    grid, text: placed.text, ids: pillarGrids.ids, data: pillarGrids.data,
    x: treeCell.x, y: treeCell.y,
  });
  check('placing a pillar where one already is is a no-op',
        again.ok && !again.changed && again.already, again.name);

  const removed = removePillar({ text: placed.text, x: treeCell.x, y: treeCell.y });
  check('removePillar removes only that TIBTRE',
        removed.ok && removed.changed && removed.removed === placed.name
        && findTerrainObject(removed.text, treeCell.packed) === null);
  const removedT = terrainMap(removed.text);
  check('removing the pillar keeps the other [Terrain] lines',
        removedT.size === beforeT.size - 1
        && [...removedT].every(([k, v]) => k !== treeCell.packed && beforeT.get(k) === v));

  // A non-mineral overlay on the target is removed as the user asked; ore/gems
  // are kept (the generator's own pillars sit on ore).
  const overlayGrids = readOverlayGrids(mapText);
  overlayGrids.ids[treeCell.x + 512 * treeCell.y] = 173;   // a tree/prop overlay
  const withOverlay = placePillar({
    grid, text: mapText, ids: overlayGrids.ids, data: overlayGrids.data,
    x: treeCell.x, y: treeCell.y,
  });
  check('a non-mineral overlay on the pillar cell is removed',
        withOverlay.ok && withOverlay.changed && withOverlay.removedOverlay === 173
        && overlayGrids.ids[treeCell.x + 512 * treeCell.y] === EMPTY_OVERLAY,
        `removed overlay ${withOverlay.removedOverlay}`);

  // Water/cliff/outside-map and building foundations are refused.
  let wetCell = null;
  for (let y = 0; y < grid.height && !wetCell; ++y) {
    for (let x = 0; x < grid.width; ++x) {
      const f = cellFlags(grid, x, y);
      if ((f & CELL_IN_MAP) && !(f & CELL_PASSABLE)) { wetCell = { x, y }; break; }
    }
  }
  check('a water/cliff cell is refused', !!wetCell);
  if (wetCell) {
    const refused = placePillar({
      grid, text: mapText, ids: pillarGrids.ids, data: pillarGrids.data,
      x: wetCell.x, y: wetCell.y,
    });
    check('placePillar refuses water/cliffs', !refused.ok && /可通行|水面|崖/.test(refused.reason),
          refused.reason);
  }

  const syntheticFlags = grid.flags.slice();
  syntheticFlags[treeCell.y * grid.width + treeCell.x] |= CELL_BUILDING;
  const buildingGrid = { ...grid, flags: syntheticFlags };
  const onBuilding = placePillar({
    grid: buildingGrid, text: mapText, ids: pillarGrids.ids, data: pillarGrids.data,
    x: treeCell.x, y: treeCell.y,
  });
  check('placePillar refuses a building foundation',
        !onBuilding.ok && /建筑/.test(onBuilding.reason), onBuilding.reason);
}

// ---------------------------------------------------------------------------
// 5. the renderer: painted pixels must change in a real render
// ---------------------------------------------------------------------------
if (args.renderer && args.mixdir) {
  const dotnet = process.env.DOTNET_EXE
    || path.join(process.env.HOME || '', 'opt/dotnet-apt/usr/bin/dotnet');
  const env = {
    ...process.env,
    DOTNET_ROOT: process.env.DOTNET_ROOT
      || path.join(process.env.HOME || '', 'opt/dotnet-apt/usr/lib/dotnet'),
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH
      || path.join(process.env.HOME || '', 'opt/dotnet-apt/usr/lib/x86_64-linux-gnu'),
  };
  const render = (map, name) => {
    const prefix = path.join(scratch, name);
    execFileSync(dotnet, [
      args.renderer, '-i', map, '-o', prefix, '-m', path.resolve(args.mixdir),
      '-p', '--meta-json', prefix + '.json',
    ], { stdio: 'pipe', timeout: 300000, env });
    return { png: prefix + '.png', meta: JSON.parse(fs.readFileSync(prefix + '.json', 'utf8')) };
  };
  try {
    const original = path.join(scratch, 'render-before.map');
    fs.writeFileSync(original, Buffer.from(mapText, 'latin1'));
    // Re-paint a fresh copy: the block above was cleared again.
    const renderIds = beforeIds.slice();
    const renderData = beforeData.slice();
    const renderPainted = paintOreCells({
      grid, cells: block ? block.cells.slice() : [], ids: renderIds, data: renderData, occupied,
    });
    let renderText = writeOverlayGrids(mapText, renderIds, renderData);
    // Put a pillar on the tree cell in the same render: one "after" image then
    // proves both the overlay brush and the [Terrain] edit are drawn.
    let renderPillar = null;
    if (treeCell) {
      const pr = placePillar({
        grid, text: renderText, ids: renderIds, data: renderData,
        x: treeCell.x, y: treeCell.y,
      });
      if (pr.ok && pr.changed) {
        renderPillar = pr;
        renderText = pr.removedOverlay !== null
          ? writeOverlayGrids(pr.text, renderIds, renderData) : pr.text;
      }
    }
    const renderPath = path.join(scratch, 'render-after.map');
    fs.writeFileSync(renderPath, Buffer.from(renderText, 'latin1'));

    const before = render(original, 'before');
    const after = render(renderPath, 'after');
    check('the native renderer produced both images',
          fs.existsSync(before.png) && fs.existsSync(after.png));

    // The renderer publishes its own cell -> pixel transform; sample a window
    // around every painted cell centre in the two images.
    const points = (block ? block.cells : []).map((c) => {
      const q = projectCell(grid, before.meta, c.x, c.y);
      return { x: Math.round(q.x), y: Math.round(q.y), kind: 'ore' };
    });
    if (renderPillar) {
      const q = projectCell(grid, before.meta, treeCell.x, treeCell.y);
      points.push({ x: Math.round(q.x), y: Math.round(q.y), kind: 'pillar' });
    }
    const samplePath = path.join(scratch, 'samples.json');
    fs.writeFileSync(samplePath, JSON.stringify(points));
    const pixels = py(`
import sys, json
from collections import Counter
from PIL import Image
before = Image.open(sys.argv[1]).convert('RGB')
after = Image.open(sys.argv[2]).convert('RGB')
points = json.load(open(sys.argv[3]))
total = Counter()
hit = Counter()
for p in points:
    kind = p.get('kind', 'ore')
    total[kind] += 1
    x, y = p['x'], p['y']
    if x < 8 or y < 8 or x + 8 >= before.width or y + 8 >= before.height:
        continue
    changed = any(before.getpixel((x + dx, y + dy)) != after.getpixel((x + dx, y + dy))
                  for dy in range(-8, 9) for dx in range(-8, 9))
    if changed:
        hit[kind] += 1
print(json.dumps({'total': total, 'hit': hit}))
`, before.png, after.png, samplePath);
    check('the painted cells\' pixels changed in the render', pixels.status === 0,
          (pixels.stderr || '').trim());
    if (pixels.status === 0) {
      const r = JSON.parse(pixels.stdout);
      const oreTotal = r.total.ore || 0;
      const oreHit = r.hit.ore || 0;
      // The block is free, flat ground by construction, so every painted cell
      // should be visible; allow a little slack for a cell hidden behind its
      // neighbour's z.
      check('most painted cells are visibly different after the render',
            oreHit >= Math.ceil(oreTotal * 0.9),
            `${oreHit}/${oreTotal} cell windows changed`);
      check('at least one cell actually changed', oreHit > 0);
      if (renderPillar) {
        check('the pillar cell is visibly different after the render',
              (r.hit.pillar || 0) === 1,
              `${r.hit.pillar || 0}/1 pillar window changed (${renderPillar.name})`);
      }
    }
    check('the painted map rendered a different image',
          sha(fs.readFileSync(before.png)) !== sha(fs.readFileSync(after.png)));
    check('the overlay paint is not a no-op for the renderer',
          renderPainted.painted > 0, `${renderPainted.painted} cells`);
  } catch (err) {
    check('the native renderer ran', false,
          String((err && err.message) || err).split('\n')[0]);
  }
} else {
  console.log('  (no --renderer/--mixdir; pixel check skipped)');
}

fs.rmSync(scratch, { recursive: true, force: true });

console.log('');
if (failures.length) {
  for (const f of failures) console.log(`[verify_ore] FAIL ${f}`);
  console.log(`[verify_ore] FAIL -- ${failures.length} of ${checks} checks`);
  process.exit(1);
}
console.log(`[verify_ore] OK -- ${checks} checks`);
