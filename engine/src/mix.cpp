// RA2/YR MIX archive reader.  See mix.h for provenance.
#include "mix.h"

#include "blowfish.h"
#include "crc32.h"

#include <algorithm>
#include <cstdio>

namespace mg {
namespace {

constexpr std::uint32_t kMixFlagEncrypted = 0x00020000u;
constexpr std::size_t kKeyblockOffset = 4;
constexpr std::size_t kKeyblockSize = 80;
constexpr std::uint32_t kMaxReasonableFiles = 1u << 20;

std::uint16_t le16(const std::uint8_t* p)
{
    return static_cast<std::uint16_t>(p[0] | (p[1] << 8));
}

std::uint32_t le32(const std::uint8_t* p)
{
    return static_cast<std::uint32_t>(p[0]) |
           (static_cast<std::uint32_t>(p[1]) << 8) |
           (static_cast<std::uint32_t>(p[2]) << 16) |
           (static_cast<std::uint32_t>(p[3]) << 24);
}

// Well-known RA2/YR file names, used to seed hash -> name resolution.  The
// retail index stores only hashes; these plus any "local mix database.dat"
// carried inside the archive are what make listing readable.
const char* const kKnownNames[] = {
    "temperat.ini", "temperatmd.ini", "snow.ini", "snowmd.ini",
    "urban.ini", "urbanmd.ini", "urbann.ini", "urbannmd.ini",
    "desert.ini", "desertmd.ini", "lunar.ini", "lunarmd.ini",
    "rules.ini", "rulesmd.ini", "art.ini", "artmd.ini", "aimd.ini",
    "ai.ini", "ra2.ini", "ra2md.ini",
    "isotemp.mix", "isotemmd.mix", "temperat.mix", "tem.mix",
    "isosnow.mix", "isosnomd.mix", "snow.mix", "sno.mix",
    "isourb.mix", "isourbmd.mix", "urb.mix", "urban.mix",
    "isoubn.mix", "isoubnmd.mix", "ubn.mix", "urbann.mix",
    "isodes.mix", "isodesmd.mix", "des.mix", "desert.mix",
    "isolun.mix", "isolunmd.mix", "lun.mix", "lunar.mix",
    "local.mix", "localmd.mix", "cache.mix", "conquer.mix", "generic.mix",
    "generics.mix", "multimd.mix", "language.mix", "langmd.mix",
    "expand01.mix", "expandmd01.mix", "ra2.mix", "ra2md.mix",
    "key.ini",
    "isotem.pal", "unittem.pal", "temperat.pal", "anim.pal",
    "isosno.pal", "isourb.pal", "isodes.pal", "isolun.pal", "isoubn.pal",
    "unitsno.pal", "uniturb.pal", "unitdes.pal", "unitubn.pal",
    "unitlum.pal", "libpal.pal",
    "local mix database.dat", "tibsun.mix",
};

std::vector<std::string> parseLocalMixDatabase(const std::vector<std::uint8_t>& blob)
{
    if (blob.size() < 8) return {};
    const std::uint32_t a = le32(blob.data());
    const std::uint32_t b = le32(blob.data() + 4);
    for (std::uint32_t count : {b, a})
    {
        if (count == 0 || count > 200000) continue;
        const std::size_t bodyOff = 8;
        std::size_t zeros = 0;
        for (std::size_t i = bodyOff; i < blob.size(); ++i)
            if (blob[i] == 0) ++zeros;
        if (zeros < count) continue;

        std::vector<std::string> names;
        std::size_t pos = bodyOff;
        bool bad = false;
        for (std::uint32_t i = 0; i < count; ++i)
        {
            std::size_t end = pos;
            while (end < blob.size() && blob[end] != 0) ++end;
            if (end >= blob.size()) { bad = true; break; }
            names.emplace_back(reinterpret_cast<const char*>(blob.data() + pos),
                               end - pos);
            pos = end + 1;
        }
        if (!bad && !names.empty()) return names;
    }
    return {};
}

}  // namespace

MixArchive MixArchive::parse(std::shared_ptr<ByteSource> src, std::string path)
{
    MixArchive m;
    m.source_ = std::move(src);
    m.path_ = std::move(path);

    if (!m.source_ || m.source_->size() < 6)
    {
        m.error_ = "file is too short to be a MIX archive";
        return m;
    }
    const std::size_t total = m.source_->size();

    std::uint8_t sig4[4];
    if (!m.source_->read(0, 4, sig4))
    {
        m.error_ = "cannot read the MIX signature";
        return m;
    }
    m.signature_ = le32(sig4);
    // Anything whose low 16 bits are non-zero is the older CNC-style layout
    // where the signature *is* the file count.
    m.cncStyle_ = (m.signature_ & 0xFFFFu) != 0;
    m.encrypted_ = !m.cncStyle_ && (m.signature_ & kMixFlagEncrypted) != 0;

    std::vector<std::uint8_t> header;
    std::uint32_t numFiles = 0;
    std::uint32_t dataSize = 0;

    if (m.cncStyle_)
    {
        numFiles = m.signature_ & 0xFFFFu;
        const std::size_t indexLen = 6 + static_cast<std::size_t>(numFiles) * 12;
        if (total < indexLen)
        {
            m.error_ = "CNC-style MIX index is truncated";
            return m;
        }
        header = m.source_->readVec(0, indexLen);
        if (header.size() < indexLen)
        {
            m.error_ = "CNC-style MIX header read failed";
            return m;
        }
        dataSize = le32(header.data() + 2);
        m.dataStart_ = indexLen;
    }
    else if (m.encrypted_)
    {
        const std::size_t body = kKeyblockOffset + kKeyblockSize;
        if (total < body + 8)
        {
            m.error_ = "encrypted MIX header is truncated";
            return m;
        }
        const std::vector<std::uint8_t> keyblock =
            m.source_->readVec(kKeyblockOffset, kKeyblockSize);
        if (keyblock.size() != kKeyblockSize)
        {
            m.error_ = "cannot read the MIX keyblock";
            return m;
        }
        const std::vector<std::uint8_t> key =
            deriveBlowfishKey(keyblock.data(), keyblock.size());
        if (key.empty())
        {
            m.error_ = "Blowfish key derivation failed";
            return m;
        }
        const Blowfish fish(key.data(), key.size());

        // The first two header words give numFiles.
        const std::vector<std::uint8_t> first8 = m.source_->readVec(body, 8);
        if (first8.size() != 8)
        {
            m.error_ = "cannot read the encrypted header";
            return m;
        }
        std::vector<std::uint32_t> first{le32(first8.data()), le32(first8.data() + 4)};
        const std::vector<std::uint32_t> decFirst = fish.decryptWords(first);
        if (decFirst.empty())
        {
            m.error_ = "Blowfish header decrypt produced no words";
            return m;
        }
        numFiles = decFirst[0] & 0xFFFFu;
        if (numFiles > kMaxReasonableFiles)
        {
            m.error_ = "encrypted header reports an implausible file count";
            return m;
        }

        const std::size_t headerLen =
            (6 + static_cast<std::size_t>(numFiles) * 12 + 7) & ~std::size_t(7);
        if (headerLen == 0 || body + headerLen > total)
        {
            m.error_ = "encrypted MIX header overruns the file";
            return m;
        }
        const std::vector<std::uint8_t> enc = m.source_->readVec(body, headerLen);
        if (enc.size() != headerLen)
        {
            m.error_ = "cannot read the encrypted header body";
            return m;
        }
        std::vector<std::uint32_t> words(headerLen / 4);
        for (std::size_t i = 0; i < words.size(); ++i)
            words[i] = le32(enc.data() + i * 4);
        const std::vector<std::uint32_t> plain = fish.decryptWords(words);
        header.resize(plain.size() * 4);
        for (std::size_t i = 0; i < plain.size(); ++i)
        {
            header[i * 4 + 0] = static_cast<std::uint8_t>(plain[i] & 0xFF);
            header[i * 4 + 1] = static_cast<std::uint8_t>((plain[i] >> 8) & 0xFF);
            header[i * 4 + 2] = static_cast<std::uint8_t>((plain[i] >> 16) & 0xFF);
            header[i * 4 + 3] = static_cast<std::uint8_t>((plain[i] >> 24) & 0xFF);
        }
        m.dataStart_ = body + headerLen;
    }
    else
    {
        const std::vector<std::uint8_t> head6 = m.source_->readVec(4, 6);
        if (head6.size() != 6)
        {
            m.error_ = "MIX header is truncated";
            return m;
        }
        numFiles = le16(head6.data());
        dataSize = le32(head6.data() + 2);
        const std::size_t indexLen = 6 + static_cast<std::size_t>(numFiles) * 12;
        if (4 + indexLen > total)
        {
            m.error_ = "MIX index is truncated";
            return m;
        }
        header = m.source_->readVec(4, indexLen);
        if (header.size() != indexLen)
        {
            m.error_ = "MIX header read failed";
            return m;
        }
        m.dataStart_ = 4 + indexLen;
    }

    m.dataSize_ = dataSize;
    if (header.size() < 6)
    {
        m.error_ = "MIX header is truncated";
        return m;
    }
    if (!m.cncStyle_) dataSize = le32(header.data() + 2);
    m.dataSize_ = dataSize;

    const std::size_t indexLen = 6 + static_cast<std::size_t>(numFiles) * 12;
    if (header.size() < indexLen)
    {
        m.error_ = "MIX index is truncated";
        return m;
    }
    m.entries_.reserve(numFiles);
    for (std::uint32_t i = 0; i < numFiles; ++i)
    {
        const std::uint8_t* p = header.data() + 6 + static_cast<std::size_t>(i) * 12;
        MixEntry e;
        e.hash = le32(p);
        e.offset = le32(p + 4);
        e.size = le32(p + 8);
        m.entries_.push_back(e);
        m.index_.emplace(e.hash, e);
    }

    if (m.dataStart_ > total)
    {
        m.error_ = "MIX data start lies past the end of the file";
        return m;
    }

    m.loadNameDatabase();
    return m;
}

MixArchive MixArchive::parseNested(const MixArchive& parent, const MixEntry& entry,
                                   const std::string& label)
{
    const std::vector<std::uint8_t> blob = parent.readEntry(entry);
    return MixArchive::parse(std::make_shared<MemorySource>(blob), label);
}

void MixArchive::loadNameDatabase()
{
    for (const char* n : kKnownNames)
        names_.emplace(hashFilename(n), n);

    const MixEntry* e = findByHash(hashFilename("local mix database.dat"));
    if (!e) return;
    const std::vector<std::uint8_t> blob = readEntry(*e);
    for (const std::string& name : parseLocalMixDatabase(blob))
        names_[hashFilename(name)] = name;
}

const std::string* MixArchive::nameOf(std::uint32_t hash) const
{
    const auto it = names_.find(hash);
    return it == names_.end() ? nullptr : &it->second;
}

std::vector<std::pair<std::string, MixEntry>> MixArchive::namedEntries() const
{
    std::vector<std::pair<std::string, MixEntry>> out;
    out.reserve(entries_.size());
    char buf[32];
    for (const MixEntry& e : entries_)
    {
        const std::string* n = nameOf(e.hash);
        if (n) out.emplace_back(*n, e);
        else
        {
            std::snprintf(buf, sizeof(buf), "0x%08X", e.hash);
            out.emplace_back(buf, e);
        }
    }
    std::sort(out.begin(), out.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });
    return out;
}

const MixEntry* MixArchive::findByHash(std::uint32_t hash) const
{
    const auto it = index_.find(hash);
    return it == index_.end() ? nullptr : &it->second;
}

const MixEntry* MixArchive::find(const std::string& name) const
{
    return findByHash(hashFilename(name));
}

std::vector<std::uint8_t> MixArchive::readEntry(const MixEntry& entry) const
{
    if (!source_) return {};
    const std::size_t begin = dataStart_ + entry.offset;
    if (begin > source_->size()) return {};
    if (entry.size > source_->size() - begin) return {};
    return source_->readVec(begin, entry.size);
}

std::vector<std::uint8_t> MixArchive::read(const std::string& name) const
{
    const MixEntry* e = find(name);
    return e ? readEntry(*e) : std::vector<std::uint8_t>{};
}

std::vector<MixArchive> MixArchive::nested() const
{
    std::vector<MixArchive> out;
    for (const MixEntry& e : entries_)
    {
        const std::string* n = nameOf(e.hash);
        if (!n || n->size() < 4) continue;
        if (n->compare(n->size() - 4, 4, ".mix") != 0) continue;
        MixArchive sub = parseNested(*this, e, path_ + ":" + *n);
        if (sub.ok()) out.push_back(std::move(sub));
    }
    return out;
}

}  // namespace mg
