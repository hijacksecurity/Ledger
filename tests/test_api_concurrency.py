"""Concurrency.

This file exists because two separate thread bugs shipped past a green suite:

  1. a single connection shared across FastAPI's threadpool, and
  2. a per-request connection opened on one worker and closed on another,
     because a sync dependency's setup and teardown are separate threadpool
     jobs.

Neither reproduces sequentially. The first was caught by a real browser, the
second by hammering the running container — 191 of 240 requests failed while
the whole test suite was green. So: hit it from many threads at once, or the
next one ships too.
"""

from __future__ import annotations

import concurrent.futures as cf

import pytest

pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient

READ_PATHS = [
    "/api/health",
    "/api/summary",
    "/api/history",
    "/api/soccer",
    "/api/trends?metric=load&grain=week",
    "/api/trends?metric=distance&grain=month",
    "/api/sessions?limit=50",
    "/api/report/weekly",
    "/api/exercises",
]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DB_PATH", str(tmp_path / "conc.db"))
    import ledger.api.main as main
    from ledger.config import load_config

    monkeypatch.setattr(main, "cfg", load_config())
    with TestClient(main.app) as c:
        c.post("/api/sessions", json={"text": (
            "2026-08-03 run 5km 30:00 rpe=5\n"
            "2026-08-05 soccer W3:1 2g0a 60min rpe=9\n"
            "2026-08-06 bike 20km 45:00 rpe=6\n"
        )})
        yield c


def test_concurrent_reads_never_500(client):
    def hit(path: str) -> tuple[str, int]:
        return path, client.get(path).status_code

    with cf.ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(hit, READ_PATHS * 12))

    bad = [(p, code) for p, code in results if code != 200]
    assert not bad, f"{len(bad)} of {len(results)} concurrent reads failed: {bad[:5]}"


def test_concurrent_writes_all_land(client):
    """Every accepted write must be durable, not just non-crashing."""

    def add(i: int) -> int:
        return client.post(
            "/api/sessions",
            json={"date": "2026-09-01", "kind": "run", "rpe": 5, "duration_min": 30 + i},
        ).status_code

    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(add, range(24)))

    assert codes.count(200) == 24, f"writes failed: {sorted(set(codes))}"
    assert client.get("/api/sessions?from=2026-09-01&to=2026-09-01").json()["total"] == 24


def test_reads_and_writes_interleaved(client):
    """A read holding a connection must not break a concurrent write."""

    def job(i: int) -> int:
        if i % 3 == 0:
            return client.post(
                "/api/sessions",
                json={"date": "2026-09-02", "kind": "bike", "rpe": 6, "duration_min": 40},
            ).status_code
        return client.get(READ_PATHS[i % len(READ_PATHS)]).status_code

    with cf.ThreadPoolExecutor(max_workers=12) as pool:
        codes = list(pool.map(job, range(60)))

    assert set(codes) == {200}, f"unexpected statuses: {sorted(set(codes))}"
