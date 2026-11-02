"""Ledger as an MCP server: the read API, for a Claude session on this machine.

    .venv/Scripts/python.exe -m ledger.mcp            # stdio (default)
    .venv/Scripts/python.exe -m ledger.mcp --transport http --port 8765

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
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

LEDGER_URL = os.getenv("LEDGER_URL", "http://127.0.0.1:8000").rstrip("/")

INSTRUCTIONS = """\
Ledger is a single-user training log: soccer, running, biking, lifting,
rucking and fasting on one load scale. Every tool is a read of the running
app; nothing is computed in this server.

Ledger is the record. When a Garmin MCP is also connected, answer from
Ledger first for anything about training, sessions, load, ACWR, matches,
leagues, habits, weight, calories eaten and burned, or the watch's nightly
numbers (sleep, HRV, resting HR, readiness, body battery, stress): Ledger
holds them already
cleaned, calibrated and on the app's own scales, and a figure quoted from
here is the figure on the page. Go to the Garmin MCP only for what Ledger
does not store — per-activity detail such as splits, laps, HR time series,
the weather during an activity, gear, device state — or when a Ledger tool
says the app is down. Never combine the two sources into one figure.

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
- Leagues: `leagues` is the seasons being played; `league_seasons` is every
  season on record with its final table, results and the goals logged.
- Calories: intake is what the user typed, burn is Garmin's. A day's deficit
  is burn minus intake. For today the burn is an estimate and the payload
  says so (`burn.estimated`): Garmin pro-rates BMR during the day, so the
  app takes the median BMR of recent finished days as the full-day baseline
  and adds the active calories so far. Quote the `arithmetic` line as
  printed; state the figures against the target, do not judge the day.
- Weather: `weather_hourly` and `weather_daily` are the forecast the pages
  show, for the one place in the app's configuration, from Open-Meteo. A
  forecast, never the record; a day seven or more out is an outlook.
- What a field means, and which surfaces depend on it, is in the resource
  `ledger://docs/data-map`; the design rules are in `ledger://docs/brief`.

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


# --- The app itself -------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def health() -> dict[str, Any]:
    """Is the app up, and which database it is serving. The cheapest call;
    use it before anything else when a tool has just failed."""
    return await _get("/api/health")


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


@mcp.tool(annotations=READ_ONLY)
async def plan_intent(
    from_date: str | None = None, to_date: str | None = None
) -> dict[str, Any]:
    """Planned session counts per kind, one row per week that has its own plan.

    `kinds` is kind -> count (`{"run": 3, "soccer": 2}`) with a free-text
    `note`. Only weeks written explicitly are listed; on the Plan page a week
    with no row inherits the most recent earlier one. Dates are ISO Mondays.
    """
    return await _get("/api/plan/intent", **{"from": from_date, "to": to_date})


@mcp.tool(annotations=READ_ONLY)
async def plan_days(
    from_date: str | None = None, to_date: str | None = None
) -> dict[str, Any]:
    """How each planned week's distance is spread over its days.

    Per week: `km` is date -> planned kilometres and `match` is the match
    days the user marked themselves (published fixtures are in `leagues`).
    """
    return await _get("/api/plan/days", **{"from": from_date, "to": to_date})


@mcp.tool(annotations=READ_ONLY)
async def plan_goal() -> dict[str, Any]:
    """The goal weight in pounds, or null when none is set.

    The Scoreboard scores which way the four-week bodyweight average is
    moving relative to it, never the number itself.
    """
    return await _get("/api/plan/goal")


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


@mcp.tool(annotations=READ_ONLY)
async def league_seasons() -> dict[str, Any]:
    """Every league season on record, newest first: final position and
    record for a finished one, the table so far for the one being played,
    every result, and the goals and assists logged inside its dates."""
    return await _get("/api/leagues/seasons")


# --- Recovery -------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def daily_metrics(
    from_date: str | None = None, to_date: str | None = None, all_time: bool = False
) -> dict[str, Any]:
    """The watch's nightly numbers, one row per date: sleep, HRV, resting HR,
    readiness, stress, body battery, bodyweight.

    Nulls are nights the watch was not worn, never zero. Default window is the
    trailing 28 days; `all_time` returns every night recorded.

    Rows also carry the raw burn columns (`calories_total`, `calories_active`,
    `calories_bmr`, `day_elapsed_min`) exactly as Garmin reported them at
    fetch time. Do not read `calories_total` as a day's burn from here: a row
    with `day_elapsed_min` under 1440 is a partial day. The `calories` tool
    has the interpreted figures.
    """
    return await _get(
        "/api/metrics", **{"from": from_date, "to": to_date}, all=all_time or None
    )


# --- Calories --------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def calories(from_date: str | None = None, to_date: str | None = None) -> dict[str, Any]:
    """Intake against burn, one row per day: the meals typed in and their sum
    (`intake`), what the watch reports burned (`burn.bmr` + `burn.active` =
    `burn.total`), the `deficit` (burn minus intake), and `eat_up_to`, the
    intake that would land exactly on the daily target.

    `burn.estimated` is true for an unfinished day: Garmin pro-rates BMR
    during the day, so the app uses the median BMR of recent finished days
    as the full-day baseline (`burn.baseline_note` says how many) and adds
    the active calories so far. That is a floor, since activity can still
    rise. A past day with no watch row has no burn and no deficit, never a
    guessed one, and a day with no meals is unlogged rather than zero.

    `arithmetic` is the whole sum as one line; quote it as printed.
    `standing` is the app's own word for where the deficit sits against the
    target (met, close, short, over, far_over); report it as that word, not
    as praise or blame. Default window is the trailing 28 days. `summary`
    carries the rolling 7- and 28-day mean deficit over finished, logged
    days only, ending yesterday, each with its standing.
    """
    return await _get("/api/calories", **{"from": from_date, "to": to_date})


@mcp.tool(annotations=READ_ONLY)
async def calories_settings() -> dict[str, Any]:
    """The daily deficit target in kcal the Calories page measures each day
    against (500 until one is set), and whether that is the default."""
    return await _get("/api/calories/settings")


# --- Weeks and habits -----------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def weeks(from_date: str | None = None, to_date: str | None = None) -> dict[str, Any]:
    """Week headers as the notebook writes them: week number, bodyweight,
    cumulative activities per week, and the header note."""
    return await _get("/api/weeks", **{"from": from_date, "to": to_date})


@mcp.tool(annotations=READ_ONLY)
async def week(start_date: str) -> dict[str, Any]:
    """One week's header: week number, bodyweight, cumulative activities per
    week, and the header note. `start_date` is that week's Monday. 404 when
    the notebook has no header for that week."""
    return await _get(f"/api/weeks/{start_date}")


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


# --- Weather ----------------------------------------------------------------


@mcp.tool(annotations=READ_ONLY)
async def weather_hourly(hours: int = 24) -> dict[str, Any]:
    """The forecast for the next `hours` hours (1 to 48), starting with the
    hour in progress, for the one place set in the app's configuration, from
    Open-Meteo. Each hour: temperature and feels-like, chance of rain (%) and
    amount, wind and gusts, a summary word, and whether it is daylight.
    `today` and `tomorrow` carry the high, low, sunrise and sunset.
    `headline.text` is the stretch in one sentence, worded on the National
    Weather Service's scale for a probability (each hour's `precip_level`:
    dry, slight, chance, likely, certain); quote it as printed. `temp_band`
    names each temperature's band, listed with its range in `bands`.

    A forecast, not the record: nothing here is stored. `units` names the
    units every figure is in; `fetched_at` says when it was fetched and
    `stale: true` means the latest fetch failed and an older forecast is being
    served. `configured: false` means no place is set — say so rather than
    guessing a location. For the weather during a past activity, use the
    Garmin MCP's per-activity weather instead."""
    return await _get("/api/weather/hourly", hours=hours)


@mcp.tool(annotations=READ_ONLY)
async def weather_daily(from_date: str | None = None, to_date: str | None = None) -> dict[str, Any]:
    """The daily forecast for a window (default today and the six days after
    it; at most 31 days): high and low, feels-like, the highest chance of rain
    and the day's total, wind and gusts, sunrise and sunset, and a summary
    word.

    Every date in the window is a row. `status` is `forecast`, `past` (the day
    has gone by; no figures) or `beyond` (further ahead than the 16-day
    forecast reaches; no figures). `outlook: true` marks a day seven or more
    days out — report it as a rough guide, not a forecast to plan on.
    `temp_band` and `precip_level` are the same readings the hourly tool
    carries.
    `configured: false` means no place is set."""
    return await _get("/api/weather/daily", **{"from": from_date, "to": to_date})


# --- Resources: what the fields mean ---------------------------------------
#
# The data map indexes every field to the surfaces that read it and the traps
# each has caused; the brief holds the design rules. A client that reads
# these reasons about the record the way the app does.

_DOCS = Path(__file__).resolve().parents[2] / "docs"


@mcp.resource("ledger://docs/data-map", mime_type="text/markdown")
def data_map() -> str:
    """docs/DATA-MAP.md — every field, the surfaces that read it, the traps."""
    return (_DOCS / "DATA-MAP.md").read_text(encoding="utf-8")


@mcp.resource("ledger://docs/brief", mime_type="text/markdown")
def brief() -> str:
    """docs/BRIEF.md — what the app is for and the rules it is built on."""
    return (_DOCS / "BRIEF.md").read_text(encoding="utf-8")


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

