"""Rolling windows (BRIEF §6). The no-streaks guarantee lives or dies here."""

from __future__ import annotations

import pytest

from ledger.core.windows import (
    avg_activities_per_week,
    consistency,
    daily_totals,
    day_range,
    ema,
    ema_series,
    rolling_count,
    rolling_count_by_kind,
    window_start,
)


def test_window_is_inclusive_of_both_ends():
    assert window_start("2026-01-28", 28) == "2026-01-01"
    days = day_range("2026-01-28", 28)
    assert len(days) == 28
    assert days[0] == "2026-01-01"
    assert days[-1] == "2026-01-28"


def test_rolling_count_excludes_outside_the_window():
    dates = ["2025-12-31", "2026-01-01", "2026-01-15", "2026-01-28", "2026-01-29"]
    assert rolling_count(dates, "2026-01-28", 28) == 3


def test_a_missed_day_dips_the_count_it_does_not_reset_it():
    """The central anti-streak property. If this ever returns 0 after one
    missed day, the tool has become the thing BRIEF §2 forbids."""
    dates = [f"2026-01-{d:02d}" for d in range(1, 21)]  # 20 straight days
    before = rolling_count(dates, "2026-01-20", 28)
    after_missing_a_day = rolling_count(dates, "2026-01-21", 28)
    assert before == 20
    assert after_missing_a_day == 20  # still counted; the window just moved


def test_count_by_kind():
    events = [("2026-01-05", "run"), ("2026-01-06", "run"), ("2026-01-06", "soccer")]
    assert rolling_count_by_kind(events, "2026-01-28", 28) == {"run": 2, "soccer": 1}


def test_consistency_scales_a_weekly_plan_to_the_window():
    events = [("2026-01-05", "run")] * 9
    result = consistency(events, {"run": 3, "soccer": 2}, "2026-01-28", 28)
    assert result["run"] == (9, 12.0)     # 3/week over 4 weeks
    assert result["soccer"] == (0, 8.0)   # nothing done, still reported


def test_avg_activities_per_week_reproduces_the_notebook():
    """The Year-2 summary page: 218 activities @ 52 weeks -> 4.19 (docs/NOTEBOOK.md)."""
    end = "2025-12-30"  # 2025-01-01 + 52 weeks - 1 day
    assert avg_activities_per_week(218, "2025-01-01", end) == pytest.approx(4.19, abs=0.01)


def test_an_empty_week_pulls_the_average_down_without_resetting_it():
    """Week 45 logged nothing: 4.36 -> 4.26, not to zero."""
    before = avg_activities_per_week(192, "2025-01-01", "2025-11-09")
    after = avg_activities_per_week(192, "2025-01-01", "2025-11-16")
    assert after < before
    assert after > 4.0


def test_no_average_before_a_full_week_of_history():
    assert avg_activities_per_week(3, "2026-01-01", "2026-01-03") is None
    assert avg_activities_per_week(0, None, "2026-01-30") is None


def test_daily_totals_zero_fills_rest_days():
    """A rest day is a real zero for load; dropping it inflates every mean."""
    totals = daily_totals([("2026-01-28", 600.0)], "2026-01-28", 7)
    assert len(totals) == 7
    assert totals[-1] == ("2026-01-28", 600.0)
    assert all(v == 0.0 for _, v in totals[:-1])


def test_daily_totals_sums_multiple_sessions_on_one_day():
    values = [("2026-01-28", 300.0), ("2026-01-28", 250.0)]
    assert daily_totals(values, "2026-01-28", 1) == [("2026-01-28", 550.0)]


def test_ema_is_seeded_with_the_first_value_and_smooths_toward_later_ones():
    out = ema([100.0, 100.0, 100.0], span=7)
    assert out == pytest.approx([100.0, 100.0, 100.0])

    rising = ema([100.0, 110.0], span=7)
    assert rising[0] == 100.0
    assert 100.0 < rising[1] < 110.0  # lags the raw value, as intended


def test_ema_series_uses_observations_not_a_zero_filled_calendar():
    """A missed weigh-in is missing data, not a bodyweight of zero."""
    obs = [("2026-01-01", 96.0), ("2026-01-10", 95.0)]
    out = ema_series(obs, span=7)
    assert [d for d, _ in out] == ["2026-01-01", "2026-01-10"]
    assert all(v > 90 for _, v in out)


def test_ema_of_nothing_is_nothing():
    assert ema([]) == []
    assert ema_series([]) == []
