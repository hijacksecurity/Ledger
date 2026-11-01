"""Migrations, PR persistence, and sync idempotency (BRIEF §12)."""

from __future__ import annotations

import pytest

from ledger.core.e1rm import SetRow
from ledger.db import queries as q
from ledger.db.schema import connect, migrate, pending_migrations
from ledger.entry import parse_entry
from ledger.garmin.sync import sync_range
from ledger.ingest import save_session


def test_migrations_apply_and_are_not_reapplied(tmp_path):
    conn = connect(tmp_path / "m.db")
    first = migrate(conn)
    assert "001_init.sql" in first
    assert "002_notebook_reality.sql" in first
    assert pending_migrations(conn) == []
    assert migrate(conn) == []      # second run is a no-op


def test_wal_and_foreign_keys_are_on(conn):
    assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_deleting_a_session_cascades_to_its_sets(conn):
    ex = q.get_or_create_exercise(conn, "Barbell Back Squat")
    sid = q.insert_session(conn, date="2026-01-05", kind="lift", source="manual")
    q.add_sets(conn, sid, [SetRow(ex, 100, 5)])
    conn.execute("DELETE FROM session WHERE id = ?", (sid,))
    assert conn.execute("SELECT COUNT(*) FROM lift_set").fetchone()[0] == 0


def test_exercise_lookup_is_case_insensitive_and_alias_aware(conn):
    a = q.get_or_create_exercise(conn, "Barbell Back Squat")
    assert q.get_or_create_exercise(conn, "barbell back squat") == a
    q.add_alias(conn, a, "sq")
    assert q.get_or_create_exercise(conn, "SQ") == a
    assert conn.execute("SELECT COUNT(*) FROM exercise").fetchone()[0] == 1


def test_metric_upsert_never_nulls_an_existing_value(conn):
    """A metric that failed to fetch must leave yesterday's value alone."""
    q.upsert_metric_daily(conn, "2026-01-05", bodyweight_kg=96.0, hrv_ms=48.0)
    q.upsert_metric_daily(conn, "2026-01-05", bodyweight_kg=95.5, hrv_ms=None)
    row = conn.execute("SELECT * FROM metric_daily WHERE date='2026-01-05'").fetchone()
    assert row["bodyweight_kg"] == 95.5   # revised
    assert row["hrv_ms"] == 48.0          # preserved


def test_prior_bests_excludes_the_session_being_scored(conn):
    sessions = parse_entry(
        "2026-01-05 lift\nsquat 100x5\n\n2026-01-12 lift\nsquat 105x5\n"
    )
    _, first_hits = save_session(conn, sessions[0])
    _, second_hits = save_session(conn, sessions[1])

    assert {h.kind for h in first_hits} >= {"first_time", "e1rm"}
    # The second session must see the first as history, and beat it.
    assert "first_time" not in {h.kind for h in second_hits}
    assert "e1rm" in {h.kind for h in second_hits}


def test_no_pr_on_a_worse_session(conn):
    sessions = parse_entry(
        "2026-01-05 lift\nsquat 100x5 100x5\n\n2026-01-12 lift\nsquat 90x3\n"
    )
    save_session(conn, sessions[0])
    _, hits = save_session(conn, sessions[1])
    assert hits == []   # an empty PR list is a normal week


# --- sync idempotency -----------------------------------------------------

ACTIVITY = {
    "activityId": 555,
    "startTimeLocal": "2026-01-05 18:30:00",
    "duration": 3600,
    "activityType": {"typeKey": "indoor_soccer"},
    "activityName": "Indoor Soccer",
}


def test_sync_is_idempotent(conn, fake_client):
    client, _ = fake_client(activities=[ACTIVITY])
    sync_range(conn, client, "2026-01-05", "2026-01-05")

    client2, _ = fake_client(activities=[ACTIVITY])
    sync_range(conn, client2, "2026-01-05", "2026-01-05")

    assert conn.execute("SELECT COUNT(*) FROM session").fetchone()[0] == 1


def test_resync_does_not_wipe_a_user_supplied_rpe(conn, fake_client):
    """RPE is the one field the watch cannot provide. Never overwrite it."""
    client, _ = fake_client(activities=[ACTIVITY])
    sync_range(conn, client, "2026-01-05", "2026-01-05")
    sid = conn.execute("SELECT id FROM session").fetchone()["id"]
    q.set_session_rpe(conn, sid, 9.0)

    client2, _ = fake_client(activities=[ACTIVITY])
    sync_range(conn, client2, "2026-01-05", "2026-01-05")
    assert conn.execute("SELECT rpe FROM session").fetchone()["rpe"] == 9.0


def test_a_garmin_lift_merges_into_an_untimed_manual_session(conn, fake_client):
    save_session(conn, parse_entry("2026-01-05 lift\nsquat 100x5\n")[0])
    lift_activity = {**ACTIVITY, "activityType": {"typeKey": "strength_training"}}

    client, _ = fake_client(activities=[lift_activity])
    result = sync_range(conn, client, "2026-01-05", "2026-01-05")

    assert result.sessions_merged == 1
    assert conn.execute("SELECT COUNT(*) FROM session").fetchone()[0] == 1
    row = conn.execute("SELECT * FROM session").fetchone()
    assert row["source"] == "manual"          # the notebook stays authoritative
    assert row["garmin_activity_id"] == "555"
    assert row["duration_min"] == 60.0


def test_every_call_is_logged_even_when_it_fails(conn, fake_client):
    client, api = fake_client(activities=[ACTIVITY])

    def boom(day):
        raise RuntimeError("500 Server Error")

    api.get_hrv_data = boom
    sync_range(conn, client, "2026-01-05", "2026-01-05")

    statuses = {
        r["endpoint"]: r["status"] for r in conn.execute("SELECT * FROM sync_log")
    }
    assert statuses["get_activities_by_date"] == "ok"
    assert statuses["get_hrv_data"] == "error"


def test_a_broken_endpoint_does_not_abort_the_rest_of_the_sync(conn, fake_client):
    client, api = fake_client(activities=[ACTIVITY])
    api.get_stats_and_body = lambda day: (_ for _ in ()).throw(ValueError("nope"))
    result = sync_range(conn, client, "2026-01-05", "2026-01-05")
    assert result.errors                                    # recorded
    assert conn.execute("SELECT COUNT(*) FROM session").fetchone()[0] == 1  # continued


def test_range_longer_than_the_chunk_limit_is_refused(conn, fake_client):
    client, _ = fake_client()
    with pytest.raises(ValueError, match="chunk limit"):
        sync_range(conn, client, "2026-01-01", "2026-03-01")


def test_a_table_rebuild_keeps_the_rows_that_reference_it(tmp_path):
    """Migration 014 rebuilds `session`. With foreign keys enforced, the DROP
    it needs is an implicit DELETE that cascades into lift_set — the lifting
    record would have gone quietly. The runner turns enforcement off for the
    script and checks the result before committing."""
    from ledger.db import queries as q
    from ledger.db import schema

    conn = schema.connect(tmp_path / "t.db")
    # Everything before 014, by hiding 014 and later from the runner.
    orig = schema.pending_migrations
    schema.pending_migrations = lambda c: [p for p in orig(c) if p.name < "014"]
    try:
        schema.migrate(conn)
    finally:
        schema.pending_migrations = orig

    sid = q.insert_session(conn, date="2026-09-16", kind="lift", source="manual",
                           rpe=7, duration_min=45)
    conn.execute(
        "INSERT INTO exercise (id, name, modality, created_at) "
        "VALUES (1, 'Barbell Back Squat', 'barbell', '2026-09-16')")
    conn.execute(
        "INSERT INTO lift_set (session_id, exercise_id, set_index, weight, reps) "
        "VALUES (?, 1, 1, 100, 5)", (sid,))

    applied = schema.migrate(conn)
    assert any(name.startswith("014") for name in applied)
    assert conn.execute("SELECT COUNT(*) FROM lift_set").fetchone()[0] == 1
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    conn.execute("INSERT INTO session (date, kind, source) VALUES ('2026-09-19', 'stairs', 'manual')")


def test_a_migration_that_orphans_rows_is_rolled_back(tmp_path, monkeypatch):
    from ledger.db import schema

    conn = schema.connect(tmp_path / "t.db")
    schema.migrate(conn)
    bad = tmp_path / "999_bad.sql"
    bad.write_text("INSERT INTO lift_set (session_id, exercise_id, set_index, weight, reps) "
                   "VALUES (424242, 424242, 1, 1, 1);", encoding="utf-8")
    monkeypatch.setattr(schema, "pending_migrations", lambda c: [bad])

    import pytest
    with pytest.raises(schema.sqlite3.IntegrityError):
        schema.migrate(conn)
    assert conn.execute("SELECT COUNT(*) FROM lift_set").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM _migration WHERE filename = '999_bad.sql'").fetchone()[0] == 0
    assert not conn.in_transaction


def test_metrics_only_backfill_calls_two_endpoints_and_fills_015_columns(conn, fake_client):
    """Re-reading a year for the recovery columns must not re-pull activities."""
    from ledger.config import Config
    from ledger.garmin.sync import backfill_metrics

    client, api = fake_client(metrics={
        "get_stats_and_body": {"2026-01-05": {
            "averageStressLevel": 31, "totalSteps": 8000,
            "bodyBatteryAtWakeTime": 70, "bodyBatteryHighestValue": 75,
            "bodyBatteryLowestValue": 12, "totalAverage": {"weight": 95000},
        }},
        "get_sleep_data": {"2026-01-05": {"dailySleepDTO": {
            "sleepTimeSeconds": 25200, "deepSleepSeconds": 3600,
            "remSleepSeconds": 4800, "awakeSleepSeconds": 600,
            "sleepScores": {"overall": {"value": 81}},
        }}},
        "get_hrv_data": {"2026-01-05": {"hrvSummary": {"lastNightAvg": 55}}},
    })
    cfg = Config.__new__(Config)
    object.__setattr__(cfg, "sync_chunk_pause_s", 0.0)
    result = backfill_metrics(conn, client, "2026-01-05", "2026-01-05", cfg, sleep=lambda _s: None)

    called = {name for name, _ in api.calls}
    assert called == {"get_stats_and_body", "get_sleep_data", "get_hrv_data"}
    assert result.metric_days == 1
    row = conn.execute("SELECT * FROM metric_daily WHERE date='2026-01-05'").fetchone()
    assert row["stress_avg"] == 31
    assert row["steps"] == 8000
    assert row["body_battery_wake"] == 70
    assert row["body_battery_high"] == 75
    assert row["sleep_hours"] == 7.0
    assert row["sleep_score"] == 81
    assert row["deep_min"] == 60
    assert row["hrv_ms"] == 55.0
    # 016: the personal range travels with the night.
    assert row["hrv_status"] is None  # the fake sends no status
    assert row["sleep_need_min"] is None
