"""PR detection (BRIEF §6). Never invent a PR to have something to show."""

from __future__ import annotations

from ledger.core.e1rm import SetRow
from ledger.core.prs import PriorBests, detect_prs


def kinds(hits) -> set[str]:
    return {h.kind for h in hits}


def test_first_ever_session_is_a_first_time_pr():
    hits = detect_prs(1, [SetRow(1, 100, 5)], PriorBests())
    assert "first_time" in kinds(hits)


def test_a_repeat_of_a_previous_best_is_not_a_pr():
    """Ties do not count. A report that always celebrates is not trustworthy."""
    prior = PriorBests(
        ever_logged=True,
        best_e1rm=116.6667,
        best_session_volume=1500.0,
        best_reps_at_weight={100.0: 5},
    )
    hits = detect_prs(1, [SetRow(1, 100, 5), SetRow(1, 100, 5), SetRow(1, 100, 5)], prior)
    assert hits == []


def test_beating_the_e1rm_is_detected_with_the_set_that_did_it():
    prior = PriorBests(ever_logged=True, best_e1rm=116.0)
    hits = detect_prs(1, [SetRow(1, 110, 3)], prior)
    e1rm = next(h for h in hits if h.kind == "e1rm")
    assert e1rm.value == 121.0
    assert e1rm.context == {"weight": 110, "reps": 3}


def test_warmups_never_count_toward_any_pr():
    prior = PriorBests(ever_logged=True, best_e1rm=100.0, best_session_volume=100.0)
    hits = detect_prs(1, [SetRow(1, 200, 5, is_warmup=True)], prior)
    assert hits == []


def test_reps_at_weight_is_per_exact_weight():
    prior = PriorBests(ever_logged=True, best_reps_at_weight={100.0: 5})
    hits = detect_prs(1, [SetRow(1, 100, 6), SetRow(1, 102.5, 3)], prior)
    weights = {h.context["weight"] for h in hits if h.kind == "reps_at_weight"}
    assert 100.0 in weights    # 6 beats 5
    assert 102.5 not in weights  # a new weight is not a PR, just a new weight


def test_a_lighter_session_celebrates_nothing():
    """90x3 the week after 100x5 must come back empty."""
    prior = PriorBests(
        ever_logged=True,
        best_e1rm=116.67,
        best_session_volume=1000.0,
        best_reps_at_weight={100.0: 5},
    )
    assert detect_prs(1, [SetRow(1, 90, 3)], prior) == []


def test_session_volume_pr():
    prior = PriorBests(ever_logged=True, best_session_volume=1000.0)
    hits = detect_prs(1, [SetRow(1, 100, 6), SetRow(1, 100, 6)], prior)
    vol = next(h for h in hits if h.kind == "session_volume")
    assert vol.value == 1200.0


def test_high_rep_sets_give_no_e1rm_pr_but_can_still_set_volume():
    prior = PriorBests(ever_logged=True, best_e1rm=200.0, best_session_volume=100.0)
    hits = detect_prs(1, [SetRow(1, 60, 20)], prior)
    assert "e1rm" not in kinds(hits)
    assert "session_volume" in kinds(hits)


def test_a_session_of_only_warmups_yields_nothing():
    assert detect_prs(1, [SetRow(1, 60, 5, is_warmup=True)], PriorBests()) == []


def test_context_serialises_to_json():
    hits = detect_prs(1, [SetRow(1, 100, 5)], PriorBests())
    assert all(h.context_json().startswith("{") for h in hits)
