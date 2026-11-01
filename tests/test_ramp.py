"""Week-over-week distance and the next target.

Both bugs this file guards against shipped, and both were the same mistake:
treating a week that has barely started as if it were finished.
"""

from __future__ import annotations

from datetime import date

from ledger.db import queries as q
from ledger.report import ramp


def seed(conn, weeks: dict[str, float]):
    for day, km in weeks.items():
        q.insert_session(
            conn, date=day, kind="run", source="manual",
            rpe=5, duration_min=30, distance_km=km,
        )


def test_the_target_builds_on_the_last_complete_week(conn):
    """On a Monday the current week is 0 km. Basing the target on it produced
    'no this week's to build on' — correct arithmetic, useless answer."""
    seed(conn, {"2026-08-05": 29.2})          # week of Aug 3, complete
    out = ramp.build(conn, end=date(2026, 8, 10), weeks=4)   # Monday Aug 10

    assert out["points"][-1]["in_progress"] is True
    assert out["points"][-1]["km"] == 0
    assert out["last_complete_week"]["week_start"] == "2026-08-03"

    target = out["target"]
    assert target["base_week"] == "2026-08-03"
    assert target["from_base"]["base_km"] == 29.2
    assert target["from_base"]["target_km"] == 32.1


def test_the_weeks_are_named_against_today_not_against_the_data(conn):
    """On Monday the target is for THIS week, and the base was LAST week.
    Calling them next/this is a week out, which is how it read on screen."""
    seed(conn, {"2026-08-05": 29.2})
    target = ramp.build(conn, end=date(2026, 8, 10), weeks=4)["target"]

    assert target["labels"] == {"base": "last week", "target": "this week"}
    assert target["target_week"]["start"] == "2026-08-10"
    assert target["target_week"]["is_current_week"] is True


def test_mid_week_the_target_is_still_for_the_week_under_way(conn):
    seed(conn, {"2026-08-05": 29.2})
    target = ramp.build(conn, end=date(2026, 8, 13), weeks=4)["target"]
    assert target["labels"]["target"] == "this week"
    assert target["target_week"]["is_current_week"] is True


def test_only_one_target_is_offered(conn):
    """A four-week-mean alternative was shown beside it. The user does not
    work that way, and two targets is a decision, not information."""
    seed(conn, {"2026-08-05": 29.2})
    target = ramp.build(conn, end=date(2026, 8, 10), weeks=4)["target"]
    assert "from_4w_mean" not in target


def test_no_distance_in_the_last_complete_week(conn):
    seed(conn, {"2026-07-20": 10.0})
    out = ramp.build(conn, end=date(2026, 8, 10), weeks=3)
    target = out["target"]

    assert target["from_base"] is None
    assert "no percentage to add" in target["note"]
    assert "four-week" not in target["note"]


def test_an_in_progress_week_is_not_reported_as_a_drop(conn):
    seed(conn, {"2026-08-05": 29.2})
    points = ramp.build(conn, end=date(2026, 8, 10), weeks=4)["points"]
    current = points[-1]
    assert current["in_progress"] is True
    # The completed weeks carry the verdicts; the live one is just marked.
    assert [p["in_progress"] for p in points[:-1]] == [False, False, False]


def test_soccer_and_drills_count_toward_distance_but_cycling_does_not(conn):
    day = "2026-08-05"
    q.insert_session(conn, date=day, kind="soccer", source="manual",
                     rpe=9, duration_min=60, distance_km=8.0)
    q.insert_session(conn, date=day, kind="quickfeet", source="manual",
                     rpe=4, duration_min=20, distance_km=1.5)
    q.insert_session(conn, date=day, kind="bike", source="manual",
                     rpe=6, duration_min=45, distance_km=20.0)

    week = ramp.build(conn, end=date(2026, 8, 9), weeks=1)["points"][-1]
    assert week["km"] == 9.5                       # bike excluded
    assert set(week["by_kind"]) == {"soccer", "quickfeet"}


def test_a_percentage_off_a_zero_week_is_not_a_number(conn):
    seed(conn, {"2026-08-05": 20.0})
    points = ramp.build(conn, end=date(2026, 8, 9), weeks=3)["points"]
    first_real = next(p for p in points if p["km"] > 0)
    assert first_real["delta_pct"] is None


def test_stairs_and_a_one_off_with_a_distance_count_on_foot(conn):
    """Asked for directly: 'other' counts when it has mileage attached, because
    it is on the legs. Without a distance it contributes nothing."""
    day = "2026-09-16"
    q.insert_session(conn, date=day, kind="stairs", source="manual",
                     rpe=6, duration_min=30, distance_km=1.3)
    q.insert_session(conn, date=day, kind="other", source="manual",
                     rpe=5, duration_min=40, distance_km=2.2)
    q.insert_session(conn, date=day, kind="other", source="manual",
                     rpe=3, duration_min=30)
    q.insert_session(conn, date=day, kind="bike", source="manual",
                     rpe=6, duration_min=45, distance_km=20.0)

    week = ramp.build(conn, end=date(2026, 9, 20), weeks=1)["points"][-1]
    assert week["km"] == 3.5
    assert week["by_kind"] == {"stairs": 1.3, "other": 2.2}
