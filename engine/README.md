# engine/ -- C++ MIX layer and virtual filesystem

The C++ side of the generator.  Written so the same source builds natively (for
verification and the command-line pipeline) and under Emscripten (for the
single-page front end, phase 3).

## Why this layer exists

The reference implementation this project is modelled on reads only **loose
files** next to its executable -- which is why its repository ships extracted
`相关INI/` and `Tile资源/`.  This layer removes that requirement: it reads the
player's own game directory directly, out of the retail MIX archives.

Verified facts about the retail layout (see `docs/external_mapgenerator_yaoyaojiang.md`
and the checks in `tools/verify_mix.py`):

| Wanted | Lives in | Depth |
| --- | --- | --- |
| `rulesmd.ini`, `artmd.ini`, `temperatmd.ini`, `rmgmd.ini` | `ra2md.mix` → `localmd.mix` | 2 |
| `temperat.pal` | `ra2.mix` → `cache.mix` | 2 |
| theater tiles (TEMPERATE) | `ra2.mix` → `isotemp.mix`, `ra2.mix` → `temperat.mix`, `ra2md.mix` → `isotemmd.mix` | 2 |

Two consequences drove the design:

* **Nested archives are mandatory**, not a nicety -- every file above is one
  level deeper than the top archive.
* **The retail index stores only 32-bit name hashes.**  Names come from a
  curated `KNOWN_NAMES` list plus the `local mix database.dat` the archive
  carries; both feed a hash → name map, and lookup is always by hash.
* **MIX entries are stored raw.**  There is no LZO step in the archive format;
  LZO belongs to the map's IsoMapPack5 payload (`maptools/format5.py`).

## Files

```
src/crc32.h            reflected CRC-32 + the MIX filename hash (padding quirk)
src/blowfish.h/.cpp    Blowfish + Westwood public-key key derivation
src/blowfish_tables.h  GENERATED -- P-array, S-boxes, RSA modulus
src/byte_source.h/.cpp lazy byte access: MemorySource / FileSource
src/mix.h/.cpp         MixArchive (parse/lookup/extract/nested)
src/ini.h/.cpp         INI reader with GetPrivateProfile* semantics
src/extract.h/.cpp     MIX -> the reference implementation's loose-file layout
src/win32/windows.h    Win32 compatibility layer (see below)
src/win32/win32_compat.cpp
src/win32/strsafe.h    <strsafe.h> / <objidl.h> / <gdiplus.h> replacements
src/win32/objidl.h
src/win32/gdiplus.h
tools/mixinfo.cpp      MIX verification CLI
tools/mgextract.cpp    extraction CLI
tools/mgconsole.cpp    console driver for the unmodified reference pipeline
tools/wasm_entry.cpp   browser entry point (mg_add_file/mg_set_root/mg_extract/...)
build_oracle.sh        builds mgconsole: reference sources + our shim
build_wasm.sh          node/wasm build of the same console (for diffing)
build_web.sh           browser module (ES module + worker)
```

### The Win32 shim

`src/win32/windows.h` provides exactly the surface the reference's core
translation units use -- measured, not guessed: 53 `GetPrivateProfileIntA`, 23
`GetPrivateProfileStringA`, 2 `GetPrivateProfileSectionNamesA`, 9
`GetModuleFileNameW`, 6 `GetFileAttributesW`, 4 `CreateDirectoryW`, one each of
`CreateFileW`/`ReadFile`/`GetFileSizeEx`, 3 `_wfopen_s`, and the MSVC secure-CRT
and `swprintf_s` calls.  (`StringCch*`, `SendMessageW`, `MessageBoxW`,
`EnableWindow` and the `FindFirst` family appear only in `WinMain.cpp`, which
`mgconsole` replaces.)

Two platform differences would silently corrupt results and are handled inside
the shim rather than at the call sites:

* **`%s` in a wide printf.**  MSVC reads it as a wide string; glibc reads it as
  multibyte and wants `%ls`.  Every conversion in a wide format is rewritten
  before glibc sees it.  (Symptom when unfixed: `swprintf_s(w, L"%s%s", a, b)`
  produces the two characters `CT`.)
* **Path case.**  Windows ignores case and uses backslashes; ext4 and MEMFS do
  neither.  Every path is normalised and resolved case-insensitively, because
  the reference asks for `TEMPERATMD.INI` and `RULESMD.INI` in upper case, and
  `GetModuleFileNameW` reports a backslash path so its `wcsrchr(dir, L'\\')`
  finds the separator.
* **Wide printf and non-ASCII.**  `swprintf_s` is NOT the C library's.  glibc's
  `vswprintf` takes a wide format directly, but musl's -- which Emscripten uses
  -- converts it to multibyte first, and in the default `"C"` locale a non-ASCII
  wide character cannot be represented, so **the conversion stops there**.  The
  reference builds its theater tile path with
  `L"%s..\\..\\Tile\u8d44\u6e90\\%s\\"`, which therefore produced
  `.../Tile` under wasm and the full path natively: every tile lookup missed,
  the map came out 25% smaller, and the two builds disagreed.  `formatWide()`
  in `win32_compat.cpp` implements the conversions directly (d i u o x X c s,
  flags/width/precision, `%%`, `%s` = wide string) and removes the dependency
  on either C library's locale handling.

Only the header/index of an archive is held in memory: `ra2.mix` is 269 MB and
`ra2md.mix` 195 MB, so entry payload is read on demand through a `ByteSource`.
The same interface will back the browser build, where the bytes come from a File
the player picked.

`blowfish_tables.h` is generated by `tools/gen_blowfish_tables.py` from the
verified Python reader rather than transcribed, so a single wrong nibble in an
S-box cannot silently poison the key schedule.

## Building

```sh
# native (verification CLI)
g++ -std=c++17 -O2 -Wall -Wextra -Iengine/src \
    -o build/engine/mixinfo \
    engine/src/blowfish.cpp engine/src/mix.cpp engine/tools/mixinfo.cpp

# or cmake
cmake -S engine -B build/engine -DCMAKE_BUILD_TYPE=Release && cmake --build build/engine

# WebAssembly (phase 3; entry point not written yet)
emcmake cmake -S engine -B build/engine-wasm -DMG_WASM=ON && cmake --build build/engine-wasm
```

## Verification

```sh
python3 tools/verify_mix.py
```

Drives the C++ CLI and the verified Python reader over the same real archives
and compares header facts, filename hashes, and extracted bytes (size + md5)
for files reached through nested archives, with a negative control.  Exit status
is 0 only when everything agrees.

## Extraction instead of a filesystem shim

The reference implementation reads only loose files, so rather than intercepting
its 78 `GetPrivateProfile*` call sites with a MIX-aware shim we materialise the
layout it already expects -- the same layout its own repository ships -- once per
game directory and reuse it across generations.  Under Emscripten the identical
tree is built in MEMFS, so nothing touches the player's disk.

## Status

* Phase 1 (MIX layer) -- **done and verified**: 35 checks pass, byte-for-byte
  identical to `maptools/mix_file.py` on `ra2.mix`, `ra2md.mix`, `language.mix`,
  `langmd.mix`, `expandmd01.mix` and on four nested extractions.
* Phase 2a (extraction) -- **done and verified** by `tools/verify_extract.py`:
  the four INIs are byte-identical to the Python reader, and the theater tile set
  matches the Python oracle exactly (804 requested, 494 held by the archives, 494
  written).  Against the reference repository's own `Tile资源/温和/` folder, every
  tile that folder holds and the INI requests is present in ours (we have 233 it
  lacks; its 191 extra files are names the INI never requests).
* Phase 2b (Win32 shim + `mgconsole`) -- **done and verified** by
  `tools/verify_oracle.py`: the reference's own core, linked against this
  repository's shim and pointed at the extracted tree, generates a 13 005-cell
  map (water 6436, terrain 3797, clear 1784, shore 988) that the project's
  decoder reads back, and it is byte-identical across repeated runs with the same
  seed.  The oracle is now usable as ground truth for the port.
* Phase 3 (Emscripten) -- **engine verified**: `sh engine/build_wasm.sh` produces
  a 591 KB `mgconsole.wasm`, and `tools/verify_wasm.py` requires it to emit a map
  byte-identical to the native build's (110 371 B, md5 `8b650e5b...`).  The
  browser front end in `webapp/` is written against `engine/tools/wasm_entry.cpp`
  but has not been run in a browser yet -- see `webapp/README.md`.
* Phase 3 (browser glue) -- **contract verified under node** by
  `tools/verify_webapi.mjs`, which drives the browser module through exactly the
  API `webapp/worker.js` uses -- with the two EM_JS hooks (`mgFileSize`,
  `mgRead`) backed by the process filesystem instead of `FileReaderSync` -- and
  requires a byte-identical map.  That covers the risky part: the JS-backed
  ByteSource factory that reads `ra2.mix` (269 MB) on demand instead of copying
  it into MEMFS, the extraction into MEMFS (494 `.tem` files land under
  `/mg/Tile资源/温和`), and the two-call read-out.  What remains untested is what
  only a browser can exercise: `FileReaderSync` itself, worker/module loading and
  the page.
* Phase 4 (rendering) -- not started.

## Toolchain

Emscripten is not on this machine by default.  `tools/fetch_emscripten.sh` pulls
the Debian packages from an apt mirror and unpacks them under `~/opt/emscripten`
without root; `tools/emenv.sh` then puts it on PATH.  Two things that bite:

* A single long-range request to these mirrors is throttled to a few hundred
  kB/s.  `tools/fetch_parallel.sh` splits large files across 16 range requests
  (243 MB in under a minute instead of nine).  It concatenates chunks in
  **numeric** order -- a plain `part.*` glob sorts lexically, putting `part.10`
  before `part.2`, which yields a file of exactly the right length that is
  silently scrambled.
* The packaged `.emscripten` sets `FROZEN_CACHE` and points `LLVM_ROOT` at
  `/usr/bin`; both have to be overridden once the tree is relocated, and the
  Debian `emcc` symlink's wrapper hardcodes `/usr/share/emscripten`.
