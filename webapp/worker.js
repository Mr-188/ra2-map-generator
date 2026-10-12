// Worker host for the wasm engine.
//
// It lives in a Worker for one hard reason: the engine's ByteSource::read is
// synchronous, and the only synchronous way to read a picked File is
// FileReaderSync -- which exists in workers and nowhere else.  The alternative
// (copying ra2.mix, 269 MB, into MEMFS) is not viable.
//
// Files are never uploaded anywhere.  They are read in this worker, sliced on
// demand, and the extracted loose-file tree the generator reads lives in MEMFS.
//
// ---------------------------------------------------------------------------
// This MUST be a CLASSIC worker, not a module worker, even though everything it
// loads is an ES module.
//
// The .NET runtime works out what kind of host it is in with
// `typeof importScripts === "function"` -- and importScripts does not exist in a
// module worker.  It then falls through to "no window, no worker", decides it is
// an unknown shell environment, and startup stalls forever with no error at all.
// A classic worker restores the detection; the ES modules are still reachable
// because dynamic import() works in classic workers.
//
// Consequence: no static `import` statements in this file.  See boot().
// ---------------------------------------------------------------------------

const readers = new FileReaderSync();
/** @type {Map<number, File>} */
const files = new Map();
let nextId = 1;
let Module = null;
let engine = null;   // cwrapped entry points

function fail(message) {
  self.postMessage({ type: 'error', message });
}

// The .NET runtime and Emscripten write their diagnostics to console.*, which is
// invisible unless devtools is open.  Mirror it into the page's log panel: a
// stall with no message is impossible to diagnose from the outside.
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...parts) => {
    try {
      self.postMessage({ type: 'log', line: `[${level}] ${parts.join(' ')}` });
    } catch (err) { /* posting must never be what breaks the run */ }
    original(...parts);
  };
}

function mark(text) {
  self.postMessage({ type: 'log', line: `-- ${text}` });
}

// The single most useful line in this file.  The .NET runtime decides what kind
// of host it is in with `typeof importScripts`; reporting the same value here
// says whether the page really gave us a classic worker, and that the worker ran
// at all.
mark(`worker: classic=${typeof importScripts === 'function'} ` +
     `window=${typeof window} FileReaderSync=${typeof FileReaderSync}`);

// ---- handing the extracted tree to the main thread ------------------------
// Rendering happens on the MAIN THREAD, not here.  The .NET runtime works out
// what host it is in with `typeof importScripts` / `typeof window`, and inside a
// worker it kept deciding it was an unknown shell environment and stalling in
// dotnet.create() with no error at all -- in a module worker and in a classic
// one alike.  On the main thread `window` exists, the detection is unambiguous,
// and there is no second filesystem to copy into.
//
// So this worker only generates.  It hands the extracted tree over on request.
const RENDER_DIRS = ['/mg/x64/Release'];

function assetDirs() {
  const dirs = RENDER_DIRS.slice();
  try {
    for (const sub of Module.FS.readdir('/mg/Tile资源')) {
      if (sub !== '.' && sub !== '..') dirs.push(`/mg/Tile资源/${sub}`);
    }
  } catch (err) { /* not extracted yet */ }
  return dirs;
}

/** FNV-1a over a byte array: what the diagnostics compare trees by.  Sizes alone
 *  are not enough - a packing bug can keep every size identical. */
function checksum(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; ++i) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Every regular file under the extracted tree, as { name, bytes }. */
function collectAssets() {
  const out = [];
  for (const dir of assetDirs()) {
    let names;
    try { names = Module.FS.readdir(dir); } catch (err) { continue; }
    for (const name of names) {
      const p = `${dir}/${name}`;
      try {
        if (!Module.FS.isFile(Module.FS.stat(p).mode)) continue;
        out.push({ name, bytes: Module.FS.readFile(p) });
      } catch (err) { /* skip */ }
    }
  }
  return out;
}

// ---- the extracted tree, cached in the browser's own storage (OPFS) --------
//
// Re-reading the player's ~470 MB of archives on every visit is not just slow: the
// File System Access permission does not survive a browser restart, so the page has
// to ask again ("继续使用 RA2MD") every time, and that prompt cannot be skipped --
// requestPermission() must run inside a user gesture.
//
// The extracted tree is only ~13 MB / ~970 files, so the second visit does not need
// the game directory at all: after the first extraction the tree is written here and
// rehydrated from OPFS on boot.  No directory, no permission, no click.  The cache is
// per theatre (the tiles and the theatre INI differ) and can be cleared.
const CACHE_DIR = 'ra2-rmg-assets';
// v2: ONE cache for the whole extracted tree, covering every theatre that was
// extracted into it (temperate AND snow), instead of one file per theatre.  A per
// theatre cache meant "roll the theatre and you may have to pick the folder again",
// which is exactly the freedom 随机 in the 剧场 row is supposed to give.  v1 files are
// removed on the next save.
const CACHE_VERSION = 2;
const CACHE_BIN = 'assets.bin';
const CACHE_JSON = 'assets.json';
// The theatres whose assets have been extracted into the CURRENT MEMFS tree.  The
// tree accumulates (mg_extract only adds), so this is a union, and the manifest
// records it: the page needs to know whether the map it is about to make is covered.
const extractedTheaters = new Set();
const CACHE_ENC = new TextEncoder();
const CACHE_DEC = new TextDecoder();

async function opfsCacheDir(create) {
  if (typeof navigator === 'undefined' || !navigator.storage
      || typeof navigator.storage.getDirectory !== 'function') return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: !!create });
  } catch (err) {
    return null;                       // no OPFS / storage disabled: manual path only
  }
}

async function cacheManifest() {
  const dir = await opfsCacheDir(false);
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(CACHE_JSON);
    const man = JSON.parse(await (await fh.getFile()).text());
    if (!man || man.version !== CACHE_VERSION) return null;      // an older layout
    return man;
  } catch (err) {
    return null;
  }
}

// { path, name, bytes } for every file under the extracted tree.
function extractedEntries() {
  const out = [];
  for (const dir of assetDirs()) {
    let names;
    try { names = Module.FS.readdir(dir); } catch (err) { continue; }
    for (const name of names) {
      const p = `${dir}/${name}`;
      try {
        if (!Module.FS.isFile(Module.FS.stat(p).mode)) continue;
        out.push({ path: p, name, bytes: Module.FS.readFile(p) });
      } catch (err) { /* skip */ }
    }
  }
  return out;
}

// One packed blob + a small manifest, rather than ~970 OPFS entries: a single read
// on restore, and no per-entry bookkeeping to get wrong.
async function saveAssetCache(theaters) {
  const dir = await opfsCacheDir(true);
  if (!dir) {
    self.postMessage({ type: 'cache-unavailable' });
    return null;
  }
  const entries = extractedEntries();
  if (!entries.length) return null;
  let bytes = 0;
  const parts = [];
  for (const e of entries) {
    const name = CACHE_ENC.encode(e.path);
    const head = new Uint8Array(6);
    new DataView(head.buffer).setUint16(0, name.length, true);
    new DataView(head.buffer).setUint32(2, e.bytes.length, true);
    parts.push(head, name, e.bytes);
    bytes += e.bytes.length;
  }
  const man = { version: CACHE_VERSION, files: entries.length, bytes,
                savedAt: Date.now(),
                theaters: [...extractedTheaters].sort(),
                sums: entries.map((e) => [e.path, checksum(e.bytes)]) };
  const bin = await dir.getFileHandle(CACHE_BIN, { create: true });
  const bw = await bin.createWritable();
  await bw.write(new Blob(parts));
  await bw.close();
  const js = await dir.getFileHandle(CACHE_JSON, { create: true });
  const jw = await js.createWritable();
  await jw.write(JSON.stringify(man));
  await jw.close();
  // Drop the per-theatre files of the old layout; leaving them would waste ~20 MB and
  // invite a future reader to use them.
  for (const old of ['theater-0.bin', 'theater-0.json', 'theater-1.bin', 'theater-1.json']) {
    try { await dir.removeEntry(old); } catch (err) { /* not there */ }
  }
  return man;
}

async function restoreAssetCache(theater) {
  const man = await cacheManifest();
  if (!man) return null;
  // The cache is one tree; say which theatres it holds so the page can tell a covered
  // roll from an uncovered one instead of generating on a tree that lacks the theatre.
  if (Array.isArray(man.theaters) && !man.theaters.includes(theater)) {
    return { uncovered: true, theater, theaters: man.theaters };
  }
  const dir = await opfsCacheDir(false);
  if (!dir) return null;
  let buf;
  try {
    const fh = await dir.getFileHandle(CACHE_BIN);
    buf = new Uint8Array(await (await fh.getFile()).arrayBuffer());
  } catch (err) {
    return null;
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sums = new Map(man.sums || []);      // absent in a manifest from an older build
  let off = 0, n = 0, failed = 0;
  // Layout, matching saveAssetCache exactly: [nameLen u16][dataLen u32][name][data].
  // Reading the two lengths on either side of the name (as this used to) consumes the
  // file's own bytes as the length, and the tree comes out with one bogus file in it.
  while (off + 6 <= buf.length && n + failed < man.files) {
    const nameLen = dv.getUint16(off, true); off += 2;
    const len = dv.getUint32(off, true); off += 4;
    const path = CACHE_DEC.decode(buf.subarray(off, off + nameLen)); off += nameLen;
    const data = buf.subarray(off, off + len); off += len;
    const slash = path.lastIndexOf('/');
    try {
      if (slash > 0) Module.FS.mkdirTree(path.slice(0, slash));
      Module.FS.writeFile(path, data);
      // A file that lands with the right length but the wrong bytes is exactly the
      // failure a length check cannot see (this caught a pack/unpack mismatch during
      // development), and the generator would then run on a silently wrong INI.
      if (sums.size && sums.get(path) !== checksum(data)) { ++failed; continue; }
      ++n;
    } catch (err) { ++failed; }
  }
  // A partial tree is worse than no tree: the generator walks it and a missing INI
  // sends the engine into an unbounded fallback search (measured: "Maximum call stack
  // size exceeded" from mg_engine.wasm).  So anything short of a complete restore is
  // reported as a miss and the page asks for the directory again.
  if (failed > 0 || n !== man.files) {
    return { incomplete: true, files: n, expected: man.files, failed };
  }
  return { files: n, bytes: man.bytes, savedAt: man.savedAt, expected: man.files,
           failed, theaters: man.theaters || [theater] };
}

async function clearAssetCache() {
  if (typeof navigator === 'undefined' || !navigator.storage
      || typeof navigator.storage.getDirectory !== 'function') return false;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(CACHE_DIR, { recursive: true });
    return true;
  } catch (err) {
    return false;                      // nothing cached is not an error
  }
}

/** Copies a MEMFS file out in two calls: ask for the length, then read it. */
function readMemfs(path) {
  const probe = engine.readOutput(path, 0, -1);   // -1 = "just tell me the size"
  if (probe < 0) return null;
  const ptr = Module._malloc(probe);
  try {
    const got = engine.readOutput(path, ptr, probe);
    if (got < 0) return null;
    return Module.HEAPU8.slice(ptr, ptr + got);
  } finally {
    Module._free(ptr);
  }
}

async function boot() {
  // Dynamic import, not a static one: this file has to stay a classic script.
  const { default: createMgEngine } = await import('./mg_engine.js');
  Module = await createMgEngine({
    noInitialRun: true,
    print: (line) => self.postMessage({ type: 'log', line }),
    printErr: (line) => self.postMessage({ type: 'log', line }),
  });

  // The EM_JS hooks in engine/src/wasm_entry.cpp call these two.
  Module.mgFileSize = (id) => {
    const f = files.get(id);
    return f ? f.size : -1;
  };
  Module.mgRead = (id, offset, length, ptr) => {
    const f = files.get(id);
    if (!f) return 0;
    let bytes;
    try {
      bytes = new Uint8Array(readers.readAsArrayBuffer(f.slice(offset, offset + length)));
    } catch (err) {
      return 0;
    }
    if (bytes.length !== length) return 0;
    Module.HEAPU8.set(bytes, ptr);
    return 1;
  };

  engine = {
    addFile: Module.cwrap('mg_add_file', null, ['number', 'string']),
    setRoot: Module.cwrap('mg_set_root', null, ['string']),
    extract: Module.cwrap('mg_extract', 'number', ['number']),
    generate: Module.cwrap('mg_generate', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number',
       'number', 'number', 'number', 'number', 'number', 'number', 'number', 'string']),
    readOutput: Module.cwrap('mg_read_output', 'number', ['string', 'number', 'number']),
    error: Module.cwrap('mg_error', 'string', []),
    outputPath: Module.cwrap('mg_output_path', 'string', []),
    sizeUsefulMax: Module.cwrap('mg_size_useful_max', 'number', ['number', 'number']),
    sizeLegalMax: Module.cwrap('mg_size_legal_max', 'number', ['number', 'number']),
    sizeStep: Module.cwrap('mg_size_step', 'number', []),
    rectMaxSum: Module.cwrap('mg_rect_max_sum', 'number', []),
    rectCells: Module.cwrap('mg_rect_cells', 'number', ['number', 'number']),
    symmetryMax: Module.cwrap('mg_symmetry_max', 'number', []),
  };

  // The sizeSlider bounds come from the engine, so the page never carries its own
  // copy of the size tables.  A 5x7 table (land 0..4 x players 2..8) is small
  // enough to send once here instead of asking on every parameter change:
  // sizeMax[land][players - 2].  All three values are fractional -- the useful
  // bound is 3.6, which an integer slider cannot name.
  const sizeMax = [];
  const sizeLimit = [];
  for (let land = 0; land < 5; ++land) {
    const useful = [];
    const legal = [];
    for (let p = 2; p <= 8; ++p) {
      useful.push(engine.sizeUsefulMax(land, p));
      legal.push(engine.sizeLegalMax(land, p));
    }
    sizeMax.push(useful);
    sizeLimit.push(legal);
  }
  self.postMessage({ type: 'ready', sizeMax, sizeLimit, sizeStep: engine.sizeStep(),
                     rectMaxSum: engine.rectMaxSum(),
                     symmetryMax: engine.symmetryMax() });
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'boot') {
      mark('worker: booting the generator engine');
      try {
        await boot();
      } catch (err) {
        fail(`启动生成引擎失败：${(err && err.stack) || err}`);
      }
      return;
    }
    if (!engine) {
      fail('engine not booted');
      return;
    }
    // The page's "面积" readout for an explicit rectangle.  It is a question, not
    // work, so it is answered straight from the engine's own grid arithmetic
    // (mg_rect_cells) rather than from a copy of it in app.js.  Asked on every
    // keystroke in the two number inputs; the call is a few instructions.
    if (msg.type === 'rect-cells') {
      const width = Number(msg.width) || 0;
      const height = Number(msg.height) || 0;
      self.postMessage({ type: 'rect-cells', width, height,
                         cells: engine.rectCells(width, height) });
      return;
    }
    if (msg.type === 'assets') {
      // msg.files: [{ name, file }] -- the archives the player picked.
      files.clear();
      for (const entry of msg.files) {
        const id = nextId++;
        files.set(id, entry.file);
        engine.addFile(id, entry.name);
      }
      engine.setRoot('/mg');
      self.postMessage({ type: 'progress', stage: 'extracting' });
      // A folder pick asks for ALL theatres (`all`): one extraction pass covers the
      // whole product, so 随机 in the 剧场 row can never land on "not cached yet".
      // mg_extract only adds files, so the tree accumulates and one cache holds both.
      const want = msg.all ? [0, 1] : [msg.theater | 0];
      for (const theater of want) {
        const rc = engine.extract(theater);
        if (rc !== 0) {
          fail(`extraction failed: ${engine.error()}`);
          return;
        }
        extractedTheaters.add(theater);
      }
      self.postMessage({ type: 'assets-ready', theater: msg.theater | 0,
                         theaters: [...extractedTheaters].sort() });
      // Written after the ready message so the first generation never waits for the
      // cache write: a failed one costs nothing but the next visit.
      saveAssetCache([...extractedTheaters].sort())
        .then((man) => { if (man) self.postMessage({ type: 'cache-saved', ...man }); })
        .catch((err) => {
          // Silently skipping the cache would look exactly like "the cache never
          // works", which is the report this feature exists to answer, so say it.
          self.postMessage({ type: 'cache-failed',
                             reason: String((err && err.message) || err) });
        });
      return;
    }
    if (msg.type === 'generate') {
      const p = msg.params;
      self.postMessage({ type: 'progress', stage: 'generating' });
      // p.size must NOT go through `| 0`: it is a double, and truncating it would
      // quietly turn the slider's 1.5 into 1.
      const rc = engine.generate(
        p.land | 0, p.theater | 0, p.time | 0, Number(p.size) || 0, p.players | 0,
        p.ore | 0, p.water | 0, p.seed >>> 0, p.mapSeed >>> 0,
        p.single ? 1 : 0, p.width | 0, p.height | 0, p.symmetry | 0,
        p.outPath || '/mg/out.map');
      if (rc !== 0) {
        fail(`generation failed: ${engine.error()}`);
        return;
      }
      const bytes = readMemfs(engine.outputPath());
      if (!bytes) {
        fail('the engine reported success but produced no map');
        return;
      }
      self.postMessage(
        { type: 'map', bytes, name: (p.outPath || 'out.map').split('/').pop() },
        [bytes.buffer]);
      return;
    }
    if (msg.type === 'cache-info') {
      const man = await cacheManifest();
      self.postMessage({ type: 'cache-info', theater: msg.theater | 0, manifest: man });
      return;
    }
    if (msg.type === 'assets-from-cache') {
      const theater = msg.theater | 0;
      files.clear();
      engine.setRoot('/mg');
      self.postMessage({ type: 'progress', stage: 'extracting' });
      const got = await restoreAssetCache(theater);
      if (got && !got.incomplete && !got.uncovered) {
        // The tree now holds exactly what the cache held, so remember that.
        extractedTheaters.clear();
        for (const th of (got.theaters || [theater])) extractedTheaters.add(th);
      }
      if (!got || got.incomplete) {
        self.postMessage({ type: 'cache-miss', theater, detail: got || null });
        return;
      }
      self.postMessage({ type: 'assets-ready', theater, fromCache: true,
                         theaters: [...extractedTheaters].sort(), ...got });
      return;
    }
    if (msg.type === 'cache-clear') {
      self.postMessage({ type: 'cache-cleared', ok: await clearAssetCache() });
      return;
    }
    if (msg.type === 'collect') {
      // CNCMaps takes a DIRECTORY of loose files and its DirArchive is
      // non-recursive, so the tree is flattened here before being handed over.
      const files = collectAssets();
      if (!files.length) {
        fail('还没有提取任何素材，无法渲染');
        return;
      }
      self.postMessage(
        { type: 'assets-data', files, mapPath: engine.outputPath() },
        files.map((f) => f.bytes.buffer));
      return;
    }
  } catch (err) {
    fail(String((err && err.stack) || err));
  }
};
