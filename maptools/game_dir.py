"""Locate the RA2/YR install that holds the original ``.mix`` archives.

**Classification: class D -- environment plumbing** (rounds 101, 177, 197/256).  Nothing here is
map logic: it answers "where is the game installed", for the TMP extractor and the previewer.  By the
class-D criterion it needs no disassembly citation, and none is possible -- this is a property of how
this repository finds assets, not of the game engine.

Both the TMP extractor (`maptools.theater_assets`) and the CNCMaps previewer
(`maptools.cncmaps_render`) need the same thing: the directory containing
``ra2.mix`` / ``ra2md.mix``.  The lookup rules live here once so the two paths
cannot drift apart.

The game install is treated as **read-only reference material**: nothing in this
project ever writes into it.
"""

from __future__ import annotations

import os
from pathlib import Path

#: Environment variable that points at the RA2/YR install holding the .mix files.
MIXDIR_ENV = "RA2_MIXDIR"

#: Places the game install is looked for when the environment does not say.
MIXDIR_CANDIDATES = (
    Path.home() / "RA2MD",
    Path.home() / "Westwood",
    Path.home() / ".wine" / "drive_c" / "RA2MD",
)


def looks_like_game_dir(path: Path) -> bool:
    """True when *path* holds a RA2/YR archive (``ra2.mix`` or ``ra2md.mix``)."""
    return (path / "ra2.mix").is_file() or (path / "ra2md.mix").is_file()


def find_game_dir(explicit: Path | str | None = None) -> Path | None:
    """Locate the directory holding ra2.mix / ra2md.mix, or ``None``.

    Resolution order: *explicit* argument, then ``$RA2_MIXDIR``, then the usual
    install locations.  A candidate only counts when it actually contains a
    game archive, so a stale ``~/RA2MD`` directory does not silently win.
    """
    if explicit is not None:
        candidate = Path(explicit)
        return candidate if candidate.is_dir() else None
    from_env = os.environ.get(MIXDIR_ENV)
    if from_env:
        candidate = Path(from_env)
        if candidate.is_dir():
            return candidate
    for candidate in MIXDIR_CANDIDATES:
        if looks_like_game_dir(candidate):
            return candidate
    return None
