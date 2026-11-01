"""Session-RPE load and ACWR (BRIEF §8)."""

from __future__ import annotations

import pytest

from ledger.core.load import (
    MIN_DAYS_FOR_ACWR,
    compute_acwr,
    load_by_kind,
    modality_split,
    session_load,
)


def test_session_load_is_rpe_times_minutes():
    assert session_load(8, 60) == 480


def test_soccer_gets_its_real_weight():
    """The hidden-load problem: a 90-minute match Garmin barely registers."""
    match = session_load(9, 90)
    easy_run = session_load(4, 40)
    assert match == 810
    assert match > 5 * easy_run


def test_missing_inputs_give_none_not_zero():
    """Missing load must be excluded from the mean, not counted as an easy day."""
    assert session_load(None, 60) is None
    assert session_load(8, None) is None
    assert session_load(8, 0) is None


def test_acwr_withheld_until_28_days_of_history_exist():
    loads = [(f"2026-01-{d:02d}", 400.0) for d in range(1, 15)]
    acwr = compute_acwr(loads, "2026-01-14", days_of_history=14)
    assert acwr.ratio is None
    assert acwr.available is False
    assert acwr.band == "building baseline"


def test_acwr_of_a_perfectly_steady_block_is_one():
    loads = [(f"2026-01-{d:02d}", 400.0) for d in range(1, 29)]
    acwr = compute_acwr(loads, "2026-01-28", days_of_history=MIN_DAYS_FOR_ACWR)
    assert acwr.ratio == pytest.approx(1.0)
    assert acwr.band == "steady"


def test_a_spike_week_is_flagged_but_not_as_a_verdict():
    loads = [(f"2026-01-{d:02d}", 100.0) for d in range(1, 22)]
    loads += [(f"2026-01-{d:02d}", 900.0) for d in range(22, 29)]
    acwr = compute_acwr(loads, "2026-01-28", days_of_history=28)
    assert acwr.ratio > 1.5
    assert acwr.band == "sharp increase"
    # Wording matters: it is an observation, not an alarm.
    assert "warning" not in acwr.band and "!" not in acwr.band


def test_zero_chronic_load_does_not_divide_by_zero():
    acwr = compute_acwr([], "2026-01-28", days_of_history=400)
    assert acwr.ratio is None
    assert acwr.chronic == 0


def test_modality_split_and_by_kind():
    sessions = [
        ("2026-01-26", "soccer", 800.0),
        ("2026-01-27", "run", 200.0),
        ("2026-01-20", "run", 999.0),  # outside the range
    ]
    totals = load_by_kind(sessions, "2026-01-26", "2026-01-28")
    assert totals == {"soccer": 800.0, "run": 200.0}
    assert modality_split(totals) == pytest.approx({"run": 0.2, "soccer": 0.8})


def test_modality_split_of_an_empty_week_is_empty_not_a_crash():
    assert modality_split({}) == {}
    assert modality_split({"run": 0.0}) == {}
