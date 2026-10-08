// A Win32 compatibility layer, so the reference implementation's core
// translation units (MapGen*.cpp) compile and run on Linux and, later, under
// Emscripten.
//
// Scope is deliberately narrow: it provides exactly the surface those files
// actually use, which was measured rather than guessed --
//
//   GetPrivateProfileIntA            53      GetModuleFileNameW        9
//   GetPrivateProfileStringA         23      GetFileAttributesW        6
//   CreateDirectoryW                  4      _wfopen_s                 3
//   CreateFileW / ReadFile            1      GetFileSizeEx             1
//   CloseHandle                       2      GetLocalTime / GetTickCount / Sleep
//   swprintf_s                       10      sprintf_s                 3
//   strtok_s                          4      strncpy_s / wcscpy_s / wcscat_s
//   _stricmp / _strnicmp / sscanf_s / GetDlgItem
//
// (StringCchPrintfW, SendMessageW, MessageBoxW, EnableWindow and the FindFirst
// family appear only in WinMain.cpp, which the console driver replaces.  The
// stubs below exist so a stray reference still links.)
//
// Two platform differences would silently corrupt results if ignored, and both
// are handled here rather than at the call sites:
//
//  1. In MSVC's wide printf, %s means a WIDE string; in glibc's swprintf it
//     means a multibyte one and %ls is the wide form.  Every %s in a wide format
//     is rewritten to %ls before glibc sees it.
//  2. Windows paths are case-insensitive and use backslashes; Linux is the
//     opposite on both counts.  Every path argument is normalised and resolved
//     case-insensitively, and GetModuleFileNameW reports a backslash path.
#pragma once

#ifndef _WIN32

#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <ctime>
#include <strings.h>
#include <string>

// ---------------------------------------------------------------------------
// Types
//
// These are FIXED WIDTH on purpose.  `unsigned long` is 32-bit on Windows and
// wasm32 but 64-bit on Linux x86_64, so spelling DWORD that way makes the native
// and wasm builds disagree -- which they did, before this was pinned down.
// ---------------------------------------------------------------------------
typedef std::uint32_t      UINT;
typedef std::int32_t       INT;
typedef std::uint32_t      DWORD;
typedef std::int32_t       LONG;
typedef int                BOOL;
typedef std::uint8_t       BYTE;
typedef std::uint16_t      WORD;
typedef void*              HANDLE;
typedef std::uint32_t      ULONG;
typedef std::uint64_t      ULONG_PTR;
typedef const char*        LPCSTR;
typedef char*              LPSTR;
typedef const wchar_t*     LPCWSTR;
typedef wchar_t*           LPWSTR;
typedef void*              HWND;
typedef void*              HINSTANCE;

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif

#define MAX_PATH 260
#ifndef ARRAYSIZE
#define ARRAYSIZE(a) (sizeof(a) / sizeof((a)[0]))
#endif
#ifndef _TRUNCATE
#define _TRUNCATE ((size_t)-1)
#endif

#define CP_ACP 0
#define CP_UTF8 65001

#define INVALID_FILE_ATTRIBUTES  ((DWORD)0xFFFFFFFFu)
#define INVALID_HANDLE_VALUE     ((HANDLE)(intptr_t)-1)

#define GENERIC_READ             0x80000000u
#define GENERIC_WRITE            0x40000000u
#define FILE_SHARE_READ          0x00000001u
#define FILE_SHARE_WRITE         0x00000002u
#define CREATE_NEW               1u
#define CREATE_ALWAYS            2u
#define OPEN_EXISTING            3u
#define OPEN_ALWAYS              4u
#define TRUNCATE_EXISTING        5u
#define FILE_ATTRIBUTE_READONLY  0x00000001u
#define FILE_ATTRIBUTE_DIRECTORY 0x00000010u
#define FILE_ATTRIBUTE_NORMAL    0x00000080u
#define FILE_APPEND_DATA         0x00000004u
#define FILE_BEGIN               0u
#define FILE_CURRENT             1u
#define FILE_END                 2u

#define WINAPI
#define __stdcall
#define CALLBACK

typedef union _LARGE_INTEGER
{
    struct { DWORD LowPart; LONG HighPart; } u;
    long long QuadPart;
} LARGE_INTEGER;

typedef struct _SYSTEMTIME
{
    WORD wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds;
} SYSTEMTIME;

typedef struct _FILETIME { DWORD dwLowDateTime, dwHighDateTime; } FILETIME;
typedef struct _WIN32_FIND_DATAW
{
    DWORD dwFileAttributes;
    FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
    DWORD nFileSizeHigh, nFileSizeLow;
    DWORD dwReserved0, dwReserved1;
    wchar_t cFileName[MAX_PATH];
    wchar_t cAlternateFileName[16];
} WIN32_FIND_DATAW;
typedef WIN32_FIND_DATAW WIN32_FIND_DATA;

// ---------------------------------------------------------------------------
// Path handling (see the header note)
// ---------------------------------------------------------------------------
namespace mg_win32 {

// Directory GetModuleFileNameW reports.  Set by the host before the generator
// runs; empty means "the process working directory".
void setModulePath(const std::string& posixPath);
const std::string& modulePath();

// Backslashes to slashes, and the synthetic drive prefix mapped onto the real
// root.  Pure string work; no filesystem access.
std::string normalise(const char* path);
std::string normaliseW(const wchar_t* path);

// Case-insensitive resolve: Windows does not care about case, ext4 and MEMFS
// do.  Returns false when nothing matches.
bool resolveExisting(const std::string& posixPath, std::string* out);
bool statPath(const std::string& posixPath, void* stOut);

// UTF-16/32 <-> UTF-8, so the code's wide paths name real files here.
std::string toUtf8(const wchar_t* wide, int len = -1);
std::wstring fromUtf8(const char* narrow, int len = -1);

// MSVC's wide printf reads %s as a WIDE string; glibc's reads it as multibyte
// and wants %ls.  This rewrites every conversion in a wide format accordingly.
std::wstring widenFormat(const wchar_t* fmt);

// A self-contained wide formatter.
//
// It exists because the C libraries disagree about wide formats in a way that
// SILENTLY changes results.  glibc's vswprintf takes the wide format as-is;
// musl's (which Emscripten uses) first converts it to multibyte, and in the
// default "C" locale a non-ASCII wide character cannot be represented, so the
// conversion stops there.  `swprintf_s(w, L"%s..\\..\\Tile\u8d44\u6e90\\%s\\", ...)`
// therefore produced `...Tile` under wasm and the full path natively -- the two
// builds disagreed on every theater tile path, and the maps differed.
//
// Supported conversions: d i u o x X c s (with flags, width and precision) and
// %%.  `%s` means a WIDE string, as on MSVC.  This covers every format the
// reference sources use.
int formatWide(wchar_t* buf, std::size_t cap, const wchar_t* fmt, va_list ap);

}  // namespace mg_win32

// ---------------------------------------------------------------------------
// INI profile API -- backed by engine/src/ini.cpp
// ---------------------------------------------------------------------------
DWORD GetPrivateProfileIntA(LPCSTR section, LPCSTR key, int def, LPCSTR file);
DWORD GetPrivateProfileStringA(LPCSTR section, LPCSTR key, LPCSTR def,
                               LPSTR out, DWORD size, LPCSTR file);
DWORD GetPrivateProfileSectionNamesA(LPSTR out, DWORD size, LPCSTR file);
DWORD GetPrivateProfileSectionA(LPCSTR section, LPSTR out, DWORD size, LPCSTR file);
BOOL  WritePrivateProfileStringA(LPCSTR, LPCSTR, LPCSTR, LPCSTR);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
HANDLE CreateFileW(LPCWSTR path, DWORD access, DWORD share, void* sa,
                   DWORD disposition, DWORD flags, HANDLE templ);
BOOL   ReadFile(HANDLE h, void* buf, DWORD want, DWORD* got, void* ov);
BOOL   WriteFile(HANDLE h, const void* buf, DWORD want, DWORD* got, void* ov);
BOOL   CloseHandle(HANDLE h);
BOOL   GetFileSizeEx(HANDLE h, LARGE_INTEGER* size);
DWORD  SetFilePointer(HANDLE h, LONG lo, LONG* hi, DWORD method);
BOOL   DeleteFileW(LPCWSTR path);
DWORD  GetFileAttributesW(LPCWSTR path);
BOOL   CreateDirectoryW(LPCWSTR path, void* sa);
BOOL   RemoveDirectoryW(LPCWSTR path);
HANDLE FindFirstFileW(LPCWSTR spec, WIN32_FIND_DATAW* data);
BOOL   FindNextFileW(HANDLE find, WIN32_FIND_DATAW* data);
BOOL   FindClose(HANDLE find);
DWORD  GetModuleFileNameW(HANDLE mod, LPWSTR out, DWORD size);
DWORD  GetCurrentDirectoryW(DWORD size, LPWSTR out);
DWORD  GetFullPathNameW(LPCWSTR name, DWORD size, LPWSTR out, LPWSTR* filePart);
// MSVC's secure fopen.  Returns 0 on success, like the original.
int    _wfopen_s(std::FILE** fp, LPCWSTR path, LPCWSTR mode);

// ---------------------------------------------------------------------------
// Wide/ANSI conversion
// ---------------------------------------------------------------------------
int WideCharToMultiByte(UINT cp, DWORD flags, LPCWSTR in, int inLen,
                        LPSTR out, int outSize, LPCSTR defChar, BOOL* used);
int MultiByteToWideChar(UINT cp, DWORD flags, LPCSTR in, int inLen,
                        LPWSTR out, int outSize);

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
void  Sleep(DWORD ms);
DWORD GetTickCount();
void  GetLocalTime(SYSTEMTIME* st);
void  GetSystemTime(SYSTEMTIME* st);
void  OutputDebugStringA(LPCSTR s);
void  OutputDebugStringW(LPCWSTR s);
HWND  GetDlgItem(HWND, int);
int   MessageBoxW(HWND, LPCWSTR, LPCWSTR, UINT);
void* SendMessageW(HWND, UINT, ULONG_PTR, long);
BOOL  EnableWindow(HWND, BOOL);
void  PostQuitMessage(int);

// ---------------------------------------------------------------------------
// MSVC secure CRT / strsafe
// ---------------------------------------------------------------------------
inline int swprintf_s(wchar_t* buf, size_t n, const wchar_t* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    const int r = mg_win32::formatWide(buf, n, fmt, ap);
    va_end(ap);
    return r;
}
template <std::size_t N, typename... A>
inline int swprintf_s(wchar_t (&buf)[N], const wchar_t* fmt, A... a)
{
    return swprintf_s(buf, static_cast<size_t>(N), fmt, a...);
}
inline int sprintf_s(char* buf, size_t n, const char* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    const int r = vsnprintf(buf, n, fmt, ap);
    va_end(ap);
    return r;
}
template <std::size_t N, typename... A>
inline int sprintf_s(char (&buf)[N], const char* fmt, A... a)
{
    return sprintf_s(buf, static_cast<size_t>(N), fmt, a...);
}
template <std::size_t N, typename... A>
inline int _snprintf_s(char (&buf)[N], size_t, size_t, const char* fmt, A... a)
{
    const int r = snprintf(buf, N, fmt, a...);
    return r < 0 ? -1 : r;
}
inline int strcpy_s(char* dst, size_t n, const char* src)
{
    if (!src) { if (n) dst[0] = 0; return 0; }
    snprintf(dst, n, "%s", src);
    return 0;
}
inline int wcscpy_s(wchar_t* dst, size_t n, const wchar_t* src)
{
    if (!src) { if (n) dst[0] = 0; return 0; }
    if (n) { wcsncpy(dst, src, n - 1); dst[n - 1] = 0; }
    return 0;
}
inline int wcscat_s(wchar_t* dst, size_t n, const wchar_t* src)
{
    if (!dst || !src || n == 0) return -1;
    const size_t have = wcslen(dst);
    if (have >= n) return -1;
    wcsncat(dst, src, n - have - 1);
    return 0;
}
inline int strcat_s(char* dst, size_t n, const char* src)
{
    if (!dst || !src || n == 0) return -1;
    const size_t have = strlen(dst);
    if (have >= n) return -1;
    strncat(dst, src, n - have - 1);
    return 0;
}
inline int strncpy_s(char* dst, size_t n, const char* src, size_t count)
{
    if (!dst || n == 0) return -1;
    if (!src) { dst[0] = 0; return 0; }
    if (count == (size_t)-1) { snprintf(dst, n, "%s", src); return 0; }
    size_t i = 0;
    for (; i < count && i < n - 1 && src[i]; ++i) dst[i] = src[i];
    dst[i] = 0;
    return 0;
}
inline int wcsncpy_s(wchar_t* dst, size_t n, const wchar_t* src, size_t count)
{
    if (!dst || n == 0) return -1;
    if (!src) { dst[0] = 0; return 0; }
    if (count == (size_t)-1) { wcsncpy(dst, src, n - 1); dst[n - 1] = 0; return 0; }
    size_t i = 0;
    for (; i < count && i < n - 1 && src[i]; ++i) dst[i] = src[i];
    dst[i] = 0;
    return 0;
}
template <std::size_t N>
inline int strncpy_s(char (&dst)[N], const char* src, size_t count)
{ return strncpy_s(dst, (size_t)N, src, count); }
template <std::size_t N>
inline int wcsncpy_s(wchar_t (&dst)[N], const wchar_t* src, size_t count)
{ return wcsncpy_s(dst, (size_t)N, src, count); }
template <std::size_t N>
inline int strcpy_s(char (&dst)[N], const char* src)
{ return strcpy_s(dst, (size_t)N, src); }
template <std::size_t N>
inline int wcscpy_s(wchar_t (&dst)[N], const wchar_t* src)
{ return wcscpy_s(dst, (size_t)N, src); }
template <std::size_t N>
inline int strcat_s(char (&dst)[N], const char* src)
{ return strcat_s(dst, (size_t)N, src); }
template <std::size_t N>
inline int wcscat_s(wchar_t (&dst)[N], const wchar_t* src)
{ return wcscat_s(dst, (size_t)N, src); }
inline char* strtok_s(char* str, const char* delim, char** ctx)
{ return strtok_r(str, delim, ctx); }
// The sources use only integer conversions (%d), where MSVC's sscanf_s and
// plain sscanf take the same arguments.
inline int sscanf_s(const char* buf, const char* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    const int r = vsscanf(buf, fmt, ap);
    va_end(ap);
    return r;
}
inline int _stricmp(const char* a, const char* b) { return strcasecmp(a, b); }
inline int _strnicmp(const char* a, const char* b, size_t n) { return strncasecmp(a, b, n); }
inline int _wcsicmp(const wchar_t* a, const wchar_t* b) { return wcscasecmp(a, b); }
inline int _wcsnicmp(const wchar_t* a, const wchar_t* b, size_t n) { return wcsncasecmp(a, b, n); }

#endif  // !_WIN32
