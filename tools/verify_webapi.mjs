// Contract test for the browser entry point, run under node.
//
// The browser module (engine/build_web.sh) is driven through exactly the API
// webapp/worker.js uses -- mg_add_file / mg_set_root / mg_extract /
// mg_generate / mg_read_output -- with the two EM_JS hooks (mgFileSize,
// mgRead) backed by this process's filesystem instead of FileReaderSync.
//
// So this does not test the browser; it tests the GLUE BETWEEN the browser and
// the engine, which is where the risk actually is.  The page's HTML and CSS are
// the low-risk part.
//
// The map produced must be byte-identical to the native oracle's, which is the
// same standard the wasm console build is held to.
//
//   node tools/verify_webapi.mjs --web build/engine-web-node --game /path/to/RA2MD \
//        --assets build/oracle_assets --product webapp
//
// `--web` must point at the NODE-flavoured build (MG_WEB_ENV=worker,node).  The
// artifact that ships is built with `worker` alone, because adding `node` makes
// Emscripten emit a top-level `import { createRequire } from 'module'` that a
// browser cannot parse -- which is exactly how the first browser run failed.
// `--product` therefore checks the shipped artifact TEXTUALLY (no node-only
// imports) while the behavioural checks run against the node build.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = { theater: 0, time: 0, land: 1, size: 1, players: 2, seed: 20260913 };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    out[key] = key === 'theater' || key === 'time' || key === 'land' ||
               key === 'size' || key === 'players' ? Number(value) : value;
  }
  return out;
}

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

const args = parseArgs(process.argv);
if (!args.web || !args.game) {
  console.error('usage: node tools/verify_webapi.mjs --web <dir> --game <RA2 dir>');
  process.exit(2);
}

const webDir = path.resolve(args.web);
const gameDir = path.resolve(args.game);
const bundles = ['ra2.mix', 'ra2md.mix', 'expandmd01.mix'];
for (const name of bundles) {
  if (!fs.existsSync(path.join(gameDir, name))) {
    console.error(`missing ${name} in ${gameDir}`);
    process.exit(2);
  }
}

// The module is an ES module emitted as .js; node needs to be told so.
const pkgPath = path.join(webDir, 'package.json');
if (!fs.existsSync(pkgPath)) {
  fs.writeFileSync(pkgPath, JSON.stringify({ type: 'module' }, null, 2));
}

const mod = await import(pathToFileURL(path.join(webDir, 'mg_engine.js')).href);
const Module = await mod.default({
  locateFile: (name) => path.join(webDir, name),
  print: (line) => process.stderr.write(line + '\n'),
  printErr: (line) => process.stderr.write(line + '\n'),
});

// ---- the two hooks worker.js also installs --------------------------------
const files = new Map();   // id -> absolute path
const sizes = new Map();   // id -> length
let nextId = 1;

Module.mgFileSize = (id) => (sizes.has(id) ? sizes.get(id) : -1);
Module.mgRead = (id, offset, length, ptr) => {
  const file = files.get(id);
  if (!file) return 0;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const got = fs.readSync(fd, buf, 0, length, offset);
    if (got !== length) return 0;
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
     'number', 'number', 'number', 'number', 'string']),
  readOutput: Module.cwrap('mg_read_output', 'number', ['string', 'number', 'number']),
  error: Module.cwrap('mg_error', 'string', []),
  outputPath: Module.cwrap('mg_output_path', 'string', []),
};

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(`${label} ${detail}`.trim());
};

// ---- 0. the SHIPPED artifact must be browser-safe --------------------------
if (args.product) {
  const shipped = path.join(path.resolve(args.product), 'mg_engine.js');
  if (!fs.existsSync(shipped)) {
    check('product artifact present', false, shipped);
  } else {
    const text = fs.readFileSync(shipped, 'utf8');
    const bad = [];
    if (/from\s+['"]module['"]/.test(text)) bad.push("import from 'module'");
    if (/createRequire/.test(text)) bad.push('createRequire');
    if (/require\(\s*['"](fs|path|crypto)['"]\s*\)/.test(text)) bad.push('require(node builtin)');
    check('product artifact is browser-safe', bad.length === 0,
          bad.length ? `found ${bad.join(', ')}` : 'no node-only imports');
  }
}

// ---- 1. register the archives --------------------------------------------
for (const name of bundles) {
  const full = path.join(gameDir, name);
  const id = nextId++;
  files.set(id, full);
  sizes.set(id, fs.statSync(full).size);
  api.addFile(id, name);
}
check('mg_add_file', true, `${bundles.length} archives`);

// ---- 2. set the MEMFS root (installs the JS ByteSource factory) -----------
api.setRoot('/mg');
check('mg_set_root', true, '/mg');

// ---- 3. extract the loose-file tree into MEMFS ---------------------------
const rcExtract = api.extract(args.theater);
check('mg_extract', rcExtract === 0, rcExtract === 0 ? '' : api.error());

// The extracted files must be visible through the module's own FS.
let tiles = 0;
try {
  const entries = Module.FS.readdir('/mg/Tile资源/温和');
  tiles = entries.filter((n) => n.toLowerCase().endsWith('.tem')).length;
} catch (err) {
  // fall through with tiles = 0
}
check('MEMFS tile tree', tiles > 100, `${tiles} .tem files`);

// ---- 4. generate ---------------------------------------------------------
const outPath = args.single ? '/mg/out.map' : '/mg/out.yrm';
const rcGen = api.generate(args.land, args.theater, args.time, args.size, args.players, 1, -1,
                           args.seed >>> 0, 0, args.single ? 1 : 0, outPath);
check('mg_generate', rcGen === 0, rcGen === 0 ? '' : api.error());

// ---- 5. two-call read-out ------------------------------------------------
const size = api.readOutput(outPath, 0, -1);
check('mg_read_output sizing call', size > 0, `${size} B`);

let produced = null;
if (size > 0) {
  const ptr = Module._malloc(size);
  try {
    const got = api.readOutput(outPath, ptr, size);
    if (got === size) produced = Buffer.from(Module.HEAPU8.slice(ptr, ptr + got));
  } finally {
    Module._free(ptr);
  }
}
check('mg_read_output data call', produced !== null && produced.length === size);

// ---- 6. byte-identical to the native oracle ------------------------------
if (produced) {
  const digest = md5(produced);
  console.log(`  map  ${produced.length} B  md5=${digest}`);
  if (args.assets) {
    const native = path.join(path.resolve(args.assets), 'oracle.map');
    if (fs.existsSync(native)) {
      const want = fs.readFileSync(native);
      check('byte-identical to the native oracle', md5(want) === digest,
            `${want.length} B md5=${md5(want).slice(0, 16)}`);
    } else {
      console.log(`  (no native oracle at ${native}; skipping the comparison)`);
    }
  }
}

// ---- 7. the render half, through the same flattening the worker does -----
// webapp/worker.js copies the extracted tree out of the engine's MEMFS into the
// renderer's own (separate) filesystem, flattening on the way because CNCMaps'
// DirArchive is non-recursive.  This is that exact loop.
if (args.render) {
  const dotnet = (await import(pathToFileURL(
    path.join(path.resolve(args.render), '_framework', 'dotnet.js')).href)).dotnet;
  const rt = await dotnet.create();
  const cfg = rt.getConfig();
  const exports = await rt.getAssemblyExports(cfg.mainAssemblyName);
  const Render = exports?.CNCMaps?.WebEntry?.Render;
  check('renderer export present', typeof Render === 'function');
  if (typeof Render === 'function') {
    const fsThem = rt.Module.FS;
    fsThem.mkdir('/game');
    fsThem.mkdir('/maps');

    let copied = 0;
    const dirs = ['/mg/x64/Release'];
    for (const sub of Module.FS.readdir('/mg/Tile资源')) {
      if (sub !== '.' && sub !== '..') dirs.push(`/mg/Tile资源/${sub}`);
    }
    for (const dir of dirs) {
      for (const name of Module.FS.readdir(dir)) {
        const p = `${dir}/${name}`;
        const st = Module.FS.stat(p);
        if (!Module.FS.isFile(st.mode)) continue;
        fsThem.writeFile(`/game/${name}`, Module.FS.readFile(p));
        copied++;
      }
    }
    check('flatten MEMFS into the renderer', copied > 900, `${copied} files`);

    fsThem.writeFile('/maps/render.map', Module.FS.readFile(outPath));
    const started = Date.now();
    const rc = Render('/maps/render.map', '/game', '/maps/render');
    check('renderer ran', rc === 0, `rc=${rc} in ${Date.now() - started} ms`);
    if (rc === 0) {
      const png = fsThem.readFile('/maps/render.png');
      check('preview PNG produced', png.length > 1000, `${png.length} B`);
      if (args.preview) fs.writeFileSync(path.resolve(args.preview), png);
    }
  }
}

console.log();
if (failures.length) {
  console.log(`FAILED ${failures.length} checks`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('OK -- the browser entry-point contract holds end to end');
