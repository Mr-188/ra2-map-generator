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
  await page.goto(args.url, { waitUntil: 'networkidle2', timeout: 60000 });
  check('page loaded', true, await page.title());

  // Wait for the engine to report ready.
  await page.waitForFunction(
    () => /就绪/.test(document.getElementById('status')?.textContent || ''),
    { timeout: 60000 });
  check('engine ready', true);
  check('worker is classic', workers.length > 0, workers.join(','));

  // The 对称 select is a PRODUCT decision, not "everything the engine can do".
  //
  // The page offers exactly three values: 0 (off), 2 (180-degree central symmetry)
  // and ? (随机 - rolled at generate time).
  // The engine still implements left-right (1) and top-bottom (3) - mirror.h declares
  // the max, and the CLI/API accept them - but the page deliberately exposes one
  // optional kind, and it must be the one that actually works: the option has to be
  // ENABLED (the ready message's mg_symmetry_max() is what disables a kind the engine
  // would refuse) and 180 is what the generate call below then exercises.
  //
  // A page that hid 180 (or offered a kind the engine refuses) is the failure this
  // pins; "the page offers all four" is no longer the contract.
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
  check('the page offers exactly 无 / 180° / 随机 for 对称, all enabled',
        sym !== null && sym.values.join(',') === '0,2,?'
          && sym.disabled.every((d) => d === false) && sym.value === '0'
          && declaredMax !== null && declaredMax >= 2,
        sym ? `options ${sym.values.join('/')}, disabled ${sym.disabled.join('/')}, `
              + `selected ${sym.value} (mirror.h declares 0..${declaredMax})`
            : 'no #symmetry select');

  // ---- the 随机 entries, 全随机, and the 设置 drawer ---------------------------
  //
  // Every parameter the generator takes can be left to a roll, one at a time or all
  // at once, and the rolled values are printed rather than written back (app.js), so
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
      const r = await fetch(base + n);
      if (!r.ok) return { error: `${n}: HTTP ${r.status}` };
      dt.items.add(new File([await r.blob()], n));
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
  await page.waitForFunction(
    () => /已缓存素材/.test(document.getElementById('cache-note')?.textContent || ''),
    { timeout: 180000 }).catch(() => {});
  const cacheAfterPick = await page.$eval('#cache-note', (e) => e.textContent.trim());
  check('picking a folder alone fills the cache for BOTH theatres (no generate needed)',
        /已缓存素材/.test(cacheAfterPick) && /温和/.test(cacheAfterPick)
          && /雪地/.test(cacheAfterPick), cacheAfterPick);

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
  // the file that proves the rotation applied.
  //
  // The page's one optional kind is 180 (value 2), so the mapping to check is the one
  // engine/src/mirror.h uses for it - a PURE 180-degree rotation of the cell grid,
  // (x, y) -> (Wp + Hp - x, Wp + Hp - y), written out here independently.  The old
  // form of this check swapped the two packed fields, which is left-right, not 180;
  // it would pass for the wrong kind.
  const readBlob = () => page.evaluate(async () => {
    if (!window.__mapBlob) return null;
    return Array.from(new Uint8Array(await window.__mapBlob.arrayBuffer()));
  });
  const plain = await readBlob();
  await page.select('#symmetry', '2');
  await page.evaluate(() => { window.__mapBlob = null; });
  await page.click('#go');
  await page.waitForFunction(() => window.__mapBlob !== null, { timeout: args.timeout });
  const rotatedBytes = await readBlob();

  const textOf = (bytes) => (bytes ? new TextDecoder('latin1').decode(Buffer.from(bytes)) : '');
  const header = (bytes) => {
    const t = textOf(bytes);
    const w = Number((t.match(/^Width=(\d+)/m) || [])[1]);
    const h = Number((t.match(/^Height=(\d+)/m) || [])[1]);
    return { w, h };
  };
  const waypoints = (bytes) => {
    const section = (textOf(bytes).split('[Waypoints]')[1] || '').split('\n\n')[0];
    return section.split('\n').filter((l) => l.includes('='))
      .map((l) => l.split('=').map((n) => Number(n)));
  };
  const wa = waypoints(plain);
  const wb = waypoints(rotatedBytes);
  // The writer stores start points as X + 1000*Y (MapGenMapFile.cpp:1092).
  const { w: Wp, h: Hp } = header(rotatedBytes);
  const rotate = (packed) => {
    const x = packed % 1000, y = Math.floor(packed / 1000);
    return (Wp + Hp - x) + 1000 * (Wp + Hp - y);
  };
  // What the symmetric map must show is NOT "each waypoint equals the rotation of the
  // plain map's own".  A pairwise swap produces exactly that, and a swap is not a
  // symmetric map: it preserves whether a pair agrees.  The property is that the
  // symmetric map's own start points come in rotated pairs, with the count preserved
  // (a 2-player map has to stay a 2-player map).
  //
  // A start point whose image falls outside the header rectangle is allowed through:
  // the 180 cell map misses the hidden border band (mirror.h), and a map whose starts
  // sit there would otherwise fail for the wrong reason.
  const cells = wb.map(([, v]) => v);
  const inRange = (packed) => {
    const x = packed % 1000, y = Math.floor(packed / 1000);
    return x >= 1 && x <= Wp && y >= 1 && y <= Hp;
  };
  const paired = cells.length > 0
    && cells.every((v) => cells.includes(rotate(v)) || !inRange(rotate(v)));
  check("the page's 对称 option reaches the engine (180)",
        wb.length > 0 && wb.length === wa.length && paired
          && Buffer.compare(Buffer.from(rotatedBytes || []), Buffer.from(plain || [])) !== 0,
        `waypoints ${JSON.stringify(wa)} -> ${JSON.stringify(wb)} ` +
        `(rotated-paired within the symmetric map: ${paired}, count, differs: ` +
        `${Buffer.compare(Buffer.from(rotatedBytes || []), Buffer.from(plain || [])) !== 0})`);

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
        /本次随机/.test(rollNote) && /环境=/.test(rollNote) && /地图大小=/.test(rollNote),
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
    document.getElementById('map-seed').value = '0';
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
