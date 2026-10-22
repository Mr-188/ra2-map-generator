// End-to-end test of the actual page in a real browser.
//
// Everything else in tools/ runs the engine in node, which does not exercise the
// parts that only exist in a browser: the worker, FileReaderSync, how Emscripten
// and the .NET runtime decide what host they are in, and the page's own message
// plumbing.  Three separate defects shipped because of that gap, so this drives
// the real thing.
//
//   node tools/verify_browser.mjs --game /path/to/RA2MD [--url http://127.0.0.1:8017/]
//
// Needs puppeteer-core and a Chromium; see tools/fetch_chromium.sh.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { decodeParams, encodeParams, enginePrefix, sizeFromIndex } from '../webapp/sharebits.js';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

// The symmetry kinds the engine DECLARES (engine/src/mirror.h), read rather than
// hard-coded: the page's <select> must offer exactly 0..max with none disabled, and
// a hard-coded list goes stale the moment a kind ships (measured: top-bottom landed
// in the header and in the page's options while this file still expected
// "0,1,2", so the suite went red over a feature that worked).
function declaredSymmetryMax() {
  try {
    // ROOT is the repository root: new URL('.') ends in a slash, so dirname drops 'tools/'.
    const header = fs.readFileSync(path.join(ROOT, 'engine', 'src', 'mirror.h'), 'utf8');
    const enumBody = header.split('enum class MapSymmetry')[1]?.split('};')[0] ?? '';
    const values = {};
    for (const m of enumBody.matchAll(/(\w+)\s*=\s*(\d+)/g)) values[m[1]] = Number(m[2]);
    const impl = header.match(
      /kMapSymmetryImplementedMax\s*=\s*static_cast<int>\(\s*MapSymmetry::(\w+)\s*\)/);
    if (!impl || values[impl[1]] === undefined) return null;
    return values[impl[1]];
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { url: 'http://127.0.0.1:8017/', timeout: 300000 };
  for (let i = 2; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}
const args = parseArgs(process.argv);
if (!args.game) {
  console.error('usage: node tools/verify_browser.mjs --game <RA2 dir> [--url ...]');
  process.exit(2);
}

function findChrome() {
  if (args.chrome) return args.chrome;
  const base = path.join(process.env.HOME || '', 'opt', 'chrome');
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'chrome') return p;
    }
  }
  return null;
}

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(`${label} ${detail}`.trim());
};

const chrome = findChrome();
if (!chrome) {
  console.log('no chromium found; run tools/fetch_chromium.sh');
  process.exit(2);
}

const bundles = ['ra2.mix', 'ra2md.mix', 'expandmd01.mix']
  .map((n) => path.join(args.game, n))
  .filter((p) => { if (!fs.existsSync(p)) { console.error(`missing ${p}`); process.exit(2); } return true; });

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'],
});

// Declared out here so the failure dump can still reach them.
const lines = [];
const workers = [];
const started = Date.now();
let page = null;
try {
  page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000 });

  // Everything the page and its worker say, in one place.  This is the thing
  // that was missing when the page could fail with nothing on screen.
  page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => lines.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('workercreated', (w) => {
    workers.push(w.url());
    lines.push(`[worker] created ${w.url()}`);
  });

  console.log(`  open     ${args.url}`);
  // domcontentloaded, not networkidle2: the engine keeps a wasm/worker stream open, so
  // the network never goes idle and the whole suite stalled here (measured 2026-10-21).
  // Readiness is the explicit waitForFunction('就绪') right below.
  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  check('page loaded', true, await page.title());

  // Wait for the engine to report ready.
  await page.waitForFunction(
    () => /就绪/.test(document.getElementById('status')?.textContent || ''),
    { timeout: 60000 });
  check('engine ready', true);
  check('worker is classic', workers.length > 0, workers.join(','));

  // The 对称 select offers every kind mirror.h implements -- 0 none, 1 left-right,
  // 3 top-bottom, 2/4 the two 180° halves -- plus one 随机, all ENABLED: the ready
  // message's mg_symmetry_max() is what greys out a kind the engine would refuse, so a
  // disabled option means the page and the engine disagree.  Each offered kind must be
  // enabled; the values are compared as a SET (reordering the menu is not a failure)
  // while hiding a kind, or offering one the engine refuses, still is.
  //
  // Top-bottom (3) is offered since 2026-10-21: the user asked for it after looking at
  // the maps it produces (outline, water and elevation symmetric; inland cliff lines keep
  // their facing on one half).  This is where that promise is pinned -- removing the
  // option again fails here first.
  const sym = await page.evaluate(() => {
    const s = document.getElementById('symmetry');
    if (!s) return null;
    return {
      values: [...s.options].map((o) => o.value),
      disabled: [...s.options].map((o) => o.disabled),
      value: s.value,
    };
  });
  const declaredMax = declaredSymmetryMax();
  const concrete = sym ? sym.values.filter((v) => v !== '?').map(Number) : [];
  const wildcards = sym ? sym.values.filter((v) => v === '?').length : 0;
  const expected = declaredMax === null ? null
    : Array.from({ length: declaredMax + 1 }, (_, k) => k);
  const everyKind = expected !== null && concrete.length === expected.length
    && expected.every((k) => concrete.includes(k));
  check(`the page offers every 对称 kind mirror.h ships (${expected ? expected.join('/') : '?'}) + 随机, all enabled`,
        sym !== null && everyKind && wildcards === 1
          && sym.disabled.every((d) => d === false) && sym.value === '0',
        sym ? `options ${sym.values.join('/')}, disabled ${sym.disabled.join('/')}, `
              + `selected ${sym.value} (mirror.h declares 0..${declaredMax})`
            : 'no #symmetry select');

  // ---- the 随机 entries, 全随机, and the 设置 drawer ---------------------------
  //
  // Every parameter the generator takes can be left to a roll, one at a time or all
  // at once, and the rolled values are printed rather than written back (app.js) -
  // including BOTH seeds (全局种子 and 地形种子, each rolled when its box holds 0) - so
  // what is checked here is the state the user sees.  Done BEFORE the archives are
  // injected, because the drawer's switch is persisted and this reloads the page to
  // prove it; the switch is turned back off afterwards so the rest of the suite -
  // which clicks 渲染预览 by hand - runs exactly as it did before.
  const ROLL_IDS = ['land', 'time', 'theater', 'players', 'ore', 'symmetry'];
  const noRandom = await page.evaluate((ids) => ids.filter((id) =>
    ![...document.getElementById(id).options].some((o) => o.value === '?')), ROLL_IDS);
  check('every variable parameter offers 随机', noRandom.length === 0,
        `missing on ${noRandom.join(', ')}`);

  // 地图类型 carries no 随机 and 全随机 must not touch it: multiplayer (.yrm) is the
  // layout that shows up in the game's skirmish list, so it is a deliberate choice.
  const kindUi = await page.evaluate(() => ({
    values: [...document.getElementById('kind').options].map((o) => o.value),
    value: document.getElementById('kind').value,
  }));
  check('地图类型 offers exactly 多人/单人 and defaults to 多人',
        kindUi.values.join(',') === '0,1' && kindUi.value === '0', JSON.stringify(kindUi));

  await page.click('#roll-all');
  const rollAll = await page.evaluate((ids) => ({
    values: ids.map((id) => document.getElementById(id).value),
    mode: [...document.querySelectorAll('#size-mode button')]
      .find((b) => b.classList.contains('on'))?.dataset.mode,
    seed: document.getElementById('seed').value,
    mapSeed: document.getElementById('map-seed').value,
    kind: document.getElementById('kind').value,
  }), ROLL_IDS);
  check('全随机 sets every variable parameter to 随机 and both seeds to 0 (地图类型 untouched)',
        rollAll.values.every((v) => v === '?') && rollAll.mode === 'random'
          && rollAll.seed === '0' && rollAll.mapSeed === '0'
          && rollAll.kind === '0',
        JSON.stringify(rollAll));

  await page.click('#settings-open');
  const drawer = await page.waitForFunction(
    () => !document.getElementById('settings').hidden
          && !document.getElementById('settings-backdrop').hidden, { timeout: 5000 })
    .then(() => true).catch(() => false);
  await page.click('#auto-render');
  await page.click('#settings-close');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => /就绪/.test(document.getElementById('status')?.textContent || ''),
    { timeout: 60000 });
  const persisted = await page.evaluate(() => ({
    checked: document.getElementById('auto-render').checked,
    stored: (() => {
      try { return JSON.parse(localStorage.getItem('ra2mg.settings') || '{}').autoRender; }
      catch { return null; }
    })(),
  }));
  check('设置 drawer opens and 自动渲染地图 survives a reload',
        drawer && persisted.checked === true && persisted.stored === true,
        `drawer=${drawer} ${JSON.stringify(persisted)}`);
  // Back off again: the auto-render path gets its own end-to-end check at the end.
  await page.click('#settings-open');
  await page.click('#auto-render');
  await page.click('#settings-close');

  // ---- the remembered game directory -----------------------------------------
  //
  // The handle (WHICH folder) is remembered in IndexedDB, but the permission to read
  // it belongs to the browser and often does not survive a restart.  app.js therefore
  // asks on boot (queryPermission) and reopens the folder silently when the answer is
  // still "granted"; only a downgraded permission needs the click, because
  // requestPermission() has to run inside a user gesture.
  //
  // Only the second half of that is testable here: minting a real handle needs the
  // native folder picker and a human, so the "granted" path cannot be driven from a
  // test.  What IS checked is the robustness the auto-restore path depends on - a
  // fresh profile shows no restore button, and a stored record that is not a usable
  // handle (an older browser's entry, or one this page cannot use) must not break boot
  // nor the manual button.
  const rememberUi = await page.evaluate(() => ({
    supported: typeof window.showDirectoryPicker === 'function',
    blockHidden: document.getElementById('remember').hidden,
    restoreHidden: document.getElementById('restore').hidden,
  }));
  check('remembered directory: fresh profile offers no restore button',
        !rememberUi.supported
          || (rememberUi.blockHidden === false && rememberUi.restoreHidden === true),
        JSON.stringify(rememberUi));

  const wrote = await page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('ra2-rmg', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onsuccess = () => {
      const st = open.result.transaction('handles', 'readwrite').objectStore('handles');
      const req = st.put({ name: 'RA2MD' }, 'gameDir');    // NOT a FileSystemHandle
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    };
    open.onerror = () => resolve(false);
  }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => /就绪/.test(document.getElementById('status')?.textContent || ''),
    { timeout: 60000 });
  const afterStale = await page.evaluate(() => ({
    restoreHidden: document.getElementById('restore').hidden,
    note: document.getElementById('remember-note').textContent.trim(),
    error: document.getElementById('error').textContent.trim(),
    ready: /就绪/.test(document.getElementById('status').textContent),
  }));
  check('a stored record that is not a handle does not break boot',
        wrote && afterStale.ready && afterStale.error === ''
          && afterStale.restoreHidden === false,
        `wrote=${wrote} ${JSON.stringify(afterStale)}`);
  await page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('ra2-rmg', 1);
    open.onsuccess = () => {
      const st = open.result.transaction('handles', 'readwrite').objectStore('handles');
      const req = st.delete('gameDir');
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(true);
    };
    open.onerror = () => resolve(true);
  }));

  // A webkitdirectory input cannot be populated with uploadFile() -- Chrome
  // ignores it and the FileList stays empty.  Instead fetch the archives over
  // HTTP and build real File objects in the page, then hand them to the same
  // change handler a human's folder pick would reach.  The files are the real
  // ones; nothing about the page's path changes.
  if (!args.gameurl) {
    check('archives accepted', false, 'pass --gameurl (an HTTP view of the game dir)');
    throw new Error('cannot feed the page without --gameurl');
  }
  console.log('  upload   fetching the archives in the page (~470 MB, local)');
  const landed = await page.evaluate(async (base, names) => {
    const dt = new DataTransfer();
    for (const n of names) {
      // The archives are hundreds of MB, so this is a STREAM (a pause, not a
      // re-read) rather than r.blob(): a half-finished multi-hundred-MB response
      // fails silently in the page and looks like a CORS problem when it is a
      // transport one.  Chunks are counted into the console so a stalled upload
      // says where it stopped instead of just "Failed to fetch".
      const r = await fetch(base + n);
      if (!r.ok) return { error: `${n}: HTTP ${r.status}` };
      const walk = r.body.getReader();
      const chunks = [];
      let got = 0;
      // Yield to the event loop between chunks: a tight read loop inside one
      // evaluate keeps the main thread busy for the whole ~470 MB, so the page's own
      // progress text (提取中…) is painted, then replaced by the result without the
      // waiters below ever seeing it - which read as "the cache never filled".
      for (;;) {
        const { done, value } = await walk.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        await new Promise((res) => setTimeout(res, 0));
      }
      console.log(`[upload] ${n}: ${got} bytes`);
      dt.items.add(new File(chunks, n));
    }
    const input = document.getElementById('dir');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { count: dt.files.length };
  }, args.gameurl, ['ra2.mix', 'ra2md.mix', 'expandmd01.mix']);
  if (landed.error) {
    check('archives accepted', false, landed.error);
    throw new Error(landed.error);
  }
  await page.waitForFunction(
    () => /已找到/.test(document.getElementById('picked')?.textContent || ''),
    { timeout: 120000 });
  const picked = await page.$eval('#picked', (e) => e.textContent);
  check('archives accepted', /已找到 3\/3/.test(picked), picked.trim());

  // The reported scenario: pick a folder, refresh, and NOT have to pick again.  That
  // needs the cache to exist from the PICK alone, so the extraction (and the cache
  // write that follows it) starts when the folder is picked - not on the first
  // generate, which is how it used to work and why a fresh pick + reload had none.
  // A failing run must say WHY, not just "the note never changed": the pick-time
  // extraction is where the user's report ("选了目录不缓存，也生成不了") lands, and
  // the page's own error / status text is the only place the reason appears.
  const snapshot = async (tag) => {
    const st = await page.evaluate(() => ({
      status: document.getElementById('status')?.textContent?.trim() || '',
      error: document.getElementById('error')?.textContent?.trim() || '',
      picked: document.getElementById('picked')?.textContent?.trim() || '',
      cache: document.getElementById('cache-note')?.textContent?.trim() || '',
      done: document.getElementById('done')?.textContent?.trim() || '',
    }));
    console.log(`  [snapshot ${tag}] ${JSON.stringify(st)}`);
    return st;
  };

  // The note is a live status line: it says 正在提取… first and only becomes
  // 已缓存素材 when BOTH theatres are written.  The wait therefore polls for the
  // end state on the elements that can carry it, and on timeout reports where it
  // stopped instead of quietly reading whatever the line said mid-extraction.
  //
  // The extraction END is not the cache END: #cache-note says 正在提取… while the
  // OPFS write runs and the failure arrives later as cache-failed.  Waiting only for
  // 已缓存素材 therefore failed on the write (with the page's own honest
  // "写缓存失败" text) instead of on the extraction.  Both end states are accepted
  // here, and the failure is reported verbatim.
  const cacheFilled = await page.waitForFunction(
    () => {
      const a = document.getElementById('cache-note')?.textContent || '';
      const b = document.getElementById('picked')?.textContent || '';
      const t = a + ' ' + b;
      if (/已缓存素材|写缓存失败|已清除浏览器缓存/.test(t)) return t;
      if (/未找到游戏目录|提取失败/.test(t)) return 'error:' + t;
      return false;
    },
    { timeout: 300000, polling: 500 }).then((h) => h.jsonValue()).catch(() => '');
  const cacheAfterPick = cacheFilled || (await page.evaluate(() => [
    document.getElementById('cache-note')?.textContent || '',
    document.getElementById('picked')?.textContent || '',
    document.getElementById('error')?.textContent || '',
  ].join(' | ').trim()));
  check('picking a folder alone fills the cache for BOTH theatres (no generate needed)',
        /已缓存素材/.test(cacheAfterPick) && /温和/.test(cacheAfterPick)
          && /雪地/.test(cacheAfterPick), cacheAfterPick);
  if (!/已缓存素材/.test(cacheAfterPick)) {
    // A cache write that lost the pick cannot be repaired by this run: the injected
    // File handles die with the page, and every later block here reloads.  Stop
    // with the reason on screen rather than cascading into misleading failures.
    await snapshot('after the pick-time wait');
    console.log(`\nBLOCKED: the pick-time cache write did not happen - ${cacheAfterPick}`);
    failures.push(`pick-time cache write failed: ${cacheAfterPick}`);
    throw new Error('pick-time cache write failed');
  }

  console.log('  generate');
  await page.click('#go');
  await page.waitForFunction(
    () => { const d = document.getElementById('result'); return d && d.style.display !== 'none'; },
    { timeout: args.timeout });
  const done = await page.$eval('#done', (e) => e.textContent);
  check('map generated', true, done.trim());

  console.log('  render   (first run downloads ~15 MB and starts the runtime)');
  await page.click('#render');
  const rendered = await page.waitForFunction(
    () => {
      const p = document.getElementById('preview');
      if (p && p.style.display !== 'none') return 'ok';
      const err = document.getElementById('error')?.textContent || '';
      if (err) return 'error:' + err;
      return false;
    },
    { timeout: args.timeout, polling: 1000 });
  const outcome = await rendered.jsonValue();

  if (String(outcome).startsWith('error:')) {
    check('preview rendered', false, String(outcome).slice(0, 400));
  } else {
    const cap = await page.$eval('#preview-cap', (e) => e.textContent);
    check('preview rendered', true, cap.trim());
    // src is set before the bitmap is decoded; wait for the decode.
    await page.waitForFunction(
      () => { const i = document.getElementById('preview-img'); return i && i.complete && i.naturalWidth > 0; },
      { timeout: 60000 });
    const img = await page.$eval('#preview-img', (e) => ({
      w: e.naturalWidth, h: e.naturalHeight, src: e.src.slice(0, 30),
    }));
    check('preview image decoded', img.w > 100, `${img.w}x${img.h}`);

    // The start positions have to be ON the preview: the render settings enable
    // CNCMaps's start markers (WebEntry.cs), so the page's own renderer must produce
    // the red squares.  Counted on a canvas from the decoded preview - the marker is
    // drawn at alpha 212 over terrain, which still leaves r>240 and g,b<40.
    const marks = await page.evaluate(() => {
      const img = document.getElementById('preview-img');
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let red = 0;
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 240 && d[i + 1] < 40 && d[i + 2] < 40) {
          ++red;
          const p = i / 4, x = p % c.width, y = Math.floor(p / c.width);
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      return { red, box: [minX, minY, maxX, maxY] };
    });
    check('the preview marks the start positions (red squares)',
          marks.red >= 1000, `${marks.red} red px, box ${JSON.stringify(marks.box)}`);

    // ---- the start-point editor -----------------------------------------
    //
    // The feature's claim is "click the picture, the marker moves, the picture
    // comes back".  That spans every piece (worker -> main thread -> renderer
    // metadata -> [Waypoints] rewrite), so this is the only honest place to test
    // it.  The click target is the amber marker the editor itself draws, read
    // back off the overlay canvas -- which also catches the failure this had
    // once: the overlay drawn somewhere other than the renderer's red square,
    // because a canvas is a replaced element and `inset` alone does not stretch
    // it (it kept its intrinsic 300x150).
    const editorOn = await page.$eval('#starts-bar', (e) => e.classList.contains('on'))
      .catch(() => false);
    check('the start-point editor is offered after a render', editorOn);

    if (editorOn) {
      const waypointLines = async () => {
        const href = await page.$eval('#download', (a) => a.href);
        return await page.evaluate(async (url) => {
          const buf = await (await fetch(url)).arrayBuffer();
          const text = new TextDecoder('latin1').decode(buf);
          const sec = (/\[Waypoints\]([\s\S]*?)(?=\n\[|$)/i.exec(text) || [])[1] || '';
          return sec.split('\n').map((s) => s.trim()).filter((s) => /^\d+\s*=/.test(s));
        }, href);
      };

      const before = await waypointLines();
      check('the map carries start waypoints', before.length > 0, before.join(' '));

      await page.click('#starts-edit');
      check('the editor opens on the preview',
            await page.$eval('#starts-layer', (e) => !e.hidden));

      const spot = await page.evaluate(() => {
        const img = document.getElementById('preview-img');
        const cv = document.getElementById('starts-layer');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let n = 0, sx = 0, sy = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 180) continue;
          if (Math.abs(d[i] - 242) < 30 && Math.abs(d[i + 1] - 192) < 40
              && Math.abs(d[i + 2] - 105) < 60) {
            const p = i / 4;
            n++; sx += p % cv.width; sy += Math.floor(p / cv.width);
          }
        }
        if (!n) return null;
        const r = cv.getBoundingClientRect();
        const k = r.width / cv.width;
        return { x: r.left + (sx / n) * k, y: r.top + (sy / n) * k,
                 cellW: 60 * (r.width / img.naturalWidth), n };
      });
      check('the editor draws the selected start on the preview', !!spot,
            spot ? `${spot.n} amber px` : 'none');

      if (spot) {
        // One cell to the side: starts sit on cleared ground, so the neighbour is
        // ground too.  Directions are tried because a start can sit at the edge of
        // its clearing.
        const dx = spot.cellW / 2;
        const dy = spot.cellW / 4;
        const targets = [
          { x: spot.x + dx, y: spot.y + dy },
          { x: spot.x - dx, y: spot.y - dy },
          { x: spot.x + dx, y: spot.y - dy },
          { x: spot.x - dx, y: spot.y + dy },
        ];
        let moved = false;
        let hint = '';
        for (const t of targets) {
          await page.mouse.click(t.x, t.y);
          hint = await page.$eval('#starts-hint', (e) => e.textContent);
          if (/出生点\s*\d+\s*→/.test(hint)) { moved = true; break; }
        }
        check('clicking the preview picks a cell for the selected start', moved, hint.trim());

        if (moved) {
          const srcBefore = await page.$eval('#preview-img', (e) => e.src);
          await page.click('#starts-apply');
          await page.waitForFunction((prev) => {
            const i = document.getElementById('preview-img');
            const err = document.getElementById('error')?.textContent || '';
            if (err) return 'error:' + err;
            return i && i.src !== prev && i.complete && i.naturalWidth > 0;
          }, { timeout: args.timeout, polling: 500 }, srcBefore);
          const after = await waypointLines();
          check('the moved start is written into the map and re-rendered',
                JSON.stringify(before) !== JSON.stringify(after),
                `${before.join(' ')} -> ${after.join(' ')}`);

          // Put the map back: the steps after this read the download blob and
          // expect the freshly generated one.
          const srcReset = await page.$eval('#preview-img', (e) => e.src);
          await page.click('#starts-reset');
          await page.waitForFunction((prev) => {
            const i = document.getElementById('preview-img');
            return i && i.src !== prev && i.complete && i.naturalWidth > 0;
          }, { timeout: args.timeout, polling: 500 }, srcReset);
          const restored = await waypointLines();
          check('还原 restores the generated map',
                JSON.stringify(restored) === JSON.stringify(before), restored.join(' '));
        }
      }
      await page.click('#starts-edit').catch(() => {});
    }

    if (args.shot) {
      await page.screenshot({ path: path.resolve(args.shot), fullPage: true });
      console.log(`  shot     ${path.resolve(args.shot)}`);
    }
  }

  // ---- non-square maps, all the way through the worker --------------------
  //
  // The page is the only place worker.js's argument marshalling is exercised, and
  // that is exactly where a silent truncation hides: `p.size | 0` turned the
  // slider's 1.5 into 1, and a missing width/height pair would leave the engine
  // making a square with no error anywhere.  So drive the UI and read the bytes
  // the engine actually wrote, rather than trusting the round-trip.
  console.log('  rect     switching to 长 × 宽 and asking for 380x100');
  await page.evaluate(() => {
    // Capture the map the page hands to the download link.
    if (!window.__mapBlob) {
      window.__mapBlob = null;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__mapBlob = blob; return orig(blob); };
    }
  });
  await page.click('#size-mode button[data-mode="rect"]');
  await page.evaluate(() => {
    const w = document.getElementById('rect-w');
    const h = document.getElementById('rect-h');
    w.value = '380';
    h.value = '100';
    w.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // The readout is the engine's own cell count, which the page asks the worker
  // for (mg_rect_cells), so it arrives a message later -- wait for the answer
  // instead of sampling the "…" that is still in flight.
  await page.waitForFunction(
    () => !/…/.test(document.getElementById('size-out')?.textContent || ''),
    { timeout: 15000 });
  const rectUi = await page.evaluate(() => ({
    w: document.getElementById('rect-w').value,
    h: document.getElementById('rect-h').value,
    out: document.getElementById('size-out').textContent,
  }));
  check('rect mode takes both sides', rectUi.w === '380' && rectUi.h === '100',
        `${rectUi.w} x ${rectUi.h} -> ${rectUi.out}`);

  await page.click('#go');
  await page.waitForFunction(
    () => { const d = document.getElementById('result'); return d && d.style.display !== 'none'; },
    { timeout: args.timeout });
  const size = await page.evaluate(async () => {
    if (!window.__mapBlob) return null;
    const text = new TextDecoder('latin1').decode(await window.__mapBlob.arrayBuffer());
    const m = text.match(/Size=\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  });
  // The writer's +4 / +12, which is what makes a request for 380x100 come out as
  // 384x112 -- and proves the two sides really are independent.
  check('rect map is non-square', Array.isArray(size) && size[0] === 384 && size[1] === 112,
        size ? `engine wrote Size=0,0,${size[0]},${size[1]}` : 'no map bytes captured');
  check('rect exceeds the square cap', Array.isArray(size) && size[0] > 247,
        size ? `width ${size[0]} vs the ~247 square cap` : 'no map bytes captured');

  // The readout must be the cell count the writer really emitted, not the visible
  // rect the page used to print (380 x 100 = 38,000).  The map is the diamond of
  // its iso bounding box, so it holds (2 * Size.width - 1) * Size.height cells --
  // the count tools/decode.py reads back out of a written map, and the number the
  // page gets from the engine rather than deriving itself.
  if (Array.isArray(size)) {
    const want = `${((2 * size[0] - 1) * size[1]).toLocaleString('en-US')} 格`;
    const outNow = await page.evaluate(() => document.getElementById('size-out').textContent);
    check("size readout is the written map's cell count", outNow === want,
          `page showed "${outNow}", the map holds ${want}`);
  }

  // The 对称 select has to reach the ENGINE through the worker, not merely exist.
  // The same rectangle is generated again with only the symmetry changed, so the two
  // maps are directly comparable, and the [Waypoints] section is the smallest part of
  // the file that proves the mirror applied.
  //
  // The page's one optional kind is 左右轴对称 (value 1), whose cell map in
  // engine/src/mirror.h is the pure swap of the two cell coordinates.
  const readBlob = () => page.evaluate(async () => {
    if (!window.__mapBlob) return null;
    return Array.from(new Uint8Array(await window.__mapBlob.arrayBuffer()));
  });
  const plain = await readBlob();
  await page.select('#symmetry', '1');
  await page.evaluate(() => { window.__mapBlob = null; });
  await page.click('#go');
  await page.waitForFunction(() => window.__mapBlob !== null, { timeout: args.timeout });
  const mirroredBytes = await readBlob();

  const textOf = (bytes) => (bytes ? new TextDecoder('latin1').decode(Buffer.from(bytes)) : '');
  const waypoints = (bytes) => {
    const section = (textOf(bytes).split('[Waypoints]')[1] || '').split('\n\n')[0];
    return section.split('\n').filter((l) => l.includes('='))
      .map((l) => l.split('=').map((n) => Number(n)));
  };
  const wa = waypoints(plain);
  const wb = waypoints(mirroredBytes);
  // The writer stores start points as X + 1000*Y (MapGenMapFile.cpp:1092), and the
  // left-right cell map is the PURE SWAP (engine/src/mirror.h:566, and the same
  // formula is written out independently in tools/verify_symmetry.py's mirror_cell).
  const mirror = (packed) => (packed % 1000) * 1000 + Math.floor(packed / 1000);
  // What the symmetric map must show is NOT "each waypoint equals the mirror of the
  // plain map's own".  A pairwise swap produces exactly that, and a swap is not a
  // symmetric map: it preserves whether a pair agrees.  The property is that the
  // symmetric map's own start points come in mirror pairs, with the count preserved
  // (a 2-player map has to stay a 2-player map).  The swap is its own inverse, so the
  // closed-set test below needs no range exception: every image is inside the map.
  const cells = wb.map(([, v]) => v);
  const paired = cells.length > 0 && cells.every((v) => cells.includes(mirror(v)));
  check("the page's 对称 option reaches the engine (左右轴对称)",
        wb.length > 0 && wb.length === wa.length && paired
          && Buffer.compare(Buffer.from(mirroredBytes || []), Buffer.from(plain || [])) !== 0,
        `waypoints ${JSON.stringify(wa)} -> ${JSON.stringify(wb)} ` +
        `(mirror-paired within the symmetric map: ${paired}, count, differs: ` +
        `${Buffer.compare(Buffer.from(mirroredBytes || []), Buffer.from(plain || [])) !== 0})`);

  // ---- 随机 + 自动渲染, end to end -------------------------------------------
  //
  // Two features that only mean something if they reach the engine, so this drives
  // both at once: every parameter is left on 随机 (全随机), and 自动渲染地图 is turned
  // on, so a single #go click has to roll the parameters, generate a map from them,
  // print what it rolled, and then render WITHOUT 渲染预览 being clicked.
  console.log('  random   all parameters to 随机, 自动渲染 on, one click');
  await page.click('#settings-open');
  await page.click('#auto-render');                 // back ON
  await page.click('#settings-close');
  await page.click('#roll-all');
  await page.evaluate(() => { window.__mapBlob = null; document.getElementById('rolled').textContent = ''; });
  await page.click('#go');
  await page.waitForFunction(() => window.__mapBlob !== null, { timeout: args.timeout });
  const rollNote = await page.$eval('#rolled', (e) => e.textContent.trim());
  const autoImg = await page.waitForFunction(
    () => {
      const p = document.getElementById('preview');
      if (p && p.style.display !== 'none'
          && document.getElementById('preview-img')?.naturalWidth > 0) return 'ok';
      const err = document.getElementById('error')?.textContent || '';
      return err ? 'error:' + err : false;
    },
    { timeout: args.timeout, polling: 1000 }).then((h) => h.jsonValue()).catch((e) => 'timeout:' + e.message);
  check('随机 rolls every parameter and prints what it used',
        /本次随机/.test(rollNote) && /环境=/.test(rollNote) && /地图大小=/.test(rollNote)
          && /全局种子=\d+/.test(rollNote) && /地形种子=\d+/.test(rollNote),
        `#rolled = "${rollNote}"`);
  check('自动渲染地图 renders by itself after a generation',
        autoImg === 'ok', String(autoImg));

  // ---- the cached extraction: a second visit without the game directory ---------
  //
  // The first generation above read the picked archives; the worker also wrote the
  // extracted tree (~13 MB / ~970 files) into OPFS.  This reloads the page with
  // NOTHING injected - no directory, no permission, no click - and requires the page
  // to be able to generate again, from the cache, producing the SAME bytes for the
  // same parameters.  Byte equality is the point: it proves the rehydrated MEMFS is
  // the tree the generator had, not merely "some assets that happen to work".
  console.log('  cache    first with the picked archives, then a reload with none');
  // Auto-render must be OFF for this section: it would create a second object URL for
  // the preview image and the blob captured below could be the PNG instead of the map.
  await page.click('#settings-open');
  if (await page.$eval('#auto-render', (e) => e.checked)) await page.click('#auto-render');
  await page.click('#settings-close');
  const setFixed = () => page.evaluate(() => {
    document.getElementById('land').value = '1';
    document.getElementById('time').value = '0';
    document.getElementById('theater').value = '0';
    document.getElementById('players').value = '2';
    document.getElementById('ore').value = '1';
    document.getElementById('symmetry').value = '0';
    document.getElementById('kind').value = '0';
    document.getElementById('seed').value = '20260913';
    // A FIXED terrain seed since 2026-10-21 (the box's 0 now means "roll one", and a
    // rolled value differs between runs by design).  The two runs compared below must
    // describe the same map, so the seed that would differ is pinned.
    document.getElementById('map-seed').value = '4242';
    document.getElementById('size').value = '1';
    document.querySelector('#size-mode button[data-mode="square"]').click();
  });
  const installCapture = () => page.evaluate(() => {
    if (!window.__captureWrapped) {
      window.__captureWrapped = true;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__mapBlob = blob; return orig(blob); };
    }
    window.__mapBlob = null;
  });
  const waitForReady = () => page.waitForFunction(
    () => /就绪/.test(document.getElementById('status')?.textContent || ''),
    { timeout: 60000 });

  await page.evaluate(() => { window.__mapBlob = null; });
  await setFixed();
  await page.click('#go');
  await page.waitForFunction(() => window.__mapBlob !== null, { timeout: args.timeout });

  // 参数集: the page has to show, for the map it just made, a code that decodes back
  // to the parameters of that run.  The codec itself is proven exact by
  // tools/verify_sharebits.mjs (every field, every slider position, every changed
  // character); this is the WIRING, where a code built from the wrong value would
  // still look perfectly fine on screen.  A regression here is silent, which is
  // exactly what this suite exists for.
  const shareCode = await page.$eval('#share-code', (e) => e.textContent.trim());
  const shareBlockShown = await page.$eval('#share', (e) => !e.hidden);
  let decoded = null;
  try { decoded = decodeParams(shareCode); } catch (err) { decoded = { error: String(err.message || err) }; }
  check('参数集 appears with the map and decodes to the run that made it',
        shareBlockShown && shareCode.length === 13
          && decoded.land === 1 && decoded.theater === 0 && decoded.time === 0
          && decoded.players === 2 && decoded.ore === 1 && decoded.single === false
          && decoded.symmetry === 0 && decoded.seed === 20260913
          // 地形种子 0 = 随机 since 2026-10-21: the box holds 0, the page rolls a
          // non-zero value for each run (the engine's own 0 would freeze the terrain
          // to the vanilla constant).  So the code carries SOMETHING non-zero here,
          // and the reproducibility itself is checked in the two runs below.
          && decoded.mapSeed > 0
          && decoded.mapSeed <= 0xFFFFFFFF
          // The size travels as the slider's index, not as a double: this is the
          // value the codec refuses to guess (sharebits.js's header explains why).
          && decoded.size === 1 && decoded.index === 10,
        `${shareCode} -> ${JSON.stringify(decoded)}`);

  // Clicking it must copy, and must say what actually happened -- the page falls
  // back to selecting the text when the Clipboard API is refused, so both outcomes
  // are honest and both are accepted here.  The wait is for the OUTCOME, not for
  // "the note is non-empty": it starts out holding the hint, and the clipboard call
  // is asynchronous (waiting on the hint reads it before the copy has resolved).
  await page.click('#share-code');
  const shareNote = await page.waitForFunction(
    () => {
      const t = document.getElementById('share-note').textContent.trim();
      return /已复制|Ctrl\+C/.test(t) ? t : false;
    },
    { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
  check('clicking the code reports a copy (or offers the manual one)',
        shareNote !== null, shareNote === null ? 'the note never changed from the hint' : shareNote);
  const withDir = await readBlob();
  // The cache write is posted as `cache-saved` once OPFS is done; wait for the note
  // to say so rather than guessing a delay.
  await page.waitForFunction(
    () => /已缓存素材/.test(document.getElementById('cache-note')?.textContent || ''),
    { timeout: 120000 }).catch(() => {});
  const noteWithCache = await page.$eval('#cache-note', (e) => e.textContent.trim());
  console.log(`  cache    ${noteWithCache}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady();
  // The cache lookup is a worker round trip: wait for the section to say it found one
  // rather than reading the note the instant the page is ready (it would read
  // "尚未缓存" and the assertion below would fail for a timing reason).
  await page.waitForFunction(
    () => /已缓存素材/.test(document.getElementById('cache-note')?.textContent || ''),
    { timeout: 60000 }).catch(() => {});
  await installCapture();
  await setFixed();
  const afterReload = await page.evaluate(() => ({
    note: document.getElementById('cache-note').textContent.trim(),
    goEnabled: !document.getElementById('go').disabled,
    picked: document.getElementById('picked').textContent.trim(),
  }));
  await page.click('#go');
  await page.waitForFunction(() => window.__mapBlob !== null, { timeout: args.timeout });
  const fromCache = await readBlob();
  const same = withDir && fromCache
    && Buffer.compare(Buffer.from(withDir), Buffer.from(fromCache)) === 0;
  check('cached extraction: a reload with no directory generates the same map',
        /已缓存素材/.test(afterReload.note) && afterReload.goEnabled && same
          && afterReload.picked === '',
        `note="${afterReload.note}" go=${afterReload.goEnabled} picked="${afterReload.picked}" `
          + `same=${same} (${withDir?.length}B vs ${fromCache?.length}B)`);

  // The reason the cache holds BOTH theatres: 随机 in the 剧场 row (or a manual switch)
  // must not send the user back to the folder picker.  Nothing is injected anywhere in
  // this block - the cache written from the single pick above is the only asset source.
  await page.select('#theater', '1');
  await installCapture();
  await page.click('#go');
  await page.waitForFunction(() => window.__mapBlob !== null, { timeout: args.timeout });
  const snowBytes = await readBlob();
  const snowNote = await page.$eval('#cache-note', (e) => e.textContent.trim());
  check('the cache covers 雪地 as well: switch the theatre, still no directory',
        !!snowBytes && snowBytes.length > 0
          && Buffer.compare(Buffer.from(snowBytes), Buffer.from(fromCache || [])) !== 0
          && /温和/.test(snowNote) && /雪地/.test(snowNote),
        `${snowBytes?.length}B, differs from 温和: `
          + `${Buffer.compare(Buffer.from(snowBytes || []), Buffer.from(fromCache || [])) !== 0}, `
          + `note="${snowNote.slice(0, 60)}…"`);

  // ---- the parameters of the last generation survive a refresh ----------------
  //
  // Clicking 生成 records every control (and the note about what the roll picked), and
  // boot puts them back, so a refresh does not cost the user their setup.  This is the
  // whole point of persisting them, so it is driven: set a distinctive setup, generate,
  // reload, and read the controls back.  The game directory is gone after the reload
  // (the injected Files die with the page); the cache written earlier covers it.
  console.log('  params   set a distinctive setup, generate, reload');
  const WANT = { land: '3', time: '2', theater: '1', players: '5', ore: '2',
                 symmetry: '1', kind: '1', seed: '12345', 'map-seed': '7' };
  await page.evaluate((want) => {
    for (const [id, v] of Object.entries(want)) document.getElementById(id).value = v;
    document.querySelector('#size-mode button[data-mode="rect"]').click();
    const w = document.getElementById('rect-w');
    const h = document.getElementById('rect-h');
    w.value = '200';
    h.value = '150';
    w.dispatchEvent(new Event('input', { bubbles: true }));
  }, WANT);
  await installCapture();
  await page.click('#go');
  await page.waitForFunction(() => window.__mapBlob !== null, { timeout: args.timeout });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady();
  const restored = await page.evaluate((ids) => {
    const o = {};
    for (const id of ids) o[id] = document.getElementById(id).value;
    o.sizeMode = [...document.querySelectorAll('#size-mode button')]
      .find((b) => b.classList.contains('on'))?.dataset.mode;
    o.rectW = document.getElementById('rect-w').value;
    o.rectH = document.getElementById('rect-h').value;
    return o;
  }, Object.keys(WANT));
  const wrong = Object.entries(WANT).filter(([k, v]) => restored[k] !== v);
  check('the last generated parameters come back after a refresh',
        wrong.length === 0 && restored.sizeMode === 'rect'
          && restored.rectW === '200' && restored.rectH === '150',
        wrong.length ? `restored wrong: ${JSON.stringify(wrong)}`
                     : JSON.stringify(restored));

  // ---- 参数集: importing a code, and the version it came from ----------------
  //
  // The export half is checked above (the code appears with the map and decodes back
  // to that run).  This is the receiving half: a code made by ANOTHER build has to
  // restore its parameters and say so, offering the 历史版本 switch that already
  // exists -- carrying the code in the fragment, or the player lands on the old page
  // with nothing to check.
  //
  // The page's own version.json / versions.json are served by interception: this
  // runs from a source checkout, where neither file exists, and publishing a build
  // is not something a test may do.
  console.log('  参数集  importing a code from an older build');
  {
    const OWN_ENGINE = '30a88bb1c0ffee00';
    const OLD_ENGINE = '9f1c02abdeadbeef';
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.pathname === '/version.json') {
        return req.respond({ contentType: 'application/json', body: JSON.stringify({
          version: '2026.10.13.2', engine: OWN_ENGINE }) });
      }
      if (u.pathname === '/versions.json') {
        return req.respond({ contentType: 'application/json', body: JSON.stringify({
          current: '2026.10.13.2',
          versions: [{ version: '2026.10.13.2', path: '/', engine: OWN_ENGINE },
                     { version: '2026.10.11', path: '/v/2026.10.11/', engine: OLD_ENGINE }] }) });
      }
      return req.continue();
    });

    const code = encodeParams({
      land: 1, theater: 0, time: 0, players: 2, ore: 1, single: false, symmetry: 4,
      size: 1, width: 0, height: 0, seed: 424242, mapSeed: 0,
      engine: enginePrefix(OLD_ENGINE),
    }).code;

    // A shared link is a real page load: set the fragment and RELOAD.  Navigating to
    // the same path with only a different fragment is a same-document navigation --
    // it fires hashchange but does not re-run the page, so version.json is not
    // fetched again (which is how this check first failed, the page reporting "no
    // version.json" while the interception above was serving one).
    await page.evaluate((c) => { location.hash = `p=${c}`; }, code);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForReady();
    await page.waitForFunction(
      () => /2026\.10\.11/.test(document.getElementById('import-note')?.textContent || ''),
      { timeout: 30000 }).catch(() => {});
    const imported = await page.evaluate(() => ({
      note: document.getElementById('import-note').textContent.trim(),
      noteIsError: /err/.test(document.getElementById('import-note').className),
      switchHidden: document.getElementById('import-switch').hidden,
      switchHref: document.getElementById('import-switch').getAttribute('href') || '',
      land: document.getElementById('land').value,
      symmetry: document.getElementById('symmetry').value,
      seed: document.getElementById('seed').value,
    }));
    check('a code in the URL restores its parameters without a click',
          imported.land === '1' && imported.symmetry === '4' && imported.seed === '424242'
            && imported.noteIsError === false,
          `land=${imported.land} symmetry=${imported.symmetry} seed=${imported.seed}`);
    check('the page says the code came from another version',
          /本页是 2026\.10\.13\.2/.test(imported.note) && /2026\.10\.11/.test(imported.note),
          imported.note);
    check('and offers the switch to it, carrying the code',
          imported.switchHidden === false
            && imported.switchHref === `/v/2026.10.11/#p=${code}`,
          imported.switchHref);

    // A code carrying TOP-BOTTOM has to be applied like any other kind (it used to be
    // refused while the page withheld it).  The point of the check is that the page and
    // the code agree again: the select ends up on 3, the form keeps the code's seed, and
    // the note does not report an error.
    const readForm = () => page.evaluate(() => ({
      land: document.getElementById('land').value,
      symmetry: document.getElementById('symmetry').value,
      seed: document.getElementById('seed').value,
      note: document.getElementById('import-note').textContent.trim(),
      noteIsError: /err/.test(document.getElementById('import-note').className),
    }));
    await page.evaluate(() => { location.hash = ''; });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForReady();

    const topBottom = encodeParams({
      land: 3, theater: 0, time: 0, players: 2, ore: 1, single: false, symmetry: 3,
      size: 1, width: 0, height: 0, seed: 777777, mapSeed: 0,
      engine: enginePrefix(OWN_ENGINE),
    }).code;
    await page.evaluate((c) => { location.hash = `p=${c}`; }, topBottom);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForReady();
    await page.waitForFunction(
      () => document.getElementById('symmetry')?.value === '3',
      { timeout: 30000 }).catch(() => {});
    const applied = await readForm();
    check('a code using 上下对称 restores it (the kind ships again)',
          applied.symmetry === '3' && applied.land === '3' && applied.seed === '777777'
            && !applied.noteIsError,
          applied.note);

    // A rectangle code takes the other commit path in applyDecodedShare: 长 × 宽 mode
    // plus the two number inputs, instead of the slider.
    const rectCode = encodeParams({
      land: 1, theater: 0, time: 0, players: 2, ore: 1, single: false, symmetry: 0,
      size: 0, width: 380, height: 100, seed: 31337, mapSeed: 0,
      engine: enginePrefix(OWN_ENGINE),
    }).code;
    await page.$eval('#import-code', (e, v) => { e.value = v; }, rectCode);
    await page.click('#import-go');
    await page.waitForFunction(
      () => document.querySelector('#size-mode button.on')?.dataset.mode === 'rect',
      { timeout: 10000 }).catch(() => {});
    const rectImport = await page.evaluate(() => ({
      mode: document.querySelector('#size-mode button.on')?.dataset.mode,
      w: document.getElementById('rect-w').value,
      h: document.getElementById('rect-h').value,
      seed: document.getElementById('seed').value,
      note: document.getElementById('import-note').textContent.trim(),
    }));
    check('a rectangle code restores 长 × 宽 mode and both sides',
          rectImport.mode === 'rect' && rectImport.w === '380' && rectImport.h === '100'
            && rectImport.seed === '31337' && /相同/.test(rectImport.note),
          JSON.stringify(rectImport));
  }

  // ======================= 画廊 (gallery.html) =======================
  //
  // The second page: a catalogue of 参数集 maintained by hand in a text file, where the
  // tag on every card is DECODED from the code rather than typed next to it.  It gets
  // its own checks because it is one header click from the generator, and every one of
  // its promises can rot silently: the list file, the batch machinery, the links that
  // carry a code, the chips that claim to describe it, and the card that has to land in
  // the generator with those parameters actually loaded.
  //
  // Runs LAST on purpose: it reuses the OPFS asset cache the earlier sections filled, so
  // the generator it opens is ready without a game directory.
  const gal = await browser.newPage();
  await gal.setViewport({ width: 1280, height: 900 });
  gal.on('pageerror', (e) => lines.push(`[gallery pageerror] ${e.message}`));
  gal.on('console', (m) => { if (m.type() === 'error') lines.push(`[gallery console] ${m.text()}`); });

  // A synthetic version, so "is this from another build?" has a known answer.  The engine
  // id is the one the fixture entries (below) use for their OLD builds: that makes
  // 另一个版本 appear on exactly the cards whose code says so, which is what gets checked.
  const GALLERY_ENGINE = '9f1c02abdeadbeef';

  // The list is the repository's own file first: that is what ships, and the checks below
  // validate whatever the curator has put in it.  When it is EMPTY -- which is how the
  // site ships, the first entry being the curator's to add -- a fixture is served over
  // interception instead, so an empty file never means an untested gallery.  The empty
  // state itself is checked first, against the real file, because that is what a visitor
  // would see today.
  const listText = (() => {
    const real = fs.readFileSync(path.join(ROOT, 'webapp/gallery.txt'), 'utf8');
    const codes = real.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.split('|')[0].trim());
    if (codes.length > 0) return { text: real, fixture: false };
    const legal = (over) => encodeParams({ land: 1, theater: 0, time: 0, players: 4, ore: 1,
      single: false, symmetry: 1, size: sizeFromIndex(30, 0.1), width: 0, height: 0,
      seed: 20260913, mapSeed: 0, engine: enginePrefix(GALLERY_ENGINE), ...over }).code;
    return { fixture: true, text: [
      '# 夹具：仓库里那份清单是空的（站点就是这样发布的），这一份由验收脚本通过请求拦截喂给页面。',
      `${legal({})} | 测试甲 | 2026-01-02 | 甲图 | 夹具条目：本版能做的方形图。`,
      // 乙图 carries a THIRD engine id on purpose: that is what makes the card show
      // 另一个版本, and it is still buildable here (only the code's provenance differs).
      `${legal({ land: 3, size: sizeFromIndex(9, 0.1), width: 200, height: 150, engine: 200 })} | 测试乙 | 2026-01-03 | 乙图 | 夹具条目：非方图，码里是另一个版本。`,
      // 丙图 is the withdrawn kind AND says this very build made it -- the case with
      // nowhere to send the player, so no switch may be offered (a switch is only useful
      // when the code names another build; see describeShareOrigin).
      `${legal({ land: 2, players: 6, symmetry: 3, size: sizeFromIndex(9, 0.1), seed: 24680 })} | 测试丙 | 2026-01-04 | 丙图 | 夹具条目：上下对称，本版已撤回。`,
      // 只做「能不能换一批 / 刷新换顺序」这类检查需要"批里不止一条、且整体多于一批"：
      // 夹具原来只有 3 条（其中一条还是被撤回的那种），批大小就等于条数，顺序根本无从改变 ——
      // 那两条检查因此恒定失败。补几条本版能做的，让洗牌真的有东西可换。
      `${legal({ symmetry: 2, seed: 11111 })} | 测试丁 | 2026-01-05 | 丁图 | 夹具条目：旋转对称。`,
      `${legal({ symmetry: 4, seed: 22222 })} | 测试戊 | 2026-01-06 | 戊图 | 夹具条目：旋转对称（另一版）。`,
      `${legal({ water: 2, seed: 33333 })} | 测试己 | 2026-01-07 | 己图 | 夹具条目：多水。`,
      `${legal({ players: 2, size: sizeFromIndex(15, 0.1), seed: 44444 })} | 测试庚 | 2026-01-08 | 庚图 | 夹具条目：小图两玩家。`,
    ].join('\n') + '\n' };
  })();
  if (listText.fixture) {
    console.log('  note   gallery.txt 是空的：清单相关的检查改用夹具（页面状态仍按真实文件检查）');
  }

  const galleryUrl = new URL('gallery.html', args.url).href;
  await gal.goto(galleryUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await gal.waitForFunction(() => document.getElementById('grid') !== null, { timeout: 30000 });
  check('gallery page opened', true, galleryUrl);

  if (listText.fixture) {
    const shipped = await gal.evaluate(() => ({
      count: document.getElementById('count').textContent.trim(),
      empty: document.getElementById('empty').hidden ? '' : document.getElementById('empty').textContent.trim(),
      maps: document.querySelectorAll('.card:not(.tile)').length,
      tile: !!document.querySelector('.card.tile'),
      more: document.getElementById('more').hidden,
      banner: document.getElementById('sample').hidden ? '' : document.getElementById('sample').textContent.trim(),
    }));
    check('an empty gallery says so, offers the door, and shows no error',
          shipped.maps === 0 && /还没有收录地图/.test(shipped.empty) && shipped.tile
            && shipped.more === true && shipped.banner === '' && /^0 \/ 0/.test(shipped.count),
          JSON.stringify(shipped));
    await gal.setRequestInterception(true);
  }
  gal.on('request', (req) => {
    const url = req.url().split('?')[0];
    if (listText.fixture && url.endsWith('/gallery.txt')) {
      return req.respond({ contentType: 'text/plain; charset=utf-8', body: listText.text });
    }
    if (url.endsWith('/version.json')) {
      return req.respond({ contentType: 'application/json', body: JSON.stringify({
        version: '2099.01.01', commit: 'c0ffee1',
        builtAt: '2099-01-01T00:00:00+0800', engine: GALLERY_ENGINE }) });
    }
    if (url.endsWith('/versions.json')) {
      return req.respond({ contentType: 'application/json', body: JSON.stringify({
        current: '2099.01.01',
        versions: [{ version: '2099.01.01', path: '/', commit: 'c0ffee1', engine: GALLERY_ENGINE }] }) });
    }
    req.continue();
  });
  if (listText.fixture) {
    await gal.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await gal.waitForFunction(() => document.querySelectorAll('.card:not(.tile)').length > 0,
                              { timeout: 30000 });
  }

  // Parsed here the way the page parses it, so "one line per card" is checked against the
  // list and not against the page.  The list is a SET -- the page shuffles it on every
  // load -- so nothing below may assume the cards come out in file order; every
  // expectation is derived from the code each card carries.
  const galleryLines = listText.text
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  const fileCodes = galleryLines.map((l) => l.split('|')[0].trim());
  // A code of our own for the checks that just need "a valid 参数集" (the import hint
  // below): generated here rather than taken from gallery.txt, which ships EMPTY -- the
  // first real entry is the curator's to add.
  const sampleCode = encodeParams({ land: 1, theater: 0, time: 0, players: 4, ore: 1,
    single: false, symmetry: 1, size: sizeFromIndex(30, 0.1), width: 0, height: 0,
    seed: 20260913, mapSeed: 0, engine: enginePrefix(GALLERY_ENGINE) }).code;
  const PAGE_SIZE = 24;                       // keep in step with webapp/gallery.js
  const batchSize = Math.min(galleryLines.length, PAGE_SIZE);

  const galCards = await gal.$$eval('.card', (ns) => ns.map((n) => ({
    tile: n.classList.contains('tile'),
    title: n.querySelector('.title')?.textContent.trim() || '',
    code: n.querySelector('.code')?.textContent.trim() || '',
    href: n.querySelector('a.hit')?.getAttribute('href') || '',
    chips: [...n.querySelectorAll('.chip')].map((c) => c.textContent.trim()),
    tags: [...n.querySelectorAll('.tag')].map((c) => c.textContent.trim()),
  })));
  const mapCards = galCards.filter((c) => !c.tile);
  check(`gallery draws a batch of gallery.txt (${batchSize} of ${galleryLines.length})`,
        mapCards.length === batchSize, `cards=${mapCards.length}`);
  check('and every card it drew came from the file, exactly once',
        new Set(mapCards.map((c) => c.code)).size === mapCards.length
          && mapCards.every((c) => fileCodes.includes(c.code)),
        mapCards.map((c) => c.code).filter((c) => !fileCodes.includes(c)).join(' '));
  const tile = galCards.find((c) => c.tile);
  check('the grid closes with a "自己摇一张" tile that opens the generator',
        galCards.filter((c) => c.tile).length === 1
          && tile === galCards[galCards.length - 1] && tile.href === './index.html',
        tile && tile.href);

  // Every card carries its code into the generator, and that code decodes.
  const badHref = mapCards.filter((c) => !/^\.\/index\.html#p=[A-Za-z0-9_-]+$/.test(c.href));
  check('every card links into the generator with its 参数集 in the fragment',
        badHref.length === 0, badHref.map((c) => `${c.title}:${c.href}`).join(' '));
  const undecodable = mapCards.filter((c) => {
    try { decodeParams((/#p=([A-Za-z0-9_-]+)$/.exec(c.href) || [])[1] || ''); return false; }
    catch { return true; }
  });
  check('every code a card carries decodes', undecodable.length === 0,
        undecodable.map((c) => c.code).join(' '));

  // The chips have to come from the code.  Checked two ways, because the two pages word
  // a chip differently on purpose: the gallery has no field label in front of it (it
  // says 无对称 where the <select> says 无), so the fields with a shared wording are
  // compared exactly, and the ones that legitimately differ are pinned as one stable,
  // DISTINCT word per value.  That is what breaks when someone types a tag next to a
  // code instead of letting it decode.
  const pairs = mapCards.map((card) => ({ card, p: decodeParams(card.code) }));
  // An EMPTY list is a legitimate state -- it is what the site ships with, before anyone
  // submits a map -- so everything below that needs entries is guarded rather than
  // assumed.  Where a check has nothing to look at it says so in its detail line instead
  // of passing silently: "ok" with a reason is honest, an invisible skip is not.
  const hasEntries = pairs.length > 0;
  const EMPTY_LIST = '(gallery.txt 还没有条目)';
  const playersBad = pairs.filter(({ p, card }) => !card.chips.includes(`${p.players} 人`));
  const sizeBad = pairs.filter(({ p, card }) => !card.chips.some((c) => (p.width > 0
    ? c === `${p.width} × ${p.height}` : /^尺寸 /.test(c))));
  check('the 人数 and 尺寸 chips match the decoded code on every card',
        playersBad.length === 0 && sizeBad.length === 0,
        `players=${playersBad.length} size=${sizeBad.length} of ${pairs.length}`);


  const galleryLand = hasEntries
    ? await page.evaluate((land) =>
        document.querySelector(`#land option[value="${land}"]`)?.textContent.trim() || null,
        String(pairs[0].p.land))
    : null;
  check('the environment chip is the word the generator itself uses',
        !hasEntries || (!!galleryLand && pairs[0].card.chips[0] === galleryLand),
        hasEntries ? `${pairs[0].card.chips[0]} vs select=${galleryLand}` : EMPTY_LIST);
  for (const [field, position] of [['环境', 0], ['对称', 2]]) {
    const perValue = new Map();
    for (const { p, card } of pairs) {
      const key = field === '环境' ? p.land : p.symmetry;
      if (!perValue.has(key)) perValue.set(key, new Set());
      perValue.get(key).add(card.chips[position] || '');
    }
    const values = [...perValue.keys()];
    const texts = values.map((v) => [...perValue.get(v)][0]);
    check(`the ${field} chip is one stable, distinct word per value (${values.length} values)`,
          values.every((v) => perValue.get(v).size === 1 && [...perValue.get(v)][0] !== '')
            && new Set(texts).size === texts.length,
          texts.join(' / '));
  }
  // Two decoded fields are deliberately NOT chips (user decision, 2026-10-21): the
  // map-type layout (多人 .yrm / 单人 .map) and the "换过地形种子" note.  Pinned here so
  // they cannot quietly come back.
  const hiddenChips = pairs.filter(({ card }) => card.chips.some(
    (c) => /\.yrm|\.map|地形种子/.test(c)));
  check('the map-type and terrain-seed chips are not shown on cards',
        hiddenChips.length === 0,
        hiddenChips.length ? `${hiddenChips.length} card(s) still carry one` : EMPTY_LIST);

  // Cards from another build say so, and the count comes from the codes actually drawn:
  // decoded engine id against this page's engine, never from what the page claims.
  const mine = enginePrefix(GALLERY_ENGINE);
  const expectMarked = pairs.filter(({ p }) => p.engine && p.engine !== mine).length;
  const drawnMarked = mapCards.filter((c) => c.tags.includes('另一个版本')).length;
  check('cards from another build are marked, counted from their own codes',
        drawnMarked === expectMarked, `drawn=${drawnMarked} expected=${expectMarked}`);

  // The batches: the button, the automatic load on scroll, and the end of the list.
  const moreNow = await gal.$eval('#more', (b) => ({ hidden: b.hidden, text: b.textContent.trim() }));
  if (galleryLines.length > PAGE_SIZE) {
    check('a 加载更多 button says how many are left',
          !moreNow.hidden && /还有 \d+ 条/.test(moreNow.text), moreNow.text);
    await gal.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await gal.waitForFunction((n) => document.querySelectorAll('.card:not(.tile)').length === n,
                              { timeout: 20000 }, galleryLines.length);
    const gone = await gal.$eval('#more', (b) => b.hidden);
    check('scrolling to the bottom loads the rest, and the button goes away',
          gone === true, `cards=${galleryLines.length}`);
  } else {
    check('the whole list fits in one batch (no button)', moreNow.hidden, moreNow.text);
  }

  // ---- the order is deliberately meaningless --------------------------------
  // gallery.txt is a set: every load shuffles it, so there is no "position" to maintain
  // and adding an entry never means deciding where it goes.  The properties below are
  // about ORDER only -- because the batch is a random 24 of 26, the cards on screen can
  // legitimately differ between two reads (which is the point of the shuffle), so an
  // assertion about "the same cards" would be testing the wrong thing.
  const drawnCodes = () => gal.$$eval('.card:not(.tile) .code',
    (ns) => ns.map((n) => n.textContent.trim()));
  const sharedInOrder = (a, b) => b.filter((c) => a.includes(c)).join();
  const defaultSort = await gal.$eval('#f-sort', (s) => s.value);
  check('排序 defaults to 随机', defaultSort === 'random', defaultSort);

  if (!hasEntries) {
    check('the shuffle / batch behaviour needs entries', true, EMPTY_LIST);
  } else {
  const beforeFilter = await drawnCodes();
  await gal.select('#f-land', String(pairs[0].p.land));
  await new Promise((r) => setTimeout(r, 250));
  const filtered = await drawnCodes();
  await gal.select('#f-land', '');
  await new Promise((r) => setTimeout(r, 250));
  const backAgain = await drawnCodes();
  // The batch length itself may differ (clearing a filter re-batches, and the auto-load
  // may not have fired yet), so compare the cards both reads share -- in relative order.
  check('filtering keeps every card where it was (the shuffle is per load, not per render)',
        sharedInOrder(beforeFilter, backAgain) === sharedInOrder(backAgain, beforeFilter)
          && filtered.length > 0
          && filtered.join() === sharedInOrder(beforeFilter, filtered),
        `${beforeFilter.length} → ${filtered.length} → ${backAgain.length}`);

  await gal.click('#f-again');
  await new Promise((r) => setTimeout(r, 250));
  const afterAgain = await drawnCodes();
  // 换一批 starts the batches over AND re-draws which cards are in the batch: a new order
  // over a newly drawn subset is still "a different gallery", so all that is asserted is
  // that the order changed and nothing invented appeared.
  const overlap = Math.min(backAgain.length, afterAgain.length);
  const sameSpots = afterAgain.slice(0, overlap).filter((c, i) => c === backAgain[i]).length;
  check('换一批 draws a new order without a reload',
        overlap > 1 && sameSpots < overlap && afterAgain.every((c) => fileCodes.includes(c)),
        `same positions: ${sameSpots}/${overlap} drawn=${afterAgain.length}`);

  await gal.goto(galleryUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await gal.waitForFunction(() => document.getElementById('grid') !== null, { timeout: 30000 });
  const nextLoad = await drawnCodes();
  check('a reload comes back in a different order (1 in 26! by chance)',
        nextLoad.join() !== afterAgain.join(),
        `same positions: ${nextLoad.filter((c, i) => c === afterAgain[i]).length}/${nextLoad.length}`);
  await gal.select('#f-sort', 'new');
  await new Promise((r) => setTimeout(r, 250));
  const newest = await gal.$eval('.card:not(.tile) .meta', (m) => m.textContent.trim());
  await gal.select('#f-sort', 'old');
  await new Promise((r) => setTimeout(r, 250));
  const oldest = await gal.$eval('.card:not(.tile) .meta', (m) => m.textContent.trim());
  check('最新 / 最早 are still real date sorts (and disagree)',
        newest !== oldest, `${newest} vs ${oldest}`);
  await gal.select('#f-sort', 'random');
  await new Promise((r) => setTimeout(r, 250));
  }

  // The footer this page shares with the generator.  verify_deploy checks the source and
  // the served bytes; this checks the RENDERED page, which a CSS rule could hide.
  const footText = await gal.$eval('footer.foot', (f) => f.innerText);
  check('the gallery footer shows the filing numbers',
        /苏ICP备2023037209号-2/.test(footText) && /苏公网安备32081202000454号/.test(footText)
          && /与 EA 无关/.test(footText));

  // 投稿 is a function of the site, not decoration: the group number appears where a
  // player decides to submit (the tile, and the export block right after a map) and in
  // the footer.  Read out of the footer instead of hard-coded, so changing the group is
  // one edit -- and forgetting one of these spots fails here rather than silently
  // sending people to a dead group.
  const groupNo = (/(?:QQ 群|QQ群)\s*(\d{6,12})/.exec(footText) || [])[1] || '';
  const tileTip = await gal.$eval('.tile-tip', (e) => e.textContent.trim());
  const shareTip = await page.$eval('.share-tip', (e) => e.textContent.trim());
  check('the 投稿 spots all carry the footer\'s group number',
        !!groupNo && tileTip.includes(groupNo) && shareTip.includes(groupNo),
        `${groupNo || '(没读到群号)'} tile=${tileTip.includes(groupNo)} share=${shareTip.includes(groupNo)}`);

  // The gallery link in the import box is part of the HINT line, and that is the whole
  // point of it: "paste the code you were sent" and "where would I get one" are two
  // halves of one thought, so they are one line -- and the link leaves with the hint,
  // because every other state (已载入 / 本页做不出来 / 读不出来) replaces the line with
  // status text.  Measured 2026-10-14: as a SIBLING element it stayed up next to
  // "参数集读不出来", which read as if the box were still empty.
  //
  // Driven in-page instead of with page.click(): the mouse path scrolls the element into
  // view first, and this page has just run a render (which smooth-scrolls).  What is
  // under test is the button's handler, not Chrome's hit-testing.  A race, so that a
  // stalled renderer fails THIS check with a reason instead of hanging the whole suite
  // (measured: under load a single CDP call stalled long enough to abort a 180 s run).
  const inPage = (fn, arg) => Promise.race([
    page.evaluate(fn, arg), new Promise((r) => setTimeout(() => r('(stalled)'), 20000)),
  ]);
  const readNote = () => inPage(() => {
    const n = document.getElementById('import-note');
    const a = n.querySelector('a');
    return { text: n.textContent.trim(), href: a ? a.getAttribute('href') : '',
             links: n.querySelectorAll('a').length, cls: n.className };
  });
  await inPage(() => { document.getElementById('import-code').value = ''; });
  await inPage(() => { document.getElementById('import-go').click(); });
  await new Promise((r) => setTimeout(r, 250));
  const hintNote = await readNote();
  // An unreadable code is the interesting state: it must NOT look like an empty box.
  await inPage(() => { document.getElementById('import-code').value = 'not-a-code!!'; });
  await inPage(() => { document.getElementById('import-go').click(); });
  await new Promise((r) => setTimeout(r, 250));
  const badNote = await readNote();
  await inPage((code) => { document.getElementById('import-code').value = code; }, sampleCode);
  await inPage(() => { document.getElementById('import-go').click(); });
  await new Promise((r) => setTimeout(r, 250));
  const afterNote = await readNote();
  check('the import hint carries the gallery link, and the link leaves with the hint',
        hintNote.href === './gallery.html' && /没有码/.test(hintNote.text) && hintNote.links === 1
          && badNote.links === 0 && /读不出来/.test(badNote.text) && badNote.cls.includes('err')
          && afterNote.links === 0 && afterNote.text.length > 0,
        JSON.stringify({ hint: hintNote.text.slice(0, 24), bad: badNote.text.slice(0, 20),
                         after: afterNote.text.slice(0, 20) }));

  // 画廊 / 历史版本 / 设置 are one toolbar row: same height, and that height is the
  // bar's -- no vertical inset.  A deliberate design decision (they used to be centred
  // 22-30px pills in a 55px bar), so it gets a check instead of a comment.
  //
  // The vertical offset is measured on the CONTENT, not assumed from the box: stretching
  // a <a> leaves its label at the top edge (measured: 优秀地图画廊 sat against the top
  // while the neighbouring <button> was centred, because buttons centre their own
  // content and anchors do not), and .minibtn.hot's later display:inline-block silently
  // won over an inline-flex in a block that came earlier.
  const chromeRow = await inPage(() => {
    const bar = document.querySelector('.bar').getBoundingClientRect();
    return { barH: Math.round(bar.height), barTop: Math.round(bar.top),
      items: ['gallery-open', 'hist-open', 'settings-open'].map((id) => {
        const el = document.getElementById(id);
        const r = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const cr = range.getBoundingClientRect();
        return { id, h: Math.round(r.height), top: Math.round(r.top),
                 font: getComputedStyle(el).fontSize,
                 off: Math.round(((cr.top + cr.bottom) / 2) - ((r.top + r.bottom) / 2)) };
      }) };
  });
  check('the three header controls are one size, filling the bar (no vertical inset)',
        !!chromeRow.items && chromeRow.items.every((i) => Math.abs(i.h - chromeRow.items[0].h) <= 1
          && i.top === chromeRow.barTop && i.h >= chromeRow.barH - 2
          && i.font === chromeRow.items[0].font),
        JSON.stringify(chromeRow));
  check('and their labels are centred in them, not glued to the top',
        !!chromeRow.items && chromeRow.items.every((i) => Math.abs(i.off) <= 1),
        chromeRow.items.map((i) => `${i.id}:${i.off}px`).join(' '));

  // Responsive: measured, not read out of the CSS.  The defect this pins was a 1240px
  // container that left 230px dead on each side of an ordinary 1700px window while the
  // cards sat at 255px.  A column-count jump can make the width dip slightly, so the
  // growth test has slack; "uses the window" does not.
  const geo = [];
  for (const w of [1280, 1700, 2100]) {
    await gal.setViewport({ width: w, height: 900 });
    await new Promise((r) => setTimeout(r, 150));
    geo.push(await gal.evaluate(() => {
      // A map card when there is one; an empty list still renders the tile, and the grid
      // width (the property under test) exists in both states.  Measured 2026-10-14:
      // querying '.card:not(.tile)' unguarded threw on the empty list and aborted the run.
      const card = document.querySelector('.card:not(.tile)') || document.querySelector('.card');
      return {
        vw: innerWidth,
        card: card ? Math.round(card.getBoundingClientRect().width) : 0,
        grid: Math.round(document.getElementById('grid').getBoundingClientRect().width),
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
      };
    }));
  }
  check('the grid uses the window it is given (no dead gutters) and never overflows',
        geo.every((g) => !g.overflow && g.grid / g.vw > 0.9),
        geo.map((g) => `${g.vw}:${g.grid}`).join(' '));
  check('and the cards get wider with the window',
        !hasEntries || (geo[1].card > geo[0].card * 1.15 && geo[2].card > geo[0].card * 1.15),
        hasEntries ? geo.map((g) => `${g.vw}:${g.card}`).join(' ') : EMPTY_LIST);

  // The whole point: a card click lands in the generator with that 参数集 loaded.
  // Read the cards AGAIN rather than reusing the snapshot: the shuffle checks above
  // re-ordered the grid and reloaded the page, so the card at the top is a different one.
  //
  // And it has to be a card this build can actually MAKE.  The list deliberately
  // contains two it cannot (the withdrawn 上下对称) and a shuffled order can put one of
  // those on top -- so "can make it" is ASKED OF THE PAGE rather than re-derived here:
  // set the entry's environment / player count / theatre in the controls and read the
  // slider limit the engine just handed the page.  Re-deriving that table (or checking
  // only the symmetry, which is what this did first) silently disagrees: measured
  // 2026-10-14, 4 of the 26 sample entries exceeded their per-environment size limit
  // while the symmetry-only probe called them fine, so the check picked one and the page
  // refused it -- and the sample data was wrong, not the page.
  await gal.setViewport({ width: 1280, height: 900 });
  const symChoices = await page.$$eval('#symmetry option',
    (ns) => ns.map((o) => ({ v: o.value, off: o.disabled })));
  const sizeLimitFor = async (p) => inPage((pp) => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v);
      e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('land', pp.land); set('players', pp.players); set('theater', pp.theater);
    return Number(document.getElementById('size').max);
  }, p);
  const topCards = await gal.$$eval('.card:not(.tile)', (ns) => ns.map((n) => ({
    code: n.querySelector('.code').textContent.trim(),
    chips: [...n.querySelectorAll('.chip')].map((c) => c.textContent.trim()),
  })));

  // Every entry must be one this build can actually PRODUCE -- the gallery's promise is
  // "click a card and get that map", and the page refuses rather than clamping.  This is
  // the check that was missing: measured 2026-10-14, 4 of the 26 sample entries exceeded
  // their per-environment size limit (a 大岛屿 map with 2 players caps at 3.6, and nothing
  // said so), so those cards led straight to a red refusal.
  //
  // One exception, on purpose: a code asking for the withdrawn 上下对称 may be
  // unbuildable HERE as long as it says which build made it -- that refusal is the version
  // story, and the switch it offers is only useful because the marker is there.
  const unbuildable = [];
  for (const { p, card } of pairs) {
    const opt = symChoices.find((x) => x.v === String(p.symmetry));
    if (!opt || opt.off || p.symmetry === 3) {
      if (!p.engine) unbuildable.push(`${card.code}: 用了本页没有的对称，却没标是哪个版本做的`);
      continue;
    }
    if (p.width > 0) continue;                    // rectangles: their limit is not read here
    const sizeMaxHere = await sizeLimitFor(p);
    if (!(typeof sizeMaxHere === 'number' && p.size <= sizeMaxHere + 1e-9)) {
      unbuildable.push(`${card.code}: 尺寸 ${p.size} 超过该环境上限 ${sizeMaxHere}`);
    }
  }
  check('every entry this build is supposed to make is one it can actually make',
        unbuildable.length === 0, unbuildable.join(' | '));
  // Two different questions, so two different paths -- conflating them made this check
  // demand a refusal from a rectangle the page accepts (measured: it clicked a 380×100
  // card, the page loaded it, and the check failed on its own bookkeeping):
  //   * makeable: a square card this build can produce (rectangles are skipped here only
  //     because their limit is not read out below -- not because they are refused);
  //   * refused: a card the page will actually reject, which is the withdrawn symmetry
  //     (decidable from the <select> alone) or a size past the environment's limit.
  let makeable = null;
  let refusedCard = null;
  for (const c of topCards) {
    const p = decodeParams(c.code);
    const opt = symChoices.find((x) => x.v === String(p.symmetry));
    if (!opt || opt.off || p.symmetry === 3) {
      if (!refusedCard) refusedCard = c;
    } else if (p.width === 0) {
      const max = await sizeLimitFor(p);
      if (typeof max === 'number' && p.size <= max + 1e-9) { if (!makeable) makeable = c; }
      else if (!refusedCard) refusedCard = c;
    }
    if (makeable && refusedCard) break;
  }
  check('the shuffled top of the list includes a card this build can make',
        !hasEntries || !!makeable, hasEntries ? `of ${topCards.length} drawn` : EMPTY_LIST);
  if (makeable) {
    const firstP = decodeParams(makeable.code);
    await gal.click(`a.hit[href="./index.html#p=${makeable.code}"]`);
    await gal.waitForFunction(
      () => /就绪/.test(document.getElementById('status')?.textContent || ''),
      { timeout: 120000 });
    const landedGal = await gal.evaluate(() => ({
      hash: location.hash,
      seed: document.getElementById('seed').value,
      land: document.getElementById('land').value,
      banner: document.getElementById('landing').hidden
        ? '' : document.getElementById('landing-what').textContent.trim(),
    }));
    check('clicking a card opens the generator with that code loaded and applied',
          landedGal.hash === `#p=${makeable.code}` && landedGal.seed === String(firstP.seed)
            && landedGal.land === String(firstP.land),
          JSON.stringify(landedGal));
    // ...and the two pages describe that loaded code with the SAME words.  The banner
    // reads 环境 · N 人 · 对称 · 尺寸, the card draws the same four as chips; a player who
    // clicks a card should not see the parameters renamed on arrival.
    const bannerFields = landedGal.banner.split(' · ');
    check('and the landing banner names them the way the card did',
          bannerFields.length === 4 && bannerFields[0] === makeable.chips[0]
            && bannerFields[1] === makeable.chips[1] && bannerFields[2] === makeable.chips[2]
            && bannerFields[3] === makeable.chips[3],
          `${JSON.stringify(bannerFields)} vs ${JSON.stringify(makeable.chips.slice(0, 4))}`);
  }

  // The other half of a SHUFFLED list: sooner or later the top card is one this build
  // cannot make.  That must be loud (a red banner naming the reason) and must leave the
  // form alone -- silently generating something else is the failure mode this whole
  // version story exists to prevent.
  // Prefer one the shuffle actually drew (that is the path a player meets); otherwise the
  // withdrawn kind, which the sample list keeps on purpose, so this never degenerates
  // into "nothing to test".
  const unmakeableCode = (refusedCard && refusedCard.code)
    || fileCodes.find((c) => decodeParams(c).symmetry === 3);
  if (unmakeableCode) {
    // The GENERATOR with the code in its fragment (not the gallery): this is what a card
    // click does, minus the card.  goto alone would be a same-document navigation when
    // the path is already index.html, so the reload is what makes it boot and apply.
    const genUrl = new URL('index.html', args.url).href;
    await gal.goto(`${genUrl}#p=${unmakeableCode}`, { waitUntil: 'domcontentloaded' });
    await gal.reload({ waitUntil: 'networkidle2' });
    await gal.waitForFunction(
      () => /就绪/.test(document.getElementById('status')?.textContent || ''),
      { timeout: 120000 });
    const refusedGal = await gal.evaluate(() => ({
      hidden: document.getElementById('landing').hidden,
      bad: document.getElementById('landing').classList.contains('bad'),
      lead: document.getElementById('landing-lead').textContent.trim(),
      what: document.getElementById('landing-what').textContent.trim(),
      go: document.getElementById('landing-go').hidden,
      switchText: document.getElementById('landing-switch').textContent.trim(),
    }));
    // The switch is offered only when the code came from ANOTHER engine AND that engine
    // is one this site still publishes.  A refusal by the very build the code names has
    // nowhere to send the player -- and pretending otherwise would be worse than saying
    // nothing.  (The other-build case is covered by the import section above.)
    const engineDiffers = decodeParams(unmakeableCode).engine !== mine;
    check('a card this build cannot make is refused loudly, with a way out',
          !refusedGal.hidden && refusedGal.bad === true && refusedGal.lead.length > 0
            && refusedGal.what === '' && refusedGal.go === true
            && (refusedGal.switchText.length > 0) === engineDiffers,
          `${JSON.stringify(refusedGal)} engineDiffers=${engineDiffers}`);
  } else {
    check('a card this build cannot make is refused loudly, with a way out', true,
          'no such card in the drawn batch (the list has none)');
  }
  await gal.close();

  // ---- a slow start must not look like a broken one --------------------------
  // The boot watchdog fires after 20 s, and a healthy start can exceed that on a loaded
  // machine (692 KB of wasm to compile).  Measured 2026-10-14: the old wording blamed the
  // Content-Type of mg_engine.wasm while the engine was still coming up, which sends
  // whoever reads it after the wrong problem -- and it was the only thing a suite run saw
  // when the machine was busy building something else.  Two cheap properties: the alarm
  // says waiting may be all that is needed, and it clears itself when the module lands.
  const slow = await browser.newPage();
  await slow.setViewport({ width: 900, height: 700 });
  slow.on('pageerror', (e) => lines.push(`[slow pageerror] ${e.message}`));
  const wasmBody = fs.readFileSync(path.join(ROOT, 'webapp/mg_engine.wasm'));
  await slow.setRequestInterception(true);
  slow.on('request', async (req) => {
    if (req.url().endsWith('mg_engine.wasm')) {
      await new Promise((r) => setTimeout(r, 24000));
      return req.respond({ status: 200, contentType: 'application/wasm', body: wasmBody });
    }
    req.continue();
  });
  await slow.goto(new URL('index.html', args.url).href,
                  { waitUntil: 'domcontentloaded', timeout: 30000 });
  await slow.waitForFunction(
    () => (document.getElementById('error')?.textContent || '').trim() !== '',
    { timeout: 40000 });
  const alarm = await slow.$eval('#error', (e) => e.textContent.trim());
  check('a slow engine start warns without claiming the files are wrong',
        /慢|继续等/.test(alarm), alarm.slice(0, 70));
  await slow.waitForFunction(
    () => /就绪/.test(document.getElementById('status')?.textContent || ''),
    { timeout: 120000 });
  const healed = await slow.evaluate(() => ({
    error: document.getElementById('error').textContent.trim(), status: document.getElementById('status').textContent.trim(),
  }));
  check('and it heals itself when the module finally lands (no stale error)',
        healed.error === '', JSON.stringify(healed).slice(0, 110));
  await slow.close();

  console.log('\n  --- page + worker output ---');
  for (const l of lines.slice(-40)) console.log('  ' + l);
} catch (err) {
  // A wait failing is the interesting case, so dump everything the page said
  // before rethrowing: that output IS the diagnosis.
  console.log(`\n  FAILED after ${Date.now() - started} ms: ${err.message}`);
  if (page) {
    try {
      const status = await page.$eval('#status', (e) => e.textContent);
      const error = await page.$eval('#error', (e) => e.textContent);
      const log = await page.$eval('#log', (e) => e.textContent);
      console.log(`  status: ${status}`);
      if (error) console.log(`  error : ${error}`);
      if (log) console.log(`  log   :\n${log.split('\n').map((l) => '    ' + l).join('\n')}`);
    } catch (e2) { /* page may be gone */ }
  }
  console.log('\n  --- console ----------------');
  for (const l of lines.slice(-60)) console.log('  ' + l);
  failures.push(err.message);
} finally {
  await browser.close();
}

console.log();
if (failures.length) {
  console.log(`FAILED ${failures.length} checks`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('OK -- the page generates and renders in a real browser');
