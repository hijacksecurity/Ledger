"""Acute:chronic is a rolling window and must not reset on a Monday.

Opening the app on a Monday morning showed acute:chronic 0.00 — "below recent
average" — after a seven-activity week. Nothing had changed about the training;
the window had simply been anchored on the Sunday the week will *end* on, so
"trailing 7 days" was one real day and six that had not happened yet.

That is a window resetting on a calendar boundary, which BRIEF §6 rules out.
The anchor is now the last day that actually happened. These tests hold that
down at both ends: a week in progress looks backwards, and a week already
finished is unaffected.
"""

from __future__ import annotations

from datetime import date, timedelta

from ledger.db import queries as q
from ledger.report import ramp, weekly

MONDAY = date(2026, 8, 10)          # the week being viewed, one day old
LAST_MONDAY = MONDAY - timedelta(days=7)


def _busy_previous_week(conn) -> None:
    """Seven scored sessions across the week that just finished, plus enough
    history behind them that the ratio is allowed to report at all."""
    for i in range(70):
        day = MONDAY - timedelta(days=14 + i)
        if day.weekday() in (1, 3):
            q.insert_session(conn, date=day.isoformat(), kind="run",
                             source="manual", rpe=5, duration_min=40)
    for i in range(7):
        q.insert_session(conn, date=(LAST_MONDAY + timedelta(days=i)).isoformat(),
                         kind="soccer", source="manual", rpe=8, duration_min=60)


def test_monday_morning_does_not_read_zero(conn):
    _busy_previous_week(conn)
    rep = weekly.build_report(conn, week_end=MONDAY, today=MONDAY)

    assert rep.week_load == 0            # nothing logged in the new week yet
    assert rep.acwr is not None
    assert rep.acwr.acute > 0, "the trailing 7 days still contain last week"
    assert rep.acwr.ratio and rep.acwr.ratio > 0.5


def test_the_windows_end_today_not_on_the_coming_sunday(conn):
    _busy_previous_week(conn)
    rep = weekly.build_report(conn, week_end=MONDAY, today=MONDAY)

    assert rep.as_of == MONDAY.isoformat()
    assert rep.week_end == (MONDAY + timedelta(days=6)).isoformat()


def test_a_finished_week_is_anchored_on_its_own_sunday(conn):
    """Looking back at a past week must not drag its window up to today."""
    _busy_previous_week(conn)
    last_sunday = LAST_MONDAY + timedelta(days=6)
    rep = weekly.build_report(conn, week_end=last_sunday, today=MONDAY)

    assert rep.as_of == last_sunday.isoformat()
    assert rep.week_load > 0


def test_the_ratio_climbs_through_the_week_rather_than_starting_from_nothing(conn):
    """Day 1 and day 4 of the same week both report against real history."""
    _busy_previous_week(conn)
    day1 = weekly.build_report(conn, week_end=MONDAY, today=MONDAY)
    day4 = weekly.build_report(conn, week_end=MONDAY,
                               today=MONDAY + timedelta(days=3))

    assert day1.acwr.ratio and day4.acwr.ratio
    # Same week, both non-zero; the later anchor has shed three of last week's
    # days from the acute window, so it is the lower of the two.
    assert day4.acwr.acute < day1.acwr.acute
    assert day1.as_of != day4.as_of


def test_the_rolling_28_day_count_also_ignores_the_unlived_days(conn):
    _busy_previous_week(conn)
    rep = weekly.build_report(conn, week_end=MONDAY, today=MONDAY)

    assert sum(rep.sessions_28d.values()) > 0


def test_the_distance_ratio_is_anchored_on_the_last_completed_week(conn):
    """The running page carries its own acute:chronic, on kilometres rather
    than load. It had the same defect from the other direction: the acute term
    was the week being lived, so a Monday divided 0 km by the four-week mean."""
    for w in range(6):
        monday = LAST_MONDAY - timedelta(weeks=w)
        for offset in (1, 3, 5):
            q.insert_session(
                conn, date=(monday + timedelta(days=offset)).isoformat(),
                kind="run", source="manual", rpe=5, duration_min=50,
                distance_km=10.0,
            )

    out = ramp.build(conn, end=MONDAY, weeks=8)
    acwr = out["acwr"]

    assert out["points"][-1]["in_progress"] is True
    assert out["points"][-1]["km"] == 0.0
    assert acwr["week_start"] == LAST_MONDAY.isoformat(), "not the live week"
    assert acwr["ratio"] == 1.0
    assert acwr["band"] == "steady"
