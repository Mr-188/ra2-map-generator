// Contract test for the preview's neutral-tech-building brush, run under node.
//
//   node tools/verify_buildings.mjs --web build/engine-web-node --game <RA2 dir>
//        --product webapp [--mgextract build/engine/mgextract \
//                          --renderer <CNCMaps.Renderer.dll>]
//
// What it pins:
//   1. placement rules against the generator's own sidecar: in-map, passable,
//      flat foundation, no existing building; water/cliffs/buildings/out-of-map
//      are refused with a reason;
//   2. the map edit: one [Structures] line per building in the writer's exact
//      shape, owner Neutral (multiplayer) / Neutral House (single-player),
//      overlays and [Terrain] objects under the foundation cleared, every other
//      section byte-identical;
//   3. the renderer: with only the extracted loose tree (what the page actually
//      hands the renderer), the three placed buildings change pixels in a fresh
//      render -- the tree now carries their SHP/VXL art.
//
// The engine is driven through the same API webapp/worker.js uses; the harness
// is the one verify_webapi.mjs / verify_ore.mjs use.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

import {
  parseCellGrid, projectCell, cellFlags, CELL_IN_MAP, CELL_PASSABLE, CELL_BUILDING,
} from '../webapp/starts.js';
import {
  readOverlayGrids, writeOverlayGrids, setTerrainObject,
  EMPTY_OVERLAY,
} from '../webapp/ore.js';
import {
  BUILDING_TYPES, buildingType, describeBuildingPlacement, placeBuilding,
  readStructures, structureOccupiedCells,
} from '../webapp/buildings.js';

function parseArgs(argv) {
  const out = { theater: 0, time: 0, land: 1, size: 1, players: 4, seed: 2 };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    out[key] = ['theater', 'time', 'land', 'size', 'players', 'seed'].includes(key)
      ? Number(value) : value;
  }
  return out;
}
const args = parseArgs(process.argv);
if (!args.web || !args.game) {
  console.error('usage: node tools/verify_buildings.mjs --web <dir> --game <RA2 dir> '
    + '[--product webapp] [--mgextract <path> --renderer <dll>]');
  process.exit(2);
}
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
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

// ---- 0. shipped page must be browser-safe --------------------------------
if (args.product) {
  for (const name of ['app.js', 'worker.js', 'starts.js', 'ore.js', 'buildings.js']) {
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

// ---- 1. the engine harness ----------------------------------------------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-buildings-'));
const pkgPath = path.join(webDir, 'package.json');
if (!fs.existsSync(pkgPath)) fs.writeFileSync(pkgPath, JSON.stringify({ type: 'module' }, null, 2));
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
check('mg_extract', api.extract(args.theater) === 0, api.error());

function generate(out, single) {
  const rc = api.generate(args.land, args.theater, args.time, args.size, args.players,
                          1, -1, args.seed >>> 0, 0, single ? 1 : 0, 0, 0, 0, out);
  if (rc !== 0) return null;
  const bytes = readOut(out);
  const cells = readOut(out + '.cells');
  if (!bytes || !cells) return null;
  return {
    bytes, cells,
    text: new TextDecoder('latin1').decode(bytes),
    grid: parseCellGrid(cells),
  };
}

const base = generate('/mg/multi.map', false);
check('mg_generate (multiplayer)', !!base);
if (!base) {
  console.log(`\n[verify_buildings] FAIL -- ${failures.length} of ${checks} checks`);
  process.exit(1);
}
const grid = base.grid;
let text = base.text;
let grids = readOverlayGrids(text);
check('the map has overlay grids', !!grids);

// ---- 2. place the three buildings ---------------------------------------
function findSpot(type, currentText, avoid) {
  for (let y = 2; y < grid.height - type.height - 2; y += 2) {
    for (let x = 2; x < grid.width - type.width - 2; x += 2) {
      if (avoid.some((p) => Math.abs(p.x - x) < 10 && Math.abs(p.y - y) < 10)) continue;
      const occupied = structureOccupiedCells(currentText);
      if (describeBuildingPlacement({ grid, type, x, y, occupied }).ok) return { x, y };
    }
  }
  return null;
}

const placed = [];
// Seed the first foundation with an overlay and a tree, so "别的都去掉" is
// exercised on the real map rather than only in a synthetic branch.
const firstType = BUILDING_TYPES[0];
const firstSpot = findSpot(firstType, text, []);
check('a spot exists for the oil derrick', !!firstSpot,
      firstSpot ? `(${firstSpot.x}, ${firstSpot.y})` : 'none');
if (firstSpot) {
  const idx = firstSpot.x + 512 * firstSpot.y;
  grids.ids[idx] = 105;                       // ore
  grids.data[idx] = 0;
  text = setTerrainObject(text, 1000 * (firstSpot.y + 1) + (firstSpot.x + 1), 'TREE24');
  const structures = structureOccupiedCells(text);
  const res = placeBuilding({
    grid, text, ids: grids.ids, data: grids.data, type: firstType,
    x: firstSpot.x, y: firstSpot.y, occupied: structures,
  });
  check('placeBuilding places the oil derrick', res.ok, res.reason || '');
  check('the foundation overlay is cleared', res.ok && grids.ids[idx] === EMPTY_OVERLAY,
        res.ok ? `cleared ${res.clearedOverlays} overlay(s)` : '');
  check('the tree on the foundation is removed', res.ok && res.removedObjects.includes('TREE24'),
        res.ok ? res.removedObjects.join(',') : '');
  if (res.ok) { text = res.text; placed.push({ type: firstType, ...firstSpot, res }); }
}

for (const type of BUILDING_TYPES.slice(1)) {
  const spot = findSpot(type, text, placed);
  check(`a spot exists for ${type.id}`, !!spot, spot ? `(${spot.x}, ${spot.y})` : 'none');
  if (!spot) continue;
  const structures = structureOccupiedCells(text);
  const res = placeBuilding({
    grid, text, ids: grids.ids, data: grids.data, type,
    x: spot.x, y: spot.y, occupied: structures,
  });
  check(`placeBuilding places ${type.id}`, res.ok, res.reason || '');
  if (res.ok) { text = res.text; placed.push({ type, ...spot, res }); }
}
check('all three buildings were placed', placed.length === 3,
      placed.map((p) => `${p.type.id}@${p.x},${p.y}`).join(' '));

const finalText = writeOverlayGrids(text, grids.ids, grids.data);
const structs = readStructures(finalText);
for (const p of placed) {
  const got = structs.find((s) => s.type === p.type.id && s.x === p.x && s.y === p.y);
  check(`${p.type.id} has a [Structures] entry at its cell`, !!got,
        got ? `#${got.index}` : 'missing');
  if (got) {
    check(`${p.type.id} is owned by Neutral and has the writer's 17 fields`,
          got.owner === 'Neutral' && got.fields.length === 17 && got.health === 256,
          `${got.owner},${got.type},${got.health} fields=${got.fields.length}`);
  }
}
check('the [Structures] indices are unique',
      new Set(structs.map((s) => s.index)).size === structs.length,
      `${structs.length} entries`);
check('the existing generated buildings survived',
      structs.some((s) => s.type === 'CATHOSP') && structs.some((s) => s.type === 'CAAIRP'),
      structs.map((s) => s.type).join(','));

// ---- 3. refusal rules ----------------------------------------------------
const water = (() => {
  for (let y = 0; y < grid.height; ++y) {
    for (let x = 0; x < grid.width; ++x) {
      const f = cellFlags(grid, x, y);
      if ((f & CELL_IN_MAP) && !(f & CELL_PASSABLE)) return { x, y };
    }
  }
  return null;
})();
check('a water/cliff cell exists to test against', !!water);
if (water) {
  const type = buildingType('CAOILD');
  const occupied = structureOccupiedCells(text);
  const info = describeBuildingPlacement({ grid, type, x: water.x, y: water.y, occupied });
  check('water/cliffs are refused', !info.ok && /可通行|水面|崖/.test(info.reason), info.reason);
}
const building = (() => {
  for (let y = 0; y < grid.height; ++y) {
    for (let x = 0; x < grid.width; ++x) {
      if (cellFlags(grid, x, y) & CELL_BUILDING) return { x, y };
    }
  }
  return null;
})();
check('an existing building cell exists to test against', !!building);
if (building) {
  const type = buildingType('CAOILD');
  const occupied = structureOccupiedCells(text);
  const info = describeBuildingPlacement({ grid, type, x: building.x, y: building.y, occupied });
  check('an existing building is refused', !info.ok && /建筑/.test(info.reason), info.reason);
}
{
  const type = buildingType('CAOILD');
  const info = describeBuildingPlacement({
    grid, type, x: grid.width - 1, y: grid.height - 1,
    occupied: structureOccupiedCells(text),
  });
  check('a foundation outside the diamond is refused', !info.ok && /出了地图/.test(info.reason),
        info.reason);
}
{
  // One foundation cell raised by one level: the engine's own Level grid.
  const p = placed[0];
  if (p) {
    const flags = grid.flags.slice();
    const levels = grid.level.slice();
    levels[(p.y + 1) * grid.width + (p.x + 1)] += 1;
    const synthetic = { ...grid, flags, level: levels };
    // The map text already carries this building; leave the [Structures]
    // occupancy out so the height check is what refuses it.
    const info = describeBuildingPlacement({
      grid: synthetic, type: p.type, x: p.x, y: p.y, occupied: new Set(),
    });
    check('a sloped foundation is refused', !info.ok && /地基不平/.test(info.reason), info.reason);
  }
}
{
  const p = placed[0];
  if (p) {
    const again = placeBuilding({
      grid, text, ids: grids.ids, data: grids.data, type: p.type,
      x: p.x, y: p.y, occupied: structureOccupiedCells(text),
    });
    check('placing on top of a just-placed building is refused',
          !again.ok && /建筑/.test(again.reason), again.reason);
  }
}

// ---- 4. the Python map-format oracle ------------------------------------
const finalPath = path.join(scratch, 'placed.map');
const basePath = path.join(scratch, 'base.map');
fs.writeFileSync(finalPath, Buffer.from(finalText, 'latin1'));
const baseText = (() => {
  // The base map is the generated text before any of our edits.  For the
  // section comparison only; rendering below uses the pre-placement state.
  return base.text;
})();
fs.writeFileSync(basePath, Buffer.from(baseText, 'latin1'));
const py = spawnSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(ROOT)})
from maptools import map_ini
def sections(p):
    return map_ini.read_sections(open(p, 'rb').read().decode('latin1'))
a = sections(sys.argv[1]); b = sections(sys.argv[2])
changed = []
for (na, la), (nb, lb) in zip(a, b):
    if na != nb: changed.append(('section-order', na, nb)); continue
    if la != lb: changed.append(na)
print(json.dumps({
  'changed': changed,
  'structures': [l for n, lines in b if n == 'Structures' for l in lines if '=' in l],
}))
`, basePath, finalPath], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: ROOT } });
check('the Python oracle parses the placed map', py.status === 0, (py.stderr || '').trim());
if (py.status === 0) {
  const o = JSON.parse(py.stdout);
  const allowed = new Set(['OverlayPack', 'OverlayDataPack', 'Terrain', 'Structures']);
  check('only the sections the brush edits changed',
        o.changed.every((c) => typeof c === 'string' && allowed.has(c)),
        JSON.stringify(o.changed));
  check('the oracle sees all five structures', o.structures.length === 5,
        `${o.structures.length} lines`);
}

// ---- 5. single-player owner ---------------------------------------------
{
  const sp = generate('/mg/single.map', true);
  check('mg_generate (single player)', !!sp);
  if (sp) {
    const sgrid = sp.grid;
    const sgrids = readOverlayGrids(sp.text);
    let spot = null;
    for (let y = 2; y < sgrid.height - 4 && !spot; y += 2) {
      for (let x = 2; x < sgrid.width - 4 && !spot; x += 2) {
        const info = describeBuildingPlacement({
          grid: sgrid, type: buildingType('CAOILD'), x, y,
          occupied: structureOccupiedCells(sp.text),
        });
        if (info.ok) spot = { x, y };
      }
    }
    check('a single-player spot exists', !!spot);
    if (spot) {
      const res = placeBuilding({
        grid: sgrid, text: sp.text, ids: sgrids.ids, data: sgrids.data,
        type: buildingType('CAOILD'), x: spot.x, y: spot.y,
        occupied: structureOccupiedCells(sp.text),
      });
      check('single-player maps use the Neutral House owner',
            res.ok && res.owner === 'Neutral House', res.ok ? res.owner : res.reason);
    }
  }
}

// ---- 6. the renderer draws the placed buildings -------------------------
if (args.renderer && args.mgextract) {
  const dotnet = process.env.DOTNET_EXE
    || path.join(process.env.HOME || '', 'opt/dotnet-apt/usr/bin/dotnet');
  const renderEnv = {
    ...process.env,
    DOTNET_ROOT: process.env.DOTNET_ROOT
      || path.join(process.env.HOME || '', 'opt/dotnet-apt/usr/lib/dotnet'),
    LD_LIBRARY_PATH: process.env.LIBRARY_PATH
      || path.join(process.env.HOME || '', 'opt/dotnet-apt/usr/lib/x86_64-linux-gnu'),
  };
  const render = (mapPath, name) => {
    const prefix = path.join(scratch, name);
    execFileSync(dotnet, [
      args.renderer, '-i', mapPath, '-o', prefix, '-m', flatDir,
      '-p', '--meta-json', prefix + '.json', '--debug-tiles', prefix + '.tiles.csv',
    ], { stdio: 'pipe', timeout: 300000, env: renderEnv });
    return { png: prefix + '.png', meta: JSON.parse(fs.readFileSync(prefix + '.json', 'utf8')),
             tiles: prefix + '.tiles.csv' };
  };

  // Build the loose tree exactly the page does, from this game directory.
  const extractDir = path.join(scratch, 'extract');
  execFileSync(process.env.MGEXTRACT || args.mgextract,
    ['--game-dir', gameDir, '--out', extractDir, '--theater', String(args.theater)],
    { stdio: 'pipe', timeout: 300000 });
  const flatDir = path.join(scratch, 'flat');
  fs.mkdirSync(flatDir, { recursive: true });
  let copied = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { fs.copyFileSync(p, path.join(flatDir, e.name)); copied++; }
    }
  };
  walk(extractDir);
  check('the extracted tree contains the building art',
        ['CTOILD.shp', 'CGMACH.shp', 'CTOUTP.shp', 'OUTP.vxl']
          .every((n) => fs.existsSync(path.join(flatDir, n))),
        `${copied} files`);
  try {
    const before = render(basePath, 'before');
    const after = render(finalPath, 'after');
    check('the native renderer produced both images',
          fs.existsSync(before.png) && fs.existsSync(after.png));

    // The renderer's own cell -> pixel transform; its per-cell height is the
    // sidecar's Level (verify_starts checks those agree on 13005/13005 cells).
    const points = placed.map((p) => {
      const q = projectCell(grid, before.meta, p.x, p.y);
      return { x: Math.round(q.x), y: Math.round(q.y), type: p.type.id };
    });
    const samplePath = path.join(scratch, 'points.json');
    fs.writeFileSync(samplePath, JSON.stringify(points));
    const pixels = spawnSync('python3', ['-c', `
import sys, json
from PIL import Image
a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
pts = json.load(open(sys.argv[3]))
out = {}
for p in pts:
    x, y = p['x'], p['y']
    if x < 12 or y < 12 or x + 12 >= a.width or y + 12 >= a.height:
        out[p['type']] = None; continue
    out[p['type']] = sum(1 for dy in range(-12, 13) for dx in range(-12, 13)
                         if a.getpixel((x + dx, y + dy)) != b.getpixel((x + dx, y + dy)))
print(json.dumps(out))
`, before.png, after.png, samplePath], { encoding: 'utf8' });
    check('the pixel sampler ran', pixels.status === 0, (pixels.stderr || '').trim());
    if (pixels.status === 0) {
      const r = JSON.parse(pixels.stdout);
      for (const p of placed) {
        check(`${p.type.id} is drawn by the extracted tree`,
              (r[p.type.id] || 0) > 50, `${r[p.type.id] || 0} changed pixels`);
      }
    }
  } catch (err) {
    check('the native renderer ran', false,
          String((err && err.message) || err).split('\n')[0]);
  }
} else {
  console.log('  (no --renderer/--mgextract; pixel check skipped)');
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log('');
if (failures.length) {
  for (const f of failures) console.log(`[verify_buildings] FAIL ${f}`);
  console.log(`[verify_buildings] FAIL -- ${failures.length} of ${checks} checks`);
  process.exit(1);
}
console.log(`[verify_buildings] OK -- ${checks} checks`);
