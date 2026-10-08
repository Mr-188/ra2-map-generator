// Extract the file set the generator needs out of the retail MIX archives.
//
// The reference implementation reads only LOOSE files: it looks for
// RULESMD.INI / ARTMD.INI / TEMPERATMD.INI / RMGMD.INI next to its executable
// and for the theater's TMP tiles under `..\..\Tile资源\<theater>\`.  Rather
// than intercepting its file calls with a MIX-aware shim, we materialise that
// exact layout once and let the algorithm run unmodified.  The directory can be
// reused across generations, and under Emscripten the same layout is created in
// MEMFS so nothing touches the player's disk.
//
// Layout produced under `root` (mirrors the reference repository, which is the
// layout its author verified):
//
//   <root>/x64/Release/<synthetic exe name>   -- what GetModuleFileNameW reports
//   <root>/x64/Release/rmgmd.ini              -- requested with no fallback
//   <root>/x64/Release/temperatmd.ini         -- requested with no fallback
//   <root>/x64/Release/rulesmd.ini            -- also searched one level up
//   <root>/x64/Release/artmd.ini
//   <root>/Tile资源/温和/<Name><NN>.tem        -- 838 files for TEMPERATE
//
// Windows INI lookup is case-insensitive but Linux and MEMFS are not, so the
// extractor writes both the upper-case and lower-case spellings of the files
// the 8.3-era code asks for by name.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mg {

// Theater indices the reference implementation models.  Only two have a TMP
// folder in its LoadTileCellAttrs (`温和` for everything but snow, `雪地` for
// snow), so the extractor's tile support stops there as well.
struct TheaterSpec
{
    const char* name;        // "TEMPERATE"
    const char* controlIni;  // "temperatmd.ini"
    const char* tileFolder;  // "温和"  (UTF-8)
    const char* tileExt;     // "tem"
    // Archive chain as (archive file, member) pairs in load order; later wins.
    const char* const (*chain)[2];
    std::size_t chainLen;
};

// Returns nullptr for an index the reference implementation cannot tile.
const TheaterSpec* theaterSpec(int theater);

struct ExtractOptions
{
    std::string gameDir;
    int theater = 1;          // matches the reference's MapGenConfig.theater
    std::string root;         // destination root; created if missing
    std::string exeName = "MapGenerator.exe";
};

struct ExtractReport
{
    bool ok = false;
    std::string error;
    std::vector<std::string> written;   // paths relative to root
    std::vector<std::string> missing;   // requested but absent in the archives
    std::size_t bytes = 0;
};

ExtractReport extractForGenerator(const ExtractOptions& opt);

// Path the generator's GetModuleFileNameW must report so that its
// `..\..\Tile资源\` and `..\..\相关INI\` candidates land inside `root`.
std::string syntheticModulePath(const ExtractOptions& opt);

}  // namespace mg
