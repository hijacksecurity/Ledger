"""Manual entry, editing, and the flexible read views.

Garmin sync is not connected, so these endpoints are the only way data gets
in. They get exercised through a real client for the same reason as
test_api.py: the threadpool is where a working-looking API breaks.
"""

from __future__ import annotations

from datetime import date

import pytest

pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DB_PATH", str(tmp_path / "entry.db"))
    import ledger.api.main as main
    from ledger.config import load_config

    monkeypatch.setattr(main, "cfg", load_config())
    with TestClient(main.app) as c:
        yield c


# --- parse preview --------------------------------------------------------


def test_parse_preview_writes_nothing(client):
    text = '2026-08-05 soccer W7:4 3g0a 60min rpe=9 "mon game"'
    r = client.post("/api/parse", json={"text": text})
    assert r.status_code == 200

    body = r.json()
    assert body["error"] is None
    (s,) = body["sessions"]
    assert s["kind"] == "soccer"
    assert s["detail"] == {"result": "W", "gf": 7, "ga": 4, "goals": 3, "assists": 0}
    assert s["duration_min"] == 60
    assert s["load"] == 540

    assert client.get("/api/sessions").json()["total"] == 0


def test_parse_preview_computes_pace(client):
    r = client.post("/api/parse", json={"text": "2026-07-29 run 5.43km 39:10 rpe=6"})
    (s,) = r.json()["sessions"]
    assert s["distance_km"] == 5.43
    assert round(s["pace_s_per_km"]) == 433      # 7:13/km, as written in the notebook


def test_parse_preview_reports_errors_without_raising(client):
    r = client.post("/api/parse", json={"text": "2026-08-05 soccer rpe=99"})
    assert r.status_code == 200
    assert "rpe" in r.json()["error"]
    assert r.json()["sessions"] == []


def test_parse_preview_of_nothing(client):
    assert client.post("/api/parse", json={"text": ""}).json()["sessions"] == []


# --- create ---------------------------------------------------------------


def test_create_from_the_structured_form(client):
    r = client.post(
        "/api/sessions",
        json={
            "date": "2026-08-05", "kind": "soccer", "rpe": 9, "duration_min": 60,
            "detail": {"result": "W", "gf": 8, "ga": 4, "goals": 2, "assists": 0},
            "notes": "league",
        },
    )
    assert r.status_code == 200, r.text
    s = r.json()["session"]
    assert s["kind"] == "soccer"
    assert s["load"] == 540
    assert s["detail"]["result"] == "W"


def test_create_from_shorthand_text(client):
    r = client.post("/api/sessions", json={"text": "2026-07-29 run 5.43km 39:10 rpe=6"})
    assert r.status_code == 200, r.text
    assert r.json()["session"]["distance_km"] == 5.43


def test_create_many_from_one_paste(client):
    text = (
        "week 2026-08-03 213lb 4.27 #86\n"
        "2026-08-05 soccer W8:4 2g0a 60min rpe=9\n"
        "2026-08-08 run 6.02km 46:52 rpe=5\n"
    )
    r = client.post("/api/sessions", json={"text": text})
    assert len(r.json()["session_ids"]) == 2
    # The week header also lands, so bodyweight has a source.
    assert client.get("/api/summary?week_of=2026-08-08").json()["bodyweight"]["ema_kg"]


@pytest.mark.parametrize(
    "payload",
    [
        {"kind": "run", "rpe": 5},                             # no date
        {"date": "not-a-date", "kind": "run"},                 # bad date
        {"date": "2026-08-05", "kind": "quidditch"},           # unknown kind
        {"date": "2026-08-05", "kind": "run", "rpe": 42},      # rpe out of range
        {"text": "this is not a session"},                     # unparseable
        {"text": ""},                                          # nothing at all
    ],
)
def test_bad_creates_are_422(client, payload):
    assert client.post("/api/sessions", json=payload).status_code == 422


# --- edit and delete ------------------------------------------------------


def make(client, **over):
    body = {"date": "2026-08-05", "kind": "run", "rpe": 5, "duration_min": 30, **over}
    return client.post("/api/sessions", json=body).json()["session_id"]


def test_patch_updates_and_returns_the_session(client):
    sid = make(client)
    r = client.patch(f"/api/sessions/{sid}", json={"rpe": 8, "notes": "harder than it felt"})
    assert r.status_code == 200
    s = r.json()["session"]
    assert s["rpe"] == 8
    assert s["load"] == 240          # recomputed, not stale
    assert s["notes"] == "harder than it felt"


def test_patch_rescores_so_stale_prs_cannot_survive_an_edit(client):
    text = "2026-08-05 lift\nsquat 100x5\n"
    sid = client.post("/api/sessions", json={"text": text}).json()["session_id"]
    assert client.get("/api/summary?week_of=2026-08-05").json()["prs"]

    # Move the session to another week; its PRs must move with it.
    client.patch(f"/api/sessions/{sid}", json={"date": "2026-07-01"})
    assert client.get("/api/summary?week_of=2026-08-05").json()["prs"] == []
    assert client.get("/api/summary?week_of=2026-07-01").json()["prs"]


def test_patch_validates(client):
    sid = make(client)
    assert client.patch(f"/api/sessions/{sid}", json={"rpe": 99}).status_code == 422
    assert client.patch(f"/api/sessions/{sid}", json={"kind": "nope"}).status_code == 422
    assert client.patch("/api/sessions/9999", json={"rpe": 5}).status_code == 404


def test_delete(client):
    sid = make(client)
    assert client.delete(f"/api/sessions/{sid}").status_code == 200
    assert client.get("/api/sessions").json()["total"] == 0
    assert client.delete(f"/api/sessions/{sid}").status_code == 404


# --- session log ----------------------------------------------------------


def test_session_log_filters_and_pages(client):
    client.post("/api/sessions", json={"text": (
        "2026-08-03 run 5km 30:00 rpe=5\n"
        "2026-08-05 soccer W3:1 60min rpe=9 \"league night\"\n"
        "2026-08-06 bike 20km 45:00 rpe=6\n"
    )})

    assert client.get("/api/sessions").json()["total"] == 3
    assert client.get("/api/sessions?kind=soccer").json()["total"] == 1
    assert client.get("/api/sessions?from=2026-08-05").json()["total"] == 2
    assert client.get("/api/sessions?to=2026-08-04").json()["total"] == 1
    assert client.get("/api/sessions?q=league").json()["total"] == 1

    page = client.get("/api/sessions?limit=2").json()
    assert len(page["items"]) == 2 and page["total"] == 3
    assert page["items"][0]["date"] == "2026-08-06"   # newest first


# --- trends ---------------------------------------------------------------


def test_trends_zero_fill_empty_periods(client):
    client.post("/api/sessions", json={"text": (
        "2026-06-01 run 10km 60:00 rpe=5\n"
        "2026-08-03 run 5km 30:00 rpe=5\n"
    )})
    t = client.get("/api/trends?metric=distance&grain=week").json()
    assert t["unit"] == "km"
    values = [p["value"] for p in t["points"]]
    assert values[0] == 10 and 0 in values      # the quiet weeks are real zeros


def test_trends_by_metric_and_grain(client):
    client.post("/api/sessions", json={"text": "2026-08-03 run 5km 30:00 rpe=6"})

    # Anchored with `to`, so the assertions do not depend on today's date —
    # an unanchored window ends "now" and its last bucket empties overnight.
    monthly = client.get("/api/trends?metric=load&grain=month&to=2026-08-31").json()
    assert monthly["points"][-1]["period"] == "2026-08"
    assert monthly["points"][-1]["by_kind"] == {"run": 180.0}

    weekly = client.get("/api/trends?metric=count&grain=week&to=2026-08-09").json()
    assert weekly["points"][-1]["value"] == 1
    assert client.get("/api/trends?metric=duration&grain=week").json()["unit"] == "min"


def test_trends_rejects_unknown_metric_or_grain(client):
    assert client.get("/api/trends?metric=vibes").status_code == 422
    assert client.get("/api/trends?grain=fortnight").status_code == 422


def test_trends_on_an_empty_database(client):
    assert client.get("/api/trends").json()["points"] == []


# --- soccer ---------------------------------------------------------------


def test_soccer_record_and_goal_involvement(client):
    client.post("/api/sessions", json={"text": (
        "2026-08-03 soccer W7:4 3g0a 60min rpe=9\n"
        "2026-08-05 soccer L2:5 0g1a 60min rpe=9\n"
        "2026-08-06 soccer D4:4 1g1a 90min rpe=8 \"pickup\"\n"
    )})
    s = client.get("/api/soccer").json()

    assert s["record"] == {"w": 1, "l": 1, "d": 1}
    assert s["games_played"] == 3
    assert (s["goals"], s["assists"], s["goal_involvements"]) == (4, 2, 6)
    assert (s["goals_for"], s["goals_against"]) == (13, 13)
    assert s["win_rate"] == pytest.approx(1 / 3, abs=1e-3)
    assert s["games"][-1]["pickup"] is True


def test_soccer_on_an_empty_database_reports_zero_not_null_shapes(client):
    s = client.get("/api/soccer").json()
    assert s["record"] == {"w": 0, "l": 0, "d": 0}
    assert s["games"] == []
    assert s["win_rate"] is None      # undefined, not 0% — nothing was played


# --- week headers ---------------------------------------------------------


def test_week_notes_round_trip(client):
    """They used to be write-only, which forced the UI to mirror them locally."""
    r = client.put(
        "/api/weeks/2026-08-03",
        json={"notes": "game improving with load management", "bodyweight_lbs": 213,
              "week_number": 86, "avg_activities_per_week": 4.27},
    )
    assert r.status_code == 200

    w = client.get("/api/weeks/2026-08-03").json()
    assert w["notes"] == "game improving with load management"
    assert w["bodyweight_lbs"] == 213
    assert w["week_number"] == 86

    # And it reaches the week view without a second request.
    assert client.get("/api/summary?week_of=2026-08-05").json()["week_note"]["notes"] == w["notes"]
    assert [x["start_date"] for x in client.get("/api/weeks").json()["weeks"]] == ["2026-08-03"]


def test_week_put_leaves_absent_fields_alone(client):
    client.put("/api/weeks/2026-08-03", json={"notes": "first", "bodyweight_lbs": 213})
    client.put("/api/weeks/2026-08-03", json={"week_number": 86})
    w = client.get("/api/weeks/2026-08-03").json()
    assert w["notes"] == "first" and w["bodyweight_lbs"] == 213 and w["week_number"] == 86


def test_missing_week_and_bad_date(client):
    assert client.get("/api/weeks/2026-01-05").status_code == 404
    assert client.put("/api/weeks/nope", json={"notes": "x"}).status_code == 422


def test_get_one_session_by_id(client):
    sid = make(client)
    assert client.get(f"/api/sessions/{sid}").json()["id"] == sid
    assert client.get("/api/sessions/99999").status_code == 404


def test_acwr_publishes_its_inputs(client):
    """The ratio won't match the watch; showing the arithmetic is the answer."""
    load = client.get("/api/summary").json()["load"]
    assert "acute_au" in load and "chronic_au" in load


def test_fixture_token_saves_in_one_write(client):
    """Was POST-then-PATCH; a failed second call silently lost the fixture."""
    r = client.post(
        "/api/sessions",
        json={"text": '2026-08-06 soccer +pickup W18:13 8g2a 90min rpe=8'},
    )
    assert r.status_code == 200, r.text
    assert r.json()["session"]["detail"]["team"] == "pickup"

    game = client.get("/api/soccer").json()["games"][0]
    assert game["team"] == "pickup"
    assert game["pickup"] is True


def test_fixture_falls_back_to_the_note_for_older_entries(client):
    """84 weeks were logged before the field existed; they must still classify."""
    client.post("/api/sessions", json={"text": '2026-08-06 soccer W3:1 90min rpe=8 "pickup"'})
    game = client.get("/api/soccer").json()["games"][0]
    assert game["team"] is None and game["pickup"] is True


def test_a_one_sided_range_still_states_its_span(client):
    """`?from=` with no `to` printed "no data yet" above a full page of rows."""
    client.post("/api/sessions", json={"text": (
        "2026-06-01 run 5km 30:00 rpe=5\n"
        "2026-07-15 run 6km 35:00 rpe=5\n"
        "2026-08-03 run 7km 40:00 rpe=5\n"
    )})

    open_ended = client.get("/api/sessions?from=2026-07-01").json()
    assert open_ended["total"] == 2
    tf = open_ended["timeframe"]
    assert tf["from"] == "2026-07-01"
    # The open end is *today*, not the last matching row. "Everything from
    # July" is a window that runs to now; where the data happens to stop is a
    # fact about the data. Reporting the latter made this panel disagree with
    # every other one about what "now" meant — see test_timeframe_alignment.
    assert tf["to"] == date.today().isoformat()
    assert "no data yet" not in tf["label"]

    # And the other way round. An open *start* has no equivalent answer, so
    # there the earliest matching row is still the best bound available.
    to_only = client.get("/api/sessions?to=2026-07-01").json()["timeframe"]
    assert to_only["to"] == "2026-07-01"
    assert to_only["from"] == "2026-06-01"
    assert "no data yet" not in to_only["label"]


def test_a_count_window_describes_its_rows_not_the_calendar(client):
    """The deliberate exception: "most recent N sessions" is bounded by the
    rows, so it says where they actually stop."""
    client.post("/api/sessions", json={"text": "2026-06-01 run 5km 30:00 rpe=5\n"})

    tf = client.get("/api/sessions").json()["timeframe"]
    assert tf["to"] == "2026-06-01"
    assert tf["label"].startswith("most recent 1 session")
