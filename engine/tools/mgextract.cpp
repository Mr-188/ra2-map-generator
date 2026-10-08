// mgextract -- materialise the generator's loose-file layout from the retail
// MIX archives.  Verifiable against tools/extract_assets.py, which does the
// same job with the Python reader.
//
//   mgextract --game-dir <RA2 dir> --out <dir> [--theater 0|1] [--exe MapGenerator.exe]
//
// theater 0 = TEMPERATE, 1 = SNOW (the two the reference implementation can
// tile; see engine/src/extract.cpp).
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "extract.h"

int main(int argc, char** argv)
{
    mg::ExtractOptions opt;
    for (int i = 1; i < argc; ++i)
    {
        const std::string a = argv[i];
        auto next = [&](const char* what) -> const char* {
            if (i + 1 >= argc)
            {
                std::fprintf(stderr, "%s needs a value\n", what);
                std::exit(2);
            }
            return argv[++i];
        };
        if (a == "--game-dir") opt.gameDir = next("--game-dir");
        else if (a == "--out") opt.root = next("--out");
        else if (a == "--theater") opt.theater = std::atoi(next("--theater"));
        else if (a == "--exe") opt.exeName = next("--exe");
        else if (a == "-h" || a == "--help")
        {
            std::printf("usage: mgextract --game-dir <RA2 dir> --out <dir> "
                        "[--theater 0|1] [--exe name]\n");
            return 0;
        }
        else
        {
            std::fprintf(stderr, "unknown argument: %s\n", a.c_str());
            return 2;
        }
    }
    if (opt.gameDir.empty() || opt.root.empty())
    {
        std::fprintf(stderr, "usage: mgextract --game-dir <RA2 dir> --out <dir> "
                             "[--theater 0|1]\n");
        return 2;
    }

    const mg::ExtractReport rep = mg::extractForGenerator(opt);
    std::printf("ok=%d\n", rep.ok ? 1 : 0);
    std::printf("exe=%s\n", mg::syntheticModulePath(opt).c_str());
    std::printf("bytes=%zu\n", rep.bytes);
    std::printf("files=%zu\n", rep.written.size());
    for (const std::string& w : rep.written)
        std::printf("  wrote %s\n", w.c_str());
    for (const std::string& m : rep.missing)
        std::printf("  missing %s\n", m.c_str());
    if (!rep.ok)
    {
        std::fprintf(stderr, "extraction failed: %s\n", rep.error.c_str());
        return 1;
    }
    return 0;
}
