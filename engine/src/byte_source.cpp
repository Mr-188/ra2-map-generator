#include "byte_source.h"

#include <cstring>

#if defined(_WIN32)
#include <io.h>
#else
#include <sys/stat.h>
#endif

namespace mg {
namespace {
SourceFactory g_factory = nullptr;
}  // namespace

void setSourceFactory(SourceFactory factory) { g_factory = factory; }
SourceFactory sourceFactory() { return g_factory; }

std::shared_ptr<ByteSource> openSource(const std::string& path)
{
    if (g_factory) return g_factory(path);
    return FileSource::open(path);
}

std::shared_ptr<FileSource> FileSource::open(const std::string& path)
{
#if defined(_WIN32)
    struct _stat64 st;
    if (_stat64(path.c_str(), &st) != 0 || (st.st_mode & _S_IFDIR)) return nullptr;
    std::FILE* f = std::fopen(path.c_str(), "rb");
#else
    struct stat st;
    if (stat(path.c_str(), &st) != 0 || S_ISDIR(st.st_mode)) return nullptr;
    std::FILE* f = std::fopen(path.c_str(), "rb");
#endif
    if (!f) return nullptr;
    std::fseek(f, 0, SEEK_END);
    const long end = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    if (end < 0)
    {
        std::fclose(f);
        return nullptr;
    }
    return std::shared_ptr<FileSource>(new FileSource(f, static_cast<std::size_t>(end)));
}

FileSource::~FileSource()
{
    if (file_) std::fclose(file_);
}

bool FileSource::read(std::size_t offset, std::size_t len, std::uint8_t* out)
{
    if (!file_ || offset > size_ || len > size_ - offset) return false;
    if (len == 0) return true;
    if (std::fseek(file_, static_cast<long>(offset), SEEK_SET) != 0) return false;
    return std::fread(out, 1, len, file_) == len;
}

}  // namespace mg
