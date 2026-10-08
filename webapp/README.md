# webapp/ -- the browser front end

Static files, no backend.  The page never uploads anything: the game archives are
read inside a Worker and the extracted data lives in the wasm module's MEMFS.

## Why the engine runs in a Worker

`ByteSource::read` is synchronous, and the only synchronous way to read a picked
`File` is `FileReaderSync`, which exists **only in workers**.  The alternative --
copying `ra2.mix` (269 MB) and `ra2md.mix` (195 MB) into MEMFS -- would need
~464 MB of wasm heap before any work starts.

So the split is:

```
main thread (app.js)          worker (worker.js)              wasm (mg_engine.js)
  <input webkitdirectory>  ─▶  register File objects  ─▶  mg_add_file(id, name)
  params                   ─▶  mg_extract(theater)    ─▶  reads archives through
                                                           the JS ByteSource factory
                               MEMFS: ~9 MB loose-file tree
                               mg_generate(...)        ─▶  the unmodified pipeline
                               mg_read_output(...)     ─◀  the .map bytes
  download link            ◀─  { type: 'map', bytes }
```

Files needed from the player's install: `ra2.mix`, `ra2md.mix`, `expandmd01.mix`.
Everything else the generator reads (`rulesmd.ini`, `artmd.ini`, the theater
control INI, `rmgmd.ini`, the theater's TMP tiles) comes out of those archives.

## The rendering half

Map generation and map rendering are two separate wasm runtimes in the same
worker, because they are two separate codebases:

```
worker
  |-- engine (C++ -> Emscripten, ~630 KB)         generates the .map
  `-- renderer (C# -> dotnet browser-wasm, 15 MB) renders it to a PNG
        built by engine/build_render_web.sh, staged into webapp/render/
```

There is no third option that keeps the output identical. CNCMaps is a pure
software rasteriser now -- zero OpenGL calls, no GPU dependency -- so the same
source that produces the reference images compiles straight to wasm. "Identical
to CNCMaps" is therefore free rather than reimplemented.

The two runtimes do not share a filesystem. `worker.js` walks the generator's
MEMFS after extraction and copies the tree into the renderer's own FS, flattening
on the way: CNCMaps takes a DIRECTORY of loose files (`-m <dir>` builds a
`DirArchive`, which is non-recursive). The game's `ra2.mix` never goes near
either one.

The renderer is booted lazily, on the first render, because it is 15 MB and a
session that only generates maps should not pay for it.

## Serving

`file://` will not work: the wasm module and the Worker cannot be loaded from a
file origin.  Serve the directory statically, e.g.

```sh
python3 -m http.server 8000
# add build/engine-web/mg_engine.js and .wasm next to these files, then open
# http://localhost:8000/webapp/
```

## Verification status -- read this before trusting the page

* The **engine** behind this page is verified: `tools/verify_wasm.py` requires the
  wasm build to produce a byte-identical map to the native oracle, and
  `tools/verify_oracle.py` requires that oracle to be rich and deterministic.
* The **glue between page and engine is verified**: `tools/verify_webapi.mjs`
  drives `build/engine-web/mg_engine.js` through the same calls `worker.js`
  makes, with `mgFileSize`/`mgRead` backed by the filesystem, and requires a map
  byte-identical to the native oracle.  That is the part with real risk.
* The **render half** is verified the same way: `tools/verify_webapi.mjs
  --render` performs the worker's exact flatten-and-render loop under node, and
  requires the preview to be **pixel-identical** to the reference render produced
  natively from the game's own `.mix` files.
* What is **still untested** is only what needs a browser: `FileReaderSync`
  (the tests substitute `fs.readSync`), ES-module/worker loading, and the page
  itself.  `app.js` / `worker.js` are written against the verified interface, but
  the first browser run should still be treated as a real test, not a formality.
* `showDirectoryPicker()` is Chromium-only and needs a secure context;
  `<input webkitdirectory>` works in more browsers and is what the page uses.
