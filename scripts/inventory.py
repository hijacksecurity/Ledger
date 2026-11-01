"""Count every data surface in the front end, and find the ones nobody indexed.

`docs/DATA-MAP.md` maps a data field to the surfaces that read it, so a change
to one field can be traced to everything downstream. An index goes stale the
moment a panel is added without touching it — and a stale index is worse than
none, because it gets trusted.

This is the check that keeps it honest:

    .venv/Scripts/python.exe scripts/inventory.py          # the table
    .venv/Scripts/python.exe scripts/inventory.py --check  # fail if drifted

Exit code is the number of panels the map does not mention, so it drops into
CI or a pre-commit hook the same way `qa.py` does.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

WEB = pathlib.Path(__file__).resolve().parent.parent / "ledger" / "web"
MAP = pathlib.Path(__file__).resolve().parent.parent / "docs" / "DATA-MAP.md"

#: A panel's title is how the map refers to it, so that is what we extract.
TITLE = re.compile(r"title:\s*'([^']+)'")
PANEL = re.compile(r"panel\(\{")
FIGURE = re.compile(r"\bfigure\(")
TABLE = re.compile(r"data-table|el\('table'")
STRIP = re.compile(r"statStrip\(")


def scan(path: pathlib.Path) -> dict:
    src = path.read_text(encoding="utf-8")
    # Titles inside a panel({...}) call. Good enough: every panel in this
    # codebase either passes a literal title or is deliberately untitled.
    titles = []
    for m in PANEL.finditer(src):
        chunk = src[m.start(): m.start() + 400]
        t = TITLE.search(chunk)
        if t:
            titles.append(t.group(1))
    return {
        "panels": len(PANEL.findall(src)),
        "charts": len(FIGURE.findall(src)),
        "tables": len(TABLE.findall(src)),
        "strips": len(STRIP.findall(src)),
        "titles": titles,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if a panel is missing from DATA-MAP.md")
    args = ap.parse_args()

    views = sorted(WEB.glob("view-*.js"))
    rows = {p.stem.replace("view-", ""): scan(p) for p in views}

    width = max(len(k) for k in rows)
    print(f"{'page':<{width}}  panels  charts  tables  strips")
    total = {"panels": 0, "charts": 0, "tables": 0, "strips": 0}
    for name, r in rows.items():
        print(f"{name:<{width}}  {r['panels']:>6}  {r['charts']:>6}  "
              f"{r['tables']:>6}  {r['strips']:>6}")
        for k in total:
            total[k] += r[k]
    print(f"{'TOTAL':<{width}}  {total['panels']:>6}  {total['charts']:>6}  "
          f"{total['tables']:>6}  {total['strips']:>6}")

    if not args.check:
        return 0

    if not MAP.exists():
        print(f"\nMissing {MAP}")
        return 1

    doc = MAP.read_text(encoding="utf-8")
    missing = []
    for name, r in rows.items():
        for t in r["titles"]:
            # A panel counts as indexed if the map names it anywhere — under a
            # field it reads, or in the per-page table.
            if t not in doc:
                missing.append(f"{name}: {t}")

    if missing:
        print(f"\n{len(missing)} panels are not mentioned in docs/DATA-MAP.md:")
        for m in sorted(missing):
            print(f"   {m}")
        print("\nAdd them under the field they read. A panel nobody indexed is a"
              " panel nobody will think to re-check when that field changes.")
    else:
        print("\nEvery panel is mentioned in docs/DATA-MAP.md.")
    return len(missing)


if __name__ == "__main__":
    sys.exit(main())
