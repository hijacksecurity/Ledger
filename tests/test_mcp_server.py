"""The MCP server is a proxy, so the tests prove exactly that: every tool
returns what the API returns for the same question, no tool can write, and
the one error a user will actually hit (app not running) is explained.

The tools are called through FastMCP's own dispatcher, so argument schemas
are validated the way a real client's call would be.
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, timedelta

import pytest

pytest.importorskip("httpx")
pytest.importorskip("mcp", reason="pip install -e .[mcp]")

import httpx
from fastapi.testclient import TestClient

from ledger.entry import parse_entry
from ledger.ingest import save_session
from ledger.mcp import server

MONDAY = date.today() - timedelta(days=date.today().weekday())

ENTRY = f"""
{MONDAY.isoformat()} run 5.2km 28:00 rpe=6
{(MONDAY + timedelta(days=1)).isoformat()} lift 45min rpe=7
bench 3x60x5
{(MONDAY + timedelta(days=2)).isoformat()} soccer W3:1 1g1a 60min rpe=8
"""


@pytest.fixture
def api(tmp_path, monkeypatch):
    """The FastAPI app on a fresh database, with the MCP server pointed at it
    in-process rather than over a socket."""
    monkeypatch.setenv("LEDGER_DB_PATH", str(tmp_path / "mcp.db"))
    import ledger.api.main as main
    from ledger.config import load_config

    monkeypatch.setattr(main, "cfg", load_config())
    with TestClient(main.app) as client:
        conn = main.connect(main.cfg.db_path)
        for parsed in parse_entry(ENTRY):
            save_session(conn, parsed)
        conn.close()
        monkeypatch.setattr(server, "_transport", httpx.ASGITransport(app=main.app))
        yield client


def call(name: str, **args):
    result = asyncio.run(server.mcp.call_tool(name, args))
    # FastMCP returns (content blocks, structured) for structured output, or
    # just the content blocks. Either way the first text block is the answer.
    blocks = result[0] if isinstance(result, tuple) else result
    text = blocks[0].text
    try:
        return json.loads(text)
    except ValueError:
        return text


def tool_names() -> set[str]:
    return {t.name for t in asyncio.run(server.mcp.list_tools())}


# --- Shape of the surface --------------------------------------------------


def test_every_tool_is_read_only():
    tools = asyncio.run(server.mcp.list_tools())
    assert tools, "no tools registered"
    for t in tools:
        assert t.annotations is not None, t.name
        assert t.annotations.readOnlyHint is True, t.name
        assert t.annotations.destructiveHint is False, t.name


def test_scoreboard_is_not_exposed():
    names = tool_names()
    assert not any("score" in n for n in names), names
    assert "Scoreboard" in server.INSTRUCTIONS


def test_no_write_tools_registered():
    names = tool_names()
    for forbidden in ("sync", "create", "patch", "set_rpe", "delete", "lock", "mark"):
        assert forbidden not in names, forbidden
    # `sync_status` and `sync_log` are reads; the plain `sync` must not exist.
    assert {"sync_status", "sync_log"} <= names


def test_every_tool_has_a_description():
    for t in asyncio.run(server.mcp.list_tools()):
        assert t.description and len(t.description) > 20, t.name


# --- Each tool returns what the API returns --------------------------------


@pytest.mark.parametrize(
    ("tool", "args", "path"),
    [
        ("week_summary", {}, "/api/summary"),
        ("week_summary", {"week_of": MONDAY.isoformat(), "weeks": 0},
         f"/api/summary?week_of={MONDAY.isoformat()}&weeks=0"),
        ("history", {}, "/api/history"),
        ("sessions", {}, "/api/sessions"),
        ("sessions", {"kind": "run", "limit": 5}, "/api/sessions?kind=run&limit=5"),
        ("trends", {}, "/api/trends"),
        ("trends", {"metric": "distance", "grain": "month"},
         "/api/trends?metric=distance&grain=month"),
        ("distance_ramp", {}, "/api/distance"),
        ("plan", {}, "/api/plan/locked"),
        ("plan_projection", {"pct": 5.0, "weeks": 4}, "/api/plan/distance?pct=5&weeks=4"),
        ("soccer", {}, "/api/soccer"),
        ("daily_metrics", {}, "/api/metrics"),
        ("daily_metrics", {"all_time": True}, "/api/metrics?all=true"),
        ("weeks", {}, "/api/weeks"),
        ("week_notes", {"start_date": MONDAY.isoformat()},
         f"/api/weeks/{MONDAY.isoformat()}/notes"),
        ("habits", {}, "/api/habits"),
        ("habits_trend", {"weeks": 8}, "/api/habits/trend?weeks=8"),
        ("sync_status", {}, "/api/sync-status"),
        ("sync_log", {"limit": 3}, "/api/sync-log?limit=3"),
    ],
)
def test_tool_matches_api(api, tool, args, path):
    expected = api.get(path).json()
    got = call(tool, **args)
    assert got == expected


def test_exercises_match_api(api):
    assert call("exercises")["exercises"] == api.get("/api/exercises").json()


def test_session_detail_matches_api(api):
    first = api.get("/api/sessions").json()["items"][0]
    got = call("session", session_id=first["id"])
    assert got == api.get(f"/api/sessions/{first['id']}").json()
    assert got["id"] == first["id"]


def test_exercise_last_sets_matches_api(api):
    ex = api.get("/api/exercises").json()
    assert ex, "the lift in ENTRY should have created an exercise"
    got = call("exercise_last_sets", exercise_id=ex[0]["id"])["sets"]
    assert got == api.get(f"/api/exercises/{ex[0]['id']}/last").json()
    assert got, "the bench sets should be there"


def test_weekly_report_is_the_text_report(api):
    text = call("weekly_report")
    assert isinstance(text, str)
    assert text.startswith("LEDGER — week of")
    assert "<html" not in text.lower()
    assert text == api.get("/api/report/weekly?format=text").text


def test_the_figures_are_real(api):
    """Not just equal to the API — the API saw the sessions that were entered."""
    log = call("sessions")
    assert log["total"] == 3
    kinds = sorted(s["kind"] for s in log["items"])
    assert kinds == ["lift", "run", "soccer"]
    run = next(s for s in log["items"] if s["kind"] == "run")
    assert run["distance_km"] == pytest.approx(5.2)
    assert run["duration_min"] == 28


# --- Errors a user will meet ----------------------------------------------


def test_api_error_is_passed_through(api):
    with pytest.raises(Exception, match="422"):
        call("trends", metric="nonsense")


def test_unknown_session_is_a_clear_404(api):
    with pytest.raises(Exception, match="404"):
        call("session", session_id=999_999)


def test_app_down_names_the_fix(monkeypatch):
    monkeypatch.setattr(server, "_transport", None)
    monkeypatch.setattr(server, "LEDGER_URL", "http://127.0.0.1:9")
    with pytest.raises(Exception, match="docker compose up -d"):
        call("history")


# --- The API change made for this -----------------------------------------


def test_weekly_report_default_is_still_html(api):
    r = api.get("/api/report/weekly")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    r = api.get("/api/report/weekly?format=text")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
