// 地图编辑器：独立页面。
//
// 生成页只负责生成/渲染并把地图交过来（IndexedDB, mapstore.js）。这里复用
// 已经提取到 OPFS 的素材树（worker.js 的 assets-from-cache -> collect），
// 用同一套 CNCMaps WASM 渲染器出图，再用纯模块（starts.js / ore.js /
// buildings.js）编辑地图文本。
//
// 交互不再用右击菜单：左侧选工具，图上直接拖/点；每次改动进撤销栈并自动
// 重新渲染。所有工具都只改地图文件，不改生成参数，也不碰分享码。

import {
  parseCellGrid, pickCell, projectCell, readWaypoints, rewriteWaypoint,
  cellFlags, cellLevel, CELL_IN_MAP, CELL_PASSABLE, CELL_BUILDING,
} from './starts.js';
import {
  readOverlayGrids, writeOverlayGrids, readOccupiedCells, cellsInRect,
  countSelection, paintMineralCells, clearMineralCells, removeOreDecorations,
  describePillarTarget, placePillar, removePillar, isPillarName,
  findTerrainObject, overlayIndex, classifyCell,
  ORE_OVERLAY_START, GEM_OVERLAY_START, ORE_DATA, GEM_DATA,
  EMPTY_OVERLAY, CELL_EMPTY, CELL_ORE, CELL_OTHER,
} from './ore.js';
import {
  BUILDING_TYPES, buildingType, describeBuildingPlacement, placeBuilding,
  readStructures, structureOccupiedCells,
} from './buildings.js';
import {
  SLOT_BASE, playerSlots, isMultiplayerMap, readHandovers, applyHandovers,
  assignable, structureCells, buildingScreenRect, structureAtScreenPoint,
} from './houses.js?v=20261026h';
import { loadSession, saveCurrent } from './mapstore.js';

const el = (id) => document.getElementById(id);
const logEl = el('log');
const statusHint = el('status-hint');
const hintEl = el('hint');
const busyEl = el('busy');
const busyText = el('busy-text');
const emptyEl = el('empty-state');
const overlay = el('overlay');
const img = el('map-img');
const viewport = el('viewport');
const stage = el('stage');
const downloadMap = el('download-map');
const downloadPng = el('download-png');

const NEEDED = ['ra2.mix', 'ra2md.mix', 'expandmd01.mix'];

const state = {
  session: null,
  bytes: null,
  text: '',
  grid: null,
  ids: null,
  data: null,
  occupied: new Set(),        // [Terrain] + [Structures] footprints (for minerals)
  structureCells: new Set(),  // [Structures] only (for buildings/pillars)
  meta: null,
  mapName: 'out.map',
  theater: 0,
  baseBytes: null,
  undo: [],
  redo: [],
  tool: 'select',
  zoom: 1,               // 1 = natural pixels; the page starts at a fit zoom
  imageLoaded: false,
  selection: null,        // { x0, y0, x1, y1 } natural pixels (box mode)
  selCells: [],           // selected cells, from the box or the brush
  selKeys: new Set(),     // "x,y" for O(1) brush add/remove
  lastBrushKey: null,
  actionKind: 'ore',       // which ore brush the stats/colours describe
  areaMode: 'box',         // 'box' | 'brush': how the ore tools target cells
  counts: null,
  hover: null,            // { x, y } natural pixel
  hoverCell: null,        // { x, y, z }
  buildPreview: null,     // building type, for a hovered placement
  dragging: null,         // box / brush / area-brush / start / click / pan
  dragStart: null,
  selectedStart: -1,
  startPoints: [],
  structures: [],
  handovers: new Map(),    // structure index -> { slot, tag, trigger, name }
  slotCount: 2,            // players on this map ([Header] NumberStartingPoints)
  ownerMultiplayer: true,  // false on a single-player .map (the tool is refused)
  rendering: false,
  renderDirty: false,
  renderer: null,
  renderFs: null,
  Render: null,
  assets: null,
  assetsReady: false,
  assetsBooting: false,
  mapUrl: null,
  pngUrl: null,
  saveTimer: null,
  lastHint: '',
};

// ---------------------------------------------------------------------------
// small UI helpers
// ---------------------------------------------------------------------------
function log(line) {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
function setHint(text, tone = '') {
  state.lastHint = text;
  hintEl.textContent = text;
  hintEl.className = tone;
  statusHint.textContent = text;
  statusHint.className = `hint ${tone}`;
}
function setStatus(text, tone = '') {
  statusHint.textContent = text;
  statusHint.className = `hint ${tone}`;
}
function setBusy(text) {
  if (text === null) {
    busyEl.hidden = true;
    return;
  }
  busyText.textContent = text;
  busyEl.hidden = false;
}
function setEmpty(title, text, showPick) {
  if (!title) {
    emptyEl.hidden = true;
    return;
  }
  el('empty-title').textContent = title;
  el('empty-text').textContent = text;
  el('pick-assets').hidden = !showPick;
  emptyEl.hidden = false;
}

// ---------------------------------------------------------------------------
// latin1 map text
// ---------------------------------------------------------------------------
function decodeLatin1(bytes) { return new TextDecoder('latin1').decode(bytes); }
function encodeLatin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; ++i) out[i] = text.charCodeAt(i) & 0xFF;
  return out;
}

// ---------------------------------------------------------------------------
// worker: reuse the extracted asset tree from OPFS
// ---------------------------------------------------------------------------
const worker = new Worker('./worker.js');
let workerSeq = 0;
const waiters = new Map();       // message type -> [{ resolve, reject, timer }]

worker.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'log') { log(msg.line); return; }
  if (msg.type === 'progress') {
    const labels = { extracting: '正在准备素材……', generating: '', rendering: '' };
    if (labels[msg.stage]) busyText.textContent = labels[msg.stage];
    return;
  }
  if (msg.type === 'error') {
    for (const list of waiters.values()) {
      for (const w of list) { clearTimeout(w.timer); w.reject(new Error(msg.message)); }
    }
    waiters.clear();
    log(`[worker] ${msg.message}`);
    return;
  }
  if (msg.type === 'cache-saved') { log(`素材缓存已写入：${msg.files} 个文件`); return; }
  if (msg.type === 'cache-failed') { log(`素材缓存写入失败：${msg.reason || ''}`); return; }
  const list = waiters.get(msg.type);
  if (!list || !list.length) return;
  const waiter = list.shift();
  if (!list.length) waiters.delete(msg.type);
  clearTimeout(waiter.timer);
  waiter.resolve(msg);
};
worker.onerror = (event) => {
  const message = event.message || 'worker error';
  for (const list of waiters.values()) {
    for (const w of list) { clearTimeout(w.timer); w.reject(new Error(message)); }
  }
  waiters.clear();
  log(`[worker] ${message}`);
};

function waitFor(type, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const list = waiters.get(type) || [];
    const timer = setTimeout(() => {
      const rest = (waiters.get(type) || []).filter((w) => w !== entry);
      if (rest.length) waiters.set(type, rest); else waiters.delete(type);
      reject(new Error(`等待 worker 的 ${type} 超时`));
    }, timeout);
    const entry = { resolve, reject, timer };
    list.push(entry);
    waiters.set(type, list);
  });
}

async function bootWorker() {
  if (state.assetsBooting) return;
  state.assetsBooting = true;
  setBusy('正在启动素材服务……');
  worker.postMessage({ type: 'boot' });
  await waitFor('ready', 180000);
  state.assetsBooting = false;
}

async function loadAssetsFromCache(theater) {
  setBusy('正在从缓存恢复素材……');
  worker.postMessage({ type: 'assets-from-cache', theater });
  const msg = await Promise.race([
    waitFor('assets-ready', 180000),
    waitFor('cache-miss', 180000),
  ]).catch((err) => ({ type: 'error', error: err }));
  if (msg.type === 'cache-miss') {
    setBusy(null);
    setEmpty('缺少素材缓存',
      '这个地图的剧场没有可用的提取缓存。回生成页生成一次（会缓存），或在下面重新选一次游戏目录。',
      true);
    return false;
  }
  if (msg.type === 'error') throw (msg.error || new Error('恢复素材失败'));
  setBusy('正在整理渲染素材……');
  worker.postMessage({ type: 'collect' });
  const data = await waitFor('assets-data', 180000);
  state.assets = data.files || [];
  state.assetsReady = state.assets.length > 0;
  setBusy(null);
  log(`素材就绪：${state.assets.length} 个文件`);
  return state.assetsReady;
}

async function extractFromPickedDir(fileList) {
  const byName = new Map();
  for (const f of fileList) byName.set(f.name.toLowerCase(), f);
  const missing = NEEDED.filter((n) => !byName.has(n));
  if (missing.length) {
    setHint(`缺少 ${missing.join('、')}，请选 RA2/YR 安装目录。`, 'bad');
    return false;
  }
  const files = NEEDED.map((n) => ({ name: n, file: byName.get(n) }));
  setBusy('正在从游戏目录提取素材……');
  worker.postMessage({ type: 'assets', files, theater: state.theater, all: true });
  const msg = await Promise.race([
    waitFor('assets-ready', 300000),
    waitFor('error', 300000).catch(() => null),
  ]);
  if (!msg || msg.type !== 'assets-ready') {
    setBusy(null);
    setHint('提取失败，请看日志。', 'bad');
    return false;
  }
  worker.postMessage({ type: 'collect' });
  const data = await waitFor('assets-data', 180000);
  state.assets = data.files || [];
  state.assetsReady = state.assets.length > 0;
  setBusy(null);
  setEmpty(null);
  log(`素材就绪：${state.assets.length} 个文件`);
  return state.assetsReady;
}

// ---------------------------------------------------------------------------
// renderer (CNCMaps WASM, main thread)
// ---------------------------------------------------------------------------
async function ensureRenderer() {
  if (state.Render) return;
  setBusy('正在启动渲染器（首次约十几秒）……');
  const { dotnet } = await import('./render/_framework/dotnet.js');
  const runtime = await dotnet.create({
    print: (line) => log(`[dotnet] ${line}`),
    printErr: (line) => log(`[dotnet:err] ${line}`),
  });
  const config = runtime.getConfig();
  const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
  const Render = exports?.CNCMaps?.WebEntry?.Render;
  if (typeof Render !== 'function') throw new Error('渲染器模块里没有 CNCMaps.WebEntry.Render');
  const RenderStart = exports?.CNCMaps?.WebEntry?.RenderStart;
  const RenderUpdate = exports?.CNCMaps?.WebEntry?.RenderUpdate;
  const RenderStop = exports?.CNCMaps?.WebEntry?.RenderStop;
  const fs = runtime.Module.FS;
  for (const dir of ['/game', '/maps']) {
    try { fs.mkdir(dir); } catch (err) { /* already */ }
  }
  for (const f of state.assets) {
    try { fs.writeFile(`/game/${f.name}`, f.bytes); } catch (err) { log(`素材写入失败 ${f.name}: ${err}`); }
  }
  state.renderer = runtime;
  state.renderFs = fs;
  state.Render = Render;
  // The editor prefers the persistent pair: RenderStart loads VFS/rules/art/
  // theater once, RenderUpdate re-reads the map into that context.  An older
  // renderer without them falls back to a full Render per edit.
  state.RenderStart = typeof RenderStart === 'function' ? RenderStart : null;
  state.RenderUpdate = typeof RenderUpdate === 'function' ? RenderUpdate : null;
  state.RenderStop = typeof RenderStop === 'function' ? RenderStop : null;
  log(`渲染器就绪：${state.assets.length} 个素材文件`
    + `${state.RenderStart && state.RenderUpdate ? '（增量会话）' : ''}`);
}

async function renderNow() {
  if (!state.bytes) return;
  if (state.rendering) { state.renderDirty = true; return; }
  state.rendering = true;
  setStatus('正在渲染……');
  try {
    await ensureRenderer();
    const fs = state.renderFs;
    fs.writeFile('/maps/render.map', state.bytes);
    const started = performance.now();
    let rc;
    if (state.RenderStart && state.RenderUpdate) {
      if (state.sessionStarted) {
        rc = state.RenderUpdate('/maps/render.map', '/maps/render');
        if (rc !== 0) {
          log('增量渲染失败；回退整图渲染');
          state.sessionStarted = false;
          rc = state.RenderStart('/maps/render.map', '/game', '/maps/render');
          if (rc === 0) state.sessionStarted = true;
        }
      } else {
        rc = state.RenderStart('/maps/render.map', '/game', '/maps/render');
        if (rc === 0) state.sessionStarted = true;
      }
    } else {
      rc = state.Render('/maps/render.map', '/game', '/maps/render');
    }
    if (rc !== 0) throw new Error(`渲染器返回 ${rc}`);
    const png = fs.readFile('/maps/render.png');
    try {
      state.meta = JSON.parse(new TextDecoder().decode(fs.readFile('/maps/render.json')));
    } catch (err) {
      state.meta = null;
      throw new Error('渲染器没有给出坐标元数据（render.json）');
    }
    if (state.pngUrl) URL.revokeObjectURL(state.pngUrl);
    state.pngUrl = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    img.src = state.pngUrl;
    downloadPng.href = state.pngUrl;
    setStatus(`渲染完成（${Math.round(performance.now() - started)} ms）`, 'ok');
    log(`渲染完成：${Math.round(performance.now() - started)} ms`);
  } catch (err) {
    setHint(`渲染失败：${(err && err.message) || err}`, 'bad');
    log(`渲染失败：${(err && err.stack) || err}`);
  } finally {
    state.rendering = false;
    setBusy(null);
    if (state.renderDirty) { state.renderDirty = false; renderNow(); }
  }
}

// The image may be replaced; its natural size changes on a different map, but
// within one session it is the same.
img.addEventListener('load', () => {
  if (!state.imageLoaded) { state.imageLoaded = true; fit(); }
  else { sizeOverlay(); draw(); }
});

// ---------------------------------------------------------------------------
// map state and session
// ---------------------------------------------------------------------------
function parseMapState() {
  state.text = decodeLatin1(state.bytes);
  const grids = readOverlayGrids(state.text);
  if (!grids) throw new Error('这张地图没有 [OverlayPack]/[OverlayDataPack]');
  state.ids = grids.ids;
  state.data = grids.data;
  const occupied = readOccupiedCells(state.text);
  state.structureCells = structureOccupiedCells(state.text);
  for (const index of state.structureCells) occupied.add(index);
  state.occupied = occupied;
  state.structures = readStructures(state.text);
  state.handovers = readHandovers(state.text);
  state.slotCount = playerSlots(state.text);
  state.ownerMultiplayer = isMultiplayerMap(state.text);
  state.startPoints = readWaypoints(state.text).filter((w) => w.number < 8);
  const ownerTool = el('owner-tool');
  if (ownerTool) {
    ownerTool.title = state.ownerMultiplayer
      ? '给中立建筑指定开局归哪个玩家号位'
      : '单人 .map 不支持按号位归属（触发器只能按房主名）';
  }
  updateOwnerPanel();
  if (state.startPoints.length && state.selectedStart >= state.startPoints.length) {
    state.selectedStart = 0;
  }
  updateStartPanel();
  updateMapStats();
  updateDownload();
}

function refreshFromBytes(bytes, { keepSelection = true } = {}) {
  state.bytes = new Uint8Array(bytes);
  parseMapState();
  if (!keepSelection) clearSelection(false);
  else if (state.selCells.length) refreshSelectionCounts();
  updateStatsPanel();
  queueSessionSave();
  renderNow();
}

function seedUndo() {
  state.undo = [];
  state.redo = [];
  state.baseBytes = new Uint8Array(state.bytes);
}

function pushUndo() {
  state.undo.push(new Uint8Array(state.bytes));
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
  updateUndoButtons();
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(new Uint8Array(state.bytes));
  const bytes = state.undo.pop();
  refreshFromBytes(bytes);
  updateUndoButtons();
  setHint('已撤销。');
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(new Uint8Array(state.bytes));
  const bytes = state.redo.pop();
  refreshFromBytes(bytes);
  updateUndoButtons();
  setHint('已重做。');
}

function updateUndoButtons() {
  el('undo').disabled = state.undo.length === 0;
  el('redo').disabled = state.redo.length === 0;
}

function queueSessionSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    saveCurrent(state.bytes).catch((err) => log(`保存会话失败：${(err && err.message) || err}`));
  }, 350);
}

function commitEdit(bytes, hint, tone = 'ok') {
  pushUndo();
  refreshFromBytes(bytes);
  setHint(hint, tone);
}

// ---------------------------------------------------------------------------
// header / stats
// ---------------------------------------------------------------------------
function theaterName(t) { return t === 1 ? '雪地' : '温带'; }

function mapSizeText() {
  const m = /^\s*Size\s*=\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/mi.exec(state.text);
  if (!m) return state.grid ? `${state.grid.width}×${state.grid.height}` : '—';
  return `${m[3]}×${m[4]}`;
}

function updateMapMeta() {
  el('map-name').textContent = state.mapName;
  el('map-meta').textContent = `${mapSizeText()} · ${theaterName(state.theater)} · ${state.structures.length} 建筑`;
  el('stat-size').textContent = mapSizeText();
  el('stat-theater').textContent = theaterName(state.theater);
}

function scanMinerals() {
  let ore = 0, gems = 0;
  if (state.ids) {
    for (let i = 0; i < state.ids.length; ++i) {
      const id = state.ids[i];
      if (id >= ORE_OVERLAY_START && id < ORE_OVERLAY_START + 12) ore++;
      else if (id >= GEM_OVERLAY_START && id < GEM_OVERLAY_START + 12) gems++;
    }
  }
  let pillars = 0;
  // TIBTRE lines live in [Terrain]; count by a quick text scan of that section.
  const sec = /\[Terrain\]([\s\S]*?)(?=\n\[|$)/i.exec(state.text);
  if (sec) for (const line of sec[1].split(/\r?\n/)) {
    const m = /^\s*\d+\s*=\s*(\w+)/.exec(line);
    if (m && isPillarName(m[1])) pillars++;
  }
  return { ore, gems, pillars };
}

function updateMapStats() {
  updateMapMeta();
  const m = scanMinerals();
  el('stat-structures').textContent = String(state.structures.length);
  el('stat-ore').textContent = String(m.ore);
  el('stat-gems').textContent = String(m.gems);
  el('stat-pillars').textContent = String(m.pillars);
}

function updateStatsPanel() {
  const gems = state.actionKind === 'gems';
  el('sel-empty-label').textContent = gems ? '可放彩矿' : '可放矿石';
  el('sel-ore-label').textContent = gems ? '已有彩矿' : '已有矿石';
  const c = state.counts;
  const set = (id, v, tone = '') => { const e = el(id); e.textContent = v == null ? '—' : String(v); e.className = tone; };
  if (!c) {
    for (const id of ['sel-total', 'sel-empty', 'sel-ore', 'sel-other', 'sel-blocked']) set(id, null);
    el('sel-readout').textContent = '未选择';
    return;
  }
  set('sel-total', c.total);
  set('sel-empty', c.empty, c.empty ? 'ok' : '');
  set('sel-ore', c.ore);
  set('sel-other', c.other);
  set('sel-blocked', c.blocked, c.blocked ? 'bad' : '');
  el('sel-readout').textContent = `选区 ${c.total} 格`;
}

function updateDownload() {
  if (state.mapUrl) URL.revokeObjectURL(state.mapUrl);
  state.mapUrl = URL.createObjectURL(new Blob([state.bytes], { type: 'application/octet-stream' }));
  downloadMap.href = state.mapUrl;
  downloadMap.download = state.mapName;
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------
const TOOLS = {
  select: {
    title: '框选',
    help: '拖拽框选；切到放矿石/放彩矿/清除矿后按框选方式在图上拖框执行。',
  },
  brush: {
    title: '自由',
    help: '左键涂抹选择，右键涂抹删除；切到放矿石等工具后按自由方式执行。',
  },
  ore: {
    title: '放矿石（绿）',
    help: '按当前区域方式：框选就拖框，自由就涂抹；松开后对选区放绿矿。',
  },
  gems: {
    title: '放彩矿',
    help: '按当前区域方式：框选就拖框，自由就涂抹；松开后对选区放彩矿。',
  },
  clear: {
    title: '清除矿',
    help: '按当前区域方式：框选就拖框，自由就涂抹；松开后清除选区里的矿。',
  },
  pillar: {
    title: '放矿柱',
    help: '点一个格子放 TIBTRE 矿柱；会替换该格的地形对象、清掉非矿 overlay。右击移除。',
  },
  unpillar: {
    title: '移除矿柱',
    help: '点一个格子，删掉该格的 TIBTRE 矿柱；其他地形对象不动。',
  },
  owner: {
    title: '改归属',
    help: '点建筑（点塔身也算，不必点地基）或拖框选中，再到右栏点号位；'
      + '「中立」清除。选中会画框并标出当前归属。只改 [Structures] 的标签和触发器，不改房主字段。',
  },
  start: {
    title: '改出生点',
    help: '拖红方块改落点，或先点红方块再点目标格。只改 [Waypoints]。',
  },
};

function toolInfo(tool) {
  if (TOOLS[tool]) return TOOLS[tool];
  if (tool.startsWith('build-')) {
    const t = buildingType(tool.slice(6));
    if (t) return {
      title: `放${t.short}`,
      help: `${t.full} · ${t.width}×${t.height}。悬停看地基，点一下放置；地基上的矿/树会被清掉，已有建筑/水面/坡会被拒绝。`,
    };
  }
  return { title: tool, help: '' };
}

function startCellInfo(cell) {
  if (!cell) return { ok: false, reason: '这里没有格子。' };
  const flags = cellFlags(state.grid, cell.x, cell.y);
  if (!(flags & CELL_IN_MAP)) return { ok: false, reason: '这格出了地图。' };
  if (!(flags & CELL_PASSABLE) || (flags & CELL_BUILDING)) {
    return { ok: false, reason: '这格不能站人（水面/崖/建筑）。' };
  }
  if (state.startPoints.some((p, i) => i !== state.selectedStart
      && p.x === cell.x && p.y === cell.y)) {
    return { ok: false, reason: '这格已经有别的出生点。' };
  }
  return { ok: true, reason: '' };
}

/**
 * The player slot a start waypoint belongs to.  Multiplayer slot A is waypoint
 * 0, so the number shown on a start is waypoint + 1 -- the same 1-based number
 * the ownership badges use.  (The waypoint number stays available in tooltips.)
 */
function playerNumberOf(pt) {
  return pt.number + 1;
}

function updateStartPanel() {
  const panel = el('start-panel');
  const show = state.tool === 'start';
  panel.hidden = !show;
  if (!show) return;
  const list = el('start-list');
  list.textContent = '';
  if (!state.startPoints.length) {
    el('start-current').textContent = '这张地图没有出生点。';
    return;
  }
  if (state.selectedStart < 0 || state.selectedStart >= state.startPoints.length) {
    state.selectedStart = 0;
  }
  for (let i = 0; i < state.startPoints.length; ++i) {
    const pt = state.startPoints[i];
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(playerNumberOf(pt));
    b.title = `玩家 ${playerNumberOf(pt)}（waypoint ${pt.number}）@ (${pt.x}, ${pt.y})`;
    b.classList.toggle('on', i === state.selectedStart);
    b.addEventListener('click', () => {
      state.selectedStart = i;
      updateStartPanel();
      draw();
      setHint(`选中玩家 ${playerNumberOf(pt)}；拖红方块或点目标格。`, 'ok');
    });
    list.appendChild(b);
  }
  const pt = state.startPoints[state.selectedStart];
  el('start-current').textContent =
    `选中 玩家 ${playerNumberOf(pt)} · (${pt.x}, ${pt.y}) · waypoint ${pt.number}`;
}

function setTool(tool) {
  state.tool = tool;
  for (const b of document.querySelectorAll('.tool')) {
    b.classList.toggle('on', b.dataset.tool === tool);
  }
  const info = toolInfo(tool);
  el('tool-title').textContent = info.title;
  el('tool-help').textContent = info.help;
  state.buildPreview = tool.startsWith('build-') ? buildingType(tool.slice(6)) : null;
  if (tool === 'select') state.areaMode = 'box';
  else if (tool === 'brush') state.areaMode = 'brush';
  if (tool === 'ore') state.actionKind = 'ore';
  else if (tool === 'gems') state.actionKind = 'gems';
  el('area-mode-readout').textContent =
    `区域方式：${state.areaMode === 'box' ? '框选' : '自由'}`;
  if (tool === 'select') {
    setHint('拖拽框选；切到放矿石等工具后按框选方式执行。', 'ok');
  } else if (tool === 'brush') {
    setHint('左键涂抹选择，右键删除；切到放矿石等工具后按自由方式执行。', 'ok');
  } else if (tool === 'owner') {
    setHint(state.ownerMultiplayer
      ? '框选或点一栋中立建筑，然后到右栏选号位。'
      : '单人 .map 没有玩家号位，这一步只在多人图里可用。',
      state.ownerMultiplayer ? 'ok' : 'bad');
  } else if (tool === 'ore' || tool === 'gems' || tool === 'clear') {
    setHint(state.areaMode === 'box'
      ? '在图上拖一个框，松开后对框内区域执行。'
      : '按住左键涂抹，松开后对涂过的格子执行。', 'ok');
  }
  if (tool === 'start' && state.startPoints.length) {
    if (state.selectedStart < 0 || state.selectedStart >= state.startPoints.length) {
      state.selectedStart = 0;
    }
    setHint(`选中玩家 ${playerNumberOf(state.startPoints[state.selectedStart])}；`
      + '拖红方块，或点目标格。', 'ok');
  }
  state.dragging = null;
  state.dragStart = null;
  state.hover = null;
  state.lastBrushKey = null;
  if (tool === 'brush') state.selection = null;
  updateStartPanel();
  if (state.selCells.length) refreshSelectionCounts();
  else updateStatsPanel();
  updateOwnerPanel();
  draw();
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------
function dpr() { return window.devicePixelRatio || 1; }
function displayScale() {
  return img.naturalWidth ? img.clientWidth / img.naturalWidth : 0;
}
function sizeOverlay() {
  if (!img.clientWidth || !img.clientHeight) return;
  const w = Math.max(1, Math.round(img.clientWidth * dpr()));
  const h = Math.max(1, Math.round(img.clientHeight * dpr()));
  if (overlay.width !== w) overlay.width = w;
  if (overlay.height !== h) overlay.height = h;
}
function diamond(ctx, cx, cy, hw, hh) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx + hw, cy);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy);
  ctx.closePath();
}
function addDiamond(path, cx, cy, hw, hh) {
  path.moveTo(cx, cy - hh);
  path.lineTo(cx + hw, cy);
  path.lineTo(cx, cy + hh);
  path.lineTo(cx - hw, cy);
  path.closePath();
}

function draw() {
  if (!state.grid || !state.meta || !img.clientWidth) { overlay.hidden = true; return; }
  overlay.hidden = false;
  const ctx = overlay.getContext('2d');
  const s = displayScale();
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!s) return;
  const tw = (state.meta.tileWidth / 2) * s;
  const th = (state.meta.tileHeight / 2) * s;

  // selection cells: blue for the owner tool, mineral colours otherwise
  if (state.selCells.length && state.tool === 'owner') {
    for (const c of state.selCells) {
      const p = projectCell(state.grid, state.meta, c.x, c.y);
      diamond(ctx, p.x * s, p.y * s, tw, th);
      ctx.fillStyle = 'rgba(120,170,255,.26)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(190,220,255,.75)';
      ctx.stroke();
    }
  } else if (state.selCells.length) {
    const family = state.actionKind === 'gems' ? GEM_OVERLAY_START : ORE_OVERLAY_START;
    const empty = new Path2D();
    const same = new Path2D();
    const other = new Path2D();
    for (const c of state.selCells) {
      const kind = classifyCell(state.grid, state.ids, state.occupied, c.x, c.y, family);
      if (kind !== CELL_EMPTY && kind !== CELL_ORE && kind !== CELL_OTHER) continue;
      const p = projectCell(state.grid, state.meta, c.x, c.y);
      addDiamond(kind === CELL_EMPTY ? empty : (kind === CELL_ORE ? same : other),
        p.x * s, p.y * s, tw, th);
    }
    ctx.fillStyle = 'rgba(242,192,105,.30)';
    ctx.fill(empty);
    ctx.fillStyle = 'rgba(126,214,120,.32)';
    ctx.fill(same);
    ctx.fillStyle = 'rgba(130,150,240,.34)';
    ctx.fill(other);
  }

  // hovered cell / building footprint
  if (state.hoverCell) {
    const c = state.hoverCell;
    if (state.tool.startsWith('build-') && state.meta) {
      const type = buildingType(state.tool.slice(6));
      if (type) {
        const info = describeBuildingPlacement({
          grid: state.grid, type, x: c.x, y: c.y, occupied: state.structureCells,
        });
        for (const cell of info.cells) {
          const p = projectCell(state.grid, state.meta, cell.x, cell.y);
          diamond(ctx, p.x * s, p.y * s, tw, th);
          ctx.fillStyle = info.ok ? 'rgba(120,170,255,.36)' : 'rgba(224,133,122,.36)';
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = info.ok ? 'rgba(190,220,255,.9)' : 'rgba(240,160,150,.9)';
          ctx.stroke();
        }
      }
    } else {
      const p = projectCell(state.grid, state.meta, c.x, c.y);
      diamond(ctx, p.x * s, p.y * s, tw, th);
      ctx.fillStyle = 'rgba(242,192,105,.16)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,210,122,.95)';
      ctx.stroke();
    }
  }

  // owner tool: highlight the building under the pointer (tower included)
  if (state.tool === 'owner' && state.hover) {
    const st = structureAtPoint(state.hover);
    if (st) {
      const ok = assignable(state.text, st);
      for (const c of structureCells(st.type, st.x, st.y)) {
        const p = projectCell(state.grid, state.meta, c.x, c.y);
        diamond(ctx, p.x * s, p.y * s, tw, th);
        ctx.fillStyle = ok ? 'rgba(120,170,255,.30)' : 'rgba(224,133,122,.28)';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = ok ? 'rgba(190,220,255,.9)' : 'rgba(240,160,150,.9)';
        ctx.stroke();
      }
      const r = screenRectOf(st, s);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = ok ? 'rgba(190,220,255,.9)' : 'rgba(240,160,150,.9)';
      ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      ctx.setLineDash([]);
    }
  }

  // selected buildings: a solid frame around the art + a slot label.  The
  // renderer keeps Neutral buildings grey, so this is the only "it is selected
  // and it belongs to slot N" feedback the editor can give.
  if (state.tool === 'owner' && state.selCells.length) {
    for (const st of selectedStructures()) {
      const h = state.handovers.get(st.index);
      const color = '#f2c069';
      const r = screenRectOf(st, s);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, 6);
      else ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      drawPill(ctx, (r.x0 + r.x1) / 2, r.y0 - 12, h ? `${h.slot} 号位` : '中立', color);
    }
  }

  // starts linked to the current selection / hovered building: ring them, so
  // "which start is this building's player" needs no colour code
  const linkedSlots = new Set();
  for (const st of selectedStructures()) {
    const h = state.handovers.get(st.index);
    if (h) linkedSlots.add(h.slot);
  }
  if (state.tool === 'owner' && state.hover) {
    const st = structureAtPoint(state.hover);
    const h = st ? state.handovers.get(st.index) : null;
    if (h) linkedSlots.add(h.slot);
  }

  // while dragging a start, show where it would land
  if (state.dragging === 'start' && state.startPoints.length && state.selectedStart >= 0) {
    const pt = state.startPoints[state.selectedStart];
    const cell = state.hoverCell;
    if (cell) {
      const info = startCellInfo(cell);
      const p = projectCell(state.grid, state.meta, cell.x, cell.y);
      diamond(ctx, p.x * s, p.y * s, tw, th);
      ctx.fillStyle = info.ok ? 'rgba(242,192,105,.42)' : 'rgba(224,133,122,.42)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = info.ok ? '#f2c069' : '#e0857a';
      ctx.stroke();
      drawStartBadge(ctx, startBadgeCenter(p, s, th), String(playerNumberOf(pt)),
        true, linkedSlots.has(playerNumberOf(pt)));
    }
  }

  // start points
  if (state.startPoints.length) {
    for (let i = 0; i < state.startPoints.length; ++i) {
      const pt = state.startPoints[i];
      const p = projectCell(state.grid, state.meta, pt.x, pt.y);
      diamond(ctx, p.x * s, p.y * s, tw, th);
      ctx.fillStyle = i === state.selectedStart ? 'rgba(242,192,105,.40)' : 'rgba(230,90,80,.35)';
      ctx.fill();
      ctx.lineWidth = i === state.selectedStart ? 2 : 1.5;
      ctx.strokeStyle = i === state.selectedStart ? '#f2c069' : '#f06a5a';
      ctx.stroke();
      drawStartBadge(ctx, startBadgeCenter(p, s, th), String(playerNumberOf(pt)),
        i === state.selectedStart, linkedSlots.has(playerNumberOf(pt)));
    }
  }

  // assigned neutral buildings: the renderer keeps them grey (the owner field
  // never changes), so the editor marks them with the slot number.
  if (state.handovers.size) {
    for (const st of state.structures) {
      const h = state.handovers.get(st.index);
      if (!h) continue;
      const p = projectCell(state.grid, state.meta, st.x, st.y);
      const r = Math.max(6, Math.min(tw, th) * 0.52);
      ctx.beginPath();
      ctx.arc(p.x * s, p.y * s, r, 0, Math.PI * 2);
      ctx.fillStyle = BADGE_FILL;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(12,13,16,.85)';
      ctx.stroke();
      ctx.font = `600 ${Math.max(9, Math.round(r * 1.15))}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(String(h.slot), p.x * s, p.y * s + 0.5);
    }
  }

  // rubber band
  if (state.selection) {
    const r = state.selection;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(242,192,105,.95)';
    ctx.strokeRect(Math.min(r.x0, r.x1) * s, Math.min(r.y0, r.y1) * s,
      Math.abs(r.x1 - r.x0) * s, Math.abs(r.y1 - r.y0) * s);
    ctx.setLineDash([]);
  }
}

// ---------------------------------------------------------------------------
// pointer mapping
// ---------------------------------------------------------------------------
function toNatural(event) {
  const rect = img.getBoundingClientRect();
  if (!rect.width || !rect.height || !img.naturalWidth) return null;
  return {
    x: (event.clientX - rect.left) * img.naturalWidth / rect.width,
    y: (event.clientY - rect.top) * img.naturalHeight / rect.height,
  };
}
function clampNatural(p) {
  return {
    x: Math.max(0, Math.min(img.naturalWidth, p.x)),
    y: Math.max(0, Math.min(img.naturalHeight, p.y)),
  };
}
function cellAt(natural) {
  if (!natural || !state.grid || !state.meta) return null;
  return pickCell(state.grid, state.meta, natural.x, natural.y);
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------
function refreshSelectionCounts() {
  if (!state.grid || !state.meta || !state.selCells.length) {
    state.counts = null;
    updateStatsPanel();
    return;
  }
  const family = state.actionKind === 'gems' ? GEM_OVERLAY_START : ORE_OVERLAY_START;
  state.counts = countSelection(state.grid, state.ids, state.occupied, state.selCells, family);
  updateStatsPanel();
  updateOwnerPanel();
}

function setSelectionFromRect(rect) {
  state.selection = rect;
  state.selCells = cellsInRect(state.grid, state.meta, rect);
  state.selKeys = new Set(state.selCells.map((c) => `${c.x},${c.y}`));
  refreshSelectionCounts();
}

function clearSelection(redraw = true) {
  state.selection = null;
  state.selCells = [];
  state.selKeys.clear();
  state.lastBrushKey = null;
  state.counts = null;
  updateStatsPanel();
  updateOwnerPanel();
  if (redraw) draw();
}

/** Adds/removes the cell under the pointer to the freeform selection. */
function brushPaint(natural, erase = false) {
  if (!state.grid || !state.meta || !natural) return;
  const cell = cellAt(natural);
  if (!cell) return;
  if (!(cellFlags(state.grid, cell.x, cell.y) & CELL_IN_MAP)) return;
  const key = `${cell.x},${cell.y}`;
  if (key === state.lastBrushKey) return;
  state.lastBrushKey = key;
  if (erase) {
    if (!state.selKeys.has(key)) return;
    state.selKeys.delete(key);
    state.selCells = state.selCells.filter((c) => c.x !== cell.x || c.y !== cell.y);
  } else {
    if (state.selKeys.has(key)) return;
    state.selKeys.add(key);
    state.selCells.push(cell);
  }
  refreshSelectionCounts();
  draw();
}


// ---------------------------------------------------------------------------
// neutral building ownership (webapp/houses.js does the map rewrite)
// ---------------------------------------------------------------------------
// Numbers are player slots; the badge colour is NOT a player colour.  RA2 picks
// player colours in the lobby, so a fixed palette per slot would invent a
// mapping the game does not have, and two "1"s in different colours read as two
// different things.  One neutral badge everywhere; shape says what it is
// (pin = start, circle = owned building) and the number says which player.
const BADGE_FILL = '#2e3440';

const STRUCTURE_SHORT = {
  CAOILD: '油井', CAMACH: '科技商店', CAOUTP: '维修厂',
  CAAIRP: '机场', CATHOSP: '医院', CAPOWR: '电厂',
};

function structureShort(st) {
  return STRUCTURE_SHORT[String(st.type).toUpperCase()] || st.type;
}

function structureAtCell(cell) {
  if (!cell) return null;
  return state.structures.find((st) =>
    structureCells(st.type, st.x, st.y).some((c) => c.x === cell.x && c.y === cell.y)) || null;
}

// Frame height per type, in tile heights, for the SELECTION FRAME only.  The
// hit box keeps the generous 4.2 so clicking a tower still selects; the frame
// should hug the art instead of leaving a big empty area above it.  Measured on
// the renderer: derrick art ends ~2.7 tiles above the anchor, hospital ~3.3.
const FRAME_LIFT_TILES = {
  CAOILD: 2.6, CATHOSP: 3.2, CAAIRP: 3.0, CAMACH: 2.4, CAOUTP: 2.6, CAPOWR: 2.4,
};

function frameLiftOf(type) {
  return FRAME_LIFT_TILES[String(type || '').toUpperCase()] ?? 2.8;
}

/** The drawing rect: footprint + a per-type art lift (tighter than the hit box). */
function screenRectOf(st, s) {
  return buildingScreenRect(st, (x, y) => projectCell(state.grid, state.meta, x, y),
    state.meta.tileWidth, state.meta.tileHeight, s, frameLiftOf(st.type));
}

/** The building under a natural-pixel point: exact cell first, then the art box. */
function structureAtPoint(natural) {
  if (!state.grid || !state.meta || !natural) return null;
  const exact = structureAtCell(cellAt(natural));
  if (exact) return exact;
  const s = displayScale();
  if (!s) return null;
  return structureAtScreenPoint(state.structures, natural.x * s, natural.y * s, {
    project: (x, y) => projectCell(state.grid, state.meta, x, y),
    tileWidth: state.meta.tileWidth,
    tileHeight: state.meta.tileHeight,
    scale: s,
  });
}

/** Every building intersecting the current cell selection. */
function selectedStructures() {
  if (!state.selCells.length) return [];
  const cells = new Set(state.selCells.map((c) => `${c.x},${c.y}`));
  return state.structures.filter((st) =>
    structureCells(st.type, st.x, st.y).some((c) => cells.has(`${c.x},${c.y}`)));
}

/** The neutral, assignable buildings covered by the current cell selection. */
function ownerTargets() {
  return selectedStructures().filter((st) => assignable(state.text, st));
}

function describeSelected(st) {
  if (!assignable(state.text, st)) return `${structureShort(st)}（不可归属）`;
  const h = state.handovers.get(st.index);
  return `${structureShort(st)}（${h ? `${h.slot} 号位` : '中立'}）`;
}

/** Writes the "what did the last click hit" line in the owner panel. */
function setOwnerLast(text) {
  const node = el('owner-last');
  if (node) node.textContent = text;
}

/** Click without dragging: select the building under the pointer (tower included). */
function selectStructureAt(natural) {
  const st = structureAtPoint(natural);
  if (!st) {
    const cell = natural ? cellAt(natural) : null;
    setOwnerLast(`上次点击：格 ${cell ? `(${cell.x}, ${cell.y})` : '—'} · 未命中建筑`);
    log(`[owner] click ${cell ? `(${cell.x}, ${cell.y})` : '—'} -> no building`);
    clearSelection();
    setHint('这里没有建筑：点建筑本体（塔身也算），或先用框选。', 'bad');
    return;
  }
  state.selCells = structureCells(st.type, st.x, st.y)
    .filter((c) => c.x >= 0 && c.y >= 0 && c.x < 512 && c.y < 512)
    .filter((c) => cellFlags(state.grid, c.x, c.y) & CELL_IN_MAP);
  state.selKeys = new Set(state.selCells.map((c) => `${c.x},${c.y}`));
  state.selection = null;
  refreshSelectionCounts();
  updateOwnerPanel();
  setOwnerLast(`上次点击：格 (${st.x}, ${st.y}) · 命中 ${structureShort(st)} #${st.index}`);
  log(`[owner] click (${st.x}, ${st.y}) -> ${st.type} #${st.index}`);
  const ok = assignable(state.text, st);
  setHint(`${ok ? '选中' : '选中（不可归属）'} ${structureShort(st)}（#[${st.index}]）`
    + (state.handovers.has(st.index) ? `，当前 ${state.handovers.get(st.index).slot} 号位。` : '，当前中立。'),
    ok ? 'ok' : 'bad');
}

/** Draws a pill label (screen pixels) used for the selection frame / slot badge. */
const START_BADGE_R = 11;

/**
 * Where the start-point number badge sits: above the cell, fixed size in screen
 * pixels.  The cell is one diamond and the number cannot grow with it without
 * lying about the footprint, so the label is decoupled from the cell; a little
 * pointer keeps it attached.  Clamped so a start at the map edge stays visible.
 */
function startBadgeCenter(p, s, th) {
  const cw = overlay.width / dpr();
  const ch = overlay.height / dpr();
  const x = Math.min(Math.max(p.x * s, START_BADGE_R + 2),
                     Math.max(START_BADGE_R + 2, cw - START_BADGE_R - 2));
  const lift = Math.max(18, th + 16);
  const y = Math.min(Math.max(p.y * s - lift, START_BADGE_R + 8),
                     Math.max(START_BADGE_R + 8, ch - START_BADGE_R - 12));
  return { x, y };
}

function drawStartBadge(ctx, c, label, selected, linked = false) {
  const r = START_BADGE_R;
  const fill = BADGE_FILL;
  ctx.beginPath();
  ctx.moveTo(c.x - 4, c.y + r - 1);
  ctx.lineTo(c.x + 4, c.y + r - 1);
  ctx.lineTo(c.x, c.y + r + 6);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(12,13,16,.9)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = '700 13px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(12,13,16,.9)';
  ctx.strokeText(label, c.x, c.y + 0.5);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, c.x, c.y + 0.5);
  if (selected) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, r + 3.5, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#f2c069';
    ctx.stroke();
  }
  if (linked) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, r + 6.5, 0, Math.PI * 2);
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawPill(ctx, x, y, text, bg) {
  ctx.font = '600 12px ui-monospace, monospace';
  const w = ctx.measureText(text).width + 14;
  const h = 18;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, 4);
  else ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(12,13,16,.9)';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
}

function updateOwnerPanel() {
  const panel = el('owner-panel');
  if (!panel) return;
  // Always visible: a map that cannot take a handover (single player, or no
  // neutral buildings this seed) must SAY so instead of looking like a dead
  // control.  A user who selects with 框选 still sees the slot buttons.
  panel.hidden = false;
  const row = el('owner-slots');
  const count = el('owner-count');
  if (!row || !count) return;

  row.textContent = '';
  if (state.ownerMultiplayer) {
    const add = (slot, label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot';
      btn.dataset.slot = slot === null ? 'neutral' : String(slot);
      btn.append(document.createTextNode(label));
      btn.addEventListener('click', () => applyOwner(slot));
      row.append(btn);
    };
    add(null, '中立');
    for (let i = 1; i <= state.slotCount; ++i) add(i, String(i));
  }

  if (!state.ownerMultiplayer) {
    count.textContent = '单人 .map：没有玩家号位，不能按号位归属。';
    return;
  }
  if (!state.structures.length) {
    count.textContent = '这张图没有中立建筑（科技建筑是随机放的，这局可能没出）。';
    return;
  }
  const picked = selectedStructures();
  if (!picked.length) {
    const bySlot = new Map();
    for (const h of state.handovers.values()) {
      bySlot.set(h.slot, (bySlot.get(h.slot) || 0) + 1);
    }
    const summary = [...bySlot.entries()].sort((a, b) => a[0] - b[0])
      .map(([slot, n]) => `${slot} 号位 ×${n}`).join('、');
    count.textContent = '未选中建筑：用框选/自由，或「改归属」点一下建筑本体。'
      + (summary ? ` 本图已归属：${summary}。` : '');
    return;
  }
  count.textContent = `选中 ${picked.length} 栋：${picked.map(describeSelected).join('、')}`;
}

function applyOwner(slot) {
  if (!state.ownerMultiplayer) {
    setHint('单人 .map 不支持按号位归属：触发器只能按房主名，号位编码 4475+ 是多人专属。', 'bad');
    return;
  }
  const picked = ownerTargets();
  if (!picked.length) {
    setHint('先框选或点选一栋中立建筑（油井、科技商店、科技维修厂 …）。', 'bad');
    return;
  }
  const res = applyHandovers({
    text: state.text, structures: state.structures,
    indices: picked.map((st) => st.index), slot,
  });
  if (!res.ok) { setHint(res.reason, 'bad'); return; }
  if (!res.changed) { setHint('这些建筑已经是这个归属了。', ''); return; }
  commitEdit(encodeLatin1(res.text), slot === null
    ? `已把 ${res.assigned.length} 栋中立建筑改回中立（删掉对应触发器）。`
    : `已把 ${res.assigned.length} 栋中立建筑给 ${slot} 号位`
      + `（动作 14 的目标码 ${SLOT_BASE + slot - 1}）。`);
  log(`编辑：中立建筑归属 #${res.assigned.join(' #')} → ${slot === null ? '中立' : slot + ' 号位'}`);
}

// ---------------------------------------------------------------------------
// edits
// ---------------------------------------------------------------------------
function applyMineral(family, label) {
  if (!state.selCells.length) { setHint('先框选或涂抹一个选区。', 'bad'); return; }
  const grids = readOverlayGrids(state.text);
  if (!grids) return;
  const result = paintMineralCells({
    grid: state.grid, cells: state.selCells, ids: grids.ids, data: grids.data,
    occupied: state.occupied, family,
    stage: family === GEM_OVERLAY_START ? GEM_DATA : ORE_DATA,
  });
  if (!result.painted) { setHint(`选区里没有可放${label}的空地。`, 'bad'); return; }
  const next = writeOverlayGrids(state.text, grids.ids, grids.data);
  commitEdit(encodeLatin1(next), `已放 ${result.painted} 格${label}（${result.existing} 格已有，`
    + `${result.other} 格其他矿，${result.blocked} 格不可放）。`);
  log(`编辑：放 ${result.painted} 格${label}`);
}

function applyClear() {
  if (!state.selCells.length) { setHint('先框选或涂抹一个选区。', 'bad'); return; }
  const grids = readOverlayGrids(state.text);
  if (!grids) return;
  const result = clearMineralCells({ cells: state.selCells, ids: grids.ids, data: grids.data });
  if (!result.cleared) { setHint('选区里没有矿。', 'bad'); return; }
  let next = writeOverlayGrids(state.text, grids.ids, grids.data);
  next = removeOreDecorations(next, result.packed);
  commitEdit(encodeLatin1(next), `已清除 ${result.cleared} 格矿。`);
  log(`编辑：清除 ${result.cleared} 格矿`);
}

function applyPillar(remove) {
  if (!state.hoverCell) { setHint('先指到一个格子上。', 'bad'); return; }
  const c = state.hoverCell;
  if (remove) {
    const res = removePillar({ text: state.text, x: c.x, y: c.y });
    if (!res.changed) { setHint(res.reason || '这格没有矿柱。', 'bad'); return; }
    commitEdit(encodeLatin1(res.text), `已移除 (${c.x}, ${c.y}) 的 ${res.removed}。`);
    return;
  }
  const info = describePillarTarget({ grid: state.grid, text: state.text, x: c.x, y: c.y });
  if (!info.ok) { setHint(info.reason, 'bad'); return; }
  if (info.isPillar) { setHint(`(${c.x}, ${c.y}) 已经是 ${info.existing}。`, 'bad'); return; }
  const grids = readOverlayGrids(state.text);
  if (!grids) return;
  if (state.structureCells.has(overlayIndex(c.x, c.y))) {
    setHint('这里有建筑，不能放矿柱。', 'bad');
    return;
  }
  const res = placePillar({
    grid: state.grid, text: state.text, ids: grids.ids, data: grids.data,
    x: c.x, y: c.y,
  });
  if (!res.ok) { setHint(res.reason, 'bad'); return; }
  let next = res.removedOverlay !== null
    ? writeOverlayGrids(res.text, grids.ids, grids.data) : res.text;
  let extra = '';
  if (res.removedObject) extra += `，替换了 ${res.removedObject}`;
  if (res.removedOverlay !== null) extra += `，去掉 overlay ${res.removedOverlay}`;
  commitEdit(encodeLatin1(next), `已在 (${c.x}, ${c.y}) 放了 ${res.name}${extra}。`);
  log(`编辑：矿柱 ${res.name} @ (${c.x}, ${c.y})`);
}

function applyBuilding() {
  if (!state.hoverCell) { setHint('先指到一个格子上。', 'bad'); return; }
  const type = buildingType(state.tool.slice(6));
  if (!type) return;
  const c = state.hoverCell;
  const grids = readOverlayGrids(state.text);
  if (!grids) return;
  const res = placeBuilding({
    grid: state.grid, text: state.text, ids: grids.ids, data: grids.data,
    type, x: c.x, y: c.y, occupied: state.structureCells,
  });
  if (!res.ok) { setHint(res.reason, 'bad'); return; }
  let next = res.clearedOverlays > 0
    ? writeOverlayGrids(res.text, grids.ids, grids.data) : res.text;
  let extra = '';
  if (res.clearedOverlays) extra += `，清掉 ${res.clearedOverlays} 格 overlay`;
  if (res.removedObjects.length) extra += `，去掉 ${res.removedObjects.length} 个地形对象`;
  commitEdit(encodeLatin1(next), `已在 (${c.x}, ${c.y}) 放了${type.short}（${type.full}）${extra}。`);
  log(`编辑：建筑 ${type.id} @ (${c.x}, ${c.y})`);
}

function applyStartMove() {
  if (!state.hoverCell || state.selectedStart < 0) return;
  const pt = state.startPoints[state.selectedStart];
  if (!pt) return;
  if (pt.x === state.hoverCell.x && pt.y === state.hoverCell.y) return;
  const info = startCellInfo(state.hoverCell);
  if (!info.ok) { setHint(info.reason, 'bad'); return; }
  const next = rewriteWaypoint(state.text, pt.number, state.hoverCell.x, state.hoverCell.y);
  if (next === null) { setHint('地图里没有这个出生点。', 'bad'); return; }
  commitEdit(encodeLatin1(next),
    `玩家 ${playerNumberOf(pt)} 的出生点 → (${state.hoverCell.x}, ${state.hoverCell.y})。`);
  log(`编辑：玩家 ${playerNumberOf(pt)} 的出生点（waypoint ${pt.number}）→ `
    + `(${state.hoverCell.x}, ${state.hoverCell.y})`);
}

function applyCurrentArea() {
  if (!state.selCells.length) {
    setHint('选区里没有格子。', 'bad');
    return;
  }
  if (state.tool === 'ore') applyMineral(ORE_OVERLAY_START, '矿石');
  else if (state.tool === 'gems') applyMineral(GEM_OVERLAY_START, '彩矿');
  else if (state.tool === 'clear') applyClear();
}

// ---------------------------------------------------------------------------
// pointer handling
// ---------------------------------------------------------------------------
overlay.addEventListener('pointerdown', (event) => {
  if (!state.grid || !state.meta) return;
  if (event.button === 1) {
    state.dragging = 'pan';
    state.dragStart = { x: event.clientX, y: event.clientY,
                        left: viewport.scrollLeft, top: viewport.scrollTop };
    overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.button !== 0 && !(event.button === 2 && state.tool === 'brush')) return;
  const natural = toNatural(event);
  if (!natural) return;
  const p = clampNatural(natural);
  state.hover = p;
  state.hoverCell = cellAt(p);
  overlay.setPointerCapture(event.pointerId);

  if (state.tool === 'brush') {
    const erase = event.button === 2;
    state.dragging = erase ? 'brush-erase' : 'brush-add';
    state.lastBrushKey = null;
    state.selection = null;
    brushPaint(p, erase);
    event.preventDefault();
    return;
  }
  if (state.tool === 'select' || state.tool === 'owner') {
    state.dragging = 'box';
    state.dragStart = p;
    state.selection = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    state.selCells = [];
    state.counts = null;
    updateStatsPanel();
    draw();
    event.preventDefault();
    return;
  }
  if (state.tool === 'ore' || state.tool === 'gems' || state.tool === 'clear') {
    state.actionKind = state.tool === 'gems' ? 'gems' : 'ore';
    if (state.areaMode === 'box') {
      state.dragging = 'box';
      state.dragStart = p;
      state.selection = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      state.selCells = [];
      state.selKeys.clear();
      state.counts = null;
      updateStatsPanel();
      draw();
    } else {
      state.dragging = 'area-brush';
      state.lastBrushKey = null;
      state.selection = null;
      state.selCells = [];
      state.selKeys.clear();
      state.counts = null;
      brushPaint(p, false);
    }
    event.preventDefault();
    return;
  }
  if (state.tool === 'start') {
    // Pick the nearest start in screen pixels; otherwise the currently selected one.
    let best = -1, bestD = Infinity;
    const s = displayScale();
    const th = (state.meta.tileHeight / 2) * s;
    for (let i = 0; i < state.startPoints.length; ++i) {
      const sp = state.startPoints[i];
      const q = projectCell(state.grid, state.meta, sp.x, sp.y);
      const b = startBadgeCenter(q, s, th);
      // Either the cell or its number badge selects the start; the badge is
      // ~30 px above the cell, so a click on the number used to miss.
      const d = Math.min(Math.hypot((q.x - p.x) * s, (q.y - p.y) * s),
                         Math.hypot(b.x - p.x * s, b.y - p.y * s));
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD <= 18) state.selectedStart = best;
    if (state.selectedStart < 0 && state.startPoints.length) state.selectedStart = 0;
    state.dragging = 'start';
    state.dragStart = p;
    updateStartPanel();
    draw();
    event.preventDefault();
    return;
  }
  state.dragging = 'click';
  state.dragStart = p;
  draw();
  event.preventDefault();
});

overlay.addEventListener('pointermove', (event) => {
  if (state.dragging === 'pan') {
    viewport.scrollLeft = state.dragStart.left - (event.clientX - state.dragStart.x);
    viewport.scrollTop = state.dragStart.top - (event.clientY - state.dragStart.y);
    return;
  }
  const natural = toNatural(event);
  if (!natural) return;
  const p = clampNatural(natural);
  state.hover = p;
  const cell = cellAt(p);
  state.hoverCell = cell;
  updateCellReadout(cell);
  if (state.dragging === 'box') {
    state.selection = { x0: state.dragStart.x, y0: state.dragStart.y, x1: p.x, y1: p.y };
  } else if (state.dragging === 'area-brush') {
    brushPaint(p, false);
    return;
  } else if (state.dragging === 'brush-add' || state.dragging === 'brush-erase') {
    brushPaint(p, state.dragging === 'brush-erase');
    return;
  }
  draw();
});

overlay.addEventListener('pointerup', (event) => {
  if (state.dragging === 'pan') {
    state.dragging = null;
    return;
  }
  const natural = toNatural(event);
  const p = natural ? clampNatural(natural) : null;
  if (p) {
    state.hover = p;
    state.hoverCell = cellAt(p);
    updateCellReadout(state.hoverCell);
  }
  if (state.dragging === 'area-brush') {
    if (p) brushPaint(p, false);
    state.dragging = null;
    state.lastBrushKey = null;
    applyCurrentArea();
    return;
  }
  if (state.dragging === 'brush-add' || state.dragging === 'brush-erase') {
    if (p) brushPaint(p, state.dragging === 'brush-erase');
    state.dragging = null;
    state.lastBrushKey = null;
    draw();
    return;
  }
  if (state.dragging === 'box') {
    const r = state.selection;
    const dragged = r ? Math.hypot(r.x1 - r.x0, r.y1 - r.y0) : 0;
    state.dragging = null;
    if (!r || dragged < 6) {
      if (state.tool === 'owner') { selectStructureAt(state.hover); draw(); return; }
      clearSelection(); draw(); return;
    }
    setSelectionFromRect(r);
    draw();
    if (state.tool === 'owner') {
      // A tiny/short drag can select no cells; fall back to the building under
      // the pointer so a shaky click still selects.
      if (!state.selCells.length) { selectStructureAt(state.hover); draw(); return; }
      const picked = selectedStructures().length;
      setOwnerLast(`上次框选：${state.selCells.length} 格 · 命中 ${picked} 栋建筑`);
      log(`[owner] box ${state.selCells.length} cells -> ${picked} buildings`);
      updateOwnerPanel();
      return;
    }
    applyCurrentArea();
    return;
  }
  if (state.dragging === 'start') {
    state.dragging = null;
    applyStartMove();
    return;
  }
  if (state.dragging === 'click') {
    state.dragging = null;
    if (state.tool === 'pillar') applyPillar(false);
    else if (state.tool === 'unpillar') applyPillar(true);
    else if (state.tool.startsWith('build-')) applyBuilding();
    return;
  }
});

overlay.addEventListener('contextmenu', (event) => {
  if (state.tool === 'brush') event.preventDefault();
});
overlay.addEventListener('pointercancel', () => { state.dragging = null; draw(); });
overlay.addEventListener('pointerleave', () => {
  if (state.dragging) return;
  state.hover = null;
  state.hoverCell = null;
  draw();
});
overlay.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (state.tool === 'pillar' || state.tool === 'unpillar') {
    const p = toNatural(event);
    const cell = p ? cellAt(clampNatural(p)) : null;
    if (cell) { state.hoverCell = cell; applyPillar(true); }
  }
});

// wheel: Ctrl+wheel zooms at the cursor, plain wheel scrolls.
overlay.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  const natural = toNatural(event);
  zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15, natural);
}, { passive: false });

// ---------------------------------------------------------------------------
// zoom / fit
// ---------------------------------------------------------------------------
function applyZoom() {
  if (!img.naturalWidth) return;
  const width = Math.max(80, Math.round(img.naturalWidth * state.zoom));
  stage.style.width = `${width}px`;
  el('zoom-readout').textContent = `${Math.round(state.zoom * 100)}%`;
  sizeOverlay();
  draw();
}
function zoomBy(factor, anchorNatural = null) {
  const before = anchorNatural;
  const rect = img.getBoundingClientRect();
  const anchorClient = before ? {
    x: rect.left + before.x * rect.width / img.naturalWidth,
    y: rect.top + before.y * rect.height / img.naturalHeight,
  } : null;
  state.zoom = Math.max(0.1, Math.min(6, state.zoom * factor));
  applyZoom();
  if (anchorClient) {
    const rect2 = img.getBoundingClientRect();
    const after = {
      x: rect2.left + before.x * rect2.width / img.naturalWidth,
      y: rect2.top + before.y * rect2.height / img.naturalHeight,
    };
    viewport.scrollLeft += after.x - anchorClient.x;
    viewport.scrollTop += after.y - anchorClient.y;
  }
}
function fit() {
  if (!img.naturalWidth) return;
  const availW = Math.max(160, viewport.clientWidth - 40);
  const availH = Math.max(160, viewport.clientHeight - 40);
  state.zoom = Math.min(1, availW / img.naturalWidth, availH / img.naturalHeight);
  applyZoom();
}

window.addEventListener('resize', () => { applyZoom(); });

function updateCellReadout(cell) {
  if (!cell) { el('cell-readout').textContent = '—'; return; }
  const flags = cellFlags(state.grid, cell.x, cell.y);
  const level = cellLevel(state.grid, cell.x, cell.y);
  const bits = [];
  bits.push(`(${cell.x}, ${cell.y})`);
  bits.push(`高 ${level}`);
  if (!(flags & CELL_IN_MAP)) bits.push('图外');
  else if (flags & CELL_BUILDING) bits.push('建筑');
  else if (!(flags & CELL_PASSABLE)) bits.push('不可通行');
  else bits.push('可通行');
  el('cell-readout').textContent = bits.join(' · ');
}

// ---------------------------------------------------------------------------
// load session + boot
// ---------------------------------------------------------------------------
function showToolState(enabled) {
  for (const b of document.querySelectorAll('.tool')) b.disabled = !enabled;
}

async function loadFromSession() {
  setEmpty(null);
  showToolState(false);
  setBusy('正在读取地图会话……');
  const session = await loadSession();
  if (!session || !session.current) {
    setBusy(null);
    setEmpty('还没有拿到地图',
      '生成页生成并渲染一张图后，点预览图下方的「在编辑器中打开」。'
      + '编辑器会复用已经提取好的素材缓存，不需要再选游戏目录。', false);
    return;
  }
  if (!session.cells) {
    setBusy(null);
    setEmpty('缺少地面网格',
      '这次交接没有 .cells 侧车（生成器的地面网格），编辑器无法判断可通行/高度。'
      + '请回生成页重新点一次「在编辑器中打开」。', false);
    return;
  }
  state.session = session;
  state.sessionStarted = false;
  state.mapName = session.name || 'out.map';
  state.theater = Number(session.theater) || 0;
  state.bytes = new Uint8Array(session.current);
  state.grid = parseCellGrid(new Uint8Array(session.cells));
  if (!state.grid) {
    setBusy(null);
    setEmpty('地面网格损坏', '这次交接的 .cells 无法解析，请回生成页重新打开编辑器。', false);
    return;
  }
  try {
    parseMapState();
  } catch (err) {
    setBusy(null);
    setEmpty('地图格式不支持', String(err.message || err), false);
    return;
  }
  seedUndo();
  showToolState(true);
  updateUndoButtons();
  updateStatsPanel();
  state.zoom = 1;
  // The renderer gets the map + assets, then the image arrives via img.onload.
  setBusy('正在启动渲染器（首次约十几秒）……');
  await bootWorker();
  const ok = await loadAssetsFromCache(state.theater);
  if (!ok) { setBusy(null); return; }
  await renderNow();
  setBusy(null);
  clearSelection(false);
  setHint('工具会直接改地图并自动重新渲染；Ctrl+Z 撤销。', 'ok');
}

el('pick-assets').addEventListener('click', () => el('asset-pick').click());
el('asset-pick').addEventListener('change', async (event) => {
  const files = event.target.files;
  if (!files || !files.length) return;
  try {
    await bootWorker();
    const ok = await extractFromPickedDir(files);
    if (ok) {
      setEmpty(null);
      await renderNow();
    }
  } catch (err) {
    setBusy(null);
    setHint(`素材准备失败：${(err && err.message) || err}`, 'bad');
  }
});

el('retry-session').addEventListener('click', loadFromSession);
el('reload-session').addEventListener('click', loadFromSession);

// ---------------------------------------------------------------------------
// toolbar wiring
// ---------------------------------------------------------------------------
for (const b of document.querySelectorAll('.tool')) {
  b.addEventListener('click', () => setTool(b.dataset.tool));
}
el('sel-clear').addEventListener('click', () => {
  clearSelection();
  setHint('已清空选区。', 'ok');
});
el('undo').addEventListener('click', undo);
el('redo').addEventListener('click', redo);
el('render').addEventListener('click', () => renderNow());
el('fit').addEventListener('click', fit);
el('zoom-in').addEventListener('click', () => zoomBy(1.2));
el('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
el('zoom-reset').addEventListener('click', () => { state.zoom = 1; applyZoom(); });
el('reset-map').addEventListener('click', () => {
  if (!state.baseBytes) return;
  if (!window.confirm('把所有编辑退回到生成页交过来的地图？')) return;
  pushUndo();
  refreshFromBytes(new Uint8Array(state.baseBytes));
  setHint('已还原成生成时交过来的地图。', 'ok');
});

window.addEventListener('keydown', (event) => {
  const tag = (event.target && event.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const k = event.key;
  if ((event.ctrlKey || event.metaKey) && k.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && k.toLowerCase() === 'y') {
    event.preventDefault(); redo(); return;
  }
  if (k === 'Escape') { clearSelection(); setHint('已取消框选。'); return; }
  if (k === 'f' || k === 'F') { fit(); return; }
  if (k === 'r' || k === 'R') { renderNow(); return; }
  if (k === '+' || k === '=') { zoomBy(1.2); return; }
  if (k === '-') { zoomBy(1 / 1.2); return; }
  const tools = {
    1: 'select', b: 'brush', 2: 'ore', 3: 'gems', 4: 'clear', 5: 'pillar', 6: 'unpillar',
    7: 'build-CAOILD', 8: 'build-CAMACH', 9: 'build-CAOUTP', 0: 'start',
    h: 'owner',
  };
  if (tools[k]) setTool(tools[k]);
  else if (tools[k.toLowerCase()]) setTool(tools[k.toLowerCase()]);
});

// leave the page with a clean object URL lifetime
window.addEventListener('beforeunload', () => {
  if (state.mapUrl) URL.revokeObjectURL(state.mapUrl);
  if (state.pngUrl) URL.revokeObjectURL(state.pngUrl);
  if (state.RenderStop) {
    try { state.RenderStop(); } catch (err) { /* process is going away */ }
  }
});

// Build marker: visible in the tab title, so "which version am I looking at"
// can be answered without DevTools.  Bump with editor.js/editor.html changes.
document.title = '地图编辑器 · 2026-10-26h';

loadFromSession().catch((err) => {
  setBusy(null);
  setEmpty('编辑器启动失败', String((err && err.message) || err), false);
  log(String((err && err.stack) || err));
});
