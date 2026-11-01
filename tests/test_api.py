"""HTTP surface.

These exist mainly because the endpoints run on a threadpool, and a sqlite3
connection may only be used on the thread that created it. A shared connection
passes every unit test and then 500s on the first real request — so the API
gets exercised through a client, not by calling the functions directly.
"""

from __future__ import annotations

from datetime import date

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


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_root_serves_the_dashboard(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "<title>Ledger</title>" in r.text
    assert "/app.js" in r.text


def test_static_assets_are_served(client):
    for path, kind in [
        ("/app.js", "javascript"),
        ("/styles.css", "css"),
        ("/manifest.json", "json"),
        ("/sw.js", "javascript"),
    ]:
        r = client.get(path)
        assert r.status_code == 200, path
        assert kind in r.headers["content-type"], path


def test_summary_shape(client):
    """The dashboard reads these keys directly; renaming one breaks the page."""
    client.post(
        "/api/sessions",
        json={"date": "2026-08-05", "kind": "soccer", "rpe": 9, "duration_min": 60},
    )
    d = client.get("/api/summary?week_of=2026-08-05").json()
    for key in (
        "week", "headline", "kinds", "consistency", "load",
        "load_by_week", "sessions", "prs", "bodyweight", "latest_week_end",
    ):
        assert key in d, key
    assert d["load"]["week_total"] == 540          # 9 rpe x 60 min
    assert d["load"]["by_kind"]["soccer"] == 540
    assert len(d["load_by_week"]) == 12
    assert d["sessions"][0]["kind"] == "soccer"


def test_history_grows_a_year_row_per_year_present(client):
    """Open-ended by construction: no year list is hardcoded anywhere."""
    for day in ("2025-03-04", "2026-01-07", "2027-11-30"):
        client.post(
            "/api/sessions",
            json={"date": day, "kind": "run", "rpe": 5, "duration_min": 30},
        )
    h = client.get("/api/history").json()

    assert [y["year"] for y in h["years"]] == ["2025", "2026", "2027"]
    assert h["start"] == "2025-03-04"
    assert h["end"] >= "2027-11-30"
    # One count per day from the first entry to the end of the final week.
    span = (date.fromisoformat(h["end"]) - date.fromisoformat(h["start"])).days + 1
    assert len(h["counts"]) == span
    assert sum(h["counts"]) == h["total"] == 3


def test_history_of_an_empty_database(client):
    h = client.get("/api/history").json()
    assert h["start"] is None
    assert h["years"] == []
    assert h["counts"] == []


def test_latest_week_end_tracks_the_data_not_the_request(client):
    """`next` must stop at the newest real week, however far ahead it is."""
    client.post(
        "/api/sessions",
        json={"date": "2027-06-02", "kind": "run", "rpe": 5, "duration_min": 30},
    )
    d = client.get("/api/summary?week_of=2025-01-01").json()
    assert d["latest_week_end"] == "2027-06-06"   # Sunday of that week


def test_load_window_is_selectable_and_clamped(client):
    assert len(client.get("/api/summary?weeks=26").json()["load_by_week"]) == 26
    assert len(client.get("/api/summary?weeks=52").json()["load_by_week"]) == 52
    # Ceiling is ten years, not two: the Week page offers "All time" and the
    # record has to be able to outgrow the old 104-week cap.
    assert len(client.get("/api/summary?weeks=9999").json()["load_by_week"]) == 520
    assert len(client.get("/api/summary?weeks=1").json()["load_by_week"]) == 4


def test_weeks_zero_means_the_whole_record(client):
    """"All time" has to keep meaning all time as the record grows, so it is
    resolved against the first logged session rather than a constant."""
    client.post("/api/sessions", json={
        "date": "2026-01-05", "kind": "run", "rpe": 5, "duration_min": 30})
    client.post("/api/sessions", json={
        "date": "2026-03-02", "kind": "run", "rpe": 5, "duration_min": 30})

    d = client.get("/api/summary?week_of=2026-03-08&weeks=0").json()

    # 5 Jan to 8 Mar 2026 inclusive is nine Monday-start weeks.
    assert d["load_weeks"] == 9
    assert len(d["load_by_week"]) == 9
    assert d["load_by_week"][0]["week_start"] == "2026-01-05"
    assert d["timeframes"]["load_by_week"]["periods"] == 9


def test_all_time_does_not_flicker_with_the_week_anchor(client):
    """Any day of a week must resolve to the same span. Anchoring on the raw
    date instead of its Monday made "All time" read 84 on load and 85 after a
    click, purely because one request carried `week_of` and the other did not."""
    client.post("/api/sessions", json={
        "date": "2026-01-07", "kind": "run", "rpe": 5, "duration_min": 30})

    spans = {
        client.get(f"/api/summary?week_of={day}&weeks=0").json()["load_weeks"]
        for day in ("2026-03-02", "2026-03-05", "2026-03-08")   # Mon, Thu, Sun
    }
    assert len(spans) == 1


def test_weeks_zero_on_an_empty_database_falls_back(client):
    """No first session means no span to resolve; it must not divide by nothing."""
    d = client.get("/api/summary?weeks=0").json()
    assert d["load_weeks"] == 12


def test_summary_on_an_empty_database_is_all_nulls_not_zeros(client):
    """Nothing may be invented before there is data to compute it from."""
    d = client.get("/api/summary").json()
    assert d["headline"]["avg_per_week"] is None
    assert d["load"]["acwr"] is None
    assert d["load"]["band"] == "building baseline"
    assert d["bodyweight"]["ema_kg"] is None
    assert d["prs"] == []


def test_weekly_report_renders_on_an_empty_database(client):
    """A brand-new install must not 500, and must not invent numbers."""
    r = client.get("/api/report/weekly")
    assert r.status_code == 200
    assert "Ledger" in r.text
    assert "no sessions logged" in r.text


def test_post_session_then_see_it_in_the_report(client):
    r = client.post(
        "/api/sessions",
        json={
            "date": "2026-08-05",
            "kind": "soccer",
            "rpe": 9,
            "duration_min": 60,
            "notes": "indoor league",
            "exercises": [],
        },
    )
    assert r.status_code == 200, r.text
    session_id = r.json()["session_id"]

    report = client.get("/api/report/weekly?week_of=2026-08-05")
    assert report.status_code == 200
    assert "soccer" in report.text

    assert client.post(f"/api/sessions/{session_id}/rpe", json={"rpe": 8}).status_code == 200


def test_bad_payloads_are_422_not_500(client):
    assert client.post("/api/sessions", json={"kind": "run"}).status_code == 422
    assert client.post("/api/sessions/1/rpe", json={}).status_code == 422
    assert client.post("/api/sessions/1/rpe", json={"rpe": 42}).status_code == 422


def test_repeated_requests_hit_different_threads_without_error(client):
    """The regression this file exists for."""
    for _ in range(12):
        assert client.get("/api/report/weekly").status_code == 200


def test_every_screen_reports_the_same_average(client):
    """Three screens once showed 4.20, 4.27 and 4.35 for the same figure.

    The week hero and the history page must agree to the cent, because they
    are the same sentence about the same record.
    """
    client.post("/api/sessions", json={"text": (
        "week 2026-08-03 213lb 4.27 #86\n"
        "2026-07-20 run 5km 30:00 rpe=5\n"
        "2026-07-27 soccer W3:1 60min rpe=9\n"
        "2026-08-05 run 6km 35:00 rpe=5\n"
    )})

    # Both without a week, so both describe the same "now" — comparing a
    # requested week against the current one is not the same question.
    summary = client.get("/api/summary").json()
    history = client.get("/api/history").json()

    assert history["average"]["value"] == summary["headline"]["avg_per_week"]
    assert history["average"]["weeks"] == summary["headline"]["weeks_divisor"]

    # And when the week being asked about does have a notebook page, the
    # divisor comes from its counter: week 86's header describes 85 done.
    wk86 = client.get("/api/summary?week_of=2026-08-05").json()["headline"]
    assert wk86["weeks_divisor"] == 85


def test_average_falls_back_to_calendar_weeks_without_a_page_number(client):
    client.post("/api/sessions", json={"text": "2026-03-02 run 5km 30:00 rpe=5"})
    avg = client.get("/api/history").json()["average"]
    assert avg["basis"] == "elapsed"
    assert avg["weeks"] >= 1


def test_average_of_an_empty_record_is_none_not_zero(client):
    avg = client.get("/api/history").json()["average"]
    assert avg["value"] is None and avg["basis"] == "empty"


def test_the_weekly_load_total_equals_the_sessions_it_totals(client):
    """The total was Foster AU while the rows were Garmin-scale — 2091 vs 661.

    A total that does not equal the things it totals is the most corrosive
    kind of wrong: every number looks plausible on its own.
    """
    client.post("/api/sessions", json={"text": (
        "2026-08-03 run 5km 30:00 rpe=5\n"
        "2026-08-05 soccer W3:1 60min rpe=9\n"
        "2026-08-06 bike 20km 45:00 rpe=6\n"
    )})
    d = client.get("/api/summary?week_of=2026-08-05").json()

    rows = sum(s["load"] or 0 for s in d["sessions"])
    assert d["load"]["week_total"] == pytest.approx(rows, abs=1)

    # And the per-modality split must add up to the same figure.
    assert sum(d["load"]["by_kind"].values()) == pytest.approx(rows, abs=2)


def test_the_week_counter_continues_into_unwritten_weeks(client):
    """A week with no page yet still has a number.

    Falling back to calendar weeks silently switched basis — 84 instead of 86 —
    so the average jumped every Monday for no visible reason.
    """
    client.post("/api/sessions", json={"text": (
        "week 2026-08-03 213lb 4.27 #86\n"
        "2026-08-05 soccer W3:1 60min rpe=9\n"
    )})

    written = client.get("/api/summary?week_of=2026-08-05").json()["headline"]
    assert written["weeks_divisor"] == 85          # page 86 -> 85 completed

    # The following week has no page. The counter carries on regardless.
    nextwk = client.get("/api/summary?week_of=2026-08-12").json()["headline"]
    assert nextwk["weeks_divisor"] == 86           # page 87 -> 86 completed

    # And three weeks out, still counting rather than reverting to calendar.
    later = client.get("/api/summary?week_of=2026-08-26").json()["headline"]
    assert later["weeks_divisor"] == 88


# --- league auto-refresh ---------------------------------------------------
#
# The scraper is never allowed near the network here. What is under test is
# the decision to scrape, not the scraping — leagues.py has its own tests for
# the parsing, and this file would otherwise depend on somebody else's site
# being up.


@pytest.fixture(autouse=True)
def _reset_league_guards():
    """The refresh guards are module globals, like `_sync_running`.

    Without this, the first test to trigger a scrape leaves the cooldown armed
    and every test after it silently sees "recently attempted".
    """
    import ledger.api.main as main

    main._league_refreshing = False
    main._league_last_attempt = None
    yield


def _fake_refresh(calls, *, age_hours: float = 0.0):
    """Stand in for the scraper: record the call and move `fetched_at` the way
    a real refresh would, at a controllable age."""
    from datetime import UTC, datetime, timedelta

    def refresh_all(conn):
        calls.append(True)
        stamp = (
            datetime.now(UTC) - timedelta(hours=age_hours)
        ).isoformat(timespec="seconds")
        conn.execute(
            "INSERT INTO league (provider_id, name, my_team, fixture, url, fetched_at) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(provider_id) DO UPDATE SET fetched_at = excluded.fetched_at",
            ("test", "Test League", "Sparrows FC", "coed",
             "https://example.invalid/league", stamp),
        )
        return [("Sparrows FC", "1 teams, 0 fixtures (0 played)")]

    return refresh_all


def test_an_empty_league_table_fills_itself(client, monkeypatch):
    from ledger import leagues

    calls = []
    monkeypatch.setattr(leagues, "refresh_all", _fake_refresh(calls))

    body = client.get("/api/leagues").json()
    assert body["refreshing"] is True       # started behind the response
    assert body["leagues"] == []            # ...so this response is still empty
    assert len(calls) == 1

    # TestClient drains background tasks before returning, so the row has
    # landed by the time the client asks again — which is the whole point.
    again = client.get("/api/leagues").json()
    assert again["refreshing"] is False
    assert again["leagues"][0]["my_team"] == "Sparrows FC"
    assert len(calls) == 1                  # fresh now; not scraped twice


def test_fresh_leagues_are_served_without_refetching(client, monkeypatch):
    from ledger import leagues

    calls = []
    monkeypatch.setattr(leagues, "refresh_all", _fake_refresh(calls))
    client.get("/api/leagues")              # populates, at age zero

    for _ in range(5):
        assert client.get("/api/leagues").json()["refreshing"] is False
    assert len(calls) == 1


def test_stale_leagues_are_refetched(client, monkeypatch):
    """Nine hours old is past LEAGUE_MAX_AGE_S — last night's game is missing."""
    import ledger.api.main as main
    from ledger import leagues

    calls = []
    monkeypatch.setattr(leagues, "refresh_all", _fake_refresh(calls, age_hours=9))
    client.get("/api/leagues")
    assert len(calls) == 1

    main._league_last_attempt = None        # pretend the cooldown has expired
    monkeypatch.setattr(leagues, "refresh_all", _fake_refresh(calls))
    assert client.get("/api/leagues").json()["refreshing"] is True
    assert len(calls) == 2

    # And now that it is current, it settles.
    assert client.get("/api/leagues").json()["refreshing"] is False
    assert len(calls) == 2


def test_a_failing_scrape_is_not_retried_on_every_open(client, monkeypatch):
    """The cooldown is load-bearing.

    `refresh_all()` reports a dead league page as an outcome rather than
    raising, so `fetched_at` never moves — staleness alone would hammer a
    404ing season page once per app open, forever.
    """
    from ledger import leagues

    calls = []

    def failing(conn):
        calls.append(True)
        return [("Sparrows FC", "failed: HTTPError: HTTP Error 404: Not Found")]

    monkeypatch.setattr(leagues, "refresh_all", failing)

    for _ in range(4):
        assert client.get("/api/leagues").status_code == 200
    assert len(calls) == 1


def test_a_scrape_that_raises_does_not_break_the_page(client, monkeypatch):
    """A stale table beats a 500 on the soccer view."""
    from ledger import leagues

    def exploding(conn):
        raise RuntimeError("the page layout has probably changed")

    monkeypatch.setattr(leagues, "refresh_all", exploding)

    r = client.get("/api/leagues")
    assert r.status_code == 200
    assert r.json()["leagues"] == []

    # The in-flight flag must be cleared even on the failure path, or every
    # later request reports a refresh that is not running.
    import ledger.api.main as main
    assert main._league_refreshing is False


def test_explicit_refresh_disarms_the_automatic_one(client, monkeypatch):
    from ledger import leagues

    calls = []
    monkeypatch.setattr(leagues, "refresh_all", _fake_refresh(calls, age_hours=9))

    posted = client.post("/api/leagues/refresh").json()
    assert posted["results"] == [{"team": "Sparrows FC",
                                 "outcome": "1 teams, 0 fixtures (0 played)"}]
    assert len(calls) == 1

    # The rows it wrote are stale by construction, but the GET must not turn
    # straight round and scrape the same two pages again.
    assert client.get("/api/leagues").json()["refreshing"] is False
    assert len(calls) == 1


def test_the_first_refresh_survives_a_recently_booted_machine(client, monkeypatch):
    """Regression: the cooldown must not swallow the very first scrape.

    `time.monotonic()` counts from boot, not from process start. A container
    that came up a minute ago reports ~60, so a `0.0` "never attempted"
    sentinel made `now - last` about 60 seconds — inside the one-hour cooldown
    — and the leagues sat stale until an hour after every restart. Shipped
    that way once; caught only because Docker Desktop had just started.
    """
    import ledger.api.main as main
    from ledger import leagues

    monkeypatch.setattr(main.time, "monotonic", lambda: 67.0)

    calls = []
    monkeypatch.setattr(leagues, "refresh_all", _fake_refresh(calls))

    assert client.get("/api/leagues").json()["refreshing"] is True
    assert len(calls) == 1


def test_metrics_window_returns_every_column_and_keeps_nulls(client, tmp_path):
    import os

    from ledger.db import queries as q
    from ledger.db.schema import connect

    conn = connect(os.environ["LEDGER_DB_PATH"])
    q.upsert_metric_daily(conn, "2026-01-05", sleep_hours=6.5, hrv_ms=48.0, stress_avg=31)
    q.upsert_metric_daily(conn, "2026-01-06", sleep_hours=7.2)
    conn.commit()
    conn.close()

    res = client.get("/api/metrics?from=2026-01-04&to=2026-01-06")
    assert res.status_code == 200
    body = res.json()
    assert body["timeframe"]["from"] == "2026-01-04"
    assert body["timeframe"]["to"] == "2026-01-06"
    assert body["timeframe"]["grain"] == "day"
    days = body["days"]
    assert [d["date"] for d in days] == ["2026-01-05", "2026-01-06"]
    assert days[0]["stress_avg"] == 31
    assert days[1]["hrv_ms"] is None          # null kept, never zero
    assert "body_battery_wake" in days[0]     # every 015 column present


def test_metrics_rejects_a_backwards_window(client):
    assert client.get("/api/metrics?from=2026-02-01&to=2026-01-01").status_code == 422
    assert client.get("/api/metrics?from=nope").status_code == 422


def test_metrics_all_spans_the_whole_record(client):
    import os

    from ledger.db import queries as q
    from ledger.db.schema import connect

    conn = connect(os.environ["LEDGER_DB_PATH"])
    q.upsert_metric_daily(conn, "2025-06-01", bodyweight_kg=99.0)   # scale only
    q.upsert_metric_daily(conn, "2025-12-30", sleep_hours=6.0)
    q.upsert_metric_daily(conn, "2026-01-02", sleep_hours=7.0)
    conn.commit()
    conn.close()

    body = client.get("/api/metrics?all=1").json()
    assert body["timeframe"]["from"] == "2025-12-30"   # first night, not first weigh-in
    assert body["timeframe"]["all_time"] is True
    assert [d["date"] for d in body["days"]] == ["2025-12-30", "2026-01-02"]
