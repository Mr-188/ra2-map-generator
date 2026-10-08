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
       'number', 'number', 'number', 'number', 'string']),
    readOutput: Module.cwrap('mg_read_output', 'number', ['string', 'number', 'number']),
    error: Module.cwrap('mg_error', 'string', []),
    outputPath: Module.cwrap('mg_output_path', 'string', []),
  };
  self.postMessage({ type: 'ready' });
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
      const rc = engine.extract(msg.theater | 0);
      if (rc !== 0) {
        fail(`extraction failed: ${engine.error()}`);
        return;
      }
      self.postMessage({ type: 'assets-ready' });
      return;
    }
    if (msg.type === 'generate') {
      const p = msg.params;
      self.postMessage({ type: 'progress', stage: 'generating' });
      const rc = engine.generate(
        p.land | 0, p.theater | 0, p.time | 0, p.size | 0, p.players | 0,
        p.ore | 0, p.water | 0, p.seed >>> 0, p.mapSeed >>> 0,
        p.single ? 1 : 0, p.outPath || '/mg/out.map');
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
