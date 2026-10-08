#pragma once
// <strsafe.h> replacement for the Linux/Emscripten build.
//
// Only WinMain.cpp uses the StringCch* family, and the console driver replaces
// that file -- but MapGen.cpp includes the header, so the entry points exist
// here in case a future revision reaches for one.
#include "windows.h"

typedef long HRESULT;
#define S_OK ((HRESULT)0)
#define E_FAIL ((HRESULT)0x80004005L)
#define STRSAFE_E_INSUFFICIENT_BUFFER ((HRESULT)0x8007007AL)

inline HRESULT StringCchPrintfW(wchar_t* dst, size_t cch, const wchar_t* fmt, ...)
{
    if (!dst || cch == 0) return E_FAIL;
    const std::wstring f = mg_win32::widenFormat(fmt);
    va_list ap;
    va_start(ap, fmt);
    const int r = vswprintf(dst, cch, f.c_str(), ap);
    va_end(ap);
    return r < 0 ? STRSAFE_E_INSUFFICIENT_BUFFER : S_OK;
}

inline HRESULT StringCchCopyW(wchar_t* dst, size_t cch, const wchar_t* src)
{
    if (!dst || cch == 0) return E_FAIL;
    if (!src) { dst[0] = 0; return S_OK; }
    wcsncpy(dst, src, cch - 1);
    dst[cch - 1] = 0;
    return S_OK;
}

inline HRESULT StringCchCatW(wchar_t* dst, size_t cch, const wchar_t* src)
{
    if (!dst || cch == 0) return E_FAIL;
    const size_t have = wcslen(dst);
    if (have + 1 >= cch) return STRSAFE_E_INSUFFICIENT_BUFFER;
    wcsncat(dst, src ? src : L"", cch - have - 1);
    return S_OK;
}

inline HRESULT StringCchPrintfA(char* dst, size_t cch, const char* fmt, ...)
{
    if (!dst || cch == 0) return E_FAIL;
    va_list ap;
    va_start(ap, fmt);
    const int r = vsnprintf(dst, cch, fmt, ap);
    va_end(ap);
    return r < 0 ? STRSAFE_E_INSUFFICIENT_BUFFER : S_OK;
}

inline HRESULT StringCchCopyA(char* dst, size_t cch, const char* src)
{
    if (!dst || cch == 0) return E_FAIL;
    snprintf(dst, cch, "%s", src ? src : "");
    return S_OK;
}
