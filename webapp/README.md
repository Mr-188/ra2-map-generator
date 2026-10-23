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

## 参数集 (the share code)

A whole run -- every parameter plus the seed -- in one 13-character string
(`sharebits.js`).  The player clicks the code to copy it; pasting it into 导入参数集
(or opening `#p=<code>`) restores the controls and makes the same map.

Three things about it are deliberate, and each of them is there because the obvious
alternative silently produces a different map:

* **It carries concrete values, never the 随机 placeholders.**  Re-deciding a roll on
  the receiving side is exactly what changes the map, so the page settles every roll at
  generate time -- including the global seed, which the engine would otherwise read as
  "take GetTickCount()" and never report back.
* **The size travels as a slider INDEX, not as a number.**  The engine reads
  `sizeSlider` as a double in one place (`MapGenLAT.cpp:661`), and a rolled value
  (`Math.round(...)*0.1`, e.g. `0.7000000000000001`) is not one the slider can hold:
  measured, 2 of 200 seeds make a different map from `0.7`.  The page generates with
  `sizeFromIndex(k)` and the code carries `k`.
* **It refuses rather than clamps.**  A code asking for something this build cannot
  make (a size past the engine's table, a symmetry kind this engine lacks) is rejected
  with the reason, before any control is written -- a half-applied form would generate
  a map neither side asked for.

The code also carries the top 10 bits of this build's `engine` fingerprint
(`version.json`), which is what the date version cannot do: a page-only release keeps
the same engine, so the check does not fire on it.  The receiving page compares it with
its own -- equal means the same parameters make the same map; different means it says
so and offers the 历史版本 switch, carrying the code in the fragment so the older page
comes up with the same 参数集.  It is a hint, not a proof (1/1024 of engines collide),
and it cannot see the player's own game data differing, which changes the map just as
surely.

## 出生点编辑 (moving start positions on the preview)

After a render, `编辑出生点` turns the preview into an editor: the starts the
renderer drew as red squares get a handle of their own, and dragging one (or
clicking elsewhere with it selected) moves it.  `应用并重新预览` writes the move
into the map and renders again; `还原` goes back to the bytes the generator
produced.

It edits **[Waypoints] and nothing else** -- the same thing a map editor does when
you move a start.  Terrain is not regenerated, which is why this is instant and why
the button says 重新预览 rather than 重新生成.  Everything around the move comes
from a single owner rather than a copy:

* **the cell <-> pixel transform** is the renderer's own.  `engine/render/WebEntry.cs`
  asks for `--meta-json`, which writes the crop origin, the tile size and every
  start's pixel next to the PNG.  Note that the transform comment in
  `RenderEngine.cs` omits the `+1` that `Map.cs:GetStartPositionPixels` uses; the
  code is the authority and `tools/verify_starts.mjs` pins it against a real render.
* **the cell's height and whether it can carry a start** come from the generator:
  `mg_generate` writes `<out>.cells` (side, then `[level][flags]` per cell, in the
  same padded diamond the map's own cell coordinates live in).  That is what makes
  one pixel column resolve to a single cell, and what lets the editor say "这里是水面"
  instead of letting you drop a start into a lake.  The flag is the engine's
  `PassabilityType_Passable`, not a guess from the image.
* **the map format** is one number: `[Waypoints]` stores `X + 1000 * Y`
  (`MapGenMapFile.cpp`), which is what the renderer and FA2 decode.  `[Terrain]` and
  `[Structures]` keys are packed cells too, so the rewrite is section-scoped
  (`rewriteWaypoint` in `starts.js`) rather than a text replacement.

`starts.js` is pure code (no DOM) so `node tools/verify_starts.mjs` can drive all of
it; the canvas and pointer handling stay in `app.js`.

One browser-only trap worth remembering: the overlay is a `<canvas>`, which is a
**replaced element**.  `position: absolute; inset: 1px` does not stretch it -- its
`width: auto` takes the intrinsic 300x150 and the opposite inset is ignored, so the
markers are drawn at a fraction of the map.  The CSS sets an explicit
`calc(100% - 2px)` size for that reason.

**参数集 does not describe the moved starts.**  The code carries generation inputs
only (`sharebits.js`), so it reproduces the terrain — not a hand-edited map.  Rather
than extend the format (it would cost +4 characters for one moved start and +29 for
eight, force a version bump so older pages reject new codes, and put the codec — an
area other work is touching — on the critical path), the editor says it in one line
next to its own buttons: 改出生点不进参数集.  Sharing the exact edited map means
sending the `.map` file.

## 矿石绘制 (painting ore on the preview)

With the same rendered image, dragging a box on the preview selects the cells whose
drawn centre falls inside it (`cellsInRect` in `ore.js`); right-clicking opens a menu
that paints **green ore** (Riparius) or **彩矿/gems** (Cruentus) on every placeable
cell of the selection, clears the minerals in it, or acts on the **single cell under
the pointer** (放矿柱 / 移除矿柱).  The map is rewritten **in the browser**, then
re-rendered — no regeneration, so the terrain, starts and everything else stay
exactly as generated.

What the brushes write is the map's own mineral layer:

* **[OverlayPack]/[OverlayDataPack]** are the fixed 512 × 512 grids the writer emits
  (`MapGenMapFile.cpp`: `index = X + 512 * Y`, `0xFF` = no overlay), 32 chunks of
  8192 bytes, each a 3-byte length, the `0x20` tag and a Format80 payload, shipped as
  numbered base64 lines.  `ore.js` decodes and re-encodes exactly that shape;
  `tools/verify_ore.mjs` checks both directions against `maptools/format80.py` and
  compares the rewritten file with the Python map-format oracle, section by section.
* **The ids are the generator's own**: ore 102..113 (`MapGenTiberium.cpp`'s
  `overlayBase 102` plus 0..11) and gems 27..38 (`overlayBase 27`), both at growth
  stage 11 — a mature field, the value most cells of a generated map already carry.
  The brushes are additive: a cell already carrying the **other** family is left
  alone (清除矿 is the way to change a field's type), and other tiberium families are
  recognised and never overwritten.
* **Placeability is the engine's vocabulary**, not a colour guess: the cell must be
  in the map diamond and `PassabilityType_Passable` in the `<out>.cells` sidecar the
  generator already exports for the start editor (so water, beach, cliffs, walls and
  rocks are out), its overlay slot must be empty, it must not be a building
  foundation cell (the sidecar's third flag bit is `AltCellFlags_ContainsBuilding`;
  `[Structures]` names the anchor cell only), and it must not hold a `[Terrain]`
  object (trees; read out of the map text).  The variant within each family is
  derived from the cell coordinates, so painting the same box twice produces the
  same bytes.
* **矿柱** is a `[Terrain]` object (`TIBTRE01..03`), not an overlay, so it can sit on
  an ore tile (the generator's 矿树) or on bare ground (裸矿柱).  Right-clicking a
  single cell offers 放矿柱: the cell must be passable and not a building foundation,
  and whatever else is on it is removed first — an existing `[Terrain]` object is
  replaced and a non-mineral overlay is cleared; ore/gems are kept.  移除矿柱 deletes
  only the `TIBTRE` line.  The generator's own placement rules and names are in
  `MapGenTiberium.cpp` 397-409 / 484-510.

Like the start editor, this is a manual edit and the 参数集 does not describe it —
regenerating from the code gives back the generated map, not the painted one.

## 中立建筑 (placing a neutral tech building)

Right-clicking a cell also offers the three neutral tech buildings the user picked:
科技钻油井 (CAOILD, 2×2), 科技机器商店 (CAMACH, 3×3) and 科技前哨站 (CAOUTP, 4×3,
the one with the repair dock — labelled 科技维修厂 in the menu).  Hovering an item
draws the exact foundation; clicking it appends a real `[Structures]` line:

```
INDEX=OWNER,TYPE,256,X,Y,0,None,0,0,1,0,0,None,None,None,1,0
```

The owner is the map's neutral house — `Neutral` on a multiplayer map,
`Neutral House` on a single-player one (the generator writes both layouts).  The
foundation is validated against the `<out>.cells` sidecar: every cell must be in
the map, passable, not a building foundation, and at the **same Level** as the
anchor (a building cannot sit on a slope).  Overlays (ore/gems included) and
`[Terrain]` objects under the footprint are removed, as asked; an existing
building is refused instead.  Buildings added by the page live only in
`[Structures]`, so their footprints are merged into the occupancy set used by the
ore and pillar brushes too.

**The renderer needed the art.** The extracted loose tree used to carry only
theater tiles and INIs, so CNCMaps drew **no buildings at all** — a map with an
oil derrick rendered as empty ground.  `engine/src/extract.cpp` now also pulls
the six neutral tech buildings' SHP art (theater-specific and generic variants)
and the outpost's `OUTP.vxl`/`.hva` turret, plus both theaters' palettes, into
`x64/Release`.  The browser cache version was bumped so older caches (which lack
those files) are discarded instead of silently hiding the buildings.  The names
are the renderer's own NewTheater resolution (temperate `CTOILD`/`CTHOSP`/…,
snow `CAOILD`/`CAHOSP`/…, generic `CGMACH`/`CGPOWR`), verified with the
renderer's `CCMAPS_VFS_TRACE` output and then by a real render.

## 地图编辑器（新页面）

编辑工具不再长在生成页上。生成页保留“预览 + 下载”，预览下方多一个
**在编辑器中打开**：它把当前地图字节和生成器的 `<out>.cells` 侧车写进
IndexedDB（`mapstore.js`），然后打开 `editor.html`。编辑器复用生成页已经写进
OPFS 的素材缓存（`worker.js` 的 `assets-from-cache` → `collect`），所以**不需要
再选一次游戏目录**，也不需要重新提取。

编辑器是三栏布局：

* 左侧工具条（数字键 1–9/0）：框选/查看、放矿石、放彩矿、清除矿、放矿柱、
  移除矿柱、放油井、放科技商店、放科技维修厂、改出生点；选出生点工具后右侧
  会列出每名玩家的出生点，点数字选中，拖红方块或点目标格移动（可撤销）；
* 中间是地图画布：滚轮缩放、Ctrl+滚轮按光标缩放、中键拖动、适应窗口；
  工具直接在地图上拖/点，悬停显示格子或建筑地基；
* 右侧是当前工具说明、选区统计（可放/已有/其他矿/不可放）、地图统计
  （尺寸/剧场/建筑/矿/矿柱）和操作（还原成生成时的地图、重新读取会话）。
* 每次改动都进撤销栈（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y），自动重新渲染；
  改动会防抖写回 IndexedDB，刷新编辑器不会丢；“下载地图/下载预览图”
  随时可取当前结果。

工具本身仍是纯模块：`starts.js` / `ore.js` / `buildings.js`，页面只做交互。
生成页原来的内嵌编辑条暂时保留（等这个页面验收后再删），但**新功能只加在
编辑器页面**。

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
* The **参数集** is verified by `tools/verify_sharebits.mjs` (every field the page can
  produce and every slider position round-trip exactly, a changed character is always
  caught, and the codec's constants are read from `mgconsole` rather than copied) and
  by `tools/verify_browser.mjs` (it appears with the map, decodes back to that run, a
  click copies it, and a code from another build offers the right version switch).
* The **矿石绘制** is verified by `tools/verify_ore.mjs`: Format80 against the
  project's Python codec in both directions, the `[OverlayPack]` rewrite against the
  Python map-format oracle (every other section byte-identical), both mineral
  brushes (green/gems, additive, idempotent, 清除 back to `0xFF`), the 矿柱 edit
  (replaces a tree, keeps every other `[Terrain]` line, refuses water/buildings,
  removes only TIBTRE), and — when the native renderer and a loose game tree are
  available — a real render whose painted cells' and pillar cell's pixels changed.
* The **中立建筑** is verified by `tools/verify_buildings.mjs`: the three
  foundations against the generator's sidecar (water/cliff/slope/existing-building
  refusal), the exact `[Structures]` line and owner for both map layouts, the
  overlay/terrain cleanup, a Python section-by-section comparison, and a real
  render from **only the extracted loose tree** proving the building is drawn.
* The **地图编辑器** is verified in `tools/verify_browser.mjs`: the generator hands
  the map over, the editor loads it and restores the cached assets without the game
  directory, the unified tool palette is present, an ore drag changes only the
  overlay sections, and undo restores the starting map byte-for-byte.
* The **画廊** (`gallery.html` + `gallery.js`) is the other half of 参数集: a catalogue
  whose list is a hand-editable text file (`gallery.txt`, one line per map:
  `参数集 | 作者 | 日期 | 标题 | 描述`, only the first field required) and whose every
  tag is decoded from the code, so a card cannot claim something the generator would
  not do.  The list is a **set, not a sequence**: every load shuffles it (「换一批」
  re-shuffles in place; a filter change keeps the order, so nothing moves under a click),
  which is why adding an entry is only ever adding a line.  `tools/verify_browser.mjs` covers it: the list is read line for line, the
  chips are checked against the decoded parameters (and against the generator's own
  wording), cards from another build are marked, the batch loading ends with the footer
  reachable, a card click lands in the generator with the code loaded, and the cards
  get wider with the window without overflowing.
* What is **still untested** is only what needs a browser: `FileReaderSync`
  (the tests substitute `fs.readSync`), ES-module/worker loading, and the page
  itself.  `app.js` / `worker.js` are written against the verified interface, but
  the first browser run should still be treated as a real test, not a formality.
* `showDirectoryPicker()` is Chromium-only and needs a secure context;
  `<input webkitdirectory>` works in more browsers and is what the page uses.
