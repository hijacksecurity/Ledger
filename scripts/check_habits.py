"""Accuracy audit for the habit surfaces: the DOM against the API.

`scripts/qa.py` proves a page *renders* cleanly and says outright that it
cannot tell whether a figure is right. This is the other half, for the one
feature whose data is spread over four surfaces:

    #/habits     today's taps, the week grid, the rates, the week-by-week trend
    #/week       the habits widget
    #/calendar   the read-only overlay
    #/score      the habits pillar

Every one of them reads `GET /api/habits`. None of them may disagree with it,
and none of them may disagree with each other. This walks all four in a real
browser and asserts, mark by mark, that what is on screen is what the server
said — which is exactly the class of defect that shipped twice while this
feature was being built:

  * a day before the habit was created rendered as a blank hole in the middle
    of the current week, and every night of sleep older than the habit itself
    disappeared from the grid;
  * the Week widget and the Scoreboard scored the same week differently.

Run it after any change to habit resolution, the trend, or any of the four
surfaces:

    .venv/Scripts/python.exe scripts/check_habits.py
    .venv/Scripts/python.exe scripts/check_habits.py --base http://127.0.0.1:8000

Exit code is the number of mismatches, so it drops into a loop or a hook the
same way `qa.py` does.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8000"


def api(base: str, path: str) -> dict:
    with urllib.request.urlopen(f"{base}{path}", timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


class Report:
    def __init__(self) -> None:
        self.bad: list[str] = []
        self.checks = 0

    def eq(self, where: str, what: str, got, want) -> None:
        self.checks += 1
        if got != want:
            self.bad.append(f"{where}: {what} — page says {got!r}, API says {want!r}")

    def note(self, where: str, message: str) -> None:
        self.bad.append(f"{where}: {message}")


# --- the surfaces ---------------------------------------------------------

GRID_JS = """() => {
  const rows = [...document.querySelectorAll('.hbgrid-row:not(.is-head)')];
  return rows.map(r => ({
    name: r.querySelector('.hbgrid-name b')?.textContent,
    days: [...r.querySelectorAll('.hbcell')].map(c => ({
      state: c.dataset.state,
      value: c.querySelector('.hbcell-v')?.textContent ?? null,
    })),
  }));
}"""

WIDGET_JS = """() => {
  const p = [...document.querySelectorAll('.panel')]
    .find(x => x.querySelector('h2')?.textContent === 'Habits');
  if (!p) return null;
  return [...p.querySelectorAll('.hbw-row')].map(r => ({
    name: r.querySelector('.hbw-label b')?.textContent,
    note: r.querySelector('.hbw-note')?.textContent,
    days: [...r.querySelectorAll('.hbcell')].map(c => ({
      state: c.dataset.state,
      value: c.querySelector('.hbcell-v')?.textContent ?? null,
    })),
  }));
}"""

STRIP_JS = """() => [...document.querySelectorAll('.strip .stat')].map(s => ({
  label: s.querySelector('.stat-label')?.textContent,
  value: s.querySelector('.stat-value span')?.textContent,
  note: s.querySelector('.stat-note')?.textContent,
}))"""

PILLAR_JS = """() => {
  const row = [...document.querySelectorAll('.pillar')]
    .find(p => p.querySelector('.pillar-name span')?.textContent === 'Habits');
  if (!row) return null;
  return {
    score: row.querySelector('.pillar-score span')?.textContent,
    weight: row.querySelector('.pillar-weight')?.textContent,
    lines: [...row.querySelectorAll('.pillar-lines li')].map(l => l.textContent),
  };
}"""

CAL_JS = """() => {
  const out = {};
  for (const cell of document.querySelectorAll('.calcell:not(.is-pad)')) {
    const marks = [...cell.querySelectorAll('.hbcell')].map(m => m.dataset.state);
    if (marks.length) out[cell.dataset.date || ''] = marks;
  }
  return out;
}"""


def pillar_score(habits: list[dict]) -> int | None:
    """The habits pillar, by the same rule `score.js::habitsPillar` uses.

    Deliberately reimplemented here rather than imported: this script's job is
    to be an independent witness. If it shared the front end's arithmetic it
    could only ever confirm that the page agrees with itself.
    """
    rates = [h["totals"]["rate"] for h in habits if h["totals"]["scored"] > 0]
    if not rates:
        return None
    return round(sum(rates) / len(rates) * 100)


def run(base: str, verbose: bool) -> int:
    rep = Report()

    week = api(base, "/api/habits")
    today = week["today"]
    dates = sorted(next(iter(week["habits"]), {}).get("days", {}))
    by_name = {h["name"]: h for h in week["habits"]}

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1000})

        # ── #/habits: the week grid ──────────────────────────────────────
        page.goto(f"{base}/#/habits", wait_until="networkidle")
        page.wait_for_selector(".hbgrid-row:not(.is-head)", timeout=15000)

        for row in page.evaluate(GRID_JS):
            h = by_name.get(row["name"])
            if h is None:
                rep.note("#/habits grid", f"row {row['name']!r} is not in the API payload")
                continue
            rep.eq("#/habits grid", f"{row['name']} day count", len(row["days"]), len(dates))
            for date, cell in zip(dates, row["days"], strict=False):
                want = h["days"][date]
                rep.eq("#/habits grid", f"{row['name']} {date}", cell["state"], want["state"])
                # A measured habit prints its reading at week grain. The value
                # disappearing for older days is the exact regression that put
                # holes in the user's first week.
                if h["mode"] == "metric" and want["value"] is not None:
                    rep.eq("#/habits grid", f"{row['name']} {date} value",
                           cell["value"], f"{want['value']:.1f}")

        # ── #/habits: the rate tiles ─────────────────────────────────────
        for tile in page.evaluate(STRIP_JS):
            h = by_name.get(tile["label"])
            if h is None:
                continue
            t = h["totals"]
            want = "—" if t["rate"] is None else str(round(t["rate"] * 100))
            rep.eq("#/habits tiles", f"{tile['label']} rate", tile["value"], want)
            if t["scored"]:
                noun = "nights" if h["mode"] == "metric" else "days"
                if f"{t['met']} of {t['scored']} {noun}" not in (tile["note"] or ""):
                    rep.note("#/habits tiles",
                             f"{tile['label']} note {tile['note']!r} does not state "
                             f"{t['met']} of {t['scored']} {noun}")

        # ── #/week: the widget ───────────────────────────────────────────
        page.goto(f"{base}/#/week", wait_until="networkidle")
        page.wait_for_selector(".hbw-row", timeout=15000)
        widget = page.evaluate(WIDGET_JS)
        if widget is None:
            rep.note("#/week", "the habits widget did not render")
        else:
            for row in widget:
                h = by_name.get(row["name"])
                if h is None:
                    rep.note("#/week widget", f"row {row['name']!r} is not in the API payload")
                    continue
                for date, cell in zip(dates, row["days"], strict=False):
                    rep.eq("#/week widget", f"{row['name']} {date}",
                           cell["state"], h["days"][date]["state"])
                t = h["totals"]
                noun = "nights" if h["mode"] == "metric" else "days"
                rep.eq("#/week widget", f"{row['name']} rate",
                       row["note"], f"{t['met']} of {t['scored']} {noun}")

        # ── #/score: the pillar ──────────────────────────────────────────
        page.goto(f"{base}/#/score", wait_until="networkidle")
        page.wait_for_selector(".pillar", timeout=15000)
        pillar = page.evaluate(PILLAR_JS)
        want = pillar_score(week["habits"])
        if pillar is None:
            if want is not None:
                rep.note("#/score", f"no habits pillar, but the week scores {want}")
        elif want is None:
            rep.eq("#/score", "habits pillar", pillar["score"], "—")
        else:
            # One point of slack: the page rounds a float this script rebuilds
            # from rounded rates.
            got = int(pillar["score"])
            rep.checks += 1
            if abs(got - want) > 1:
                rep.bad.append(
                    f"#/score: habits pillar — page says {got}, the API's own totals give {want}")

        # ── #/calendar: the overlay ──────────────────────────────────────
        page.goto(f"{base}/#/calendar?by=month&on={today}", wait_until="networkidle")
        page.wait_for_selector(".calcell", timeout=15000)
        overlay = page.evaluate(CAL_JS)
        if not overlay:
            rep.note("#/calendar", "no habit marks in the month grid")
        elif not any(d in dates for d in overlay):
            # This check silently passed for its first run: the cells carried
            # no `data-date`, every key came back "", nothing matched the
            # window, and the loop below ran zero times. A check that can match
            # nothing has to say so rather than report success.
            rep.note("#/calendar",
                     f"no cell could be keyed to a date in the window "
                     f"(saw {sorted(overlay)[:3]}) — the assertions below ran zero times")
        else:
            order = [h["name"] for h in week["habits"]]
            for date, marks in overlay.items():
                if date not in dates:
                    continue
                rep.eq("#/calendar", f"{date} mark count", len(marks), len(order))
                for name, got in zip(order, marks, strict=False):
                    rep.eq("#/calendar", f"{name} {date}",
                           got, by_name[name]["days"][date]["state"])

        # ── the trend ────────────────────────────────────────────────────
        trend = api(base, "/api/habits/trend?weeks=12")
        current = next((w for w in trend["weeks"] if w["week_start"] <= today <= w["week_end"]), None)
        if current is None:
            rep.note("/api/habits/trend", "the current week is missing from the trend")
        else:
            for h in current["habits"]:
                rep.eq("/api/habits/trend", f"{h['name']} totals",
                       h["totals"], by_name[h["name"]]["totals"])
        for w in trend["weeks"]:
            for h in w["habits"]:
                t = h["totals"]
                if t["scored"] == 0 and t["rate"] is not None:
                    rep.note("/api/habits/trend",
                             f"{h['name']} in {w['week_start']} has no scored days "
                             f"but reports a rate of {t['rate']}")

        browser.close()

    if verbose:
        print(f"{rep.checks} assertions across five surfaces")
    if rep.bad:
        print(f"HABITS: {len(rep.bad)} mismatches\n")
        for line in rep.bad:
            print(f"  {line}")
        return len(rep.bad)
    print(f"HABITS: no mismatches ({rep.checks} assertions)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default=BASE)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    return run(args.base, args.verbose)


if __name__ == "__main__":
    sys.exit(main())
