// MIX filename hashing and CRC-32.
//
// Spec source: the verified Python reader `maptools/mix_file.py` (crc32 /
// hash_filename), which in turn ports the bundled reference implementation
// (data/_mix_tools/CRC32.cs + MixExtract.HashFilename).  The MIX index stores
// only these 32-bit hashes, never file names, so this is the key that opens
// every lookup.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace mg {

namespace detail {

// Standard reflected CRC-32 table (polynomial 0xEDB88320), built at compile
// time so the translation unit carries no 1 KiB literal.
struct Crc32Table
{
    std::uint32_t v[256];
    constexpr Crc32Table() : v{}
    {
        for (std::uint32_t i = 0; i < 256; ++i)
        {
            std::uint32_t c = i;
            for (int k = 0; k < 8; ++k)
                c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
            v[i] = c;
        }
    }
};

inline constexpr Crc32Table kCrc32Table{};

}  // namespace detail

// Reflected CRC-32 with init 0xFFFFFFFF and a final xor -- the same value
// zlib.crc32() returns, which is what the Python reader uses.
inline std::uint32_t crc32(const void* data, std::size_t len,
                           std::uint32_t seed = 0)
{
    const auto* p = static_cast<const unsigned char*>(data);
    std::uint32_t c = ~seed;
    for (std::size_t i = 0; i < len; ++i)
        c = detail::kCrc32Table.v[(c ^ p[i]) & 0xFFu] ^ (c >> 8);
    return ~c;
}

// MIX index hash for one file name (MixExtract.HashFilename).
//
// The name is upper-cased, then padded to a multiple of four: first the length
// remainder as a raw character code, then copies of the character at the start
// of the last complete quarter.  That last rule is a quirk of the original --
// padding with zeros instead produces a different hash and every lookup misses.
inline std::uint32_t hashFilename(const std::string& filename)
{
    std::string name;
    name.reserve(filename.size() + 4);
    for (char ch : filename)
    {
        const unsigned char u = static_cast<unsigned char>(ch);
        if (u >= 0x80)
        {
            // Encoding.ASCII.GetBytes substitutes '?' for non-ASCII.
            name.push_back('?');
        }
        else if (u >= 'a' && u <= 'z')
        {
            name.push_back(static_cast<char>(u - 32));
        }
        else
        {
            name.push_back(static_cast<char>(u));
        }
    }

    const std::size_t length = name.size();
    const std::size_t quarter = length >> 2;
    if (length & 3u)
    {
        name.push_back(static_cast<char>(length - (quarter << 2)));
        for (std::size_t pad = 3 - (length & 3u); pad; --pad)
            name.push_back(name[quarter << 2]);
    }
    return crc32(name.data(), name.size());
}

}  // namespace mg
