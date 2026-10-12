// Main-thread UI for the wasm generator.
//
// The archives are handed to the worker as File objects -- structured-cloneable,
// never read here and never uploaded.  The worker slices them on demand with
// FileReaderSync, which is why the engine has to live in a worker at all.
//
// NOTE: no browser has been used to exercise this page yet.  It is written
// against the interface webapp/worker.js exposes; the engine it drives is the
// one tools/verify_wasm.py proves byte-identical to the native oracle.

const NEEDED = ['ra2.mix', 'ra2md.mix', 'expandmd01.mix'];

// Stage labels for the worker's progress messages.  Missing this table used to
// throw a ReferenceError inside the message listener on every progress message;
// each message is its own task, so the page carried on and the failure was
// silent -- worth remembering when reading these handlers.
const PROGRESS = {
  'extracting': '正在从你的游戏归档里提取素材……',
  'generating': '正在生成地图……',
  'renderer-boot': '正在启动渲染器（首次约十几秒）……',
  'renderer-assets': '正在把素材交给渲染器……',
  'rendering': '正在渲染预览图……',
};

const el = (id) => document.getElementById(id);
const dirInput = el('dir');
const picked = el('picked');
const goBtn = el('go');
const statusEl = el('status');
const errorEl = el('error');
const logEl = el('log');
const resultEl = el('result');
const downloadEl = el('download');
const renderBtn = el('render');
const previewEl = el('preview');
const previewImg = el('preview-img');
const previewCap = el('preview-cap');
const previewDl = el('preview-dl');

// Object URLs for the two downloads; revoked before being replaced so a session
// that generates many maps does not leak blob storage.
let mapUrl = null;
let previewUrl = null;
let mapBytes = null;      // the renderer runs on this thread and reads these
let rendererRuntime = null;

// NOT { type: 'module' }: the .NET runtime detects its host with
// `typeof importScripts`, which a module worker does not have, and stalls.
const worker = new Worker('./worker.js');
let archives = null;
let booted = false;

// 水量 is deliberately NOT a control on this page.  The reference GUI has no
// water parameter at all: the engine always takes it from RollGlobalOptions
// (WinMain.cpp:493), which rolls a per-terrain range (Archipelago [75,100],
// Continent [0,25], TeamContinent [50,100], Inland/Mountainous [0,100]).
//
// A slider was built and then removed again.  A sweep over the five terrains
// (fixed seed, water = -1/0/20/50/100) showed why it could not be honest:
//
//   Archipelago   1/5 distinct -- GenerateArchipelago never reads waterAmount_
//   Continent     2/5 distinct -- only water == 100 changes anything: the value
//                                feeds an integer patch cap, and the roll range
//                                [0,25] lies entirely below where it binds
//   TeamContinent 5/5
//   Inland        5/5  (rivers and lakes scale with it)
//   Mountainous   5/5  (and byte-identical to Inland - see the note on the
//                       #land select in index.html: the engine accepts 4, the
//                       page does not offer it)
//
// So the page sends -1, which the engine reads as "use the rolled global value"
// -- exactly what the original does on every terrain.  The knob is absent
// because the game never offered it.  (mgconsole still has --water, which is
// how the sweep above was measured.)
const WATER_FROM_GLOBAL_ROLL = -1;

// ---- 地图大小 --------------------------------------------------------------
//
// The engine's `sizeSlider` is an integer (0..3 in the retail dialog): it goes
// straight into `f = size / 3` and then `W = Wmin*(1-f) + Wmax*f`, so it walks
// the size tables in thirds of the way from Wmin to Wmax.
//
// The VALID RANGE IS NOT COMPUTED HERE.  The engine owns it -- the tables, the
// clamp and the 512-cell overlay wall all live together in CalcMapSize /
// SizeSliderRange -- and the worker asks for it at boot and forwards it in the
// `ready` message.  This file used to hard-code "past 4 nothing changes", which
// was a hand transcription of kSizeFractionMax and would have gone stale
// silently the moment that constant moved.
//
//   sizeMax[land][players - 2]    the last value that changes the map size
//   sizeLimit[land][players - 2]  the last value the writer will not truncate
//
// For 内陆 the two are equal (no clamp, so the slider keeps growing until
// the overlay grid stops it); for the other three sizeMax is 4 and sizeLimit is
// the grid bound, so anything past sizeMax is legal but redundant -- which is
// why the slider's max is sizeMax and the note explains the cap.  The tables are
// still filled for all five engine land types (the API keeps accepting 4); the
// page just no longer offers 山地 as a second name for 内陆.
let sizeMax = null;
let sizeLimit = null;
let sizeStep = 0.1;        // replaced by the engine's kSizeSliderStep at boot
let rectMaxSum = 495;      // replaced by the engine's MaxRectCellSum() at boot
// The sentinel every <select> uses for "roll this one at generate time".  It is a
// string so it can never collide with a numeric option, and it is deliberately not
// written back into the control after a roll: the control stays on 随机 so the next
// click rolls again, and the values that were used are shown in #rolled instead.
const RANDOM = '?';

let symmetryMax = 2;       // replaced by the engine's mg_symmetry_max() at boot; the
                           // page offers 无(0) and 180°(2), so 2 is the value that has
                           // to stay usable - syncSymmetry() disables anything above
                           // what the engine reports
let sizeMode = 'square';   // 'square' (the slider) or 'rect' (explicit 长 × 宽)
// The engine's own cell count for one explicit pair, as { w, h, cells }.  w/h are
// carried so a reply that arrives after the inputs changed can be recognised as
// stale instead of being shown as if it described the current map.
let rectCells = null;

let autoRender = false;    // the 设置 drawer's 自动渲染地图 switch (persisted)
// theatre -> cached-extraction manifest ({files, bytes, savedAt}) from the worker.
// A cache hit means the page can generate (and render) with NO game directory and
// no permission prompt; see the OPFS section in worker.js.
const cacheInfo = { manifest: null };
let cacheRestorePending = false;
// 'idle' | 'running' | 'ok' | 'failed' | 'unsupported' - what to say about the
// browser-side cache in the 游戏目录 section.
let cacheState = 'idle';
let cacheFailReason = '';
let extractInFlight = false;   // an extraction (which also fills the cache) is running
// The theatres the worker's tree currently holds (mg_extract accumulates, and a folder
// pick asks for all of them).
const extractedTheaters = new Set();
const SETTINGS_KEY = 'ra2mg.settings';
const rolledEl = el('rolled');

const sizeInput = el('size');
const sizeOut = el('size-out');
const sizeNote = el('size-note');
const rectPair = el('rect-pair');
const rectW = el('rect-w');
const rectH = el('rect-h');
const sizeModeBox = el('size-mode');

// 3.6, not 3.6000000000000005.  Two decimals is past the engine's own
// granularity (one cell per size step), so nothing is lost.
const fmtSize = (v) => String(Number(Number(v).toFixed(2)));
const group = (n) => n.toLocaleString('en-US');

// The engine caps width + height, not either one, because the 512-cell overlay
// grid is indexed over mapWidth + mapHeight.  Clamp the field being edited
// against the other, so the pair is always one the writer will accept.
function clampedRect() {
  let w = Math.max(1, Math.round(Number(rectW.value) || 1));
  let h = Math.max(1, Math.round(Number(rectH.value) || 1));
  const over = (w + h) - rectMaxSum;
  if (over > 0) {                  // shrink whichever is larger, keeping w*h high
    if (w >= h) w = Math.max(1, w - over); else h = Math.max(1, h - over);
    const stillOver = (w + h) - rectMaxSum;
    if (stillOver > 0) h = Math.max(1, h - stillOver);
  }
  return { w, h };
}

// The readout for an explicit rectangle.  `cells` is the engine's count for the
// pair sitting in the inputs right now; until that answer arrives -- or while a
// reply for a pair the user has already edited away is in flight -- it says so,
// rather than printing a number that is not what the map will contain.
function showRectSize(w, h) {
  const known = rectCells && rectCells.w === w && rectCells.h === h;
  const cells = known ? rectCells.cells : null;
  const cellsText = cells === null ? '…' : group(cells);
  sizeOut.value = cells === null ? '…' : `${group(cells)} 格`;
  sizeNote.textContent =
    `地图大小：长 ${w} × 宽 ${h}，引擎实际写出 ${cellsText} 格`
    + `（可见区 ${group(w * h)} 格）。`
    + `引擎把长 + 宽限制在 ${rectMaxSum} 以内（overlay 网格按两者之和寻址）；`
    + `方图的边长上限约 247，所以这种长宽比能做出方图做不到的尺寸。`;
}

// The widest useful size any (land, players) pair allows.  Only used while a 随机
// entry is selected, so the slider's bounds cover whatever the roll may pick.
function maxUseful() {
  if (!sizeMax) return Number(sizeInput.max);
  let best = 0;
  for (const row of sizeMax) {
    if (!Array.isArray(row)) continue;
    for (const v of row) if (Number.isFinite(v) && v > best) best = v;
  }
  return best || Number(sizeInput.max);
}

function setSizeMode(mode) {
  sizeMode = mode;
  for (const b of sizeModeBox.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.mode === mode);
  }
  // 'random' keeps the slider visible (it shows the range the roll draws from) but
  // disabled, so it cannot look like the value that will be used.
  sizeInput.hidden = (mode === 'rect');
  sizeInput.disabled = (mode === 'random');
  rectPair.hidden = (mode !== 'rect');
  syncSize();
}

function syncSize() {
  const land = Number(el('land').value);
  const players = Number(el('players').value);
  const idx = Math.max(0, Math.min(6, players - 2));
  // 随机 means the engine table cannot be indexed yet.  The slider then spans every
  // land/player combination the roll could pick, so no rolled value can fall off it.
  const unknown = !Number.isFinite(land) || !Number.isFinite(players);

  if (sizeMode === 'rect') {
    const { w, h } = clampedRect();
    rectW.value = String(w);
    rectH.value = String(h);
    // The engine owns the grid arithmetic (mg_rect_cells).  This used to label
    // w * h as 格, but that is the *visible* rect -- the diamond the writer emits
    // holds about twice as many cells, and the readout disagreed with the file.
    // Asking is one postMessage; the answer is a few instructions.
    if (booted && (!rectCells || rectCells.w !== w || rectCells.h !== h)) {
      worker.postMessage({ type: 'rect-cells', width: w, height: h });
    }
    showRectSize(w, h);
    return;
  }

  if (!sizeMax) {                    // engine table not here yet (still booting)
    if (sizeMode === 'random') {
    sizeOut.value = '随机';
    sizeNote.textContent =
      `地图大小：每次生成时在 0..${fmtSize(useful)} 之间随机取一个（步长 ${sizeStep}，`
      + `按抽到的环境与玩家数决定上限）。`;
    return;
  }
  sizeOut.value = fmtSize(sizeInput.value);
    return;
  }

  const useful = unknown ? maxUseful()
    : (sizeMax[land] ? sizeMax[land][idx] : Number(sizeInput.max));
  const legal = unknown ? useful
    : (sizeLimit && sizeLimit[land] ? sizeLimit[land][idx] : useful);

  // Ceiling and step are both the engine's, so the slider cannot offer a value
  // the generator refuses, nor a position that changes nothing.
  sizeInput.step = String(sizeStep);
  sizeInput.max = String(useful);
  if (Number(sizeInput.value) > useful) sizeInput.value = String(useful);

  sizeOut.value = fmtSize(sizeInput.value);
  // Only the three clamped land types need the explanation, and the way to tell
  // them apart needs no land-type knowledge in the page: a clamped map stops
  // growing while the overlay grid is still far away, so its legal bound is
  // hundreds of steps above its useful one.  On Inland the two differ only by the
  // last quantisation step (0.2 at most).  Comparing on that gap is why this text
  // is not shown on a map that does have head-room.
  sizeNote.textContent = (legal - useful) > 1
    ? '地图大小：此环境的最大档由引擎的尺寸插值上限决定；内陆没有这个上限。'
    : '';
}

// The page offers 无 / 180° 中心对称 (one optional kind, by product decision; the
// engine also implements left-right and top-bottom and the CLI/API still take them).
// Anything above what the engine reports gets disabled rather than offered and then
// refused - so if 180 were ever not implemented the option would grey out instead of
// producing a map it cannot make.
function syncSymmetry() {
  const sel = el('symmetry');
  for (const opt of sel.options) {
    opt.disabled = Number(opt.value) > symmetryMax;
  }
  if ((Number(sel.value) || 0) > symmetryMax) sel.value = '0';
}

sizeModeBox.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setSizeMode(b.dataset.mode);
});
sizeInput.addEventListener('input', syncSize);
rectW.addEventListener('input', syncSize);
rectH.addEventListener('input', syncSize);
el('land').addEventListener('change', syncSize);
el('players').addEventListener('change', syncSize);
syncSize();

function setStatus(text, cls) {
  statusEl.textContent = text || '';
  statusEl.className = cls || '';
}

function showError(text) {
  errorEl.textContent = text;
  setStatus('失败', 'err');
  // Reinstate the button only if the engine itself is alive -- otherwise the
  // user can click a button that cannot possibly work.
  goBtn.disabled = !(booted && archives);
}

worker.addEventListener('error', (event) => {
  // A module worker that fails to EVALUATE its script reports here with a
  // message like "Failed to fetch dynamically imported module" or, for a bad
  // top-level import, almost nothing -- so include everything the event carries.
  const where = event.filename ? ` (${event.filename}:${event.lineno || 0})` : '';
  showError(`引擎加载失败：${event.message || '(浏览器没有给出消息)'}${where}\n` +
            `常见原因：mg_engine.js 里有一句浏览器无法解析的 import。`);
});
worker.addEventListener('messageerror', (event) => {
  showError(`worker 消息无法反序列化：${String(event.data)}`);
});

// If the worker never reports ready, say so rather than leaving a dead button.
const bootWatchdog = setTimeout(() => {
  if (!booted) {
    showError('引擎在 20 秒内没有就绪。打开浏览器控制台（F12）能看到具体报错；'
              + '常见原因是 mg_engine.js / mg_engine.wasm 没有被正确提供。');
  }
}, 20000);

worker.addEventListener('message', async (event) => {
  const msg = event.data || {};
  switch (msg.type) {
    case 'ready':
      booted = true;
      clearTimeout(bootWatchdog);
      errorEl.textContent = '';
      // The engine's sizeSlider bounds arrive with the ready message; adopt them
      // before the first syncSize() so the slider is never sized from a guess.
      if (Array.isArray(msg.sizeMax)) sizeMax = msg.sizeMax;
      if (Array.isArray(msg.sizeLimit)) sizeLimit = msg.sizeLimit;
      if (typeof msg.sizeStep === 'number' && msg.sizeStep > 0) sizeStep = msg.sizeStep;
      if (typeof msg.rectMaxSum === 'number' && msg.rectMaxSum > 0) rectMaxSum = msg.rectMaxSum;
      if (typeof msg.symmetryMax === 'number') { symmetryMax = msg.symmetryMax; syncSymmetry(); }
      syncSize();
      setStatus('引擎已就绪。选好游戏目录和参数后点生成。');
      askCacheInfo(currentTheater());
      refreshGoButton();
      break;
    case 'cache-info': {
      delete cacheInfo.__pending;
      cacheInfo.manifest = msg.manifest || null;
      renderCacheNote();
      break;
    }
    case 'cache-saved': {
      cacheState = 'ok';
      cacheInfo.manifest = { version: msg.version, files: msg.files, bytes: msg.bytes,
                             savedAt: msg.savedAt, theaters: msg.theaters };
      renderCacheNote();
      mark(`cache: 素材已缓存（${theaterNames(msg.theaters)} · ${fmtBytes(msg.bytes)}），`
           + '下次打开不再需要游戏目录');
      break;
    }
    case 'cache-miss': {
      const uncovered = !!(msg.detail && msg.detail.uncovered);
      if (!uncovered) cacheInfo.manifest = null;     // nothing usable: really a miss
      renderCacheNote();
      break;
    }
    case 'cache-cleared': {
      cacheInfo.manifest = null;
      extractedTheaters.clear();
      renderCacheNote();
      setStatus(msg.ok ? '已清除浏览器缓存。' : '清除缓存失败（可能本来就没有）。', msg.ok ? 'ok' : '');
      break;
    }
    case 'log':
      logEl.textContent += msg.line + '\n';
      logEl.scrollTop = logEl.scrollHeight;
      break;
    case 'progress':
      setStatus(PROGRESS[msg.stage] || '处理中……');
      break;
    case 'assets-ready': {
      extractInFlight = false;
      extractedTheaters.clear();
      for (const th of (msg.theaters || [msg.theater])) {
        if (typeof th === 'number') extractedTheaters.add(th);
      }
      if (cacheState === 'running') cacheState = 'idle';
      renderCacheNote();
      setStatus(msg.fromCache
        ? `素材已从浏览器缓存恢复（${theaterNames(msg.theaters)}）。`
        : '素材已就绪（正在写缓存）。');
      break;
    }
    case 'cache-unavailable':
      cacheState = 'unsupported';
      renderCacheNote();
      break;
    case 'cache-failed':
      cacheState = 'failed';
      cacheFailReason = msg.reason || '(未知原因)';
      renderCacheNote();
      break;
    case 'rect-cells':
      // The engine's answer for one 长 × 宽 pair.  Recorded with its pair so a
      // reply that overtook an edit is recognised as stale; syncSize() only
      // re-asks when the inputs no longer match what it holds.
      rectCells = { w: msg.width, h: msg.height, cells: msg.cells };
      if (sizeMode === 'rect') syncSize();
      break;
    case 'map': {
      mapBytes = msg.bytes;
      if (mapUrl) URL.revokeObjectURL(mapUrl);
      mapUrl = URL.createObjectURL(new Blob([msg.bytes], { type: 'application/octet-stream' }));
      downloadEl.href = mapUrl;
      downloadEl.download = msg.name;
      el('done').textContent = `${msg.name} · ${(msg.bytes.length / 1024).toFixed(0)} KB`;
      resultEl.style.display = 'block';
      setStatus('完成。', 'ok');
      goBtn.disabled = false;
      // The preview needs its own wasm runtime, so it is a deliberate second
      // step rather than something that happens behind the user's back.
      renderBtn.disabled = false;
      renderBtn.textContent = '渲染预览';
      if (autoRender) {
        mark('settings: 自动渲染地图已开启，生成完成后直接开始渲染');
        startRender();
      }
      break;
    }
    case 'preview': {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(new Blob([msg.bytes], { type: 'image/png' }));
      previewImg.src = previewUrl;
      previewDl.href = previewUrl;
      previewEl.style.display = 'block';
      previewCap.textContent =
        `用你自己的游戏素材渲染：${msg.assets} 个文件，耗时 ${msg.ms} ms。` +
        `与 CNCMaps 本机渲染逐像素一致。`;
      // The preview is full width and sits below the two columns, so the first
      // render can finish entirely below the fold.  Bring it into view, but do
      // not animate for users who asked for reduced motion.
      previewEl.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto' : 'smooth',
        block: 'start',
      });
      setStatus('渲染完成。', 'ok');
      renderBtn.disabled = false;
      renderBtn.textContent = '重新渲染';
      break;
    }
    case 'assets-data':
      await renderOnMainThread(msg);
      break;
    case 'error':
      showError(msg.message);
      break;
  }
});

// The rendering half runs HERE, on the main thread.
//
// It used to run in the worker and never started: the .NET runtime works out
// what host it is in with `typeof importScripts` / `typeof window`, and inside a
// worker it concluded it was an unknown shell environment and stalled inside
// dotnet.create() -- silently, in a module worker and in a classic one alike.
// On the main thread `window` exists, the detection is unambiguous, and there is
// no second filesystem to copy into.
async function renderOnMainThread(msg) {
  mark('renderer: booting on the main thread');
  try {
    const { dotnet } = await import('./render/_framework/dotnet.js');
    mark('renderer: module loaded, starting the runtime (the page will pause)');
    const runtime = rendererRuntime || await dotnet.create({
      print: (line) => logEl.textContent += `[dotnet] ${line}\n`,
      printErr: (line) => logEl.textContent += `[dotnet:err] ${line}\n`,
    });
    rendererRuntime = runtime;
    const config = runtime.getConfig();
    mark(`renderer: runtime started (${config.mainAssemblyName})`);
    const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
    const Render = exports?.CNCMaps?.WebEntry?.Render;
    if (typeof Render !== 'function') {
      throw new Error('渲染器模块里没有 CNCMaps.WebEntry.Render 导出');
    }

    const fs = runtime.Module.FS;
    for (const dir of ['/game', '/maps']) {
      try { fs.mkdir(dir); } catch (err) { /* already there */ }
    }
    let copied = 0;
    for (const file of msg.files) {
      fs.writeFile(`/game/${file.name}`, file.bytes);
      copied++;
    }
    mark(`renderer: ${copied} files handed over`);
    fs.writeFile('/maps/render.map', mapBytes);

    // performance.now(), NOT Date.now(): elapsed time has to come from a
    // monotonic clock.  Date.now() is wall time and can be stepped by NTP or by
    // the VM host -- this machine's clock was measured jumping BACKWARDS by
    // 14 s during a render, which printed "耗时 -13430 ms" to the user.
    const started = performance.now();
    const rc = Render('/maps/render.map', '/game', '/maps/render');
    if (rc !== 0) throw new Error(`渲染器返回 ${rc}`);
    const png = fs.readFile('/maps/render.png');

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    previewImg.src = previewUrl;
    previewDl.href = previewUrl;
    previewEl.style.display = 'block';
    previewCap.textContent =
      `用你自己的游戏素材渲染：${copied} 个文件，耗时 ` +
      `${Math.round(performance.now() - started)} ms。与 CNCMaps 本机渲染逐像素一致。`;
    setStatus('渲染完成。', 'ok');
    renderBtn.disabled = false;
    renderBtn.textContent = '重新渲染';
  } catch (err) {
    showError(`渲染失败：${(err && err.stack) || err}`);
    renderBtn.disabled = false;
  }
}

function mark(text) {
  logEl.textContent += `-- ${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}


// One place decides what a candidate set of files means, so the <input> path and
// the remembered-directory path below cannot drift apart.
function applyPicked(byName, label) {
  const found = NEEDED.filter((n) => byName.has(n));
  const missing = NEEDED.filter((n) => !byName.has(n));
  const where = label ? `「${label}」` : '所选目录';

  picked.textContent = found.length
    ? `已找到 ${found.length}/${NEEDED.length}：${found.join('、')}` +
      (missing.length ? `（缺少 ${missing.join('、')}）` : '')
    : `没有在${where}里找到需要的 .mix 文件。`;

  archives = missing.length ? null : found.map((n) => ({ name: n, file: byName.get(n) }));
  refreshGoButton();
  // Extract (and cache) as soon as the folder is picked, not on the first generate:
  // "picked the folder, refreshed, had to pick again" was exactly the report this
  // answers.  The cache write follows the extraction on its own.
  if (archives && booted) startExtract();
  resultEl.style.display = 'none';
  errorEl.textContent = '';
}

dirInput.addEventListener('change', () => {
  const byName = new Map();
  for (const f of Array.from(dirInput.files || [])) byName.set(f.name.toLowerCase(), f);
  applyPicked(byName, '');
});

// ---- remember the game directory -------------------------------------------
//
// A <input webkitdirectory> hands out File objects that die with the page, so a
// refresh used to mean re-picking a 470 MB folder.  The only way to remember a
// directory is the File System Access API: showDirectoryPicker() returns a
// FileSystemDirectoryHandle that survives in IndexedDB and can be re-authorised
// with one click.  It is Chromium-only and needs a secure context, so this is an
// ADDITION to the input path, never a replacement -- the input is what every
// other browser uses, and what tools/verify_browser.mjs drives.
const IDB_NAME = 'ra2-rmg';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'gameDir';

const rememberEl = el('remember');
const rememberNote = el('remember-note');
const restoreBtn = el('restore');
const restoreName = el('restore-name');
const pickRememberBtn = el('pick-remember');
const pickRememberLabel = el('pick-remember-label');

function idb(mode, fn) {
  return new Promise((resolve) => {
    if (!window.indexedDB) { resolve(null); return; }
    try {
      const open = indexedDB.open(IDB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        const store = open.result.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      };
    } catch (err) {
      resolve(null);
    }
  });
}
const handleGet = () => idb('readonly', (s) => s.get(HANDLE_KEY));
const handlePut = (h) => idb('readwrite', (s) => s.put(h, HANDLE_KEY));

async function entriesFromHandle(handle) {
  const byName = new Map();
  for await (const entry of handle.values()) {
    if (entry.kind === 'file') byName.set(entry.name.toLowerCase(), entry);
  }
  return byName;
}

async function useHandle(handle, remember) {
  const byName = await entriesFromHandle(handle);
  if (NEEDED.some((n) => !byName.has(n))) {
    applyPicked(new Map(), handle.name);
    return;
  }
  const files = new Map();
  for (const n of NEEDED) files.set(n, await byName.get(n).getFile());
  if (remember) await handlePut(handle);
  applyPicked(files, handle.name);
  await tryAutoRestore();
}

// ---- the cached extraction (see worker.js) ---------------------------------
const cacheEl = el('cache-note');
const cacheClearBtn = el('cache-clear');

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function currentTheater() { return Number(el('theater').value); }
// ONE cache holding the whole extracted tree (both theatres - see worker.js).  With a
// per-theatre cache, 随机 in the 剧场 row could roll a theatre that was not cached yet
// and make the user pick the folder again; a folder pick now extracts both.
function cacheManifestNow() { return cacheInfo.manifest || null; }
function coversTheater(theater) {
  const man = cacheManifestNow();
  if (!man) return false;
  if (!Array.isArray(man.theaters)) return true;      // a manifest from before v2
  return man.theaters.includes(theater);
}
function theaterNames(list) {
  return (list || []).map((n) => (n === 1 ? '雪地' : '温和')).join(' + ') || '未知';
}
// What the generate button needs: either the picked archives (this visit) or a cache
// that covers the theatre the current selection names.
function hasAssets() {
  if (archives !== null) return true;
  const t = currentTheater();
  return Number.isFinite(t) ? coversTheater(t) : !!cacheManifestNow();
}
function refreshGoButton() { if (booted) goBtn.disabled = !hasAssets(); }
function renderCacheNote() {
  const man = cacheManifestNow();
  const name = el('theater').selectedOptions[0]?.textContent || `theater ${currentTheater()}`;
  const pending = cacheInfo.__pending ? '（正在查看缓存……）' : '';
  if (cacheState === 'unsupported') {
    cacheEl.textContent = '这个浏览器不支持本地缓存（OPFS）：每次打开都要重新选一次游戏目录。'
      + '用「选择目录并记住」可以少一步，但浏览器的读取权限不保证跨重启保留。';
    cacheClearBtn.hidden = true;
    refreshGoButton();
    return;
  }
  if (cacheState === 'running') {
    cacheEl.textContent = '正在提取素材（温和 + 雪地）并写入浏览器缓存……'
      + '（十几到几十秒，完成后以后不用再选目录，剧场随便换）';
    cacheClearBtn.hidden = !man;
    refreshGoButton();
    return;
  }
  if (cacheState === 'failed') {
    cacheEl.textContent = `素材已提取，但写缓存失败：${cacheFailReason}`
      + '——生成照常能用，只是下次打开还得再选一次目录。';
    cacheClearBtn.hidden = !man;
    refreshGoButton();
    return;
  }
  if (man) {
    cacheEl.textContent =
      `已缓存素材：${theaterNames(man.theaters)} · ${man.files} 个文件 / ${fmtBytes(man.bytes)} · `
      + `${new Date(man.savedAt).toLocaleString()}`
      + `——本次生成和渲染直接用缓存，不需要游戏目录，也不会要权限，剧场也能随便换。`
      + (coversTheater(currentTheater()) ? ''
         : `（注意：缓存里没有${name}的素材，选一次游戏目录即可补上。）`);
    cacheClearBtn.hidden = false;
    // The remember block is about the File System Access handle, which is now the
    // fallback rather than the normal path - say so instead of "刷新后不用重选",
    // which the cache has already made true on its own.
    if (!rememberEl.hidden) {
      rememberNote.textContent = '想换游戏或换剧场时再选一次目录；平时这一块不用管。';
    }
  } else {
    cacheEl.textContent =
      `尚未缓存素材：选一次游戏目录（温和 + 雪地一起缓存），之后开页面就不用再选了${pending}。`;
    cacheClearBtn.hidden = true;
  }
  refreshGoButton();
}
function askCacheInfo(theater) {
  cacheInfo.__pending = true;
  worker.postMessage({ type: 'cache-info', theater });
}

async function refreshRemember() {
  if (typeof window.showDirectoryPicker !== 'function') return null;   // stays hidden
  rememberEl.hidden = false;
  const handle = await handleGet();
  restoreBtn.hidden = !handle;
  if (handle) restoreName.textContent = handle.name;
  pickRememberLabel.textContent = handle ? '换一个目录' : '选择目录并记住';
  rememberNote.textContent = handle
    ? '目录已记住：刷新或下次打开后，点左侧按钮即可继续使用。'
    : '用这个按钮选的目录会被记住，刷新后不用重选。';
  return handle;
}

// Restore the remembered directory WITHOUT a click, when the browser still allows it.
//
// The handle (which folder) survives in IndexedDB; the PERMISSION to read it is the
// browser's to decide, and it does not always survive a restart.  When it does - the
// same session, or a grant the user chose to persist - queryPermission() answers
// "granted" and there is nothing to ask for, so this reopens the directory silently.
// When it answers "prompt" the click is unavoidable: requestPermission() must run
// inside a user gesture, which is the whole point of the rule (a page must not be able
// to keep reading a disk folder behind the user's back).  So the button stays, and the
// note now says why instead of pretending the click is our choice.
async function tryAutoRestore() {
  const handle = await refreshRemember();
  if (!handle || typeof handle.queryPermission !== 'function') return;
  try {
    const perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      rememberNote.textContent =
        '目录已记住：读取权限要你点一下才能恢复（浏览器的安全限制，页面不能自己申请）。';
      return;
    }
    await useHandle(handle, false);
    restoreBtn.hidden = true;                 // nothing left to restore by hand
    rememberNote.textContent = '已自动恢复上次的目录。';
  } catch (err) {
    // Any failure here (a handle from an older browser, a moved folder) just leaves
    // the manual button in place; it is the path that has always worked.
  }
}

restoreBtn.addEventListener('click', async () => {
  const handle = await handleGet();
  if (!handle) { await refreshRemember(); return; }
  try {
    let perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') {
      rememberNote.textContent = '没有获得读取该目录的权限。';
      return;
    }
    await useHandle(handle, false);
    rememberNote.textContent = '已恢复上次的目录。';
  } catch (err) {
    rememberNote.textContent = `恢复失败：${(err && err.message) || err}`;
  }
});

pickRememberBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'ra2game', mode: 'read' });
    await useHandle(handle, true);
  } catch (err) {
    // AbortError just means the user closed the picker.
    if (err && err.name !== 'AbortError') {
      rememberNote.textContent = `选择失败：${err.message || err}`;
    }
  }
});

refreshRemember();

// ---- 随机: one roll per 随机 control, at generate time ----------------------
//
// The controls stay on 随机 (so the next click rolls again); what was rolled is
// printed in #rolled so the run can be reproduced by typing the values back in.
//
// Order matters: 地图大小 draws from the engine's own table for the (land, players)
// pair the roll just picked, so land and players are rolled first.
// 地图类型 (多人 .yrm / 单人 .map) is deliberately NOT in this list and carries no
// 随机 entry: a roll that produced a .map would hand the user a file the skirmish map
// list does not show.  It stays whatever the user picked (多人 by default), and
// 全随机 leaves it alone.
const ROLL_IDS = ['land', 'time', 'theater', 'players', 'ore', 'symmetry'];
const ROLL_LABEL = { land: '环境', time: '时间', theater: '剧场', players: '玩家数',
                     ore: '矿量', symmetry: '对称' };

function concreteOptions(id) {
  return [...el(id).options]
    .filter((o) => o.value !== RANDOM && !o.disabled)
    .map((o) => o.value);
}

function pickOne(list) { return list[Math.floor(Math.random() * list.length)]; }

function labelOf(id, value) {
  const o = [...el(id).options].find((x) => x.value === value);
  return o ? o.textContent.trim() : String(value);
}

// A size inside the range the engine reports for this (land, players): the roll
// cannot ask for a map the size slider itself could not reach.
function pickSize(land, players) {
  const idx = Math.max(0, Math.min(6, players - 2));
  const useful = (sizeMax && sizeMax[land] && Number.isFinite(sizeMax[land][idx]))
    ? sizeMax[land][idx] : maxUseful();
  const steps = Math.max(1, Math.round(useful / sizeStep));
  return Math.min(useful, Math.round(Math.random() * steps) * sizeStep);
}

function rollParams() {
  const chosen = {};
  const notes = [];
  for (const id of ROLL_IDS) {
    const raw = el(id).value;
    const value = raw === RANDOM ? pickOne(concreteOptions(id)) : raw;
    chosen[id] = value;
    if (raw === RANDOM) notes.push(`${ROLL_LABEL[id]}=${labelOf(id, value)}`);
  }
  let size = null;
  if (sizeMode === 'random') {
    size = pickSize(Number(chosen.land), Number(chosen.players));
    notes.push(`地图大小=${fmtSize(size)}`);
  }
  return { chosen, size, notes };
}

// 全随机: every parameter to 随机 at once.  The seeds already have the engine's own
// spelling for it (0 = roll from the clock / the vanilla constant), so they get 0
// rather than a second way to say 随机.
el('roll-all').addEventListener('click', () => {
  for (const id of ROLL_IDS) el(id).value = RANDOM;
  setSizeMode('random');
  el('seed').value = '0';
  el('map-seed').value = '0';
  syncSize();
  syncSymmetry();
  setStatus('所有可变参数已设为随机（地图类型保持不动）：每次点「生成地图」都会重新抽一套，'
            + '抽到的值会显示在按钮下面。');
});

goBtn.addEventListener('click', () => {
  if (!hasAssets()) {
    showError('还没有可用的素材：选一次游戏目录（之后会缓存起来），或等缓存就绪。');
    return;
  }
  goBtn.disabled = true;
  errorEl.textContent = '';
  logEl.textContent = '';
  resultEl.style.display = 'none';
  setStatus('正在准备……');

  // Everything the user left on 随机 is decided HERE, once per click, and reported
  // in #rolled (the controls themselves stay on 随机, so the next click rolls again).
  const roll = rollParams();
  const single = el('kind').value === '1';      // never rolled, see ROLL_IDS
  const outPath = `/mg/out.${single ? 'map' : 'yrm'}`;
  const rect = (roll.size === null && sizeMode === 'rect') ? clampedRect() : { w: 0, h: 0 };
  const params = {
    land: Number(roll.chosen.land),
    theater: Number(roll.chosen.theater),
    time: Number(roll.chosen.time),
    // A rolled size wins over the slider; the slider is disabled in 随机 mode.
    size: roll.size !== null ? roll.size : Number(el('size').value),
    players: Number(roll.chosen.players),
    ore: Number(roll.chosen.ore),
    water: WATER_FROM_GLOBAL_ROLL,
    seed: Number(el('seed').value) >>> 0,
    mapSeed: Number(el('map-seed').value) >>> 0,
    single,
    // 0/0 tells the engine to use `size`; anything else is an explicit rectangle.
    width: rect.w,
    height: rect.h,
    // 0 = none, 2 = 180° central symmetry (the page's single optional kind).  The
    // engine also implements left-right (1) and top-bottom (3) for the CLI/API;
    // syncSymmetry() disables anything above what the engine reports.
    symmetry: Number(roll.chosen.symmetry) || 0,
    outPath,
  };
  rolledEl.textContent = roll.notes.length ? `本次随机：${roll.notes.join(' · ')}` : '';

  // The picked directory wins when there is one (the user may have switched games);
  // otherwise the cached extraction is rehydrated, which needs no permission at all.
  //
  // Both decisions use the theatre the ROLL produced, not the select: with 随机 in the
  // 剧场 row the two differ, and the cache lookup has to follow the map being made.
  // (They read `params`, so they cannot sit above this line - doing that threw
  // "Cannot access 'params' before initialization" on every click.)
  const fromCache = !archives && coversTheater(params.theater);
  // If the tree already holds this theatre (a folder pick extracts both), do not
  // extract again.
  const needExtract = !!archives && !extractedTheaters.has(params.theater);

  // The worker prepares the asset tree, then reports assets-ready; generation is
  // kicked off from here so the two stages stay individually reportable.
  const onceReady = (event) => {
    const d = event.data || {};
    if (d.type === 'assets-ready') {
      worker.removeEventListener('message', onceReady);
      worker.postMessage({ type: 'generate', params });
    } else if (d.type === 'cache-miss') {
      worker.removeEventListener('message', onceReady);
      showError('浏览器缓存已失效（可能被清理或换了浏览器），请重新选择一次游戏目录。');
      goBtn.disabled = false;
    }
  };
  worker.addEventListener('message', onceReady);
  if (fromCache) {
    setStatus('正在从浏览器缓存恢复素材……');
    worker.postMessage({ type: 'assets-from-cache', theater: params.theater });
  } else if (needExtract) {
    worker.postMessage({ type: 'assets', files: archives, theater: params.theater });
  } else if (archives) {
    // The tree already holds this theatre (picked earlier); straight to generating.
    worker.removeEventListener('message', onceReady);
    worker.postMessage({ type: 'generate', params });
  } else {
    // No directory this visit AND nothing cached for the theatre that was rolled:
    // generating now would run the engine on an empty tree.
    worker.removeEventListener('message', onceReady);
    showError('这个剧场的素材还没有缓存，也没有选择游戏目录：请选一次游戏目录'
              + '（会把温和与雪地一起缓存，之后剧场随便换）。');
    goBtn.disabled = false;
  }
});

// Extraction + cache write, started by picking a directory.  The generate handler
// reuses the result: nothing is re-extracted when the tree already holds this theatre.
function startExtract() {
  const theater = Number(el('theater').value);
  // The theatre select can be on 随机: then there is no theatre to pre-extract, and
  // the generate path extracts the rolled one (and caches it) instead.
  if (!Number.isFinite(theater)) return;
  if (!archives || extractInFlight) return;
  if (extractedTheaters.has(0) && extractedTheaters.has(1)) return;
  extractInFlight = true;
  cacheState = 'running';
  renderCacheNote();
  setStatus('正在提取素材（温和 + 雪地，完成后写入缓存，以后打开就不用再选目录了）……');
  // `all: true` = extract every theatre in one pass, so the cache covers the roll too.
  worker.postMessage({ type: 'assets', files: archives, theater, all: true });
}

// ---- cache controls --------------------------------------------------------
el('theater').addEventListener('change', renderCacheNote);
cacheClearBtn.addEventListener('click', () => {
  cacheClearBtn.disabled = true;
  worker.postMessage({ type: 'cache-clear' });
  setTimeout(() => { cacheClearBtn.disabled = false; }, 1500);
});
renderCacheNote();

worker.postMessage({ type: 'boot' });
setStatus('正在加载引擎……');

function startRender() {
  renderBtn.disabled = true;
  errorEl.textContent = '';
  mark('renderer: asking the worker for the extracted assets');
  setStatus('正在准备渲染……');
  worker.postMessage({ type: 'collect' });
}
renderBtn.addEventListener('click', startRender);

// ---- 设置 drawer: 自动渲染地图 ---------------------------------------------
// A preference, not a generation parameter, so it lives in its own drawer and is
// remembered (localStorage).  With it on, a finished generation starts the render
// itself; the renderer's first run downloads ~15 MB, which is why the switch says so.
const autoRenderEl = el('auto-render');
const settingsEl = el('settings');
const backdropEl = el('settings-backdrop');

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(patch) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch })); }
  catch { /* private mode / storage disabled: the switch still works this session */ }
}
function openSettings(open) {
  settingsEl.hidden = !open;
  backdropEl.hidden = !open;
  if (open) el('settings-close').focus();
}
function renderSettingsNote() {
  el('settings-note').textContent = autoRender
    ? '已开启：每次生成完成后会自动开始渲染预览。'
    : '已关闭：生成后需要手动点「渲染预览」。';
}
autoRender = !!loadSettings().autoRender;
autoRenderEl.checked = autoRender;
renderSettingsNote();
autoRenderEl.addEventListener('change', () => {
  autoRender = autoRenderEl.checked;
  saveSettings({ autoRender });
  renderSettingsNote();
});
el('settings-open').addEventListener('click', () => openSettings(true));
el('settings-close').addEventListener('click', () => openSettings(false));
backdropEl.addEventListener('click', () => openSettings(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsEl.hidden) openSettings(false);
});
