"""A backfill must not run over dates the notebook already covers.

Garmin's copy of an already-logged session arrives as a *second* row, not a
merge: `_merge_target` joins a Garmin strength activity to a manual lift and
nothing else. A bike session written "Power Zone + abs" and the watch's
11-minute "Strength" are the same half-hour, and no rule in this codebase can
tell. Five such rows once slipped in and moved the lifetime average from 4.42
to 4.47 — a figure read every day, immediately wrong to the one person who
would notice.

The duplicates are invisible to a (date, kind) check, because the two sources
label the same session differently. So the guard is on the range, not on the
rows.
"""

import json

import pytest

from ledger.db import queries as q
from ledger.db.schema import open_db


@pytest.fixture()
def conn(tmp_path):
    c = open_db(tmp_path / "t.db")
    rows = [
        ("2026-01-02", "bike", "manual", "Power Zone + abs"),
        ("2026-01-17", "other", "manual", "kettlebell intro"),
        ("2026-08-28", "run", "garmin", "Riverside Running"),
    ]
    for date, kind, source, notes in rows:
        c.execute(
            "INSERT INTO session (date, kind, source, notes) VALUES (?, ?, ?, ?)",
            (date, kind, source, notes),
        )
    return c


def test_finds_hand_entered_sessions_in_range(conn):
    hits = q.manual_sessions_between(conn, "2026-01-01", "2026-02-01")
    assert [r["date"] for r in hits] == ["2026-01-02", "2026-01-17"]


def test_ignores_garmin_sourced_sessions(conn):
    """Only the notebook makes a range unsafe; Garmin rows merge by activity id."""
    hits = q.manual_sessions_between(conn, "2026-08-01", "2026-09-01")
    assert hits == []


def test_a_clean_range_is_reported_clean(conn):
    assert q.manual_sessions_between(conn, "2026-03-01", "2026-04-01") == []


def test_the_range_is_inclusive_at_both_ends(conn):
    assert len(q.manual_sessions_between(conn, "2026-01-02", "2026-01-17")) == 2
    assert len(q.manual_sessions_between(conn, "2026-01-03", "2026-01-16")) == 0
