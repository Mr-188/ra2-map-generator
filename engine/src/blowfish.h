// Blowfish in the "Westwood MIX header" configuration.
//
// Spec source: the verified Python reader `maptools/mix_file.py` (class
// Blowfish), itself a literal port of the bundled reference implementation
// (data/_mix_tools/Blowfish.cs).  Two things about it are easy to get wrong and
// both are reproduced here verbatim:
//
//   * The archive stores header words little-endian while the cipher works on
//     big-endian words, so every uint32 is byte-swapped on the way in AND on the
//     way out (SwapBytes in the original RunCipher).
//   * encrypt_block/decrypt_block return their two words in a *swapped* order
//     relative to the iteration variables (see the `return _b .., _a` in the
//     Python).  Swapping them back "to be tidy" breaks the key schedule.
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace mg {

class Blowfish
{
public:
    // Key schedule; key must not be empty.
    explicit Blowfish(const std::uint8_t* key, std::size_t keyLen);

    // One 64-bit block.  Both return (a, b) in the original's swapped order.
    void encryptBlock(std::uint32_t& a, std::uint32_t& b) const;
    void decryptBlock(std::uint32_t& a, std::uint32_t& b) const;

    // ECB over a word sequence, two words per block, with the byte swap on both
    // sides.  An odd trailing word is ignored, exactly as in the original.
    std::vector<std::uint32_t> encryptWords(const std::vector<std::uint32_t>&) const;
    std::vector<std::uint32_t> decryptWords(const std::vector<std::uint32_t>&) const;

    static std::uint32_t swapWords(std::uint32_t i);

private:
    std::uint32_t f(std::uint32_t x) const;

    std::uint32_t p_[18];
    std::uint32_t s_[4][256];
};

// ---------------------------------------------------------------------------
// Westwood public key -> Blowfish key (BlowfishKeyProvider.DecryptKey).
//
// The MIX header is preceded by an 80-byte keyblock.  Each 40-byte chunk is
// read little-endian as a bignum, raised to 0x10001 mod the embedded public
// modulus, and the low 39 bytes of each result are concatenated; the first 56
// bytes of that are the Blowfish key.
//
// `keyblock` must hold at least 80 bytes; returns exactly 56.
// ---------------------------------------------------------------------------
std::vector<std::uint8_t> deriveBlowfishKey(const std::uint8_t* keyblock,
                                            std::size_t keyblockLen);

}  // namespace mg
