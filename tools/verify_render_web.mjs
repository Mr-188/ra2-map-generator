// Contract test for the BROWSER render path, run under node.
//
// The rendering half of the page is a .NET WASM module (CNCMaps published with
// `dotnet publish -r browser-wasm`).  This drives it exactly as webapp/worker.js
// will: boot the runtime, populate its Emscripten MEMFS with the extracted
// loose-file tree and the generated map, call the exported Render(), and read
// the PNG back out.
//
// It does not test a browser.  It tests the glue between the browser and the
// renderer, which is where the risk is -- the same split that worked for the
// generation half.
//
// The PNG must be pixel-identical to what the native renderer produces from the
// game's .mix files, which is the same bar tools/verify_render.py sets.
//
//   node tools/verify_render_web.mjs --bundle build/ccmaps-web --assets build/flat \
//        --map build/oracle_assets/oracle.map [--reference build/render_test/ours.png]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The .NET WASM build does not byte-match the native one for identical pixels:
// its deflate implementation differs, so the same image encodes to different
// bytes.  Pixels are the thing that must match, so compare them with a real
// decoder rather than by hashing the file.
const PIXEL_COMPARE = `
import sys
from PIL import Image
a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
if a.size != b.size:
    print(f"size {a.size} != {b.size}"); sys.exit(1)
if a.tobytes() != b.tobytes():
    pa, pb = a.tobytes(), b.tobytes()
    d = sum(1 for x, y in zip(pa, pb) if x != y)
    print(f"{d}/{len(pa)} bytes differ ({d/len(pa)*100:.4f}%)"); sys.exit(1)
print("identical")
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

const args = parseArgs(process.argv);
if (!args.bundle || !args.assets || !args.map) {
  console.error('usage: node tools/verify_render_web.mjs --bundle DIR --assets DIR --map FILE');
  process.exit(2);
}
const bundle = path.resolve(args.bundle);
const assets = path.resolve(args.assets);
const mapFile = path.resolve(args.map);

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(`${label} ${detail}`.trim());
};

// The .NET WASM bundle is an ES module; node needs to be told so.
const pkg = path.join(bundle, 'package.json');
if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ type: 'module' }, null, 2));

const dotnetUrl = pathToFileURL(path.join(bundle, '_framework', 'dotnet.js')).href;
const { dotnet } = await import(dotnetUrl);

const runtime = await dotnet.create();
const config = runtime.getConfig();
const Module = runtime.Module;

console.log(`  boot     main assembly ${config.mainAssemblyName}`);

// ---- 1. populate the virtual filesystem --------------------------------
// CNCMaps takes a DIRECTORY of loose files (-m <dir> builds a DirArchive, which
// is non-recursive).  The game's ra2.mix is 269 MB and never comes near here:
// the C++ engine has already materialised exactly what the renderer asks for.
const gameDir = '/game';
const mapDir = '/maps';
Module.FS.mkdir(gameDir);
Module.FS.mkdir(mapDir);

let copied = 0;
let bytes = 0;
for (const name of fs.readdirSync(assets)) {
  const src = path.join(assets, name);
  if (!fs.statSync(src).isFile()) continue;
  const data = fs.readFileSync(src);
  Module.FS.writeFile(`${gameDir}/${name}`, data);
  copied++;
  bytes += data.length;
}
check('populate MEMFS', copied > 900, `${copied} files, ${(bytes / 1048576).toFixed(1)} MB`);

Module.FS.writeFile(`${mapDir}/probe.map`, fs.readFileSync(mapFile));

// ---- 2. call the exported entry ----------------------------------------
const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
const entry = exports?.CNCMaps?.WebEntry;
check('WebEntry export present', !!entry && typeof entry.Render === 'function');

if (entry) {
  // The renderer writes the PNG into the FS; read it back from there.
  const outBase = '/maps/rendered';
  const started = Date.now();
  const rc = entry.Render(`${mapDir}/probe.map`, gameDir, outBase);
  const ms = Date.now() - started;
  check('Render() returned success', rc === 0, `rc=${rc} in ${ms} ms`);

  const pngPath = `${outBase}.png`;
  let png = null;
  try {
    png = Module.FS.readFile(pngPath);
  } catch (err) {
    check('PNG written into MEMFS', false, String(err));
  }
  if (png) {
    const digest = crypto.createHash('md5').update(png).digest('hex');
    check('PNG written into MEMFS', png.length > 1000, `${png.length} B md5=${digest.slice(0, 16)}`);
    // Always drop the file so the pixel comparison can be done with a real PNG
    // decoder: the .NET WASM build does not necessarily byte-match the native
    // one even for identical pixels, because the deflate implementation differs.
    const out = path.resolve(args.out || 'build/render_test/from_wasm.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, png);
    console.log(`  wrote    ${out}`);

    if (args.reference && fs.existsSync(path.resolve(args.reference))) {
      let verdict = '', ok = false;
      try {
        verdict = execFileSync('python3', ['-c', PIXEL_COMPARE,
          path.resolve(args.reference), out], { encoding: 'utf8' }).trim();
        ok = verdict === 'identical';
      } catch (err) {
        verdict = (err.stdout || '').trim() || String(err.message);
      }
      check('pixel-identical to the native render', ok, verdict);
    }
  }
}

console.log();
if (failures.length) {
  console.log(`FAILED ${failures.length} checks`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('OK -- the browser render path works end to end');
