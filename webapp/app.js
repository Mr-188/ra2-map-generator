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
//   Mountainous   5/5  (and byte-identical to Inland)
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
// For 内陆/山地 the two are equal (no clamp, so the slider keeps growing until
// the overlay grid stops it); for the other three sizeMax is 4 and sizeLimit is
// the grid bound, so anything past sizeMax is legal but redundant -- which is
// why the slider's max is sizeMax and the note explains the cap.
let sizeMax = null;
let sizeLimit = null;
let sizeStep = 0.1;        // replaced by the engine's kSizeSliderStep at boot
let rectMaxSum = 495;      // replaced by the engine's MaxRectCellSum() at boot
let symmetryMax = 1;       // replaced by the engine's mg_symmetry_max() at boot
let sizeMode = 'square';   // 'square' (the slider) or 'rect' (explicit 长 × 宽)
// The engine's own cell count for one explicit pair, as { w, h, cells }.  w/h are
// carried so a reply that arrives after the inputs changed can be recognised as
// stale instead of being shown as if it described the current map.
let rectCells = null;

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

function setSizeMode(mode) {
  sizeMode = mode;
  for (const b of sizeModeBox.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.mode === mode);
  }
  sizeInput.hidden = (mode !== 'square');
  rectPair.hidden = (mode !== 'rect');
  syncSize();
}

function syncSize() {
  const land = Number(el('land').value);
  const players = Number(el('players').value);
  const idx = Math.max(0, Math.min(6, players - 2));

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
    sizeOut.value = fmtSize(sizeInput.value);
    return;
  }

  const useful = sizeMax[land] ? sizeMax[land][idx] : Number(sizeInput.max);
  const legal = sizeLimit && sizeLimit[land] ? sizeLimit[land][idx] : useful;

  // Ceiling and step are both the engine's, so the slider cannot offer a value
  // the generator refuses, nor a position that changes nothing.
  sizeInput.step = String(sizeStep);
  sizeInput.max = String(useful);
  if (Number(sizeInput.value) > useful) sizeInput.value = String(useful);

  sizeOut.value = fmtSize(sizeInput.value);
  // Only the three clamped land types need the explanation, and the way to tell
  // them apart needs no land-type knowledge in the page: a clamped map stops
  // growing while the overlay grid is still far away, so its legal bound is
  // hundreds of steps above its useful one.  On Inland/Mountainous the two differ
  // only by the last quantisation step (0.2 at most).  Comparing on that gap is
  // why this text is not shown on a map that does have head-room.
  sizeNote.textContent = (legal - useful) > 1
    ? '地图大小：此环境的最大档由引擎的尺寸插值上限决定；内陆与山地没有这个上限。'
    : '';
}

// The page offers 无 / 左右轴对称.  Anything above what the engine reports gets
// disabled rather than offered and then refused: engine/src/mirror.h derives and
// tests the 180-degree mapping, but the pass does not apply it yet.
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
      if (archives) goBtn.disabled = false;
      break;
    case 'log':
      logEl.textContent += msg.line + '\n';
      logEl.scrollTop = logEl.scrollHeight;
      break;
    case 'progress':
      setStatus(PROGRESS[msg.stage] || '处理中……');
      break;
    case 'assets-ready':
      setStatus('素材已就绪。');
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
  goBtn.disabled = !(archives && booted);
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
  await refreshRemember();
}

async function refreshRemember() {
  if (typeof window.showDirectoryPicker !== 'function') return;   // stays hidden
  rememberEl.hidden = false;
  const handle = await handleGet();
  restoreBtn.hidden = !handle;
  if (handle) restoreName.textContent = handle.name;
  pickRememberLabel.textContent = handle ? '换一个目录' : '选择目录并记住';
  rememberNote.textContent = handle
    ? '目录已记住：刷新或下次打开后，点左侧按钮即可继续使用。'
    : '用这个按钮选的目录会被记住，刷新后不用重选。';
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

goBtn.addEventListener('click', () => {
  if (!archives) return;
  goBtn.disabled = true;
  errorEl.textContent = '';
  logEl.textContent = '';
  resultEl.style.display = 'none';
  setStatus('正在准备……');

  const single = el('kind').value === '1';
  const outPath = `/mg/out.${single ? 'map' : 'yrm'}`;
  const params = {
    land: Number(el('land').value),
    theater: Number(el('theater').value),
    time: Number(el('time').value),
    size: Number(el('size').value),
    players: Number(el('players').value),
    ore: Number(el('ore').value),
    water: WATER_FROM_GLOBAL_ROLL,
    seed: Number(el('seed').value) >>> 0,
    mapSeed: Number(el('map-seed').value) >>> 0,
    single,
    // 0/0 tells the engine to use `size`; anything else is an explicit rectangle.
    width: sizeMode === 'rect' ? clampedRect().w : 0,
    height: sizeMode === 'rect' ? clampedRect().h : 0,
    // 0 = none, 1 = left-right.  180 degrees is derived and tested in
    // engine/src/mirror.h but the pass does not apply it yet, so the page does
    // not offer it; syncSymmetry() disables anything above what the engine says.
    symmetry: Number(el('symmetry').value) || 0,
    outPath,
  };

  worker.postMessage({ type: 'assets', files: archives, theater: params.theater });
  // The worker extracts, then reports assets-ready; generation is kicked off
  // from here so the two stages stay individually reportable.
  const onceReady = (event) => {
    if (event.data && event.data.type === 'assets-ready') {
      worker.removeEventListener('message', onceReady);
      worker.postMessage({ type: 'generate', params });
    }
  };
  worker.addEventListener('message', onceReady);
});

worker.postMessage({ type: 'boot' });
setStatus('正在加载引擎……');

renderBtn.addEventListener('click', () => {
  renderBtn.disabled = true;
  errorEl.textContent = '';
  mark('renderer: asking the worker for the extracted assets');
  setStatus('正在准备渲染……');
  worker.postMessage({ type: 'collect' });
});
