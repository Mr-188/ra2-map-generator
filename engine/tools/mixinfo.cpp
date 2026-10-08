// mixinfo -- the verification CLI for the C++ MIX layer.
//
// Its whole purpose is to be checkable against the Python reader: for a given
// archive it prints the same header facts `maptools/mix_file.py` prints, and
// for a given member it writes the same bytes.  tools/verify_mix.py drives both
// sides and compares, so a mismatch is a bug in this layer, not a judgement
// call.
//
//   mixinfo info    <archive>
//   mixinfo list    <archive>
//   mixinfo extract <archive> <member> <outfile>
//   mixinfo layered <archive> <inner.mix> <member> <outfile>
//   mixinfo hash    <name>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "byte_source.h"
#include "crc32.h"
#include "mix.h"

namespace {

int writeWholeFile(const std::string& path, const std::vector<std::uint8_t>& data)
{
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return 1;
    if (!data.empty()) std::fwrite(data.data(), 1, data.size(), f);
    std::fclose(f);
    return 0;
}

int usage()
{
    std::fprintf(stderr,
        "usage:\n"
        "  mixinfo info    <archive>\n"
        "  mixinfo list    <archive>\n"
        "  mixinfo extract <archive> <member> <outfile>\n"
        "  mixinfo layered <archive> <inner.mix> <member> <outfile>\n"
        "  mixinfo hash    <name>\n");
    return 2;
}

}  // namespace

int main(int argc, char** argv)
{
    if (argc < 3) return usage();
    const std::string cmd = argv[1];

    if (cmd == "hash")
    {
        std::printf("0x%08X\n", mg::hashFilename(argv[2]));
        return 0;
    }

    const std::string archivePath = argv[2];
    std::shared_ptr<mg::FileSource> src = mg::FileSource::open(archivePath);
    if (!src)
    {
        std::fprintf(stderr, "cannot read %s\n", archivePath.c_str());
        return 1;
    }

    mg::MixArchive a = mg::MixArchive::parse(src, archivePath);
    if (!a.ok())
    {
        std::fprintf(stderr, "MIX parse failed: %s\n", a.error().c_str());
        return 1;
    }

    if (cmd == "info")
    {
        std::printf("path=%s\n", a.path().c_str());
        std::printf("signature=0x%08X\n", a.signature());
        std::printf("encrypted=%d\n", a.encrypted() ? 1 : 0);
        std::printf("cncStyle=%d\n", a.cncStyle() ? 1 : 0);
        std::printf("numFiles=%zu\n", a.entries().size());
        std::printf("dataSize=%zu\n", a.dataSize());
        std::printf("dataStart=%zu\n", a.dataStart());
        return 0;
    }

    if (cmd == "list")
    {
        for (const auto& kv : a.namedEntries())
            std::printf("%-32s hash=0x%08X off=%-10u size=%u\n", kv.first.c_str(),
                        kv.second.hash, kv.second.offset, kv.second.size);
        return 0;
    }

    if (cmd == "extract")
    {
        if (argc < 5) return usage();
        const std::vector<std::uint8_t> blob = a.read(argv[3]);
        if (blob.empty())
        {
            std::fprintf(stderr, "member not found or empty: %s\n", argv[3]);
            return 1;
        }
        if (writeWholeFile(argv[4], blob) != 0) return 1;
        std::fprintf(stderr, "wrote %s (%zu bytes)\n", argv[4], blob.size());
        return 0;
    }

    if (cmd == "layered")
    {
        if (argc < 6) return usage();
        const mg::MixEntry* innerEntry = a.find(argv[3]);
        if (!innerEntry)
        {
            std::fprintf(stderr, "inner archive not found: %s\n", argv[3]);
            return 1;
        }
        mg::MixArchive inner =
            mg::MixArchive::parseNested(a, *innerEntry, archivePath + ":" + argv[3]);
        if (!inner.ok())
        {
            std::fprintf(stderr, "inner MIX parse failed: %s\n", inner.error().c_str());
            return 1;
        }
        const std::vector<std::uint8_t> blob = inner.read(argv[4]);
        if (blob.empty())
        {
            std::fprintf(stderr, "member not found in %s: %s\n", argv[3], argv[4]);
            return 1;
        }
        if (writeWholeFile(argv[5], blob) != 0) return 1;
        std::fprintf(stderr, "wrote %s (%zu bytes) from %s:%s\n", argv[5], blob.size(),
                     argv[3], argv[4]);
        return 0;
    }

    return usage();
}
