"""One per-match rate, with its denominator named.

The Sports page showed "Your G+A per match 2.78" a few centimetres from a panel
headed "Involvement per match" reading 3.60, and a By-fixture column headed
"G+A / match" giving a third set of numbers. Three denominators were in play at
once:

    58  matches logged
    54  matches with a result          (the server's goals_per_game used this)
    45  matches with goals or assists  (the browser's perMatch() used this)

and the 3.60 was not a lifetime rate at all — it was the last point of a rolling
five-match mean, printed under a timeframe line that said "1 Jan 2025 to
11 Aug 2026" because the page stamped its date range on every panel.

So the rate is computed on the server, once, and published with the basis it
used. The browser's copy is deleted.
"""

from __future__ import annotations

import pytest

pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DB_PATH", str(tmp_path / "soccer.db"))
    import ledger.api.main as main
    from ledger.config import load_config
    main.cfg = load_config()
    with TestClient(main.app) as c:
        yield c


def _seed(client):
    """Four matches: three carry goal involvement, one only a result."""
    client.post("/api/sessions", json={"text": (
        "2026-07-06 soccer W3:1 60:00 2g1a rpe=8\n"
        "2026-07-13 soccer L1:2 60:00 1g0a rpe=8\n"
        "2026-07-20 soccer W4:0 60:00 0g2a rpe=8\n"
    )})
    # A result with no goal line: known to have happened, unknown involvement.
    client.post("/api/sessions", json={"text": "2026-07-27 soccer L0:3 60:00 rpe=8"})


def test_the_per_match_rate_is_published_with_its_denominator(client):
    _seed(client)
    d = client.get("/api/soccer").json()

    assert d["goal_involvements"] == 6           # 3 goals + 3 assists
    assert d["matches_with_involvement"] == 3    # not 4
    assert d["involvements_per_match"] == 2.0    # 6 / 3
    assert d["involvements_basis"] == "matches with goals or assists recorded"


def test_a_match_logged_without_a_goal_line_is_unknown_not_zero(client):
    """Counting it as a zero would drag the rate down for a record-keeping gap
    rather than for anything that happened on the pitch."""
    _seed(client)
    d = client.get("/api/soccer").json()

    assert d["games_played"] == 4                 # it counts as a match
    assert d["matches_with_involvement"] == 3     # but not against the rate
    assert d["involvements_per_match"] != round(6 / 4, 2)


def test_the_three_denominators_stay_distinguishable(client):
    """Each is a real quantity; the bug was using them interchangeably."""
    _seed(client)
    d = client.get("/api/soccer").json()

    assert d["games_logged"] >= d["games_played"] >= d["matches_with_involvement"]
    # goals_per_game divides by matches played; involvements_per_match does not.
    assert d["goals_per_game"] == round(3 / 4, 2)
    assert d["involvements_per_match"] == round(6 / 3, 2)


def test_the_fixture_is_resolved_once_on_the_server(client):
    """"Pickup" meant two things: the read-out counted an explicit field or the
    word in the note (6 matches), the By-fixture table fell all the way through
    to the weekday (8). Same word, two definitions, one page."""
    # A Tuesday with nothing said about it — weekday alone makes it pickup.
    client.post("/api/sessions", json={"text": "2026-07-07 soccer W2:1 60:00 1g0a rpe=8"})
    # A Monday that was really pickup, said in the note.
    client.post("/api/sessions", json={
        "text": '2026-07-06 soccer W2:1 60:00 1g0a rpe=8 "pickup at the park"'})
    # A plain Monday: coed by weekday.
    client.post("/api/sessions", json={"text": "2026-07-13 soccer L0:1 60:00 0g0a rpe=8"})

    by_date = {g["date"]: g for g in client.get("/api/soccer").json()["games"]}

    assert by_date["2026-07-07"]["fixture"] == "pickup"
    assert by_date["2026-07-07"]["fixture_source"] == "weekday"
    assert by_date["2026-07-06"]["fixture"] == "pickup"
    assert by_date["2026-07-06"]["fixture_source"] == "note"
    assert by_date["2026-07-13"]["fixture"] == "coed"

    # `pickup` is now that same resolution, not a narrower second rule.
    assert by_date["2026-07-07"]["pickup"] is True
    assert by_date["2026-07-13"]["pickup"] is False


def test_an_explicit_fixture_beats_the_weekday(client):
    client.post("/api/sessions", json={"text": "2026-07-07 soccer W2:1 60:00 rpe=8"})
    game = client.get("/api/soccer").json()["games"][0]
    client.patch(f"/api/sessions/{game['id']}", json={"detail": {"team": "mens"}})

    after = client.get("/api/soccer").json()["games"][0]
    assert after["fixture"] == "mens"          # not pickup, despite the Tuesday
    assert after["fixture_source"] == "set"
    assert after["pickup"] is False


def test_an_empty_record_reports_no_rate_rather_than_zero(client):
    d = client.get("/api/soccer").json()

    assert d["involvements_per_match"] is None
    assert d["matches_with_involvement"] == 0
    assert "involvements_basis" in d
