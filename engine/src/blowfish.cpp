// Blowfish + Westwood key derivation.  See blowfish.h for the provenance note.
#include "blowfish.h"

#include "blowfish_tables.h"

#include <cstring>

namespace mg {
namespace {

// ---------------------------------------------------------------------------
// A minimal fixed-purpose bignum.  The Westwood modulus is 319 bits and the
// operands here never exceed 320 bits, so 32-bit limbs and binary long division
// are more than fast enough (about 20 reductions per key derivation).
// ---------------------------------------------------------------------------
using Big = std::vector<std::uint32_t>;  // little-endian limbs

void trim(Big& a)
{
    while (!a.empty() && a.back() == 0) a.pop_back();
}

int cmp(const Big& a, const Big& b)
{
    if (a.size() != b.size()) return a.size() < b.size() ? -1 : 1;
    for (std::size_t i = a.size(); i-- > 0;)
        if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

Big sub(const Big& a, const Big& b)  // requires a >= b
{
    Big r(a.size(), 0);
    std::uint64_t borrow = 0;
    for (std::size_t i = 0; i < a.size(); ++i)
    {
        const std::uint64_t bi = (i < b.size() ? b[i] : 0u) + borrow;
        const std::uint64_t ai = a[i];
        if (ai >= bi)
        {
            r[i] = static_cast<std::uint32_t>(ai - bi);
            borrow = 0;
        }
        else
        {
            r[i] = static_cast<std::uint32_t>(ai + 0x100000000ull - bi);
            borrow = 1;
        }
    }
    trim(r);
    return r;
}

Big mul(const Big& a, const Big& b)
{
    Big r(a.size() + b.size(), 0);
    for (std::size_t i = 0; i < a.size(); ++i)
    {
        std::uint64_t carry = 0;
        for (std::size_t j = 0; j < b.size(); ++j)
        {
            const std::uint64_t cur =
                static_cast<std::uint64_t>(r[i + j]) +
                static_cast<std::uint64_t>(a[i]) * b[j] + carry;
            r[i + j] = static_cast<std::uint32_t>(cur);
            carry = cur >> 32;
        }
        std::size_t k = i + b.size();
        while (carry && k < r.size())
        {
            const std::uint64_t cur = static_cast<std::uint64_t>(r[k]) + carry;
            r[k] = static_cast<std::uint32_t>(cur);
            carry = cur >> 32;
            ++k;
        }
    }
    trim(r);
    return r;
}

Big mod(const Big& a, const Big& m)  // binary long division
{
    Big r;
    for (std::size_t bit = a.size() * 32; bit-- > 0;)
    {
        // r <<= 1
        std::uint32_t carry = 0;
        for (std::size_t i = 0; i < r.size(); ++i)
        {
            const std::uint32_t next = r[i] >> 31;
            r[i] = (r[i] << 1) | carry;
            carry = next;
        }
        if (carry) r.push_back(carry);
        // bring in the next bit of the dividend
        if ((a[bit / 32] >> (bit % 32)) & 1u)
        {
            if (r.empty()) r.push_back(1);
            else r[0] |= 1u;
        }
        if (cmp(r, m) >= 0) r = sub(r, m);
    }
    return r;
}

Big modexp(Big base, std::uint32_t exp, const Big& m)
{
    Big result{1};
    base = mod(base, m);
    while (exp)
    {
        if (exp & 1u) result = mod(mul(result, base), m);
        exp >>= 1;
        if (exp) base = mod(mul(base, base), m);
    }
    return result;
}

Big fromLE(const std::uint8_t* p, std::size_t n)
{
    Big a((n + 3) / 4, 0);
    for (std::size_t i = 0; i < n; ++i)
        a[i / 4] |= static_cast<std::uint32_t>(p[i]) << ((i % 4) * 8);
    trim(a);
    return a;
}

std::vector<std::uint8_t> toLE(const Big& a, std::size_t want)
{
    std::vector<std::uint8_t> out(want, 0);
    for (std::size_t i = 0; i < want; ++i)
    {
        const std::size_t limb = i / 4;
        if (limb < a.size())
            out[i] = static_cast<std::uint8_t>((a[limb] >> ((i % 4) * 8)) & 0xFF);
    }
    return out;
}

}  // namespace

std::uint32_t Blowfish::swapWords(std::uint32_t i)
{
    i = ((i << 16) | (i >> 16));
    return ((i << 8) & 0xFF00FF00u) | ((i >> 8) & 0x00FF00FFu);
}

Blowfish::Blowfish(const std::uint8_t* key, std::size_t keyLen)
{
    if (!key || keyLen == 0) keyLen = 1;  // caller guarantees non-empty key

    std::memcpy(p_, kPInit, sizeof(p_));
    std::memcpy(s_, kSInit, sizeof(s_));

    std::size_t j = 0;
    for (int i = 0; i < 18; ++i)
    {
        const std::uint32_t a = key[j % keyLen]; ++j;
        const std::uint32_t b = key[j % keyLen]; ++j;
        const std::uint32_t c = key[j % keyLen]; ++j;
        const std::uint32_t d = key[j % keyLen]; ++j;
        p_[i] ^= (a << 24) | (b << 16) | (c << 8) | d;
    }

    std::uint32_t left = 0, right = 0;
    for (int i = 0; i < 18; i += 2)
    {
        encryptBlock(left, right);
        p_[i] = left;
        p_[i + 1] = right;
    }
    for (int box = 0; box < 4; ++box)
    {
        for (int k = 0; k < 256; k += 2)
        {
            encryptBlock(left, right);
            s_[box][k] = left;
            s_[box][k + 1] = right;
        }
    }
}

std::uint32_t Blowfish::f(std::uint32_t x) const
{
    return ((((s_[0][(x >> 24) & 0xFF] + s_[1][(x >> 16) & 0xFF]))
             ^ s_[2][(x >> 8) & 0xFF]) +
            s_[3][x & 0xFF]);
}

void Blowfish::encryptBlock(std::uint32_t& a, std::uint32_t& b) const
{
    std::uint32_t x = a ^ p_[0];
    std::uint32_t y = b;
    for (int i = 1; i < 17; ++i)
    {
        if (i & 1) y = y ^ (f(x) ^ p_[i]);
        else       x = x ^ (f(y) ^ p_[i]);
    }
    y ^= p_[17];
    // The original returns (_b, _a) -- keep the swap.
    a = y;
    b = x;
}

void Blowfish::decryptBlock(std::uint32_t& a, std::uint32_t& b) const
{
    std::uint32_t x = a ^ p_[17];
    std::uint32_t y = b;
    for (int i = 16; i > 0; --i)
    {
        if (i & 1) x = x ^ (f(y) ^ p_[i]);
        else       y = y ^ (f(x) ^ p_[i]);
    }
    y ^= p_[0];
    a = y;
    b = x;
}

std::vector<std::uint32_t> Blowfish::encryptWords(const std::vector<std::uint32_t>& w) const
{
    std::vector<std::uint32_t> out;
    out.reserve(w.size());
    for (std::size_t i = 0; i + 1 < w.size(); i += 2)
    {
        std::uint32_t a = swapWords(w[i]);
        std::uint32_t b = swapWords(w[i + 1]);
        encryptBlock(a, b);
        out.push_back(swapWords(a));
        out.push_back(swapWords(b));
    }
    return out;
}

std::vector<std::uint32_t> Blowfish::decryptWords(const std::vector<std::uint32_t>& w) const
{
    std::vector<std::uint32_t> out;
    out.reserve(w.size());
    for (std::size_t i = 0; i + 1 < w.size(); i += 2)
    {
        std::uint32_t a = swapWords(w[i]);
        std::uint32_t b = swapWords(w[i + 1]);
        decryptBlock(a, b);
        out.push_back(swapWords(a));
        out.push_back(swapWords(b));
    }
    return out;
}

std::vector<std::uint8_t> deriveBlowfishKey(const std::uint8_t* keyblock,
                                            std::size_t keyblockLen)
{
    std::vector<std::uint8_t> out;
    if (!keyblock || keyblockLen < 80) return out;

    // kPublicModulus is stored little-endian (see tools/gen_blowfish_tables.py).
    const Big modulus = fromLE(kPublicModulus, sizeof(kPublicModulus));
    if (modulus.empty()) return out;
    int pubkeyLen = 0;  // bitlen_bignum(key1, 64) - 1
    for (std::size_t i = modulus.size(); i-- > 0;)
    {
        if (modulus[i])
        {
            std::uint32_t top = modulus[i];
            int bits = 0;
            while (top) { top >>= 1; ++bits; }
            pubkeyLen = static_cast<int>(i * 32 + bits) - 1;
            break;
        }
    }
    if (pubkeyLen <= 0) return out;
    const std::size_t a = static_cast<std::size_t>(pubkeyLen - 1) / 8;
    if (a == 0) return out;
    std::size_t preLen = (55 / a + 1) * (a + 1);

    std::size_t offset = 0;
    while (a + 1 <= preLen)
    {
        const Big chunk = fromLE(keyblock + offset, a + 1);
        const Big decrypted = modexp(chunk, kRsaPublicExponent, modulus);
        const std::vector<std::uint8_t> blob = toLE(decrypted, a);
        out.insert(out.end(), blob.begin(), blob.end());
        offset += a + 1;
        preLen -= a + 1;
    }

    out.resize(out.size() < 56 ? out.size() : 56);  // Python: bytes(out[:56])
    return out;
}

}  // namespace mg
