// mgconsole -- run the reference implementation's RMG pipeline with no GUI.
//
// Mirrors OnGenerate() in MapGenerator/WinMain.cpp stage for stage; only the
// dialog, progress bar and preview panel are left out.  Every rmg.* call and its
// sub_ address comes from that file, so the two stay comparable.
//
// This program is a LOCAL ORACLE: it links the reference sources from
// reference_impl/ (git-ignored, no licence) to produce ground truth for the
// port.  It is not part of the product and must never be shipped.
//
//   mgconsole --root <extract dir> [--land 1] [--theater 0] [--size 1]
//              [--players 2] [--ore 1] [--water -1] [--seed 1] [--map-seed 0]
//              [--single] [--out map.map]
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "MapGen.h"
#include "win32/windows.h"

namespace {

void usage()
{
    std::fprintf(stderr,
        "usage: mgconsole --root <extract dir> [options]\n"
        "  --land 0..4      Archipelago/Continent/TeamContinent/Inland/Mountainous\n"
        "  --theater 0|1    TEMPERATE (0) or SNOW (1)\n"
        "  --time 0..3      morning / day / dusk / night (the GUI's 时间 row)\n"
        "  --size N         map size slider, fractional: 0..useful (see --size-range)\n"
        "  --width N        explicit visible width  } together these replace --size and\n"
        "  --height N       explicit visible height } are the only way to get a non-square map\n"
        "  --players 2..8\n"
        "  --ore N          ore density index\n"
        "  --water 0..100   -1 = roll it (default)\n"
        "  --seed N         global seed (0 = GetTickCount)\n"
        "  --map-seed N     terrain RNG seed (0 = the vanilla constant)\n"
        "  --single         write a single-player .map instead of a .yrm\n"
        "  --size-range     print the legal/useful --size bounds for --land/--players, exit\n"
        "  --out PATH       output map path\n");
}

// UTF-8 -> UTF-16, via the shim.  The obvious byte-wise cast is WRONG here:
// the shim's normaliseW() encodes wide paths back to UTF-8 before it touches the
// filesystem, so a byte-wise widen double-encodes every non-ASCII byte and the
// resulting path names nothing.  Symptom: SaveMapFile() fails with no further
// explanation whenever --out sits under a directory whose name is not ASCII --
// which is what broke verify_render, since it writes under build/.
std::wstring widen(const std::string& s)
{
    return mg_win32::fromUtf8(s.c_str(), static_cast<int>(s.size()));
}

}  // namespace

int main(int argc, char** argv)
{
    std::string root;
    std::string out = "oracle.map";
    int land = 1, theater = 0, time = 0, players = 2, ore = 1, water = -1;
    double size = 1.0;
    int width = 0, height = 0;   // explicit rectangle, overrides --size when both > 0
    unsigned seed = 1, mapSeed = 0;
    bool single = false;
    bool sizeRange = false;

    for (int i = 1; i < argc; ++i)
    {
        const std::string a = argv[i];
        auto next = [&]() -> const char* {
            if (i + 1 >= argc) { usage(); std::exit(2); }
            return argv[++i];
        };
        if (a == "--root") root = next();
        else if (a == "--out") out = next();
        else if (a == "--land") land = std::atoi(next());
        else if (a == "--theater") theater = std::atoi(next());
        else if (a == "--time") time = std::atoi(next());
        else if (a == "--size") size = std::strtod(next(), nullptr);
        else if (a == "--width") width = std::atoi(next());
        else if (a == "--height") height = std::atoi(next());
        else if (a == "--players") players = std::atoi(next());
        else if (a == "--ore") ore = std::atoi(next());
        else if (a == "--water") water = std::atoi(next());
        else if (a == "--seed") seed = static_cast<unsigned>(std::strtoul(next(), nullptr, 0));
        else if (a == "--map-seed") mapSeed = static_cast<unsigned>(std::strtoul(next(), nullptr, 0));
        else if (a == "--single") single = true;
        else if (a == "--size-range") sizeRange = true;
        else if (a == "-h" || a == "--help") { usage(); return 0; }
        else { std::fprintf(stderr, "unknown argument: %s\n", a.c_str()); usage(); return 2; }
    }

    // --size-range answers a question rather than generating, and needs no root.
    // It is how tools/verify_size.py reads the engine's own limits instead of
    // restating them.
    if (sizeRange)
    {
        const RandomMapGenerator::SizeRange r =
            RandomMapGenerator::SizeSliderRange(static_cast<LandType>(land), players);
        std::printf("land=%d players=%d useful=%.3f legal=%.3f step=%.3f rectsum=%d\n",
                    land, players, r.usefulMax, r.legalMax,
                    RandomMapGenerator::kSizeSliderStep,
                    RandomMapGenerator::MaxRectCellSum());
        return 0;
    }

    if (root.empty()) { usage(); return 2; }

    // The generator derives every path from GetModuleFileNameW, so point it at
    // the extraction layout's synthetic executable.
    const std::string exe = root + "/x64/Release/MapGenerator.exe";
    mg_win32::setModulePath(exe);
    std::fprintf(stderr, "[mgconsole] module path %s\n", exe.c_str());

    RandomMapGenerator rmg;
    rmg.SetOutputDir(widen(root + "/x64/Release/"));

    MapGenConfig cfg = {};
    cfg.landType = static_cast<LandType>(land);
    cfg.theater = theater;
    cfg.timeOfDay = time;
    cfg.sizeSlider = size;
    cfg.widthCells = width;
    cfg.heightCells = height;
    cfg.playerCount = players;
    cfg.oreDensity = ore;
    cfg.multiplayer = !single;

    cfg.global = rmg.RollGlobalOptions(seed ? seed : GetTickCount());
    cfg.randomSeed = static_cast<uint32_t>(cfg.global.seed04C);
    cfg.mapRngSeed = mapSeed;
    cfg.waterAmount = (water >= 0) ? water : cfg.global.waterAmount;

    std::fprintf(stderr, "[mgconsole] land=%d theater=%d time=%d size=%.3f players=%d ore=%d water=%d seed=%u\n",
                 land, theater, time, size, players, ore, cfg.waterAmount, seed);

    // Refuse a size the writer would silently truncate.  The limit comes from the
    // engine's own tables (SizeSliderRange), not from a second copy of them here.
    if (width > 0 && height > 0)
    {
        const MapSizeResult ms = RandomMapGenerator::CalcMapSize(cfg);
        if (ms.workSide > RandomMapGenerator::kOverlayGridSide)
        {
            std::fprintf(stderr,
                "[mgconsole] %dx%d cells needs workSide %d > %d (the 512-cell "
                "overlay grid); the overlays would be truncated\n",
                width, height, ms.workSide, RandomMapGenerator::kOverlayGridSide);
            return 5;
        }
        std::fprintf(stderr, "[mgconsole] explicit %dx%d -> mapWidth=%d mapHeight=%d workSide=%d\n",
                     width, height, ms.mapWidth, ms.mapHeight, ms.workSide);
    }
    else
    {
        const RandomMapGenerator::SizeRange r =
            RandomMapGenerator::SizeSliderRange(cfg.landType, cfg.playerCount);
        if (size < 0 || size > r.legalMax)
        {
            std::fprintf(stderr,
                "[mgconsole] size %.3f is out of range for land=%d players=%d: "
                "legal 0..%.3f, of which 0..%.3f change the map (a larger value is either "
                "clamped or would overflow the 512-cell overlay grid)\n",
                size, land, players, r.legalMax, r.usefulMax);
            return 5;
        }
        if (size > r.usefulMax)
        {
            std::fprintf(stderr,
                "[mgconsole] note: size %.3f is legal but identical to size %.3f "
                "(fraction pinned at %.2f)\n",
                size, r.usefulMax,
                static_cast<double>(RandomMapGenerator::kSizeFractionMax));
        }
    }

    // ---- the pipeline, in WinMain.cpp's order -----------------------------
    if (!rmg.GenerateMapBody(cfg))                       // sub_599650
    {
        std::fprintf(stderr, "[mgconsole] GenerateMapBody failed\n");
        return 3;
    }

    if (cfg.landType == LandType::Inland || cfg.landType == LandType::Mountainous)  // 0x598aed
    {
        if (rmg.GetWaterAmount() != 0) rmg.GenerateSpecialTerrain();  // sub_59C580
    }
    else
    {
        rmg.GenerateTerrain();                            // sub_59A6C0
    }

    rmg.DecorateWaterTiles();                             // 0x598b14  sub_59C630
    rmg.InitRegions();                                    // 0x598C24
    rmg.MakeRegions();                                    // 0x598D44
    rmg.RecalculateCellAttributes();                      // 0x598E1F
    rmg.CreateStartingPoints();                           // 0x598E9E
    rmg.AddTechBuildings();                               // 0x598EBF
    rmg.AddTiberium();                                    // 0x598EE5
    rmg.RecalculateCellAttributes();                      // 0x598FB8
    rmg.RecalculateCellAttributes();                      // 0x59912A
    rmg.CreateHills();                                    // 0x599171
    rmg.CreateLATs();                                     // 0x599215
    rmg.RecalculateCellAttributes();                      // 0x599354
    rmg.PruneTerrainTrees();                              // port-side, after pass 4
    rmg.Cleanup();                                        // 0x5993A5
    rmg.ComputeRadarImage();                              // 0x599451
    rmg.Done();                                           // 0x59947E

    const std::wstring wout = widen(out);
    if (!rmg.SaveMapFile(wout.c_str()))
    {
        std::fprintf(stderr, "[mgconsole] SaveMapFile failed\n");
        return 4;
    }
    std::fprintf(stderr, "[mgconsole] wrote %s\n", out.c_str());
    return 0;
}
