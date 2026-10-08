// MIX -> loose-file extraction.  See extract.h.
#include "extract.h"

#include <cctype>
#include <algorithm>
#include <set>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>

#include "byte_source.h"
#include "ini.h"
#include "mix.h"

#if defined(_WIN32)
#include <direct.h>
#include <sys/stat.h>
#else
#include <sys/stat.h>
#include <sys/types.h>
#endif

namespace mg {
namespace {

// ---- theater chains ------------------------------------------------------
// Only the two theaters the reference can tile.  Source of truth:
// maptools/theater_assets.py THEATER_MIXES (order is the game's load order,
// later members win).
const char* const kTemperateChain[][2] = {
    {"ra2.mix", "isotemp.mix"},
    {"ra2.mix", "temperat.mix"},
    {"ra2md.mix", "isotemmd.mix"},
};
const char* const kSnowChain[][2] = {
    {"ra2.mix", "isosnow.mix"},
    {"ra2.mix", "snow.mix"},
    {"ra2md.mix", "isosnomd.mix"},
};

const TheaterSpec kTheaters[] = {
    {"TEMPERATE", "temperatmd.ini", "\xe6\xb8\xa9\xe5\x92\x8c", "tem",
     kTemperateChain, sizeof(kTemperateChain) / sizeof(kTemperateChain[0])},
    {"SNOW", "snowmd.ini", "\xe9\x9b\xaa\xe5\x9c\xb0", "sno",
     kSnowChain, sizeof(kSnowChain) / sizeof(kSnowChain[0])},
};

// ---- small filesystem helpers -------------------------------------------

bool isDir(const std::string& path)
{
#if defined(_WIN32)
    struct _stat st;
    if (_stat(path.c_str(), &st) != 0) return false;
    return (st.st_mode & _S_IFDIR) != 0;
#else
    struct stat st;
    if (stat(path.c_str(), &st) != 0) return false;
    return S_ISDIR(st.st_mode);
#endif
}

bool makeDir(const std::string& path)
{
#if defined(_WIN32)
    return _mkdir(path.c_str()) == 0;
#else
    return mkdir(path.c_str(), 0755) == 0;
#endif
}

// Recursive mkdir -p; succeeds when the directory already exists.
bool makeDirs(const std::string& path)
{
    if (path.empty()) return false;
    if (isDir(path)) return true;
    std::string partial;
    std::size_t i = 0;
    if (path[0] == '/') { partial = "/"; i = 1; }
    while (i <= path.size())
    {
        const std::size_t slash = path.find('/', i);
        const std::string part = path.substr(i, slash == std::string::npos
                                                   ? std::string::npos
                                                   : slash - i);
        if (!part.empty())
        {
            if (!partial.empty() && partial.back() != '/') partial += '/';
            partial += part;
            if (!isDir(partial)) makeDir(partial);
        }
        if (slash == std::string::npos) break;
        i = slash + 1;
    }
    return isDir(path);
}

bool writeFile(const std::string& path, const std::vector<std::uint8_t>& bytes)
{
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return false;
    const bool ok = bytes.empty() || std::fwrite(bytes.data(), 1, bytes.size(), f) == bytes.size();
    std::fclose(f);
    return ok;
}

// ---- a layered archive search path --------------------------------------

class ArchiveSet
{
public:
    ~ArchiveSet()
    {
        for (auto& p : opened_) p.second.reset();
    }

    // Opens <gameDir>/<archive> once and keeps it; returns null on failure.
    std::shared_ptr<MixArchive> openArchive(const std::string& archive)
    {
        auto it = opened_.find(archive);
        if (it != opened_.end()) return it->second;
        std::shared_ptr<MixArchive> a;
        std::shared_ptr<ByteSource> src = openSource(gameDir_ + "/" + archive);
        if (src)
        {
            auto parsed = std::make_shared<MixArchive>(MixArchive::parse(src, archive));
            if (parsed->ok()) a = parsed;
        }
        opened_.emplace(archive, a);
        return a;
    }

    // Registers one layer.  Empty member means "the archive itself".
    void addLayer(const std::string& gameDir, const std::string& archive,
                  const std::string& member)
    {
        gameDir_ = gameDir;
        std::shared_ptr<MixArchive> top = openArchive(archive);
        if (!top) return;
        if (member.empty())
        {
            layers_.emplace_back(archive, top);
            return;
        }
        const MixEntry* e = top->find(member);
        if (!e) return;
        const std::vector<std::uint8_t> blob = top->readEntry(*e);
        if (blob.empty()) return;
        auto inner = std::make_shared<MixArchive>(
            MixArchive::parse(std::make_shared<MemorySource>(blob),
                              archive + ":" + member));
        if (!inner->ok()) return;
        layers_.emplace_back(archive + ":" + member, inner);
    }

    // Every entry name the layers hold whose name ends with `suffix` (matched
    // case-insensitively).  Ordered and de-duplicated, later layers winning.
    std::vector<std::string> namesEndingWith(const std::string& suffix) const
    {
        std::vector<std::string> out;
        std::map<std::string, bool> seen;   // lower-case name -> true
        for (const auto& layer : layers_)
        {
            for (const auto& kv : layer.second->namedEntries())
            {
                const std::string& n = kv.first;
                if (n.size() < suffix.size()) continue;
                std::string tail = n.substr(n.size() - suffix.size());
                for (char& c : tail) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
                if (tail != suffix) continue;
                std::string low = n;
                for (char& c : low) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
                if (seen.count(low)) continue;
                seen[low] = true;
                out.push_back(n);
            }
        }
        std::sort(out.begin(), out.end());
        return out;
    }

    // Later layers win.
    bool read(const std::string& name, std::vector<std::uint8_t>* out) const
    {
        bool found = false;
        for (const auto& layer : layers_)
        {
            const MixEntry* e = layer.second->find(name);
            if (!e) continue;
            std::vector<std::uint8_t> bytes = layer.second->readEntry(*e);
            if (bytes.empty() && e->size != 0) continue;
            if (out) *out = std::move(bytes);
            found = true;
        }
        return found;
    }

private:
    std::string gameDir_;
    std::map<std::string, std::shared_ptr<MixArchive>> opened_;
    std::vector<std::pair<std::string, std::shared_ptr<MixArchive>>> layers_;
};

}  // namespace

const TheaterSpec* theaterSpec(int theater)
{
    if (theater == 0) return &kTheaters[0];
    if (theater == 1) return &kTheaters[1];
    return nullptr;
}

std::string syntheticModulePath(const ExtractOptions& opt)
{
    return opt.root + "/x64/Release/" + opt.exeName;
}

ExtractReport extractForGenerator(const ExtractOptions& opt)
{
    ExtractReport rep;

    const TheaterSpec* spec = theaterSpec(opt.theater);
    if (!spec)
    {
        rep.error = "the reference implementation cannot tile this theater index";
        return rep;
    }
    if (opt.gameDir.empty() || opt.root.empty())
    {
        rep.error = "gameDir and root are required";
        return rep;
    }
    if (!isDir(opt.gameDir))
    {
        rep.error = "game directory does not exist: " + opt.gameDir;
        return rep;
    }
    if (!makeDirs(opt.root))
    {
        rep.error = "cannot create output root: " + opt.root;
        return rep;
    }

    const std::string exeDir = opt.root + "/x64/Release";
    const std::string tileDir = opt.root + "/Tile资源/" + spec->tileFolder;
    if (!makeDirs(exeDir) || !makeDirs(tileDir))
    {
        rep.error = "cannot create the extraction layout under " + opt.root;
        return rep;
    }

    // ---- common layers: the INIs -----------------------------------------
    // Order is the game's: the base rules first, the expansion archive after,
    // so expandmd01.mix's copies win.
    ArchiveSet common;
    common.addLayer(opt.gameDir, "ra2md.mix", "localmd.mix");
    common.addLayer(opt.gameDir, "expandmd01.mix", "");

    auto emit = [&](const std::string& dir, const std::string& name,
                    const std::vector<std::uint8_t>& bytes,
                    const std::string& relative) -> bool {
        if (bytes.empty()) return false;
        if (!writeFile(dir + "/" + name, bytes)) return false;
        rep.written.push_back(relative);
        rep.bytes += bytes.size();
        return true;
    };

    // rulesmd.ini / artmd.ini: the reference searches the exe dir first, so
    // landing them there is enough and avoids depending on `相关INI\`.
    const char* const kIniNames[] = {"rulesmd.ini", "artmd.ini", spec->controlIni, "rmgmd.ini"};
    for (const char* name : kIniNames)
    {
        std::vector<std::uint8_t> bytes;
        if (!common.read(name, &bytes))
        {
            rep.missing.push_back(name);
            continue;
        }
        // The generator asks for these two in upper case with no fallback.
        std::string upper;
        for (const char* p = name; *p; ++p)
            upper.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(*p))));
        emit(exeDir, upper, bytes, std::string("x64/Release/") + upper);
        if (upper != name) emit(exeDir, name, bytes, std::string("x64/Release/") + name);
    }

    // ---- palettes and the voxel palette --------------------------------
    // A renderer needs these alongside the tiles: the theater palette colours
    // every .tem, unit/isotem palettes handle remaps, and voxels.vpl is looked
    // up while setting the VFS up.  All are small.
    {
        struct Extra { const char* archive; const char* member; const char* name; };
        static const Extra kExtras[] = {
            {"ra2.mix",   "cache.mix",             "temperat.pal"},
            {"ra2.mix",   "cache.mix",             "isotem.pal"},
            {"ra2.mix",   "cache.mix",             "unittem.pal"},
            {"ra2.mix",   "cache.mix",             "anim.pal"},
            {"ra2md.mix", "localmd.mix",           "voxels.vpl"},
        };
        for (const Extra& e : kExtras)
        {
            std::shared_ptr<ByteSource> src = openSource(opt.gameDir + "/" + e.archive);
            if (!src) continue;
            MixArchive top = MixArchive::parse(src, e.archive);
            if (!top.ok()) continue;
            const MixEntry* inner = top.find(e.member);
            if (!inner) continue;
            const std::vector<std::uint8_t> blob = top.readEntry(*inner);
            if (blob.empty()) continue;
            MixArchive sub = MixArchive::parse(std::make_shared<MemorySource>(blob), e.member);
            if (!sub.ok()) continue;
            const MixEntry* file = sub.find(e.name);
            if (!file) continue;
            const std::vector<std::uint8_t> bytes = sub.readEntry(*file);
            if (bytes.empty()) continue;
            emit(exeDir, e.name, bytes, std::string("x64/Release/") + e.name);
            rep.bytes += bytes.size();
        }
    }

    // artmd.ini is needed again below: it is how object art is discovered.
    std::vector<std::uint8_t> artBytes;
    common.read("artmd.ini", &artBytes);

    // ---- the theater's tiles ---------------------------------------------
    // Which TMPs a theater uses is declared by its control INI: every
    // [TileSetNNNN] names a base file and a tile count, and the tiles are
    // <Name><NN>.<ext>.
    std::vector<std::uint8_t> iniBytes;
    if (!common.read(spec->controlIni, &iniBytes))
    {
        rep.error = std::string("theater control INI not found in the archives: ")
                    + spec->controlIni;
        return rep;
    }
    const IniFile ini = IniFile::parse(iniBytes);

    ArchiveSet theaterSet;
    for (std::size_t i = 0; i < spec->chainLen; ++i)
        theaterSet.addLayer(opt.gameDir, spec->chain[i][0], spec->chain[i][1]);

    std::size_t tiles = 0;
    std::size_t tileBytes = 0;
    std::size_t tileMissing = 0;
    std::set<std::string> written;   // lower-cased names already emitted
    for (const std::string& section : ini.sectionNames())
    {
        if (section.size() < 7 || section.compare(0, 7, "TileSet") != 0) continue;
        const int count = ini.getInt(section, "TilesInSet", 0);
        if (count <= 0) continue;
        const std::string base = ini.getString(section, "FileName", "");
        if (base.empty()) continue;

        for (int k = 0; k < count; ++k)
        {
            char suffix[16];
            std::snprintf(suffix, sizeof(suffix), "%02d", k + 1);
            const std::string stem = base + suffix;

            // Each tile index has a base name plus optional randomised variants
            // `a`..`z`, and the scan STOPS at the first name that is absent --
            // TileCollection.LoadTileSets in CNCMaps does exactly this, and the
            // "clear01a/b/c/d" files in the archives are what it is looking for.
            bool anyForThisIndex = false;
            for (char variant = '`'; variant <= 'z'; ++variant)
            {
                std::string name = stem;
                if (variant >= 'a') name.push_back(variant);
                name += ".";
                name += spec->tileExt;

                // Several [TileSetNNNN] sections can share one FileName (the
                // temperate INI lists FileName=blank 19 times), so a name may be
                // reached more than once.  Skipping repeats keeps the reported
                // count equal to the number of files actually on disk.
                std::string low = name;
                for (char& c : low) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
                if (written.count(low)) continue;

                std::vector<std::uint8_t> bytes;
                if (!theaterSet.read(name, &bytes) || bytes.empty())
                {
                    if (variant == '`') { ++tileMissing; }
                    break;   // first gap ends this index
                }
                if (!writeFile(tileDir + "/" + name, bytes)) continue;
                written.insert(low);
                ++tiles;
                tileBytes += bytes.size();
                anyForThisIndex = true;
            }
            (void)anyForThisIndex;
        }
    }

    // ---- object art the theater INI does not list --------------------------
    // Trees, ore, gems, rocks, walls and tunnel tops are drawn from .tem files
    // that live in the same theater archives as the tiles but appear in no
    // [TileSetNNNN].  They are reached through artmd.ini: every object section
    // names its art either explicitly with Image= or implicitly by its own
    // section name.  Without this a renderer is short of ~10% of its tiles --
    // 761 wanted versus 697 found on a temperate map.
    std::size_t art = 0;
    std::size_t artBytesWritten = 0;
    if (!artBytes.empty())
    {
        const IniFile artIni = IniFile::parse(artBytes);
        for (const std::string& section : artIni.sectionNames())
        {
            std::string image = artIni.getString(section, "Image", "");
            if (image.empty()) image = section;
            const std::string name = image + "." + spec->tileExt;

            std::string low = name;
            for (char& c : low) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            if (written.count(low)) continue;

            std::vector<std::uint8_t> bytes;
            if (!theaterSet.read(name, &bytes) || bytes.empty()) continue;
            if (!writeFile(tileDir + "/" + name, bytes)) continue;
            written.insert(low);
            ++art;
            artBytesWritten += bytes.size();
        }
    }
    tiles += art;
    tileBytes += artBytesWritten;


    rep.bytes += tileBytes;
    if (tiles == 0)
    {
        rep.error = "no theater tiles could be extracted";
        return rep;
    }
    if (tileMissing)
    {
        char buf[96];
        std::snprintf(buf, sizeof(buf), "%zu theater tiles absent from the archives",
                      tileMissing);
        rep.missing.push_back(buf);
    }
    rep.written.push_back("Tile资源/" + std::string(spec->tileFolder) + "/*" +
                          spec->tileExt + " (" + std::to_string(tiles) + " files, " +
                          std::to_string(art) + " of them object art)");
    rep.ok = true;
    return rep;
}

}  // namespace mg
