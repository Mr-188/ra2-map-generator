// 参数集 (the share code): every generation input in one short string.
//
// A player hands this string to someone else, and pasting it back has to give the
// same map -- byte for byte, which is red line 3 ("相同参数 + 相同种子 → 逐字节相同").
// It therefore carries the CONCRETE values a run used, never the controls' 随机
// placeholders: re-deciding a roll on the receiving side is exactly what would
// change the map.
//
// Layout (v1), MSB first.  `mode` picks the geometry field:
//
// v2 exists for DESERT: the v1 theater field is one bit, so a desert run would
// decode as temperate.  v2 widens theater to two bits and shifts everything
// after it by one bit.  v1 codes keep decoding exactly as before; only a code
// that names theater 2 is written as v2.
//
//   bit   n   field
//    0    2   version       0 = this layout; anything else is refused
//    2    2   land          0..3   (the page's four environments; 4 = 3, same map)
//    4    1   theater       0 = 温带, 1 = 雪地
//    5    2   time          0..3
//    7    3   players - 2   0..6   (2..8 players)
//   10    2   ore           0..3
//   12    1   single        0 = 多人 .yrm, 1 = 单人 .map
//   13    3   symmetry      0..4   (mirror.h's MapSymmetry; 5..7 are not kinds)
//   16    1   rectMode
//   17   10   size index k  size = sizeFromIndex(k, step)   } square
//   27   32   seed                                           }
//   59    1   terrain-seed present -> 32 more bits           }
//   60   10   engine        see below                        } square payload 70
//   ----------------------------------------------------------------
//   17    9   width  - 1    } rect
//   26    9   height - 1    }
//   35   32   seed
//   67    1   terrain-seed present -> 32 more bits
//   68   10   engine                                     rect payload 78
//   payload 8  CRC-8 (poly 0x07, init 0) over the payload zero-padded to whole bytes
//
// 70 + 8 = 78 bits = 13 base64url characters, exactly.  A rectangle costs 8 more
// bits (15 characters: 78 + 8 = 86 does not fit in 14) and a non-zero terrain seed
// 32 more (19 / 20).
//
// WHY THERE IS AN ENGINE FIELD.  The same parameters can make a different map on a
// different build, and a player who pastes a code has to be told BEFORE generating
// that the code came from somewhere else -- the page can then offer the 历史版本
// switch that already exists.  The identifier has to be the thing that actually
// decides the bytes, and version.json already carries it: `engine` = the sha256 of
// mg_engine.wasm (package_webapp.sh).  So this stores the TOP 10 BITS of that hash
// (enginePrefix() below) and the receiving page compares it with its own:
//
//   prefix equal  -> same engine, so the same parameters make the same map.  A
//                    PAGE-only release keeps the same engine, so it does not
//                    prompt -- the date version would, on every such release.
//   prefix differs-> the page says so, and resolves WHICH version to switch to by
//                    looking the prefix up in versions.json (each entry carries
//                    `engine`).  The lookup is a prefix match, so two page-only
//                    releases sharing an engine are interchangeable here.
//
// 10 bits is a HINT, not a proof: it can call two engines the same with chance
// 1/1024.  0 is reserved for "this build does not know its engine" (a source
// checkout has no version.json), so a real engine whose top 10 bits are zero is
// read as unknown rather than as a mismatch -- the safe direction, since unknown
// never claims the map will be the same.
//
// WHAT THIS FIELD IS NOT: it cannot detect a player's GAME DATA differing, which
// changes the map just as surely (measured: rmgmd.ini MaxTrees 600 -> 300, same
// parameters, different bytes).  Nothing in the code can; only a fingerprint of
// the produced map could, and that is not what a code is for.
//
// WHY THE SIZE IS AN INDEX, NOT A DOUBLE.  The engine reads sizeSlider as a double
// in one place (MapGenLAT.cpp:661: the green-patch budget truncates
// (size*0.1+0.7)*veg*0.01*600), so 0.7000000000000001 and 0.7 can be different
// maps -- measured: 2 of 200 seeds.  A page-rolled size is Math.round(...)*0.1 and
// carries that noise, so the code cannot store the double (10 bits) and cannot
// store a rounded decimal either.  It stores the SLIDER INDEX instead, and the
// page generates with sizeFromIndex(k) so that the code and the map agree by
// construction.  sizeFromIndex is exactly what the browser's own range input
// yields for that index (verified in Chrome for k = 0..531), so this changes
// nothing for a size the user dragged.
//
// WHY THE SEED IS 32 BITS.  Every one of the 32 bits changes the map: the engine
// seeds R250 with them (MapGen.cpp:104) and the map is a function of that stream.
// Measured by flipping each bit of two base seeds: 64/64 flips changed the md5.

export const VERSION = 0;          // v1: theater is one bit (0..1)
export const VERSION_V2 = 1;       // v2: theater is two bits (0..2, DESERT)
export const SIZE_STEP = 0.1;      // the engine's kSizeSliderStep (mg_size_step)
export const RECT_MAX_SUM = 495;   // the engine's MaxRectCellSum (mg_rect_max_sum)
export const MAX_INDEX = 1023;     // 10 bits
export const MAX_SYMMETRY = 4;     // mirror.h's kMapSymmetryImplementedMax
export const ENGINE_UNKNOWN = 0;   // what a build without version.json writes
export const ENGINE_MASK = 0x3ff;  // 10 bits
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * version.json's `engine` (a sha256 hex prefix) -> the 10 bits a code carries.
 * The top 10 bits of the first two bytes, nothing cleverer: it only has to be the
 * same function on the sending and the receiving side.
 */
export function enginePrefix(hex) {
  const head = String(hex || '').slice(0, 4);
  if (!/^[0-9a-fA-F]{4}$/.test(head)) return ENGINE_UNKNOWN;
  return (parseInt(head, 16) >> 6) & ENGINE_MASK;
}


/** The size slider's index -> the double the engine receives (its step domain). */
export function sizeFromIndex(k, step = SIZE_STEP) {
  return Number((k * step).toPrecision(15));
}

/** The double back to its slider index (the inverse of sizeFromIndex). */
export function indexFromSize(size, step = SIZE_STEP) {
  return Math.round(Number(size) / step);
}

function crc8(bytes) {
  let c = 0;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; ++i) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

class Bits {
  constructor(bits = []) { this.bits = bits; }
  put(v, n) { for (let i = n - 1; i >= 0; --i) this.bits.push((v >>> i) & 1); }
  get(n) {
    let v = 0;
    for (let i = 0; i < n; ++i) {
      const b = this.bits.shift();
      if (b === undefined) throw new Error('参数集不完整（位数不够）');
      v = v * 2 + b;
    }
    return v;
  }
  /** Zero-padded to a whole number of bytes -- what the CRC is defined over. */
  bytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  }
  chars() {
    let s = '';
    for (let i = 0; i < this.bits.length; i += 6) {
      let v = 0;
      for (let j = 0; j < 6; ++j) v = v * 2 + (this.bits[i + j] || 0);
      s += ALPHA[v];
    }
    return s;
  }
  static from(str) {
    const b = new Bits();
    for (const ch of str) {
      const v = ALPHA.indexOf(ch);
      if (v < 0) throw new Error(`参数集里有非法字符 "${ch}"`);
      for (let j = 5; j >= 0; --j) b.bits.push((v >>> j) & 1);
    }
    return b;
  }
}

function need(ok, msg) { if (!ok) throw new Error(msg); }

/**
 * One run's parameters -> the share code.
 *
 * `p` is the object the page hands the engine (app.js), so the caller cannot
 * forget a field: land, theater, time, players, ore, single, symmetry, seed,
 * mapSeed, and either size or width+height.
 *
 * Throws rather than writing a code that would reproduce something else:
 *   - seed 0 (the engine takes that from the clock and never reports it back)
 *   - a size off the slider's step grid (the code stores the index)
 *   - a rectangle the overlay grid cannot hold
 */
export function encodeParams(p, opts = {}) {
  const step = opts.step ?? SIZE_STEP;
  const rectMaxSum = opts.rectMaxSum ?? RECT_MAX_SUM;

  const seed = p.seed >>> 0;
  need(seed !== 0, '全局种子为 0：引擎会用时钟现取，这个参数集无法复现同一张地图');
  need(Number.isInteger(p.land) && p.land >= 0 && p.land <= 3, `环境 ${p.land} 不在 0..3`);
  need(Number.isInteger(p.theater) && p.theater >= 0 && p.theater <= 2,
       `剧场 ${p.theater} 不在 0..2`);
  need(Number.isInteger(p.time) && p.time >= 0 && p.time <= 3, `时间 ${p.time} 不在 0..3`);
  need(Number.isInteger(p.players) && p.players >= 2 && p.players <= 8,
       `玩家数 ${p.players} 不在 2..8`);
  need(Number.isInteger(p.ore) && p.ore >= 0 && p.ore <= 3, `矿量 ${p.ore} 不在 0..3`);
  need(Number.isInteger(p.symmetry) && p.symmetry >= 0 && p.symmetry <= MAX_SYMMETRY,
       `对称 ${p.symmetry} 不在 0..${MAX_SYMMETRY}（引擎实现的档位）`);

  // One side without the other is the engine's own error ("--width without
  // --height"), and here it would be worse than an error: the rectangle would be
  // dropped and the code would describe a square that was never made.
  need((p.width > 0) === (p.height > 0),
       `长宽必须同时给出或同时为 0（收到 ${p.width}x${p.height}）`);
  const rect = p.width > 0 && p.height > 0;
  let k = 0;
  if (rect) {
    need(Number.isInteger(p.width) && Number.isInteger(p.height),
         '长宽必须是整数');
    need(p.width >= 1 && p.height >= 1, '长宽必须 ≥ 1');
    need(p.width + p.height <= rectMaxSum,
         `长 ${p.width} + 宽 ${p.height} 超过引擎的 ${rectMaxSum}`);
    need(p.width - 1 <= 511 && p.height - 1 <= 511, '长宽超出 9 位能表示的范围');
  } else {
    k = indexFromSize(p.size, step);
    // The caller must have generated with the canonical value, or the code would
    // describe a map that was never made.  This is the trap the codec exists to
    // make impossible (see the header).
    need(k >= 0 && k <= MAX_INDEX, `尺寸 ${p.size} 超出可编码范围`);
    need(Object.is(p.size, sizeFromIndex(k, step)),
         `尺寸 ${p.size} 不在引擎的档位上（滑块只能落在 k*${step}）`);
  }

  const b = new Bits();
  // v1 unless this code names DESERT, so every temperate/snow code stays
  // byte-identical to what older pages wrote and can still be read by them.
  const v2 = p.theater === 2;
  b.put(v2 ? VERSION_V2 : VERSION, 2);
  b.put(p.land, 2);
  b.put(p.theater, v2 ? 2 : 1);
  b.put(p.time, 2);
  b.put(p.players - 2, 3);
  b.put(p.ore, 2);
  b.put(p.single ? 1 : 0, 1);
  b.put(p.symmetry, 3);
  b.put(rect ? 1 : 0, 1);
  if (rect) { b.put(p.width - 1, 9); b.put(p.height - 1, 9); }
  else { b.put(k, 10); }
  b.put(seed, 32);
  const mapSeed = p.mapSeed >>> 0;
  b.put(mapSeed !== 0 ? 1 : 0, 1);
  if (mapSeed !== 0) b.put(mapSeed, 32);
  // Absent = "this build cannot say" (a source checkout has no version.json), which
  // reads as unknown rather than as a mismatch -- see the header.
  const engine = (p.engine ?? ENGINE_UNKNOWN) & ENGINE_MASK;
  b.put(engine, 10);
  const payloadBits = b.bits.length;
  b.put(crc8(b.bytes()), 8);
  return { code: b.chars(), bits: payloadBits + 8, index: rect ? null : k };
}

/** The share code -> the parameter object the engine takes (see encodeParams). */
export function decodeParams(code, opts = {}) {
  const step = opts.step ?? SIZE_STEP;
  const rectMaxSum = opts.rectMaxSum ?? RECT_MAX_SUM;
  need(typeof code === 'string' && code.length > 0, '参数集是空的');
  // 13 is the shortest layout (a square map); the bit reader reports anything that
  // claims to be longer but runs out.
  need(code.length >= 13, '参数集太短（可能没复制全）');

  const b = Bits.from(code);
  const total = code.length * 6;
  const version = b.get(2);
  // Checked before anything else, because it is needed before anything else: the
  // CRC's position depends on the layout (a rectangle is 8 bits longer, a terrain
  // seed 32), so a decoder cannot even find the checksum until it knows the layout.
  // That is also why this field cannot be replaced by a date or a fingerprint.
  need(version === VERSION || version === VERSION_V2,
       `参数集版本 ${version} 不认识（或没复制全，请刷新页面再试）`);
  const land = b.get(2);
  const theater = b.get(version === VERSION_V2 ? 2 : 1);
  need(theater <= 2, `参数集里的剧场是 ${theater}，本页只认识 0..2`);
  const time = b.get(2);
  const players = b.get(3) + 2;
  const ore = b.get(2);
  const single = b.get(1);
  const symmetry = b.get(3);
  need(symmetry <= MAX_SYMMETRY,
       `参数集里的对称是 ${symmetry}，引擎实现的只有 0..${MAX_SYMMETRY}`);
  need(players >= 2 && players <= 8, `参数集里的玩家数 ${players} 不在 2..8`);

  const rect = b.get(1);
  let size = 0, width = 0, height = 0, k = null;
  if (rect) {
    width = b.get(9) + 1;
    height = b.get(9) + 1;
    need(width + height <= rectMaxSum,
         `参数集里的长宽 ${width}x${height} 超过引擎的 ${rectMaxSum}`);
  } else {
    k = b.get(10);
    size = sizeFromIndex(k, step);
  }
  const seed = b.get(32) >>> 0;
  const mapSeed = b.get(1) ? b.get(32) >>> 0 : 0;
  const engine = b.get(10);

  const payloadBits = total - b.bits.length;
  const withCrc = Bits.from(code);
  withCrc.bits.splice(payloadBits);
  const want = crc8(withCrc.bytes());
  const got = b.get(8);
  need(want === got, '参数集校验和不匹配（被改过或没复制全）');
  need(b.bits.every((x) => x === 0), '参数集有保留位非零，不是本页生成的串');

  return { land, theater, time, players, ore, single: !!single, symmetry,
           size, width, height, seed, mapSeed, index: k, engine };
}
