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
