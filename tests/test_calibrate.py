"""One load scale, Garmin's, with estimates filling the gaps.

The rule this file protects: a figure the watch measured is never overridden,
and a figure we derived is never presented as if it were measured.
"""

from __future__ import annotations

import pytest

from ledger.core.calibrate import (
    FULL_TRUST_SAMPLES,
    MIN_SAMPLES_FOR_KIND,
    fit,
    session_load,
)
from ledger.db import queries as q


def add(conn, kind, rpe, minutes, garmin=None, estimated=False, date="2026-01-05"):
    detail = {}
    if garmin is not None:
        detail["garmin_load"] = garmin
    if estimated:
        detail["rpe_estimated"] = True
    return q.insert_session(
        conn, date=date, kind=kind, source="garmin" if garmin else "manual",
        rpe=rpe, duration_min=minutes, detail=detail or None,
    )


def test_no_paired_data_means_no_conversion_is_invented(conn):
    cal = fit(conn)
    assert cal.fitted is False
    value, source = session_load("run", 5, 30, None, cal)
    assert (value, source) == (150.0, "unscaled")


def test_a_measured_garmin_value_is_used_untouched(conn):
    """The watch's number is the scale. Nothing here may override it."""
    cal = fit(conn)
    assert session_load("run", 9, 200, 84.8, cal) == (84.8, "garmin")


def test_the_factor_is_fitted_from_paired_sessions(conn):
    # Ten runs where Garmin reads a third of rpe x minutes.
    for i in range(10):
        add(conn, "run", 5, 30, garmin=50.0, date=f"2026-01-{i + 1:02d}")
    cal = fit(conn)

    assert cal.fitted and cal.samples["run"] == 10
    assert cal.overall == pytest.approx(1 / 3, rel=1e-6)

    value, source = session_load("run", 5, 30, None, cal)
    assert source == "estimated"
    assert value == pytest.approx(50.0, rel=1e-3)


def test_a_modality_with_too_few_samples_borrows_the_global_factor(conn):
    for i in range(12):
        add(conn, "run", 5, 30, garmin=50.0, date=f"2026-02-{i + 1:02d}")
    add(conn, "soccer", 9, 60, garmin=200.0, date="2026-03-01")

    cal = fit(conn)
    assert cal.samples["soccer"] == 1 < MIN_SAMPLES_FOR_KIND
    assert "soccer" not in cal.by_kind
    assert cal.factor("soccer") == cal.overall


def test_a_well_sampled_modality_gets_its_own_factor(conn):
    """Soccer and running convert differently — that is the whole point."""
    for i in range(FULL_TRUST_SAMPLES):
        add(conn, "run", 5, 30, garmin=50.0, date=f"2026-04-{i % 28 + 1:02d}")
    for i in range(FULL_TRUST_SAMPLES):
        add(conn, "soccer", 9, 60, garmin=200.0, date=f"2026-05-{i % 28 + 1:02d}")

    cal = fit(conn)
    assert cal.by_kind["run"] == pytest.approx(1 / 3, rel=0.02)
    assert cal.by_kind["soccer"] == pytest.approx(200 / 540, rel=0.02)
    assert cal.by_kind["soccer"] != cal.by_kind["run"]


def test_an_estimated_rpe_never_feeds_the_fit(conn):
    """Otherwise the fit trains on its own output and drifts."""
    for i in range(10):
        add(conn, "run", 5, 30, garmin=50.0, estimated=True, date=f"2026-06-{i + 1:02d}")
    assert fit(conn).fitted is False


def test_a_session_with_nothing_to_go_on(conn):
    cal = fit(conn)
    assert session_load("fast", None, None, None, cal) == (None, "none")
    assert session_load("lift", 7, None, None, cal) == (None, "none")


def test_short_sessions_do_not_dominate_the_fit(conn):
    """Least squares through the origin, not a mean of ratios.

    A 5-minute session with a wild ratio would otherwise pull the factor
    around as hard as a 90-minute match.
    """
    for i in range(10):
        add(conn, "run", 5, 60, garmin=100.0, date=f"2026-07-{i + 1:02d}")
    add(conn, "run", 1, 2, garmin=50.0, date="2026-07-20")   # absurd ratio, tiny

    cal = fit(conn)
    # Ratio-averaging would land near 2.7; least squares stays close to 1/3.
    assert cal.overall == pytest.approx(1 / 3, rel=0.05)


def test_detail_that_is_not_json_is_skipped_not_fatal(conn):
    add(conn, "run", 5, 30, garmin=50.0)
    conn.execute("UPDATE session SET detail = 'not json' WHERE id = 1")
    assert fit(conn).total_samples == 0
