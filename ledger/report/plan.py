"""Forward planner: what the next weeks look like at a chosen ramp.

Not a training plan and not advice — arithmetic, projected honestly, with the
consequences made visible before they are committed to.

Three things this does that naive compounding does not:

1. **It shows the multiplier.** +10% a week sounds modest and is not: eight
   weeks of it is 2.14x the starting mileage. Compounding is the thing people
   get wrong, so the total is stated up front rather than discovered in week
   seven.

2. **It offers down weeks.** Real progressions are not monotonic. The common
   shape is three build weeks then one cut-back, and a planner that only ever
   goes up is quietly encouraging the injury it claims to help avoid. Building
   resumes from the last build week, not from the cut, so a down week costs
   nothing in progress.

3. **It projects acute:chronic forward**, using real history for the trailing
   weeks that have already happened. A ramp can look reasonable week to week
   and still push the ratio somewhere silly by week four; this is where that
   shows up.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from typing import Any

from ledger.db import queries as q
from ledger.report import ramp, timeframe

#: Weeks of real history used to seed the trailing mean for the first
#: projected week's acute:chronic.
HISTORY_WEEKS = 8

MAX_WEEKS = 26
MAX_PCT = 50.0

#: A cut-back week drops to this fraction of the last build week. Roughly the
#: conventional "take a third off" recovery week.
DELOAD_FACTOR = 0.7


def build(
    conn: sqlite3.Connection,
    pct: float = 10.0,
    weeks: int = 8,
    deload_every: int = 4,
    base_km: float | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    """Project `weeks` weeks forward at `pct` growth a week.

    `base_km` defaults to the **last complete week** — never the one being
    lived. `deload_every = 0` turns cut-back weeks off.

    That default is the whole point of the page. A week in progress is a
    partial count of itself: on a Monday morning it is 0 km, on a Tuesday it is
    whatever happened yesterday. Building a ramp on it projected a collapse and
    then compounded it — open the planner on a Monday and every target for the
    next eight weeks was zero. The client worked around it by passing `week_of`
    to name the last complete week itself; it no longer has to, and the
    workaround costs nothing if it keeps doing it.

    So the base, the trailing mean behind the first acute:chronic, and the week
    the projection starts from all come off complete weeks. The first projected
    week is therefore the one we are *in* — you get a target for this week,
    built on last week's actual, which is the question being asked on a Monday.
    """
    pct = max(0.0, min(MAX_PCT, float(pct)))
    weeks = max(1, min(MAX_WEEKS, int(weeks)))
    deload_every = max(0, min(12, int(deload_every)))

    # One extra week requested, because the in-progress one is about to be
    # dropped and HISTORY_WEEKS of real history still has to survive it.
    history = ramp.build(conn, end=end, weeks=HISTORY_WEEKS + 1)
    past = [p for p in history["points"] if not p["in_progress"]][-HISTORY_WEEKS:]
    base = float(base_km) if base_km is not None else (past[-1]["km"] if past else 0.0)

    # The trailing weeks that really happened, used so the first projected
    # acute:chronic is not computed against a vacuum.
    trailing = [p["km"] for p in past[-4:]] if past else []
    last_monday = (
        date.fromisoformat(past[-1]["week_start"]) if past else _monday(end or date.today())
    )

    points: list[dict[str, Any]] = []
    build_level = base
    growth = 1 + pct / 100

    for i in range(1, weeks + 1):
        is_deload = bool(deload_every) and i % deload_every == 0
        if is_deload:
            target = build_level * DELOAD_FACTOR
        else:
            build_level = build_level * growth
            target = build_level

        window = (trailing + [p["target_km"] for p in points])[-4:]
        chronic = sum(window) / len(window) if window else target
        acwr = round(target / chronic, 2) if chronic else None

        points.append(
            {
                "week_start": (last_monday + timedelta(weeks=i)).isoformat(),
                "week_index": i,
                "target_km": round(target, 1),
                "add_km": round(target - (points[-1]["target_km"] if points else base), 1),
                "is_deload": is_deload,
                "acwr": acwr,
                "acwr_band": _band(acwr),
            }
        )

    peak = max((p["target_km"] for p in points), default=base)
    return {
        "base_km": round(base, 1),
        "base_week": past[-1]["week_start"] if past else None,
        # The week being lived, reported separately and never built on. The
        # "build from" control needs to name it and show its partial total;
        # `history` below is complete weeks only, so it cannot be read off the
        # end of that list.
        "current_week": history["current"],
        "pct": pct,
        "weeks": weeks,
        "deload_every": deload_every,
        "deload_factor": DELOAD_FACTOR,
        "history": [
            {"week_start": p["week_start"], "km": p["km"]} for p in past
        ],
        # Both windows are week-grained, so they end on the Sunday the last
        # bucket finishes on rather than the Monday it starts — passing the
        # Monday understated every one of these labels by six days.
        "timeframes": {
            "history": timeframe.window(
                past[0]["week_start"] if past else None,
                _sunday(past[-1]["week_start"]) if past else None, "week", len(past),
            ).as_dict(),
            "projection": timeframe.window(
                points[0]["week_start"] if points else None,
                _sunday(points[-1]["week_start"]) if points else None, "week", weeks,
                forecast=True,      # a projection is meant to be in the future
            ).as_dict(),
            # The two halves as one continuous window, for the chart that draws
            # them on a single axis. It used to print both labels either side of
            # an arrow, which read as two periods on a page that has one.
            "span": timeframe.window(
                past[0]["week_start"] if past else (
                    points[0]["week_start"] if points else None),
                _sunday(points[-1]["week_start"]) if points else (
                    _sunday(past[-1]["week_start"]) if past else None),
                "week", len(past) + len(points), forecast=True,
            ).as_dict(),
        },
        "points": points,
        "summary": {
            "final_km": points[-1]["target_km"] if points else round(base, 1),
            "peak_km": round(peak, 1),
            # The number that stops a plan being agreed to by accident.
            "multiplier": round(peak / base, 2) if base else None,
            "total_km": round(sum(p["target_km"] for p in points), 1),
            "max_acwr": max((p["acwr"] or 0) for p in points) if points else None,
        },
        "note": _note(pct, points, base),
    }


def lock(
    conn: sqlite3.Connection,
    pct: float = 10.0,
    weeks: int = 8,
    deload_every: int = 4,
    base_km: float | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    """Commit the projection so its targets stop moving.

    Same arithmetic as `build`; the difference is that the answer is written
    down. Locking covers the week being lived and the ones after it — never
    the past, so a target you set and then missed stays on the record.
    """
    projected = build(conn, pct=pct, weeks=weeks, deload_every=deload_every,
                      base_km=base_km, end=end)
    points = projected["points"]
    if not points:
        return {"locked": 0, "weeks": [], "note": projected["note"]}

    q.replace_plan_weeks(
        conn,
        [
            {
                "week_start": p["week_start"],
                "target_km": p["target_km"],
                "is_deload": p["is_deload"],
                "base_km": projected["base_km"],
                "pct": projected["pct"],
            }
            for p in points
        ],
        from_week=points[0]["week_start"],
    )
    return {"locked": len(points), **locked(conn, end=end)}


def locked(conn: sqlite3.Connection, end: date | None = None) -> dict[str, Any]:
    """The committed plan, each week beside what actually happened.

    Reports both figures and the difference. It does not grade them: a week
    under target is a week under target, and whether that was the right call
    is not something arithmetic knows (BRIEF §6, §7).
    """
    rows = q.plan_weeks(conn)
    if not rows:
        return {"weeks": [], "locked_at": None, "timeframe": None, "summary": None}

    first, last = rows[0]["week_start"], rows[-1]["week_start"]
    this_monday = _monday(end or date.today())

    # Actual on-foot distance for every week the plan spans, from the same
    # bucketing the ramp uses so the two pages cannot disagree.
    span_weeks = (date.fromisoformat(last) - date.fromisoformat(first)).days // 7 + 1
    actual: dict[str, float] = {}
    if date.fromisoformat(first) <= this_monday:
        history = ramp.build(
            conn, end=min(this_monday, date.fromisoformat(last)) + timedelta(days=6),
            weeks=span_weeks,
        )
        actual = {p["week_start"]: p["km"] for p in history["points"]}

    weeks_out = []
    for r in rows:
        ws = r["week_start"]
        state = (
            "done" if ws < this_monday.isoformat()
            else "current" if ws == this_monday.isoformat()
            else "ahead"
        )
        km = actual.get(ws) if state in ("done", "current") else None
        weeks_out.append({
            "week_start": ws,
            "week_end": _sunday(ws),
            "target_km": round(r["target_km"], 1),
            "is_deload": bool(r["is_deload"]),
            "actual_km": km,
            # Only a finished week has a difference worth printing; a week two
            # days in is not "22 km short", it is two days in.
            "delta_km": (
                round(km - r["target_km"], 1)
                if km is not None and state == "done" else None
            ),
            "state": state,
            "locked_at": r["locked_at"],
        })

    done = [w for w in weeks_out if w["state"] == "done"]
    return {
        "weeks": weeks_out,
        "locked_at": max(r["locked_at"] for r in rows),
        "base_km": rows[-1]["base_km"],
        "pct": rows[-1]["pct"],
        "timeframe": timeframe.window(
            first, _sunday(last), "week", len(rows), forecast=True,
        ).as_dict(),
        "summary": {
            "weeks_locked": len(rows),
            "weeks_done": len(done),
            "target_km_done": round(sum(w["target_km"] for w in done), 1),
            "actual_km_done": round(sum(w["actual_km"] or 0 for w in done), 1),
            "total_target_km": round(sum(w["target_km"] for w in weeks_out), 1),
        },
    }


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _sunday(week_start: str) -> str:
    """The last day of the week a bucket labelled `week_start` covers."""
    return (date.fromisoformat(week_start) + timedelta(days=6)).isoformat()


def _band(acwr: float | None) -> str:
    """Same wording as everywhere else. A position, never a verdict."""
    if acwr is None:
        return "unknown"
    if acwr >= 1.5:
        return "sharp increase"
    if acwr < 0.8:
        return "below recent average"
    if acwr <= 1.3:
        return "steady"
    return "elevated"


def _note(pct: float, points: list[dict[str, Any]], base: float) -> str | None:
    """One honest sentence about what was just projected."""
    if not points or not base:
        return "No recent distance to build from, so there is nothing to project yet."

    peak = max(p["target_km"] for p in points)
    weeks = len(points)
    if pct == 0:
        return f"Holding at {base:.1f} km. Nothing compounds."

    sharp = [p for p in points if (p["acwr"] or 0) >= 1.5]
    text = (
        f"{pct:.0f}% a week for {weeks} weeks reaches {peak:.1f} km — "
        f"{peak / base:.2f}x where you are now."
    )
    if sharp:
        first = sharp[0]
        text += (
            f" Acute:chronic crosses 1.5 in week {first['week_index']}, which is"
            " where a ramp usually starts costing more than it buys."
        )
    return text
