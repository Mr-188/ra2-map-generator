// 参数集 (share code) contract test.
//
// The code is the thing a player hands to another player, so what has to hold is
// not "it decodes" but "it cannot silently describe a different map":
//
//   1. every field the page can produce survives the round trip;
//   2. every size the slider can hold survives exactly (the code stores an index,
//      and the engine reads sizeSlider as a double in MapGenLAT.cpp:661, so a
//      rounded decimal is NOT good enough -- measured: 0.7000000000000001 and 0.7
//      are different maps on 2 of 200 seeds);
//   3. a run whose seed is 0 is refused rather than encoded (the engine takes that
//      from the clock and never reports it, so such a code would be a lie);
//   4. a changed character is caught, not silently accepted;
//   5. the codec's constants are the engine's, and the page's own <select> cannot
//      offer a value the codec cannot carry.
//
//   node tools/verify_sharebits.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  encodeParams, decodeParams, sizeFromIndex, indexFromSize, enginePrefix,
  SIZE_STEP, RECT_MAX_SUM, MAX_SYMMETRY, MAX_INDEX, VERSION, ENGINE_UNKNOWN,
} from '../webapp/sharebits.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(`${label} ${detail}`.trim());
};

const base = {
  land: 3, theater: 0, time: 0, players: 2, ore: 1, single: false, symmetry: 0,
  size: 1, width: 0, height: 0, seed: 424242, mapSeed: 0,
};

// ---- 1. the layout's lengths are what the design says -----------------------
console.log('  layout   lengths and the reserved bits');
{
  const sq = encodeParams(base);
  const rc = encodeParams({ ...base, size: 0, width: 380, height: 100 });
  const ms = encodeParams({ ...base, mapSeed: 987654321 });
  const both = encodeParams({ ...base, size: 0, width: 380, height: 100, mapSeed: 987654321 });
  check('square is 13 characters / 78 bits', sq.code.length === 13 && sq.bits === 78,
        `${sq.code.length} chars, ${sq.bits} bits, ${sq.code}`);
  check('rectangle is 15 characters / 86 bits', rc.code.length === 15 && rc.bits === 86,
        `${rc.code.length} chars, ${rc.bits} bits, ${rc.code}`);
  check('terrain seed is 19 characters / 110 bits', ms.code.length === 19 && ms.bits === 110,
        `${ms.code.length} chars, ${ms.bits} bits, ${ms.code}`);
  check('rectangle + terrain seed is 20 characters', both.code.length === 20,
        `${both.code.length} chars, ${both.code}`);
  check('the code only uses fragment-safe characters',
        [sq, rc, ms, both].every((c) => /^[A-Za-z0-9_-]+$/.test(c.code)));
}

// ---- 2. every field combination the page can produce -----------------------
console.log('  fields   every combination the <select>s can produce');
{
  let n = 0, bad = 0;
  for (const land of [0, 1, 2, 3])
  for (const theater of [0, 1])
  for (const time of [0, 1, 2, 3])
  for (const players of [2, 3, 4, 5, 6, 7, 8])
  for (const ore of [0, 1, 2, 3])
  for (const single of [false, true])
  for (const symmetry of [0, 1, 2, 3, 4]) {
    const p = { ...base, land, theater, time, players, ore, single, symmetry, seed: 0xFFFFFFFF };
    const d = decodeParams(encodeParams(p).code);
    ++n;
    if (d.land !== land || d.theater !== theater || d.time !== time || d.players !== players
        || d.ore !== ore || d.single !== single || d.symmetry !== symmetry
        || d.seed !== p.seed || !Object.is(d.size, p.size) || d.mapSeed !== p.mapSeed) {
      if (bad++ < 5) console.log('        mismatch', JSON.stringify(p), JSON.stringify(d));
    }
  }
  check(`${n} field combinations round-trip exact`, bad === 0, bad ? `${bad} bad` : '');
}

// ---- 3. every size the slider can hold -------------------------------------
console.log('  size     every slider index, and the noise the codec refuses');
{
  let bad = 0;
  // k = 531 is the largest the page can reach (内陆/2人 useful=53.1).
  for (let k = 0; k <= 531; ++k) {
    const size = sizeFromIndex(k, SIZE_STEP);
    const d = decodeParams(encodeParams({ ...base, size }).code);
    if (!Object.is(d.size, size) || d.index !== k || indexFromSize(d.size, SIZE_STEP) !== k) ++bad;
  }
  check('k = 0..531 round-trip exactly', bad === 0, bad ? `${bad} bad` : '');

  // The measured trap: 7*0.1 is not a double the slider can hold, and it can be a
  // different map from 0.7.  Encoding it must fail loudly instead.
  let refused = false;
  try { encodeParams({ ...base, size: 7 * 0.1 }); } catch { refused = true; }
  check('a size off the step grid is refused (7*0.1, not 0.7)', refused,
        `7*0.1 = ${7 * 0.1}, grid value = ${sizeFromIndex(7, SIZE_STEP)}`);

  let refusedHigh = false;
  try { encodeParams({ ...base, size: sizeFromIndex(MAX_INDEX + 1, SIZE_STEP) }); }
  catch { refusedHigh = true; }
  check('a size past the 10-bit index is refused', refusedHigh);
}

// ---- 4. the seed ------------------------------------------------------------
console.log('  seed     32 bits, and "0 = clock" is not encodable');
{
  for (const seed of [1, 0xFF, 0x100, 0x00FFFFFF, 0x01000000, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF]) {
    const d = decodeParams(encodeParams({ ...base, seed }).code);
    if (d.seed !== seed) { check(`seed ${seed} round-trips`, false, `got ${d.seed}`); break; }
  }
  check('seed boundaries round-trip (1 .. 0xFFFFFFFF)', true);
  let refused = false;
  try { encodeParams({ ...base, seed: 0 }); } catch { refused = true; }
  check('seed 0 is refused (the engine would take it from the clock)', refused);
}

// ---- 4b. the engine prefix: "was this made by this build?" ------------------
console.log('  engine   the 10-bit build id, and what "unknown" means');
{
  let bad = 0;
  for (const engine of [0, 1, 2, 511, 512, 1022, 1023]) {
    const d = decodeParams(encodeParams({ ...base, engine }).code);
    if (d.engine !== engine) { ++bad; console.log('        engine', engine, '->', d.engine); }
  }
  check('every 10-bit value round-trips (0..1023)', bad === 0, bad ? `${bad} bad` : '');
  check('omitting it means unknown (0)',
        decodeParams(encodeParams(base).code).engine === ENGINE_UNKNOWN);

  // enginePrefix() is the one function both sides must agree on: it turns
  // version.json's `engine` (a sha256 hex prefix) into the 10 bits in the code.
  check('enginePrefix takes the top 10 bits of the hash',
        enginePrefix('ffffffff') === 1023            // 0xffff >> 6
          && enginePrefix('0000abcd') === 0          // the sentinel, by design
          && enginePrefix('abcd1234') === (0xabcd >> 6)
          && enginePrefix('00401234') === 1,         // 0x0040 >> 6
        `ffff=${enginePrefix('ffffffff')} abcd=${enginePrefix('abcd1234')} ` +
        `0000=${enginePrefix('0000abcd')}`);
  check('enginePrefix refuses anything that is not 2 bytes of hex',
        enginePrefix('') === ENGINE_UNKNOWN && enginePrefix('zzzz') === ENGINE_UNKNOWN
          && enginePrefix('ab') === ENGINE_UNKNOWN && enginePrefix(null) === ENGINE_UNKNOWN);

  // The point of the field: two builds that differ must not look the same, and the
  // page must be able to say so from the bits alone.
  const mine = enginePrefix('30a88bb1c0ffee00');
  const theirs = enginePrefix('9f1c02abdeadbeef');
  check('different engines get different prefixes', mine !== theirs,
        `${mine} vs ${theirs}`);
  check('a different engine is visible after decoding',
        decodeParams(encodeParams({ ...base, engine: theirs }).code).engine !== mine);
}

// ---- 5. what the encoder must refuse ---------------------------------------
console.log('  range    out-of-range input is refused by the encoder');
{
  const cases = [
    ['land 4 (山地 is not a page option)', { land: 4 }],
    ['symmetry 5 (past mirror.h)', { symmetry: 5 }],
    ['players 9', { players: 9 }],
    ['ore 4', { ore: 4 }],
    ['theater 2', { theater: 2 }],
    ['time 4', { time: 4 }],
    ['rectangle over the overlay grid', { size: 0, width: 400, height: 100 }],
    ['rectangle with a zero side', { size: 0, width: 380, height: 0 }],
  ];
  for (const [label, patch] of cases) {
    let refused = false;
    try { encodeParams({ ...base, ...patch }); } catch { refused = true; }
    check(label, refused);
  }
}

// ---- 6. a changed character is never accepted -------------------------------
console.log('  corrupt  every single-character change is caught');
{
  const good = encodeParams(base).code;
  let tried = 0, accepted = 0;
  for (let i = 0; i < good.length; ++i) {
    for (const ch of ALPHA) {
      if (ch === good[i]) continue;
      ++tried;
      try { decodeParams(good.slice(0, i) + ch + good.slice(i + 1)); ++accepted; } catch { /* good */ }
    }
    ++tried;                                   // a dropped character
    try { decodeParams(good.slice(0, i) + good.slice(i + 1)); ++accepted; } catch { /* good */ }
  }
  check(`${tried} single-character changes, 0 accepted`, accepted === 0, `${accepted} accepted`);
  for (const junk of ['', 'x', 'EBAFAAM8mQU!!!', 'EBAFAAM8mQ']) {
    let threw = false;
    try { decodeParams(junk); } catch { threw = true; }
    check(`junk ${JSON.stringify(junk)} is rejected`, threw);
  }
}

// ---- 7. the codec's constants are the engine's ------------------------------
console.log('  engine   the constants come from the engine, not from a copy');
{
  const mgconsole = path.join(ROOT, 'build', 'engine', 'mgconsole');
  if (!fs.existsSync(mgconsole)) {
    check('build/engine/mgconsole exists (run sh engine/build_oracle.sh)', false, mgconsole);
  } else {
    const out = execFileSync(mgconsole, ['--size-range', '--land', '0', '--players', '2'],
                             { encoding: 'utf8', timeout: 30000 });
    const step = /step=([0-9.]+)/.exec(out);
    const rectsum = /rectsum=(\d+)/.exec(out);
    check(`engine step == codec SIZE_STEP (${SIZE_STEP})`,
          step && Number(step[1]) === SIZE_STEP, step ? step[1] : 'not printed');
    check(`engine rectsum == codec RECT_MAX_SUM (${RECT_MAX_SUM})`,
          rectsum && Number(rectsum[1]) === RECT_MAX_SUM, rectsum ? rectsum[1] : 'not printed');
  }
}

// ---- 8. the page cannot offer what the codec cannot carry -------------------
console.log('  page     every option the <select>s offer is encodable');
{
  const page = fs.readFileSync(path.join(ROOT, 'webapp', 'index.html'), 'utf8');
  const optionsOf = (id) => {
    const block = new RegExp(`<select id="${id}"[\\s\\S]*?</select>`).exec(page);
    if (!block) return null;
    return [...block[0].matchAll(/<option value="([^"]*)"/g)]
      .map((m) => m[1]).filter((v) => v !== '?');
  };
  const land = optionsOf('land');
  const symmetry = optionsOf('symmetry');
  check('the #land select exists', land !== null);
  check('the #symmetry select exists', symmetry !== null);
  if (land) {
    let bad = 0;
    for (const v of land) {
      try { decodeParams(encodeParams({ ...base, land: Number(v) }).code); } catch { ++bad; }
    }
    check(`all ${land.length} 环境 options are encodable`, bad === 0, land.join('/'));
  }
  if (symmetry) {
    let bad = 0;
    for (const v of symmetry) {
      try { decodeParams(encodeParams({ ...base, symmetry: Number(v) }).code); } catch { ++bad; }
    }
    check(`all ${symmetry.length} 对称 options are encodable`, bad === 0, symmetry.join('/'));
    check(`MAX_SYMMETRY (${MAX_SYMMETRY}) is the page's largest 对称`,
          Math.max(...symmetry.map(Number)) === MAX_SYMMETRY, symmetry.join('/'));
  }
  // The placeholder the codec writes for "no version 0" must stay refused, so a
  // future layout change bites here instead of silently misreading old codes.
  check('VERSION is 0', VERSION === 0);
}

console.log();
if (failures.length) {
  console.log(`FAILED ${failures.length} checks`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('OK -- the 参数集 carries every field, every size, and nothing else');
