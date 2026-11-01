"""Automated quality audit of the running app.

The dev -> test -> fix loop for the front end. `smoke.py` only ever answered
"did it throw?", which a page can pass while being unusable. This asks the
questions a person would ask looking at the screen:

  * Is anything cut off, overlapping, or off the edge?
  * Is any panel empty, still skeletal, or stuck loading?
  * Does every chart say what period it covers?
  * Is text readable against what is behind it?
  * Can a thumb hit the controls on a phone?
  * Does the same number appear twice with two different values?

Run it after every change:

    .venv/Scripts/python.exe scripts/qa.py            # all routes, both themes
    .venv/Scripts/python.exe scripts/qa.py --shots out/   # also write PNGs
    .venv/Scripts/python.exe scripts/qa.py --route week   # one route

Exit code is the number of failures, so it drops straight into a loop.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from collections import defaultdict

from playwright.sync_api import sync_playwright

# Windows consoles default to cp1252 and choke on the report's box drawing.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8000"

ROUTES = ["week", "score", "calendar", "habits", "recovery", "plan", "intent", "insights", "soccer",
          "running", "lifting", "trends", "log", "all", "sync", "add"]

VIEWPORTS = [("desktop", 1440, 1000), ("phone", 390, 844)]
THEMES = ["dark", "light"]

#: Minimum comfortable tap target. Apple says 44, Material 48; 40 is the floor
#: below which a control is genuinely awkward on a phone.
MIN_TAP_PX = 40

#: WCAG AA for body text. Applied to real rendered pairs, not tokens.
MIN_CONTRAST = 4.5
MIN_CONTRAST_LARGE = 3.0

AUDIT_JS = pathlib.Path(__file__).with_name("qa_audit.js").read_text(encoding="utf-8")


def run(routes, themes, viewports, shots: pathlib.Path | None, verbose: bool,
        base: str = BASE) -> int:
    findings: dict[str, list[str]] = defaultdict(list)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for vp_name, width, height in viewports:
            for theme in themes:
                ctx = browser.new_context(
                    viewport={"width": width, "height": height},
                    color_scheme=theme,
                    reduced_motion="reduce",   # so charts are captured settled
                )
                page = ctx.new_page()
                errors: list[str] = []

                def note_console(msg, sink=errors):
                    if msg.type == "error":
                        sink.append(msg.text)

                def note_error(exc, sink=errors):
                    sink.append(str(exc))

                page.on("console", note_console)
                page.on("pageerror", note_error)

                for route in routes:
                    errors.clear()
                    page.goto(f"{base}/#/{route}", wait_until="networkidle",
                              timeout=30000)
                    page.evaluate(
                        "t => document.documentElement.dataset.theme = t", theme)
                    page.wait_for_timeout(1500)

                    where = f"{route} [{vp_name}/{theme}]"
                    for e in errors[:3]:
                        findings["console errors"].append(f"{where}: {e[:140]}")

                    report = page.evaluate(AUDIT_JS, {
                        "minTap": MIN_TAP_PX,
                        "minContrast": MIN_CONTRAST,
                        "minContrastLarge": MIN_CONTRAST_LARGE,
                        "viewport": vp_name,
                    })
                    for category, items in report.items():
                        for item in items:
                            findings[category].append(f"{where}: {item}")

                    if shots:
                        shots.mkdir(parents=True, exist_ok=True)
                        page.screenshot(
                            path=str(shots / f"{vp_name}-{theme}-{route}.png"),
                            full_page=(vp_name == "desktop"),
                        )
                ctx.close()
        browser.close()

    total = sum(len(v) for v in findings.values())
    if not total:
        print("QA: no findings")
        return 0

    print(f"QA: {total} findings\n")
    for category in sorted(findings, key=lambda c: -len(findings[c])):
        items = findings[category]
        print(f"-- {category}  ({len(items)})")
        shown = items if verbose else items[:6]
        for item in shown:
            print(f"   {item}")
        if len(items) > len(shown):
            print(f"   ... {len(items) - len(shown)} more")
        print()
    return total


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--route", action="append", help="limit to these routes")
    ap.add_argument("--base", default=BASE, help=f"the app to audit (default {BASE})")
    ap.add_argument("--theme", action="append", choices=THEMES)
    ap.add_argument("--phone-only", action="store_true")
    ap.add_argument("--desktop-only", action="store_true")
    ap.add_argument("--shots", type=pathlib.Path, help="write PNGs here")
    ap.add_argument("-v", "--verbose", action="store_true", help="every finding")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    viewports = VIEWPORTS
    if args.phone_only:
        viewports = [v for v in VIEWPORTS if v[0] == "phone"]
    elif args.desktop_only:
        viewports = [v for v in VIEWPORTS if v[0] == "desktop"]

    count = run(
        args.route or ROUTES,
        args.theme or THEMES,
        viewports,
        args.shots,
        args.verbose,
        base=args.base,
    )
    if args.json:
        print(json.dumps({"findings": count}))
    return count


if __name__ == "__main__":
    sys.exit(main())
