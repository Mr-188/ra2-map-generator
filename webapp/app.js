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

for (const name of ['ore', 'water']) {
  const input = el(name);
  const out = el(`${name}-out`);
  const render = () => { out.value = (name === 'water' && input.value === '-1') ? '自动' : input.value; };
  input.addEventListener('input', render);
  render();
}

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

    const started = Date.now();
    const rc = Render('/maps/render.map', '/game', '/maps/render');
    if (rc !== 0) throw new Error(`渲染器返回 ${rc}`);
    const png = fs.readFile('/maps/render.png');

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    previewImg.src = previewUrl;
    previewDl.href = previewUrl;
    previewEl.style.display = 'block';
    previewCap.textContent =
      `用你自己的游戏素材渲染：${copied} 个文件，耗时 ${Date.now() - started} ms。` +
      `与 CNCMaps 本机渲染逐像素一致。`;
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


dirInput.addEventListener('change', () => {
  const all = Array.from(dirInput.files || []);
  const byName = new Map();
  for (const f of all) byName.set(f.name.toLowerCase(), f);
  const found = NEEDED.filter((n) => byName.has(n));
  const missing = NEEDED.filter((n) => !byName.has(n));

  picked.textContent = found.length
    ? `已找到 ${found.length}/${NEEDED.length}：${found.join('、')}` +
      (missing.length ? `（缺少 ${missing.join('、')}）` : '')
    : '没有在所选目录里找到需要的 .mix 文件。';

  archives = missing.length ? null : found.map((n) => ({ name: n, file: byName.get(n) }));
  goBtn.disabled = !(archives && booted);
  resultEl.style.display = 'none';
  errorEl.textContent = '';
});

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
    size: Number(el('size').value),
    players: Number(el('players').value),
    ore: Number(el('ore').value),
    water: Number(el('water').value),
    seed: Number(el('seed').value) >>> 0,
    mapSeed: 0,
    single,
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
