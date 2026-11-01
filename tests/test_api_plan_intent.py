"""The rest of the plan, over HTTP.

The committed distance ramp has always lived on the server. The planned
counts per kind, the day split and the goal weight did not — they sat in one
browser's localStorage, so a plan written on one device was missing on the
next. These endpoints are that half of the page; the tests prove a write
reads back the same from anywhere, and that the shapes the page relies on are
refused rather than quietly reshaped.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DB_PATH", str(tmp_path / "api.db"))
    import ledger.api.main as main
    from ledger.config import load_config

    monkeypatch.setattr(main, "cfg", load_config())
    with TestClient(main.app) as c:
        yield c


MONDAY = "2026-09-07"
NEXT = "2026-09-14"


# --- intent -----------------------------------------------------------------


def test_intent_round_trips(client):
    r = client.put(f"/api/plan/intent/{MONDAY}",
                   json={"kinds": {"run": 3, "soccer": 2}, "note": " two games "})
    assert r.status_code == 200
    assert r.json()["plan"]["kinds"] == {"run": 3, "soccer": 2}
    assert r.json()["plan"]["note"] == "two games"

    got = client.get("/api/plan/intent").json()["plans"]
    assert [p["week_start"] for p in got] == [MONDAY]
    assert got[0]["kinds"] == {"run": 3, "soccer": 2}
    assert got[0]["note"] == "two games"


def test_intent_rewrite_replaces_rather_than_piles_up(client):
    client.put(f"/api/plan/intent/{MONDAY}", json={"kinds": {"run": 3}})
    client.put(f"/api/plan/intent/{MONDAY}", json={"kinds": {"lift": 2}})
    got = client.get("/api/plan/intent").json()["plans"]
    assert len(got) == 1
    assert got[0]["kinds"] == {"lift": 2}


def test_intent_zero_counts_are_dropped_and_an_empty_plan_is_deleted(client):
    client.put(f"/api/plan/intent/{MONDAY}", json={"kinds": {"run": 3, "bike": 0}})
    assert client.get("/api/plan/intent").json()["plans"][0]["kinds"] == {"run": 3}

    r = client.put(f"/api/plan/intent/{MONDAY}", json={"kinds": {"run": 0}, "note": "  "})
    assert r.status_code == 200
    assert r.json()["plan"] is None
    assert client.get("/api/plan/intent").json()["plans"] == []


def test_intent_window(client):
    client.put(f"/api/plan/intent/{MONDAY}", json={"kinds": {"run": 1}})
    client.put(f"/api/plan/intent/{NEXT}", json={"kinds": {"run": 2}})
    got = client.get("/api/plan/intent", params={"from": NEXT}).json()["plans"]
    assert [p["week_start"] for p in got] == [NEXT]
    got = client.get("/api/plan/intent", params={"to": MONDAY}).json()["plans"]
    assert [p["week_start"] for p in got] == [MONDAY]
    assert client.get("/api/plan/intent", params={"from": NEXT, "to": MONDAY}).status_code == 422


def test_intent_delete(client):
    client.put(f"/api/plan/intent/{MONDAY}", json={"kinds": {"run": 1}})
    r = client.delete(f"/api/plan/intent/{MONDAY}")
    assert r.status_code == 200 and r.json()["deleted"] == 1
    assert client.get("/api/plan/intent").json()["plans"] == []
    assert client.delete(f"/api/plan/intent/{MONDAY}").json()["deleted"] == 0


@pytest.mark.parametrize(
    ("week", "body", "needle"),
    [
        ("2026-09-08", {"kinds": {"run": 1}}, "Monday"),
        ("next monday", {"kinds": {"run": 1}}, "YYYY-MM-DD"),
        (MONDAY, {"kinds": {"swim": 1}}, "unknown kind"),
        (MONDAY, {"kinds": {"run": "three"}}, "whole number"),
        (MONDAY, {"kinds": {"run": 22}}, "0-21"),
        (MONDAY, {"kinds": {"run": -1}}, "0-21"),
        (MONDAY, {"kinds": [1, 2]}, "object"),
        (MONDAY, {"kinds": {"run": 1}, "note": "x" * 501}, "500"),
    ],
)
def test_intent_refuses_bad_shapes(client, week, body, needle):
    r = client.put(f"/api/plan/intent/{week}", json=body)
    assert r.status_code == 422
    assert needle in r.json()["detail"]
    assert client.get("/api/plan/intent").json()["plans"] == []


# --- days -------------------------------------------------------------------


def test_days_round_trip(client):
    body = {"km": {"2026-09-08": 5.0, "2026-09-10": 7.25}, "match": ["2026-09-10", "2026-09-09"]}
    r = client.put(f"/api/plan/days/{MONDAY}", json=body)
    assert r.status_code == 200
    week = r.json()["week"]
    assert week["km"] == {"2026-09-08": 5.0, "2026-09-10": 7.25}
    assert week["match"] == ["2026-09-09", "2026-09-10"]
    assert client.get("/api/plan/days").json()["weeks"][0] == week


def test_days_outside_the_week_are_refused(client):
    r = client.put(f"/api/plan/days/{MONDAY}", json={"km": {"2026-09-14": 5.0}})
    assert r.status_code == 422 and "not in the week" in r.json()["detail"]
    r = client.put(f"/api/plan/days/{MONDAY}", json={"match": ["2026-09-06"]})
    assert r.status_code == 422 and "not in the week" in r.json()["detail"]
    assert client.get("/api/plan/days").json()["weeks"] == []


def test_days_null_km_drops_the_day_and_an_empty_split_deletes(client):
    client.put(f"/api/plan/days/{MONDAY}", json={"km": {"2026-09-08": 5.0, "2026-09-09": 4.0}})
    r = client.put(f"/api/plan/days/{MONDAY}", json={"km": {"2026-09-08": None, "2026-09-09": 4.0}})
    assert r.json()["week"]["km"] == {"2026-09-09": 4.0}
    r = client.put(f"/api/plan/days/{MONDAY}", json={"km": {}, "match": []})
    assert r.json()["week"] is None
    assert client.get("/api/plan/days").json()["weeks"] == []


def test_days_delete(client):
    client.put(f"/api/plan/days/{MONDAY}", json={"match": ["2026-09-09"]})
    assert client.delete(f"/api/plan/days/{MONDAY}").json()["deleted"] == 1
    assert client.get("/api/plan/days").json()["weeks"] == []


# --- goal -------------------------------------------------------------------


def test_goal_is_null_until_set_then_round_trips(client):
    assert client.get("/api/plan/goal").json() == {"goal_weight_lb": None, "updated_at": None}
    r = client.put("/api/plan/goal", json={"lb": 180})
    assert r.status_code == 200 and r.json()["goal_weight_lb"] == 180.0
    assert client.get("/api/plan/goal").json()["goal_weight_lb"] == 180.0
    assert client.get("/api/plan/goal").json()["updated_at"]


def test_goal_can_be_cleared(client):
    client.put("/api/plan/goal", json={"lb": 180})
    assert client.put("/api/plan/goal", json={"lb": None}).json()["goal_weight_lb"] is None
    client.put("/api/plan/goal", json={"lb": 180})
    assert client.delete("/api/plan/goal").json()["goal_weight_lb"] is None
    assert client.get("/api/plan/goal").json()["goal_weight_lb"] is None


@pytest.mark.parametrize("body", [{}, {"lb": "heavy"}, {"lb": 20}, {"lb": 900}])
def test_goal_refuses_nonsense(client, body):
    assert client.put("/api/plan/goal", json=body).status_code == 422
    assert client.get("/api/plan/goal").json()["goal_weight_lb"] is None


def test_the_three_stores_survive_a_second_connection(client, tmp_path):
    """The point of the feature: another device sees the same plan."""
    client.put(f"/api/plan/intent/{MONDAY}", json={"kinds": {"run": 3}})
    client.put(f"/api/plan/days/{MONDAY}", json={"km": {"2026-09-08": 5.0}})
    client.put("/api/plan/goal", json={"lb": 175})

    from ledger.db.schema import open_db

    conn = open_db(tmp_path / "api.db")
    try:
        assert conn.execute("SELECT count(*) FROM plan_intent").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM plan_days").fetchone()[0] == 1
        row = conn.execute("SELECT value FROM setting WHERE key='goal_weight_lb'").fetchone()
        assert row[0] == "175.0"
    finally:
        conn.close()


def test_a_real_monday_is_a_monday():
    assert date.fromisoformat(MONDAY).weekday() == 0
    assert date.fromisoformat(NEXT) - date.fromisoformat(MONDAY) == timedelta(days=7)
