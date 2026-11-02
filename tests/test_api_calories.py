"""The calorie endpoints, over HTTP.

What matters here is that a meal is a number and nothing else gets in, that
the day comes back rebuilt from the server after every write, and that the
on-demand Garmin pull is guarded the way the full sync is. Figures invented.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient

TODAY = date.today().isoformat()
YESTERDAY = (date.today() - timedelta(days=1)).isoformat()
TOMORROW = (date.today() + timedelta(days=1)).isoformat()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DB_PATH", str(tmp_path / "api.db"))
    import ledger.api.main as main
    from ledger.config import load_config

    monkeypatch.setattr(main, "cfg", load_config())
    main._burn_refreshing = False
    main._burn_last_attempt = None
    main._sync_running = False
    with TestClient(main.app) as c:
        yield c


def _seed_burn(client, day=YESTERDAY, bmr=2180, active=600, elapsed=1440):
    import ledger.api.main as main
    from ledger.db import queries as q

    conn = main.connect(main.cfg.db_path)
    q.upsert_metric_daily(conn, day, calories_bmr=bmr, calories_active=active,
                          calories_total=bmr + active, day_elapsed_min=elapsed,
                          calories_fetched_at="2026-01-01T00:00:00+00:00")
    conn.close()


# --- reading --------------------------------------------------------------


def test_the_default_window_is_28_days_ending_today(client):
    body = client.get("/api/calories").json()
    assert len(body["days"]) == 28
    assert body["days"][-1]["date"] == TODAY
    assert body["target"] == 500
    assert body["target_is_default"] is True


def test_a_backwards_window_is_refused(client):
    r = client.get(f"/api/calories?from={TODAY}&to={YESTERDAY}")
    assert r.status_code == 422


# --- meals ----------------------------------------------------------------


def test_adding_a_meal_returns_the_day_rebuilt(client):
    _seed_burn(client)
    r = client.post(f"/api/calories/{YESTERDAY}/meals", json={"kcal": 700, "label": "breakfast"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meal"]["kcal"] == 700
    assert body["meal"]["label"] == "breakfast"
    assert body["day"]["intake"] == 700
    assert body["day"]["deficit"] == 2780 - 700
    r = client.post(f"/api/calories/{YESTERDAY}/meals", json={"kcal": 850})
    assert r.json()["day"]["intake"] == 1550
    assert r.json()["meal"]["label"] == ""


@pytest.mark.parametrize("kcal", [0, 5001, -10, "abc", None, 12.5, True])
def test_a_meal_is_a_whole_number_between_1_and_5000(client, kcal):
    r = client.post(f"/api/calories/{TODAY}/meals", json={"kcal": kcal})
    assert r.status_code == 422
    assert "whole number" in r.json()["detail"]


def test_a_meal_on_a_future_day_is_refused(client):
    r = client.post(f"/api/calories/{TOMORROW}/meals", json={"kcal": 500})
    assert r.status_code == 422
    assert "not happened" in r.json()["detail"]


def test_a_malformed_day_is_named(client):
    r = client.post("/api/calories/2026-13-01/meals", json={"kcal": 500})
    assert r.status_code == 422
    assert "YYYY-MM-DD" in r.json()["detail"]


def test_a_long_label_is_refused(client):
    r = client.post(f"/api/calories/{TODAY}/meals", json={"kcal": 500, "label": "x" * 41})
    assert r.status_code == 422


def test_a_meal_can_be_corrected_moved_and_deleted(client):
    meal = client.post(f"/api/calories/{TODAY}/meals", json={"kcal": 700, "label": "lunch"}).json()["meal"]
    r = client.patch(f"/api/meals/{meal['id']}", json={"kcal": 750, "label": "late lunch"})
    assert r.status_code == 200
    assert r.json()["meal"] == {**meal, "kcal": 750, "label": "late lunch", "updated_at": r.json()["meal"]["updated_at"]}
    assert r.json()["day"]["intake"] == 750

    r = client.patch(f"/api/meals/{meal['id']}", json={"date": YESTERDAY})
    assert r.json()["day"]["date"] == YESTERDAY
    assert r.json()["day"]["intake"] == 750
    assert client.get(f"/api/calories?from={TODAY}&to={TODAY}").json()["days"][0]["intake"] == 0

    r = client.delete(f"/api/meals/{meal['id']}")
    assert r.json()["deleted"] == 1
    assert r.json()["day"]["intake"] == 0
    assert client.delete(f"/api/meals/{meal['id']}").status_code == 404
    assert client.patch(f"/api/meals/{meal['id']}", json={"kcal": 1}).status_code == 404


def test_an_empty_patch_is_refused(client):
    meal = client.post(f"/api/calories/{TODAY}/meals", json={"kcal": 700}).json()["meal"]
    assert client.patch(f"/api/meals/{meal['id']}", json={}).status_code == 422


# --- settings -------------------------------------------------------------


def test_the_target_can_be_set_and_reset(client):
    assert client.get("/api/calories/settings").json()["deficit_target_kcal"] == 500
    r = client.put("/api/calories/settings", json={"deficit_target_kcal": 450})
    assert r.json()["deficit_target_kcal"] == 450
    assert r.json()["is_default"] is False
    assert client.get("/api/calories").json()["target"] == 450
    r = client.put("/api/calories/settings", json={"deficit_target_kcal": None})
    assert r.json()["deficit_target_kcal"] == 500
    assert r.json()["is_default"] is True


@pytest.mark.parametrize("value", [-1, 2001, "lots", 12.5])
def test_a_nonsense_target_is_refused(client, value):
    assert client.put("/api/calories/settings", json={"deficit_target_kcal": value}).status_code == 422


# --- the on-demand pull ---------------------------------------------------


def test_refresh_pulls_today_and_returns_it(client, monkeypatch):
    import ledger.api.main as main
    from ledger.db import queries as q

    pulled = []

    def fake_pull(conn, day):
        pulled.append(day)
        q.upsert_metric_daily(conn, day, calories_bmr=1500, calories_active=400,
                              calories_total=1900, day_elapsed_min=990,
                              calories_fetched_at="2026-01-01T00:00:00+00:00")
        return []

    monkeypatch.setattr(main, "_pull_burn", fake_pull)
    monkeypatch.setattr(main.status, "tokens_present", lambda _d: True)
    r = client.post("/api/calories/refresh")
    assert r.status_code == 200, r.text
    assert pulled == [TODAY]
    assert r.json()["refreshed"] is True
    assert r.json()["day"]["burn"]["so_far"] == 1900
    assert r.json()["day"]["burn"]["estimated"] is True

    # A second tap inside a minute is told to wait, not sent to Garmin.
    r = client.post("/api/calories/refresh")
    assert r.status_code == 429
    assert pulled == [TODAY]


def test_refresh_is_refused_while_a_sync_runs(client, monkeypatch):
    import ledger.api.main as main

    monkeypatch.setattr(main.status, "tokens_present", lambda _d: True)
    main._sync_running = True
    try:
        assert client.post("/api/calories/refresh").status_code == 409
    finally:
        main._sync_running = False


def test_refresh_is_refused_without_tokens(client, monkeypatch):
    import ledger.api.main as main

    monkeypatch.setattr(main.status, "tokens_present", lambda _d: False)
    r = client.post("/api/calories/refresh")
    assert r.status_code == 409
    assert "garmin-login" in r.json()["detail"]


def test_refresh_for_a_future_day_is_refused(client, monkeypatch):
    import ledger.api.main as main

    monkeypatch.setattr(main.status, "tokens_present", lambda _d: True)
    assert client.post("/api/calories/refresh", json={"day": TOMORROW}).status_code == 422


def test_a_pull_that_errors_still_returns_the_day(client, monkeypatch):
    import ledger.api.main as main

    monkeypatch.setattr(main, "_pull_burn", lambda conn, day: ["get_stats_and_body: 500"])
    monkeypatch.setattr(main.status, "tokens_present", lambda _d: True)
    r = client.post("/api/calories/refresh")
    assert r.status_code == 200
    assert r.json()["refreshed"] is False
    assert r.json()["errors"]
    assert r.json()["day"]["date"] == TODAY
