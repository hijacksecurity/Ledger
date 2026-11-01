from __future__ import annotations

import sqlite3
from collections.abc import Iterator

import pytest

from ledger.db.schema import connect, migrate


@pytest.fixture
def conn(tmp_path) -> Iterator[sqlite3.Connection]:
    connection = connect(tmp_path / "test.db")
    migrate(connection)
    yield connection
    connection.close()


class FakeGarmin:
    """Stand-in for the `garminconnect` client.

    Records every call so tests can assert on pacing and idempotency without
    touching the network.
    """

    def __init__(self, activities=None, exercise_sets=None, metrics=None):
        self._activities = activities or []
        self._exercise_sets = exercise_sets or {}
        self._metrics = metrics or {}
        self.calls: list[tuple[str, tuple]] = []

    def get_activities_by_date(self, start, end):
        self.calls.append(("get_activities_by_date", (start, end)))
        return [
            a
            for a in self._activities
            if start <= str(a.get("startTimeLocal", ""))[:10] <= end
        ]

    def get_activity_exercise_sets(self, activity_id):
        self.calls.append(("get_activity_exercise_sets", (activity_id,)))
        return self._exercise_sets.get(str(activity_id), {})

    def _metric(self, name, day):
        self.calls.append((name, (day,)))
        return self._metrics.get(name, {}).get(day)

    def get_stats_and_body(self, day):
        return self._metric("get_stats_and_body", day)

    def get_training_readiness(self, day):
        return self._metric("get_training_readiness", day)

    def get_hrv_data(self, day):
        return self._metric("get_hrv_data", day)

    def get_rhr_day(self, day):
        return self._metric("get_rhr_day", day)

    def get_sleep_data(self, day):
        return self._metric("get_sleep_data", day)


@pytest.fixture
def fake_client():
    """A GarminClient wired to FakeGarmin with sleeping disabled."""
    from ledger.garmin.client import GarminClient

    def _make(**kwargs) -> tuple[GarminClient, FakeGarmin]:
        api = FakeGarmin(**kwargs)
        client = GarminClient(token_dir="unused", call_delay_s=0, sleep=lambda _s: None)
        client._api = api
        return client, api

    return _make
