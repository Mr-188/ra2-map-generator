// Win32 compatibility layer -- implementations.  See win32/windows.h.
#include "windows.h"

#include <dirent.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>

#include <map>
#include <mutex>
#include <vector>

#include "../ini.h"

namespace mg_win32 {
namespace {

std::string g_modulePath;
std::map<std::string, mg::IniFile>& iniCache()
{
    static std::map<std::string, mg::IniFile> cache;
    return cache;
}

}  // namespace

void setModulePath(const std::string& posixPath) { g_modulePath = posixPath; }
const std::string& modulePath() { return g_modulePath; }

std::string normalise(const char* path)
{
    if (!path) return std::string();
    std::string p(path);
    for (char& c : p)
        if (c == '\\') c = '/';
    // Collapse a leading "C:/..." onto the real root when one was supplied.
    return p;
}

std::string normaliseW(const wchar_t* path)
{
    return normalise(toUtf8(path).c_str());
}

bool resolveExisting(const std::string& posixPath, std::string* out)
{
    struct stat st;
    if (stat(posixPath.c_str(), &st) == 0)
    {
        if (out) *out = posixPath;
        return true;
    }
    // Windows is case-insensitive; ext4 and MEMFS are not.  The reference asks
    // for "TEMPERATMD.INI" and "RULESMD.INI" in upper case.
    const std::size_t slash = posixPath.find_last_of('/');
    const std::string dir = (slash == std::string::npos) ? std::string(".")
                                                         : posixPath.substr(0, slash);
    const std::string base = (slash == std::string::npos) ? posixPath
                                                          : posixPath.substr(slash + 1);
    DIR* d = opendir(dir.c_str());
    if (!d) return false;
    bool found = false;
    while (struct dirent* e = readdir(d))
    {
        if (strcasecmp(e->d_name, base.c_str()) == 0)
        {
            if (out)
                *out = (slash == std::string::npos) ? std::string(e->d_name)
                                                    : dir + "/" + e->d_name;
            found = true;
            break;
        }
    }
    closedir(d);
    return found;
}

bool statPath(const std::string& posixPath, void* stOut)
{
    std::string resolved;
    if (!resolveExisting(posixPath, &resolved)) return false;
    return stat(resolved.c_str(), static_cast<struct stat*>(stOut)) == 0;
}

std::string toUtf8(const wchar_t* wide, int len)
{
    if (!wide) return std::string();
    std::string out;
    const std::size_t n = (len < 0) ? wcslen(wide) : static_cast<std::size_t>(len);
    for (std::size_t i = 0; i < n; ++i)
    {
        const unsigned long c = static_cast<unsigned long>(wide[i]);
        if (c < 0x80) out.push_back(static_cast<char>(c));
        else if (c < 0x800)
        {
            out.push_back(static_cast<char>(0xC0 | (c >> 6)));
            out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
        }
        else if (c < 0x10000)
        {
            out.push_back(static_cast<char>(0xE0 | (c >> 12)));
            out.push_back(static_cast<char>(0x80 | ((c >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
        }
        else
        {
            out.push_back(static_cast<char>(0xF0 | (c >> 18)));
            out.push_back(static_cast<char>(0x80 | ((c >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((c >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
        }
    }
    return out;
}

std::wstring fromUtf8(const char* narrow, int len)
{
    if (!narrow) return std::wstring();
    std::wstring out;
    const std::size_t n = (len < 0) ? strlen(narrow) : static_cast<std::size_t>(len);
    for (std::size_t i = 0; i < n;)
    {
        const unsigned char c = static_cast<unsigned char>(narrow[i]);
        unsigned long cp = c;
        int extra = 0;
        if (c >= 0xF0) { cp = c & 0x07; extra = 3; }
        else if (c >= 0xE0) { cp = c & 0x0F; extra = 2; }
        else if (c >= 0xC0) { cp = c & 0x1F; extra = 1; }
        for (int k = 0; k < extra && i + 1 + k < n; ++k)
            cp = (cp << 6) | (static_cast<unsigned char>(narrow[i + 1 + k]) & 0x3F);
        out.push_back(static_cast<wchar_t>(cp));
        i += 1 + extra;
    }
    return out;
}

std::wstring widenFormat(const wchar_t* fmt)
{
    static const wchar_t* kConv = L"diouxXeEfgGaAcspn%";
    std::wstring out;
    if (!fmt) return out;
    for (const wchar_t* p = fmt; *p; ++p)
    {
        if (*p != L'%') { out.push_back(*p); continue; }
        const wchar_t* q = p + 1;
        if (*q == L'%') { out += L"%%"; p = q; continue; }
        std::wstring spec(1, L'%');
        bool hasL = false;
        while (*q && !wcschr(kConv, *q))
        {
            if (*q == L'l') hasL = true;
            spec.push_back(*q);
            ++q;
        }
        if (*q == L's' && !hasL) spec.push_back(L'l');
        if (*q) spec.push_back(*q);
        out += spec;
        p = q;
    }
    return out;
}

namespace {
void appendPaddedImpl(std::wstring& out, const std::wstring& value, int width, bool leftAlign)
{
    const std::size_t pad = (width > 0 && static_cast<std::size_t>(width) > value.size())
                                ? static_cast<std::size_t>(width) - value.size() : 0;
    if (!leftAlign) out.append(pad, L' ');
    out += value;
    if (leftAlign) out.append(pad, L' ');
}
}  // namespace

int formatWide(wchar_t* buf, std::size_t cap, const wchar_t* fmt, va_list ap)
{
    if (!buf || cap == 0) return -1;
    std::wstring out;
    const wchar_t* p = fmt;
    while (p && *p)
    {
        if (*p != L'%') { out.push_back(*p++); continue; }
        ++p;
        if (*p == L'%') { out.push_back(L'%'); ++p; continue; }

        // ---- flags ----------------------------------------------------
        std::wstring spec;              // the ASCII part, for a narrow snprintf
        bool leftAlign = false, zeroPad = false, plusSign = false, spaceSign = false;
        bool altForm = false;
        for (;;)
        {
            if (*p == L'-') { leftAlign = true; spec.push_back(*p++); }
            else if (*p == L'0') { zeroPad = true; spec.push_back(*p++); }
            else if (*p == L'+') { plusSign = true; spec.push_back(*p++); }
            else if (*p == L' ') { spaceSign = true; spec.push_back(*p++); }
            else if (*p == L'#') { altForm = true; spec.push_back(*p++); }
            else break;
        }
        // ---- width ----------------------------------------------------
        int width = 0;
        if (*p == L'*') { width = va_arg(ap, int); p++; }
        else while (*p >= L'0' && *p <= L'9') { width = width * 10 + (*p - L'0'); spec.push_back(*p++); }
        // ---- precision ------------------------------------------------
        int precision = -1;
        if (*p == L'.')
        {
            spec.push_back(*p++);
            precision = 0;
            if (*p == L'*') { precision = va_arg(ap, int); p++; }
            else while (*p >= L'0' && *p <= L'9') { precision = precision * 10 + (*p - L'0'); spec.push_back(*p++); }
        }
        // ---- length modifiers (ignored: everything is promoted anyway) --
        while (*p == L'l' || *p == L'h' || *p == L'L' || *p == L'j' || *p == L'z' || *p == L't')
            ++p;
        if (!*p) break;

        const wchar_t conv = *p++;
        char tmp[512];
        switch (conv)
        {
            case L'd': case L'i':
            {
                const int v = va_arg(ap, int);
                std::string ns(spec.begin(), spec.end());
                std::snprintf(tmp, sizeof(tmp), ("%" + ns + "d").c_str(), v);
                for (char c : std::string(tmp)) out.push_back(static_cast<wchar_t>(c));
                break;
            }
            case L'u': case L'o': case L'x': case L'X':
            {
                const unsigned v = va_arg(ap, unsigned);
                std::string ns(spec.begin(), spec.end());
                ns.push_back(static_cast<char>(conv));
                std::snprintf(tmp, sizeof(tmp), ("%" + ns).c_str(), v);
                for (char c : std::string(tmp)) out.push_back(static_cast<wchar_t>(c));
                break;
            }
            case L'f': case L'F': case L'e': case L'E': case L'g': case L'G':
            {
                const double v = va_arg(ap, double);
                std::string ns(spec.begin(), spec.end());
                ns.push_back(static_cast<char>(conv));
                std::snprintf(tmp, sizeof(tmp), ("%" + ns).c_str(), v);
                for (char c : std::string(tmp)) out.push_back(static_cast<wchar_t>(c));
                break;
            }
            case L'c':
            {
                std::wstring one(1, static_cast<wchar_t>(va_arg(ap, int)));
                appendPaddedImpl(out, one, width, leftAlign);
                break;
            }
            case L'p':
            {
                std::snprintf(tmp, sizeof(tmp), "%p", va_arg(ap, void*));
                for (char c : std::string(tmp)) out.push_back(static_cast<wchar_t>(c));
                break;
            }
            case L's':
            {
                // MSVC semantics: %s is a WIDE string.
                const wchar_t* text = va_arg(ap, const wchar_t*);
                std::wstring value = text ? text : L"(null)";
                if (precision >= 0 && static_cast<std::size_t>(precision) < value.size())
                    value.resize(static_cast<std::size_t>(precision));
                appendPaddedImpl(out, value, width, leftAlign);
                break;
            }
            default:
                // Unknown conversion: emit it verbatim rather than truncating.
                out.push_back(L'%');
                out.push_back(conv);
                break;
        }
    }

    if (out.size() + 1 > cap) return -1;   // matches swprintf_s' failure mode
    std::memcpy(buf, out.data(), (out.size() + 1) * sizeof(wchar_t));
    return static_cast<int>(out.size());
}

}  // namespace mg_win32

using mg_win32::fromUtf8;
using mg_win32::normalise;
using mg_win32::normaliseW;
using mg_win32::resolveExisting;
using mg_win32::toUtf8;

// ---------------------------------------------------------------------------
// INI profile API
// ---------------------------------------------------------------------------
namespace {

const mg::IniFile* loadIni(const char* file)
{
    if (!file || !*file) return nullptr;
    const std::string want = normalise(file);
    auto& cache = mg_win32::iniCache();
    auto it = cache.find(want);
    if (it != cache.end()) return &it->second;

    mg::IniFile ini;
    std::string resolved;
    if (resolveExisting(want, &resolved))
    {
        std::FILE* f = std::fopen(resolved.c_str(), "rb");
        if (f)
        {
            std::vector<std::uint8_t> bytes;
            std::uint8_t buf[1 << 16];
            std::size_t n;
            while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0)
                bytes.insert(bytes.end(), buf, buf + n);
            std::fclose(f);
            ini = mg::IniFile::parse(bytes);
        }
    }
    auto ins = cache.emplace(want, std::move(ini));
    return &ins.first->second;
}

}  // namespace

DWORD GetPrivateProfileStringA(LPCSTR section, LPCSTR key, LPCSTR def,
                               LPSTR out, DWORD size, LPCSTR file)
{
    if (!out || size == 0) return 0;
    out[0] = 0;
    const mg::IniFile* ini = loadIni(file);
    if (!ini)
    {
        if (def) snprintf(out, size, "%s", def);
        return static_cast<DWORD>(strlen(out));
    }
    if (!section || !ini->hasSection(section))
    {
        if (def) snprintf(out, size, "%s", def);
        return static_cast<DWORD>(strlen(out));
    }
    if (key == nullptr)
    {
        // Windows: the section's keys, each NUL-terminated, list NUL-closed.
        DWORD written = 0;
        for (const std::string& k : ini->keyNames(section))
        {
            if (written + k.size() + 1 >= size) break;
            memcpy(out + written, k.c_str(), k.size() + 1);
            written += static_cast<DWORD>(k.size()) + 1;
        }
        if (written < size) out[written] = 0;
        return written;
    }
    const std::string value = ini->getString(section, key, def ? def : "");
    snprintf(out, size, "%s", value.c_str());
    return static_cast<DWORD>(strlen(out));
}

DWORD GetPrivateProfileIntA(LPCSTR section, LPCSTR key, int def, LPCSTR file)
{
    const mg::IniFile* ini = loadIni(file);
    if (!ini || !section) return static_cast<DWORD>(def);
    return static_cast<DWORD>(ini->getInt(section, key, def));
}

DWORD GetPrivateProfileSectionNamesA(LPSTR out, DWORD size, LPCSTR file)
{
    if (!out || size == 0) return 0;
    out[0] = 0;
    const mg::IniFile* ini = loadIni(file);
    if (!ini) return 0;
    DWORD written = 0;
    for (const std::string& s : ini->sectionNames())
    {
        if (written + s.size() + 1 >= size) break;
        memcpy(out + written, s.c_str(), s.size() + 1);
        written += static_cast<DWORD>(s.size()) + 1;
    }
    if (written < size) out[written] = 0;
    return written;
}

DWORD GetPrivateProfileSectionA(LPCSTR section, LPSTR out, DWORD size, LPCSTR file)
{
    if (!out || size == 0) return 0;
    out[0] = 0;
    const mg::IniFile* ini = loadIni(file);
    if (!ini || !section) return 0;
    DWORD written = 0;
    for (const std::string& k : ini->keyNames(section))
    {
        const std::string line = k + "=" + ini->getString(section, k, "");
        if (written + line.size() + 1 >= size) break;
        memcpy(out + written, line.c_str(), line.size() + 1);
        written += static_cast<DWORD>(line.size()) + 1;
    }
    if (written < size) out[written] = 0;
    return written;
}

BOOL WritePrivateProfileStringA(LPCSTR, LPCSTR, LPCSTR, LPCSTR) { return FALSE; }

// ---------------------------------------------------------------------------
// Wide/ANSI conversion
// ---------------------------------------------------------------------------
int WideCharToMultiByte(UINT, DWORD, LPCWSTR in, int inLen,
                        LPSTR out, int outSize, LPCSTR, BOOL* used)
{
    if (!in || !out || outSize <= 0) return 0;
    const std::string s = toUtf8(in, inLen);
    int n = static_cast<int>(s.size()) + 1;  // include the terminator, as Windows does
    if (n > outSize) n = outSize;
    memcpy(out, s.data(), static_cast<std::size_t>(n) - 1);
    out[n - 1] = 0;
    if (used) *used = FALSE;
    return n;
}

int MultiByteToWideChar(UINT, DWORD, LPCSTR in, int inLen, LPWSTR out, int outSize)
{
    if (!in || !out || outSize <= 0) return 0;
    const std::wstring w = fromUtf8(in, inLen);
    int n = static_cast<int>(w.size());
    if (inLen < 0) ++n;  // the terminator is part of the count
    if (n > outSize) n = outSize;
    for (int i = 0; i < n; ++i)
        out[i] = (i < static_cast<int>(w.size())) ? w[i] : L'\0';
    return n;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
HANDLE CreateFileW(LPCWSTR path, DWORD access, DWORD, void*,
                   DWORD disposition, DWORD, HANDLE)
{
    std::string p = normaliseW(path);
    if (disposition == OPEN_EXISTING)
    {
        std::string resolved;
        if (!resolveExisting(p, &resolved)) return INVALID_HANDLE_VALUE;
        p = resolved;
    }
    int flags = 0;
    if ((access & GENERIC_WRITE) && (access & GENERIC_READ)) flags = O_RDWR;
    else if (access & GENERIC_WRITE) flags = O_WRONLY;
    else flags = O_RDONLY;
    if (disposition == CREATE_ALWAYS) flags |= O_CREAT | O_TRUNC;
    else if (disposition == OPEN_ALWAYS) flags |= O_CREAT;
    else if (disposition == TRUNCATE_EXISTING) flags |= O_TRUNC;

    const int fd = open(p.c_str(), flags, 0644);
    if (fd < 0) return INVALID_HANDLE_VALUE;
    return reinterpret_cast<HANDLE>(static_cast<intptr_t>(fd) + 1);
}

BOOL ReadFile(HANDLE h, void* buf, DWORD want, DWORD* got, void*)
{
    if (got) *got = 0;
    if (!h || h == INVALID_HANDLE_VALUE) return FALSE;
    const ssize_t n = read(static_cast<int>(reinterpret_cast<intptr_t>(h)) - 1, buf, want);
    if (n < 0) return FALSE;
    if (got) *got = static_cast<DWORD>(n);
    return TRUE;
}

BOOL WriteFile(HANDLE h, const void* buf, DWORD want, DWORD* got, void*)
{
    if (got) *got = 0;
    if (!h || h == INVALID_HANDLE_VALUE) return FALSE;
    const ssize_t n = write(static_cast<int>(reinterpret_cast<intptr_t>(h)) - 1, buf, want);
    if (n < 0) return FALSE;
    if (got) *got = static_cast<DWORD>(n);
    return TRUE;
}

BOOL CloseHandle(HANDLE h)
{
    if (!h || h == INVALID_HANDLE_VALUE) return FALSE;
    return close(static_cast<int>(reinterpret_cast<intptr_t>(h)) - 1) == 0 ? TRUE : FALSE;
}

BOOL GetFileSizeEx(HANDLE h, LARGE_INTEGER* size)
{
    if (!size) return FALSE;
    struct stat st;
    if (fstat(static_cast<int>(reinterpret_cast<intptr_t>(h)) - 1, &st) != 0) return FALSE;
    size->QuadPart = static_cast<long long>(st.st_size);
    return TRUE;
}

DWORD SetFilePointer(HANDLE h, LONG lo, LONG* hi, DWORD method)
{
    const int fd = static_cast<int>(reinterpret_cast<intptr_t>(h)) - 1;
    const long long target =
        static_cast<long long>(lo) + (hi ? (static_cast<long long>(*hi) << 32) : 0);
    const off_t pos = lseek(fd, static_cast<off_t>(target), method == FILE_END ? SEEK_END
                                              : method == FILE_CURRENT ? SEEK_CUR : SEEK_SET);
    return static_cast<DWORD>(pos);
}

BOOL DeleteFileW(LPCWSTR path)
{
    std::string resolved;
    const std::string p = normaliseW(path);
    if (!resolveExisting(p, &resolved)) return FALSE;
    return unlink(resolved.c_str()) == 0 ? TRUE : FALSE;
}

DWORD GetFileAttributesW(LPCWSTR path)
{
    const std::string p = normaliseW(path);
    std::string resolved;
    if (!resolveExisting(p, &resolved)) return INVALID_FILE_ATTRIBUTES;
    struct stat st;
    if (stat(resolved.c_str(), &st) != 0) return INVALID_FILE_ATTRIBUTES;
    return S_ISDIR(st.st_mode) ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
}

BOOL CreateDirectoryW(LPCWSTR path, void*)
{
    const std::string p = normaliseW(path);
    if (p.empty()) return FALSE;
    return mkdir(p.c_str(), 0755) == 0 ? TRUE : FALSE;
}

BOOL RemoveDirectoryW(LPCWSTR path)
{
    return rmdir(normaliseW(path).c_str()) == 0 ? TRUE : FALSE;
}

int _wfopen_s(std::FILE** fp, LPCWSTR path, LPCWSTR mode)
{
    if (!fp) return -1;
    *fp = nullptr;
    const std::string p = normaliseW(path);
    const std::wstring wmode = mode ? mode : L"rb";
    char m[16] = {0};
    for (int i = 0; i < 15 && wmode[i]; ++i) m[i] = static_cast<char>(wmode[i]);
    std::string resolved;
    if (!resolveExisting(p, &resolved)) resolved = p;
    *fp = std::fopen(resolved.c_str(), m);
    return *fp ? 0 : -1;
}

HANDLE FindFirstFileW(LPCWSTR, WIN32_FIND_DATAW*) { return INVALID_HANDLE_VALUE; }
BOOL FindNextFileW(HANDLE, WIN32_FIND_DATAW*) { return FALSE; }
BOOL FindClose(HANDLE) { return TRUE; }

DWORD GetModuleFileNameW(HANDLE, LPWSTR out, DWORD size)
{
    if (!out || size == 0) return 0;
    // Report a BACKSLASH path: the sources cut the directory off with
    // wcsrchr(dir, L'\\') and rely on the trailing separator.
    std::string p = mg_win32::modulePath();
    if (p.empty()) p = "MapGenerator.exe";
    for (char& c : p)
        if (c == '/') c = '\\';
    const std::wstring w = fromUtf8(p.c_str());
    DWORD c = static_cast<DWORD>(w.size());
    if (c >= size) c = size - 1;
    for (DWORD i = 0; i < c; ++i) out[i] = w[i];
    out[c] = 0;
    return c;
}

DWORD GetCurrentDirectoryW(DWORD size, LPWSTR out)
{
    char buf[4096];
    if (!getcwd(buf, sizeof(buf))) return 0;
    const std::wstring w = fromUtf8(buf);
    DWORD c = static_cast<DWORD>(w.size());
    if (!out || size == 0) return c + 1;
    if (c >= size) c = size - 1;
    for (DWORD i = 0; i < c; ++i) out[i] = w[i];
    out[c] = 0;
    return c;
}

DWORD GetFullPathNameW(LPCWSTR name, DWORD size, LPWSTR out, LPWSTR* filePart)
{
    const std::string p = normaliseW(name);
    const std::wstring w = fromUtf8(p.c_str());
    if (filePart)
    {
        const std::size_t slash = p.find_last_of('/');
        static std::wstring tail;
        tail = fromUtf8(p.c_str() + (slash == std::string::npos ? 0 : slash + 1));
        *filePart = const_cast<wchar_t*>(tail.c_str());
    }
    DWORD c = static_cast<DWORD>(w.size());
    if (!out || size == 0) return c + 1;
    if (c >= size) c = size - 1;
    for (DWORD i = 0; i < c; ++i) out[i] = w[i];
    out[c] = 0;
    return c;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
void Sleep(DWORD ms) { usleep(static_cast<useconds_t>(ms) * 1000); }

DWORD GetTickCount()
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return static_cast<DWORD>((ts.tv_sec * 1000ull + ts.tv_nsec / 1000000ull) & 0xFFFFFFFFull);
}

namespace {
void fillSystemTime(SYSTEMTIME* st, bool local)
{
    if (!st) return;
    const time_t t = time(nullptr);
    struct tm tmv;
    if (local) localtime_r(&t, &tmv); else gmtime_r(&t, &tmv);
    st->wYear = static_cast<WORD>(tmv.tm_year + 1900);
    st->wMonth = static_cast<WORD>(tmv.tm_mon + 1);
    st->wDayOfWeek = static_cast<WORD>(tmv.tm_wday);
    st->wDay = static_cast<WORD>(tmv.tm_mday);
    st->wHour = static_cast<WORD>(tmv.tm_hour);
    st->wMinute = static_cast<WORD>(tmv.tm_min);
    st->wSecond = static_cast<WORD>(tmv.tm_sec);
    st->wMilliseconds = 0;
}
}  // namespace

void GetLocalTime(SYSTEMTIME* st) { fillSystemTime(st, true); }
void GetSystemTime(SYSTEMTIME* st) { fillSystemTime(st, false); }

void OutputDebugStringA(LPCSTR s) { if (s) std::fputs(s, stderr); }
void OutputDebugStringW(LPCWSTR s) { if (s) std::fputs(toUtf8(s).c_str(), stderr); }

HWND GetDlgItem(HWND, int) { return nullptr; }
int MessageBoxW(HWND, LPCWSTR, LPCWSTR, UINT) { return 0; }
void* SendMessageW(HWND, UINT, ULONG_PTR, long) { return nullptr; }
BOOL EnableWindow(HWND, BOOL) { return TRUE; }
void PostQuitMessage(int) {}
