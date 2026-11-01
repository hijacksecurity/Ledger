"""e1RM math (BRIEF §6). Getting this subtly wrong is invisible for months."""

from __future__ import annotations

import pytest

from ledger.core.e1rm import MAX_REPS_FOR_E1RM, SetRow, best_e1rm, epley, set_e1rm


def test_epley_single_rep_is_the_weight():
    assert epley(100, 1) == pytest.approx(103.333, abs=1e-3)


def test_epley_known_values():
    assert epley(100, 5) == pytest.approx(116.667, abs=1e-3)
    assert epley(110, 3) == pytest.approx(121.0, abs=1e-9)


def test_5x5_at_100_compares_below_3x3_at_110():
    """The whole point of using e1RM rather than raw volume."""
    assert epley(100, 5) < epley(110, 3)


def test_above_ten_reps_returns_none_not_a_misleading_number():
    assert epley(60, MAX_REPS_FOR_E1RM) is not None
    assert epley(60, MAX_REPS_FOR_E1RM + 1) is None
    assert epley(60, 20) is None


def test_unloaded_and_nonsense_input_returns_none():
    assert epley(0, 10) is None       # bodyweight set
    assert epley(-5, 5) is None
    assert epley(100, 0) is None
    assert epley(100, -1) is None


def test_warmup_sets_never_produce_an_e1rm():
    assert set_e1rm(SetRow(1, 100, 5, is_warmup=True)) is None
    assert set_e1rm(SetRow(1, 100, 5, is_warmup=False)) is not None


def test_best_e1rm_ignores_warmups_and_high_reps():
    sets = [
        SetRow(1, 140, 3, is_warmup=True),   # heaviest, but a warmup
        SetRow(1, 100, 5),
        SetRow(1, 60, 20),                   # too many reps to estimate
    ]
    assert best_e1rm(sets) == pytest.approx(epley(100, 5))


def test_best_e1rm_of_nothing_qualifying_is_none():
    assert best_e1rm([]) is None
    assert best_e1rm([SetRow(1, 0, 15)]) is None
