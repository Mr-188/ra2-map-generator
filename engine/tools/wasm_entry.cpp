// Browser entry point.
//
// The desktop CLI reads archives from disk.  A browser cannot: ra2.mix is 269 MB
// and ra2md.mix 195 MB, so neither fits in MEMFS alongside everything else.
// Instead the picked Files stay on the JS side and this translation unit hands
// the engine a ByteSource that slices them on demand.
//
// The reads must be SYNCHRONOUS because ByteSource::read is, so the worker that
// hosts this module uses FileReaderSync -- which is exactly why the wasm runs in
// a worker rather than on the page.
//
// What lands in MEMFS is only the extracted loose-file tree (about 9 MB), which
// is the layout the unmodified generator reads.
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <sys/stat.h>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "MapGen.h"

#include "byte_source.h"
#include "extract.h"
#include "win32/windows.h"

#if defined(__EMSCRIPTEN__)
#include <emscripten.h>

// Implemented in the worker (webapp/worker.js): both reach into the JS-side map
// of picked Files.
EM_JS(double, mg_js_file_size, (int id), { return Module.mgFileSize(id); });
EM_JS(int, mg_js_read, (int id, double offset, double length, std::uint8_t* out), {
    return Module.mgRead(id, offset, length, out);
});

namespace {

std::string basenameOf(const std::string& path)
{
    const std::size_t slash = path.find_last_of("/\\");
    return (slash == std::string::npos) ? path : path.substr(slash + 1);
}

// id (a JS handle) keyed by lower-case file name.
std::map<std::string, int>& registry()
{
    static std::map<std::string, int> r;
    return r;
}

std::string g_root = "/mg";
std::string g_error;
std::string g_output;

class JsFileSource final : public mg::ByteSource
{
public:
    JsFileSource(int id, std::size_t size) : id_(id), size_(size) {}

    std::size_t size() const override { return size_; }

    bool read(std::size_t offset, std::size_t len, std::uint8_t* out) override
    {
        if (offset > size_ || len > size_ - offset) return false;
        if (len == 0) return true;
        return mg_js_read(id_, static_cast<double>(offset),
                          static_cast<double>(len), out) != 0;
    }

private:
    int id_;
    std::size_t size_;
};

std::shared_ptr<mg::ByteSource> jsFactory(const std::string& path)
{
    std::string name = basenameOf(path);
    for (char& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    auto it = registry().find(name);
    if (it == registry().end()) return nullptr;
    const double size = mg_js_file_size(it->second);
    if (size < 0) return nullptr;
    return std::make_shared<JsFileSource>(it->second, static_cast<std::size_t>(size));
}

}  // namespace

extern "C" {

// Registers a File the player picked.  `id` is opaque to us; `name` is the bare
// file name, e.g. "ra2.mix".
EMSCRIPTEN_KEEPALIVE void mg_add_file(int id, const char* name)
{
    if (!name) return;
    std::string key = basenameOf(name);
    for (char& c : key) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    registry()[key] = id;
}

EMSCRIPTEN_KEEPALIVE void mg_set_root(const char* root)
{
    g_root = (root && *root) ? root : "/mg";
    mg::setSourceFactory(jsFactory);
}

EMSCRIPTEN_KEEPALIVE const char* mg_error() { return g_error.c_str(); }
EMSCRIPTEN_KEEPALIVE const char* mg_output_path() { return g_output.c_str(); }

// The engine's own sizeSlider bounds for one (land, players) pair, so the page
// can size its slider from the tables that actually drive CalcMapSize instead of
// carrying a hand copy of them.  (The page used to hard-code "past 4 nothing
// changes", which was a transcription of kSizeFractionMax.)
//
// Doubles: the parameter is fractional, and the interesting bound is 3.6, which
// the retail dialog's integer slider could not name.
//
// useful: the last value after which a larger slider changes nothing.
// legal:  the last value that does not overflow the 512-cell overlay grid.
EMSCRIPTEN_KEEPALIVE double mg_size_useful_max(int land, int players)
{
    return RandomMapGenerator::SizeSliderRange(
        static_cast<LandType>(land), players).usefulMax;
}

EMSCRIPTEN_KEEPALIVE double mg_size_legal_max(int land, int players)
{
    return RandomMapGenerator::SizeSliderRange(
        static_cast<LandType>(land), players).legalMax;
}

// The granularity to offer, from the same place the bounds come from.
EMSCRIPTEN_KEEPALIVE double mg_size_step()
{
    return RandomMapGenerator::kSizeSliderStep;
}

// The largest widthCells + heightCells an explicit rectangle may use.  The page
// clamps its two number inputs with this, so it never has to re-derive the grid
// arithmetic -- and never offers a pair the writer would refuse.
EMSCRIPTEN_KEEPALIVE int mg_rect_max_sum()
{
    return RandomMapGenerator::MaxRectCellSum();
}

// The kinds of symmetry the page may offer - the ones the pass actually applies,
// not the enum's limit.  The enum, its derivation and the measurements that decide
// which kinds exist at all live in engine/src/mirror.h; the page asks rather than
// carrying a copy.
EMSCRIPTEN_KEEPALIVE int mg_symmetry_max()
{
    return mg::kMapSymmetryImplementedMax;
}

// How many cells an explicit rectangle actually puts in the map.  The iso grid is
// (mapWidth * 2 - 1) columns wide by mapHeight tall, so the diamond holds
// (2 * mapWidth - 1) * mapHeight cells -- the same number tools/decode.py reads
// back out of the written file.  The page used to label width * height as "格",
// but that is the *visible* rect, about half the cells the map really contains;
// the arithmetic lives here so the readout cannot drift from the writer.
EMSCRIPTEN_KEEPALIVE int mg_rect_cells(int width, int height)
{
    if (width <= 0 || height <= 0)
        return 0;
    MapGenConfig cfg = {};
    cfg.widthCells = width;
    cfg.heightCells = height;
    const MapSizeResult ms = RandomMapGenerator::CalcMapSize(cfg);
    return (2 * ms.mapWidth - 1) * ms.mapHeight;
}

// Materialises the generator's loose-file tree in MEMFS from the registered
// archives.  Returns 0 on success.
EMSCRIPTEN_KEEPALIVE int mg_extract(int theater)
{
    g_error.clear();
    // MEMFS starts empty; the extractor's gameDir and root have to exist before
    // it will write anything.
    ::mkdir("/game", 0755);
    ::mkdir(g_root.c_str(), 0755);

    mg::ExtractOptions opt;
    opt.gameDir = "/game";
    opt.theater = theater;
    opt.root = g_root;

    const mg::ExtractReport rep = mg::extractForGenerator(opt);
    if (!rep.ok)
    {
        g_error = rep.error;
        return 1;
    }
    return 0;
}

// Runs the reference pipeline.  The map is written to `outPath` in MEMFS.
//
// Argument order mirrors the reference GUI's parameter rows, with `timeOfDay`
// where the GUI's 时间 combo sits.  It is a real input: the engine reads it for
// LevelLight/AmbientLight and for the per-time ore-patch lamps
// (TEMMORLAMP/TEMDAYLAMP/TEMDUSLAMP/TEMNITLAMP).
EMSCRIPTEN_KEEPALIVE int mg_generate(int land, int theater, int timeOfDay, double size, int players,
                                     int ore, int water, unsigned seed,
                                     unsigned mapSeed, int single,
                                     int width, int height, int symmetry,
                                     const char* outPath)
{
    g_error.clear();
    const std::string root = g_root;
    mg_win32::setModulePath(root + "/x64/Release/MapGenerator.exe");

    // Refuse a kind the pass does not apply up front: it would be refused anyway,
    // but only after a whole map had been generated.  The bound is the implemented
    // maximum (engine/src/mirror.h), the same one mg_symmetry_max() reports and
    // mgconsole checks, so phase 2 moves one constant.
    if (symmetry < 0 || symmetry > mg::kMapSymmetryImplementedMax)
    {
        g_error = "symmetry not implemented yet";
        return 2;
    }

    // A FRESH generator per call, exactly as the reference GUI does it: WinMain
    // constructs one inside its generate handler (WinMain.cpp:463).  Holding it
    // in a function-static instead made generation order-dependent -- the first
    // map of a session matched the native oracle and every later one did not,
    // with identical parameters and an identical seed.  tools/verify_webapi.mjs
    // regenerates on purpose to guard against a relapse.
    RandomMapGenerator rmg;

    MapGenConfig cfg = {};
    cfg.landType = static_cast<LandType>(land);
    cfg.theater = theater;
    cfg.timeOfDay = timeOfDay;
    cfg.sizeSlider = size;
    cfg.widthCells = width;
    cfg.heightCells = height;
    cfg.playerCount = players;
    cfg.oreDensity = ore;
    cfg.multiplayer = single ? false : true;
    cfg.symmetry = static_cast<mg::MapSymmetry>(symmetry);

    // Refuse a size the writer would silently truncate, using the engine's own
    // tables rather than a second copy of them.
    if (width > 0 && height > 0)
    {
        const MapSizeResult ms = RandomMapGenerator::CalcMapSize(cfg);
        if (ms.workSide > RandomMapGenerator::kOverlayGridSide)
        {
            char buf[200];
            std::snprintf(buf, sizeof buf,
                "%dx%d cells needs workSide %d > %d (the overlay grid); the "
                "overlays would be truncated",
                width, height, ms.workSide, RandomMapGenerator::kOverlayGridSide);
            g_error = buf;
            return 5;
        }
    }
    else
    {
        const RandomMapGenerator::SizeRange r =
            RandomMapGenerator::SizeSliderRange(cfg.landType, cfg.playerCount);
        if (size < 0 || size > r.legalMax)
        {
            char buf[220];
            std::snprintf(buf, sizeof buf,
                "size %.3f is out of range for land=%d players=%d: legal 0..%.3f, "
                "of which 0..%.3f change the map", size, land, players,
                r.legalMax, r.usefulMax);
            g_error = buf;
            return 5;
        }
    }

    cfg.global = rmg.RollGlobalOptions(seed ? seed : GetTickCount());
    cfg.randomSeed = static_cast<std::uint32_t>(cfg.global.seed04C);
    cfg.mapRngSeed = mapSeed;
    cfg.waterAmount = (water >= 0) ? water : cfg.global.waterAmount;

    if (!rmg.GenerateMapBody(cfg))
    {
        g_error = "GenerateMapBody failed";
        return 2;
    }
    if (cfg.landType == LandType::Inland || cfg.landType == LandType::Mountainous)
    {
        if (rmg.GetWaterAmount() != 0) rmg.GenerateSpecialTerrain();
        if (!rmg.MirrorSpecialTerrain(cfg.symmetry))
        {
            g_error = "MirrorSpecialTerrain failed";
            return 8;
        }
    }
    else
    {
        rmg.GenerateTerrain();
    }
    rmg.DecorateWaterTiles();
    rmg.InitRegions();
    rmg.MakeRegions();
    rmg.RecalculateCellAttributes();
    rmg.CreateStartingPoints();
    rmg.AddTechBuildings();
    rmg.AddTiberium();
    if (!rmg.MirrorOverlays(cfg.symmetry))
    {
        g_error = "MirrorOverlays failed";
        return 9;
    }
    rmg.RecalculateCellAttributes();
    rmg.RecalculateCellAttributes();
    rmg.CreateHills();
    rmg.CreateLATs();
    rmg.RecalculateCellAttributes();
    rmg.PruneTerrainTrees();
    // [移植侧] The symmetry pass, at the same point the native driver uses it:
    // after every RNG-consuming and disassembly-derived stage, before the radar
    // and the writer (both of which rebuild what they need from the cells).
    if (!rmg.MirrorMap(cfg.symmetry))
    {
        g_error = "MirrorMap failed";
        return 6;
    }
    rmg.Cleanup();
    rmg.ComputeRadarImage();
    rmg.Done();

    std::wstring wout;
    for (const char* p = outPath; p && *p; ++p)
        wout.push_back(static_cast<wchar_t>(static_cast<unsigned char>(*p)));
    if (!rmg.SaveMapFile(wout.c_str()))
    {
        g_error = "SaveMapFile failed";
        return 3;
    }
    g_output = outPath ? outPath : "";
    return 0;
}

// Copies a MEMFS file out to the caller.
//
// Two-call protocol: with `buf == nullptr` it returns the file's length so the
// caller can size its buffer; with a buffer it returns the number of bytes read.
// Returns -1 when the file is missing or `cap` is too small.
EMSCRIPTEN_KEEPALIVE int mg_read_output(const char* path, std::uint8_t* buf, int cap)
{
    std::FILE* f = std::fopen(path, "rb");
    if (!f) return -1;
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    if (size < 0 || (cap >= 0 && size > cap))
    {
        std::fclose(f);
        return -1;
    }
    if (!buf)
    {
        std::fclose(f);
        return static_cast<int>(size);   // sizing call
    }
    const std::size_t got = std::fread(buf, 1, static_cast<std::size_t>(size), f);
    std::fclose(f);
    return static_cast<int>(got);
}

}  // extern "C"

#else  // !__EMSCRIPTEN__

// A native build of this file has no JS to talk to; keep the translation unit
// compilable so the source is type-checked by the desktop build too.
extern "C" int mg_wasm_entry_placeholder() { return 0; }

#endif  // __EMSCRIPTEN__
