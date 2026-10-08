#pragma once
// <objidl.h> replacement: gdiplus.h normally needs IStream/PROPID/byte first.
// The reference only uses GDI+ to write radar_preview.png, a side artifact.
typedef struct _GUID
{
    unsigned long  Data1;
    unsigned short Data2;
    unsigned short Data3;
    unsigned char  Data4[8];
} GUID;
typedef GUID CLSID;
typedef GUID IID;
typedef unsigned long PROPID;
typedef unsigned char byte;
