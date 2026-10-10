// Exhaustive geometry test for engine/src/mirror.h.
//
// tools/verify_symmetry.py compiles and runs this; it is not a standalone
// product file.  It exists because the mirror mapping is the one piece of the
// symmetry feature that can be settled by arithmetic alone, before any
// generation runs - and because a wrong version of it is silently plausible.
// The 180-degree form went through exactly that: an affine
// (W'+H'-x, W'+H'-y) looks right, is an involution, and drops a row.
//
// What it pins:
//   * |S| == (2W'-1) * H' for every size, i.e. the mapping is stated over the
//     same cell set tools/decode.py reads back out of a written map;
//   * for both kinds: the image of every cell is a cell, the map is injective,
//     and it is an involution (so a pass that swaps pairs may process each pair
//     once);
//   * left-right preserves the 8-neighbourhood exactly - 0 breaks, and it is
//     asserted, because LAT and ramp art is re-derived from neighbours;
//   * 180 degrees does NOT preserve it.  That is asserted as a fact, with the
//     count printed, so nobody re-derives a "fix" for it later: the (c, r) grid
//     it comes from is sheared, and a +1 step in x flips the stagger term p.
//     Anything neighbour-derived must be recomputed after a 180 rotation.

#include "mirror.h"

#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

using mg::CellExists;
using mg::DiamondCellCount;
using mg::MapSymmetry;
using mg::MapSymmetryName;
using mg::MirrorCell;

namespace {

std::map<std::string, long long> g_failures;

void Check(bool ok, const std::string& what)
{
    if (!ok)
        ++g_failures[what];
}

// The affine form that looks right and is wrong: kept as a guard so that a
// future "simplification" back to it fails here instead of in a rendered map.
bool Affine180(int W, int H, int x, int y, int* ox, int* oy)
{
    if (!CellExists(W, H, x, y))
        return false;
    const long long k = static_cast<long long>(W) + H;
    *ox = static_cast<int>(k - x);
    *oy = static_cast<int>(k - y);
    return CellExists(W, H, *ox, *oy);
}

}  // namespace

int main()
{
    const int widths[] = {5, 6, 7, 64, 65, 101, 132, 251};
    const int heights[] = {13, 14, 15, 72, 73, 113, 259};

    long long sizes = 0, cells = 0;
    long long lrBreaks = 0, rotBreaks = 0, affineMisses = 0;

    for (int W : widths)
    {
        for (int H : heights)
        {
            ++sizes;

            // ---- the diamond itself ------------------------------------
            std::vector<std::pair<int, int>> cellsOfS;
            for (int x = 1; x <= W + H + 2; ++x)
                for (int y = 1; y <= W + H + 2; ++y)
                    if (CellExists(W, H, x, y))
                        cellsOfS.emplace_back(x, y);
            cells += static_cast<long long>(cellsOfS.size());
            const std::set<std::pair<int, int>> S(cellsOfS.begin(), cellsOfS.end());

            Check(static_cast<long long>(cellsOfS.size()) == DiamondCellCount(W, H),
                  "[set] |S| == (2W'-1)*H'");

            for (MapSymmetry kind : {MapSymmetry::AxialLeftRight,
                                     MapSymmetry::Rotational180})
            {
                const std::string kn = MapSymmetryName(kind);
                std::set<std::pair<int, int>> image;
                long long adjacencyBreaks = 0;

                for (const auto& p : cellsOfS)
                {
                    int mx = 0, my = 0, bx = 0, by = 0;
                    if (!MirrorCell(W, H, kind, p.first, p.second, &mx, &my))
                    {
                        Check(false, kn + ": mirror left the diamond");
                        continue;
                    }
                    image.insert({mx, my});

                    Check(MirrorCell(W, H, kind, mx, my, &bx, &by)
                              && bx == p.first && by == p.second,
                          kn + ": involution");

                    for (int dx = -1; dx <= 1; ++dx)
                    {
                        for (int dy = -1; dy <= 1; ++dy)
                        {
                            if (!dx && !dy)
                                continue;
                            const int nx = p.first + dx, ny = p.second + dy;
                            if (!CellExists(W, H, nx, ny))
                                continue;
                            int nmx = 0, nmy = 0;
                            if (!MirrorCell(W, H, kind, nx, ny, &nmx, &nmy))
                                continue;
                            const int ex = nmx - mx, ey = nmy - my;
                            if (ex < -1 || ex > 1 || ey < -1 || ey > 1)
                                ++adjacencyBreaks;
                        }
                    }
                }

                Check(image.size() == cellsOfS.size(), kn + ": injective");
                Check(image == S, kn + ": onto (image == S)");

                if (kind == MapSymmetry::AxialLeftRight)
                {
                    lrBreaks += adjacencyBreaks;
                    Check(adjacencyBreaks == 0, "LR: 8-neighbourhood preserved");
                }
                else
                {
                    rotBreaks += adjacencyBreaks;
                    if (W == 64 && H == 72)
                        std::printf("  180 at 64x72 breaks the 8-neighbourhood %lld times\n",
                                    adjacencyBreaks);
                }
            }

            for (const auto& p : cellsOfS)
            {
                int mx = 0, my = 0;
                MirrorCell(W, H, MapSymmetry::AxialLeftRight, p.first, p.second, &mx, &my);
                Check(mx == p.second && my == p.first, "LR: is the pure swap (x,y)->(y,x)");
            }

            for (const auto& p : cellsOfS)
            {
                int mx = 0, my = 0;
                if (!Affine180(W, H, p.first, p.second, &mx, &my))
                    ++affineMisses;
            }
        }
    }

    Check(affineMisses > 0, "guard: the affine (W'+H'-x, W'+H'-y) form is not a bijection");

    std::printf("  %lld map sizes, %lld cells\n", sizes, cells);
    std::printf("  LR   breaks the 8-neighbourhood: %lld  (must be 0)\n", lrBreaks);
    std::printf("  180  breaks the 8-neighbourhood: %lld  (measured fact, not 0)\n", rotBreaks);
    std::printf("  affine form leaves the diamond: %lld  (must be > 0)\n", affineMisses);

    if (g_failures.empty())
    {
        std::printf("  geometry OK\n");
        return 0;
    }
    for (const auto& kv : g_failures)
        std::printf("  FAILED %-44s %lld\n", kv.first.c_str(), kv.second);
    return 1;
}
