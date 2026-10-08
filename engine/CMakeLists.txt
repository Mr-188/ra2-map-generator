# engine/ -- our C++ MIX + virtual-filesystem layer.
#
# Two build targets from one source set:
#   * native  -- used by the verification CLI (tools/mixinfo) and by the
#                byte-for-byte comparison against the Python reader.
#   * wasm    -- Emscripten, for the single-page front end (phase 3).
#
# Native build:
#   cmake -S engine -B build/engine -DCMAKE_BUILD_TYPE=Release && cmake --build build/engine
# WASM build:
#   emcmake cmake -S engine -B build/engine-wasm -DMG_WASM=ON && cmake --build build/engine-wasm

cmake_minimum_required(VERSION 3.16)
project(mg_engine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(MG_WASM "Build the engine for WebAssembly with Emscripten" OFF)
option(MG_WARNINGS "Enable the strict warning set" ON)

add_library(mg_mix STATIC
    src/blowfish.cpp
    src/mix.cpp
)
target_include_directories(mg_mix PUBLIC src)

if(MG_WARNINGS)
    if(MSVC)
        target_compile_options(mg_mix PRIVATE /W4)
    else()
        target_compile_options(mg_mix PRIVATE -Wall -Wextra)
    endif()
endif()

# The verification CLI is native-only: it exists to be diffed against the
# Python reader, which has no meaning inside the browser.
if(NOT MG_WASM)
    add_executable(mixinfo tools/mixinfo.cpp)
    target_link_libraries(mixinfo PRIVATE mg_mix)
endif()

# The browser entry point.  It links the reference implementation's core, so it
# only builds when that tree is present -- see engine/build_web.sh, which is the
# supported way to produce the browser module.
if(MG_WASM)
    add_executable(mg_engine_wasm tools/wasm_entry.cpp)
    target_link_libraries(mg_engine_wasm PRIVATE mg_mix)
    set_target_properties(mg_engine_wasm PROPERTIES
        OUTPUT_NAME mg_engine
        SUFFIX ".js"
        LINK_FLAGS "-sMODULARIZE=1 -sEXPORT_ES6=1 -sALLOW_MEMORY_GROWTH=1 -sSINGLE_FILE=1")
endif()
