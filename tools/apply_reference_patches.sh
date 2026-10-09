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

    # Already applied?  A clean reverse-dry-run means the patch is in place.
    if patch -p1 -R --dry-run -d "$PARENT" < "$p" >/dev/null 2>&1; then
        echo "  [skip]  $name (already applied)"
        continue
    fi

    echo "  [apply] $name"
    patch -p1 -d "$PARENT" < "$p"
done

[ "$found" = "1" ] || { echo "no patches in $DIR" >&2; exit 2; }
echo "[patch] the reference implementation matches this repository"
