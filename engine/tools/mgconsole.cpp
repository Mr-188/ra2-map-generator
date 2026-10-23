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
#include <map>
#include <algorithm>
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
        "                   (4 Mountainous is BYTE-IDENTICAL to 3 Inland here: every\n"
        "                   land-type branch treats them together and the option tables\n"
        "                   are indexed by the rolled n3 - see MapGenStartpoint.cpp:670.\n"
        "                   The page therefore offers 内陆 only; 4 stays as an alias.)\n"
        "  --theater 0|1|2  TEMPERATE (0), SNOW (1) or DESERT (2)\n"
        "  --time 0..3      morning / day / dusk / night (the GUI's 时间 row)\n"
        "  --size N         map size slider, fractional: 0..useful (see --size-range)\n"
        "  --width N        explicit visible width  } given TOGETHER they replace --size\n"
        "  --height N       explicit visible height } and are the only way to get a\n"
        "                   non-square map; one without the other is an error\n"
        "  --players 2..8\n"
        "  --ore N          ore density index\n"
        "  --water 0..100   -1 = roll it (default)\n"
        "  --seed N         global seed (0 = GetTickCount)\n"
        "  --map-seed N     terrain RNG seed (0 = the vanilla constant)\n"
        "  --single         write a single-player .map instead of a .yrm\n"
        "  --symmetry N     0 none (default), 1 left-right axial, 3 top-bottom axial,\n"
        "                   2 / 4 the two 180-degree rotations (same cell map, opposite\n"
        "                   authoritative half, so their dividing diagonals differ).\n"
        "                   Top-bottom is offered since 2026-10-21 after the user looked\n"
        "                   at its maps; see engine/src/mirror.h and webapp/index.html.\n"
        "  --size-range     print the legal/useful --size bounds for --land/--players, exit\n"
        "  --out PATH       output map path\n"
        "  --stop-after S   [diagnostic] write the map after stage S and exit;\n"
        "                   S in special|terrain|water|regions|hills|lats|prune|mirror\n"
        "  --diag-hills     [diagnostic] run CreateHills one sub-step at a time and\n"
        "                   print the mirror divergence after each (pair it with\n"
        "                   --diag-symmetry); says WHICH step breaks the two halves\n");
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





// [诊断用] 把瓦片归到一个粗粒度族，用来区分"跨族差异"（真问题）与"族内互换"
// （镜像地图本来就该换到反方向的那一片，属于正确镜像）。
static int diagTileFamily(const RandomMapGenerator& rmg, int tile)
{
    const RandomMapGenerator::TileSets s = rmg.GetTileSets();
    if (tile >= s.water          && tile < s.water + 14)          return 1;
    if (s.shorePieces >= 0 && tile >= s.shorePieces && tile < s.shorePieces + 42) return 2;
    if (s.shoreTile   >= 0 && tile >= s.shoreTile   && tile < s.shoreTile + 40)   return 3;
    if (s.waterCliffs >= 0 && tile >= s.waterCliffs && tile < s.waterCliffs + 28) return 4;
    // 这些段（Sand/Grass/Rough 的 Individual 变体）都有十几个偏移，窗口给宽一点，
    // 否则同段内的正常互换会被误判成"跨族"（实测过：495 与 502 同属 Sand Individual）。
    if (s.greenTile   >= 0 && tile >= s.greenTile   && tile < s.greenTile + 32)   return 5;
    if (s.roughTile   >= 0 && tile >= s.roughTile   && tile < s.roughTile + 32)   return 6;
    if (s.sandTile    >= 0 && tile >= s.sandTile    && tile < s.sandTile + 32)    return 7;
    if (s.rampBase    >= 0 && tile >= s.rampBase    && tile < s.rampBase + 20)    return 8;
    if (s.rampSmooth  >= 0 && tile >= s.rampSmooth  && tile < s.rampSmooth + 12)  return 9;
    return 0;
}

// --diag-symmetry: after each stage, count the mirrored pairs that disagree about
// the elevation, the land/water marker, the tile or the Height.  A symmetric map needs
// all four at zero; whichever stage raises one is the one that broke it.  Off by
// default, so it never changes a normal run's output.
static void diagSymmetry(RandomMapGenerator& rmg, const MapGenConfig& cfg, const char* stage)
{
    if (cfg.symmetry == mg::MapSymmetry::None) return;
    // [诊断用] The family bases the classifier below needs, once per run: without
    // them a tile number cannot be attributed to a family by hand.
    static bool dumped = false;
    if (!dumped)
    {
        dumped = true;
        const RandomMapGenerator::TileSets s = rmg.GetTileSets();
        std::fprintf(stderr,
                     "[diag-sets] water=%d shorePieces=%d shoreTile=%d waterCliffs=%d "
                     "green=%d rough=%d sand=%d rampBase=%d rampSmooth=%d\n",
                     s.water, s.shorePieces, s.shoreTile, s.waterCliffs, s.greenTile,
                     s.roughTile, s.sandTile, s.rampBase, s.rampSmooth);
    }
    const MapSizeResult ms = RandomMapGenerator::CalcMapSize(cfg);
    MapCell* const* slots = rmg.GetCellSlots();
    const int rows = rmg.GetSlotRows();
    long long pairs = 0, lvlBad = 0, markerBad = 0, tileDiff = 0, subDiff = 0;
    long long slopeBad = 0;
    long long crossFam = 0;
    std::map<std::pair<int, int>, long long> slopePairs;
    for (int y = 0; y < rows; ++y)
    {
        for (int x = 0; x < 512; ++x)
        {
            MapCell* a = slots[512 * y + x];
            if (a == nullptr) continue;
            int mx = 0, my = 0;
            if (!mg::MirrorCell(ms.mapWidth, ms.mapHeight, cfg.symmetry, x, y, &mx, &my)) continue;
            if (!(x < mx || (x == mx && y < my))) continue;
            MapCell* b = slots[512 * my + mx];
            if (b == nullptr) continue;
            ++pairs;
            if (a->Level != b->Level) ++lvlBad;
            if ((a->IsoTileTypeIndex == 0) != (b->IsoTileTypeIndex == 0)) ++markerBad;
            // [诊断用] 镜像格的瓦片号 / 片内偏移是否一致。注意这**不是**对称的正确判据
            // （镜像半场本来就该拿"镜像件"，瓦片号可以不同），这里只是用来定位"差异第一次
            // 出现在哪个阶段" —— 数字跳变的那一步就是源头。
            if (a->IsoTileTypeIndex != b->IsoTileTypeIndex)
            {
                ++tileDiff;
                const int fa = diagTileFamily(rmg, a->IsoTileTypeIndex);
                const int fb = diagTileFamily(rmg, b->IsoTileTypeIndex);
                if (fa != fb)
                {
                    ++crossFam;                   // 跨族 = 真的没对上；同族互换 = 正确镜像
                    if (crossFam <= 5)
                        std::fprintf(stderr, "[diag-ex] %s (%d,%d) tile %d (L%d H%d) <-> (%d,%d) tile %d (L%d H%d)\n",
                                     stage, x, y, a->IsoTileTypeIndex, a->Level, a->Height,
                                     mx, my, b->IsoTileTypeIndex, b->Level, b->Height);
                }
            }
            if (a->Height != b->Height) ++subDiff;
            // [诊断用] SlopeIndex 的镜像关系是量出来的，不是猜的：镜像格的斜坡件由引擎自己
            // 按**转置后的角值**选出来，所以两半的 SlopeIndex 满足角值模式的转置关系 ——
            // 实测主组合是 1<->2、3<->4、6<->8、10<->12（下面的直方图直接打印）。
            // mg::ReflectSlope 描述的是另一件事（斜坡平滑那两个探测位的互换：1<->3、2<->4），
            // 复制路径用它。两者不是同一个关系，所以这里两个都量，别把 slopeBad 当成缺陷数。
            if (b->SlopeIndex != mg::ReflectSlope(cfg.symmetry, a->SlopeIndex))
                ++slopeBad;
            if (a->SlopeIndex != b->SlopeIndex)
                ++slopePairs[std::make_pair(a->SlopeIndex, b->SlopeIndex)];
            // The TILE is deliberately not compared for equality: a mirrored map is
            // supposed to give the image cell the MIRRORED piece, which is a different
            // tile index, so "tile indices equal" is the wrong expectation and an
            // earlier version of this probe was misled by it.  Level and the
            // land/water marker are orientation-free and must match exactly.
        }
    }
    std::fprintf(stderr,
                 "[diag] %-24s pairs=%lld levelBad=%lld markerBad=%lld slopeBad=%lld "
                 "tileDiff=%lld crossFam=%lld subDiff=%lld\n",
                 stage, pairs, lvlBad, markerBad, slopeBad, tileDiff, crossFam, subDiff);
    if (!slopePairs.empty())
    {
        // [诊断用] SlopeIndex 的镜像关系只能从数据里读出来：镜像格的斜坡件是引擎按
        // 转置后的角值自己选出来的，所以"a 的镜像应该是几"不是猜出来的，是这对直方图
        // 给出的。前 6 个组合足够看清主关系。
        std::fprintf(stderr, "[diag-slopes] %s pairs whose SlopeIndex differs (top 6):",
                     stage);
        std::vector<std::pair<long long, std::pair<int, int> > > top;
        for (std::map<std::pair<int, int>, long long>::const_iterator it =
                 slopePairs.begin(); it != slopePairs.end(); ++it)
            top.push_back(std::make_pair(it->second, it->first));
        std::sort(top.begin(), top.end(),
                  [](const std::pair<long long, std::pair<int, int> >& l,
                     const std::pair<long long, std::pair<int, int> >& r)
                  { return l.first > r.first; });
        for (size_t i = 0; i < top.size() && i < 6; ++i)
            std::fprintf(stderr, " %d<->%d x%lld", top[i].second.first,
                         top[i].second.second, top[i].first);
        std::fprintf(stderr, " (of %lld pairs)\n", pairs);
    }
}

int main(int argc, char** argv)
{
    std::string root;
    std::string out = "oracle.map";
    int land = 1, theater = 0, time = 0, players = 2, ore = 1, water = -1;
    bool diagSym = false;
    // [诊断用] Run CreateHills one sub-step at a time instead of in one call, so
    // --diag-symmetry can print the divergence after each of the ten steps and the
    // one that first moves the two halves apart is visible instead of inferred.
    bool diagHills = false;
    // [诊断用] Write the map after one named stage and stop there, so a render of
    // every intermediate state can say WHICH stage leaves a height step without art
    // covering it (see docs in verify_symmetry.py / mirror.h).  Empty = run to the end.
    std::string stopAfter;
    double size = 1.0;
    int width = 0, height = 0;   // explicit rectangle, overrides --size when both > 0
    unsigned seed = 1, mapSeed = 0;
    bool single = false;
    bool sizeRange = false;
    int symmetry = 0;            // 0 = none; see engine/src/mirror.h

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
        else if (a == "--diag-symmetry") diagSym = true;
        else if (a == "--diag-hills") diagHills = true;
        else if (a == "--stop-after") stopAfter = next();
        else if (a == "--seed") seed = static_cast<unsigned>(std::strtoul(next(), nullptr, 0));
        else if (a == "--map-seed") mapSeed = static_cast<unsigned>(std::strtoul(next(), nullptr, 0));
        else if (a == "--single") single = true;
        else if (a == "--symmetry") symmetry = std::atoi(next());
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
    // --symmetry is range-checked here rather than passed through: an out-of-range
    // value would otherwise reach MirrorMap as an unknown enum and be refused
    // there, after the whole map had been generated.  The bound is the
    // IMPLEMENTED maximum (engine/src/mirror.h), so a kind that is derived and
    // tested but not yet applied is refused up front in both drivers, and phase 2
    // only has to move that one constant.
    if (symmetry < 0 || symmetry > mg::kMapSymmetryImplementedMax)
    {
        std::fprintf(stderr, "[mgconsole] --symmetry %d: only 0..%d is implemented "
                     "(see engine/src/mirror.h)\n",
                     symmetry, mg::kMapSymmetryImplementedMax);
        return 2;
    }
    cfg.symmetry = static_cast<mg::MapSymmetry>(symmetry);

    cfg.global = rmg.RollGlobalOptions(seed ? seed : GetTickCount());
    cfg.randomSeed = static_cast<uint32_t>(cfg.global.seed04C);
    cfg.mapRngSeed = mapSeed;
    cfg.waterAmount = (water >= 0) ? water : cfg.global.waterAmount;

    std::fprintf(stderr, "[mgconsole] land=%d theater=%d time=%d size=%.3f players=%d ore=%d water=%d seed=%u\n",
                 land, theater, time, size, players, ore, cfg.waterAmount, seed);

    // --width and --height are ONE input, not two independent ones: the engine
    // reads them as a pair (MapGenConfig::widthCells/heightCells, and CalcMapSize
    // uses them only when both are positive).  A lone --width therefore used to be
    // dropped in silence -- the map came out at the slider's size, exit 0, no
    // warning anywhere -- which is the same class of silent fallback the workSide
    // refusal below exists to prevent.  Say so instead of guessing.
    if (width < 0 || height < 0)
    {
        std::fprintf(stderr,
            "[mgconsole] --width/--height must be positive (got %d and %d); a visible "
            "side of 0 or less would be read as \"use the size slider\"\n",
            width, height);
        return 2;
    }
    if ((width > 0) != (height > 0))
    {
        std::fprintf(stderr,
            "[mgconsole] --width and --height must be given together: %s%d alone leaves "
            "the other axis to the size slider, which silently produces a square map "
            "of a different size.  Pass both, or neither (with --size).\n",
            width > 0 ? "--width " : "--height ", width > 0 ? width : height);
        return 2;
    }

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

    // [诊断用] Finish + write, for --stop-after: the writer needs the cells, and
    // Cleanup() keeps them (the normal flow writes after it too).
    const auto emit = [&]() -> int
    {
        rmg.Cleanup();                                    // 0x5993A5
        rmg.ComputeRadarImage();                          // 0x599451
        rmg.Done();                                       // 0x59947E
        const std::wstring w = widen(out);
        if (!rmg.SaveMapFile(w.c_str()))
        {
            std::fprintf(stderr, "[mgconsole] SaveMapFile failed\n");
            return 4;
        }
        std::fprintf(stderr, "[mgconsole] wrote %s (stopped after %s)\n",
                     out.c_str(), stopAfter.c_str());
        return 0;
    };
    const auto stopHere = [&](const char* stage) -> bool
    {
        if (stopAfter.empty() || stopAfter != stage)
            return false;
        return true;
    };

    // ---- the pipeline, in WinMain.cpp's order -----------------------------
    if (!rmg.GenerateMapBody(cfg))                       // sub_599650
    {
        std::fprintf(stderr, "[mgconsole] GenerateMapBody failed\n");
        return 3;
    }

    if (cfg.landType == LandType::Inland || cfg.landType == LandType::Mountainous)  // 0x598aed
    {
        if (rmg.GetWaterAmount() != 0) rmg.GenerateSpecialTerrain();  // sub_59C580
        // [移植侧] 内陆 / 山地：河湖挖完才把半场复制过去（见 MapGenSymmetry.cpp）。
        if (!rmg.MirrorSpecialTerrain(cfg.symmetry))
        {
            std::fprintf(stderr, "[mgconsole] MirrorSpecialTerrain failed\n");
            return 8;
        }
        if (diagSym) diagSymmetry(rmg, cfg, "after MirrorSpecialTerrain");
        if (stopHere("special")) return emit();
    }
    else
    {
        rmg.GenerateTerrain();                            // sub_59A6C0
    }

    if (stopHere("terrain")) return emit();
    rmg.DecorateWaterTiles();                             // 0x598b14  sub_59C630
    if (stopHere("water")) return emit();
    if (diagSym) diagSymmetry(rmg, cfg, "after DecorateWaterTiles");
    rmg.InitRegions();                                    // 0x598C24
    rmg.MakeRegions();                                    // 0x598D44
    if (diagSym) diagSymmetry(rmg, cfg, "after MakeRegions");
    if (stopHere("regions")) return emit();
    rmg.RecalculateCellAttributes();                      // 0x598E1F
    rmg.CreateStartingPoints();                           // 0x598E9E
    rmg.AddTechBuildings();                               // 0x598EBF
    rmg.AddTiberium();                                    // 0x598EE5
    // [移植侧] 对称：矿与科技建筑是 RNG 放的，必须在 CreateHills 之前平掉 ——
    // CanHostSlope 读的就是这两样，否则 FinalizeElevationSlopes 会在两半做出不同判断。
    if (!rmg.MirrorOverlays(cfg.symmetry))
    {
        std::fprintf(stderr, "[mgconsole] MirrorOverlays failed\n");
        return 9;
    }
    rmg.RecalculateCellAttributes();                      // 0x598FB8
    rmg.RecalculateCellAttributes();                      // 0x59912A
    // [诊断用] CreateHills' own body, one call at a time (see MapGenHills.cpp).  Two
    // reasons to take this route: --diag-hills (print the mirror divergence after
    // each step) and --stop-after hills:<Step> (write the map there, so each step
    // can be RENDERED - the stage that first paints black is then a measurement
    // rather than an inference).  Without either flag the single call below runs
    // and the map is byte-identical to before.
    const bool splitHills = diagHills || stopAfter.rfind("hills:", 0) == 0;
    if (splitHills)
    {
        const auto step = [&](const char* tag, auto&& fn) -> bool
        {
            fn();
            if (diagSym) diagSymmetry(rmg, cfg, tag);
            return stopHere(tag);
        };
        if (step("hills: MarkTechBuildingProtection", [&] { rmg.MarkTechBuildingProtection(); })) return emit();
        if (step("hills: MarkHillProtection",         [&] { rmg.MarkHillProtection(); }))         return emit();
        if (step("hills: MirrorWorkMarks",            [&] { rmg.MirrorWorkMarks(cfg.symmetry); })) return emit();
        if (step("hills: BuildHillHeightField",       [&] { rmg.BuildHillHeightField(); }))       return emit();
        if (step("hills: BuildElevationGrid",         [&] { rmg.BuildElevationGrid(); }))         return emit();
        if (step("hills: ApplyElevationLevels",       [&] { rmg.ApplyElevationLevels(); }))       return emit();
        if (step("hills: MirrorElevationGrid",        [&] { rmg.MirrorElevationGrid(); }))        return emit();
        if (step("hills: FinalizeElevationSlopes",    [&] { rmg.FinalizeElevationSlopes(); }))    return emit();
        if (step("hills: MergeSlopeBlocks",           [&] { rmg.MergeSlopeBlocks(); }))           return emit();
        if (step("hills: RemoveCliffsOverRamps",      [&] { rmg.RemoveCliffsOverRamps(); }))      return emit();
    }
    else
        rmg.CreateHills();                                // 0x599171
    if (diagSym) diagSymmetry(rmg, cfg, "after CreateHills");
    if (stopHere("hills")) return emit();
    // [诊断用] CreateLATs is four calls in a fixed order; --diag-symmetry runs
    // them one at a time so the probe can say WHICH one breaks the mirror
    // instead of only that the stage as a whole did.  The calls, their order and
    // their arguments are exactly what CreateLATs does, so this path produces
    // the same map - it is only taken when the flag is on.  (Without the split,
    // "after CreateLATs" is the first probe that reports a difference at all.)
    if (diagSym)
    {
        rmg.PrepareLATDensities();                        // 0x59922B
        diagSymmetry(rmg, cfg, "lat: PrepareLATDensities");
        rmg.ScatterLATBlobs();                            // 0x599232
        diagSymmetry(rmg, cfg, "lat: ScatterLATBlobs");
        rmg.ResetLATDensityFields();                      // 0x59923E
        diagSymmetry(rmg, cfg, "lat: ResetLATDensityFields");
        rmg.ScatterRocks();                               // 0x5992AB
        diagSymmetry(rmg, cfg, "lat: ScatterRocks");
    }
    else
    {
        rmg.CreateLATs();                                 // 0x599215
    }
    if (diagSym) diagSymmetry(rmg, cfg, "after CreateLATs");
    if (stopHere("lats")) return emit();
    rmg.RecalculateCellAttributes();                      // 0x599354
    // [port-only] Left-right cliff/RAMP partners (MapGenCliffPartner.cpp).  AFTER
    // the last recalc, because every piece has to exist before the image half can
    // take its partner: cliffs are laid in MakeRegions, the RAMP pieces by the
    // region carver, and the recalc above re-derives tiles from slope indices -
    // measured 2026-10-22: zero cliff cells exist at MirrorSpecialTerrain time, so
    // an earlier hook swaps nothing.  Off unless MG_CLIFF_PARTNER=1.
    rmg.PruneTerrainTrees();                              // port-side, after pass 4
    if (diagSym) diagSymmetry(rmg, cfg, "after PruneTrees");
    if (stopHere("prune")) return emit();
    // [移植侧] 对称镜像。放在 PruneTerrainTrees 之后、Cleanup 之前：所有吃 RNG
    // 与所有出处出自反汇编的阶段都已结束，而 ComputeRadarImage 与写盘都在其后，
    // 雷达与 [Header] 因此自动重算。
    // [port-only] LG2 ramp partners: LAST, because CreateHills stamps three more
    // SlopeSetPieces per ramp and those come out same-kind on both halves too.  Off
    // unless MG_CLIFF_PARTNER=1.
    if (!rmg.MirrorMap(cfg.symmetry))
    {
        std::fprintf(stderr, "[mgconsole] MirrorMap failed\n");
        return 6;
    }
    // [port-only] LG2 ramp partners AFTER MirrorMap: MirrorMap rewrites the mirrored
    // half's art from the shape, so a partner written before it does not survive
    // (measured 2026-10-22: 40/0 right before MirrorMap, 32/8 after).  Placed last, the
    // pair relation stands in the file.  Off unless MG_CLIFF_PARTNER=1.
    rmg.MirrorCliffPartners();
    if (stopHere("mirror")) return emit();
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
