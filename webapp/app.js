// Main-thread UI for the wasm generator.
//
// The archives are handed to the worker as File objects -- structured-cloneable,
// never read here and never uploaded.  The worker slices them on demand with
// FileReaderSync, which is why the engine has to live in a worker at all.
//
// NOTE: no browser has been used to exercise this page yet.  It is written
// against the interface webapp/worker.js exposes; the engine it drives is the
// one tools/verify_wasm.py proves byte-identical to the native oracle.

// 参数集 (the share code) is a pure codec with no DOM, so it lives in its own
// module where node can exercise it: tools/verify_sharebits.mjs.  A static import
// is fine HERE -- this file is loaded as a module; only the WORKER has to stay a
// classic script (the .NET runtime detects its host with `typeof importScripts`).
import { encodeParams, decodeParams, enginePrefix, sizeFromIndex, indexFromSize }
  from './sharebits.js';
// The preview's cell -> pixel transform (the editor page and the ore brush).
// Pure code, exercised by tools/verify_starts.mjs under node.
import { parseCellGrid, pickCell, projectCell } from './starts.js';
// The preview's ore brush: [OverlayPack]/[OverlayDataPack], the map's own ore
// grid.  Pure code, exercised by tools/verify_ore.mjs under node.
import {
  readOverlayGrids, writeOverlayGrids, readOccupiedCells, cellsInRect,
  countSelection, paintMineralCells, clearMineralCells, removeOreDecorations,
  describePillarTarget, placePillar, removePillar,
  classifyCell, CELL_EMPTY, CELL_ORE, CELL_OTHER, overlayIndex,
  ORE_OVERLAY_START, GEM_OVERLAY_START, ORE_DATA, GEM_DATA,
} from './ore.js';
// Neutral tech buildings: [Structures] entries with the game's own types and
// foundations, validated against the same sidecar.
import {
  BUILDING_TYPES, buildingType, describeBuildingPlacement, placeBuilding,
  structureOccupiedCells,
} from './buildings.js';
// The generator -> editor hand-off (separate page, IndexedDB).
import { saveGenerated } from './mapstore.js';

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
const openEditorBtn = el('open-editor');
const oreLayer = el('ore-layer');
const oreBar = el('ore-bar');
const oreHint = el('ore-hint');
const oreMenu = el('ore-menu');
const oreMenuPaint = oreMenu.querySelector('[data-act="paint"]');
const oreMenuGems = oreMenu.querySelector('[data-act="gems"]');
const oreMenuPillar = oreMenu.querySelector('[data-act="pillar"]');
const oreMenuUnpillar = oreMenu.querySelector('[data-act="unpillar"]');
const oreMenuClear = oreMenu.querySelector('[data-act="clear"]');
const oreBuildButtons = {};
for (const t of BUILDING_TYPES) {
  oreBuildButtons[t.id] = oreMenu.querySelector(`[data-act="build-${t.id}"]`);
}

// Object URLs for the two downloads; revoked before being replaced so a session
// that generates many maps does not leak blob storage.
let mapUrl = null;
let previewUrl = null;
let mapBytes = null;      // the renderer runs on this thread and reads these
let rendererRuntime = null;

// ---- 预览图坐标 -----------------------------------------------------------
let cellGrid = null;       // the generator's per-cell level/passability sidecar
let cellGridBytes = null;  // the same sidecar, raw: the editor page needs it
let renderMeta = null;     // the renderer's cell -> pixel transform for the image on screen

// ---- 矿石绘制（see the "ore" section near the bottom）----------------------
const oreEdit = {
  dragging: false,
  rect: null,              // { x0, y0, x1, y1 } in the image's natural pixels
  cells: [],               // the cells whose centres are inside rect
  counts: null,            // green-ore counts for the menu labels
  countsGem: null,         // gem counts (same selection, other family)
  target: null,            // { x, y, info, buildings } under the last right-click
  buildPreview: null,      // building type whose footprint is highlighted
  cache: null,             // { bytes, ids, data, occupied } for mapBytes
};

// The 参数集 of the run that is in flight, and of the map currently on screen.  It
// is built from the CONCRETE values decided at click time (never from the controls,
// whose 随机 entries would be re-decided elsewhere), and revealed together with the
// map -- a failed run must not leave a code behind.
let pendingShare = '';

// What THIS page is, from version.json (tools/package_webapp.sh writes it into a
// packaged site).  A source checkout has no version.json, so all three stay empty
// and every version check below degrades to "cannot tell" instead of guessing.
//   ownVersion  "2026.10.13.2"        -- what the header badge shows
//   ownEngine   the 10 bits a 参数集 carries (sharebits.js enginePrefix)
//   versionList versions.json entries -- {version, path, engine}, what 历史版本 lists
let ownVersion = '';
let ownEngine = 0;
let versionList = [];
// A #p= code seen before the engine reported its tables.  It is applied on `ready`,
// because validating one needs the engine's own numbers: applying it earlier could
// let syncSize() silently clamp the size into a different map.
let pendingHashCode = '';

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

let symmetryMax = 1;       // replaced by the engine's mg_symmetry_max() at boot; the
                           // page offers 无(0) and 左右轴对称(1), so 1 is the value that
                           // has to stay usable - syncSymmetry() disables anything above
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
// theatre -> error, for the theatres a pick could not extract (see assets-ready).
const failedTheaters = new Map();
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

  if (!sizeMax && booted) {          // engine table missing after a successful boot
    // Do NOT name `useful` here: it is computed below, from that table.  This
    // branch used to reference it (a TDZ ReferenceError thrown while app.js was
    // still evaluating, which killed the whole page - the "点生成毫无反应"
    // report of 2026-10-21).  Before boot the widest useful size is the one the
    // rollout text has always quoted: the table's maximum, read leniently.
    if (sizeMode === 'random') {
      const ceiling = Number.isFinite(maxUseful()) ? maxUseful() : 0;
      sizeOut.value = '随机';
      sizeNote.textContent =
        `地图大小：每次生成时在 0..${fmtSize(ceiling)} 之间随机取一个（步长 ${sizeStep}，`
        + `按抽到的环境与玩家数决定上限）。`;
      return;
    }
    sizeOut.value = fmtSize(sizeInput.value);
    return;
  }

  // `sizeMax` arrives as JSON and can be an OBJECT keyed by land type rather
  // than an array.  Indexing it with the numeric `land` then yields null, and the
  // next line's `sizeMax[land][idx]` threw "Cannot read properties of null" on
  // every land-type change (the reported jump between "0" and "1" messages is
  // that null, read once by this function and once by the clamp inside it).
  const pick = (table, i) => {
    if (!table) return null;
    const row = Array.isArray(table) ? table[i] : table[String(i)];
    return row === undefined ? null : row;
  };
  const usable = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const useful = unknown ? maxUseful()
    : (usable(pick(sizeMax, land)) ?? Number(sizeInput.max));
  const legal = unknown ? useful
    : (usable(pick(sizeLimit, land)) ?? useful);

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
  // Two different cases reach here:
  //   * booted with the table  -> the ordinary case, decide from the table's numbers;
  //   * NOT booted yet         -> sizeMax is empty, so `useful` fell back to the
  //                               input's max and the comparison below would be
  //                               meaningless (and used to print the clamped-land
  //                               explanation for EVERY land type at start-up).
  const clampedNote = '地图大小：此环境的最大档由引擎的尺寸插值上限决定；内陆没有这个上限。';
  sizeNote.textContent = !booted ? clampedNote
    : ((legal - useful) > 1 ? clampedNote : '');
}

// The page offers every kind the engine implements: 无 / 左右轴对称 / 上下轴对称 / the
// two 180° halves.  Top-bottom used to be held back because mirror.h's "WHY TOP-BOTTOM
// IS NOT OFFERED" records that multi-cell cliff pieces have no art for that
// orientation; the user looked at the finished maps on 2026-10-21 and asked for it
// anyway (the outline, water and elevation are symmetric; only inland cliff lines keep
// their original facing on one half).  This function still only greys out what the
// ENGINE refuses, so the list and mg_symmetry_max() can never disagree visibly.
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
//
// Wording matters here, and it was wrong until now: this fires on a 20 s timer, which a
// perfectly healthy start can exceed -- 692 KB of wasm compiled on a loaded machine
// (measured 2026-10-14: a false alarm left 失败 + a disabled button on screen while the
// engine was still coming up, and the message pointed at the MIME type).  So it leads
// with the usual cause, then says the honest alternative, and states that the page is
// still waiting -- which it is: `ready` clears this and enables the button (case 'ready').
const bootWatchdog = setTimeout(() => {
  if (!booted) {
    showError('引擎 20 秒还没就绪。常见原因是 mg_engine.js / mg_engine.wasm 没有被正确提供'
              + '（F12 → Network：这两个文件是不是 200，wasm 的类型是不是 application/wasm）。'
              + '如果它们都正常，那就是机器太慢：页面会继续等，就绪后这条会自己消失。');
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
      if (pendingExtract) queueExtractAfterBusy();
      // A 参数集 out of the URL is applied HERE, not at boot: validating one needs
      // the tables just adopted (sizeMax / symmetryMax / rectMaxSum), and applying
      // it earlier would let syncSize() clamp the size into a different map.
      applyUrlShareCode();
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
      // A theatre that failed extraction is remembered, not fatal: the one that
      // worked stays usable (and gets cached), and asking for the missing one says
      // so instead of failing silently at generate time.
      failedTheaters.clear();
      for (const f of (msg.failed || [])) failedTheaters.set(f.theater, f.error);
      if (cacheState === 'running') cacheState = 'idle';
      renderCacheNote();
      if (pendingExtract) { pendingExtract = false; queueExtractAfterBusy(); }
      if (failedTheaters.size) {
        setStatus(`素材部分就绪：${theaterNames([...extractedTheaters])}可用；`
          + `${theaterNames([...failedTheaters.keys()])}提取失败（要这个剧场请再选一次目录）。`, 'err');
      } else {
        setStatus(msg.fromCache
          ? `素材已从浏览器缓存恢复（${theaterNames(msg.theaters)}）。`
          : '素材已就绪（正在写缓存）。');
      }
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
      // A new map invalidates whatever the editor was holding: the cell grid is
      // this map's, and the pixel transform belongs to the image still on screen
      // (it is replaced when the render lands).
      cellGrid = msg.cells ? parseCellGrid(msg.cells) : null;
      cellGridBytes = msg.cells ? new Uint8Array(msg.cells) : null;
      // The transform belongs to the image that is on screen, and that image is
      // this map's PREDECESSOR until the next render lands.  Keeping the old
      // numbers here would mean picking cells with one map's camera and another
      // map's terrain, which is wrong in a way no assertion downstream catches.
      renderMeta = null;
      resetOreEdit();
      refreshOreTools();
      if (mapUrl) URL.revokeObjectURL(mapUrl);
      mapUrl = URL.createObjectURL(new Blob([msg.bytes], { type: 'application/octet-stream' }));
      downloadEl.href = mapUrl;
      downloadEl.download = msg.name;
      openEditorBtn.hidden = !(mapBytes && cellGridBytes);
      el('done').textContent = `${msg.name} · ${(msg.bytes.length / 1024).toFixed(0)} KB`;
      resultEl.style.display = 'block';
      setStatus('完成。', 'ok');
      goBtn.disabled = false;
      // The preview needs its own wasm runtime, so it is a deliberate second
      // step rather than something that happens behind the user's back.
      renderBtn.disabled = false;
      renderBtn.textContent = '渲染预览';
      // The map exists, so the 参数集 that describes it may be shown.  They are
      // revealed together on purpose: see pendingShare.
      showShareCode(pendingShare);
      if (autoRender) {
        mark('settings: 自动渲染地图已开启，生成完成后直接开始渲染');
        startRender();
      }
      break;
    }
    case 'preview': {
      endRenderWatch();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(new Blob([msg.bytes], { type: 'image/png' }));
      previewImg.src = previewUrl;
      previewDl.href = previewUrl;
      previewEl.style.display = 'block';
      previewCap.textContent =
        `用你自己的游戏素材渲染：${msg.assets} 个文件，耗时 ${msg.ms} ms。` +
        `与 CNCMaps 本机渲染逐像素一致。红方块＝出生点（每名玩家一个，来自地图的起点）。`;
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
      refreshOreTools();
      break;
    }
    case 'assets-data':
      await renderOnMainThread(msg);
      break;
    case 'error':
      endRenderWatch();
      extractInFlight = false;
      if (cacheState === 'running') cacheState = 'idle';
      renderCacheNote();
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
    // The renderer's own cell -> pixel transform for THIS image (WebEntry asks
    // for it with --meta-json).  Absent means an older renderer is cached, in
    // which case the ore brush stays off rather than guessing.
    try {
      renderMeta = JSON.parse(new TextDecoder().decode(fs.readFile('/maps/render.json')));
    } catch (err) {
      renderMeta = null;
      mark('预览：渲染器没有给出坐标元数据，放矿工具关闭');
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    previewImg.src = previewUrl;
    previewDl.href = previewUrl;
    previewEl.style.display = 'block';
    previewCap.textContent =
      `用你自己的游戏素材渲染：${copied} 个文件，耗时 ` +
      `${Math.round(performance.now() - started)} ms。与 CNCMaps 本机渲染逐像素一致。`
      + '红方块＝出生点。';
    setStatus('渲染完成。', 'ok');
    renderBtn.disabled = false;
    renderBtn.textContent = '重新渲染';
    refreshOreTools();
    // This path (the main-thread renderer) is what actually runs; it used to leave
    // the 120 s watchdog armed, so a finished image was reported as "渲染超时"
    // two minutes later, on top of the picture.
    endRenderWatch();
  } catch (err) {
    endRenderWatch();
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
  // A NEW pick while an extraction is still running must not be thrown away
  // silently (the old code returned early and the second folder did nothing).
  // The running job is finished first; this pick is extracted right after.
  if (archives && booted) queueExtractAfterBusy();
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
  if (failedTheaters.size) {
    const names = theaterNames([...failedTheaters.keys()]);
    cacheEl.textContent = `素材部分缓存：${theaterNames([...extractedTheaters])}可用；`
      + `${names}这次没提取成功（${[...failedTheaters.values()][0]}）。`
      + '温和/雪地都能生成，但要用' + names + '请先再选一次游戏目录。';
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

// 全局种子's own 随机.  It has to be rolled HERE rather than left to the engine:
// the engine reads seed 0 as "take GetTickCount()" (wasm_entry.cpp:282) and never
// reports which value it used, so a 参数集 built from the controls could not
// reproduce the map.  Rolling it on this side is what every other 随机 control
// already does, and it lets #rolled show the value.
function rollSeed() {
  const buf = new Uint32Array(1);
  for (let i = 0; i < 8; ++i) {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(buf);
    } else {
      buf[0] = (Math.random() * 0x100000000) >>> 0;     // no WebCrypto: still a u32
    }
    if (buf[0] !== 0) return buf[0];                    // 0 means "roll one" again
  }
  return 1;                                            // unreachable, but never 0
}

// A size inside the range the engine reports for this (land, players): the roll
// cannot ask for a map the size slider itself could not reach.
//
// The returned value is SNAPPED to the slider's own grid.  Math.round(...)*step
// carries float noise (7*0.1 is 0.7000000000000001), the engine reads sizeSlider
// as a double in one place (MapGenLAT.cpp:661), and the two are different maps on
// some seeds -- measured: 2 of 200.  A value the slider cannot hold is also a
// value 参数集 cannot carry, so the roll is snapped where it is made.
function pickSize(land, players) {
  const idx = Math.max(0, Math.min(6, players - 2));
  // Same table-shape tolerance as syncSize: an object keyed by land type, a row
  // that is missing, or a not-yet-booted engine all fall back to the widest size
  // instead of throwing inside a click handler.
  const row = (t, i) => (t ? (Array.isArray(t) ? t[i] : t[String(i)]) : undefined);
  const pickUseful = row(sizeMax, land);
  const useful = (Number.isFinite(pickUseful) && pickUseful > 0) ? pickUseful : maxUseful();
  const steps = Math.max(1, Math.round(useful / sizeStep));
  const k = Math.min(steps, Math.round(Math.random() * steps));
  return sizeFromIndex(k, sizeStep);
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
  // The banner asked for exactly this click; it has done its job.
  hideLanding();

  // Everything the user left on 随机 is decided HERE, once per click, and reported
  // in #rolled (the controls themselves stay on 随机, so the next click rolls again).
  const roll = rollParams();
  const single = el('kind').value === '1';      // never rolled, see ROLL_IDS
  const outPath = `/mg/out.${single ? 'map' : 'yrm'}`;
  const rect = (roll.size === null && sizeMode === 'rect') ? clampedRect() : { w: 0, h: 0 };

  // 全局种子 0 = "random", and it is decided here (see rollSeed).  A non-zero value
  // the user typed is used as-is, so typing a seed still reproduces that map.
  const seedInput = Number(el('seed').value) >>> 0;
  const seed = seedInput !== 0 ? seedInput : rollSeed();
  if (seedInput === 0) roll.notes.push(`全局种子=${seed}`);

  // The slider can only hold step multiples, but a dragged value reaches the engine
  // through no arithmetic while a rolled one does; snapping both to the grid makes
  // the value the engine gets the value 参数集 stores (see sharebits.js).
  const size = roll.size !== null
    ? roll.size
    : sizeFromIndex(indexFromSize(Number(el('size').value), sizeStep), sizeStep);

  // 地形种子 0 = 随机, decided here for the same reason as 全局种子: the engine's 0 is
  // "take the fixed vanilla constant 0" and it never reports which value it used, so a
  // 参数集 built from the controls would either not reproduce the map or always
  // reproduce the SAME terrain.  A non-zero value the user typed is used as-is.
  const mapSeedInput = Number(el('map-seed').value) >>> 0;
  const mapSeed = mapSeedInput !== 0 ? mapSeedInput : rollSeed();
  if (mapSeedInput === 0) roll.notes.push(`地形种子=${mapSeed}`);

  const params = {
    land: Number(roll.chosen.land),
    theater: Number(roll.chosen.theater),
    time: Number(roll.chosen.time),
    size,
    players: Number(roll.chosen.players),
    ore: Number(roll.chosen.ore),
    water: WATER_FROM_GLOBAL_ROLL,
    seed,
    mapSeed,
    single,
    // 0/0 tells the engine to use `size`; anything else is an explicit rectangle.
    width: rect.w,
    height: rect.h,
    // mirror.h's MapSymmetry as the page offers it: 0 none, 1 left-right, 2/4 the two
    // 180° halves.  3 (top-bottom) is NOT offered -- mirror.h withdrew it because the
    // tileset has no art for it -- so a 参数集 carrying it is refused below instead of
    // being mapped onto some other kind.  syncSymmetry() disables anything above what
    // the engine reports, so this can only be a kind the run can use.
    symmetry: Number(roll.chosen.symmetry) || 0,
    outPath,
  };
  rolledEl.textContent = roll.notes.length ? `本次随机：${roll.notes.join(' · ')}` : '';
  // Everything the user set is remembered from here (the rolled values are the note
  // above, which is remembered with it).
  saveParams();

  // 参数集: built from the values just decided, so it always describes the run that
  // is about to happen.  It stays hidden until the map exists (the 'map' case), so
  // a failed run cannot leave a code that points at nothing.
  try {
    // `engine` is this build's id (0 = unknown, in a source checkout): it is what
    // lets the receiving page say "this came from another version" before spending
    // a generation, and resolve which version to 历史版本-switch to.
    pendingShare = encodeParams({ ...params, engine: ownEngine },
                                { step: sizeStep, rectMaxSum }).code;
  } catch (err) {
    // Unreachable for the inputs this page can produce -- tools/verify_sharebits.mjs
    // pins every option the <select>s offer.  If it ever happens it is a page bug,
    // and the log says so instead of a code that would not reproduce the map.
    pendingShare = '';
    mark('参数集生成失败: ' + ((err && err.message) || err));
  }
  showShareCode('');            // hoisted; a stale code must not sit next to a new run

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
      // A theatre this pick could not extract: the tree has no tiles for it, so
      // running the engine would produce a map with the wrong theatre's art (or
      // nothing).  Say which one and what to do instead.
      if (!extractedTheaters.has(params.theater)) {
        showError(`${theaterNames([params.theater])}的素材没有提取成功，无法生成这个剧场的地图`
          + '（换一个剧场，或再选一次游戏目录）。');
        goBtn.disabled = false;
        return;
      }
      worker.postMessage({ type: 'generate', params });
    } else if (d.type === 'error') {
      // The extraction-less path can also fail (engine error).  Without this the
      // status stayed on "处理中……" forever and the button stayed dead.
      worker.removeEventListener('message', onceReady);
      showError(d.message || '生成失败');
      goBtn.disabled = false;
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
// Extract as soon as the engine is idle-if-busy or immediately.  Kept small on
// purpose: one pending request is enough, the newest pick wins.
let pendingExtract = false;
function queueExtractAfterBusy() {
  if (!booted) { pendingExtract = true; return; }
  if (extractInFlight) { pendingExtract = true; return; }
  startExtract();
}

function startExtract() {
  pendingExtract = false;
  const theater = Number(el('theater').value);
  // The theatre select can be on 随机: then there is no theatre to pre-extract, and
  // the generate path extracts the rolled one (and caches it) instead.
  if (!Number.isFinite(theater)) return;
  if (!archives || extractInFlight) return;
  if (extractedTheaters.has(0) && extractedTheaters.has(1)) return;
  // A theatre that already failed extraction is retried on the next pick; clear the
  // record so its new outcome (and only that) is reported.
  failedTheaters.clear();
  extractInFlight = true;
  cacheState = 'running';
  renderCacheNote();
  setStatus('正在提取素材（温和 + 雪地，完成后写入缓存，以后打开就不用再选目录了）……');
  // `all: true` = extract every theatre in one pass, so the cache covers the roll too.
  worker.postMessage({ type: 'assets', files: archives, theater, all: true });
}

// ---- the last generated parameters (persisted) ------------------------------
//
// A refresh should not cost the user their setup, so clicking 生成 records the control
// values (plus the note saying what the roll picked, if anything was on 随机) and boot
// puts them back.  What is restored is what the CONTROLS held at that click - a control
// left on 随机 comes back on 随机, because that is the setting the user chose; the
// concrete values of that run are the 上次生成 note, which is restored with it, so the
// map can still be reproduced by typing them in.
//
// A saved value that no longer exists as an option (an option removed in a later
// version) is skipped rather than written into a control that cannot hold it.
const PARAMS_KEY = 'ra2mg.params';
const PERSIST_FIELDS = ['land', 'time', 'theater', 'players', 'ore', 'symmetry',
                        'kind', 'seed', 'map-seed'];

function paramsSnapshot() {
  const controls = {};
  for (const id of PERSIST_FIELDS) controls[id] = el(id).value;
  controls.sizeMode = sizeMode;
  controls.size = String(sizeInput.value);
  controls.rectW = String(rectW.value);
  controls.rectH = String(rectH.value);
  return { controls, rolled: rolledEl.textContent };
}

function saveParams() {
  try { localStorage.setItem(PARAMS_KEY, JSON.stringify(paramsSnapshot())); }
  catch { /* private mode: the page just starts from the defaults next time */ }
}

function restoreParams() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PARAMS_KEY) || 'null'); } catch { saved = null; }
  if (!saved || !saved.controls) return false;
  const c = saved.controls;
  for (const id of PERSIST_FIELDS) {
    const node = el(id);
    const v = c[id];
    if (typeof v !== 'string') continue;
    if (node.options) {
      // A select: only restore a value that still exists as an option.
      if ([...node.options].some((o) => o.value === v)) node.value = v;
    } else if (/^\d+$/.test(v)) {
      // The seed fields are <input type=number>: no options, and a non-numeric value
      // would be rejected by the control anyway.
      node.value = v;
    }
  }
  if (c.sizeMode === 'square' || c.sizeMode === 'rect' || c.sizeMode === 'random') {
    setSizeMode(c.sizeMode);
  }
  if (Number.isFinite(Number(c.size))) sizeInput.value = String(c.size);
  if (Number.isFinite(Number(c.rectW))) rectW.value = String(c.rectW);
  if (Number.isFinite(Number(c.rectH))) rectH.value = String(c.rectH);
  if (typeof saved.rolled === 'string' && saved.rolled) {
    rolledEl.textContent = `上次生成：${saved.rolled.replace(/^本次随机：/, '')}`;
  }
  syncSize();
  syncSymmetry();
  return true;
}

// ---- cache controls --------------------------------------------------------
el('theater').addEventListener('change', renderCacheNote);
cacheClearBtn.addEventListener('click', () => {
  cacheClearBtn.disabled = true;
  worker.postMessage({ type: 'cache-clear' });
  setTimeout(() => { cacheClearBtn.disabled = false; }, 1500);
});
renderCacheNote();
// Put back the parameters of the last generation (see paramsSnapshot) before the engine
// boots, so the page comes up showing the user's setup rather than the defaults.
restoreParams();

worker.postMessage({ type: 'boot' });
setStatus('正在加载引擎……');

// A render that never produces an image used to look like nothing happening: the status
// sat on "正在准备渲染……" and no error ever appeared.  The usual cause is a stale
// renderer bundle in the HTTP cache - the loader and the wasm files are not
// content-hashed, so after an update the page can pair an old dotnet.js with a new
// payload (or the other way round) and the .NET runtime fails to start *silently*.
// (Deployments used to pin /render/_framework/* for 7 days, which made that easy; the
// cache policy is fixed, and this is the belt to that pair of braces.)
const RENDER_WATCHDOG_MS = 120000;
let renderWatchdog = null;
let renderInFlight = false;

// Called by EVERY way a render can finish (the worker's preview message, the
// main-thread renderer, an error).  One definition on purpose: a path that
// finishes without calling this leaves the watchdog to fire later.
function endRenderWatch() {
  renderInFlight = false;
  clearTimeout(renderWatchdog);
}

function startRender() {
  renderBtn.disabled = true;
  errorEl.textContent = '';
  renderInFlight = true;
  mark('renderer: asking the worker for the extracted assets');
  setStatus('正在准备渲染……');
  clearTimeout(renderWatchdog);
  renderWatchdog = setTimeout(() => {
    if (!renderInFlight) return;                  // it finished while we were waiting
    renderInFlight = false;
    renderBtn.disabled = false;
    showError(
      '渲染器 120 秒没有出图。最常见的原因是浏览器缓存里新旧渲染器混用（页面刚更新过就会'
      + '这样）：按 Ctrl+Shift+R 强制刷新，或在开发者工具 Network 里勾上 "Disable cache"'
      + ' 再刷新。另外首次渲染本身要先下载约 15 MB 的渲染器。'
      + '若强制刷新后仍然没有图，请把 F12 控制台里的报错发出来。');
    setStatus('渲染超时。');
  }, RENDER_WATCHDOG_MS);
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

// ---- version badge and the 历史版本 drawer ---------------------------------
// version.json (what this build is) and versions.json (every version the site
// has served) are written at publish time by tools/package_webapp.sh and
// tools/versions.sh.  Neither file exists when the page is opened straight from
// the source tree, so both places degrade to "nothing known" instead of an
// error: a developer's checkout has to be a working page too.
const histEl = el('hist');
const histBackdropEl = el('hist-backdrop');

function openHist(open) {
  histEl.hidden = !open;
  histBackdropEl.hidden = !open;
  if (open) el('hist-close').focus();
}
el('hist-open').addEventListener('click', () => openHist(true));
el('hist-close').addEventListener('click', () => openHist(false));
histBackdropEl.addEventListener('click', () => openHist(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !histEl.hidden) openHist(false);
});

async function readJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;                       // offline, file://, or a source checkout
  }
}

// "2026-10-13T14:12:38+0800" -> "10-13 14:12".  The manifest is written by our
// own tooling, but it is still text off the network: parse it defensively and
// fall back to the raw string rather than printing NaN.
function shortTime(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : (iso || '');
}

(async () => {
  const info = await readJson('./version.json');
  if (info && info.version) {
    const badge = el('ver');
    badge.textContent = info.version;
    badge.title = [
      info.builtAt && `构建于 ${info.builtAt}`,
      info.commit && `提交 ${info.commit}${info.dirty ? '（含未提交改动）' : ''}`,
      info.engine && `引擎 ${info.engine}`,
      info.renderer && `渲染器 ${info.renderer}`,
    ].filter(Boolean).join(' · ');
    badge.hidden = false;
  }
  // What this page IS, for the 参数集 version check: the label the player sees and
  // the 10 bits a code carries.  A source checkout has no version.json, so both stay
  // empty and the check says "cannot tell" instead of guessing.
  ownVersion = (info && info.version) || '';
  ownEngine = enginePrefix(info && info.engine);

  // The manifest lives at the root of the deployment.  A page served from
  // /v/<version>/ therefore does not find it next to itself (archived versions
  // deliberately drop their own copy), which is what the second try is for.
  const man = (await readJson('./versions.json')) || (await readJson('/versions.json'));
  const listEl = el('ver-list');
  const noteEl = el('hist-note');
  // Each entry carries `engine` (tools/versions.sh writes it), which is how a code
  // from another build is turned into "switch to THAT version".
  versionList = (man && Array.isArray(man.versions)) ? man.versions : [];
  // The import note may have been rendered before any of this arrived; re-render it
  // now that the page knows its own engine and the list of published versions.
  shareVersionInfoReady();

  if (!man || !Array.isArray(man.versions) || man.versions.length === 0) {
    noteEl.textContent = '版本列表读不到 —— 本地开发环境没有 versions.json，'
      + '线上会显示已发布过的版本。';
    return;
  }
  if (man.versions.length === 1) {
    noteEl.textContent = `目前只有 ${man.current || man.versions[0].version} 这一个版本；`
      + '下次发布后，这里会出现可以退回去的历史版本。';
    return;
  }
  noteEl.textContent = `共 ${man.versions.length} 个版本，当前 ${man.current || '?'}。`;

  const norm = (p) => (p.endsWith('/') ? p : `${p}/`);
  const here = norm(location.pathname);
  for (const v of man.versions) {
    const a = document.createElement('a');
    a.href = v.path || `/v/${encodeURIComponent(v.version)}/`;
    // Carry the 参数集 across the switch.  Without this the fragment (the code the
    // player is holding) is dropped by the navigation, and the older page comes up
    // with nothing to check -- which is exactly the flow this drawer is being used
    // for.  Done on click, not at build time, because the code can arrive later.
    a.addEventListener('click', () => {
      const hash = location.hash || '';
      const href = a.getAttribute('href') || '';
      if (hash && !href.endsWith(hash)) a.setAttribute('href', href + hash);
    });
    const left = document.createElement('span');
    const title = document.createElement('span');
    title.textContent = v.version;
    left.appendChild(title);
    if (norm(a.pathname) === here) {
      const cur = document.createElement('span');
      cur.className = 'v-cur';
      cur.textContent = '当前';
      left.appendChild(cur);
    }
    if (v.note) {
      const note = document.createElement('span');
      note.className = 'v-note';
      note.textContent = v.note;
      left.appendChild(note);
    }
    const meta = document.createElement('span');
    meta.className = 'v-meta';
    meta.textContent = [shortTime(v.builtAt), v.commit].filter(Boolean).join(' · ');
    a.appendChild(left);
    a.appendChild(meta);

    const li = document.createElement('li');
    li.appendChild(a);
    listEl.appendChild(li);
  }
})();

// ---- 参数集: one string that reproduces the map on screen --------------------
//
// webapp/sharebits.js owns the layout (12 characters for a square map); what lives
// here is the two DOM halves: showing the code of the map that was just made, and
// copying it when it is clicked.  Nothing is uploaded and nothing is stored -- the
// string only leaves the page when the user copies it (red line 2).
//
// Reading a code back (pasting one in) is the next step: the decoder and its tests
// already exist, but no UI is wired to them yet.
const shareEl = el('share');
const shareCodeEl = el('share-code');
const shareNoteEl = el('share-note');
const SHARE_HINT = '点一下复制这串参数集';
let shareNoteTimer = null;

function setShareNote(text, ok = false) {
  shareNoteEl.textContent = text;
  shareNoteEl.classList.toggle('ok', ok);
}

// An empty code hides the block: that is the state before the first map, and the
// state after a run whose parameters could not be encoded (see pendingShare).
function showShareCode(code) {
  const text = String(code || '');
  clearTimeout(shareNoteTimer);
  if (!text) {
    shareEl.hidden = true;
    return;
  }
  shareCodeEl.textContent = text;
  shareEl.hidden = false;
  setShareNote(SHARE_HINT);
}

// document.execCommand is deprecated, but it is the only fallback left when the
// Clipboard API is absent or refused (a page served over plain http on a LAN
// address is not a secure context).  Claiming "已复制" without having copied is the
// one thing this block must not do, so the result is checked and the fallback
// tells the user to press Ctrl+C.
function copyViaSelection(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    return false;
  }
}

function selectShareCode() {
  try {
    const range = document.createRange();
    range.selectNodeContents(shareCodeEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (err) { /* the code is still on screen; selecting it is only a courtesy */ }
}

async function copyShareCode() {
  const text = shareCodeEl.textContent || '';
  if (!text) return;
  let ok = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (err) {
    ok = false;                  // refused: insecure context, or no permission
  }
  if (!ok) ok = copyViaSelection(text);
  if (ok) {
    setShareNote('已复制。发给别人，粘回来就是同一张地图。', true);
  } else {
    selectShareCode();
    setShareNote('这个浏览器不允许自动复制，已帮你选中：按 Ctrl+C 复制。');
  }
  clearTimeout(shareNoteTimer);
  shareNoteTimer = setTimeout(() => setShareNote(SHARE_HINT), 3000);
}

shareCodeEl.addEventListener('click', copyShareCode);

// ---- 导入参数集: paste someone else's code ----------------------------------
//
// Reading a code is the other half of sharing it.  Two entry points, one function:
// the #p=<code> fragment (a link someone sent) and the paste box below the generate
// button.  Both go through the same validation, and neither may silently change a
// value: a code that asks for something this build cannot do is REFUSED with the
// reason, because quietly clamping would hand the player a different map.
//
// The version check is what the engine field is for (sharebits.js): the code says
// which engine made it, this page knows its own from version.json, and when they
// differ the page offers the 历史版本 switch that already exists -- carrying the
// code along in the fragment, so the older page comes up with the same 参数集.
const importCodeEl = el('import-code');
const importNoteEl = el('import-note');
const importSwitchEl = el('import-switch');

// The banner that says a 参数集 just arrived.
const landingEl = el('landing');                // top of the output column
const landingLeadEl = el('landing-lead');
const landingWhatEl = el('landing-what');
const landingGoEl = el('landing-go');
const landingWarnEl = el('landing-warn');
const landingSwitchEl = el('landing-switch');
// What the import box currently describes.  Kept so the note can be RENDERED AGAIN
// when the version information arrives: at boot the page does not yet know which
// engine it is (version.json is a fetch), and a note that said "cannot tell" would
// otherwise stay wrong for the rest of the session.
let lastImported = null;

function setImportNote(text, cls = '') {
  importNoteEl.textContent = text || '';
  importNoteEl.className = `share-note ${cls}`.trim();
}

// The empty-box state, and the only state whose text carries a link.
//
// "Paste the code you were sent" and "where would I get one" are two halves of one
// thought, so they are ONE line: the gallery link lives inside this hint and goes away
// with it.  Every other state (已载入 / 本页做不出来 / 读不出来) replaces the whole line
// with status text -- which is also why the link cannot be a sibling element: its
// visible-conditions would have differed from the hint's (measured: it stayed up under
// "参数集读不出来", next to an error, as if the box were still empty).
//
// Built as nodes rather than innerHTML: this text is constant, and the rule that user
// data never goes through innerHTML is easier to keep than to audit.
const IMPORT_HINT_TAIL = '挑一张现成的：点开哪张，它就带着参数集回到这里。';
function setImportHint() {
  importNoteEl.textContent = '';
  importNoteEl.className = 'share-note';
  importNoteEl.append('粘贴别人发来的参数集，点「载入」还原成同一套参数。没有码？去');
  const a = document.createElement('a');
  a.href = './gallery.html';
  a.textContent = '画廊';
  importNoteEl.append(a, IMPORT_HINT_TAIL);
}
function setImportSwitch(version, path, code) {
  // Two places want the switch: the note under the paste box (where the code was
  // pasted) and the landing banner (where a shared link lands).  One function paints
  // both so they cannot disagree about which version to offer.
  const href = (version && path) ? path + (code ? `#p=${code}` : '') : '';
  const text = version ? `切到 ${version}` : '';
  importSwitchEl.hidden = !href;
  if (href) { importSwitchEl.href = href; importSwitchEl.textContent = text; }
  landingSwitchEl.hidden = !href;
  if (href) { landingSwitchEl.href = href; landingSwitchEl.textContent = text; }
}

// "内陆 · 8 人 · 左右对称 · 尺寸 20" -- labels read out of the page's OWN <select>s
// (labelOf), so the banner cannot drift from the controls the code just filled in.
//
// One exception: the <select> says 无 for 对称 0, which reads fine with the field label
// in front of it but is ambiguous in a standalone list ("... 2 人 · 无 · 尺寸 1" -- 无
// what?).  The gallery's chips spell it 无对称, and the two pages describing the same
// parameters with the same words is worth more than reusing the option text here.
function describeParams(code) {
  const size = code.width > 0 ? `${code.width} × ${code.height}` : `尺寸 ${fmtSize(code.size)}`;
  const sym = code.symmetry === 0 ? '无对称' : labelOf('symmetry', String(code.symmetry));
  return [labelOf('land', String(code.land)), `${code.players} 人`, sym, size].join(' · ');
}

function setLandingWarn(origin) {
  const warn = origin && (origin.kind === 'other' || origin.kind === 'other-pruned')
    ? origin.text : '';
  landingWarnEl.textContent = warn;
  landingWarnEl.hidden = !warn;
}

function hideLanding() {
  landingEl.hidden = true;
}

// Shown whenever a 参数集 was applied (a shared link, a gallery card, or a paste).
function showLanding(code, origin) {
  landingEl.classList.remove('bad');
  landingLeadEl.textContent = '已载入参数集';
  landingWhatEl.textContent = describeParams(code);
  landingGoEl.hidden = false;
  setLandingWarn(origin);
  landingEl.hidden = false;
}

// A code this build cannot make is the case that most needs to be LOUD.  The reason
// belongs where the eye is, not only in the small note under the paste box -- and the
// one way out (an older build that could still make it) is what the switch is for.
// This is not a "loaded" banner: nothing was loaded, so it does not say so.
function showLandingRefusal(reason, origin) {
  landingEl.classList.add('bad');
  landingLeadEl.textContent = `这条参数集本站做不出来：${reason}`;
  landingWhatEl.textContent = '';
  landingGoEl.hidden = true;
  setLandingWarn(origin);
  landingEl.hidden = false;
}

/** The version whose engine hash starts with this prefix, or null. */
function versionForEngine(prefix) {
  if (!prefix) return null;                   // 0 = "the sender could not say"
  return versionList.find((v) => v && enginePrefix(v.engine) === prefix) || null;
}

// Is this code from the engine that is running here?  Returns what to say about it,
// and never claims "same" unless it knows: a page without version.json (a source
// checkout) cannot tell, and says so.
function describeShareOrigin(code) {
  if (!ownEngine) {
    return { kind: 'unknown-self', text: '（本站没有 version.json，无法核对引擎版本）' };
  }
  if (!code.engine) {
    return { kind: 'unknown-theirs', text: '（发送方没带版本信息，无法核对）' };
  }
  if (code.engine === ownEngine) {
    return { kind: 'same', text: `引擎与本站 ${ownVersion || ''} 相同，参数一样就能生成同一张地图。` };
  }
  const target = versionForEngine(code.engine);
  const mine = ownVersion ? `本页是 ${ownVersion}，` : '';
  if (!target) {
    return { kind: 'other-pruned',
             text: `${mine}而这串来自另一个引擎版本（本站已不再保留它）：生成的图可能不一样。` };
  }
  return { kind: 'other', target,
           text: `${mine}而这串来自 ${target.version}（引擎不同）：直接生成可能不是同一张地图。` };
}

// Write a decoded code into the controls.  Throws (and changes NOTHING) when this
// build cannot produce what the code asks for.
//
// Two phases on purpose: a half-applied form is worse than a refusal, because it
// would then generate a map that neither side asked for -- and the player has no way
// to see that it happened.  (Measured: written the other way round, a refused code
// left land/players/seed from the code and the size from before.)
function applyDecodedShare(code) {
  const selects = [
    ['land', code.land], ['theater', code.theater], ['time', code.time],
    ['players', code.players], ['ore', code.ore], ['symmetry', code.symmetry],
    ['kind', code.single ? 1 : 0],
  ];

  // ---- 1. validate ---------------------------------------------------------
  if (code.symmetry > symmetryMax) {
    throw new Error(`这串用的对称是 ${code.symmetry}，本站的实现只到 ${symmetryMax}`);
  }
  for (const [id, value] of selects) {
    const wanted = String(value);
    if (![...el(id).options].some((o) => o.value === wanted)) {
      throw new Error(`${id} 的这个取值（${wanted}）本页没有`);
    }
  }
  if (code.width > 0) {
    if (code.width + code.height > rectMaxSum) {
      throw new Error(`这串的长宽 ${code.width}x${code.height} 超过本站引擎的 ${rectMaxSum}`);
    }
  } else {
    // The code stores the slider INDEX, so this is exact: the value it decodes to is
    // the value the range input itself holds for that index (sharebits.js header).
    // Checking it against the engine's table first is what keeps syncSize() from
    // clamping it into a different map.
    const idx = Math.max(0, Math.min(6, code.players - 2));
    const row = (t, i) => (t ? (Array.isArray(t) ? t[i] : t[String(i)]) : undefined);
    const pickUseful = row(sizeMax, code.land);
    const useful = (Number.isFinite(pickUseful) && pickUseful > 0) ? pickUseful : maxUseful();
    const maxK = Math.round(useful / sizeStep);
    if (code.index > maxK) {
      throw new Error(`这串的尺寸（第 ${code.index} 档）超过本站引擎给这个环境的 ${maxK} 档`);
    }
  }

  // ---- 2. commit -----------------------------------------------------------
  for (const [id, value] of selects) el(id).value = String(value);
  el('seed').value = String(code.seed);          // never 0: the codec refuses that
  el('map-seed').value = String(code.mapSeed);
  if (code.width > 0) {
    rectW.value = String(code.width);
    rectH.value = String(code.height);
    setSizeMode('rect');
  } else {
    setSizeMode('square');
    sizeInput.value = String(code.size);
  }
  syncSize();
  syncSymmetry();
  saveParams();          // a refresh keeps the imported setup
}

// Paint the import note and the 切换 link from lastImported.  Split out from
// applyShareCode so it can run again when version.json arrives (shareVersionInfoReady).
function renderImportNote() {
  if (!lastImported) {
    setImportHint();          // the one state whose line carries the gallery link
    setImportSwitch('', '', '');
    return;
  }
  const { code, raw, fromLink, refusal } = lastImported;
  const origin = describeShareOrigin(code);
  if (refusal) {
    setImportNote(`参数集读出来了，但本页做不出它要的参数：${refusal}`, 'err');
  } else {
    setImportNote(`已载入参数集${fromLink ? '（来自链接）' : ''}。${origin.text}`
                  + (origin.kind === 'same' ? '点「生成地图」即可。' : ''));
  }
  // Offer the switch whenever the code came from another engine -- and especially
  // when this build refused its parameters, which is the case that other build can
  // very likely handle.
  if (origin.kind === 'other') setImportSwitch(origin.target.version, origin.target.path, raw);
  else setImportSwitch('', '', '');
  // The banner may be up already, and version.json can land AFTER it was painted;
  // then the warning it shows would say "cannot tell" for the rest of the session.
  if (!landingEl.hidden) setLandingWarn(origin);
}

/** Called once version.json / versions.json have landed (see the loader at the end). */
function shareVersionInfoReady() {
  if (lastImported) renderImportNote();
}

// Returns true when the code was applied.
function applyShareCode(raw, { fromLink = false } = {}) {
  const text = String(raw || '').trim();
  if (!text) {
    lastImported = null;
    renderImportNote();
    hideLanding();
    return false;
  }
  let code = null;
  try {
    code = decodeParams(text, { step: sizeStep, rectMaxSum });
  } catch (err) {
    lastImported = null;
    setImportSwitch('', '', '');
    setImportNote(`参数集读不出来：${(err && err.message) || err}`, 'err');
    hideLanding();
    return false;
  }
  importCodeEl.value = text;
  try {
    applyDecodedShare(code);
  } catch (err) {
    // Nothing was changed: applyDecodedShare validates before it writes.  Say why in
    // both places -- the small note (next to the box, where the switch link lives for
    // a paste) and the banner (where a shared link lands).
    const refusal = (err && err.message) || String(err);
    lastImported = { code, raw: text, fromLink, refusal };
    renderImportNote();
    showLandingRefusal(refusal, describeShareOrigin(code));
    return false;
  }
  lastImported = { code, raw: text, fromLink, refusal: '' };
  renderImportNote();
  // The loud half: what was loaded, and that one click is all that is left.
  showLanding(code, describeShareOrigin(code));
  // The map on screen (if any) belongs to the PREVIOUS controls, so its code must
  // not keep sitting there as if it described what is now in the form.
  showShareCode('');
  return true;
}

function applyUrlShareCode() {
  if (!pendingHashCode) return;
  const code = pendingHashCode;
  pendingHashCode = '';
  applyShareCode(code, { fromLink: true });
}

function readHashCode() {
  // #p=<code>.  Kept in the fragment on purpose: a query string would be sent to
  // the host and land in its logs (red line 2 -- nothing leaves the machine).
  const m = /(?:^|[#&])p=([A-Za-z0-9_-]+)/.exec(location.hash || '');
  return m ? m[1] : '';
}

el('import-go').addEventListener('click', () => applyShareCode(importCodeEl.value));
importCodeEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); applyShareCode(importCodeEl.value); }
});
importCodeEl.addEventListener('paste', () => {
  // The pasted text lands after this event returns; one task later is soon enough
  // to load it without the user also having to press 载入.
  setTimeout(() => {
    const v = importCodeEl.value.trim();
    if (v.length >= 13) applyShareCode(v);      // shorter than the layout: not a code
  }, 0);
});
window.addEventListener('hashchange', () => {
  const code = readHashCode();
  if (code) { importCodeEl.value = code; applyShareCode(code, { fromLink: true }); }
});

// The fragment is read at boot but APPLIED on `ready` (see the ready case), so the
// validation above has the engine's tables to check against.
pendingHashCode = readHashCode();
if (pendingHashCode) importCodeEl.value = pendingHashCode;
setImportHint();
el('landing-close').addEventListener('click', hideLanding);

// ===========================================================================
// 矿石绘制（ore painting）
//
// The map file is byte-oriented; latin1 is the 1:1 decode that lets the edited
// text be re-encoded without touching a byte we did not mean to change.
function decodeLatin1(bytes) {
  return new TextDecoder('latin1').decode(bytes);
}
function encodeLatin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; ++i) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** One cell diamond, in CSS pixels, around a natural-pixel centre. */
function diamond(ctx, cx, cy, hw, hh) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx + hw, cy);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy);
  ctx.closePath();
}

//
// 生成并渲染之后，在预览图上拖一个框，右击选「放矿石」，框里所有"可放"的
// 空地就铺上矿石；写回的是地图文件自己的 [OverlayPack]/[OverlayDataPack]，
// 然后重新出图。 和出生点编辑一样，这里不猜任何地形：
//
//   * 格子能不能放，问生成器随图导出的 <out>.cells（可通行性 + 建筑地基位），
//     再加上地图自己的 overlay / [Terrain] / [Structures] 占用；
//   * 框选落在哪些格子，用渲染器发布的 cell -> pixel 变换反算（starts.js）。
//
// 矿石自己的格式、id 和"生长阶段"全部写在 webapp/ore.js 的抬头里，那份
// 逻辑由 tools/verify_ore.mjs 用 node 驱动，也在真实渲染器上对过像素。
// ===========================================================================

function resetOreEdit() {
  oreEdit.dragging = false;
  oreEdit.rect = null;
  oreEdit.cells = [];
  oreEdit.counts = null;
  oreEdit.target = null;
  oreEdit.buildPreview = null;
  oreEdit.cache = null;
  hideOreMenu();
}

function setOreHint(text, tone) {
  oreHint.textContent = text;
  oreHint.className = tone || '';
}

/** The map's overlay grids, decoded once per mapBytes value. */
function ensureOreContext() {
  if (!mapBytes) return null;
  if (oreEdit.cache && oreEdit.cache.bytes === mapBytes) return oreEdit.cache;
  const text = decodeLatin1(mapBytes);
  const grids = readOverlayGrids(text);
  if (!grids) {
    oreEdit.cache = null;
    return null;
  }
  // The sidecar knows every foundation the generator placed; buildings this
  // page adds exist only in [Structures], so merge their footprints in as well
  // (otherwise ore could be painted under a building placed a minute ago).
  const occupied = readOccupiedCells(text);
  for (const index of structureOccupiedCells(text)) occupied.add(index);
  oreEdit.cache = {
    bytes: mapBytes,
    ids: grids.ids,
    data: grids.data,
    occupied,
  };
  return oreEdit.cache;
}

/** Shows or hides the ore bar according to what is actually available. */
function refreshOreTools() {
  const ctx = (cellGrid && renderMeta && mapBytes) ? ensureOreContext() : null;
  const ready = !!ctx;
  oreBar.classList.toggle('on', ready);
  oreLayer.hidden = !ready;
  if (!ready) {
    hideOreMenu();
    oreEdit.rect = null;
    oreEdit.cells = [];
    oreEdit.counts = null;
    setOreHint('');
    return;
  }
  sizeOreLayer();
  drawOre();
  if (!oreEdit.rect) {
    setOreHint('在预览图上拖拽框选一片区域，或直接在格子上右击：放矿石 / 放彩矿 / 放矿柱。');
  }
}

function sizeOreLayer() {
  const dpr = window.devicePixelRatio || 1;
  const w = oreLayer.clientWidth;
  const h = oreLayer.clientHeight;
  if (!w || !h) return;
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (oreLayer.width !== bw) oreLayer.width = bw;
  if (oreLayer.height !== bh) oreLayer.height = bh;
}

/** The canvas covers the image's content box (the image has a 1px border). */
function toNaturalOre(event) {
  const rect = oreLayer.getBoundingClientRect();
  const nw = previewImg.naturalWidth;
  const nh = previewImg.naturalHeight;
  if (!rect.width || !rect.height || !nw || !nh) return null;
  return {
    x: (event.clientX - rect.left) * nw / rect.width,
    y: (event.clientY - rect.top) * nh / rect.height,
  };
}

function clampNatural(point) {
  const nw = previewImg.naturalWidth || 0;
  const nh = previewImg.naturalHeight || 0;
  return {
    x: Math.max(0, Math.min(nw, point.x)),
    y: Math.max(0, Math.min(nh, point.y)),
  };
}

function addDiamond(path, cx, cy, hw, hh) {
  path.moveTo(cx, cy - hh);
  path.lineTo(cx + hw, cy);
  path.lineTo(cx, cy + hh);
  path.lineTo(cx - hw, cy);
  path.closePath();
}

function drawOre() {
  if (oreLayer.hidden || !previewImg.naturalWidth) return;
  const ctx = oreLayer.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = oreLayer.clientWidth;
  const h = oreLayer.clientHeight;
  if (!w || !h) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const s = w / previewImg.naturalWidth;
  const hw = (renderMeta.tileWidth / 2) * s;
  const hh = (renderMeta.tileHeight / 2) * s;

  // The cell the menu's 矿柱 action would use.  Green/red says whether it can
  // take one before the user commits.  Drawn last (below) so the selection fill
  // cannot hide it.
  const drawTarget = () => {
    if (!oreEdit.target) return;
    const t = oreEdit.target;
    const p = projectCell(cellGrid, renderMeta, t.x, t.y);
    diamond(ctx, p.x * s, p.y * s, hw, hh);
    ctx.fillStyle = t.info.ok ? 'rgba(242,192,105,.45)' : 'rgba(224,133,122,.45)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = t.info.ok ? '#f2c069' : '#e0857a';
    ctx.stroke();
  };

  if (!oreEdit.rect) { drawTarget(); return; }
  const r = oreEdit.rect;
  const x0 = Math.min(r.x0, r.x1) * s;
  const x1 = Math.max(r.x0, r.x1) * s;
  const y0 = Math.min(r.y0, r.y1) * s;
  const y1 = Math.max(r.y0, r.y1) * s;

  // While dragging only the rubber band is drawn: painting thousands of cell
  // diamonds on every pointermove is the one thing that would make the drag lag.
  if (!oreEdit.dragging && oreEdit.cells.length) {
    const cache = ensureOreContext();
    if (cache) {
      const tw = (renderMeta.tileWidth / 2) * s;
      const th = (renderMeta.tileHeight / 2) * s;
      const emptyPath = new Path2D();
      const orePath = new Path2D();
      const otherPath = new Path2D();
      for (const cell of oreEdit.cells) {
        const kind = classifyCell(cellGrid, cache.ids, cache.occupied, cell.x, cell.y);
        if (kind !== CELL_EMPTY && kind !== CELL_ORE && kind !== CELL_OTHER) continue;
        const p = projectCell(cellGrid, renderMeta, cell.x, cell.y);
        const path = kind === CELL_ORE ? orePath : (kind === CELL_OTHER ? otherPath : emptyPath);
        addDiamond(path, p.x * s, p.y * s, tw, th);
      }
      ctx.fillStyle = 'rgba(242,192,105,.34)';
      ctx.fill(emptyPath);
      ctx.fillStyle = 'rgba(126,214,120,.32)';
      ctx.fill(orePath);
      ctx.fillStyle = 'rgba(130,150,240,.34)';
      ctx.fill(otherPath);
    }
  }

  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(242,192,105,.95)';
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.setLineDash([]);

  // Hovering a building item in the menu shows exactly which cells its
  // foundation would cover (and whether that foundation is valid).
  const preview = oreEdit.buildPreview;
  const target = oreEdit.target;
  if (preview && target && target.buildings && target.buildings[preview.id]) {
    const info = target.buildings[preview.id];
    const tw = (renderMeta.tileWidth / 2) * s;
    const th = (renderMeta.tileHeight / 2) * s;
    for (const cell of info.cells) {
      const p = projectCell(cellGrid, renderMeta, cell.x, cell.y);
      diamond(ctx, p.x * s, p.y * s, tw, th);
      ctx.fillStyle = info.ok ? 'rgba(120,170,255,.38)' : 'rgba(224,133,122,.38)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = info.ok ? 'rgba(190,220,255,.9)' : 'rgba(240,160,150,.9)';
      ctx.stroke();
    }
  }
  drawTarget();
}

/** Recomputes the selected cells and what each one offers (menu labels). */
function refreshOreSelection() {
  const cache = ensureOreContext();
  if (!cache || !oreEdit.rect) {
    oreEdit.cells = [];
    oreEdit.counts = null;
    return;
  }
  oreEdit.cells = cellsInRect(cellGrid, renderMeta, oreEdit.rect);
  oreEdit.counts = countSelection(cellGrid, cache.ids, cache.occupied, oreEdit.cells);
  const c = oreEdit.counts;
  if (!c.total) {
    setOreHint('框选区域里没有格子。', 'bad');
    return;
  }
  const tone = c.empty || c.ore || c.other ? 'ok' : 'bad';
  setOreHint(`已框选 ${c.total} 格：可放矿石 ${c.empty} 格，已有矿石 ${c.ore} 格`
           + (c.other ? `，其他矿 ${c.other} 格` : '')
           + `，不可放 ${c.blocked} 格。右击选「放矿石 / 放彩矿 / 放矿柱」。`, tone);
}

function clearOreSelection() {
  oreEdit.rect = null;
  oreEdit.cells = [];
  oreEdit.counts = null;
  hideOreMenu();
  drawOre();
  setOreHint('在预览图上拖拽框选一片区域，或在格子上右击选「放矿柱」。');
}

function showOreMenu(clientX, clientY) {
  const c = oreEdit.counts;
  const t = oreEdit.target;
  const empty = c ? c.empty : 0;
  oreMenuPaint.textContent = `放矿石（${empty} 格）`;
  oreMenuPaint.disabled = empty === 0;
  oreMenuGems.textContent = `放彩矿（${empty} 格）`;
  oreMenuGems.disabled = empty === 0;

  const minerals = c ? c.ore + c.other : 0;
  oreMenuClear.textContent = `清除矿（${minerals} 格）`;
  oreMenuClear.disabled = minerals === 0;

  if (t) {
    oreMenuPillar.textContent = `放矿柱（${t.x}, ${t.y}）`;
    oreMenuPillar.disabled = !t.info.ok || t.info.isPillar;
    oreMenuPillar.title = t.info.ok
      ? (t.info.isPillar ? '这格已经是矿柱' : (t.info.existing ? `会替换 ${t.info.existing}` : '空地'))
      : t.info.reason;
    oreMenuUnpillar.textContent = `移除矿柱（${t.x}, ${t.y}）`;
    oreMenuUnpillar.disabled = !t.info.isPillar;
    oreMenuUnpillar.title = t.info.isPillar ? `移除 ${t.info.existing}` : '这格没有矿柱';
  } else {
    oreMenuPillar.textContent = '放矿柱（在格子上右击）';
    oreMenuPillar.disabled = true;
    oreMenuPillar.title = '';
    oreMenuUnpillar.textContent = '移除矿柱';
    oreMenuUnpillar.disabled = true;
    oreMenuUnpillar.title = '';
  }

  for (const type of BUILDING_TYPES) {
    const button = oreBuildButtons[type.id];
    const info = t && t.buildings ? t.buildings[type.id] : null;
    button.textContent = `放${type.short}（${type.width}×${type.height}）`;
    button.disabled = !info || !info.ok;
    button.title = info
      ? (info.ok
        ? `${type.full} · ${type.role}；会清掉地基上的矿/树`
        : info.reason)
      : '先在格子上右击';
  }

  oreMenu.hidden = false;
  const box = oreMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(clientX, window.innerWidth - box.width - 8));
  const top = Math.max(8, Math.min(clientY, window.innerHeight - box.height - 8));
  oreMenu.style.left = `${left}px`;
  oreMenu.style.top = `${top}px`;
}

function hideOreMenu() {
  oreMenu.hidden = true;
  oreEdit.buildPreview = null;
  if (oreEdit.target) {
    oreEdit.target = null;
    if (!oreLayer.hidden) drawOre();
  }
}

/** Replaces mapBytes with an edited text and refreshes the download link. */
function commitMapText(text) {
  mapBytes = encodeLatin1(text);
  if (mapUrl) URL.revokeObjectURL(mapUrl);
  mapUrl = URL.createObjectURL(new Blob([mapBytes], { type: 'application/octet-stream' }));
  downloadEl.href = mapUrl;
  oreEdit.cache = null;
  refreshOreSelection();
  drawOre();
}

/** Paints one mineral family (ore 102..113 or gems 27..38) into the selection. */
function applyMineralEdit(family, label) {
  const cache = ensureOreContext();
  if (!cache || !oreEdit.rect || !oreEdit.cells.length) return;
  const text = decodeLatin1(mapBytes);
  // Fresh arrays on purpose: the cached grids belong to the map on disk, and a
  // failed write below must not leave them half-painted.
  const grids = readOverlayGrids(text);
  if (!grids) { setOreHint('这张地图没有 [OverlayPack]，不能放矿。', 'bad'); return; }

  const result = paintMineralCells({
    grid: cellGrid, cells: oreEdit.cells,
    ids: grids.ids, data: grids.data, occupied: cache.occupied,
    family, stage: family === GEM_OVERLAY_START ? GEM_DATA : ORE_DATA,
  });
  if (!result.painted) {
    setOreHint(`选区里没有可放${label}的空地。`, 'bad');
    return;
  }

  const next = writeOverlayGrids(text, grids.ids, grids.data);
  if (next === null) {
    setOreHint('写回 [OverlayPack] 失败，地图没有改动。', 'bad');
    return;
  }
  commitMapText(next);
  let detail = `${result.existing} 格已有${label}`;
  if (result.other) detail += `，${result.other} 格其他矿`;
  detail += `，${result.blocked} 格不可放`;
  setOreHint(`已放 ${result.painted} 格${label}（${detail}），正在重新出图……`, 'ok');
  mark(`ore: 已放 ${result.painted} 格${label}（${detail}），重新出图`);
  // 地图变了，参数集没变 —— 和出生点编辑同一条规矩：分享码描述生成输入，
  // 不描述生成后的手工编辑。
  startRender();
}

/** Clears any tiberium (green ore and gems) from the selection. */
function applyClearMinerals() {
  const cache = ensureOreContext();
  if (!cache || !oreEdit.rect || !oreEdit.cells.length) return;
  const text = decodeLatin1(mapBytes);
  const grids = readOverlayGrids(text);
  if (!grids) { setOreHint('这张地图没有 [OverlayPack]，不能清矿。', 'bad'); return; }

  const result = clearMineralCells({ cells: oreEdit.cells, ids: grids.ids, data: grids.data });
  if (!result.cleared) { setOreHint('选区里没有矿。', 'bad'); return; }

  let next = writeOverlayGrids(text, grids.ids, grids.data);
  if (next === null) {
    setOreHint('写回 [OverlayPack] 失败，地图没有改动。', 'bad');
    return;
  }
  // 清矿时把矿柱装饰树（TIBTRE）一起收掉：它们是矿石的附属物，留在草地上
  // 就是悬空的树。 放矿不添加装饰树（overlay 本身已经能画）。
  next = removeOreDecorations(next, result.packed);
  commitMapText(next);
  setOreHint(`已清除 ${result.cleared} 格矿，正在重新出图……`, 'ok');
  mark(`ore: 已清除 ${result.cleared} 格矿，重新出图`);
  startRender();
}

/** The single-cell 放矿柱 action.  `target` is captured before the menu closes. */
function applyPillar(target) {
  const cache = ensureOreContext();
  if (!cache || !target) return;
  const text = decodeLatin1(mapBytes);
  const grids = readOverlayGrids(text);
  if (!grids) { setOreHint('这张地图没有 [OverlayPack]。', 'bad'); return; }

  const result = placePillar({
    grid: cellGrid, text, ids: grids.ids, data: grids.data,
    x: target.x, y: target.y,
  });
  if (!result.ok) { setOreHint(result.reason, 'bad'); return; }
  if (!result.changed) {
    setOreHint(`(${target.x}, ${target.y}) 已经是 ${result.name}。`, 'ok');
    return;
  }

  let next = result.removedOverlay !== null
    ? writeOverlayGrids(result.text, grids.ids, grids.data)
    : result.text;
  if (next === null) { setOreHint('写回地图失败，地图没有改动。', 'bad'); return; }

  let extra = '';
  if (result.removedObject) extra += `，替换了 ${result.removedObject}`;
  if (result.removedOverlay !== null) extra += `，去掉了 overlay ${result.removedOverlay}`;
  commitMapText(next);
  setOreHint(`已在 (${target.x}, ${target.y}) 放了 ${result.name}${extra}，正在重新出图……`, 'ok');
  mark(`ore: 矿柱 ${result.name} @ (${target.x}, ${target.y})${extra}，重新出图`);
  startRender();
}

/** Places one neutral tech building at the captured target cell. */
function applyBuilding(typeId, target) {
  const type = buildingType(typeId);
  const cache = ensureOreContext();
  if (!type || !cache || !target) return;
  const text = decodeLatin1(mapBytes);
  const grids = readOverlayGrids(text);
  if (!grids) { setOreHint('这张地图没有 [OverlayPack]。', 'bad'); return; }
  const structures = structureOccupiedCells(text);

  const result = placeBuilding({
    grid: cellGrid, text, ids: grids.ids, data: grids.data,
    type, x: target.x, y: target.y, occupied: structures,
  });
  if (!result.ok) { setOreHint(result.reason, 'bad'); return; }

  let next = result.clearedOverlays > 0
    ? writeOverlayGrids(result.text, grids.ids, grids.data)
    : result.text;
  if (next === null) { setOreHint('写回地图失败，地图没有改动。', 'bad'); return; }

  let extra = '';
  if (result.clearedOverlays) extra += `，清掉 ${result.clearedOverlays} 格 overlay`;
  if (result.removedObjects.length) extra += `，去掉 ${result.removedObjects.length} 个地形对象`;
  commitMapText(next);
  setOreHint(`已在 (${target.x}, ${target.y}) 放了${type.short}（${type.full}）`
    + `${extra}，正在重新出图……`, 'ok');
  mark(`ore: 已放中立建筑 ${type.id} @ (${target.x}, ${target.y})${extra}，重新出图`);
  startRender();
}

/** Removes a TIBTRE from the cell (other [Terrain] objects stay). */
function applyRemovePillar(target) {
  if (!target) return;
  const text = decodeLatin1(mapBytes);
  const result = removePillar({ text, x: target.x, y: target.y });
  if (!result.changed) {
    setOreHint(result.reason || `(${target.x}, ${target.y}) 没有矿柱。`, 'bad');
    return;
  }
  commitMapText(result.text);
  setOreHint(`已移除 (${target.x}, ${target.y}) 的 ${result.removed}，正在重新出图……`, 'ok');
  mark(`ore: 已移除矿柱 ${result.removed} @ (${target.x}, ${target.y})，重新出图`);
  startRender();
}

oreLayer.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const p = toNaturalOre(event);
  if (!p) return;
  hideOreMenu();
  const q = clampNatural(p);
  oreEdit.dragging = true;
  oreEdit.rect = { x0: q.x, y0: q.y, x1: q.x, y1: q.y };
  oreEdit.cells = [];
  oreEdit.counts = null;
  try { oreLayer.setPointerCapture(event.pointerId); } catch (err) { /* no capture */ }
  drawOre();
  event.preventDefault();
});

oreLayer.addEventListener('pointermove', (event) => {
  if (!oreEdit.dragging) return;
  const p = toNaturalOre(event);
  if (!p) return;
  const q = clampNatural(p);
  oreEdit.rect = { x0: oreEdit.rect.x0, y0: oreEdit.rect.y0, x1: q.x, y1: q.y };
  drawOre();
});

oreLayer.addEventListener('pointerup', (event) => {
  if (!oreEdit.dragging) return;
  oreEdit.dragging = false;
  try { oreLayer.releasePointerCapture(event.pointerId); } catch (err) { /* not captured */ }
  const r = oreEdit.rect;
  if (!r) return;
  const dragged = Math.hypot(r.x1 - r.x0, r.y1 - r.y0);
  // A click is not a box: clearing is the least surprising answer, and it gives
  // the user a way out without opening the menu.
  if (dragged < 4) { clearOreSelection(); return; }
  refreshOreSelection();
  drawOre();
});

oreLayer.addEventListener('pointercancel', () => {
  oreEdit.dragging = false;
  if (oreEdit.rect) { refreshOreSelection(); drawOre(); }
});

oreLayer.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  
  // The cell under the pointer is what 放矿柱/移除矿柱 act on; the box selection
  // (if any) is what the region brushes act on.  Both can be offered at once.
  const p = toNaturalOre(event);
  const cell = p ? pickCell(cellGrid, renderMeta, p.x, p.y) : null;
  oreEdit.buildPreview = null;
  if (cell) {
    const text = decodeLatin1(mapBytes);
    const structures = structureOccupiedCells(text);
    let info = describePillarTarget({ grid: cellGrid, text, x: cell.x, y: cell.y });
    if (structures.has(overlayIndex(cell.x, cell.y))) {
      info = { ok: false, reason: '这里有建筑，不能放矿柱。', existing: info.existing, isPillar: false };
    }
    const buildings = {};
    for (const type of BUILDING_TYPES) {
      buildings[type.id] = describeBuildingPlacement({
        grid: cellGrid, type, x: cell.x, y: cell.y, occupied: structures,
      });
    }
    oreEdit.target = { x: cell.x, y: cell.y, info, buildings };
  } else {
    oreEdit.target = null;
  }
  if (!oreEdit.rect && !oreEdit.target) {
    setOreHint('先拖拽框选一片区域，或在格子上右击。', 'bad');
    return;
  }
  drawOre();
  showOreMenu(event.clientX, event.clientY);
});

oreMenu.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const action = button.dataset.act;
  // Capture the target before hiding (hiding clears the highlight).
  const target = oreEdit.target;
  hideOreMenu();
  if (action === 'paint') applyMineralEdit(ORE_OVERLAY_START, '矿石');
  else if (action === 'gems') applyMineralEdit(GEM_OVERLAY_START, '彩矿');
  else if (action === 'pillar') applyPillar(target);
  else if (action === 'unpillar') applyRemovePillar(target);
  else if (action === 'clear') applyClearMinerals();
  else if (action === 'cancel') clearOreSelection();
  else if (action.startsWith('build-')) applyBuilding(action.slice('build-'.length), target);
});

// Hovering a building item previews its foundation on the map.
for (const type of BUILDING_TYPES) {
  const button = oreBuildButtons[type.id];
  button.addEventListener('mouseenter', () => {
    if (button.disabled) return;
    oreEdit.buildPreview = type;
    drawOre();
  });
  button.addEventListener('mouseleave', () => {
    if (!oreEdit.buildPreview) return;
    oreEdit.buildPreview = null;
    drawOre();
  });
}

// Clicking anywhere else dismisses the menu; the canvas pointerdown above also
// closes it before starting a new box.
window.addEventListener('pointerdown', (event) => {
  if (!oreMenu.hidden && !oreMenu.contains(event.target)) hideOreMenu();
}, true);

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!oreMenu.hidden) { hideOreMenu(); return; }
  if (oreEdit.rect) clearOreSelection();
});

window.addEventListener('scroll', () => { if (!oreMenu.hidden) hideOreMenu(); }, true);

window.addEventListener('resize', () => {
  if (oreLayer.hidden) return;
  sizeOreLayer();
  drawOre();
});

// The render replaces the image (new natural size), so the canvases have to be
// re-measured after it decodes.
previewImg.addEventListener('load', () => {
  sizeOreLayer();
  drawOre();
});


// ===========================================================================
// 地图编辑器（separate page）
//
// The editor is its own page now (editor.html): this button only hands it the
// generated bytes and the generator's per-cell sidecar through IndexedDB.  The
// extracted asset tree is already in OPFS, so the editor can render without the
// game directory and without re-extracting.
// ===========================================================================
openEditorBtn.addEventListener('click', async () => {
  if (!mapBytes || !cellGridBytes) return;
  try {
    const text = decodeLatin1(mapBytes);
    const theaterMatch = /^\s*Theater\s*=\s*(\w+)/mi.exec(text);
    const theater = theaterMatch && /snow/i.test(theaterMatch[1]) ? 1 : 0;
    const code = (el('share-code')?.textContent || '').trim();
    await saveGenerated({
      bytes: mapBytes,
      cells: cellGridBytes,
      name: downloadEl.download || 'out.map',
      theater,
      code,
    });
    openEditorBtn.blur();
    window.open('./editor.html?v=20261026e', '_blank', 'noopener');
  } catch (err) {
    showError(`无法把地图交给编辑器：${(err && err.message) || err}`);
  }
});
