"""JSON payload behind the web dashboard.

One request, one object. The front end does no arithmetic beyond drawing —
every number it shows is computed here, by the same `core/` functions the text
report uses, so the two can never disagree.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta
from typing import Any

from ledger.core import calibrate
from ledger.core import load as load_mod
from ledger.core.windows import ema_series, to_date, window_start
from ledger.db import queries as q
from ledger.report import timeframe, weekly

#: Default window for the load chart; the client may ask for another. Both are
#: windows onto an open-ended record — the all-time view lives in history.py.
LOAD_WEEKS = 12
TREND_WEEKS = 26


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _detail(raw: str | None) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def build_summary(
    conn: sqlite3.Connection,
    week_end: date | None = None,
    planned_per_week: dict[str, int] | None = None,
    load_weeks: int = LOAD_WEEKS,
) -> dict[str, Any]:
    rep = weekly.build_report(conn, week_end, planned_per_week)
    end_d = date.fromisoformat(rep.week_end)
    kinds = weekly.ordered_kinds(rep.sessions_this_week, rep.sessions_28d)

    # The newest week the record can show, so the client's "next" stop is a
    # fact about the data rather than a guess from whatever loaded first.
    newest = q.last_session_date(conn)
    latest_end = _monday(max(to_date(newest), date.today()) if newest else date.today())
    latest_end += timedelta(days=6)

    return {
        "week": {"start": rep.week_start, "end": rep.week_end},
        # Every windowed block below names its own period; the UI prints these
        # verbatim rather than describing the window a second time.
        "timeframes": {
            "week": timeframe.one_week(rep.week_start, rep.week_end).as_dict(),
            # Ends on `as_of`, not on the week's Sunday: while the week is
            # still running the window really does stop at today, and a label
            # promising six days that have not happened is just wrong.
            "rolling_28d": timeframe.window(
                window_start(rep.as_of, 28), rep.as_of, "day", 28
            ).as_dict(),
            "load_by_week": timeframe.window(
                (_monday(end_d) - timedelta(weeks=load_weeks - 1)).isoformat(),
                rep.week_end, "week", load_weeks,
            ).as_dict(),
            "avg_history": timeframe.window(
                (_monday(end_d) - timedelta(weeks=TREND_WEEKS)).isoformat(),
                rep.week_end, "week", TREND_WEEKS,
            ).as_dict(),
        },
        "latest_week_end": latest_end.isoformat(),
        "load_weeks": load_weeks,
        "headline": {
            "avg_per_week": rep.avg_per_week,
            "total_activities": rep.total_activities,
            # The figure the notebook page recorded. Same definition, same
            # arithmetic — it is here only so a transcription gap shows up as
            # a mismatch rather than passing unnoticed. It is not for display:
            # one number means one number.
            "notebook_avg": _notebook_avg(conn, rep.week_start),
            "weeks_divisor": rep.weeks_divisor,
            "completed_activities": rep.completed_activities,
            # `week_count` is activities in the selected week; `weeks_logged`
            # is how long the record is. The names have burned people before.
            "week_count": sum(rep.sessions_this_week.values()),
            "count_28d": sum(rep.sessions_28d.values()),
            "weeks_logged": _weeks_logged(conn, end_d),
        },
        "week_note": _week_note(conn, rep.week_start),
        # A week in progress is not a quiet week. Opening the app on a Monday
        # showed 0 load and an empty session list, which reads as broken
        # rather than as "this week has barely started".
        "week_progress": _week_progress(conn, rep.week_start, rep.week_end),
        "kinds": kinds,
        "sessions_this_week": rep.sessions_this_week,
        "sessions_28d": rep.sessions_28d,
        "consistency": {k: list(v) for k, v in rep.consistency_28d.items()},
        "load": {
            "week_total": round(rep.week_load),
            "split": load_mod.modality_split(rep.load_split),
            "by_kind": {k: round(v) for k, v in rep.load_split.items()},
            "acwr": round(rep.acwr.ratio, 2) if rep.acwr and rep.acwr.available else None,
            # The day both windows end on. Not the week's Sunday while the week
            # is still running, so the panel can name the span it really covers.
            "as_of": rep.as_of,
            # The two inputs, so the UI can show the arithmetic rather than ask
            # to be believed — this number will not match the watch, and the
            # only honest answer is to publish what went into it.
            "acute_au": round(rep.acwr.acute, 1) if rep.acwr else None,
            "chronic_au": round(rep.acwr.chronic, 1) if rep.acwr else None,
            "band": rep.acwr.band if rep.acwr else "building baseline",
            "days_of_history": rep.acwr.days_of_history if rep.acwr else 0,
            "min_days": load_mod.MIN_DAYS_FOR_ACWR,
            "unscored": rep.unscored_sessions,
            # Garmin's total for the same week, where the watch recorded it.
            # Shown beside the Foster figure, never summed with it.
            "garmin_week_total": _garmin_week_load(conn, rep.week_start, rep.week_end),
        },
        "facts": _facts(conn, rep),
        "avg_history": _avg_history(conn, end_d),
        "load_by_week": _load_by_week(conn, end_d, load_weeks),
        "sessions": _sessions(conn, rep.week_start, rep.week_end),
        "prs": rep.prs,
        "e1rm": rep.e1rm_trends,
        "recovery": {k: list(v) for k, v in rep.recovery.items()},
        "bodyweight": _bodyweight(conn, rep),
    }


def _notebook_avg(conn: sqlite3.Connection, week_start: str) -> float | None:
    row = q.week_row(conn, week_start)
    return row["avg_activities_per_week"] if row else None


def _garmin_week_load(conn: sqlite3.Connection, start: str, end: str) -> float | None:
    row = conn.execute(
        "SELECT SUM(json_extract(detail, '$.garmin_load')) AS n FROM session "
        "WHERE date BETWEEN ? AND ?",
        (start, end),
    ).fetchone()
    return round(row["n"], 1) if row and row["n"] else None


def _week_progress(
    conn: sqlite3.Connection, start: str, end: str
) -> dict[str, Any]:
    """How far into the week we are, and what the last real week looked like."""
    today = date.today()
    start_d, end_d = to_date(start), to_date(end)
    current = start_d <= today <= end_d

    days_elapsed = (min(today, end_d) - start_d).days + 1 if today >= start_d else 0
    sessions = q.count_sessions_through(conn, end) - q.count_sessions_through(
        conn, (start_d - timedelta(days=1)).isoformat()
    )

    prior_end = (start_d - timedelta(days=1)).isoformat()
    prior_start = (start_d - timedelta(days=7)).isoformat()
    prior_loads = q.session_loads(conn, prior_start, prior_end)

    return {
        "is_current_week": current,
        "days_elapsed": max(0, min(7, days_elapsed)),
        "days_remaining": max(0, 7 - days_elapsed) if current else 0,
        "sessions_so_far": sessions,
        # So a fresh week can show what it is being compared against instead
        # of a row of zeroes.
        "previous_week": {
            "start": prior_start,
            "end": prior_end,
            "load": round(sum(v for _, _, v in prior_loads)),
            "sessions": len({(d, k) for d, k, _ in prior_loads}) or len(prior_loads),
        },
    }


def _weeks_logged(conn: sqlite3.Connection, end: date) -> int:
    first = q.first_session_date(conn)
    return ((end - to_date(first)).days + 1) // 7 if first else 0


def _week_note(conn: sqlite3.Connection, week_start: str) -> dict[str, Any] | None:
    """The notebook page header for this week, if one was written."""
    row = q.week_row(conn, week_start)
    if row is None:
        return None
    return {
        "start_date": row["start_date"],
        "week_number": row["week_number"],
        "bodyweight_lbs": row["bodyweight_lbs"],
        "avg_activities_per_week": row["avg_activities_per_week"],
        "notes": row["notes"],
    }


def _facts(conn: sqlite3.Connection, rep: weekly.WeeklyReport) -> list[str]:
    """Short, strictly factual lines for the hero.

    These are observations, not encouragement. Every one is a number the tool
    can defend; none of them says how the week went (BRIEF §9). If a template
    has no data behind it, it is omitted rather than softened.
    """
    facts: list[str] = []

    split = load_mod.modality_split(rep.load_split)
    if split:
        kind, share = max(split.items(), key=lambda kv: kv[1])
        if share >= 0.4:
            facts.append(f"{kind.title()} is {share:.0%} of this week's training load.")

    count_28 = sum(rep.sessions_28d.values())
    if count_28:
        facts.append(f"{count_28} activities in the last 28 days.")

    first = q.first_session_date(conn)
    if first:
        weeks = ((to_date(rep.week_end) - to_date(first)).days + 1) // 7
        if weeks >= 4:
            facts.append(f"{weeks} weeks logged since {to_date(first).strftime('%b %Y')}.")

    return facts[:3]


def _avg_history(conn: sqlite3.Connection, end: date) -> list[dict[str, Any]]:
    """The boxed number, week by week — a cumulative average, so it drifts.

    A single bad week nudges it down and the next good one lifts it back. That
    shape is the argument against streaks, drawn (BRIEF §6).
    """
    first = q.first_session_date(conn)
    if not first:
        return []

    start = to_date(first)
    out: list[dict[str, Any]] = []
    for i in range(TREND_WEEKS - 1, -1, -1):
        # Each point is that week's header value: completed weeks only, so the
        # series matches the number the hero shows (see weekly.build_report).
        week_end = _monday(end) - timedelta(weeks=i) - timedelta(days=1)
        if week_end < start:
            continue
        days = (week_end - start).days + 1
        if days < 7:
            continue
        total = q.count_sessions_through(conn, week_end.isoformat())
        out.append(
            {"week_end": week_end.isoformat(), "avg": round(total / (days / 7), 2)}
        )
    return out


def _load_by_week(
    conn: sqlite3.Connection, end: date, weeks: int = LOAD_WEEKS
) -> list[dict[str, Any]]:
    """Per-modality session load, bucketed into Monday-start weeks."""
    first_monday = _monday(end) - timedelta(weeks=weeks - 1)
    rows = q.session_loads(conn, first_monday.isoformat(), end.isoformat())

    buckets: dict[str, dict[str, float]] = {
        (first_monday + timedelta(weeks=i)).isoformat(): {} for i in range(weeks)
    }
    for d, kind, value in rows:
        key = _monday(to_date(d)).isoformat()
        if key in buckets:
            buckets[key][kind] = buckets[key].get(kind, 0.0) + value

    return [
        {
            "week_start": week_start,
            "total": round(sum(by_kind.values())),
            "by_kind": {k: round(v) for k, v in by_kind.items()},
        }
        for week_start, by_kind in buckets.items()
    ]


def _sessions(conn: sqlite3.Connection, start: str, end: str) -> list[dict[str, Any]]:
    from ledger.report.views import session_dict

    cal = calibrate.fit(conn)
    return [session_dict(r, cal) for r in q.sessions_between(conn, start, end)]


def _bodyweight(conn: sqlite3.Connection, rep: weekly.WeeklyReport) -> dict[str, Any]:
    """7-day EMA and its 4-week direction. Context, never a score (BRIEF §7)."""
    raw = q.bodyweight_series(conn, window_start(rep.week_end, 180), rep.week_end)
    return {
        "ema_kg": rep.bodyweight_ema,
        "delta_4w_kg": rep.bodyweight_delta_4w,
        "series": [
            {"date": d, "kg": round(v, 2), "ema": round(e, 2)}
            for (d, v), (_, e) in zip(raw, ema_series(raw, span=7), strict=True)
        ],
    }
