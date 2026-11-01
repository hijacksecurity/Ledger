"""The week runs Monday to Sunday. Everywhere. No exceptions.

Nine separate places compute a week boundary — the weekly report, the
dashboard, the distance ramp, the planner, the history grid, the SQL trend
buckets, the average, and two spots in the front end. One of them drifting by
a day would not raise anything; it would just quietly disagree with the
notebook, and the notebook is the thing this app has to match.

So the rule gets a test rather than a convention.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from ledger.db import queries as q
from ledger.report import dashboard, plan, ramp, weekly

#: A Monday, the Sunday that closes its week, and the neighbours either side.
MONDAY = date(2026, 8, 10)
SUNDAY = date(2026, 8, 16)
PREV_SUNDAY = date(2026, 8, 9)
NEXT_MONDAY = date(2026, 8, 17)


@pytest.mark.parametrize("day", [MONDAY + timedelta(days=i) for i in range(7)])
def test_every_day_of_the_week_resolves_to_the_same_monday_and_sunday(day):
    """Sunday belongs to the week that began six days earlier, not the next."""
    start, end = weekly.week_bounds(day)
    assert start == MONDAY.isoformat()
    assert end == SUNDAY.isoformat()


def test_the_boundary_is_exclusive_at_both_ends():
    assert weekly.week_bounds(PREV_SUNDAY)[0] == (MONDAY - timedelta(days=7)).isoformat()
    assert weekly.week_bounds(NEXT_MONDAY)[0] == NEXT_MONDAY.isoformat()


@pytest.mark.parametrize("monday_fn", [dashboard._monday, ramp._monday, plan._monday])
@pytest.mark.parametrize("offset", range(7))
def test_all_the_internal_monday_helpers_agree(monday_fn, offset):
    assert monday_fn(MONDAY + timedelta(days=offset)) == MONDAY


def test_sql_buckets_a_sunday_into_the_week_that_started_on_monday(conn):
    """SQLite has no ISO week, so the bucket is hand-rolled. Check it lands."""
    for day in (MONDAY, SUNDAY, NEXT_MONDAY):
        q.insert_session(
            conn, date=day.isoformat(), kind="run", source="manual",
            rpe=5, duration_min=30, distance_km=5,
        )
    rows = q.trend_points(
        conn, metric="count", grain="week",
        start=MONDAY.isoformat(), end=NEXT_MONDAY.isoformat(),
    )
    buckets = {r["period"]: r["value"] for r in rows}

    assert buckets[MONDAY.isoformat()] == 2        # Monday + Sunday together
    assert buckets[NEXT_MONDAY.isoformat()] == 1   # the next Monday is its own


def test_the_distance_ramp_uses_the_same_boundary(conn):
    q.insert_session(conn, date=SUNDAY.isoformat(), kind="run", source="manual",
                     rpe=5, duration_min=30, distance_km=7.0)
    week = ramp.build(conn, end=SUNDAY, weeks=1)["points"][-1]

    assert week["week_start"] == MONDAY.isoformat()
    assert week["km"] == 7.0


def test_a_sunday_evening_session_is_not_pushed_into_next_week(conn):
    """The reason dates are stored local and never UTC: a 21:30 Sunday game
    would otherwise land on Monday and move a whole week's totals."""
    q.insert_session(
        conn, date=SUNDAY.isoformat(), kind="soccer", source="manual",
        started_at=f"{SUNDAY.isoformat()}T21:30:00",
        rpe=9, duration_min=60, distance_km=8.0,
    )
    start, end = weekly.week_bounds(SUNDAY)
    assert [d for d, _ in q.session_events(conn, start, end)] == [SUNDAY.isoformat()]


def test_the_planner_projects_from_monday_to_monday(conn):
    """Every projected week starts on a Monday, one week apart.

    The run goes in the week *before* the one `end` sits in, because the
    planner builds on complete weeks only — see the two tests below.
    """
    q.insert_session(conn, date=PREV_SUNDAY.isoformat(), kind="run", source="manual",
                     rpe=5, duration_min=30, distance_km=20.0)
    points = plan.build(conn, pct=10, weeks=3, deload_every=0, end=SUNDAY)["points"]

    # Starts with the week being lived — you get a target for this week, built
    # on last week's actual — and steps a clean seven days from there.
    assert [p["week_start"] for p in points] == [
        (MONDAY + timedelta(weeks=i)).isoformat() for i in (0, 1, 2)
    ]


def test_the_planner_builds_on_the_last_complete_week_never_the_current_one(conn):
    """A week in progress is a partial count of itself. Building on it projects
    a collapse and then compounds it."""
    # 20 km finished last week, 1 km so far this week.
    q.insert_session(conn, date=PREV_SUNDAY.isoformat(), kind="run", source="manual",
                     rpe=5, duration_min=30, distance_km=20.0)
    q.insert_session(conn, date=MONDAY.isoformat(), kind="run", source="manual",
                     rpe=5, duration_min=10, distance_km=1.0)

    d = plan.build(conn, pct=10, weeks=3, deload_every=0, end=MONDAY)

    assert d["base_km"] == 20.0                          # not 1.0
    assert d["base_week"] == (MONDAY - timedelta(weeks=1)).isoformat()
    # The history it shows is complete weeks; the live one is not in there.
    assert MONDAY.isoformat() not in [p["week_start"] for p in d["history"]]


def test_opening_the_planner_on_a_monday_morning_does_not_project_zero(conn):
    """The bug this rule exists for: nothing logged yet this week meant a base
    of 0 km, and 0 km compounded at any percentage is eight weeks of zero."""
    q.insert_session(conn, date=PREV_SUNDAY.isoformat(), kind="run", source="manual",
                     rpe=5, duration_min=30, distance_km=20.0)

    d = plan.build(conn, pct=10, weeks=8, deload_every=0, end=MONDAY)

    assert d["base_km"] == 20.0
    assert all(p["target_km"] > 0 for p in d["points"])
    assert d["summary"]["multiplier"] is not None
