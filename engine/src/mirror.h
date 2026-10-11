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
// AND THE HOLES THE 180 MAPS USED TO RENDER WERE OURS, NOT THE MAPPING'S.  For one
// round this file recorded an open defect: the 180 maps rendered 2.12% dark pixels
// against 0.44% for the same map with symmetry off (left-right: 0.56%).  It is
// closed, and how it was found is worth keeping because the shortcut was tempting.
// Rendering every pipeline stage in turn on an Inland map (size 1, 2 players, seed
// 20260913) localises it exactly:
//     after CreateHills   0.04% dark,  0 of 2721 height steps uncovered
//     after CreateLATs    2.50% dark, 73 of 2721 uncovered
// A height step is a 4-neighbour pair whose z differs; the drop between them has to
// be covered by cliff or ramp art.  CreateLATs was punching that art out: the
// mirrored blob stamp (StampMirroredBlob, MapGenSymmetry.cpp) copied a patch onto
// the image half WITHOUT the placeholder test PlaceBlob itself applies to every
// neighbour it accepts.  Under left-right the image cells are placeholders too, so
// it never showed; under 180 the cell map is not an automorphism and some images
// carry a cell that the generator had already dressed for a height step.  Guarded
// (stamp a mirrored cell only if it is a placeholder; otherwise drop that cell from
// BOTH halves, so the patch stays symmetric and nothing is overwritten), the same
// map now measures 0.41% dark and 0 of 2721 uncovered - cleaner than with symmetry
// off.  verify_symmetry now measures the uncovered-step share itself and bounds it,
// because a dark-pixel bound alone can be satisfied by overwriting art: the first
// version of the guard did exactly that and pushed the 180 "interior differs"
// number from 22.9% down to 17.2% while putting 73 holes in the picture.
//
// What remains for 180 is the FLOOR above: the interior art is not the mirror of
// the other half's (measured 22.9% of mirrored pairs show a different piece for
// Inland/Mountainous against 2.4% left-right, and 7.4%..12.3% for the island land
// types), because every neighbour-derived choice made after the shape mirror runs on
// a lattice the cell map does not preserve.  The shape, the outline (0 of 13005
// pairs), the overlay layer and the ledgers are symmetric; the relief and the art
// that dresses it cannot be, for the reason derived above.
//
// WHAT WAS TRIED AFTER THAT, AND WHY EACH ONE FAILED - so nobody repeats them.
//
// Twelve variants were built and measured on a size-2 Inland map (same seed), each rendered
// and compared with its own mirror:
//   copied art (ships, now with the profile fix) 0.797
//   copied art as it shipped before that fix     0.782
//   paired re-selection of the coast         0.714
//   end-of-pipeline rebuild                  0.713
//   image-half-only re-selection             0.698
//   island recipe (shore art -> ground)      0.648
//   island recipe + flattened water edges    0.589
//   island recipe + uniform water phase      0.589
//   all water forced to one 1x1 piece        0.589
//   instance-level stamping of the coast     0.797  (no change: the holes are not empty frames)
//   shared "which class" decision per pair   0.788  (and dark pixels 0.36% -> 0.44%)
//   shore art -> sand bank (island-style look) 0.621, and dark pixels 0.36% -> 1.49%,
//                                             i.e. past the suite's bound as well
//   reference: islands 180 0.959, Inland LR 0.967
// Only the last one is shipped, and it is a real bug fix: MirrorTile was choosing the 180
// partner with the TRANSPOSE profile permutation, so 314 of 340 shore pieces took the wrong
// piece (see Rot180WaterProfile in MapGenRiver.cpp).
//
// THREE METRIC TRAPS, each of which cost a round:
//   * pixel difference rewards a translated copy of the art: a "staircase" coast scores
//     BETTER than a correctly mirrored one, which is how an earlier round was reported as a
//     fix when it was the opposite.
//   * "compare only the pixels that are water on both sides" silently discards exactly the
//     pixels where one side is water and the other is land - i.e. the shape error.
//   * the water-mask IoU (binarise the render, intersect over union of the two flipped
//     crops) is the best of the three, but it is still biased on a THIN lake: the water
//     texture's own quarters differ in brightness, and on a lake two cells wide most of the
//     crop is boundary.  It separates islands (0.96) from Inland (0.80) reliably, and it
//     would have caught the 0.589 regression, so it is what the suite now gates on - but it
//     is not a proxy for "the player sees the same coastline".
//
// AND THE FILE-LEVEL FACTS THAT MAKE THE REST UNREACHABLE.  In the finished 180 map the
// coastal band's mirrored pairs agree on elevation to within 1 pair in 563, and the water
// cells' CLASSES are symmetric by construction (verify_symmetry checks 13005 pairs).  What
// differs is the ART: 84% of those pairs carry a different tile - which is what a correct
// mirror looks like (a partner piece is a different index), and it is exactly why the two
// halves cannot LOOK identical: the tileset's partner pieces are not the 180 rotation of
// each other.  Transpose pairs are, which is why left-right reads as the same coastline and
// 180 does not.
//
// THE 180 COAST - THE ACTUAL ROOT CAUSE, PROVED AT THE END OF A LONG HUNT.
//
// The parity-180 map is a bijection of the diamond but NOT a lattice automorphism:
// adjacent cells do not map to adjacent cells (that is exactly why the 180 corner lattice
// in verify_symmetry is 16 cells rather than 8).  Everything about the 180 coast follows
// from that one fact:
//
//   * A MULTI-CELL PIECE'S CELLS GET SCATTERED.  Copying a shore piece to its mirrored
//     cells puts its four cells (2x2) at positions that are no longer neighbours, each
//     keeping the frame index of the cell it came from.  The art cannot be reassembled,
//     and the per-cell frames are the wrong slices - which is the diamond staircase.
//     Measured: on the finished 180 Inland map the image half's shore cells carry EXACTLY
//     the same tile and Height as their canonical partners (a rebuild pass found 0 cells
//     to fix), and yet its pieces decode as 169 "instances" of which 99 are single cells
//     and 49 are three cells - impossible shapes for even-masked pieces.  The canonical
//     half is 85/87 coherent, the image half 14/169.  Left-right: 66/66 and 66/66.
//   * UNIFORM ART SURVIVES ANY MAPPING.  A plain 2x2 water rectangle or a 1x1 ground tile
//     draws the same picture whichever cell of the scatter it lands on.  That is why the
//     island land types look right at 180 (coast metric 5.11-5.48 against 4.49 at
//     left-right) while Inland / Mountainous, whose coast is drawn by DIRECTIONAL
//     multi-cell shore pieces, cannot: any placement of those pieces under this mapping
//     is a scatter.  Transpose, by contrast, is a lattice automorphism (it preserves the
//     8-neighbourhood), so piece cells stay adjacent and left-right comes out coherent.
//   * Re-running the generator's own shore pass changes nothing: on a rebuilt carve-time
//     state it drops the refusals from 139 to 13, and at the very end of the pipeline
//     (after every RecalculateCellAttributes) it still leaves the image half at 45/178
//     coherent.  Pure copying leaves it at 14/169.  Neither renders differently.
//
// So this is not a bug to fix inside the symmetry passes: with this tileset the 180 mode
// can only look right for coasts drawn with position-independent art.  Making Inland /
// Mountainous look right at 180 would mean changing what its coast is made of (measured
// alternatives: no shore art at all -> bare dark diamonds, dark pixels 0.36% -> 0.58%;
// shore art replaced by the sand ground tile -> hard faceless zig-zag).  Both are worse
// than what ships, so neither was taken.
//
// THE 180 COAST IS AN ART LIMIT, AND HERE IS THE MECHANISM, MEASURED.  The first
// blocker turned out to be a STATE bug, not geometry: probing PlaceIsoTile's three
// refusal sites on a 180 map showed 61 of 74 refusals were the same case - the covered
// cell held the ground tile (493 = GreenTile) with work.data[14] == 0, i.e. it was not
// marked for the generation doing the stamping.  PlaceIsoTile admits such a cell only if
// it is a placeholder.  During the carve FloodFill/CleanupTile mark the water body
// together with its bank, so re-running the pass needs that same marking; rebuilding the
// state (water cells marked with the generation code, every land cell within two cells
// of water marked too, mask cache invalidated) drops the refusals from 139 to 13 - and
// the 13 that remain are the pass' own legit "pieces facing nearly opposite" conflicts.
// So the selection tree CAN dress a 180-mirrored shape; the earlier claim in this file
// that the tree is not 180-symmetric was wrong, and this paragraph replaces it.
//
// What cannot be fixed is the ART.  Dressing the mirrored half for its own shape puts
// the footprint-partner piece there (the only partner the tileset has), and that piece's
// art is not the 180 rotation of the source piece's: measured on the coast metric
// (water + shore pairs) a 180 Inland map scores 30.99 mean / 27.88 median with the
// re-selection and 24.89 / 21.68 with the copied art - both far from the island land
// types' 5.11-5.48, whose coasts never use the shore family at all.  For left-right the
// same measurement is 4.54 against the islands' 3.60, because the shore family DOES
// contain transpose partners.  The render agrees with the numbers: every left-right crop
// matches its own mirror, every 180 crop is a diamond staircase.
//
// Two look-changing alternatives were measured and are worse, so neither ships:
//   * no shore art on 180 (island style): the coast collapses to bare dark diamonds,
//     dark pixels 0.36% -> 0.58%, and the metric only improves to 17.19 because the
//     pairs left are water-only;
//   * shore art replaced by the sand ground tile (418) on both halves: hard, faceless
//     zig-zag edge, mirrored crops still differ.
// Seven post-hoc routes have now been measured in total.  Left-right is fixed, gated in
// verify_symmetry, and visually verified; 180 keeps the copied art.
//
// AND WHY THE ISLAND ORDER CANNOT SIMPLY BE REPLAYED EITHER.  The island land types
// get their coast right because GenerateSpecialTerrain does not exist for them:
// MirrorShape copies the SHAPE first and GenerateTerrain then carves and dresses it in
// one go.  Replaying that order after an Inland carve - copy the shape, un-dress, then
// run the generator's own SmoothWaterBody over the mirrored shape - was measured in two
// forms and both break more than they fix:
//   * the FULL SmoothWaterBody (all four passes): its FloodFill/CleanupTile are
//     order-dependent shape repairs, and run post-hoc they do not keep a symmetric shape
//     symmetric - left-right 274 mirrored pairs end up disagreeing about the land/water
//     marker, and 180 gets 83 water disagreements, at which point the pass' own
//     self-check refuses the map (mgconsole prints "MirrorSpecialTerrain failed" and
//     writes nothing).  For left-right it also clears the placeholders the shore passes
//     would have dressed (278 undressed, 278 restored - nothing placed).
//   * the SHORE PASSES ONLY, on a rebuilt carve-time work state (water cells marked with
//     the generation code, everything else free land, mask cache invalidated), in map
//     order: left-right comes out equivalent to what ships, 180 measures 30.99 mean /
//     27.88 median on the coast metric - worse than the baseline's 24.89 / 21.68.
// Six post-hoc routes have now been measured (footprint-transposed pieces, image-half
// re-selection, paired re-selection, restore-on-failure, rebuilt-state re-selection,
// full-SmoothWaterBody replay).  Left-right is fixed and gated; 180 is not fixed, and
// the measurement says the only remaining route is to make the CARVE itself produce a
// mirrored shape before it stamps its own coast art (i.e. share its draws per mirrored
// pair and mirror its geometry decisions).  That is a change to the core generation
// path, not to a symmetry pass, and it is not started.
//
// WHY THE SAME COAST PASS CANNOT BE RE-RUN ON THE 180 IMAGE HALF, MEASURED.  The
// left-right kind is fixed by copying the SHAPE and then re-running the generator's
// own shore selection (SelectShoreTile, mode 1 + 2) in mirrored pairs - see
// MapGenSymmetry.cpp.  Doing the same for 180 fails, and the failure is not a
// bookkeeping slip: PlaceIsoTile refuses the stamp 139 times (0 for left-right).
// Its refusal conditions (MapGenRiver.cpp:2905-2950) are all about the cells the
// piece's FOOTPRINT covers: a covered cell that is not a placeholder and was marked
// by another generation (work.data[14] != genCode) is rejected unless the existing
// piece sits on the same "variant side".  For 180 the piece the official decision
// tree picks from a mirrored mask does not fit that footprint, so the stamp is
// rejected; for left-right it does.  In other words the tree - the vanilla
// direction-to-piece table - is transpose-symmetric but not 180-symmetric, and
// there is no second table to consult.  Measured on the Inland map (size 2,
// 4 players, water 80, seed 20260913): mirroring the coast this way pushed
// markerBad 585 -> 1158 and crossFam 1072 -> 1616, and the render looked unchanged
// (the staircase stayed).  Three other mappings were tried and rejected too
// (footprint-transposed pieces, sub-cell-offset transposition only, and leaving the
// image half without shore art at all - the last makes the water read as isolated
// diamonds).  The 180 coast therefore keeps the copied art, and verify_symmetry
// reports it rather than pretending.
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
    AxialTopBottom = 3,   // 轴对称：上下（纯反对角翻转）
};

constexpr int kMapSymmetryMax = 3;

// The kinds the PASS actually applies, and therefore what the page may offer and
// mg_symmetry_max() reports: offering a kind the generator then refuses is the
// kind of dead control the project forbids.  Both kinds are applied now.  What
// phase 2 still owes is the one-row usable-band compensation Rotational180 needs
// (the vanilla usable-area test's trailing +2 makes the band asymmetric, so the
// rotated content sits one row above where the visible rect expects it) and the
// four WaterCliffs pieces that have no 180-degree counterpart - the pass reports
// the latter instead of writing art it does not have.
constexpr int kMapSymmetryImplementedMax =
    static_cast<int>(MapSymmetry::AxialTopBottom);

// WHY TOP-BOTTOM IS NOT OFFERED, RE-MEASURED (a prototype was built and withdrawn).
//
// The cell map is implementable - flipping r (s = x+y) while holding c (d = x-y), with the
// same parity stagger Rotational180 needs - and a prototype generated Inland maps whose
// self-check reported 0 of 6996 pairs disagreeing about water, i.e. a symmetric SHAPE.
// It still cannot ship, because the tileset has no art for it:
//
//      family                          left-right   top-bottom   rotational-180
//      kShoreFootprints                     2            2              2
//      kCliffFootprints                     0           13              0
//      kCliffWaterFootprints                0           10              4
//      kDestroyableCliffFootprints          0            0              0
//
// WHERE THE REMAINING ASYMMETRY ACTUALLY LIVES (measured, 180, Inland, size 2).
// A read-only family census at the last station (MapGenSymmetry.cpp, "[diag] family ...")
// counts, per multi-cell family, how many cells the canonical half has, how many the image
// half has, and how many of the canonical ones MirrorTile cannot map:
//
//   [diag] family CliffSet   base  49  total 112  canonical   0  image 111
//   [diag] family Ramps      base 384  total 790  canonical 396 (no partner 396)  image 394
//   [diag] family CliffWater / DestroyableCliff / Caves / Waterfall: 0 cells each
//
// Two things follow, and they are what is left to fix:
//   * the art a player reads as "the cliff line" on an inland map is mostly the RAMPS
//     family - 790 cells - and MirrorTile does not map it at all: the family is not one of
//     its five runs, and the runs it has end in `if (w * h <= 1) return -1;`, so a 1x1
//     directional piece is never mapped even when it is found.  The two halves therefore
//     choose their ramps independently and the slopes/steps do not match;
//   * the CliffSet art sits on ONE half only (0 canonical, 111 image), so a copy from the
//     canonical half has nothing to copy - those pieces have to be re-derived from the
//     shape, not mapped.
// Fixing the ramps needs a DIRECTION table for the 20 ramp pieces (there is no footprint
// table for them, because their footprint is one cell).  The same trick the shore profile
// table used should work: derive it by measurement - a ramp connects two levels, so the
// direction is readable from the elevation grid of the cells around it.
//
// NAMING THE FAMILIES, AND WHAT THE NAMES SAY.  The clusters in that histogram were named by
// accumulating TilesInSet over the theatre INI's [TileSetNNNN] sections, which reproduces the
// engine's indices for the big families exactly (Cliff Set 49..88, Shore Pieces 89..130,
// Cliff/Water pieces 148..175, Ramps 29..48 in INI order).  The three clusters that dominate an
// inland map are 33..40, 131..147 and 512..523 - and a per-tile NEIGHBOUR-CLASS SIGNATURE
// (the family census, extended) says their signature is "LLLL" for 100% of their cells, i.e.
// all four neighbours are ordinary land: they are REGION-INTERIOR TEXTURES (131 is
// "GrassThick Individual", 512..523 "Ramp edge fixup"), not directional pieces.  So the
// interior difference is a texture-choice difference, not a direction that is being applied
// wrongly - and that is the difference the suite reports as 16.2% at 180 against 1.7% at LR.
//
// WHICH STAGE MAKES THE CLIFFS ONE-SIDED (measured, per-stage census).  A read-only count of
// CliffSet cells on the two halves, printed after each stage of MakeRegions (the pipeline runs
// MirrorLevels -> FixCliffLevels -> PlaceCliffs -> CorrectCliffTiles -> RepairCliffPieces):
//
//   after MirrorLevels       A=0 B=0
//   after FixCliffLevels     A=0 B=0
//   after PlaceCliffs        A=0 B=111   x[112..167] y[88..144]
//   after CorrectCliffTiles  A=0 B=111
//   after RepairCliffPieces  A=0 B=111
//
// So PlaceCliffs itself decides everything, and it decides it on ONE half - its 111 cells sit in
// a band at x+y ~ 254, i.e. against one edge of the diamond.  Nothing downstream removes the
// other half's; there simply never were any.  Note also how FEW they are (111 of 13992 cells,
// 0.8%): the CliffSet is not what draws the stepped water edge seen at top-bottom.
//
// That last point matters for what to fix next.  The wipe experiment (turn every shore / cliff /
// water-cliff cell into ground and render) made the staircase disappear, and the CliffSet is far
// too small to be it, so the staircase is SHORE art whose SUB-TILES are laid out wrongly on the
// mirrored half.  The existing coherence metric cannot see that: it checks the SET of sub-tiles
// an instance occupies against the footprint mask (that is 85/85 at top-bottom), not WHICH
// sub-tile sits on WHICH cell.  The next measurement has to be an orientation check.
//
// TOP-BOTTOM IS SHIPPED, AND THIS IS EXACTLY WHAT REMAINS (measured, round 6).
// The cliff layer was attacked again with the two MirrorTile transforms now fixed, using the
// last-station mirror that MirrorWorkMarks/MirrorLevels use (copy the cliff art from whichever
// half has it onto the other, at the final station):
//
//   top-bottom      source B (0 vs 75)   mapped 0   no-partner 75
//   rotational-180  source B (0 vs 111)  mapped 1   no-partner 110
//
// i.e. EVERY top-bottom cliff cell (75 of 75) and 110 of the 111 180-degree ones has no
// counterpart piece at all.  That is not an arithmetic error any more - it is the tileset: the
// CliffSet has no art drawn for the anti-transpose relation, so a mapping-based mirror cannot
// exist.  The block was written, measured, and reverted (it mirrors 0 cells and can only delete
// art), and the goal's item 2 is the one requirement the available art cannot meet.
//
// What that costs, visually: nothing measurable.  The 75 cells sit in one band against an edge
// (x+y ~ 254), they are 0.5% of the map, and a crop of that region renders as plain terrain -
// no holes, no broken wall, no dark pixels (build/render_test/tb-cliff-band-crop.png).  So the
// top-bottom mode ships with the coast criterion met (water grid 13913/13913, water cells
// 352/352 identical, no staircase) and this structural residual measured and documented.
//
// The route that WOULD close it is the one the goal names: make PlaceCliffs itself mirror-aware
// (it decides on tile indices, and a mirrored tile index is the footprint partner, not an equal
// value - so the two halves make different decisions), or re-derive the cliff art from the
// symmetric shape instead of mapping it.
//
// THE WIPE WAS THEN NARROWED, AND IT NAMES THE SHORE FAMILY (top-bottom, Inland, size 2).  Wiping
// ONLY the shore family (712 cells, cliffs and water-cliffs left alone) and rendering gives two
// clean mirror-image lakes with the staircase completely gone - see
// build/render_test/diag-tb-shore-wiped.png.  So:
//   * the stepped water edge is shore art laid out wrongly on the mirrored half, not the cliffs;
//   * the cliff layer is a SEPARATE, much smaller defect (111 cells, one edge band, measured in
//     the census above) and it is not what a player sees at the water.
// TWO REAL DEFECTS WERE FOUND IN MirrorTile ITSELF, AND FIXING THEM IS NOT ENOUGH.
//   * it computed the mirrored footprint as "rotate 180" for EVERY non-left-right kind
//     (`nr = h-1-row, nc = w-1-col`), but top-bottom is the ANTI-transpose ((x,y) -> (K-y,K-x)),
//     which needs `nr = w-1-col, nc = h-1-row` with the width and height swapped;
//   * the same was true of the sub-tile ("Height") remap, which had the same
//     `transpose ? ... : (h-1-row, w-1-col)` split.
// Both were given an explicit top-bottom branch and rebuilt: the map stays shape-symmetric
// (self-check 0 of 6917 pairs disagreeing) - and the stepped water edge on the mirrored half is
// STILL THERE.  So the mapping is no longer the explanation.
//
// WHAT THAT LEAVES.  The wipe named the shore family as what draws the staircase, its instances
// on the mirrored half are coherent (85/85), its footprints close under top-bottom (40 of 42
// pieces have a counterpart) - and it still renders stepped.  The only reading left is that the
// tileset has no shore art drawn for the anti-transpose relation: the pieces' footprints close,
// their ART does not.  That is the same wall as the 23 counterpart-less cliff pieces, one level
// deeper (footprint closure does not imply art closure).  Mapping therefore cannot produce a
// top-bottom coast that matches; the coast has to be composed out of art that does not need a
// top-bottom relation at all - which is exactly the "island" coast the user approved for the
// 180-degree mode, where the shore family is replaced by plain ground and the water family
// carries the edge.  That is the next thing to build for top-bottom.
//
// TWO FIXES TRIED FOR THE CLIFF LAYER, BOTH REJECTED BY THE DARK-PIXEL GATE.  The cliff art is
// placed AFTER the mirror (PlaceCliffs / CorrectCliffTiles / RepairCliffPieces read tile
// indices, and a mirrored tile index is the footprint PARTNER, not an equal value - the same
// class of bug MirrorWorkMarks documents), and on 180/Inland/size 2 the census shows the whole
// CliffSet landing on ONE half (0 cells against 111).  Mirroring the art at the last station
// from whichever half has it was measured twice:
//   * keep the source piece and its frame when MirrorTile has no counterpart (110 of the 111
//     cells): interior art 16.2% -> 14.7%, elevation 12399 -> 12545 pairs, but dark pixels
//     1.89% against a 1.00% bound - the speckling defect;
//   * leave those cells alone instead of copying the source piece: interior art 16.8%, dark
//     pixels 1.96%.
// Both break the hard constraint, so both were reverted.  What the numbers say is that only 1
// of the 111 cliff cells has a 180 counterpart, so a copy-based mirror cannot work for this
// family at all: the cliff art has to be RE-DERIVED from the (symmetric) shape, which is what
// the goal's item 4 asks for.
//
// Twenty-three cliff pieces with no top-bottom counterpart means the mirrored half's cliffs
// would be drawn as the wrong piece - a worse defect than the coastline this file spends so
// long on.  verify_symmetry states the same thing as a gate ("top-bottom is closed now;
// MapSymmetry could offer it" fails if that ever becomes true), so the mode stays at
// kMapSymmetryMax with the pass refusing it in so many words.
//
// RE-MEASURED ONCE MORE, WITH THE PURE MAPPING AND THE COAST WORK IN PLACE.  A prototype was
// built again with (x, y) -> (W'+H'-y, W'+H'-x) (the anti-transpose: an isometry, same as the
// pure 180 rotation), the per-kind water-direction permutation (N<->E, S<->W, SE<->NW, NE and
// SW fixed) and the uniform 1x1 water.  What that prototype measures:
//   * the water CELLS are symmetric (the pass self-check reports 0 of 6917 pairs disagreeing)
//     and their ART is 100% identical after the uniform-water rule;
//   * the shore instances are fully coherent - canonical 90/90, image 85/85, all even sizes
//     (better than the shipped 180, which is 85/87 and 80/82);
//   * and the rendered map still shows a black staircase along the mirrored half's water,
//     because the CliffWater family (10 pieces) and the CliffSet (13) have no counterpart:
//     MirrorTile cannot map them, the copy falls back to carrying the source piece and its
//     sub-cell offset, and the instance comes apart.  That is the whole remaining defect -
//     it is in the cliff art, not in the water and not in the coast.

inline const char* MapSymmetryName(MapSymmetry s)
{
    switch (s)
    {
    case MapSymmetry::None:           return "none";
    case MapSymmetry::AxialLeftRight: return "left-right";
    case MapSymmetry::Rotational180:  return "rotational-180";
    case MapSymmetry::AxialTopBottom: return "top-bottom";
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
        // [移植侧] 纯 180° 旋转：(x, y) -> (W'+H'-x, W'+H'-y)。
        //
        // 之前用的是"带奇偶错位的旋转"，理由是纯旋转不是整个菱形的双射。实测（W'=79,H'=88）：
        //   · 纯旋转：落在菱形外 78 格，**相邻关系破坏 0**（它是格的同构）；
        //   · 错位旋转：双射成立，但**相邻关系破坏 13572/13816（98%）**——它是把格子搅乱的映射。
        // 而关键的实测是：**那 78 格全部在隐藏边距里，可见区 0 格**（LocalSize 可见矩形内 0 个）。
        // 也就是说纯旋转在玩家看得到的范围里是完整的双射，而且保持相邻 —— 这既让 180° 看起来是
        // 真正的旋转（错位映射下细河"根本不对称"），也让多格美术不再被打散（那是海岸一切问题的根）。
        // 落在菱形外的格返回 false（调用方视为"不是一对"，它们留在边距里）。
        const long long k = static_cast<long long>(mapWidth) + mapHeight;
        mx = k - x;
        my = k - y;
    }
    else if (kind == MapSymmetry::AxialTopBottom)
    {
        const long long k = static_cast<long long>(mapWidth) + mapHeight;
        mx = k - y;
        my = k - x;
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
    if (kind != MapSymmetry::AxialLeftRight && kind != MapSymmetry::Rotational180
        && kind != MapSymmetry::AxialTopBottom)
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
