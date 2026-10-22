// Contract test for the preview's start-point editor, run under node.
//
//   node tools/verify_starts.mjs --web build/engine-web-node --game /path/to/RA2MD
//
// Three separate things are on trial here, and each has exactly one source:
//
//   1. the ground grid the generator writes next to the map ("<out>.cells") --
//      it must describe the SAME map the file describes (every [Waypoints] cell
//      in-map and passable, dimensions equal to [Map] Width/Height);
//   2. the pixel <-> cell round trip in webapp/starts.js -- it inverts the
//      transform the renderer publishes, so projectCell followed by pickCell has
//      to return the cell it started from;
//   3. the [Waypoints] rewrite -- it must change that one number in that one
//      section and nothing else, including [Terrain]/[Structures] whose keys are
//      packed cells too.
//
// The engine is driven through the same API webapp/worker.js uses, with the two
// EM_JS hooks backed by this process's filesystem -- see verify_webapi.mjs, whose
// harness this borrows.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseCellGrid, pickCell, projectCell, rewriteWaypoint, readWaypoints,
  cellFlags, CELL_IN_MAP, CELL_PASSABLE,
} from '../webapp/starts.js';

function parseArgs(argv) {
  const out = { theater: 0, time: 0, land: 1, size: 1, players: 4, seed: 20260913 };
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
  console.error('usage: node tools/verify_starts.mjs --web <dir> --game <RA2 dir>');
  process.exit(2);
}
const webDir = path.resolve(args.web);
const gameDir = path.resolve(args.game);
for (const name of ['ra2.mix', 'ra2md.mix', 'expandmd01.mix']) {
  if (!fs.existsSync(path.join(gameDir, name))) {
    console.error(`missing ${name} in ${gameDir}`);
    process.exit(2);
  }
}

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

// ---- the two hooks worker.js installs -------------------------------------
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
  outputPath: Module.cwrap('mg_output_path', 'string', []),
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

const failures = [];
let checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(`${label} ${detail}`.trim());
};

// ---- 0. the shipped page must not carry node-only imports ----------------
if (args.product) {
  for (const name of ['app.js', 'worker.js', 'starts.js']) {
    const p = path.join(path.resolve(args.product), name);
    if (!fs.existsSync(p)) { check(`product has ${name}`, false, p); continue; }
    const text = fs.readFileSync(p, 'utf8');
    const bad = [];
    if (/from\s+['"]module['"]/.test(text)) bad.push("import from 'module'");
    if (/createRequire/.test(text)) bad.push('createRequire');
    check(`${name} is browser-safe`, bad.length === 0, bad.join(', '));
  }
}

// ---- 1. generate a map + its ground grid ---------------------------------
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
  console.log(`\n[verify_starts] FAIL -- ${failures.length} of ${checks} checks`);
  process.exit(1);
}

// ---- 2. the grid describes the same map the file does ---------------------
const mapText = new TextDecoder('latin1').decode(mapBytes);
const grid = parseCellGrid(gridBytes);
check('grid parses', !!grid, grid ? `${grid.width}x${grid.height}` : '');

// [Map] Size is the padded drawing rect (x, y, width, height); RA2 cell
// coordinates -- the ones [Waypoints] packs -- live in that padded diamond, so
// the grid is mapWidth + mapHeight a side, not Width x Height.
const sizeM = /^\s*Size\s*=\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/mi.exec(mapText);
const mapW = sizeM ? Number(sizeM[3]) : 0;
const mapH = sizeM ? Number(sizeM[4]) : 0;
check('[Map] Size read', mapW > 0 && mapH > 0, `${mapW}x${mapH}`);
check('grid side is the diamond side (mapWidth + mapHeight)',
      grid.width === mapW + mapH && grid.height === mapW + mapH,
      `grid ${grid.width}x${grid.height} vs ${mapW + mapH}`);

for (const w of readWaypoints(mapText)) {
  if (w.x >= grid.width || w.y >= grid.height) {
    check('waypoint inside the grid', false, `(${w.x}, ${w.y})`);
  }
}

const waypoints = readWaypoints(mapText);
check('[Waypoints] found', waypoints.length > 0, `${waypoints.length} entries`);
check('[Waypoints] count matches the player count',
      waypoints.length === args.players, `${waypoints.length} vs ${args.players}`);

let inMap = 0;
let passable = 0;
for (const w of waypoints) {
  const f = cellFlags(grid, w.x, w.y);
  if (f & CELL_IN_MAP) inMap++;
  if (f & CELL_PASSABLE) passable++;
}
check('every start cell is inside the map diamond', inMap === waypoints.length,
      `${inMap}/${waypoints.length}`);
check('every start cell is passable ground', passable === waypoints.length,
      `${passable}/${waypoints.length}`);

// ---- 3. pixel <-> cell round trip ---------------------------------------
// The transform is the renderer's own (see webapp/starts.js).  A cell can be
// hidden behind a taller one, so the assertion is not "same cell" in general --
// it is "the same diagonal AND the pixel lands inside the returned cell's
// diamond", which is exactly what picking means.  Start cells are chosen on
// cleared ground, so they are additionally required to round-trip exactly.
const meta = {
  tileWidth: 60,
  tileHeight: 30,
  // The renderer's FullSize is [Map] Size (MapFile.cs), and saveRect is a crop
  // of the drawing surface; zero here just shifts every pixel by the same
  // amount, which cannot change a round trip.
  fullSize: { width: mapW, height: mapH },
  saveRect: { x: 0, y: 0 },
};

let sameDiagonal = 0;
let insideDiamond = 0;
let sampled = 0;
for (let y = 0; y < grid.height; ++y) {
  for (let x = 0; x < grid.width; ++x) {
    if (!(cellFlags(grid, x, y) & CELL_IN_MAP)) continue;
    sampled++;
    const p = projectCell(grid, meta, x, y);
    const got = pickCell(grid, meta, p.x, p.y);
    if (!got) continue;
    if (got.x - got.y === x - y) sameDiagonal++;
    const g = projectCell(grid, meta, got.x, got.y);
    const tw = meta.tileWidth / 2;
    const th = meta.tileHeight / 2;
    if (Math.abs(p.x - g.x) / tw + Math.abs(p.y - g.y) / th <= 1 + 1e-9) insideDiamond++;
  }
}
check('every cell projects onto its own diagonal', sameDiagonal === sampled,
      `${sameDiagonal}/${sampled}`);
check('every cell projects into the cell pickCell returns', insideDiamond === sampled,
      `${insideDiamond}/${sampled}`);

let exact = 0;
for (const w of waypoints) {
  const p = projectCell(grid, meta, w.x, w.y);
  const got = pickCell(grid, meta, p.x, p.y);
  if (got && got.x === w.x && got.y === w.y) exact++;
}
check('every start cell round-trips exactly', exact === waypoints.length,
      `${exact}/${waypoints.length}`);

// A point in the far corner must not be mistaken for a cell.
const outside = pickCell(grid, meta, -100000, -100000);
check('a point off the map picks nothing', outside === null);

// ---- 4. the [Waypoints] rewrite touches one number -----------------------
const target = waypoints[0];
// Find a different passable, in-map, unoccupied cell to move it to.
let dest = null;
for (let y = 0; y < grid.height && !dest; ++y) {
  for (let x = 0; x < grid.width; ++x) {
    const f = cellFlags(grid, x, y);
    if (!(f & CELL_IN_MAP) || !(f & CELL_PASSABLE)) continue;
    if (waypoints.some((w) => w.x === x && w.y === y)) continue;
    dest = { x, y };
    break;
  }
}
check('a free passable cell exists to move a start to', !!dest,
      dest ? `(${dest.x}, ${dest.y})` : '');

if (dest) {
  const moved = rewriteWaypoint(mapText, target.number, dest.x, dest.y);
  check('rewriteWaypoint returns text', typeof moved === 'string');
  const after = readWaypoints(moved);
  const got = after.find((w) => w.number === target.number);
  check('the moved start reads back at its new cell',
        !!got && got.x === dest.x && got.y === dest.y,
        got ? `(${got.x}, ${got.y})` : 'missing');

  // Byte-for-byte: only the edited line may differ.
  const before = mapText.split('\n');
  const afterLines = moved.split('\n');
  check('the rewrite keeps the line count', before.length === afterLines.length,
        `${before.length} -> ${afterLines.length}`);
  let diff = 0;
  let onlyTarget = true;
  for (let i = 0; i < before.length && i < afterLines.length; ++i) {
    if (before[i] === afterLines[i]) continue;
    diff++;
    const m = /^\s*(\d+)\s*=/.exec(before[i]);
    if (!m || Number(m[1]) !== target.number) onlyTarget = false;
  }
  check('exactly one line changed', diff === 1, `${diff} line(s)`);
  check('the changed line is the target waypoint', onlyTarget);

  // The packed cell is what the writer and FA2 both use.  Read it from the
  // [Waypoints] block only -- [Terrain] and [Structures] keys are packed cells
  // too, and a whole-file search would happily find one of those.
  const wpBlock = (/\[Waypoints\]([\s\S]*?)(?=\n\[|$)/i.exec(moved) || [])[1] || '';
  const packedLine = wpBlock.split('\n')
    .map((l) => l.trim())
    .find((l) => /^\d+\s*=/.test(l) && Number(l.split('=')[0]) === target.number);
  const packed = packedLine ? Number(packedLine.split('=')[1]) : NaN;
  check('the packed cell is X + 1000 * Y', packed === dest.x + 1000 * dest.y,
        `${packed} vs ${dest.x + 1000 * dest.y}`);

  check('an absent waypoint changes nothing', rewriteWaypoint(mapText, 77, dest.x, dest.y) === null);
}

// ---- 5. the transform agrees with the RENDERER, not just with itself ------
// The round trip above only proves starts.js is self-consistent.  This stage
// checks it against the thing that actually drew the picture: the native
// renderer publishes its own cell -> pixel numbers (--meta-json) and its own
// per-cell heights (--debug-tiles).  Optional, because it needs a dotnet build
// and a loose game tree; verify_all.sh passes both when it has them.
if (args.renderer && args.mixdir) {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-starts-'));
  const mapPath = path.join(scratch, 'probe.map');
  const metaPath = path.join(scratch, 'probe.json');
  const tilesPath = path.join(scratch, 'tiles.csv');
  fs.writeFileSync(mapPath, Buffer.from(mapBytes));
  try {
    const dotnet = process.env.DOTNET_EXE
      || path.join(process.env.HOME || '', 'opt/dotnet-apt/usr/bin/dotnet');
    execFileSync(dotnet, [
      args.renderer, '-i', mapPath,
      '-o', path.join(scratch, 'probe'),
      '-m', args.mixdir, '-p',
      '--meta-json', metaPath,
      '--debug-tiles', tilesPath,
      '--mark-start-pos',
    ], { stdio: 'pipe', timeout: 300000 });
    check('the native renderer ran', true);
    const rmeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    let projOk = 0;
    for (const sp of rmeta.startPositionPixels || []) {
      const p = projectCell(grid, rmeta, sp.cell.x, sp.cell.y);
      if (Math.round(p.x) === sp.pixel.x && Math.round(p.y) === sp.pixel.y) projOk++;
    }
    const starts = (rmeta.startPositionPixels || []).length;
    check('projectCell reproduces the renderer\'s own start pixels', projOk === starts,
          `${projOk}/${starts}`);

    let pickOk = 0;
    for (const sp of rmeta.startPositionPixels || []) {
      const c = pickCell(grid, rmeta, sp.pixel.x, sp.pixel.y);
      if (c && c.x === sp.cell.x && c.y === sp.cell.y) pickOk++;
    }
    check('pickCell inverts the renderer\'s own start pixels', pickOk === starts,
          `${pickOk}/${starts}`);

    // The height the projection needs must be the height the renderer drew.
    const rows = fs.readFileSync(tilesPath, 'utf8').trim().split('\n');
    const head = rows[0].split(',');
    const ix = head.indexOf('rx');
    const iy = head.indexOf('ry');
    const iz = head.indexOf('z');
    let agree = 0;
    let differ = 0;
    if (ix >= 0 && iy >= 0 && iz >= 0) {
      for (const row of rows.slice(1)) {
        const f = row.split(',');
        const rx = Number(f[ix]);
        const ry = Number(f[iy]);
        if (rx < 0 || ry < 0 || rx >= grid.width || ry >= grid.height) continue;
        if (grid.level[ry * grid.width + rx] === Number(f[iz])) agree++;
        else differ++;
      }
    }
    check('the generator\'s cell heights match the renderer\'s', differ === 0 && agree > 0,
          `${agree} agree, ${differ} differ`);
  } catch (err) {
    check('the native renderer ran', false,
          String((err && err.message) || err).split('\n')[0]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

console.log('');
if (failures.length) {
  for (const f of failures) console.log(`[verify_starts] FAIL ${f}`);
  console.log(`[verify_starts] FAIL -- ${failures.length} of ${checks} checks`);
  process.exit(1);
}
console.log(`[verify_starts] OK -- ${checks} checks`);
