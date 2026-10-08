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
        "  --size 0..3      map size slider\n"
        "  --players 2..8\n"
        "  --ore N          ore density index\n"
        "  --water 0..100   -1 = roll it (default)\n"
        "  --seed N         global seed (0 = GetTickCount)\n"
        "  --map-seed N     terrain RNG seed (0 = the vanilla constant)\n"
        "  --single         write a single-player .map instead of a .yrm\n"
        "  --out PATH       output map path\n");
}

std::wstring widen(const std::string& s)
{
    std::wstring w;
    for (char c : s) w.push_back(static_cast<wchar_t>(static_cast<unsigned char>(c)));
    return w;
}

}  // namespace

int main(int argc, char** argv)
{
    std::string root;
    std::string out = "oracle.map";
    int land = 1, theater = 0, size = 1, players = 2, ore = 1, water = -1;
    unsigned seed = 1, mapSeed = 0;
    bool single = false;

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
        else if (a == "--size") size = std::atoi(next());
        else if (a == "--players") players = std::atoi(next());
        else if (a == "--ore") ore = std::atoi(next());
        else if (a == "--water") water = std::atoi(next());
        else if (a == "--seed") seed = static_cast<unsigned>(std::strtoul(next(), nullptr, 0));
        else if (a == "--map-seed") mapSeed = static_cast<unsigned>(std::strtoul(next(), nullptr, 0));
        else if (a == "--single") single = true;
        else if (a == "-h" || a == "--help") { usage(); return 0; }
        else { std::fprintf(stderr, "unknown argument: %s\n", a.c_str()); usage(); return 2; }
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
    cfg.timeOfDay = 0;
    cfg.sizeSlider = size;
    cfg.playerCount = players;
    cfg.oreDensity = ore;
    cfg.multiplayer = !single;

    cfg.global = rmg.RollGlobalOptions(seed ? seed : GetTickCount());
    cfg.randomSeed = static_cast<uint32_t>(cfg.global.seed04C);
    cfg.mapRngSeed = mapSeed;
    cfg.waterAmount = (water >= 0) ? water : cfg.global.waterAmount;

    std::fprintf(stderr, "[mgconsole] land=%d theater=%d size=%d players=%d ore=%d water=%d seed=%u\n",
                 land, theater, size, players, ore, cfg.waterAmount, seed);

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
