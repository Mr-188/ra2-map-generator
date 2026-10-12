#!/usr/bin/env python3
"""The worker and the page must agree on their message vocabulary.

This exists because of a real defect: several edits to webapp/app.js were made
with a search-and-replace that silently did nothing when the target text did not
match, so the worker posted a `preview` message that the page's switch had no
case for.  Rendering worked perfectly and the page showed nothing at all.

The check is deliberately textual and crude: every `type:` string the worker
posts must appear as a `case` label in app.js.  It cannot prove the payloads
agree, but it catches the exact failure that shipped.

    python3 tools/verify_uicontract.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER = ROOT / "webapp" / "worker.js"
APP = ROOT / "webapp" / "app.js"


def main() -> int:
    for p in (WORKER, APP):
        if not p.exists():
            print(f"missing {p}")
            return 2

    worker = WORKER.read_text(encoding="utf-8")
    app = APP.read_text(encoding="utf-8")

    # postMessage({ type: 'x', ... }) and postMessage({ type: 'x' }, ...)
    posted = set(re.findall(r"type:\s*'([a-zA-Z0-9_-]+)'", worker))
    # what the worker's own fail() emits counts too
    if re.search(r"function fail\(", worker):
        posted.add("error")

    handled = set(re.findall(r"case\s+'([a-zA-Z0-9_-]+)'\s*:", app))

    print(f"  worker posts : {', '.join(sorted(posted))}")
    print(f"  page handles : {', '.join(sorted(handled))}")

    failures = []
    unhandled = sorted(posted - handled)
    if unhandled:
        failures.append(f"the worker posts these and the page ignores them: {unhandled}")

    # A case the worker can never send is dead code, worth reporting but not failing.
    unused = sorted(handled - posted)
    if unused:
        print(f"  (page handles but the worker never posts: {', '.join(unused)})")

    # The page talks to the worker too; those have to be understood as well.
    sent = set(re.findall(r"postMessage\(\{\s*type:\s*'([a-zA-Z0-9_-]+)'", app))
    worker_handles = set(re.findall(r"msg\.type\s*===\s*'([a-zA-Z0-9_-]+)'", worker))
    worker_handles |= set(re.findall(r"if\s*\(msg\.type\s*===\s*'([a-zA-Z0-9_-]+)'\)", worker))
    missing = sorted(sent - worker_handles)
    if missing:
        failures.append(f"the page sends these and the worker ignores them: {missing}")

    # The worker must stay a CLASSIC worker.  The .NET runtime detects its host
    # with `typeof importScripts`, which does not exist in a module worker; it
    # then decides it is an unknown shell environment and hangs during startup
    # with no error at all.  Nothing in the node-based suites exercises a worker,
    # so this is the only guard against that regression.
    if re.search(r"new\s+Worker\([^)]*type:\s*['\"]module['\"]", app):
        failures.append("app.js creates a MODULE worker; the .NET runtime cannot "
                        "detect a module worker and will stall")
    if not re.search(r"new\s+Worker\(", app):
        failures.append("app.js no longer creates a worker at all")
    if re.search(r"^\s*import\s+[^(]", worker, re.M):
        failures.append("worker.js has a static import; a classic worker is a "
                        "script and cannot use one")
    print("  worker mode  : classic, no static imports")

    # The page's 环境 select must not offer the same map twice.
    #
    # Mountainous (value 4) is deliberately NOT listed: every land-type branch in the
    # engine treats 3 and 4 together (MapGenMaking.cpp:65, MapGenRegion.cpp:91,
    # MapGen.cpp:1702, MapGenStartpoint.cpp:2240-2241, ...), and the one table that
    # looks land-type-shaped - the option ranges in MapGenStartpoint.cpp:684-700, whose
    # rows 3 and 4 DO differ - is indexed by the ROLLED option n3
    # (RandomRanged(1,4) -> 1..3, MapGenStartpoint.cpp:670), so row 4 is unreachable and
    # row 3 is shared by both.  Measured: --land 3 and --land 4 are byte-identical over
    # seeds, sizes and symmetry kinds.
    #
    # Two names for one map is what a page must not offer, so this pins the list.  The
    # engine API keeps accepting 4 as an alias (mgconsole --land 4, mg_generate(4)); that
    # is a compatibility decision, not a second environment.
    page = (ROOT / "webapp" / "index.html").read_text(encoding="utf-8")
    land_block = re.search(r'<select id="land".*?</select>', page, re.S)
    if land_block is None:
        failures.append("index.html has no #land select")
    else:
        values = re.findall(r'<option value="(\d+)"', land_block.group(0))
        if values != ["0", "1", "2", "3"]:
            failures.append(
                f"the #land select offers {values}; it must be exactly 0..3. "
                "4 (Mountainous) is the same map as 3 - every land-type branch treats "
                "them together and the option tables are indexed by the rolled n3, not "
                "by the land type - so offering it is a second name for one map")
        else:
            print("  env options  : 0/1/2/3 (4 Mountainous not offered: byte-identical "
                  "to 3 Inland)")

    print()
    if failures:
        print(f"FAILED {len(failures)} checks")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("OK -- the page and the worker agree on their message vocabulary")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
