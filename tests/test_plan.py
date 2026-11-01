"""Forward distance planner.

The thing this must never do is make a ramp look safer than it is. Every test
here is about a way that could happen: compounding hidden behind a modest
weekly percentage, a down week silently costing progress, or an acute:chronic
spike that only appears in week four.
"""

from __future__ import annotations

import pytest

from ledger.db import queries as q
from ledger.report import plan


def seed(conn, weekly_km: float, weeks: int = 6, start: str = "2026-06-01"):
    """One run a week of the given distance, on consecutive Mondays.

    Returns the last Monday, which every test passes back as `end` — the
    projection window is relative to a date, and a test that depends on
    today's date passes until it silently doesn't.
    """
    from datetime import date, timedelta

    monday = date.fromisoformat(start)
    for i in range(weeks):
        q.insert_session(
            conn, date=(monday + timedelta(weeks=i)).isoformat(), kind="run",
            source="manual", rpe=5, duration_min=30, distance_km=weekly_km,
        )
    return date.fromisoformat(start) + timedelta(weeks=weeks - 1)


def test_the_ramp_compounds_and_the_multiplier_is_stated(conn):
    """+10% sounds modest; eight weeks of it is not. Say so up front."""
    end = seed(conn, 20.0)
    out = plan.build(conn, pct=10, weeks=8, deload_every=0, end=end)

    assert out["base_km"] == 20.0
    assert out["points"][0]["target_km"] == 22.0
    assert out["points"][-1]["target_km"] == pytest.approx(20 * 1.1 ** 8, abs=0.2)
    assert out["summary"]["multiplier"] == pytest.approx(1.1 ** 8, abs=0.02)
    assert "2.14x" in out["note"] or "x where you are now" in out["note"]


def test_zero_percent_holds_flat(conn):
    end = seed(conn, 20.0)
    out = plan.build(conn, pct=0, weeks=4, deload_every=0, end=end)
    assert {p["target_km"] for p in out["points"]} == {20.0}
    assert "Nothing compounds" in out["note"]


def test_a_down_week_cuts_back_without_costing_progress(conn):
    """Building must resume from the last build week, not from the cut."""
    end = seed(conn, 20.0)
    out = plan.build(conn, pct=10, weeks=5, deload_every=4, end=end)
    weeks = out["points"]

    assert weeks[3]["is_deload"] is True
    assert weeks[3]["target_km"] < weeks[2]["target_km"]
    # Week 5 continues from week 3's level, not from the cut.
    assert weeks[4]["target_km"] == pytest.approx(weeks[2]["target_km"] * 1.1, abs=0.2)


def test_down_weeks_can_be_turned_off(conn):
    end = seed(conn, 20.0)
    out = plan.build(conn, pct=10, weeks=8, deload_every=0, end=end)
    assert not any(p["is_deload"] for p in out["points"])


def test_acute_chronic_is_projected_against_real_history(conn):
    """A ramp can read fine week to week and still spike the ratio."""
    end = seed(conn, 10.0)
    out = plan.build(conn, pct=25, weeks=6, deload_every=0, end=end)

    assert all(p["acwr"] is not None for p in out["points"])
    assert out["summary"]["max_acwr"] >= 1.3
    assert any(p["acwr_band"] in ("elevated", "sharp increase") for p in out["points"])


def test_a_sharp_ramp_names_the_week_it_goes_wrong(conn):
    end = seed(conn, 10.0)
    note = plan.build(conn, pct=40, weeks=8, deload_every=0, end=end)["note"]
    assert "crosses 1.5 in week" in note


def test_inputs_are_clamped_not_trusted(conn):
    end = seed(conn, 20.0)
    assert plan.build(conn, pct=999, weeks=999, end=end)["pct"] == plan.MAX_PCT
    assert len(plan.build(conn, pct=10, weeks=999, end=end)["points"]) == plan.MAX_WEEKS
    assert len(plan.build(conn, pct=10, weeks=0, end=end)["points"]) == 1
    assert plan.build(conn, pct=-5, weeks=4, end=end)["pct"] == 0.0


def test_an_explicit_base_overrides_the_last_week(conn):
    """So a bad week does not have to define the next eight."""
    end = seed(conn, 5.0)
    out = plan.build(conn, pct=10, weeks=3, deload_every=0, base_km=30, end=end)
    assert out["base_km"] == 30.0
    assert out["points"][0]["target_km"] == 33.0


def test_an_empty_record_projects_nothing_rather_than_zeros(conn):
    out = plan.build(conn, pct=10, weeks=4)
    assert out["base_km"] == 0.0
    assert "nothing to project" in out["note"]


def test_history_is_returned_so_the_plan_continues_the_real_line(conn):
    end = seed(conn, 20.0, weeks=6)
    out = plan.build(conn, pct=10, weeks=4, end=end)
    assert len(out["history"]) == plan.HISTORY_WEEKS
    assert out["history"][-1]["km"] == 20.0
