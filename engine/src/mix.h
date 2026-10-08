// RA2/YR MIX archive reader -- nested archives, hash lookup, encrypted headers.
//
// Spec source: the verified Python reader `maptools/mix_file.py`, itself a port
// of the bundled reference implementation (data/_mix_tools/MixExtract.cs).  The
// C++ side is checked byte-for-byte against the Python side by
// `tools/verify_mix.py`, which is the acceptance test for this layer.
//
// Facts established against the real install:
//   * ra2.mix / ra2md.mix / language.mix / expandmd01.mix all have ENCRYPTED
//     headers (signature 0x00030000); langmd.mix does not (0x00010000).
//   * The files the generator needs are one level deeper than the top archive:
//     rulesmd.ini / artmd.ini / temperatmd.ini / rmgmd.ini live in
//     ra2md.mix -> localmd.mix, and temperat.pal in ra2.mix -> cache.mix.
//     Nested support is therefore mandatory, not a nicety.
//   * MIX entries are stored RAW.  There is no LZO step here; LZO belongs to
//     the map's IsoMapPack5 payload, not to the archive format.
//
// Only the header/index is held in memory.  Entry payload is read on demand
// through the ByteSource, because ra2.mix alone is 269 MB.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "byte_source.h"

namespace mg {

// One index record.  The retail index stores only the 32-bit name hash.
struct MixEntry
{
    std::uint32_t hash = 0;
    std::uint32_t offset = 0;  // relative to the archive's data start
    std::uint32_t size = 0;
};

class MixArchive
{
public:
    // Never throws; check ok() / error().  `src` may be null.
    static MixArchive parse(std::shared_ptr<ByteSource> src, std::string path = {});

    // Parse a nested member of `parent` as a standalone archive.
    static MixArchive parseNested(const MixArchive& parent, const MixEntry& entry,
                                  const std::string& label);

    bool ok() const { return error_.empty(); }
    const std::string& error() const { return error_; }
    const std::string& path() const { return path_; }

    std::uint32_t signature() const { return signature_; }
    bool encrypted() const { return encrypted_; }
    bool cncStyle() const { return cncStyle_; }
    std::size_t dataStart() const { return dataStart_; }
    std::size_t dataSize() const { return dataSize_; }
    std::size_t sourceSize() const { return source_ ? source_->size() : 0; }
    const std::vector<MixEntry>& entries() const { return entries_; }
    const std::shared_ptr<ByteSource>& source() const { return source_; }

    // Name resolution via the optional "local mix database.dat" carried inside
    // the archive.  Names are advisory: lookup is always by hash.
    void loadNameDatabase();
    const std::string* nameOf(std::uint32_t hash) const;
    std::vector<std::pair<std::string, MixEntry>> namedEntries() const;

    const MixEntry* findByHash(std::uint32_t hash) const;
    const MixEntry* find(const std::string& name) const;

    // Raw blob for an entry, or empty when out of range.
    std::vector<std::uint8_t> readEntry(const MixEntry& entry) const;
    std::vector<std::uint8_t> read(const std::string& name) const;

    // Every entry that is itself a MIX archive (by name), parsed.
    std::vector<MixArchive> nested() const;

private:
    std::shared_ptr<ByteSource> source_;
    std::string path_;
    std::string error_;
    std::uint32_t signature_ = 0;
    bool encrypted_ = false;
    bool cncStyle_ = false;
    std::size_t dataStart_ = 0;
    std::size_t dataSize_ = 0;
    std::vector<MixEntry> entries_;
    std::map<std::uint32_t, MixEntry> index_;
    std::map<std::uint32_t, std::string> names_;
};

}  // namespace mg
