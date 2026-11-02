"""Calories: what went in against what went out, one rule in one place.

Intake is what the user typed, a number per meal. Burn is Garmin's, and it
needs interpreting before it can be printed, because the watch reports a
different kind of figure depending on when it is asked:

  * On a **finished** day `calories_total` is the day's burn. Done.
  * On an **unfinished** day Garmin pro-rates `bmrKilocalories` to the hours
    elapsed (at 18:36 it reads about three quarters of the full-day figure)
    while `activeKilocalories` is the running total so far. Neither is the
    day's burn. The full-day baseline has to come from somewhere else: the
    median BMR of recent finished days — the wearer's own history, the same
    source the Recovery page trusts for resting HR — and the projection is
    that baseline plus the activity logged so far. It is a floor, not a
    forecast: it assumes nothing more happens today, and the payload says so.
  * The 03:00 nightly writes a three-hour row for "today". `day_elapsed_min`
    is how a row says how much of the day it covers, and it is the only thing
    that separates a finished day from a stale partial one. A date in the
    past is not enough.

A past day with no row at all has no burn and no deficit. No baseline is
substituted — a number that would mislead does not get printed — and the day
is left out of every mean. Likewise a day with no meals is unlogged, not a
zero-intake day; it is shown, and it is not averaged.

The target is printed beside the figures and the arithmetic is written out
as one line the page shows verbatim, so the reader can redo it by hand and
nothing downstream recomputes it.

`standing` is the one judgement here, and it was asked for: where the day's
deficit sits against the target, in five words the pages colour on the
Scoreboard's ramp. It is computed once, here, so the Calories page and the
Week widget cannot disagree about a day.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, date, datetime, timedelta
from statistics import median
from typing import Any

from ledger.db import queries as q
from ledger.report import timeframe as tf

DEFICIT_TARGET_KEY = "calories_deficit_target_kcal"
DEFAULT_DEFICIT_TARGET = 500

#: A row covering at least this many minutes describes a finished day. A few
#: minutes short of 1440 happens when the watch synced just before midnight.
COMPLETE_MIN = 1435
#: The baseline is the median BMR of the last 7 finished days when there are
#: at least 3 of them, else of whatever finished days the last 28 rows hold.
BASELINE_DAYS = 7
BASELINE_MIN_DAYS = 3
BASELINE_LOOKBACK = 28
#: Today's burn older than this is worth pulling again when the page opens.
STALE_AFTER_S = 600


def _now() -> datetime:
    return datetime.now(UTC)


def deficit_target(conn: sqlite3.Connection) -> tuple[int, bool, str | None]:
    """(kcal, is_default, updated_at)."""
    row = q.get_setting(conn, DEFICIT_TARGET_KEY)
    if row is None:
        return DEFAULT_DEFICIT_TARGET, True, None
    return int(float(row["value"])), False, row["updated_at"]


def is_complete(row: sqlite3.Row | dict[str, Any] | None, day: str, today: str) -> bool:
    """Whether a row describes the whole day.

    `day_elapsed_min` decides. A row that carries calories but no elapsed
    figure predates the column, and for one of those the date has to do.
    """
    if row is None:
        return False
    elapsed = row["day_elapsed_min"]
    if elapsed is not None:
        return elapsed >= COMPLETE_MIN
    return row["calories_total"] is not None and day < today


def baseline_bmr(conn: sqlite3.Connection, today: str) -> tuple[int | None, str | None]:
    """The full-day BMR for an unfinished day, from the wearer's own finished days."""
    rows = [r for r in q.metric_rows_with_bmr(conn, today, BASELINE_LOOKBACK)
            if is_complete(r, r["date"], today)]
    if not rows:
        return None, None
    recent = rows[:BASELINE_DAYS]
    chosen = recent if len(recent) >= BASELINE_MIN_DAYS else rows
    value = round(median(int(r["calories_bmr"]) for r in chosen))
    plural = "s" if len(chosen) != 1 else ""
    return value, f"median of {len(chosen)} finished day{plural}"


def _fetched_age_s(row: sqlite3.Row | dict[str, Any] | None, now: datetime) -> float | None:
    if row is None or not row["calories_fetched_at"]:
        return None
    try:
        at = datetime.fromisoformat(row["calories_fetched_at"])
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=UTC)
    return (now - at).total_seconds()


def burn_for(
    row: sqlite3.Row | dict[str, Any] | None,
    day: str,
    *,
    today: str,
    baseline: int | None,
    baseline_note: str | None,
    now: datetime,
) -> dict[str, Any]:
    """The burn block for one day. See the module docstring for the rule."""
    complete = is_complete(row, day, today)
    age = _fetched_age_s(row, now)
    out: dict[str, Any] = {
        "bmr": None, "active": None, "total": None, "so_far": None,
        "estimated": not complete, "complete": complete,
        "source": None, "baseline_note": None,
        "elapsed_min": row["day_elapsed_min"] if row is not None else None,
        "fetched_at": row["calories_fetched_at"] if row is not None else None,
        "stale": day == today and (age is None or age > STALE_AFTER_S),
    }

    if complete:
        bmr = row["calories_bmr"]
        active = row["calories_active"]
        total = row["calories_total"]
        if total is None and bmr is not None and active is not None:
            total = bmr + active
        out.update(bmr=bmr, active=active, total=total, so_far=total, source="garmin")
        return out

    if day > today:
        return out
    has_figures = row is not None and (
        row["calories_total"] is not None or row["calories_bmr"] is not None
    )
    if day < today and not has_figures:
        # A past day the watch has no burn for. No burn, no guess — a sleep
        # row alone does not make it a partial day.
        return out

    active = (row["calories_active"] if row is not None else None) or 0
    so_far = row["calories_total"] if row is not None else None
    if baseline is not None:
        bmr, source, note = baseline, "baseline", baseline_note
    elif (row is not None and row["calories_bmr"] is not None
          and row["day_elapsed_min"] is not None and row["day_elapsed_min"] >= 60):
        bmr = round(row["calories_bmr"] * 1440 / row["day_elapsed_min"])
        source = "extrapolated"
        note = f"{row['calories_bmr']:,} over {row['day_elapsed_min']} min, scaled to the day"
    else:
        bmr, source, note = None, None, None

    out.update(
        bmr=bmr,
        active=active if bmr is not None else (active or None),
        total=(bmr + active) if bmr is not None else None,
        so_far=so_far, source=source, baseline_note=note,
    )
    return out


#: Where a deficit sits against the target. Five steps, matching the
#: Scoreboard's five-tone ramp: met → strong, close → solid, short → mixed,
#: over → thin, far_over → poor. A day with no burn has none.
STANDINGS = ("met", "close", "short", "over", "far_over")


def standing_of(deficit: int | None, target: int) -> str | None:
    if deficit is None:
        return None
    if deficit >= target:
        return "met"
    if deficit >= target / 2:
        return "close"
    if deficit >= 0:
        return "short"
    if deficit > -target:
        return "over"
    return "far_over"


def _n(v: int | None) -> str:
    return "—" if v is None else f"{int(v):,}"


def arithmetic_line(burn: dict[str, Any], intake: int, deficit: int | None) -> str | None:
    """One line the page prints verbatim and the reader can redo by hand."""
    if burn["total"] is None:
        return None
    verb = "burned" if burn["complete"] else "by midnight, est."
    head = f"{_n(burn['bmr'])} baseline + {_n(burn['active'])} active = {_n(burn['total'])} {verb}"
    if deficit is None:
        return head
    if deficit > 0:
        tail = f"{_n(deficit)} under"
    elif deficit < 0:
        tail = f"{_n(-deficit)} over"
    else:
        tail = "even"
    return f"{head} · {_n(intake)} eaten · {tail}"


def day_out(
    day: str,
    meals: list[sqlite3.Row],
    row: sqlite3.Row | None,
    *,
    today: str,
    baseline: int | None,
    baseline_note: str | None,
    target: int,
    now: datetime,
) -> dict[str, Any]:
    burn = burn_for(row, day, today=today, baseline=baseline,
                    baseline_note=baseline_note, now=now)
    intake = sum(int(m["kcal"]) for m in meals)
    total = burn["total"]
    deficit = (total - intake) if total is not None else None
    eat_up_to = (total - target) if total is not None else None
    left = (eat_up_to - intake) if eat_up_to is not None else None

    if total is None:
        status = "no_burn" if meals else "empty"
    else:
        status = "complete" if burn["complete"] else "partial"

    note = None
    if status == "partial":
        note = "Projected with no more activity today; the burn can only rise from here."
    elif day < today and total is None:
        note = "No burn from the watch for this day, so there is no deficit to show."
    elif day == today and total is None:
        note = "No finished days to take a baseline from yet."

    return {
        "date": day,
        "weekday": date.fromisoformat(day).strftime("%a"),
        "status": status,
        "meals": [_meal_out(m) for m in meals],
        "intake": intake,
        "burn": burn,
        "target": target,
        "eat_up_to": eat_up_to,
        "deficit": deficit,
        "left": left,
        "standing": standing_of(deficit, target),
        "arithmetic": arithmetic_line(burn, intake, deficit),
        "note": note,
    }


def _meal_out(m: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": m["id"], "date": m["date"], "label": m["label"], "kcal": int(m["kcal"]),
        "created_at": m["created_at"], "updated_at": m["updated_at"],
    }


def _dates(start: str, end: str) -> list[str]:
    s = date.fromisoformat(start)
    e = date.fromisoformat(end)
    return [date.fromordinal(o).isoformat() for o in range(s.toordinal(), e.toordinal() + 1)]


def _mean_deficit(days: list[dict[str, Any]], end: str, n: int) -> tuple[int | None, int]:
    """Mean deficit over the `n` days ending on `end`, counting only finished,
    logged days. (mean, days_counted)."""
    start = (date.fromisoformat(end) - timedelta(days=n - 1)).isoformat()
    vals = [d["deficit"] for d in days
            if start <= d["date"] <= end and d["status"] == "complete" and d["meals"]]
    if not vals:
        return None, 0
    return round(sum(vals) / len(vals)), len(vals)


def build(
    conn: sqlite3.Connection,
    start: str,
    end: str,
    *,
    today: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Every day in the window, with its meals, its burn and the arithmetic.

    The rolling means always end yesterday regardless of the window asked
    for, like every other rolling figure in the app, so the fetch is widened
    to cover the 28 days before today when the window does not.
    """
    today = today or date.today().isoformat()
    now = now or _now()
    target, is_default, _ = deficit_target(conn)
    baseline, baseline_note = baseline_bmr(conn, today)

    yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    mean_start = (date.fromisoformat(today) - timedelta(days=28)).isoformat()
    fetch_start = min(start, mean_start)
    fetch_end = max(end, yesterday)

    meals_by_day: dict[str, list[sqlite3.Row]] = {}
    for m in q.meals_between(conn, fetch_start, fetch_end):
        meals_by_day.setdefault(m["date"], []).append(m)
    rows = {r["date"]: r for r in q.metrics_between(conn, fetch_start, fetch_end)}

    def one(day: str) -> dict[str, Any]:
        return day_out(day, meals_by_day.get(day, []), rows.get(day), today=today,
                       baseline=baseline, baseline_note=baseline_note, target=target, now=now)

    every = {d: one(d) for d in _dates(fetch_start, fetch_end)}
    days = [every[d] for d in _dates(start, end)]
    history = list(every.values())
    m7, n7 = _mean_deficit(history, yesterday, 7)
    m28, n28 = _mean_deficit(history, yesterday, 28)

    return {
        "timeframe": tf.window(start, end, grain="day", today=today).as_dict(),
        "today": today,
        "target": target,
        "target_is_default": is_default,
        "baseline": {"kcal": baseline, "note": baseline_note},
        "days": days,
        "summary": {
            "mean_deficit_7": m7, "days_counted_7": n7, "standing_7": standing_of(m7, target),
            "mean_deficit_28": m28, "days_counted_28": n28, "standing_28": standing_of(m28, target),
        },
    }
