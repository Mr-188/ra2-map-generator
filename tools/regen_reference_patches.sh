#!/bin/sh
# Regenerate engine/reference_patches/ from this machine's reference sources.
#
# The reference sources are not ours and are not committed (reference_impl/ is
# git-ignored); only the patches are.  So every time we touch reference_impl/,
# the patches have to be regenerated -- otherwise the change exists on one
# machine only and a fresh checkout does not build.  This script does that, and
# then PROVES it: it applies the fresh patches to a clean upstream copy and
# requires the result to be byte-identical to the live sources.
#
#   sh tools/regen_reference_patches.sh                    # uses the cached upstream
#   MG_UPSTREAM_DIR=/path/to/MapGenerator sh tools/regen_reference_patches.sh
#   sh tools/regen_reference_patches.sh --bootstrap        # rebuild the cached upstream
#                                                          # from the committed patches
#
# Patch layout, and why it is two patches and not one: patch 1 is a diff from the
# CLEAN upstream, patch 2 is a diff from "clean upstream + patch 1".  Both touch
# MapGen.h / MapGen.cpp / MapGenMapFile.cpp, and if both were diffs from the clean
# upstream, GNU patch would answer "Reversed (or previously applied)" for the
# whole file on the second one and silently drop the rest of it -- a fresh
# checkout then has no MapGenSymmetry.cpp at all.  See apply_reference_patches.sh,
# which now verifies every patch reverse-applies instead of trusting patch(1).
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REF=${MG_REFERENCE_DIR:-$ROOT/reference_impl/src/MapGenerator}
DIR=$ROOT/engine/reference_patches
CACHE=$ROOT/build/ro-sym/upstream/MapGenerator
UP=${MG_UPSTREAM_DIR:-$CACHE}
P1=$DIR/size-limits-single-source.patch
P2=$DIR/symmetry-shape-pass.patch

if [ ! -d "$REF" ]; then
    echo "live reference sources not found: $REF" >&2
    echo "  run sh tools/apply_reference_patches.sh first (see docs/DEPLOY.md 4/4b)" >&2
    exit 2
fi
if [ ! -f "$P1" ] || [ ! -f "$P2" ]; then
    echo "expected both patches in $DIR" >&2
    exit 2
fi

BOOTSTRAP=0
[ "$1" = "--bootstrap" ] && BOOTSTRAP=1
if [ ! -d "$UP" ] || [ "$BOOTSTRAP" = "1" ]; then
    echo "[regen] no upstream at $UP; reconstructing it from the committed patches"
    mkdir -p "$UP"
    cp -r "$REF"/. "$UP"/
    # Reverse order: undo patch 2 (its a-side is upstream + patch 1), then patch 1.
    patch -p1 -R --no-backup-if-mismatch -r /dev/null -d "$(dirname "$UP")" < "$P2" >/dev/null
    patch -p1 -R --no-backup-if-mismatch -r /dev/null -d "$(dirname "$UP")" < "$P1" >/dev/null
    echo "[regen] reconstructed $UP"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# a = clean upstream; b = upstream + patch 1 (patch 2's a-side); c = the live sources.
mkdir -p "$TMP/a" "$TMP/b"
cp -r "$UP" "$TMP/a/MapGenerator"
cp -r "$UP" "$TMP/b/MapGenerator"
(
    cd "$TMP/b"
    patch -p1 --no-backup-if-mismatch -r /dev/null < "$P1" >/dev/null
)

# New patch 1: clean upstream -> patch-1 tree.  New patch 2: patch-1 tree -> live.
# Regenerating patch 1 too (rather than copying it) keeps both files freshly
# derived from the same upstream, so "the patch content matches the sources" is a
# measured fact and not a claim.
( cd "$TMP" && diff -ruN a/MapGenerator b/MapGenerator > "$TMP/p1.new" ) || true
mkdir -p "$TMP/c"
cp -r "$REF" "$TMP/c/MapGenerator"
( cd "$TMP" && diff -ruN b/MapGenerator c/MapGenerator > "$TMP/p2.new" ) || true

[ -s "$TMP/p1.new" ] || { echo "[regen] patch 1 came out empty; upstream is wrong" >&2; exit 1; }
[ -s "$TMP/p2.new" ] || { echo "[regen] patch 2 came out empty; nothing changed?" >&2; exit 1; }

# Only the HUNKS matter to patch(1); the timestamp in each ---/+++ header does
# not.  Re-running the generator therefore must not rewrite a patch whose hunks
# are unchanged -- otherwise every round turns a one-line source edit into a
# whole-file diff in git.
norm() { sed -E 's/^([+-]{3} [ab]\/[^\t]*)\t.*/\1/' "$1" > "$1.norm"; }
write_if_changed()                                          # new, target, name
{
    norm "$1"
    if [ -f "$2" ]; then
        norm "$2"
        if cmp -s "$1.norm" "$2.norm"; then
            rm -f "$1.norm" "$2.norm"
            echo "[regen] $3 unchanged (hunks identical)"
            return
        fi
        rm -f "$2.norm"
    fi
    rm -f "$1.norm"
    cp "$1" "$2"
    echo "[regen] wrote $3 ($(wc -l < "$2" | tr -d ' ') lines)"
}
# Patch 1 is the stable half: it diffs the CLEAN upstream, so it only changes when
# the size-limit work itself changes.  It is also the a-side of patch 2, so it is
# already in $TMP/b -- rewriting it as a fresh `diff -ruN` would reorder its file
# blocks and turn a one-line source edit into a whole-file git diff.  Keep it when
# it reproduces $TMP/b exactly; regenerate it only when it does not.
keep_p1=0
if [ -f "$P1" ]; then
    mkdir -p "$TMP/chk"
    cp -r "$UP" "$TMP/chk/MapGenerator"
    if patch -p1 --no-backup-if-mismatch -r /dev/null -d "$TMP/chk" < "$P1" >/dev/null 2>&1 \
       && diff -rq "$TMP/chk/MapGenerator" "$TMP/b/MapGenerator" >/dev/null; then
        keep_p1=1
    fi
fi
if [ "$keep_p1" = "1" ]; then
    echo "[regen] size-limits-single-source.patch kept as-is (reproduces upstream + patch 1)"
else
    write_if_changed "$TMP/p1.new" "$P1" "size-limits-single-source.patch"
fi
write_if_changed "$TMP/p2.new" "$P2" "symmetry-shape-pass.patch"

# ---- The round trip: clean upstream + fresh patches must equal the live sources.
mkdir -p "$TMP/rt"
cp -r "$UP" "$TMP/rt/MapGenerator"
MG_REFERENCE_DIR="$TMP/rt/MapGenerator" sh "$ROOT/tools/apply_reference_patches.sh" >/dev/null
if ! diff -rq "$TMP/rt/MapGenerator" "$REF" >/dev/null; then
    echo "[regen] ROUND TRIP FAILED: upstream + patches != live sources" >&2
    diff -rq "$TMP/rt/MapGenerator" "$REF" >&2 || true
    exit 1
fi
echo "[regen] round trip OK: clean upstream + both patches == $REF"
