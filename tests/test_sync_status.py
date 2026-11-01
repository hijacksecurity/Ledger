"""Sync health.

The nightly job failed on its first run — Garmin had never been authenticated —
wrote one row to `sync_log`, and nothing surfaced it. It would have kept failing
indefinitely. BRIEF §12 calls `sync_log` the only debugging surface; that is
true but insufficient, because nobody reads a table they are not pointed at.

These tests pin the part that was missing: the failure has to be *visible*, and
it has to say what to do next.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from ledger.db import queries as q
from ledger.garmin.status import STALE_AFTER_HOURS, build_status, next_scheduled

NOW = datetime(2026, 8, 9, 12, 0, tzinfo=UTC)


def log(conn, endpoint, status_, when, detail=None):
    conn.execute(
        "INSERT INTO sync_log (ran_at, endpoint, date_range, status, detail) "
        "VALUES (?, ?, NULL, ?, ?)",
        (when.isoformat(), endpoint, status_, detail),
    )


@pytest.fixture
def tokens(tmp_path):
    d = tmp_path / "garth"
    d.mkdir()
    (d / "oauth1_token.json").write_text("{}")
    return d


@pytest.fixture
def no_tokens(tmp_path):
    return tmp_path / "empty"


def test_never_authenticated_is_reported_with_the_fix(conn, no_tokens):
    s = build_status(conn, no_tokens, now=NOW)
    assert s["state"] == "not_authenticated"
    assert s["healthy"] is False
    assert "garmin-login" in s["next_action"]


def test_an_empty_token_directory_is_not_authenticated(conn, tmp_path):
    empty = tmp_path / "garth"
    empty.mkdir()
    assert build_status(conn, empty, now=NOW)["state"] == "not_authenticated"


def test_the_real_failure_that_shipped(conn, no_tokens):
    """Exactly what was sitting in the database, unseen."""
    log(conn, "login", "error", NOW - timedelta(hours=5),
        "token resume failed: Username and password are required")
    s = build_status(conn, no_tokens, now=NOW)

    assert s["healthy"] is False
    assert s["last_error"]["endpoint"] == "login"
    assert "Username and password" in s["last_error"]["detail"]


def test_a_healthy_sync(conn, tokens):
    log(conn, "get_activities_by_date", "ok", NOW - timedelta(hours=9))
    s = build_status(conn, tokens, now=NOW)

    assert s["state"] == "ok" and s["healthy"] is True
    assert s["hours_since_success"] == 9.0
    assert s["next_action"] is None


def test_goes_stale_after_two_missed_nights(conn, tokens):
    log(conn, "get_activities_by_date", "ok", NOW - timedelta(hours=STALE_AFTER_HOURS + 1))
    s = build_status(conn, tokens, now=NOW)
    assert s["state"] == "stale"
    assert "garmin-login" in s["next_action"]


def test_calls_that_are_not_data_pulls_do_not_count_as_success(conn, tokens):
    """A logged-in-but-fetched-nothing run is not a working sync."""
    log(conn, "login", "ok", NOW - timedelta(hours=1))
    assert build_status(conn, tokens, now=NOW)["state"] == "never_succeeded"


def test_a_later_failure_does_not_erase_a_recent_success(conn, tokens):
    log(conn, "get_activities_by_date", "ok", NOW - timedelta(hours=3))
    log(conn, "get_hrv_data", "error", NOW - timedelta(hours=2), "boom")
    s = build_status(conn, tokens, now=NOW)

    assert s["state"] == "ok"                      # the pull worked
    assert s["last_error"]["endpoint"] == "get_hrv_data"   # and the wart still shows


def test_running_wins_over_everything(conn, no_tokens):
    s = build_status(conn, no_tokens, running=True, now=NOW)
    assert s["state"] == "running" and s["healthy"] is True


def test_rate_limited_surfaces_as_the_last_error(conn, tokens):
    log(conn, "get_activities_by_date", "rate_limited", NOW - timedelta(hours=1), "429")
    assert build_status(conn, tokens, now=NOW)["last_error"]["status"] == "rate_limited"


def test_next_scheduled_rolls_to_tomorrow_once_the_hour_has_passed(conn):
    assert next_scheduled(3, now=datetime(2026, 8, 9, 4, 0)).startswith("2026-08-10T03:00")
    assert next_scheduled(3, now=datetime(2026, 8, 9, 1, 0)).startswith("2026-08-09T03:00")


def test_garbled_timestamps_do_not_crash_the_status(conn, tokens):
    """sync_log is written by a job that must never fail; reading it must not either."""
    q.log_sync(conn, "get_activities_by_date", "ok")
    conn.execute("UPDATE sync_log SET ran_at = 'not a timestamp'")
    assert build_status(conn, tokens, now=NOW)["state"] == "never_succeeded"
