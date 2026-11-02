"""Is the nightly sync actually working?

BRIEF §12 makes `sync_log` the only debugging surface, and that was taken too
literally: the nightly job failed on its very first run — Garmin had never been
authenticated — wrote a row saying so, and nothing ever surfaced it. A job that
fails silently for months is how a training log quietly stops being a record.

This module turns that table into one answerable question: is sync healthy,
and if not, what is the next action.
"""

from __future__ import annotations

import os
import sqlite3
from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from ledger.db import queries as q

#: A pull is considered stale once the nightly job has missed roughly two runs.
STALE_AFTER_HOURS = 48

#: Endpoints that mean "real data was fetched", not just "a call was made".
DATA_ENDPOINTS = ("get_activities_by_date",)


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        parsed = datetime.fromisoformat(ts)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def tokens_present(token_dir: Path) -> bool:
    """garth writes its OAuth tokens here. Empty means never logged in."""
    return token_dir.is_dir() and any(token_dir.iterdir())


def build_status(
    conn: sqlite3.Connection,
    token_dir: Path,
    *,
    running: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    rows = q.recent_sync_log(conn, limit=200)

    last_run = _parse(rows[0]["ran_at"]) if rows else None
    last_ok = next(
        (
            _parse(r["ran_at"])
            for r in rows
            if r["status"] == "ok" and r["endpoint"] in DATA_ENDPOINTS
        ),
        None,
    )
    last_error = next(
        (r for r in rows if r["status"] in ("error", "rate_limited")), None
    )

    authenticated = tokens_present(token_dir)
    hours_since_ok = (now - last_ok).total_seconds() / 3600 if last_ok else None

    if running:
        state = "running"
    elif not authenticated:
        state = "not_authenticated"
    elif last_ok is None:
        state = "never_succeeded"
    elif hours_since_ok is not None and hours_since_ok > STALE_AFTER_HOURS:
        state = "stale"
    else:
        state = "ok"

    return {
        "state": state,
        "healthy": state in ("ok", "running"),
        "authenticated": authenticated,
        "running": running,
        "last_run": last_run.isoformat() if last_run else None,
        "last_success": last_ok.isoformat() if last_ok else None,
        "hours_since_success": round(hours_since_ok, 1) if hours_since_ok is not None else None,
        "stale_after_hours": STALE_AFTER_HOURS,
        "last_error": (
            {
                "at": last_error["ran_at"],
                "endpoint": last_error["endpoint"],
                "status": last_error["status"],
                "detail": last_error["detail"],
            }
            if last_error
            else None
        ),
        "next_action": _next_action(state),
    }


def _next_action(state: str) -> str | None:
    """What the user has to do, in their words, not the library's."""
    return {
        "not_authenticated": (
            "Garmin has never been authenticated. Put real credentials in .env, "
            "then run: docker compose run --rm cli ledger garmin-login "
            "(interactive — it may ask for an MFA code)."
        ),
        "never_succeeded": (
            "Tokens exist but no activity pull has ever succeeded. Check the last "
            "error, then re-run: docker compose run --rm cli ledger garmin-login"
        ),
        "stale": (
            "No successful pull recently. Tokens may have expired — re-run: "
            "docker compose run --rm cli ledger garmin-login"
        ),
    }.get(state)


def recent_log(conn: sqlite3.Connection, limit: int = 50) -> list[dict[str, Any]]:
    return [
        {
            "at": r["ran_at"],
            "endpoint": r["endpoint"],
            "status": r["status"],
            "date_range": r["date_range"],
            "detail": r["detail"],
        }
        for r in q.recent_sync_log(conn, limit=limit)
    ]


def morning_schedule(
    conn: sqlite3.Connection,
    today: date | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """The morning pull's window, read from the same variables the cron
    sidecar reads, and where today stands in it: waiting (the watch has not
    uploaded the night), settling (it has; still reading), settled (done)."""
    from ledger.garmin.sync import morning_state_for

    env = os.environ if env is None else env
    start = int(env.get("LEDGER_MORNING_FROM", "4"))
    until = int(env.get("LEDGER_MORNING_UNTIL", "14"))
    return {
        "from": f"{start:02d}:00",
        "until": f"{until:02d}:00",
        "every_min": int(env.get("LEDGER_MORNING_EVERY_MIN", "15")),
        "today": morning_state_for(conn, (today or date.today()).isoformat()),
    }


def next_scheduled(hour: int, now: datetime | None = None) -> str:
    """When the cron sidecar will next fire, so the UI need not guess."""
    now = now or datetime.now()
    nxt = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if nxt <= now:
        nxt += timedelta(days=1)
    return nxt.isoformat(timespec="minutes")
