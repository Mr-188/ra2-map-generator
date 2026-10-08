// Byte sources for the MIX layer.
//
// An archive is NOT loaded whole.  ra2.mix is 269 MB and ra2md.mix is 195 MB;
// pulling both into memory would cost ~464 MB, which is unacceptable in the
// browser target even before the theater archives are added.  Both the desktop
// and the WASM build instead parse only the header/index and read entry payload
// on demand through one of these.
//
// The same interface covers the three places bytes come from:
//   * MemorySource -- a std::vector already in hand (nested members, tests)
//   * FileSource   -- a real file on disk (desktop CLI)
//   * (phase 3) a JS-backed source that reads from a File the user picked
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace mg {

class ByteSource
{
public:
    virtual ~ByteSource() = default;

    virtual std::size_t size() const = 0;

    // Reads exactly `len` bytes at `offset`.  Returns false (and leaves the
    // buffer partly written) when the request is out of range -- callers treat
    // that as a malformed archive.
    virtual bool read(std::size_t offset, std::size_t len, std::uint8_t* out) = 0;

    // Convenience: read into a vector, empty on failure.
    std::vector<std::uint8_t> readVec(std::size_t offset, std::size_t len)
    {
        std::vector<std::uint8_t> out(len);
        if (len == 0) return out;
        if (!read(offset, len, out.data())) return {};
        return out;
    }
};

// ---------------------------------------------------------------------------
// Host hook.
//
// The desktop build opens an archive from the local disk.  The browser build has
// no disk: it must read from the File the player picked, sliced on demand.  The
// host installs a factory (see engine/src/wasm/js_source.cpp) and everything
// above keeps calling openSource().
// ---------------------------------------------------------------------------
using SourceFactory = std::shared_ptr<ByteSource> (*)(const std::string& path);

void setSourceFactory(SourceFactory factory);
SourceFactory sourceFactory();

// Opens `path` through the installed factory, or from the local filesystem when
// none is installed.  Returns nullptr when neither can.
std::shared_ptr<ByteSource> openSource(const std::string& path);

class MemorySource final : public ByteSource
{
public:
    explicit MemorySource(std::vector<std::uint8_t> data) : data_(std::move(data)) {}

    std::size_t size() const override { return data_.size(); }
    bool read(std::size_t offset, std::size_t len, std::uint8_t* out) override
    {
        if (offset > data_.size() || len > data_.size() - offset) return false;
        if (len) std::memcpy(out, data_.data() + offset, len);
        return true;
    }
    const std::vector<std::uint8_t>& bytes() const { return data_; }

private:
    std::vector<std::uint8_t> data_;
};

class FileSource final : public ByteSource
{
public:
    // Returns nullptr when the file cannot be opened or is a directory.
    static std::shared_ptr<FileSource> open(const std::string& path);

    ~FileSource() override;
    std::size_t size() const override { return size_; }
    bool read(std::size_t offset, std::size_t len, std::uint8_t* out) override;

private:
    FileSource(std::FILE* f, std::size_t size) : file_(f), size_(size) {}
    std::FILE* file_ = nullptr;
    std::size_t size_ = 0;
};

}  // namespace mg
