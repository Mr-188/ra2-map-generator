#pragma once
// <gdiplus.h> replacement.
//
// MapGenRadar.cpp is the only translation unit that reaches for GDI+, and only
// inside one leaf helper (SaveRadarPng / GetEncoderClsid) that writes
// radar_preview.png.  Reporting "no encoders" makes GetEncoderClsid return false
// and the caller take its existing failure path -- the same thing the retail
// build does on a machine without the PNG codec.  The map itself never goes
// through GDI+.
//
// Phase 4 renders previews from the tile data directly, so this stub is not on
// the critical path.
#include "windows.h"
#include "objidl.h"

#define PixelFormat32bppARGB 0x0026200A

namespace Gdiplus
{
    enum Status { Ok = 0, GenericError = 1, InvalidParameter = 2 };

    struct GdiplusStartupInput
    {
        GdiplusStartupInput() {}
    };

    struct ImageCodecInfo
    {
        CLSID    Clsid;
        GUID     FormatID;
        wchar_t* CodecName;
        wchar_t* DllName;
        wchar_t* FormatDescription;
        wchar_t* FilenameExtension;
        wchar_t* MimeType;
        DWORD    Flags;
        DWORD    Version;
        DWORD    SigCount;
        DWORD    SigSize;
        BYTE*    SigPattern;
        BYTE*    SigMask;
    };

    inline Status GetImageEncodersSize(UINT* count, UINT* bytes)
    {
        if (count) *count = 0;
        if (bytes) *bytes = 0;
        return Ok;
    }
    inline Status GetImageEncoders(UINT, UINT, ImageCodecInfo*) { return Ok; }
    inline Status GdiplusStartup(ULONG_PTR* token, const GdiplusStartupInput*, void*)
    {
        if (token) *token = 0;
        return Ok;
    }
    inline void GdiplusShutdown(ULONG_PTR) {}

    class Bitmap
    {
    public:
        Bitmap(int, int, int, int, BYTE*) {}
        Status GetLastStatus() const { return Ok; }
        Status Save(const wchar_t*, const CLSID*, void*) { return GenericError; }
    };
}  // namespace Gdiplus
