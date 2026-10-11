// mirror.h - the cell mapping a symmetric map needs.  Engine-owned: this is OUR
// code, not the reference implementation's, so it carries its derivation here
// instead of a disassembly address (AGENTS.md red line 4).
//
// ---------------------------------------------------------------------------
// THE DERIVATION
//
// The generator's cells are not a rectangle.  CellExists (MapGen.h:1738-1747)
// defines the diamond
//
//      W' < x + y <= W' + 2H'      and      |x - y| < W'
//
// with W' = mapWidth = visibleWidth + 4 and H' = mapHeight = visibleHeight + 12
// (CalcMapSize, MapGen.cpp:413-459).  Its size is |S| = (2W' - 1) * H', which is
// exactly what mg_rect_cells() reports and what tools/decode.py reads back out
// of a written map.
//
// The generator's own screen axes are u ~ (x - y) and v ~ (x + y): see
// PatchInBounds mode 1 (MapGen.cpp:1727-1734), PatchDirectionalPriority
// ("u along (x-y)/2, v along (x+y)/2", MapGen.cpp:1760-1782) and the iso-pixel
// HeaderX/HeaderY (MapGenMapFile.cpp:615-630), which is called with the swapped
// argument order HeaderX(c.Y, c.X) at MapGenMapFile.cpp:904-906.
//
// In the logical grid (c, r) - c = the u index, r = the v index - the diamond is
// the rectangle c in [0, 2W'-2], r in [0, H'-1], with
//
//      c = (x - y) + (W' - 1)          r = the cell's index along its anti-diagonal
//
// so c depends on the diagonal d = x - y alone, and r orders the cells that share
// a c by increasing s = x + y.  The two axes are what makes the reflections
// expressible, but the grid is SHEARED: the smallest s on a diagonal is W'+1 when
// s and W'+1 share a parity and W'+2 otherwise, so s = s_min(d) + 2r and a
// reflection of r drags a parity-dependent constant along with it.  That is where
// the p below comes from - it is not an optimisation, it is the stagger.
//
//      AxialLeftRight   c -> 2W' - 2 - c      =>  d -> -d, s unchanged
//                                               =>  (x, y) -> (y, x)
//      Rotational180    c -> 2W' - 2 - c      =>  d -> -d, s -> 2s_min(d) + 2H' - 2 - s
//                       r -> H' - 1 - r          =>  (x, y) -> (W'+H'+p - x, W'+H'+p - y)
//                                                  with p = (x - y + W' - 1) & 1
//
// Both are bijections of S and both are involutions - the test checks every cell
// of 56 map sizes.
//
// ADJACENCY, WHICH DIFFERS BETWEEN THE TWO.  AxialLeftRight is the pure swap, so
// it preserves the 8-neighbourhood exactly (swapping two coordinates cannot change
// |dx| or |dy|).  Rotational180 does NOT: stepping x by +1 flips p, which moves
// the image by 2 in x and 1 in y.  Measured on W'=64, H'=72: 17892 neighbour
// pairs break.  Two consequences, both load-bearing:
//   * per-cell data derived from neighbours (LAT masks, ramp variants, the
//     movement zones) must be RE-DERIVED after a 180 rotation, never carried
//     across - the mirror is a bijection of the cell set, not an automorphism of
//     the adjacency graph;
//   * Phase 1 is left-right precisely so this does not arise: LR keeps the
//     adjacency, so re-deriving is a correctness belt-and-braces there rather
//     than the only thing standing between us and a broken map.
//
// TRAP, recorded because it cost real time: it is tempting to "simplify" the 180
// rotation to (x,y) -> (W'+H'-x, W'+H'-y).  That form is affine, an involution,
// and it passes a casual eyeball check - but it is NOT a bijection of S: the cell
// with s = W' + 2H' lands on s' = W', which CellExists rejects.  The parity term
// is what the sheer grid contributes, and dropping it drops a row.
//
// WHY TOP-BOTTOM IS ABSENT: a top-bottom reflection (r -> H'-1-r with c fixed) is
// a bijection of S too - it is the (W'+H'+p-y, W'+H'+p-x) form - but the tile set
// has no art for the orientations it needs.  Of the 40 CliffSet pieces, only 27
// have a v-flipped counterpart (MapGenRiver.cpp:2590 kCliffFootprints, mask
// transposed per the "bit (row * w + col)" convention documented at
// MapGenRiver.cpp:3830); the other 13 - cliff01/03/04, 09/10/11, 19/20/21,
// 27/28, 31/32 - would have to keep the wrong-facing art.  Left-right and 180
// degrees are closed: 40/40.  The measurement behind that is in
// tools/verify_symmetry.py.
//
// WHAT 180 DEGREES COSTS, MEASURED, AND WHY IT CANNOT BE PAID OFF.  The broken
// adjacency above is not a detail of one pass; it bounds the whole 180 mode.  On
// an Inland map (size 2, 4 players, water 80, seed 20260913, --diag-symmetry) the
// water/land outline does come out symmetric - 0 of 13992 mirrored pairs - because
// MirrorSpecialTerrain copies the half, but the first neighbour-derived stage that
// runs afterwards breaks: PlaceCliffs takes the probe from levelBad 1 / markerBad 0
// to levelBad 72 / markerBad 203, then CreateHills takes it to 500 / 1053 of 6996
// pairs, and the finished map shows a different piece on 17.2% of pairs where the
// same map under left-right shows 2.3% (the island land types: 5.7%..9.4% under
// 180 against 0.1%..0.7% under left-right, measured by
// tools/verify_symmetry.py --score).  Under left-right those same two stages leave
// levelBad and markerBad at 0.
//
// The elevation grid is where it is most visible, and it is not a missing pass.
// FinalizeElevationSlopes (MapGenHills.cpp:982) reads the 2x2 corner block
// e(x,y), e(x+1,y), e(x+1,y+1), e(x,y+1), and MirrorElevationGrid (MapGenHills.cpp
// :1397) mirrors that grid for left-right only, where the corner map is exactly
// (X,Y) -> (Y,X) for every cell.  Under 180 it would have to be the point
// reflection about (k/2, k/2) with k = W'+H'+p, and that maps this cell's block to
// the block of the cell at (k-x-1, k-y-1) - one cell away from the image cell
// (k-x, k-y), because a block spans x..x+1 while the reflection centre falls on a
// grid point.  A constant k would map blocks onto blocks, but k must carry p: with
// p fixed the form is affine and (as measured above) is not a bijection of S - it
// drops a row.  So: a picture rotation and a preserved adjacency are mutually
// exclusive on this diamond, the product offers the bijection, and the interior
// art under 180 has a floor that pairing draws cannot remove.  verify_symmetry
// prints that floor for every land type and bounds it so it cannot regress
// silently; it is not a pass waiting to be written.
//
// AND IT IS NOT ONLY "ART DIFFERS": the 180 maps also RENDER with holes.  Same
// configuration, dark pixels (luminance < 10) as tools/verify_symmetry.py measures
// them: Inland and Mountainous 2.12% against 0.44% for the same map with symmetry
// off, where the left-right map measures 0.56% against the same 0.44%.  Sampling
// each mirrored pair's cell centre (indicative numbers - the cell -> pixel
// projection is approximate) puts the dark cells mostly on ONE side: 92 canonical
// only and 117 image only against 4 dark on both, where the left-right map is 44
// on both against 4 / 27.  So the two halves of a 180 map are not drawn alike.
// What that is NOT is proof the decoded map is bad: the verify_symmetry docstring
// records that a map whose cells mirror exactly can still render 2.30% black,
// because the renderer's outcome depends on position and draw order.  The cause is
// therefore still to be separated, and until it is, this file records the number
// instead of a conclusion: verify_symmetry prints it for every land type and holds
// 180 to a 5% bound (left-right keeps max(1%, 2x plain)).
//
// THE SHAPE OF A REAL FIX, if the holes turn out to be map data: the hill stage's
// per-cell results would have to be produced once and mirrored - Level and Height
// are orientation-free scalars, the slope piece has to be rotated by the 180
// pattern rotation of kSlopeCorners (MapGenHills.cpp:477), and multi-cell pieces
// go through MirrorTile.  Copying only Level, as was tried once, is what made the
// render DARKER (0.39% -> 3.31% on left-right) because the art had already been
// chosen for the old heights.  Left-right does not need any of this: there
// MirrorElevationGrid mirrors the corner grid exactly, and the engine derives
// symmetric art from it for free.
//
// (An earlier revision of this comment claimed the mapping "preserves the
// 8-neighbour adjacency graph" for both kinds.  That is false for 180 - see the
// measurement two paragraphs up, and check_geometry in tools/verify_symmetry.py -
// and it was the reason a pass once assumed re-deriving neighbour data after a 180
// rotation was optional.  It is not.)
// ---------------------------------------------------------------------------

#pragma once

#include <cstdint>

namespace mg {

// The kinds of symmetry the product offers.  Contiguous on purpose: the value
// crosses the CLI (mgconsole --symmetry), the wasm boundary (mg_generate) and
// the page's <select>, so an unused middle value would only be a trap.
enum class MapSymmetry
{
    None = 0,
    AxialLeftRight = 1,   // 轴对称：左右
    Rotational180 = 2,    // 普通对称：旋转 180°
};

constexpr int kMapSymmetryMax = 2;

// The kinds the PASS actually applies, and therefore what the page may offer and
// mg_symmetry_max() reports: offering a kind the generator then refuses is the
// kind of dead control the project forbids.  Both kinds are applied now.  What
// phase 2 still owes is the one-row usable-band compensation Rotational180 needs
// (the vanilla usable-area test's trailing +2 makes the band asymmetric, so the
// rotated content sits one row above where the visible rect expects it) and the
// four WaterCliffs pieces that have no 180-degree counterpart - the pass reports
// the latter instead of writing art it does not have.
constexpr int kMapSymmetryImplementedMax =
    static_cast<int>(MapSymmetry::Rotational180);

inline const char* MapSymmetryName(MapSymmetry s)
{
    switch (s)
    {
    case MapSymmetry::None:           return "none";
    case MapSymmetry::AxialLeftRight: return "left-right";
    case MapSymmetry::Rotational180:  return "rotational-180";
    }
    return "?";
}

// True when (x, y) is a cell of the diamond for this map size.  A transcription
// of CellExists (MapGen.h:1738-1747) - kept here so the mirror can be verified
// on its own, and so a mirror of a non-cell can be rejected instead of silently
// producing an out-of-diamond coordinate.
inline bool CellExists(int mapWidth, int mapHeight, long long x, long long y)
{
    if (x <= 0 || y <= 0)
        return false;
    const long long sum = x + y;
    const long long diff = x - y;
    if (diff >= mapWidth || diff <= -mapWidth)
        return false;
    return sum > mapWidth && sum <= mapWidth + 2LL * mapHeight;
}

// The mirror image of (x, y).  Returns false for MapSymmetry::None, for a
// non-cell input, and for a mirror that lands off the diamond - the caller is
// expected to treat that as a bug rather than as an empty result, because for
// the two kinds above it cannot happen.
inline bool MirrorCell(int mapWidth, int mapHeight, MapSymmetry kind,
                       int x, int y, int* outX, int* outY)
{
    if (kind == MapSymmetry::None)
        return false;
    if (!CellExists(mapWidth, mapHeight, x, y))
        return false;

    long long mx = x;
    long long my = y;

    if (kind == MapSymmetry::AxialLeftRight)
    {
        mx = y;
        my = x;
    }
    else if (kind == MapSymmetry::Rotational180)
    {
        // p is the stagger of the sheared (c, r) grid, not an optimisation; see
        // the derivation above for why (W'+H'-x, W'+H'-y) is not a bijection.
        const long long p = (static_cast<long long>(x) - y + mapWidth - 1) & 1LL;
        const long long k = static_cast<long long>(mapWidth) + mapHeight + p;
        mx = k - x;
        my = k - y;
    }
    else
    {
        return false;
    }

    if (!CellExists(mapWidth, mapHeight, mx, my))
        return false;
    if (outX) *outX = static_cast<int>(mx);
    if (outY) *outY = static_cast<int>(my);
    return true;
}

// The number of cells in the diamond.  Same quantity as mg_rect_cells()
// (wasm_entry.cpp) and as the IsoMapPack5 record count tools/decode.py reads
// back; kept here so the mapping can be checked for being a bijection without
// going through a generation.
inline long long DiamondCellCount(int mapWidth, int mapHeight)
{
    return (2LL * mapWidth - 1) * mapHeight;
}

// SlopeIndex under a mirror.  The ramp art is derived from it (MapGenRecalc.cpp
// :918-965 reads the cell's own value and two neighbours'), and kinds 1/3 and 2/4 are
// each other's mirror: they probe the same two neighbours with the bits the other way
// round.  Used by the special-terrain path (Inland / Mountainous), where the cells are
// copied whole and the ramp tiles are then re-derived from the copied value.
inline int ReflectSlope(MapSymmetry kind, int slope)
{
    if (kind != MapSymmetry::AxialLeftRight && kind != MapSymmetry::Rotational180)
        return slope;
    switch (slope)
    {
    case 1: return 3;
    case 3: return 1;
    case 2: return 4;
    case 4: return 2;
    default: return slope;
    }
}

}  // namespace mg
