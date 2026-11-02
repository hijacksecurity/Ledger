"""The morning pull: last night's numbers, as soon as the watch has them.

The nightly runs at 03:00, before the night it should report has ended. The
morning pull asks every quarter hour whether the night is in — one call —
and once it is, reads everything for today, then stops. These pin the three
states, what each costs in calls, and that a settled morning costs nothing.
All figures invented.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from ledger.db import queries as q
from ledger.garmin import sync

DAY = date(2026, 3, 20)
ISO = DAY.isoformat()
YESTERDAY = "2026-03-19"


def _ms_local(hh: int, mm: int) -> int:
    """Garmin's *Local epoch-ms: wall-clock digits encoded as UTC."""
    return int(datetime(2026, 3, 20, hh, mm, tzinfo=UTC).timestamp() * 1000)


def _night(score=74, wake=(7, 10)):
    return {"dailySleepDTO": {
        "sleepTimeSeconds": 26000, "sleepScores": {"overall": {"value": score}},
        "sleepStartTimestampLocal": _ms_local(0, 5),
        "sleepEndTimestampLocal": _ms_local(*wake),
    }}


def _metrics(sleep=True, readiness=True):
    out = {
        "get_stats_and_body": {
            ISO: {"totalKilocalories": 900, "bmrKilocalories": 800,
                  "activeKilocalories": 100, "durationInMilliseconds": 36_000_000},
            YESTERDAY: {"totalKilocalories": 3000, "bmrKilocalories": 2200,
                        "activeKilocalories": 800, "durationInMilliseconds": 86_400_000},
        },
        "get_hrv_data": {ISO: {"hrvSummary": {"lastNightAvg": 58}}},
        "get_rhr_day": {ISO: {"restingHeartRate": 52}},
    }
    if sleep:
        out["get_sleep_data"] = {ISO: _night()}
    if readiness:
        out["get_training_readiness"] = {ISO: {"score": 66}}
    return out


def _row(**kw):
    base = {"sleep_score": None, "readiness": None, "sleep_end_local": None}
    base.update(kw)
    return base


# --- the state, as a pure rule -----------------------------------------------


def test_no_sleep_score_is_waiting():
    assert sync.morning_state(None, None) == "waiting"
    assert sync.morning_state(_row(readiness=60), datetime(2026, 3, 20, 9)) == "waiting"


def test_the_night_in_but_readiness_read_too_soon_is_settling():
    row = _row(sleep_score=74, readiness=40, sleep_end_local="2026-03-20T07:10")
    assert sync.morning_state(row, None) == "settling"
    assert sync.morning_state(row, datetime(2026, 3, 20, 7, 25)) == "settling"


def test_readiness_read_half_an_hour_after_waking_is_settled():
    row = _row(sleep_score=74, readiness=66, sleep_end_local="2026-03-20T07:10")
    assert sync.morning_state(row, datetime(2026, 3, 20, 7, 40)) == "settled"


def test_a_night_without_readiness_stops_asking_after_ninety_minutes():
    row = _row(sleep_score=74, sleep_end_local="2026-03-20T07:10")
    assert sync.morning_state(row, datetime(2026, 3, 20, 8, 30)) == "settling"
    assert sync.morning_state(row, datetime(2026, 3, 20, 8, 40)) == "settled"


def test_a_utc_stamp_is_compared_as_local_time():
    """sync_log stores UTC; the wake time is local wall-clock digits."""
    utc = datetime(2026, 3, 20, 12, 0, tzinfo=UTC)
    assert sync._local_naive(utc.isoformat()) == utc.astimezone().replace(tzinfo=None)
    assert sync._local_naive("2026-03-20T07:10") == datetime(2026, 3, 20, 7, 10)
    assert sync._local_naive(None) is None


# --- the pull ----------------------------------------------------------------


def test_before_the_upload_one_call_and_nothing_else(conn, fake_client):
    client, api = fake_client(metrics=_metrics(sleep=False))
    state, result = sync.sync_morning(conn, client, today=DAY)
    assert state == "waiting"
    assert [name for name, _ in api.calls] == ["get_sleep_data"]
    assert result.api_calls == 1


def test_once_the_night_is_in_everything_for_today_and_yesterdays_burn(conn, fake_client):
    client, api = fake_client(metrics=_metrics())
    state, _ = sync.sync_morning(conn, client, today=DAY)
    called = [(name, args[0]) for name, args in api.calls]
    assert called[0] == ("get_sleep_data", ISO)
    assert {n for n, d in called if d == ISO} == set(sync.METRIC_ENDPOINTS)
    assert ("get_sleep_data", ISO) not in called[1:]  # read once, not twice
    assert [n for n, d in called if d == YESTERDAY] == ["get_stats_and_body"]
    row = q.metric_day(conn, ISO)
    got = (row["sleep_score"], row["readiness"], row["hrv_ms"], row["resting_hr"])
    assert got == (74, 66, 58, 52)
    assert row["sleep_end_local"] == "2026-03-20T07:10"
    assert q.metric_day(conn, YESTERDAY)["day_elapsed_min"] == 1440
    # The fake's calls happen now, months after the wake time: settled at once.
    assert state == "settled"


def test_a_settled_morning_costs_no_calls(conn, fake_client):
    client, _ = fake_client(metrics=_metrics())
    sync.sync_morning(conn, client, today=DAY)
    client2, api2 = fake_client(metrics=_metrics())
    state, result = sync.sync_morning(conn, client2, today=DAY)
    assert state == "settled"
    assert api2.calls == []
    assert result.api_calls == 0


def test_settling_rereads_everything_including_sleep(conn, fake_client):
    """Readiness read too soon after waking: the next pass reads it all again,
    sleep included, since Garmin may still be revising the night."""
    q.upsert_metric_daily(conn, ISO, sleep_score=70, readiness=30,
                          sleep_end_local="2026-03-20T07:10")
    conn.execute(
        "INSERT INTO sync_log (ran_at, endpoint, status, date_range) VALUES (?, ?, 'ok', ?)",
        (datetime(2026, 3, 20, 7, 12).astimezone(UTC).isoformat(), "get_training_readiness", ISO),
    )
    assert sync.morning_state_for(conn, ISO) == "settling"
    client, api = fake_client(metrics=_metrics())
    sync.sync_morning(conn, client, today=DAY)
    assert {n for n, d in api.calls if d[0] == ISO} == set(sync.METRIC_ENDPOINTS)
    assert q.metric_day(conn, ISO)["readiness"] == 66
