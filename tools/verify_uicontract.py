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
