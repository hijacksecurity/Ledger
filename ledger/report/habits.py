"""Daily habits: one rule for what a day is worth, applied in one place.

A habit day has two possible sources and they do not look alike. A manual habit
is a tap — it happened or it did not. A measured one is a number the watch
already recorded, which can be absent (the watch was on the charger), present
and short, or overridden by hand because the watch was wrong. Four states, two
modes, and any surface that worked them out for itself would work them out
slightly differently — which is the failure this codebase has shipped more than
any other.

So `resolve_day` is the only thing in the project that reads `habit_day.done`
or `habit_day.value`, and everything downstream — the API payload, the Week
widget, the Scoreboard pillar, the calendar overlay — reads the state it
returns.

## The five states

    met          the day earned its tick
    partial      measured, short of target, past the floor where it earns
                 nothing. Credit ramps; the tick is still withheld.
    missed       a past day that did not earn it
    open         today, not yet marked — never a miss, because it is not over
    unrecorded   a measured habit with no measurement. Not scored at all.

`unrecorded` is the one that matters most. A night the watch did not record is
not a night you slept badly, and counting it as a miss would grade you on
whether you wore a device. It leaves the denominator rather than entering the
numerator as a zero — the same rule the Scoreboard already applies when it
drops an absent pillar instead of scoring it nought.

## What gets scored

Completed days only. Today is shown live so ticking it is visible, and it is
not scored until it is over — part of a day against a whole one is not a
comparison, which is the rule the Week and Running views already state about
part of a week. A Monday morning therefore scores nothing and the habits pillar
is absent that day, weight redistributed, exactly as a week with no match is.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from typing import Any

from ledger.db import queries as q
from ledger.report import timeframe as tf

#: The floor of the partial band, as a share of the credit a full day earns.
#: Reaching `partial_at` is worth half a day; reaching `target` is worth one.
#: Between them it ramps, so 7.5 h of an 8 h target is 0.75 and reads as the
#: three-quarters of a good night it actually was.
PARTIAL_FLOOR = 0.5


def _metric_columns() -> tuple[str, ...]:
    return q._METRIC_COLUMNS  # noqa: SLF001 — one module, deliberately


def resolve_day(
    habit: sqlite3.Row | dict[str, Any],
    row: sqlite3.Row | dict[str, Any] | None,
    measured: float | None,
    *,
    day: str,
    today: str,
    since: str | None = None,
) -> dict[str, Any]:
    """What one habit was worth on one day.

    `row` is the `habit_day` record if there is one. `measured` is whatever
    `metric_daily` holds for a metric habit's source field, ignored entirely for
    a manual one. `since` is the day the habit started being kept.
    """
    mode = habit["mode"]
    ahead = day > today

    # Before the habit existed there was nothing to keep, so there is nothing
    # to score. Without this every day back to the start of the record reads as
    # a miss, and a twelve-week chart opens with eleven weeks of failure at
    # something that was not being asked of anybody — the plainest possible
    # case of a number that misleads. Sleep is held to the same rule even
    # though Garmin has the nights: the watch was recording, but it was not a
    # goal, and mixing the two would make an old week a sleep-only score.
    # Before the habit existed, a day does not COUNT — but for a measured habit
    # it is still shown. Garmin had been recording sleep for 242 nights before
    # sleep became a goal, and hiding all of it because the goal is three days
    # old throws away the history the user actually wants to look at. So the
    # night resolves normally, prints its hours, and carries `counts: False`
    # so no rate is built on a target nobody had set yet.
    #
    # A tapped habit has no such history: with no mark there is nothing to
    # show, so it is blank as well as uncounted. An explicit mark outranks the
    # creation date either way — going back to tick a day you did before you
    # set the habit up is a deliberate act.
    untracked = bool(since and day < since and row is None)

    if mode == "manual":
        marked = row is not None and row["done"] == 1
        if marked:
            return _day_out("met", 1.0, source="manual")
        if untracked:
            return _day_out("untracked", None, counts=False)
        if ahead:
            return _day_out("ahead", None)
        state = "open" if day == today else "missed"
        return _day_out(state, None if state == "open" else 0.0)

    # Measured. A hand-entered value outranks the sync's, and says so.
    override = row["value"] if row is not None and row["value"] is not None else None
    value = override if override is not None else measured
    source = "manual" if override is not None else ("garmin" if measured is not None else None)

    counts = not untracked

    if value is None:
        state = "ahead" if ahead else ("untracked" if untracked else "unrecorded")
        return _day_out(state, None, counts=counts)

    target = habit["target"]
    floor = habit["partial_at"]
    if target is None:
        # A metric habit with no target cannot decide anything. Report the
        # number and score nothing, rather than inventing a threshold.
        return _day_out("unrecorded", None, value=value, source=source, counts=False)

    if value >= target:
        return _day_out("met", 1.0, value=value, source=source, counts=counts)
    if floor is not None and value >= floor and target > floor:
        credit = PARTIAL_FLOOR + (1 - PARTIAL_FLOOR) * ((value - floor) / (target - floor))
        return _day_out("partial", round(credit, 4), value=value, source=source, counts=counts)
    return _day_out("missed", 0.0, value=value, source=source, counts=counts)


def _tracking_from(created_at: str | None) -> str | None:
    """The Monday of the week a habit was created in.

    Not the creation day itself. A habit set up on a Friday is a habit you are
    keeping *that week* — the user had already marked the Monday and Tuesday
    by hand, and dating tracking from Friday turned the first four days of
    their own first week into "not tracked": three green marks, a hole, another
    green mark. It also hid every night of sleep before the Friday, which
    Garmin had been recording for months.

    Anchoring to the week keeps the unit the rest of this feature works in, and
    still refuses to invent history: the weeks before the habit existed have no
    days in them at all.
    """
    day = (created_at or "")[:10]
    if not day:
        return None
    try:
        d = date.fromisoformat(day)
    except ValueError:
        return None
    return (d - timedelta(days=d.weekday())).isoformat()


def _day_out(state, credit, *, value=None, source=None, counts=True):
    """One day's answer. `counts` is whether it may enter a denominator.

    It is separate from `credit` on purpose: a night before the habit existed
    has a real reading and a real state — it is drawn, and its hours are
    printed — but it may not be scored, because there was no target to hold it
    to. `credit is None` means "nothing to add"; `counts is False` means "not
    this habit's business".
    """
    return {"state": state, "credit": credit, "value": value,
            "source": source, "counts": counts}


def _totals(days: dict[str, dict[str, Any]], today: str) -> dict[str, Any]:
    """Met, scored and credit over the days that have finished.

    Every figure the UI prints about a habit comes from here, including the
    denominator — a rate whose denominator is computed somewhere else is how
    one quantity ends up with two numbers.
    """
    met = 0
    scored = 0
    credit = 0.0
    for day, d in days.items():
        if day >= today or d["credit"] is None or not d.get("counts", True):
            continue
        scored += 1
        credit += d["credit"]
        if d["state"] == "met":
            met += 1
    return {
        "met": met,
        "scored": scored,
        "credit": round(credit, 4),
        "rate": round(credit / scored, 4) if scored else None,
    }


def _habit_out(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "key": row["key"],
        "name": row["name"],
        "mode": row["mode"],
        "source_field": row["source_field"],
        "target": row["target"],
        "partial_at": row["partial_at"],
        "unit": row["unit"],
        "polarity": row["polarity"],
        "position": row["position"],
        "archived": row["archived_at"] is not None,
        "since": _tracking_from(row["created_at"]),
    }


def build(
    conn: sqlite3.Connection,
    start: str,
    end: str,
    *,
    today: str | None = None,
    include_archived: bool = False,
) -> dict[str, Any]:
    """Every habit, every day in the window, and what each day was worth."""
    # `since` per habit, so a habit added in March does not report a January
    # it was never kept in.
    today = today or date.today().isoformat()

    defs = q.habits(conn, include_archived=True)
    marks: dict[tuple[int, str], sqlite3.Row] = {
        (r["habit_id"], r["date"]): r for r in q.habit_days(conn, start, end)
    }

    metric_cols = _metric_columns()
    measured: dict[str, sqlite3.Row] = {r["date"]: r for r in q.metrics_between(conn, start, end)}

    span = [d.isoformat() for d in _dates(start, end)]

    out = []
    for h in defs:
        if h["archived_at"] is not None and not include_archived:
            continue
        field = h["source_field"] if h["source_field"] in metric_cols else None
        since = _tracking_from(h["created_at"])
        days = {}
        for day in span:
            m = measured.get(day)
            value = m[field] if (m is not None and field) else None
            days[day] = resolve_day(h, marks.get((h["id"], day)), value,
                                    day=day, today=today, since=since)
        out.append({**_habit_out(h), "days": days, "totals": _totals(days, today)})

    # The last day the window scores. Named rather than inferred downstream,
    # because "how many days is this out of" is the denominator of every rate
    # on the page.
    scored_through = min(end, _prev(today))

    return {
        "habits": out,
        "today": today,
        "scored_through": scored_through if scored_through >= start else None,
        "timeframe": _timeframe(start, end, today),
    }


def _timeframe(start: str, end: str, today: str) -> dict[str, Any]:
    """The window, named the way the rest of the app names that shape of window.

    A Monday-to-Sunday span is a calendar unit and keeps its Sunday — `one_week`
    exists for exactly that, and without it the Week widget's window read
    "trailing 5 days to 11 Sep" on a Friday about a week it was calling "this
    week" in the same breath. Anything else is a trailing span and clamps to
    today like every other window in the app.
    """
    s = date.fromisoformat(start)
    e = date.fromisoformat(end)
    if s.weekday() == 0 and (e.toordinal() - s.toordinal()) == 6:
        return tf.one_week(s, e, today=today).as_dict()
    return tf.window(s, e, grain="day", today=today).as_dict()


def _dates(start: str, end: str) -> list[date]:
    s = date.fromisoformat(start)
    e = date.fromisoformat(end)
    if e < s:
        return []
    return [date.fromordinal(o) for o in range(s.toordinal(), e.toordinal() + 1)]


def _prev(iso: str) -> str:
    return date.fromordinal(date.fromisoformat(iso).toordinal() - 1).isoformat()


def trend(
    conn: sqlite3.Connection,
    *,
    weeks: int = 12,
    today: str | None = None,
    include_archived: bool = False,
) -> dict[str, Any]:
    """The same weekly totals, for each of the last `weeks` weeks.

    Built by calling `build()` once per Monday-to-Sunday week rather than by
    writing a second, faster aggregate: `_totals` stays the only thing that
    decides what a week came to, so a column on the chart and the figure in the
    tile are the same arithmetic. Twelve small reads of a three-row table is a
    price worth paying for that.

    The per-day maps are dropped on the way out — a trend needs the totals, and
    twelve weeks of eighty-four day records is a payload nobody reads.
    """
    today = today or date.today().isoformat()
    monday = date.fromisoformat(today)
    monday -= timedelta(days=monday.weekday())

    out = []
    for back in range(weeks - 1, -1, -1):
        start = monday - timedelta(days=7 * back)
        end = start + timedelta(days=6)
        payload = build(
            conn, start.isoformat(), end.isoformat(),
            today=today, include_archived=include_archived,
        )
        out.append({
            "week_start": start.isoformat(),
            "week_end": end.isoformat(),
            "scored_through": payload["scored_through"],
            "habits": [
                {
                    "key": h["key"],
                    "name": h["name"],
                    "mode": h["mode"],
                    "polarity": h["polarity"],
                    "position": h["position"],
                    "totals": h["totals"],
                }
                for h in payload["habits"]
            ],
        })

    first = out[0]["week_start"] if out else None
    last = out[-1]["week_end"] if out else None
    return {
        "weeks": out,
        "today": today,
        "timeframe": tf.window(first, last, grain="week", periods=weeks,
                               today=today).as_dict(),
    }
