"""Flexible read views: session log, trends, soccer record.

These exist so the UI can slice the record without the front end doing
arithmetic. Anything derived — pace, load, a win rate — is computed once here,
next to the numbers the weekly report uses, so two screens can never disagree.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta
from typing import Any

from ledger.core import calibrate
from ledger.core import load as load_mod
from ledger.core.windows import to_date
from ledger.db import queries as q
from ledger.report import timeframe

METRICS = {"load", "garmin_load", "distance", "duration", "count"}
GRAINS = {"week", "month"}

#: Unit for each metric, so the client labels axes without a lookup table.
METRIC_UNITS = {"load": "AU", "garmin_load": "Garmin load",
                "distance": "km", "duration": "min", "count": ""}


def detail_of(raw: str | None) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def session_dict(
    r: sqlite3.Row, cal: calibrate.Calibration | None = None
) -> dict[str, Any]:
    detail = detail_of(r["detail"])
    cal = cal or calibrate.Calibration()
    load_value, load_source = calibrate.session_load(
        r["kind"], r["rpe"], r["duration_min"], detail.get("garmin_load"), cal
    )
    return {
        "id": r["id"],
        "date": r["date"],
        "kind": r["kind"],
        "started_at": r["started_at"],
        "duration_min": r["duration_min"],
        "distance_km": r["distance_km"],
        "pace_s_per_km": r["pace_s_per_km"],
        "rpe": r["rpe"],
        "notes": r["notes"],
        "detail": detail,
        # One scale — Garmin's. Measured where the watch saw it, converted
        # from perceived effort where it did not, and `load_source` says which.
        "load": load_value,
        "load_source": load_source,
        "foster_au": load_mod.session_load(r["rpe"], r["duration_min"]),
        # Garmin's own training load, kept as a separate number. It is not a
        # rescaled version of the Foster figure and must never be added to it:
        # Garmin's is EPOC-derived and heart-rate-driven, Foster's is
        # perceived effort x minutes. On this record the two differ by 1.0x on
        # solo drills and 4.5x on a soccer match, and that gap is the finding,
        # not an error to calibrate away.
        "garmin_load": detail.get("garmin_load"),
        "source": r["source"],
    }


def session_log(
    conn: sqlite3.Connection,
    *,
    start: str | None = None,
    end: str | None = None,
    kind: str | None = None,
    text: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    total, rows = q.search_sessions(
        conn, start=start, end=end, kind=kind, text=text, limit=limit, offset=offset
    )
    cal = calibrate.fit(conn)
    # A one-sided filter ("everything from July") still has a real span.
    # Passing None straight through produced "no data yet" printed under a full
    # page of rows.
    #
    # An open *end* closes at today, not at the last matching row: "everything
    # from January" is a window that runs to now, and a run list whose last run
    # was Sunday should not describe its window as ending on Sunday — that is a
    # fact about the runs, and it made three panels disagree about where "now"
    # is. An open *start* has no such answer, so there the data is the best
    # available bound. `rows` is one page, so using it for the whole span would
    # let `?from=Jan&limit=10` label a year-long window with ten rows.
    dates = [r["date"] for r in rows]
    span_from = start or (min(dates) if dates else None)
    asked_for_a_window = bool(start or end)

    if asked_for_a_window:
        # The window is the one requested; `timeframe.window` clamps it to today.
        span_to = end or date.today().isoformat()
    else:
        # "Most recent N sessions" — here the span really is the rows.
        span_to = max(dates) if dates else None

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "timeframe": (
            timeframe.window(span_from, span_to, "session", total)
            if asked_for_a_window
            else timeframe.counted(len(rows), "sessions", span_from, span_to)
        ).as_dict(),
        "calibration": cal.as_dict(),
        "items": [session_dict(r, cal) for r in rows],
    }


def trends(
    conn: sqlite3.Connection,
    *,
    metric: str = "load",
    grain: str = "week",
    kind: str | None = None,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, Any]:
    """One metric per period, plus its split by modality.

    Periods with no activity are zero-filled: a gap is a real zero here, and
    dropping it would flatter every average (BRIEF §6).
    """
    if metric not in METRICS:
        raise ValueError(f"unknown metric {metric!r}")
    if grain not in GRAINS:
        raise ValueError(f"unknown grain {grain!r}")

    first = q.first_session_date(conn)
    last = q.last_session_date(conn)
    if not first:
        return {"metric": metric, "grain": grain, "kind": kind,
                "unit": METRIC_UNITS[metric], "points": []}

    start = start or first
    end = end or max(last or first, date.today().isoformat())

    rows = q.trend_points(conn, metric=metric, grain=grain, start=start, end=end, kind=kind)
    buckets: dict[str, dict[str, float]] = {}
    for r in rows:
        buckets.setdefault(r["period"], {})[r["kind"]] = round(float(r["value"]), 2)

    points = [
        {
            "period": period,
            "value": round(sum(buckets.get(period, {}).values()), 2),
            "by_kind": buckets.get(period, {}),
        }
        for period in _periods(start, end, grain)
    ]
    return {
        "metric": metric,
        "grain": grain,
        "kind": kind,
        "unit": METRIC_UNITS[metric],
        "start": start,
        "end": end,
        "timeframe": timeframe.window(start, end, grain, len(points)).as_dict(),
        "points": points,
    }


def _periods(start: str, end: str, grain: str) -> list[str]:
    """Every period label between start and end, so gaps zero-fill."""
    out: list[str] = []
    if grain == "month":
        y, m = int(start[:4]), int(start[5:7])
        last_y, last_m = int(end[:4]), int(end[5:7])
        while (y, m) <= (last_y, last_m):
            out.append(f"{y:04d}-{m:02d}")
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        return out

    cursor = to_date(start)
    cursor -= timedelta(days=cursor.weekday())      # back to Monday
    last = to_date(end)
    while cursor <= last:
        out.append(cursor.isoformat())
        cursor += timedelta(weeks=1)
    return out


def soccer(
    conn: sqlite3.Connection, start: str | None = None, end: str | None = None
) -> dict[str, Any]:
    """Record, goal involvement and match list.

    The notebook records a scoreline and goals/assists for every match; this is
    the first place the app surfaces any of it. Reported flat — a losing run is
    shown, not softened.
    """
    first = q.first_session_date(conn)
    if not first:
        return _empty_soccer()

    start = start or first
    end = end or max(q.last_session_date(conn) or first, date.today().isoformat())

    games: list[dict[str, Any]] = []
    record = {"W": 0, "L": 0, "D": 0}
    goals = assists = gf = ga = 0

    for r in q.soccer_games(conn, start, end):
        d = detail_of(r["detail"])
        result = d.get("result")

        # Solo ball work is not a match. Anything the watch filed as soccer
        # that carries no result and no goal involvement is training — it
        # belongs in the load totals, never in the record or the goal tallies.
        if result is None and d.get("goals") is None and r["source"] == "garmin":
            continue

        if result in record:
            record[result] += 1
        goals += int(d.get("goals") or 0)
        assists += int(d.get("assists") or 0)
        gf += int(d.get("gf") or 0)
        ga += int(d.get("ga") or 0)

        note = (r["notes"] or "").lower()
        games.append(
            {
                "id": r["id"],
                "date": r["date"],
                "result": result,
                "gf": d.get("gf"),
                "ga": d.get("ga"),
                "goals": d.get("goals"),
                "assists": d.get("assists"),
                # Explicit fixture if one was recorded; the note keyword is a
                # fallback for the 84 weeks logged before the field existed.
                "team": d.get("team"),
                # ...and `fixture` is that resolved all the way down to the
                # weekday, which is what every per-fixture figure on the page
                # actually groups by. `pickup` below used to be its own
                # narrower rule (explicit field or the word in the note), so
                # the read-out counted 6 pickup matches while the By-fixture
                # table counted 8 — same word, two definitions, one page.
                "fixture": _resolve_fixture(r["date"], d, note),
                "fixture_source": _fixture_source(d, note),
                "pickup": _resolve_fixture(r["date"], d, note) == "pickup",
                "duration_min": r["duration_min"],
                "rpe": r["rpe"],
                "notes": r["notes"],
            }
        )

    played = record["W"] + record["L"] + record["D"]

    # Matches where goals or assists were actually written down. Not the same as
    # `played` (a result but no involvement recorded) and not the same as
    # `games_logged`. All three denominators were in use at once — the page
    # showed "2.78 G+A per match" beside "involvement per match 3.60" — so the
    # per-match rate is computed here, once, and the basis is published with it.
    with_involvement = sum(
        1 for g in games if g["goals"] is not None or g["assists"] is not None
    )

    return {
        "start": start,
        "end": end,
        "timeframe": timeframe.window(start, end, "match", len(games)).as_dict(),
        "record": {"w": record["W"], "l": record["L"], "d": record["D"]},
        "games_played": played,
        "games_logged": len(games),
        "matches_with_involvement": with_involvement,
        "goals": goals,
        "assists": assists,
        "goal_involvements": goals + assists,
        "goals_for": gf,
        "goals_against": ga,
        # Per game played, so a fair comparison across seasons of different length.
        "goals_per_game": round(goals / played, 2) if played else None,
        #: Goals + assists ÷ matches where either was recorded. Divided by the
        #: matches that carry the data rather than by every match played: a
        #: match logged without a goal line is unknown, not a zero, and counting
        #: it as one drags the rate down for a record-keeping gap.
        "involvements_per_match": (
            round((goals + assists) / with_involvement, 2) if with_involvement else None
        ),
        "involvements_basis": "matches with goals or assists recorded",
        "win_rate": round(record["W"] / played, 3) if played else None,
        "games": games,
    }


#: The three standing fixtures, by weekday. Monday coed, Tuesday pickup,
#: Thursday men's league; anything else is a one-off. Mirrors `TEAMS` in
#: `web/dataset.js` — the client resolves the same way for rows it holds
#: locally, and the two must not drift.
#:
#: Men's league was on Wednesdays at one venue until the Fall 2026 session
#: moved it to Thursdays at another. The rule is dated rather
#: than rewritten so every summer Wednesday still reads as men's league, and
#: so a Wednesday after the move — which is somebody else's league now — does
#: not. `MENS_ON_THURSDAY_FROM` is the day after the last Wednesday fixture
#: (9 Sep 2026); the first Thursday fixture was the 17th.
MENS_ON_THURSDAY_FROM = "2026-09-10"
_FIXTURE_BY_WEEKDAY_BEFORE = {0: "coed", 1: "pickup", 2: "mens"}
_FIXTURE_BY_WEEKDAY = {0: "coed", 1: "pickup", 3: "mens"}
_FIXTURE_KEYS = ("coed", "pickup", "mens", "other")


def fixture_by_weekday(day: str) -> str:
    """The standing fixture on that date's weekday, dated for the move."""
    table = _FIXTURE_BY_WEEKDAY if day >= MENS_ON_THURSDAY_FROM else _FIXTURE_BY_WEEKDAY_BEFORE
    return table.get(to_date(day).weekday(), "other")

#: Note keywords, checked before the weekday so a Monday that was really pickup
#: resolves correctly without an explicit override.
_FIXTURE_NOTE = (
    ("pickup", "pickup"), ("pick-up", "pickup"), ("pick up", "pickup"),
    ("coed", "coed"), ("co-ed", "coed"),
    ("men's", "mens"), ("mens", "mens"),
    ("practice", "other"), ("scrimmage", "other"),
    ("tournament", "other"), ("friendly", "other"),
)


def _fixture_source(detail: dict[str, Any], note: str) -> str:
    """Where the fixture came from, so the page can say which were inferred."""
    if detail.get("team") in _FIXTURE_KEYS:
        return "set"
    return next((("note") for word, _ in _FIXTURE_NOTE if word in note), "weekday")


def _resolve_fixture(day: str, detail: dict[str, Any], note: str) -> str:
    """Explicit field, then a note keyword, then the weekday. Never null."""
    if detail.get("team") in _FIXTURE_KEYS:
        return str(detail["team"])
    for word, team in _FIXTURE_NOTE:
        if word in note:
            return team
    return fixture_by_weekday(day)


def _empty_soccer() -> dict[str, Any]:
    return {
        "start": None, "end": None, "record": {"w": 0, "l": 0, "d": 0},
        "games_played": 0, "games_logged": 0, "matches_with_involvement": 0,
        "goals": 0, "assists": 0,
        "goal_involvements": 0, "goals_for": 0, "goals_against": 0,
        "goals_per_game": None, "involvements_per_match": None,
        "involvements_basis": "matches with goals or assists recorded",
        "win_rate": None, "games": [],
    }
