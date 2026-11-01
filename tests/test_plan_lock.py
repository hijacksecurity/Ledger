"""A committed plan holds still.

The planner re-projects from the last complete week every time it is opened,
which is right for exploring and useless for holding yourself to anything:
move the slider and last week's target silently becomes a different target, so
"did I hit it?" has no answer.

Locking writes the numbers down. The rules that make the comparison honest:

* Locking covers the week being lived and the ones after it. Weeks already past
  are never rewritten — a target you set and then missed stays on the record.
* Only a *finished* week gets a difference. A week two days in is not "22 km
  short", it is two days in.
* The plan is never graded. Both figures and the gap between them, no verdict
  (BRIEF §6, §7).
"""

from __future__ import annotations

from datetime import date, timedelta

from ledger.db import queries as q
from ledger.report import plan

#: Mondays. TODAY sits two days into the week beginning CURRENT.
PREV = date(2026, 8, 3)
CURRENT = date(2026, 8, 10)
TODAY = date(2026, 8, 11)


def _run(conn, day: date, km: float) -> None:
    q.insert_session(conn, date=day.isoformat(), kind="run", source="manual",
                     rpe=5, duration_min=int(km * 6), distance_km=km)


def test_locking_writes_the_projection_down(conn):
    _run(conn, PREV, 20.0)

    out = plan.lock(conn, pct=10, weeks=4, deload_every=0, end=TODAY)

    assert out["locked"] == 4
    assert [w["week_start"] for w in out["weeks"]] == [
        (CURRENT + timedelta(weeks=i)).isoformat() for i in range(4)
    ]
    # 20 km base, +10% a week, starting with the week we are in.
    assert [w["target_km"] for w in out["weeks"]] == [22.0, 24.2, 26.6, 29.3]


def test_a_locked_target_does_not_move_when_the_slider_does(conn):
    """The whole point. Re-projecting must not silently restate the past."""
    _run(conn, PREV, 20.0)
    plan.lock(conn, pct=10, weeks=4, deload_every=0, end=TODAY)
    first_locked = plan.locked(conn, end=TODAY)["weeks"][0]["target_km"]

    # Explore a different ramp without committing it.
    plan.build(conn, pct=25, weeks=4, deload_every=0, end=TODAY)

    assert plan.locked(conn, end=TODAY)["weeks"][0]["target_km"] == first_locked


def test_relocking_replaces_the_future_and_leaves_the_past_alone(conn):
    _run(conn, PREV, 20.0)
    plan.lock(conn, pct=10, weeks=4, deload_every=0, end=TODAY)

    # A fortnight later, re-plan harder.
    later = TODAY + timedelta(weeks=2)
    plan.lock(conn, pct=30, weeks=4, deload_every=0, end=later)

    weeks = {w["week_start"]: w for w in plan.locked(conn, end=later)["weeks"]}
    # The two weeks already lived keep the targets they were given.
    assert weeks[CURRENT.isoformat()]["target_km"] == 22.0
    assert weeks[(CURRENT + timedelta(weeks=1)).isoformat()]["target_km"] == 24.2
    # The week being lived now was re-planned at the new rate.
    assert weeks[(CURRENT + timedelta(weeks=2)).isoformat()]["target_km"] != 26.6


def test_only_a_finished_week_gets_a_difference(conn):
    _run(conn, PREV, 20.0)
    plan.lock(conn, pct=10, weeks=3, deload_every=0, end=TODAY)
    _run(conn, TODAY, 3.0)                       # two days into the current week

    weeks = plan.locked(conn, end=TODAY)["weeks"]
    current = next(w for w in weeks if w["week_start"] == CURRENT.isoformat())

    assert current["state"] == "current"
    assert current["actual_km"] == 3.0           # shown...
    assert current["delta_km"] is None           # ...but not scored as a shortfall
    assert all(w["delta_km"] is None for w in weeks if w["state"] == "ahead")


def test_a_finished_week_reports_both_figures_and_the_gap(conn):
    _run(conn, PREV, 20.0)
    plan.lock(conn, pct=10, weeks=3, deload_every=0, end=TODAY)
    _run(conn, CURRENT, 18.0)                    # fell short of the 22.0 target

    # A week later, the locked week is finished.
    later = TODAY + timedelta(weeks=1)
    done = next(w for w in plan.locked(conn, end=later)["weeks"]
                if w["week_start"] == CURRENT.isoformat())

    assert done["state"] == "done"
    assert done["target_km"] == 22.0
    assert done["actual_km"] == 18.0
    assert done["delta_km"] == -4.0


def test_an_unlocked_plan_reads_as_empty_rather_than_erroring(conn):
    out = plan.locked(conn, end=TODAY)

    assert out["weeks"] == []
    assert out["locked_at"] is None
    assert out["summary"] is None


def test_clearing_from_a_week_keeps_everything_before_it(conn):
    _run(conn, PREV, 20.0)
    plan.lock(conn, pct=10, weeks=4, deload_every=0, end=TODAY)

    cut = (CURRENT + timedelta(weeks=2)).isoformat()
    q.clear_plan_weeks(conn, cut)

    remaining = [w["week_start"] for w in plan.locked(conn, end=TODAY)["weeks"]]
    assert remaining == [CURRENT.isoformat(), (CURRENT + timedelta(weeks=1)).isoformat()]


def test_the_locked_window_is_marked_as_a_forecast(conn):
    """It runs into the future by design, so the clamp must not pull it back."""
    _run(conn, PREV, 20.0)
    out = plan.lock(conn, pct=10, weeks=4, deload_every=0, end=TODAY)

    tf = out["timeframe"]
    assert tf["to"] == (CURRENT + timedelta(weeks=3, days=6)).isoformat()
    assert tf["to"] > TODAY.isoformat()


def test_locking_never_builds_on_the_week_being_lived(conn):
    """Same rule as the projection: 3 km logged so far this week must not
    become the base for an eight-week ramp."""
    _run(conn, PREV, 20.0)
    _run(conn, CURRENT, 3.0)

    out = plan.lock(conn, pct=10, weeks=4, deload_every=0, end=TODAY)

    assert out["base_km"] == 20.0
    assert out["weeks"][0]["target_km"] == 22.0
