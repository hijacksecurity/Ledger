"""Ledger as an MCP server: the read API, for a Claude session on this machine.

    .venv/Scripts/python.exe -m ledger.mcp_server            # stdio (default)
    .venv/Scripts/python.exe -m ledger.mcp_server --transport http --port 8765

A thin proxy, nothing more. Every tool is one GET against the running app
(`LEDGER_URL`, default http://127.0.0.1:8000) and returns the JSON the page
would have drawn — the same figure, from the same place, so a number quoted in
a chat is the number on the screen. Nothing here opens the database, nothing
here aggregates, and nothing here is computed twice.

Read-only, on purpose. The one person this is for asked for reads first; a
write section is sketched at the bottom for when that changes.

Not here, and not an omission: the Scoreboard. `#/score` grades a week on a
ramp the browser computes, and it was asked for as a glance, not as a figure
to reason from. A model handed a letter grade will argue from it. The load,
the ratio and the sessions behind it are all exposed; the grade is not.

Transport is stdio because that is what Claude Desktop and Claude Code both
launch directly, and because a child process listens on nothing. `--transport
http` serves the same tools on a loopback port for a client that needs one.
It binds 127.0.0.1 and nothing else.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

LEDGER_URL = os.getenv("LEDGER_URL", "http://127.0.0.1:8000").rstrip("/")

INSTRUCTIONS = """\
Ledger is a single-user training log: soccer, running, biking, lifting,
rucking and fasting on one load scale. Every tool is a read of the running
app; nothing is computed in this server.

Conventions the data follows:
- Dates are ISO (YYYY-MM-DD). Weeks run Monday to Sunday; `week_of` accepts
  any date inside the week wanted.
- `load` is Foster session-RPE, rpe x minutes, in AU. A session's
  `load_source` says whether that figure is `raw` (RPE typed in), `estimated`
  (fitted from the watch's own load) or `unscaled` (no fit yet).
- ACWR (acute:chronic, 7 days over 28) is a position on a heuristic, never a
  verdict. Report it as a ratio with its two windows; do not call it safe,
  dangerous, or a warning.
- Rolling windows only. There are no streaks, and nothing resets on a
  calendar boundary. Do not invent streaks from the data.
- Session kinds: lift, run, soccer, bike, ruck, fast, ab, quickfeet, stairs,
  other. "On foot" means soccer, run, stairs, quickfeet, ruck and other, not
  run alone.
- The Scoreboard page (#/score) is deliberately not exposed. Do not grade a
  week; show the figures.

The app may be down. A tool error naming `docker compose up -d` means exactly
that, and there is nothing to retry until it is started.
"""

# Quiet on stderr: over stdio every INFO line lands in the client's log, and a
# request log of the user's own reads is noise nobody asked for.
mcp = FastMCP("ledger", instructions=INSTRUCTIONS, log_level="WARNING")
logging.getLogger("httpx").setLevel(logging.WARNING)

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)

#: Tests inject an in-process ASGI transport here; production leaves it None.
_transport: httpx.AsyncBaseTransport | None = None


async def _get(path: str, **params: Any) -> Any:
    """One GET against the app. Errors come back as messages a chat can act on."""
    query = {k: v for k, v in params.items() if v is not None}
    try:
        async with httpx.AsyncClient(
            base_url=LEDGER_URL, transport=_transport, timeout=30.0
        ) as client:
            r = await client.get(path, params=query)
    except httpx.ConnectError as exc:
        raise RuntimeError(
            f"Ledger is not reachable at {LEDGER_URL}. It runs in Docker on this "
            "machine; start it with `docker compose up -d` in the Ledger checkout."
        ) from exc
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", r.text)
        except ValueError:
            detail = r.text
        raise RuntimeError(f"Ledger API returned {r.status_code} for {path}: {detail}")
    if r.headers.get("content-type", "").startswith("application/json"):
        return r.json()
    return r.text


# --- The week -------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def week_summary(week_of: str | None = None, weeks: int = 12) -> dict[str, Any]:
    """Everything the Week page draws for one week, in one call.

    Sessions this week and the trailing 28 days by kind, load by week with
    ACWR, bodyweight, PRs, recovery read-outs and the plan comparison.
    `week_of` is any date in the week wanted (default: this week). `weeks`
    sizes the load history; 0 means the whole record.
    """
    return await _get("/api/summary", week_of=week_of, weeks=weeks)


@mcp.tool(annotations=READ_ONLY)
async def weekly_report(week_of: str | None = None) -> str:
    """The weekly report as plain text, the same one `ledger report` prints.

    The quickest way to read a week. `week_of` is any date in that week.
    """
    return await _get("/api/report/weekly", week_of=week_of, format="text")


@mcp.tool(annotations=READ_ONLY)
async def history() -> dict[str, Any]:
    """Every day since the first entry, plus a row per year. Lifetime totals."""
    return await _get("/api/history")


# --- Sessions -------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def sessions(
    from_date: str | None = None,
    to_date: str | None = None,
    kind: str | None = None,
    search: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """The session log (`items`), one row per logged activity, newest first,
    with `total` for paging and the load `calibration` in force.

    Filter by date window, `kind` (lift, run, soccer, bike, ruck, fast, ab,
    quickfeet, stairs, other) or free text. `limit` is capped at 500 by the
    app; page with `offset`.
    """
    return await _get(
        "/api/sessions", **{"from": from_date, "to": to_date},
        kind=kind, q=search, limit=limit, offset=offset,
    )


@mcp.tool(annotations=READ_ONLY)
async def session(session_id: int) -> dict[str, Any]:
    """One session in full: sets for a lift, splits and HR zones for a run,
    scoreline and goals for a match, as the detail was recorded."""
    return await _get(f"/api/sessions/{session_id}")


@mcp.tool(annotations=READ_ONLY)
async def trends(
    metric: str = "load",
    grain: str = "week",
    kind: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> dict[str, Any]:
    """One metric per week or month, with its split by kind.

    `metric`: load, garmin_load, distance, duration or count.
    `grain`: week or month. Empty periods are present with zero, so the
    series has no gaps to misread.
    """
    return await _get(
        "/api/trends", metric=metric, grain=grain, kind=kind,
        **{"from": from_date, "to": to_date},
    )


# --- Distance and the plan ------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def distance_ramp(weeks: int = 26, week_of: str | None = None) -> dict[str, Any]:
    """Weekly distance on foot, week over week, with the +10% progression guide.

    The guide is a suggestion the app prints beside the figure, not a target
    it enforces.
    """
    return await _get("/api/distance", weeks=weeks, week_of=week_of)


@mcp.tool(annotations=READ_ONLY)
async def plan(week_of: str | None = None) -> dict[str, Any]:
    """The committed distance plan, each week beside what actually happened.

    Empty when no plan has been locked on the Plan page.
    """
    return await _get("/api/plan/locked", week_of=week_of)


@mcp.tool(annotations=READ_ONLY)
async def plan_projection(
    pct: float = 10.0,
    weeks: int = 8,
    deload_every: int = 4,
    base_km: float | None = None,
    week_of: str | None = None,
) -> dict[str, Any]:
    """Project weekly distance forward at a chosen ramp, without committing it.

    `pct` per week, a deload every `deload_every` weeks, starting from
    `base_km` or from the current trailing figure.
    """
    return await _get(
        "/api/plan/distance", pct=pct, weeks=weeks, deload_every=deload_every,
        base_km=base_km, week_of=week_of,
    )


# --- Soccer ---------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def soccer(from_date: str | None = None, to_date: str | None = None) -> dict[str, Any]:
    """Record, goal involvement and every logged match in the window."""
    return await _get("/api/soccer", **{"from": from_date, "to": to_date})


@mcp.tool(annotations=READ_ONLY)
async def leagues() -> dict[str, Any]:
    """Standings and upcoming fixtures for the leagues followed.

    Serves what is stored. When that is stale the app starts a refresh in the
    background and sets `refreshing`; call again shortly for the newer set.
    """
    return await _get("/api/leagues")


# --- Recovery -------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def daily_metrics(
    from_date: str | None = None, to_date: str | None = None, all_time: bool = False
) -> dict[str, Any]:
    """The watch's nightly numbers, one row per date: sleep, HRV, resting HR,
    readiness, stress, body battery, bodyweight.

    Nulls are nights the watch was not worn, never zero. Default window is the
    trailing 28 days; `all_time` returns every night recorded.
    """
    return await _get(
        "/api/metrics", **{"from": from_date, "to": to_date}, all=all_time or None
    )


# --- Weeks and habits -----------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def weeks(from_date: str | None = None, to_date: str | None = None) -> dict[str, Any]:
    """Week headers as the notebook writes them: week number, bodyweight,
    cumulative activities per week, and the header note."""
    return await _get("/api/weeks", **{"from": from_date, "to": to_date})


@mcp.tool(annotations=READ_ONLY)
async def week_notes(start_date: str) -> dict[str, Any]:
    """Dated notes attached to one week. `start_date` is that week's Monday."""
    return await _get(f"/api/weeks/{start_date}/notes")


@mcp.tool(annotations=READ_ONLY)
async def habits(
    from_date: str | None = None, to_date: str | None = None, include_archived: bool = False
) -> dict[str, Any]:
    """Every daily habit and what each day in the window was worth."""
    return await _get(
        "/api/habits", **{"from": from_date, "to": to_date},
        include_archived=include_archived or None,
    )


@mcp.tool(annotations=READ_ONLY)
async def habits_trend(weeks: int = 12, include_archived: bool = False) -> dict[str, Any]:
    """Weekly totals per habit for the last `weeks` weeks (4 to 52)."""
    return await _get(
        "/api/habits/trend", weeks=weeks, include_archived=include_archived or None
    )


# --- Lifting --------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def exercises() -> dict[str, Any]:
    """Every exercise ever logged, with its id."""
    return {"exercises": await _get("/api/exercises")}


@mcp.tool(annotations=READ_ONLY)
async def exercise_last_sets(exercise_id: int) -> dict[str, Any]:
    """The most recent sets logged for one exercise, by id from `exercises`."""
    return {"sets": await _get(f"/api/exercises/{exercise_id}/last")}


# --- Sync -----------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def sync_status() -> dict[str, Any]:
    """Whether the nightly Garmin sync is working, when it last ran, when it
    runs next, and what to do if it is not."""
    return await _get("/api/sync-status")


@mcp.tool(annotations=READ_ONLY)
async def sync_log(limit: int = 50) -> dict[str, Any]:
    """The most recent sync log entries, newest first."""
    return await _get("/api/sync-log", limit=limit)


# --- Writes: not registered -----------------------------------------------
#
# When writes are wanted they go here, behind `LEDGER_MCP_WRITES=1`, each one
# a POST/PATCH the app already accepts and each returning what the app echoed,
# never a figure made up here. The shape asked for so far:
#
#   sync(days)                  POST /api/sync — pull the last few days from the
#                               watch, then let the user amend what came in
#   patch_session(id, fields)   PATCH /api/sessions/{id} — fix a kind, RPE,
#                               duration or note on a synced session
#   set_rpe(id, rpe)            POST /api/sessions/{id}/rpe
#
# Before any of these ship, the uncalibrated echo in NOTES-FOR-BACKEND (0-BUG)
# has to be fixed, or a session written from a chat is quoted back at 4x its
# calibrated load. Reads are safe from that; writes are not.


def main(argv: list[str] | None = None) -> int:
    global LEDGER_URL
    p = argparse.ArgumentParser(description="Ledger MCP server (read-only)")
    p.add_argument("--transport", choices=["stdio", "http"], default="stdio")
    p.add_argument("--port", type=int, default=8765, help="loopback port for --transport http")
    p.add_argument("--url", default=None, help=f"the app (default {LEDGER_URL})")
    args = p.parse_args(argv)

    if args.url:
        LEDGER_URL = args.url.rstrip("/")

    if args.transport == "http":
        mcp.settings.host = "127.0.0.1"
        mcp.settings.port = args.port
        mcp.run(transport="streamable-http")
    else:
        mcp.run(transport="stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
