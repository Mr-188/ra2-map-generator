#!/bin/sh
# Apply this repository's patches to the reference implementation.
#
# The reference sources are not ours and are not committed -- reference_impl/ is
# git-ignored, and it has to be fetched separately (see docs/DEPLOY.md).  A few
# lines of it do have to be adjusted for this repository to build, and for the
# size limits to exist in exactly one place.  Those adjustments live here as
# ordinary patch files so that a fresh checkout reproduces them instead of
# depending on somebody's working copy.
#
#   sh tools/apply_reference_patches.sh
#
# Idempotent: a patch that is already applied is skipped.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REF=${MG_REFERENCE_DIR:-$ROOT/reference_impl/src/MapGenerator}
DIR=$ROOT/engine/reference_patches
PARENT=$(dirname "$REF")

if [ ! -d "$REF" ]; then
    echo "reference sources not found: $REF" >&2
    echo "  fetch them first; see docs/DEPLOY.md section 2" >&2
    exit 2
fi

found=0
for p in "$DIR"/*.patch; do
    [ -f "$p" ] || continue
    found=1
    name=$(basename "$p")

    # Already applied?  Ask in BOTH directions, because a later patch in this
    # directory may legitimately change the context an earlier one needs:
    #   * a clean reverse dry-run means the patch is in place;
    #   * otherwise, a forward dry-run that patch refuses as "reversed or
    #     previously applied" means the same thing.
    # Deciding with dry runs alone is deliberate.  A real forward run against an
    # already-applied patch cannot ask, so it skips the hunks and writes .rej
    # files into reference_impl/, leaving the tree littered and the script
    # reporting success.  -r /dev/null means even a failing dry run cannot write
    # anything.
    if patch -p1 -R --dry-run -r /dev/null -d "$PARENT" < "$p" >/dev/null 2>&1; then
        echo "  [skip]  $name (already applied)"
        continue
    fi
    forward=$(patch -p1 --dry-run -r /dev/null -d "$PARENT" < "$p" 2>&1) || true
    if printf '%s\n' "$forward" | grep -q "previously applied"; then
        echo "  [skip]  $name (already applied)"
        continue
    fi
    if printf '%s\n' "$forward" | grep -q "FAILED"; then
        # Say so instead of applying half of it: this is what "the patches do not
        # fit this copy of the reference sources" looks like.
        echo "  [FAIL]  $name does not fit $PARENT" >&2
        printf '%s\n' "$forward" | sed 's/^/          /' >&2
        echo "          the sources are probably not the revision these patches were made against" >&2
        exit 1
    fi

    echo "  [apply] $name"
    patch -p1 -d "$PARENT" < "$p"
done

[ "$found" = "1" ] || { echo "no patches in $DIR" >&2; exit 2; }
echo "[patch] the reference implementation matches this repository"
