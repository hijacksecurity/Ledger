"""Week-over-week distance on foot, and whether the ramp is sane.

"On foot" means everything that puts running miles through the legs — soccer,
running, stairs, quick feet and rucking, and anything filed as 'other' that
carries a distance (asked for directly: a one-off on the legs is still on the
legs). Cycling is excluded: 20 km on a Peloton is not 20 km of impact, and
averaging them makes the ramp meaningless.

The guide rail is the conventional ~10% weekly progression: widely taught,
weakly evidenced, and useful mainly as a place to look twice. It is reported
as a band with the actual number beside it, never as a pass or a fail.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from typing import Any

from ledger.core import load as load_mod
from ledger.core.windows import to_date
from ledger.db import queries as q
from ledger.report import timeframe

#: Anything that runs. Bike is deliberately absent. 'other' is present only
#: for its distance: every consumer of this tuple sums `distance_km`, so an
#: 'other' session without one contributes nothing, and one with a distance
#: was on the legs by the user's own rule. Mirrors `ON_FOOT` in `web/core.js`.
ON_FOOT = ("soccer", "run", "stairs", "quickfeet", "ruck", "other")

#: The classic progression rule. A heuristic, not a limit.
STEADY_MAX_PCT = 10.0
SHARP_PCT = 30.0


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def build(
    conn: sqlite3.Connection,
    end: date | None = None,
    weeks: int = 26,
    soccer_km_per_match: float | None = None,
) -> dict[str, Any]:
    """Weekly on-foot distance, the change against last week, and context.

    `soccer_km_per_match` is opt-in. Soccer carries no distance in the record —
    the notebook only ever kept weekly totals — so by default matches are
    counted but contribute no kilometres, and the gap is reported rather than
    hidden. Supplying a figure applies it uniformly and marks the output as
    estimated.
    """
    end = end or date.today()
    last_monday = _monday(end)
    first_monday = last_monday - timedelta(weeks=weeks - 1)

    rows = conn.execute(
        "SELECT date, kind, distance_km FROM session "
        "WHERE date BETWEEN ? AND ? AND kind IN "
        f"({','.join('?' * len(ON_FOOT))})",
        (first_monday.isoformat(), (last_monday + timedelta(days=6)).isoformat(), *ON_FOOT),
    ).fetchall()

    buckets: dict[str, dict[str, float]] = {
        (first_monday + timedelta(weeks=i)).isoformat(): {} for i in range(weeks)
    }
    matches: dict[str, int] = dict.fromkeys(buckets, 0)
    measured = unmeasured = 0

    for r in rows:
        key = _monday(to_date(r["date"])).isoformat()
        if key not in buckets:
            continue
        km = r["distance_km"]
        if r["kind"] == "soccer":
            matches[key] += 1
            if km is None:
                unmeasured += 1
                km = soccer_km_per_match
            else:
                measured += 1
        if km:
            buckets[key][r["kind"]] = buckets[key].get(r["kind"], 0.0) + float(km)

    this_monday = _monday(end)
    points: list[dict[str, Any]] = []
    totals: list[float] = []
    for week_start, by_kind in buckets.items():
        total = round(sum(by_kind.values()), 2)
        totals.append(total)
        prior = totals[-2] if len(totals) > 1 else None
        trailing = totals[max(0, len(totals) - 5):-1]

        points.append(
            {
                "week_start": week_start,
                "km": total,
                "by_kind": {k: round(v, 2) for k, v in by_kind.items()},
                "matches": matches[week_start],
                "delta_km": round(total - prior, 2) if prior is not None else None,
                # A percentage off a zero baseline is not a number. Say so.
                "delta_pct": (
                    round((total - prior) / prior * 100, 1)
                    if prior not in (None, 0) else None
                ),
                "mean_4w": round(sum(trailing) / len(trailing), 2) if trailing else None,
                "verdict": _verdict(total, prior),
                # A week still being lived is not a low week. Everything that
                # projects forward has to skip it or it reads as a collapse.
                "in_progress": week_start == this_monday.isoformat(),
            }
        )

    current = points[-1] if points else None
    complete = [p for p in points if not p["in_progress"]]
    return {
        "target": _next_target(complete, this_monday),
        # Kept under the old key too so nothing breaks mid-change.
        "next_week": _next_target(complete, this_monday),
        "last_complete_week": complete[-1] if complete else None,
        "weeks": weeks,
        "end": end.isoformat(),
        "timeframe": timeframe.window(
            first_monday.isoformat(),
            (last_monday + timedelta(days=6)).isoformat(), "week", weeks,
        ).as_dict(),
        "on_foot_kinds": list(ON_FOOT),
        "steady_max_pct": STEADY_MAX_PCT,
        "sharp_pct": SHARP_PCT,
        "points": points,
        "current": current,
        # On completed weeks only, for the same reason `target` is: the acute
        # term used to be the week being lived, so opening the app on a Monday
        # divided 0 km by the four-week mean and printed 0.00 "below recent
        # average" after a 29 km week. The rest of this function already skips
        # the in-progress week; this was the one place that did not.
        "acwr": _distance_acwr(complete),
        "soccer": {
            "matches_in_range": sum(matches.values()),
            "with_distance": measured,
            "without_distance": unmeasured,
            "assumed_km_per_match": soccer_km_per_match,
            "estimated": soccer_km_per_match is not None and unmeasured > 0,
            "note": (
                "Soccer carries no per-match distance in the record, so those "
                "matches add no kilometres here. Garmin is what fills that in."
                if soccer_km_per_match is None and unmeasured
                else None
            ),
        },
        "guidance": (
            f"A weekly rise under about {STEADY_MAX_PCT:.0f}% is the usual "
            "guide for adding running volume. It is a rule of thumb, not a "
            "limit — read it next to how the legs actually feel."
        ),
    }


def _verdict(total: float, prior: float | None) -> str:
    """Plain words, no colour, no pass/fail."""
    if prior is None:
        return "no prior week"
    if prior == 0:
        return "first week back" if total > 0 else "no distance"
    if total == 0:
        return "no distance"
    change = (total - prior) / prior * 100
    if change < -STEADY_MAX_PCT:
        return "down on last week"
    if change <= STEADY_MAX_PCT:
        return "steady"
    if change <= SHARP_PCT:
        return "above the usual ramp"
    return "well above the usual ramp"


def _distance_acwr(points: list[dict[str, Any]]) -> dict[str, Any]:
    """The same acute:chronic idea, on distance instead of load.

    `points` must be completed weeks. A week still being lived is not a light
    week, and putting one in the acute slot makes the ratio a function of which
    day you opened the app.
    """
    if len(points) < 4:
        return {"ratio": None, "band": "building baseline", "week_start": None}

    acute = points[-1]["km"]
    chronic_weeks = [p["km"] for p in points[-4:]]
    chronic = sum(chronic_weeks) / len(chronic_weeks)
    ratio = round(acute / chronic, 2) if chronic else None

    return {
        "ratio": ratio,
        "acute_km": round(acute, 2),
        "chronic_km": round(chronic, 2),
        # Which week the acute term is, so the UI can name it instead of
        # letting the reader assume it means today.
        "week_start": points[-1]["week_start"],
        "band": load_mod.ACWR(
            acute=acute, chronic=chronic, ratio=ratio, days_of_history=28
        ).band,
    }


def week_notes(conn: sqlite3.Connection, week_start: str) -> list[dict[str, Any]]:
    return [
        {"id": r["id"], "position": r["position"], "text": r["text"],
         "created_at": r["created_at"]}
        for r in q.week_notes(conn, week_start)
    ]


def _next_target(
    points: list[dict[str, Any]], this_monday: date | None = None
) -> dict[str, Any] | None:
    """What next week should look like if the ramp stays sane.

    `points` must contain COMPLETED weeks only. Basing this on a week still in
    progress produced "no this week's to build on" every Monday morning, which
    is both wrong and useless — the thing to build on is the week that just
    finished.

    One basis: the week that just finished, plus the ramp. That is what the
    10% rule means and what the user actually works from. A four-week-mean
    alternative was offered here and removed — a second target next to the
    first is not more information, it is a decision the reader has to make
    every time they look at the panel.
    """
    if not points:
        return None

    this_week = points[-1]["km"]

    # The target applies to the week AFTER the last complete one. On a Monday
    # that is the week already under way, so calling it "next week" is a week
    # out — and so is calling the base "this week". Both names are decided
    # here, against today, rather than guessed in the UI.
    base_monday = to_date(points[-1]["week_start"])
    target_monday = base_monday + timedelta(weeks=1)
    is_now = this_monday is not None and target_monday == this_monday
    labels = (
        {"base": "last week", "target": "this week"} if is_now
        else {"base": "this week", "target": "next week"}
    )
    span = {
        "start": target_monday.isoformat(),
        "end": (target_monday + timedelta(days=6)).isoformat(),
        "is_current_week": is_now,
    }

    def step(base: float) -> dict[str, Any]:
        return {
            "base_km": round(base, 1),
            "target_km": round(base * (1 + STEADY_MAX_PCT / 100), 1),
            "add_km": round(base * STEADY_MAX_PCT / 100, 1),
        }

    # After a zero or near-zero week, a percentage of nothing is nothing. Say
    # so rather than printing a target of 0.0 km.
    if this_week <= 0:
        return {
            "base_week": points[-1]["week_start"],
            "target_week": span,
            "labels": labels,
            "from_base": None,
            "from_this_week": None,
            "note": (
                "Nothing was logged in the last complete week, so there is no "
                "percentage to add yet. The target returns with the first "
                "distance logged."
            ),
        }

    return {
        "base_week": points[-1]["week_start"],
        "target_week": span,
        "labels": labels,
        "from_base": step(this_week),
        "from_this_week": step(this_week),
        "note": (
            f"About {STEADY_MAX_PCT:.0f}% is the usual ceiling for adding "
            "running volume week to week. A guide, not a limit."
        ),
    }
