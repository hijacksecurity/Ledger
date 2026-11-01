"""The habit endpoints, over HTTP.

The interesting part is not the happy path — it is that a measured habit and a
tapped one take different bodies, and sending the wrong one has to fail loudly.
A tap on `sleep` that returned 200 and changed nothing would be a control that
lies, which is the failure mode this app keeps writing rules against.
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


def _monday() -> date:
    today = date.today()
    return today - timedelta(days=today.weekday())


def _of(payload, key):
    return next(h for h in payload["habits"] if h["key"] == key)


# --- reading --------------------------------------------------------------


def test_default_window_is_the_week_containing_today(client):
    payload = client.get("/api/habits").json()
    assert payload["timeframe"]["from"] == _monday().isoformat()
    assert payload["timeframe"]["to"] == (_monday() + timedelta(days=6)).isoformat()
    assert payload["today"] == date.today().isoformat()
    assert [h["key"] for h in payload["habits"]] == ["stretch", "sleep", "no_takeout"]


def test_a_backwards_window_is_refused(client):
    r = client.get("/api/habits", params={"from": "2026-09-10", "to": "2026-09-01"})
    assert r.status_code == 422


def test_a_malformed_date_is_named(client):
    r = client.get("/api/habits", params={"from": "last tuesday"})
    assert r.status_code == 422
    assert "YYYY-MM-DD" in r.json()["detail"]


# --- marking --------------------------------------------------------------


def test_tapping_a_manual_habit_marks_the_day(client):
    day = _monday().isoformat()
    r = client.put(f"/api/habits/stretch/{day}", json={"done": True})
    assert r.status_code == 200
    assert _of(r.json(), "stretch")["days"][day]["state"] == "met"


def test_untapping_clears_it(client):
    """The mark goes, and the day falls back to whatever it was without one.

    Which of `missed`, `open` or `untracked` that is depends on where the day
    sits against today and against the day the habit was created — a habit
    seeded by the migration starts tracking now, so this week's Monday is
    before it. The assertion is about the mark being gone, not about which of
    the three unmarked states it lands in.
    """
    day = _monday().isoformat()
    client.put(f"/api/habits/stretch/{day}", json={"done": True})
    assert _of(client.get("/api/habits").json(), "stretch")["days"][day]["state"] == "met"

    r = client.put(f"/api/habits/stretch/{day}", json={"done": False})
    assert _of(r.json(), "stretch")["days"][day]["state"] != "met"


def test_a_day_before_the_habit_existed_is_untracked(client):
    """Over HTTP: the seeded habits start today, so last month was not kept."""
    old_day = (_monday() - timedelta(days=40)).isoformat()
    payload = client.get("/api/habits", params={"from": old_day, "to": old_day}).json()
    for h in payload["habits"]:
        assert h["days"][old_day]["state"] == "untracked"
        assert h["totals"]["scored"] == 0


def test_the_trend_endpoint_returns_one_entry_per_week(client):
    out = client.get("/api/habits/trend", params={"weeks": 6}).json()
    assert len(out["weeks"]) == 6
    assert out["weeks"][-1]["week_start"] == _monday().isoformat()
    # "trend" must not be swallowed as a habit key by the mark route.
    assert "detail" not in out


def test_the_trend_clamps_its_window(client):
    assert len(client.get("/api/habits/trend", params={"weeks": 1}).json()["weeks"]) == 4
    assert len(client.get("/api/habits/trend", params={"weeks": 500}).json()["weeks"]) == 52


def test_the_response_rebuilds_the_window_the_caller_is_showing(client):
    """So the page repaints from the server rather than guessing what it did."""
    monday = _monday()
    sunday = monday + timedelta(days=6)
    r = client.put(
        f"/api/habits/stretch/{monday.isoformat()}",
        params={"from": monday.isoformat(), "to": sunday.isoformat()},
        json={"done": True},
    )
    assert len(_of(r.json(), "stretch")["days"]) == 7


def test_a_measured_habit_refuses_a_tap_by_name(client):
    day = _monday().isoformat()
    r = client.put(f"/api/habits/sleep/{day}", json={"done": True})
    assert r.status_code == 422
    assert "measured" in r.json()["detail"]


def test_a_measured_habit_takes_a_value(client):
    day = _monday().isoformat()
    r = client.put(f"/api/habits/sleep/{day}", json={"value": 8.5})
    assert r.status_code == 200
    assert _of(r.json(), "sleep")["days"][day]["value"] == 8.5
    assert _of(r.json(), "sleep")["days"][day]["source"] == "manual"


def test_a_null_value_clears_the_override(client):
    day = _monday().isoformat()
    client.put(f"/api/habits/sleep/{day}", json={"value": 8.5})
    r = client.put(f"/api/habits/sleep/{day}", json={"value": None})
    assert _of(r.json(), "sleep")["days"][day]["value"] is None


def test_nonsense_values_are_refused(client):
    day = _monday().isoformat()
    assert client.put(f"/api/habits/sleep/{day}", json={"value": "eight"}).status_code == 422
    assert client.put(f"/api/habits/sleep/{day}", json={"value": -1}).status_code == 422
    assert client.put(f"/api/habits/sleep/{day}", json={}).status_code == 422


def test_an_unknown_habit_is_404(client):
    r = client.put(f"/api/habits/meditate/{_monday().isoformat()}", json={"done": True})
    assert r.status_code == 404


# --- managing the list ----------------------------------------------------


def test_a_habit_can_be_added_and_gets_a_key_from_its_name(client):
    r = client.post("/api/habits", json={"name": "Ten minutes of mobility"})
    assert r.status_code == 200
    assert r.json()["key"] == "ten_minutes_of_mobility"
    assert "ten_minutes_of_mobility" in [h["key"] for h in client.get("/api/habits").json()["habits"]]


def test_a_duplicate_key_is_refused(client):
    assert client.post("/api/habits", json={"name": "Stretch 30 min", "key": "stretch"}).status_code == 409


def test_a_blank_name_is_refused(client):
    assert client.post("/api/habits", json={"name": "   "}).status_code == 422


def test_archiving_takes_it_off_the_page_without_deleting_it(client):
    day = _monday().isoformat()
    client.put(f"/api/habits/stretch/{day}", json={"done": True})
    assert client.patch("/api/habits/stretch", json={"archived": True}).status_code == 200

    assert "stretch" not in [h["key"] for h in client.get("/api/habits").json()["habits"]]
    kept = client.get("/api/habits", params={"include_archived": True}).json()
    assert _of(kept, "stretch")["days"][day]["state"] == "met"


def test_an_archived_habit_cannot_be_marked(client):
    client.patch("/api/habits/stretch", json={"archived": True})
    r = client.put(f"/api/habits/stretch/{_monday().isoformat()}", json={"done": True})
    assert r.status_code == 409


def test_unarchiving_brings_it_back(client):
    client.patch("/api/habits/stretch", json={"archived": True})
    client.patch("/api/habits/stretch", json={"archived": False})
    assert "stretch" in [h["key"] for h in client.get("/api/habits").json()["habits"]]


def test_the_sleep_target_can_be_moved(client):
    r = client.patch("/api/habits/sleep", json={"target": 7.5, "partial_at": 6.5})
    assert r.status_code == 200
    assert _of(client.get("/api/habits").json(), "sleep")["target"] == 7.5


def test_a_floor_above_the_target_is_refused(client):
    assert client.patch("/api/habits/sleep", json={"partial_at": 9.0}).status_code == 422


def test_a_tapped_habit_has_no_target_to_set(client):
    r = client.patch("/api/habits/stretch", json={"target": 30})
    assert r.status_code == 422
    assert "not measured" in r.json()["detail"]
