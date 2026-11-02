"""FastAPI app: serves the PWA and the endpoints it syncs against (BRIEF §11).

No authentication, no accounts, no users table — by design. Access control is
the tailnet. Do not add an auth layer here; if this is reachable from the
public internet, that is a deployment bug, not a missing feature.

Phase 0 needs none of this — the CLI and the weekly report stand alone. The
endpoints below are the minimum the Phase 1 PWA will push into, kept small on
purpose.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from ledger import leagues
from ledger.config import load_config
from ledger.core import load as load_mod
from ledger.db import queries as q
from ledger.db.schema import connect, open_db, transaction
from ledger.entry import VALID_KINDS
from ledger.garmin import status
from ledger.report import (
    calories, dashboard, habits, history, plan, ramp, timeframe, views, weekly,
)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

cfg = load_config()


def get_db() -> Iterator[sqlite3.Connection]:
    """One connection per request, owned by that request start to finish.

    Two thread traps live here, and both only surface under concurrency:

    1. A shared connection raises ProgrammingError as soon as a request lands
       on a different threadpool worker. Hence per request.
    2. Even per request, FastAPI runs this generator's setup and its teardown
       as *separate* threadpool jobs, so `close()` usually runs on a different
       thread than `connect()`. Hence `same_thread=False`.

    Opening per request is cheap; WAL plus busy_timeout (both set in connect())
    is what keeps concurrent readers safe.
    """
    conn = connect(cfg.db_path, same_thread=False)
    try:
        yield conn
    finally:
        conn.close()


DB = Annotated[sqlite3.Connection, Depends(get_db)]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Migrate once at startup, on this thread, then let go of the connection.
    open_db(cfg.db_path).close()
    yield


app = FastAPI(title="Ledger", lifespan=lifespan)

#: Files that must never be served from a browser cache. `sw.js` is the worst
#: offender: a cached service worker keeps serving an old build long after the
#: server has moved on, and a hard reload does not clear it. The shell is here
#: too so a stale index.html cannot pin the app to old module URLs.
NEVER_CACHE = {"/", "/index.html", "/sw.js", "/manifest.json"}


@app.middleware("http")
async def cache_headers(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path in NEVER_CACHE:
        response.headers["Cache-Control"] = "no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    elif path.endswith((".js", ".css", ".svg")):
        # Revalidate every time, but allow a 304 when nothing changed.
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "db": str(cfg.db_path)}


@app.get("/api/exercises")
def exercises(conn: DB) -> list[dict[str, Any]]:
    """Feeds the PWA's fuzzy search. Small enough to send whole."""
    return [dict(r) for r in q.list_exercises(conn)]


@app.get("/api/exercises/{exercise_id}/last")
def last_sets(exercise_id: int, conn: DB) -> list[dict[str, Any]]:
    """Previous session's sets — the PWA pre-fills from this (BRIEF §10)."""
    return [
        {"weight": s.weight, "reps": s.reps, "rpe": s.rpe, "is_warmup": s.is_warmup}
        for s in q.last_session_sets(conn, exercise_id)
    ]


def _parsed_from_payload(payload: dict[str, Any]):
    """Build a ParsedSession from the structured entry form's JSON."""
    from ledger.entry import ParsedExercise, ParsedSession, ParsedSet

    session = ParsedSession(
        date=str(payload["date"]),
        kind=str(payload.get("kind", "lift")),
        rpe=payload.get("rpe"),
        duration_min=payload.get("duration_min"),
        started_at=payload.get("started_at"),
        notes=payload.get("notes"),
        distance_km=payload.get("distance_km"),
        detail={k: v for k, v in (payload.get("detail") or {}).items() if v is not None},
        exercises=[
            ParsedExercise(
                name=str(e["name"]),
                sets=[
                    ParsedSet(
                        weight_kg=float(s["weight"]),
                        reps=int(s["reps"]),
                        rpe=s.get("rpe"),
                        is_warmup=bool(s.get("is_warmup", False)),
                    )
                    for s in e.get("sets", [])
                ],
            )
            for e in payload.get("exercises", [])
        ],
    )
    if session.kind not in VALID_KINDS:
        raise ValueError(f"unknown kind {session.kind!r}")
    if session.rpe is not None and not 0 <= float(session.rpe) <= 10:
        raise ValueError("rpe must be 0-10")
    date.fromisoformat(session.date)  # raises on a malformed date
    return session


def _session_out(conn: sqlite3.Connection, session_id: int) -> dict[str, Any]:
    row = q.session_by_id(conn, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="no such session")
    return views.session_dict(row)


@app.post("/api/parse")
def parse_preview(payload: dict[str, Any]) -> dict[str, Any]:
    """Parse notebook shorthand and show what WOULD be saved. Writes nothing.

    Backs the live preview on the text entry path — the point is that nothing
    is committed until the user has seen it rendered back.
    """
    from ledger.entry import EntryError, parse_entry, parse_weeks

    text = str(payload.get("text") or "")
    try:
        sessions = parse_entry(text)
        weeks = parse_weeks(text)
    except EntryError as exc:
        return {"sessions": [], "weeks": [], "error": str(exc)}

    return {
        "error": None,
        "weeks": [
            {
                "start_date": w.start_date,
                "week_number": w.week_number,
                "bodyweight_lbs": w.bodyweight_lbs,
                "avg_activities_per_week": w.avg_activities_per_week,
                "notes": w.notes,
            }
            for w in weeks
        ],
        "sessions": [
            {
                "date": s.date,
                "kind": s.kind,
                "rpe": s.rpe,
                "duration_min": s.duration_min,
                "distance_km": s.distance_km,
                "pace_s_per_km": s.pace_s_per_km,
                "started_at": s.started_at,
                "notes": s.notes,
                "detail": s.detail,
                "load": load_mod.session_load(s.rpe, s.duration_min),
                "exercises": [
                    {"name": e.name, "sets": len(e.sets)} for e in s.exercises
                ],
            }
            for s in sessions
        ],
    }


@app.post("/api/sessions")
def create_session(payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """Create a session, from either the structured form or shorthand text.

    Both paths converge on the same ParsedSession and the same save_session(),
    so PR detection runs in exactly one place (BRIEF §6).
    """
    from ledger.entry import EntryError, parse_entry, parse_weeks
    from ledger.ingest import save_session, save_week

    created: list[int] = []
    all_hits: list[Any] = []

    try:
        if payload.get("text"):
            text = str(payload["text"])
            for week in parse_weeks(text):
                save_week(conn, week)
            parsed_list = parse_entry(text)
            if not parsed_list and not payload.get("allow_empty"):
                raise ValueError("nothing to save")
        else:
            parsed_list = [_parsed_from_payload(payload)]

        for parsed in parsed_list:
            session_id, hits = save_session(conn, parsed)
            created.append(session_id)
            all_hits.extend(hits)
    except (EntryError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "session_id": created[0] if created else None,
        "session_ids": created,
        "session": _session_out(conn, created[0]) if created else None,
        "prs": [
            {"kind": h.kind, "value": h.value, "context": h.context} for h in all_hits
        ],
    }


@app.patch("/api/sessions/{session_id}")
def edit_session(session_id: int, payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """Patch a session, then re-score it so stale PRs cannot survive an edit."""
    from ledger.ingest import rescore_session

    if q.session_by_id(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="no such session")

    fields = dict(payload)
    if "detail" in fields and isinstance(fields["detail"], dict):
        fields["detail"] = json.dumps(fields["detail"], sort_keys=True)
    if fields.get("rpe") is not None and not 0 <= float(fields["rpe"]) <= 10:
        raise HTTPException(status_code=422, detail="rpe must be 0-10")
    if fields.get("kind") and fields["kind"] not in VALID_KINDS:
        raise HTTPException(status_code=422, detail=f"unknown kind {fields['kind']!r}")

    try:
        with transaction(conn):
            q.update_session(conn, session_id, fields)
        rescore_session(conn, session_id)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {"ok": True, "session": _session_out(conn, session_id)}


@app.delete("/api/sessions/{session_id}")
def remove_session(session_id: int, conn: DB) -> dict[str, Any]:
    if q.session_by_id(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="no such session")
    with transaction(conn):
        q.delete_session(conn, session_id)
    return {"ok": True}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: int, conn: DB) -> dict[str, Any]:
    return _session_out(conn, session_id)


def _week_out(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "start_date": r["start_date"],
        "week_number": r["week_number"],
        "bodyweight_lbs": r["bodyweight_lbs"],
        "avg_activities_per_week": r["avg_activities_per_week"],
        "notes": r["notes"],
    }


@app.get("/api/weeks")
def list_weeks(
    conn: DB, from_: str | None = Query(None, alias="from"), to: str | None = None
) -> dict[str, Any]:
    """Notebook page headers. Written via shorthand; now readable back.

    Without this, week notes were write-only and the UI had to mirror them in
    localStorage — which is wrong the moment a second device opens the app.
    """
    rows = q.weeks_between(conn, from_ or "0000-01-01", to or "9999-12-31")
    return {"weeks": [_week_out(r) for r in rows]}


@app.get("/api/weeks/{start_date}")
def get_week(start_date: str, conn: DB) -> dict[str, Any]:
    row = q.week_row(conn, start_date)
    if row is None:
        raise HTTPException(status_code=404, detail="no such week")
    return _week_out(row)


@app.put("/api/weeks/{start_date}")
def put_week(start_date: str, payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """Upsert a week header. Absent fields are left alone, not blanked."""
    from ledger.ingest import save_week

    try:
        date.fromisoformat(start_date)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="start_date must be YYYY-MM-DD") from exc

    from ledger.entry import ParsedWeek

    save_week(
        conn,
        ParsedWeek(
            start_date=start_date,
            week_number=payload.get("week_number"),
            bodyweight_lbs=payload.get("bodyweight_lbs"),
            avg_activities_per_week=payload.get("avg_activities_per_week"),
            notes=payload.get("notes"),
        ),
    )
    row = q.week_row(conn, start_date)
    return {"ok": True, "week": _week_out(row) if row else None}


@app.get("/api/weeks/{start_date}/notes")
def get_week_notes(start_date: str, conn: DB) -> dict[str, Any]:
    return {"notes": ramp.week_notes(conn, start_date)}


@app.post("/api/weeks/{start_date}/notes")
def add_week_note(start_date: str, payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="text is required")
    with transaction(conn):
        note_id = q.add_week_note(conn, start_date, text)
    return {"ok": True, "id": note_id, "notes": ramp.week_notes(conn, start_date)}


@app.patch("/api/notes/{note_id}")
def edit_week_note(note_id: int, payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    row = q.week_note_by_id(conn, note_id)
    if row is None:
        raise HTTPException(status_code=404, detail="no such note")
    if "text" in payload and not str(payload["text"]).strip():
        raise HTTPException(status_code=422, detail="text cannot be blank")
    with transaction(conn):
        q.update_week_note(conn, note_id, **payload)
    return {"ok": True, "notes": ramp.week_notes(conn, row["week_start"])}


@app.delete("/api/notes/{note_id}")
def remove_week_note(note_id: int, conn: DB) -> dict[str, Any]:
    row = q.week_note_by_id(conn, note_id)
    if row is None:
        raise HTTPException(status_code=404, detail="no such note")
    with transaction(conn):
        q.delete_week_note(conn, note_id)
    return {"ok": True, "notes": ramp.week_notes(conn, row["week_start"])}


# --- habits ----------------------------------------------------------------
#
# Habits are not sessions and never become them: nothing here writes to
# `session`, so a tick cannot reach the activities-per-week figure, the load
# scale or the log. See migrations/011_habits.sql for why that line is drawn
# where it is.


def _iso_or_422(value: str, field: str = "date") -> str:
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{field} must be YYYY-MM-DD") from exc
    return value


def _habit_or_404(conn: sqlite3.Connection, key: str) -> sqlite3.Row:
    row = q.habit_by_key(conn, key)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no habit {key!r}")
    return row


def _habit_window(from_: str | None, to: str | None) -> tuple[str, str]:
    """Default to the week containing today, which is what most callers want.

    A given end is honoured exactly; a missing one is filled from the other so
    the window is always a real span. A silent fallback to "everything" would
    leave the page's denominators wrong rather than absent, which is worse.
    """
    if from_ is None and to is None:
        today = date.today()
        monday = today - timedelta(days=today.weekday())
        return monday.isoformat(), (monday + timedelta(days=6)).isoformat()
    start = _iso_or_422(from_, "from") if from_ else None
    end = _iso_or_422(to, "to") if to else None
    if start is None:
        start = (date.fromisoformat(end) - timedelta(days=27)).isoformat()
    if end is None:
        end = (date.fromisoformat(start) + timedelta(days=27)).isoformat()
    if end < start:
        raise HTTPException(status_code=422, detail="to must not precede from")
    return start, end


@app.get("/api/habits")
def get_habits(
    conn: DB,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    include_archived: bool = False,
) -> dict[str, Any]:
    """Every habit and every day in the window, with what each day was worth."""
    start, end = _habit_window(from_, to)
    return habits.build(conn, start, end, include_archived=include_archived)


@app.get("/api/habits/trend")
def habits_trend(conn: DB, weeks: int = 12, include_archived: bool = False) -> dict[str, Any]:
    """Weekly totals per habit, for the last `weeks` weeks.

    Declared before `/api/habits/{key}/{day}` so "trend" is not parsed as a
    habit key — FastAPI matches routes in definition order and a literal path
    that follows a parameterised one is unreachable.
    """
    return habits.trend(conn, weeks=max(4, min(52, weeks)),
                        include_archived=include_archived)


@app.put("/api/habits/{key}/{day}")
def mark_habit(
    key: str,
    day: str,
    payload: dict[str, Any],
    conn: DB,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
) -> dict[str, Any]:
    """Mark or unmark one day.

    A manual habit takes `{"done": true|false}`; false clears the day rather
    than storing a zero, because for a tapped habit those are the same fact and
    one row per marked day is the smaller thing to reason about.

    A measured habit takes `{"value": <number>}` to override what the sync
    recorded, or `{"value": null}` to hand the day back to it. `done` is
    refused by name on a measured habit rather than quietly ignored: the number
    decides the tick, and accepting a tap that changes nothing would be a
    control that lies.

    The response rebuilds whichever window the caller passes in `from`/`to` —
    the one it is displaying — so the page repaints from the server's own
    resolution instead of guessing what its tap did. Defaulting to the marked
    day alone keeps the reply small when nobody asks for more.
    """
    _iso_or_422(day)
    habit = _habit_or_404(conn, key)
    if habit["archived_at"] is not None:
        raise HTTPException(status_code=409, detail=f"habit {key!r} is archived")

    if habit["mode"] == "manual":
        if "done" not in payload:
            raise HTTPException(status_code=422, detail="done is required")
        done = bool(payload["done"])
        with transaction(conn):
            if done:
                q.mark_habit_day(conn, habit["id"], day, done=True)
            else:
                q.clear_habit_day(conn, habit["id"], day)
    else:
        if "done" in payload:
            raise HTTPException(
                status_code=422,
                detail=f"{key!r} is measured, not tapped - send a value, not done",
            )
        if "value" not in payload:
            raise HTTPException(status_code=422, detail="value is required")
        raw = payload["value"]
        if raw is None:
            with transaction(conn):
                q.clear_habit_day(conn, habit["id"], day)
        else:
            try:
                value = float(raw)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=422, detail="value must be a number") from exc
            if value < 0:
                raise HTTPException(status_code=422, detail="value must not be negative")
            with transaction(conn):
                q.mark_habit_day(conn, habit["id"], day, value=value)

    start, end = (from_, to) if (from_ or to) else (day, day)
    start, end = _habit_window(start, end)
    return {"ok": True, **habits.build(conn, start, end)}


@app.post("/api/habits")
def create_habit(payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """Add a habit. Manual only - a measured one needs a synced field to read."""
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")

    key = str(payload.get("key") or "").strip().lower()
    if not key:
        key = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    if not re.fullmatch(r"[a-z0-9_]{1,40}", key):
        raise HTTPException(
            status_code=422,
            detail="key must be lower-case letters, digits and underscores",
        )
    if q.habit_by_key(conn, key) is not None:
        raise HTTPException(status_code=409, detail=f"habit {key!r} already exists")

    polarity = payload.get("polarity") or "do"
    if polarity not in ("do", "avoid"):
        raise HTTPException(status_code=422, detail="polarity must be 'do' or 'avoid'")

    with transaction(conn):
        q.add_habit(conn, key, name, mode="manual", polarity=polarity)
    today = date.today().isoformat()
    return {"ok": True, "key": key, **habits.build(conn, today, today)}


@app.patch("/api/habits/{key}")
def edit_habit(key: str, payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """Rename, retarget, or archive.

    Archiving rather than deleting: a habit you stop keeping must not rewrite
    the weeks you did keep it. `{"archived": false}` brings it back.
    """
    habit = _habit_or_404(conn, key)
    fields: dict[str, Any] = {}

    if "name" in payload:
        name = str(payload["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="name cannot be blank")
        fields["name"] = name

    for num in ("target", "partial_at"):
        if num in payload:
            if habit["mode"] != "metric":
                raise HTTPException(
                    status_code=422, detail=f"{key!r} is not measured - it has no {num}"
                )
            try:
                fields[num] = None if payload[num] is None else float(payload[num])
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=422, detail=f"{num} must be a number") from exc

    if "archived" in payload:
        fields["archived_at"] = (
            datetime.now(UTC).isoformat(timespec="seconds") if payload["archived"] else None
        )

    if not fields:
        raise HTTPException(status_code=422, detail="nothing to change")

    target = fields.get("target", habit["target"])
    floor = fields.get("partial_at", habit["partial_at"])
    if target is not None and floor is not None and floor > target:
        raise HTTPException(status_code=422, detail="partial_at must not exceed target")

    with transaction(conn):
        q.update_habit(conn, habit["id"], **fields)
    today = date.today().isoformat()
    return {"ok": True, **habits.build(conn, today, today, include_archived=True)}


@app.get("/api/distance")
def distance_ramp(
    conn: DB,
    weeks: int = 26,
    week_of: str | None = None,
    soccer_km_per_match: float | None = None,
) -> dict[str, Any]:
    """Week-over-week distance on foot, with the usual progression guide."""
    end = date.fromisoformat(week_of) if week_of else None
    return ramp.build(
        conn, end, weeks=max(4, min(104, weeks)),
        soccer_km_per_match=soccer_km_per_match,
    )


@app.get("/api/plan/distance")
def plan_distance(
    conn: DB,
    pct: float = 10.0,
    weeks: int = 8,
    deload_every: int = 4,
    base_km: float | None = None,
    week_of: str | None = None,
) -> dict[str, Any]:
    """Project weekly distance forward at a chosen ramp.

    The projection lives here rather than in the browser so the planner and
    the ramp panel can never disagree — that has already gone wrong three
    times with the activities-per-week figure.
    """
    end = date.fromisoformat(week_of) if week_of else None
    return plan.build(
        conn, pct=pct, weeks=weeks, deload_every=deload_every,
        base_km=base_km, end=end,
    )


@app.get("/api/plan/locked")
def plan_locked(conn: DB, week_of: str | None = None) -> dict[str, Any]:
    """The committed plan, each week beside what actually happened."""
    return plan.locked(conn, end=date.fromisoformat(week_of) if week_of else None)


@app.post("/api/plan/lock")
def plan_lock(
    conn: DB,
    pct: float = 10.0,
    weeks: int = 8,
    deload_every: int = 4,
    base_km: float | None = None,
    week_of: str | None = None,
) -> dict[str, Any]:
    """Commit the projection so its targets stop moving.

    Same parameters as the projection above — this stores that exact answer.
    Locking covers the week being lived and the ones after it; weeks already
    locked and already past are never rewritten, so a target you set and then
    missed stays on the record.
    """
    end = date.fromisoformat(week_of) if week_of else None
    return plan.lock(
        conn, pct=pct, weeks=weeks, deload_every=deload_every,
        base_km=base_km, end=end,
    )


@app.delete("/api/plan/lock")
def plan_unlock(conn: DB, from_week: str | None = None) -> dict[str, Any]:
    """Drop the committed plan. `from_week` keeps everything before it."""
    return {"cleared": q.clear_plan_weeks(conn, from_week)}


# --- the rest of the plan: intent, day split, goal ---------------------------
#
# The committed distance ramp above was always on the server. The planned
# counts per kind, the day-by-day split and the goal weight lived in one
# browser's localStorage until migration 017, which is why a plan written at
# a desk was missing on the phone. These endpoints are that half of the page.
# Every PUT returns the row as stored, so the page repaints from the server's
# own answer rather than from what it sent.

#: The most of one kind a week can plan for. Three a day.
MAX_PLANNED_PER_KIND = 21
GOAL_WEIGHT_KEY = "goal_weight_lb"


def _monday_or_422(value: str, field: str = "week_start") -> str:
    day = date.fromisoformat(_iso_or_422(value, field))
    if day.weekday() != 0:
        raise HTTPException(status_code=422, detail=f"{field} must be a Monday")
    return value


def _plan_window(from_: str | None, to: str | None) -> tuple[str | None, str | None]:
    start = _iso_or_422(from_, "from") if from_ else None
    end = _iso_or_422(to, "to") if to else None
    if start and end and end < start:
        raise HTTPException(status_code=422, detail="to must not precede from")
    return start, end


def _intent_or_422(payload: dict[str, Any]) -> tuple[dict[str, int], str]:
    raw = payload.get("kinds") or {}
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail="kinds must be an object of kind -> count")
    kinds: dict[str, int] = {}
    for kind, count in raw.items():
        if kind not in VALID_KINDS:
            raise HTTPException(status_code=422, detail=f"unknown kind {kind!r}")
        try:
            n = int(count)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=422, detail=f"{kind}: count must be a whole number"
            ) from exc
        if n < 0 or n > MAX_PLANNED_PER_KIND:
            raise HTTPException(
                status_code=422, detail=f"{kind}: count must be 0-{MAX_PLANNED_PER_KIND}"
            )
        if n:
            kinds[kind] = n
    note = payload.get("note") or ""
    if not isinstance(note, str):
        raise HTTPException(status_code=422, detail="note must be text")
    note = note.strip()
    if len(note) > 500:
        raise HTTPException(status_code=422, detail="note must be 500 characters or fewer")
    return kinds, note


def _in_week_or_422(day: str, week_start: str, field: str) -> str:
    _iso_or_422(day, field)
    end = (date.fromisoformat(week_start) + timedelta(days=6)).isoformat()
    if not week_start <= day <= end:
        raise HTTPException(
            status_code=422, detail=f"{field}: {day} is not in the week of {week_start}"
        )
    return day


def _days_or_422(payload: dict[str, Any], week_start: str) -> tuple[dict[str, float], list[str]]:
    raw_km = payload.get("km") or {}
    if not isinstance(raw_km, dict):
        raise HTTPException(status_code=422, detail="km must be an object of date -> km")
    km: dict[str, float] = {}
    for day, value in raw_km.items():
        _in_week_or_422(str(day), week_start, "km")
        if value is None:
            continue
        try:
            n = float(value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=f"km on {day} must be a number") from exc
        if n < 0 or n > 200:
            raise HTTPException(status_code=422, detail=f"km on {day} must be 0-200")
        km[str(day)] = round(n, 2)
    raw_match = payload.get("match") or []
    if not isinstance(raw_match, list):
        raise HTTPException(status_code=422, detail="match must be a list of dates")
    match = sorted({_in_week_or_422(str(d), week_start, "match") for d in raw_match})
    return km, match


@app.get("/api/plan/intent")
def plan_intent(
    conn: DB,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
) -> dict[str, Any]:
    """Planned counts per kind, one row per week that has its own plan.

    Only weeks written explicitly are here. A week with no row inherits the
    most recent earlier one on the page; this endpoint reports what was
    written, not what applies.
    """
    start, end = _plan_window(from_, to)
    return {"plans": q.plan_intents(conn, start, end)}


@app.put("/api/plan/intent/{week_start}")
def put_plan_intent(week_start: str, payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """Write one week's planned counts: `{"kinds": {"run": 3}, "note": ""}`.

    Zero counts are dropped. Nothing planned and no note deletes the row, so
    a cleared week goes back to inheriting rather than storing an empty plan.
    """
    _monday_or_422(week_start)
    kinds, note = _intent_or_422(payload)
    with transaction(conn):
        if not kinds and not note:
            q.delete_plan_intent(conn, week_start)
            return {"ok": True, "week_start": week_start, "plan": None}
        q.put_plan_intent(conn, week_start, kinds, note)
    return {"ok": True, "week_start": week_start,
            "plan": q.plan_intents(conn, week_start, week_start)[0]}


@app.delete("/api/plan/intent/{week_start}")
def delete_plan_intent(week_start: str, conn: DB) -> dict[str, Any]:
    _monday_or_422(week_start)
    with transaction(conn):
        n = q.delete_plan_intent(conn, week_start)
    return {"ok": True, "week_start": week_start, "deleted": n}


@app.get("/api/plan/days")
def plan_days(
    conn: DB,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
) -> dict[str, Any]:
    """How each planned week's distance is spread over its days.

    `km` is date -> planned kilometres; `match` is the days the user marked
    as match days themselves (published fixtures are on `/api/leagues`).
    """
    start, end = _plan_window(from_, to)
    return {"weeks": q.plan_days_rows(conn, start, end)}


@app.put("/api/plan/days/{week_start}")
def put_plan_days(week_start: str, payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """Write one week's day split: `{"km": {date: n}, "match": [dates]}`.

    Every date must fall inside the week. An empty split deletes the row.
    """
    _monday_or_422(week_start)
    km, match = _days_or_422(payload, week_start)
    with transaction(conn):
        if not km and not match:
            q.delete_plan_days(conn, week_start)
            return {"ok": True, "week_start": week_start, "week": None}
        q.put_plan_days(conn, week_start, km, match)
    return {"ok": True, "week_start": week_start,
            "week": q.plan_days_rows(conn, week_start, week_start)[0]}


@app.delete("/api/plan/days/{week_start}")
def delete_plan_days(week_start: str, conn: DB) -> dict[str, Any]:
    _monday_or_422(week_start)
    with transaction(conn):
        n = q.delete_plan_days(conn, week_start)
    return {"ok": True, "week_start": week_start, "deleted": n}


def _goal(conn: sqlite3.Connection) -> dict[str, Any]:
    row = q.get_setting(conn, GOAL_WEIGHT_KEY)
    if row is None:
        return {"goal_weight_lb": None, "updated_at": None}
    return {"goal_weight_lb": float(row["value"]), "updated_at": row["updated_at"]}


@app.get("/api/plan/goal")
def plan_goal(conn: DB) -> dict[str, Any]:
    """The goal weight, in pounds, or null when none is set.

    The Scoreboard's bodyweight pillar scores which way the four-week average
    is moving relative to it — never the number itself — and is absent while
    this is null.
    """
    return _goal(conn)


@app.put("/api/plan/goal")
def put_plan_goal(payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """Set the goal weight: `{"lb": 180}`. `{"lb": null}` clears it."""
    if "lb" not in payload:
        raise HTTPException(status_code=422, detail="lb is required")
    raw = payload["lb"]
    with transaction(conn):
        if raw is None:
            q.delete_setting(conn, GOAL_WEIGHT_KEY)
            return {"ok": True, **_goal(conn)}
        try:
            lb = float(raw)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="lb must be a number") from exc
        if not 50 <= lb <= 500:
            raise HTTPException(status_code=422, detail="lb must be between 50 and 500")
        q.set_setting(conn, GOAL_WEIGHT_KEY, repr(round(lb, 1)))
    return {"ok": True, **_goal(conn)}


@app.delete("/api/plan/goal")
def delete_plan_goal(conn: DB) -> dict[str, Any]:
    with transaction(conn):
        q.delete_setting(conn, GOAL_WEIGHT_KEY)
    return {"ok": True, **_goal(conn)}


# --- Calories -------------------------------------------------------------
#
# Intake typed in, burn from Garmin, the arithmetic done once in
# `report/calories.py`. Meals are not sessions and never become them: nothing
# here writes to `session`, so a meal cannot reach the activities-per-week
# figure or the load scale. See migrations/018_calories.sql.

#: Floor between two on-demand pulls of today's burn, successful or not. The
#: page asks only when the stored row is older than `calories.STALE_AFTER_S`,
#: so this is a backstop against a tap-happy thumb, not the pacing rule.
BURN_MIN_INTERVAL_S = 60
_burn_refreshing = False
#: None, not 0.0: a monotonic clock can legitimately read under sixty seconds
#: shortly after boot, and the first pull must never be refused for it.
_burn_last_attempt: float | None = None

MEAL_KCAL_MAX = 5000
MEAL_LABEL_MAX = 40
DEFICIT_TARGET_MAX = 2000


def _calorie_window(from_: str | None, to: str | None) -> tuple[str, str]:
    """Default to the 28 days ending today. A given end is honoured exactly."""
    if from_ is None and to is None:
        today = date.today()
        return (today - timedelta(days=27)).isoformat(), today.isoformat()
    start = _iso_or_422(from_, "from") if from_ else None
    end = _iso_or_422(to, "to") if to else None
    if start is None:
        start = (date.fromisoformat(end) - timedelta(days=27)).isoformat()
    if end is None:
        end = (date.fromisoformat(start) + timedelta(days=27)).isoformat()
    if end < start:
        raise HTTPException(status_code=422, detail="to must not precede from")
    return start, end


def _calorie_day(conn: sqlite3.Connection, day: str) -> dict[str, Any]:
    return calories.build(conn, day, day)["days"][0]


def _day_not_ahead_or_422(day: str) -> str:
    _iso_or_422(day)
    if day > date.today().isoformat():
        raise HTTPException(status_code=422, detail="that day has not happened yet")
    return day


_KCAL_MSG = f"kcal must be a whole number from 1 to {MEAL_KCAL_MAX}"


def _kcal_or_422(raw: Any) -> int:
    if isinstance(raw, bool) or raw is None:
        raise HTTPException(status_code=422, detail=_KCAL_MSG)
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=_KCAL_MSG) from exc
    if value != int(value) or not 1 <= value <= MEAL_KCAL_MAX:
        raise HTTPException(status_code=422, detail=_KCAL_MSG)
    return int(value)


def _label_or_422(raw: Any) -> str:
    label = str(raw or "").strip()
    if len(label) > MEAL_LABEL_MAX:
        raise HTTPException(
            status_code=422, detail=f"label must be {MEAL_LABEL_MAX} characters or fewer"
        )
    return label


def _meal_or_404(conn: sqlite3.Connection, meal_id: int) -> sqlite3.Row:
    row = q.meal_by_id(conn, meal_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no meal {meal_id}")
    return row


def _calorie_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    kcal, is_default, updated_at = calories.deficit_target(conn)
    return {"deficit_target_kcal": kcal, "is_default": is_default, "updated_at": updated_at}


@app.get("/api/calories/settings")
def calorie_settings(conn: DB) -> dict[str, Any]:
    """The daily deficit target in kcal. 500 until one is set.

    Declared before `/api/calories/{day}/...` so "settings" is never read as
    a date.
    """
    return _calorie_settings(conn)


@app.put("/api/calories/settings")
def put_calorie_settings(payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """`{"deficit_target_kcal": 500}`; null goes back to the default."""
    if "deficit_target_kcal" not in payload:
        raise HTTPException(status_code=422, detail="deficit_target_kcal is required")
    raw = payload["deficit_target_kcal"]
    with transaction(conn):
        if raw is None:
            q.delete_setting(conn, calories.DEFICIT_TARGET_KEY)
            return {"ok": True, **_calorie_settings(conn)}
        try:
            value = float(raw)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=422, detail="deficit_target_kcal must be a number"
            ) from exc
        if value != int(value) or not 0 <= value <= DEFICIT_TARGET_MAX:
            raise HTTPException(
                status_code=422,
                detail=f"deficit_target_kcal must be a whole number from 0 to {DEFICIT_TARGET_MAX}",
            )
        q.set_setting(conn, calories.DEFICIT_TARGET_KEY, str(int(value)))
    return {"ok": True, **_calorie_settings(conn)}


def _pull_burn(conn: sqlite3.Connection, day: str) -> list[str]:
    """One paced call to get_stats_and_body for one day, written through the
    same path the nightly uses. Returns the sync's error strings."""
    from ledger.garmin.client import GarminClient
    from ledger.garmin.sync import SyncResult, sync_metrics_for_day

    client = GarminClient(cfg.garmin_token_dir, call_delay_s=cfg.sync_call_delay_s)
    client.resume()
    result = SyncResult()
    sync_metrics_for_day(conn, client, day, result, only=frozenset({"get_stats_and_body"}))
    return result.errors


@app.post("/api/calories/refresh")
def refresh_burn(conn: DB, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Pull today's burn from Garmin now, and return the day rebuilt.

    Synchronous: it is one call and takes a few seconds, and the page wants
    the figure back rather than a job to poll. One in flight at a time, never
    while a full sync runs, and never twice inside `BURN_MIN_INTERVAL_S`.
    """
    global _burn_refreshing, _burn_last_attempt
    from ledger.garmin.client import GarminAuthError, GarminRateLimited

    day = (payload or {}).get("day") or date.today().isoformat()
    _day_not_ahead_or_422(day)

    if _sync_running or _burn_refreshing:
        raise HTTPException(status_code=409, detail="a Garmin sync is already running")
    if not status.tokens_present(cfg.garmin_token_dir):
        raise HTTPException(
            status_code=409,
            detail=(
                "Garmin has never been authenticated. Run "
                "`docker compose run --rm cli ledger garmin-login` once — it is "
                "interactive and may ask for an MFA code."
            ),
        )
    now = time.monotonic()
    if _burn_last_attempt is not None and now - _burn_last_attempt < BURN_MIN_INTERVAL_S:
        raise HTTPException(
            status_code=429,
            detail=f"pulled {int(now - _burn_last_attempt)} s ago; wait a minute",
        )

    _burn_refreshing = True
    _burn_last_attempt = now
    try:
        errors = _pull_burn(conn, day)
    except GarminAuthError as exc:
        raise HTTPException(status_code=409, detail=f"Garmin login failed: {exc}") from exc
    except GarminRateLimited as exc:
        raise HTTPException(status_code=503, detail=f"Garmin is rate limiting: {exc}") from exc
    finally:
        _burn_refreshing = False
    return {"ok": True, "refreshed": not errors, "day": _calorie_day(conn, day), "errors": errors}


@app.get("/api/calories")
def get_calories(
    conn: DB,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
) -> dict[str, Any]:
    """Every day in the window: meals, intake, burn, deficit, the arithmetic."""
    start, end = _calorie_window(from_, to)
    return calories.build(conn, start, end)


@app.post("/api/calories/{day}/meals")
def add_meal(day: str, payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """`{"kcal": 700, "label": "breakfast"}`. The day comes back rebuilt."""
    _day_not_ahead_or_422(day)
    kcal = _kcal_or_422(payload.get("kcal"))
    label = _label_or_422(payload.get("label"))
    with transaction(conn):
        meal_id = q.add_meal(conn, day, kcal, label)
    day_out = _calorie_day(conn, day)
    meal = next(m for m in day_out["meals"] if m["id"] == meal_id)
    return {"ok": True, "meal": meal, "day": day_out}


@app.patch("/api/meals/{meal_id}")
def edit_meal(meal_id: int, payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """Change the number, the label, or the day a meal belongs to."""
    row = _meal_or_404(conn, meal_id)
    fields: dict[str, Any] = {}
    if "kcal" in payload:
        fields["kcal"] = _kcal_or_422(payload["kcal"])
    if "label" in payload:
        fields["label"] = _label_or_422(payload["label"])
    if "date" in payload:
        fields["date"] = _day_not_ahead_or_422(str(payload["date"] or ""))
    if not fields:
        raise HTTPException(status_code=422, detail="nothing to change")
    with transaction(conn):
        q.update_meal(conn, meal_id, **fields)
    day = fields.get("date", row["date"])
    day_out = _calorie_day(conn, day)
    meal = next(m for m in day_out["meals"] if m["id"] == meal_id)
    return {"ok": True, "meal": meal, "day": day_out}


@app.delete("/api/meals/{meal_id}")
def delete_meal(meal_id: int, conn: DB) -> dict[str, Any]:
    row = _meal_or_404(conn, meal_id)
    with transaction(conn):
        n = q.delete_meal(conn, meal_id)
    return {"ok": True, "deleted": n, "day": _calorie_day(conn, row["date"])}


#: How old the stored leagues may get before a plain GET refreshes them behind
#: the response. Six hours puts a Monday-night scoreline on the page the next
#: time it is opened, without re-scraping somebody else's site on every visit.
LEAGUE_MAX_AGE_S = 6 * 3600

#: Floor between two scrape attempts, successful or not. refresh_all() absorbs
#: a per-league failure, which leaves fetched_at untouched — so without this, a
#: league page that 404s the day a session ends would be re-fetched on every
#: single app open, forever.
LEAGUE_MIN_INTERVAL_S = 3600

_league_refreshing = False
#: None means "not since this process started", which is not the same as zero.
#: time.monotonic() counts from boot, so on a container started minutes ago a
#: 0.0 sentinel reads as "attempted 60 seconds ago" and suppresses the very
#: first refresh for an hour — exactly when the data is most likely stale.
_league_last_attempt: float | None = None


def _league_age_s(conn: sqlite3.Connection) -> float | None:
    """Seconds since the least recently fetched league.

    None when nothing is stored at all, which is treated as stale below: a
    first run should populate itself rather than sit empty until the CLI is
    run by hand.
    """
    row = conn.execute("SELECT MIN(fetched_at) AS oldest FROM league").fetchone()
    oldest = row["oldest"] if row else None
    if not oldest:
        return None
    try:
        ts = datetime.fromisoformat(oldest)
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    return (datetime.now(UTC) - ts).total_seconds()


def _run_league_refresh() -> None:
    """Background scrape. Opens its own connection — the request's is long gone."""
    global _league_refreshing
    conn = connect(cfg.db_path, same_thread=False)
    try:
        leagues.refresh_all(conn)
    except Exception:
        # refresh_all() already reports a single league failing as an outcome
        # rather than raising, so getting here means something broader broke.
        # Leagues have no sync_log equivalent to record it in, and a stale
        # table beats a 500 on the soccer page, so this stays quiet —
        # fetched_at not moving is the signal, and the page shows it.
        pass
    finally:
        conn.close()
        _league_refreshing = False


@app.get("/api/leagues")
def get_leagues(background: BackgroundTasks, conn: DB) -> dict[str, Any]:
    """Standings and fixtures for the two standing fixtures. Pickup has none.

    Serves what is stored and, when that has gone stale, starts a scrape
    behind the response instead of blocking on two external page loads. The
    caller gets the current rows immediately plus `refreshing`, which says a
    newer set is on its way and is worth asking for again shortly.
    """
    global _league_refreshing, _league_last_attempt

    age = _league_age_s(conn)
    now = time.monotonic()
    if (
        (age is None or age > LEAGUE_MAX_AGE_S)
        and not _league_refreshing
        and (
            _league_last_attempt is None
            or now - _league_last_attempt > LEAGUE_MIN_INTERVAL_S
        )
    ):
        _league_refreshing = True
        _league_last_attempt = now
        background.add_task(_run_league_refresh)

    return {"leagues": leagues.read(conn), "refreshing": _league_refreshing}


@app.get("/api/leagues/seasons")
def league_seasons(conn: DB) -> dict[str, Any]:
    """Every season on record, newest first: the final table of a finished
    one, the table so far of the one being played."""
    return {"seasons": leagues.seasons(conn)}


@app.post("/api/leagues/refresh")
def refresh_leagues(conn: DB) -> dict[str, Any]:
    """Explicit refresh: always fetches, and blocks until it has.

    Asked for by hand, so it ignores the staleness window above — but it does
    reset the attempt clock, so a GET landing straight afterwards does not
    immediately queue a second scrape of the same two pages.
    """
    global _league_last_attempt

    _league_last_attempt = time.monotonic()
    results = leagues.refresh_all(conn)
    return {
        "results": [{"team": t, "outcome": o} for t, o in results],
        "leagues": leagues.read(conn),
    }


@app.get("/api/sessions")
def list_sessions(
    conn: DB,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    kind: str | None = None,
    q_: str | None = Query(None, alias="q"),
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    return views.session_log(
        conn, start=from_, end=to, kind=kind, text=q_,
        limit=max(1, min(500, limit)), offset=max(0, offset),
    )


@app.get("/api/trends")
def trends(
    conn: DB,
    metric: str = "load",
    grain: str = "week",
    kind: str | None = None,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
) -> dict[str, Any]:
    try:
        return views.trends(conn, metric=metric, grain=grain, kind=kind, start=from_, end=to)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/soccer")
def soccer(
    conn: DB, from_: str | None = Query(None, alias="from"), to: str | None = None
) -> dict[str, Any]:
    """Record, goal involvement and every logged match."""
    return views.soccer(conn, from_, to)


@app.post("/api/sessions/{session_id}/rpe")
def set_rpe(session_id: int, payload: dict[str, Any], conn: DB) -> dict[str, Any]:
    """The one-tap post-session RPE that makes unified load possible (BRIEF §8)."""
    try:
        value = float(payload["rpe"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="rpe required") from exc
    if not 0 <= value <= 10:
        raise HTTPException(status_code=422, detail="rpe must be 0-10")
    with transaction(conn):
        q.set_session_rpe(conn, session_id, value)
    return {"ok": True}


@app.get("/api/summary")
def summary(conn: DB, week_of: str | None = None, weeks: int = 12) -> dict[str, Any]:
    """Everything the dashboard draws for one week, in one request.

    `weeks` sizes the load history and the read-out behind it. Pass 0 for the
    whole record — the Week page's context control offers "All", and pinning
    that to a constant would silently stop being all-time the week the record
    outgrew it.
    """
    end = date.fromisoformat(week_of) if week_of else None
    if weeks <= 0:
        first = q.first_session_date(conn)
        # Both ends snap to their Monday before the span is measured. Anchoring
        # on the raw dates made the answer depend on whether the client happened
        # to send `week_of`: today gave 84 buckets and the same week's Sunday
        # gave 85, so the label flickered between the two on reload. Buckets are
        # Monday-aligned, so the arithmetic has to be too.
        anchor = _monday_of(end or date.today())
        weeks = (
            ((anchor - _monday_of(date.fromisoformat(first))).days // 7) + 1
            if first else 12
        )
    return dashboard.build_summary(
        conn, end, cfg.planned_per_week, load_weeks=max(4, min(520, weeks))
    )


def _monday_of(d: date) -> date:
    """The Monday that starts `d`'s week. Same rule as everywhere else."""
    return d - timedelta(days=d.weekday())


@app.get("/api/metrics")
def daily_metrics(
    conn: DB,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    all: bool = False,
) -> dict[str, Any]:
    """Every `metric_daily` row in a window — the watch's nightly numbers.

    One row per date, every column, nulls kept: a night the watch was not
    worn is a gap, never a zero. No aggregation here; the Recovery page does
    its own arithmetic in the open and prints the denominators. Default
    window is the trailing 28 days, ending today.
    """
    end = _iso_or_422(to, "to") if to else date.today().isoformat()
    if all:
        # The first night, not the first weigh-in: the scale ran a year ahead
        # of the watch, and "all time" on a sleep page means all the sleep.
        first = conn.execute(
            "SELECT MIN(date) FROM metric_daily WHERE sleep_hours IS NOT NULL "
            "OR hrv_ms IS NOT NULL OR resting_hr IS NOT NULL OR readiness IS NOT NULL"
        ).fetchone()[0]
        start = first or end
    else:
        start = _iso_or_422(from_, "from") if from_ else (
            date.fromisoformat(end) - timedelta(days=27)
        ).isoformat()
    if start > end:
        raise HTTPException(422, "from is after to")
    rows = [dict(r) for r in q.metrics_between(conn, start, end)]
    # The window is the span asked for, not the rows that came back: a
    # 28-day range with one unsynced night is still "last 28 days".
    tf = (
        timeframe.all_time(start, end, "day") if all
        else timeframe.window(start, end, "day")
    )
    return {"timeframe": tf.as_dict(), "days": rows}


@app.get("/api/history")
def all_time(conn: DB) -> dict[str, Any]:
    """Every day since the first entry, plus a row per year. Open-ended."""
    return history.build_history(conn)


# --- Garmin sync ----------------------------------------------------------
#
# One sync at a time, process-wide. The unofficial API throttles hard and can
# block the account; two overlapping runs is the fastest way to earn that
# (BRIEF §5). The flag is a plain bool because there is exactly one process.
_sync_running = False


@app.get("/api/sync-status")
def sync_status(conn: DB) -> dict[str, Any]:
    """Whether the nightly job is actually working, and what to do if not."""
    body = status.build_status(conn, cfg.garmin_token_dir, running=_sync_running)
    body["next_scheduled"] = status.next_scheduled(int(os.getenv("LEDGER_CRON_HOUR", "3")))
    return body


@app.get("/api/sync-log")
def sync_log(conn: DB, limit: int = 50) -> dict[str, Any]:
    return {"entries": status.recent_log(conn, limit=max(1, min(500, limit)))}


def _run_sync(days: int) -> None:
    """Background sync. Opens its own connection — the request's is long gone."""
    global _sync_running
    from ledger.garmin.client import GarminAuthError, GarminClient
    from ledger.garmin.sync import sync_recent

    conn = connect(cfg.db_path, same_thread=False)
    try:
        client = GarminClient(cfg.garmin_token_dir, call_delay_s=cfg.sync_call_delay_s)
        try:
            client.resume()
        except GarminAuthError as exc:
            q.log_sync(conn, "login", "error", None, str(exc))
            return
        sync_recent(conn, client, trailing_days=days)
    except Exception as exc:  # never let a background task die unrecorded
        q.log_sync(conn, "sync", "error", None, f"{type(exc).__name__}: {exc}")
    finally:
        conn.close()
        _sync_running = False


@app.post("/api/sync")
def start_sync(background: BackgroundTasks, conn: DB, days: int = 3) -> dict[str, Any]:
    """Kick off a sync and return immediately.

    Paced calls make a run take tens of seconds, so it must not block the
    request — the client polls /api/sync-status instead.
    """
    global _sync_running
    if _sync_running:
        raise HTTPException(status_code=409, detail="a sync is already running")
    if not status.tokens_present(cfg.garmin_token_dir):
        raise HTTPException(
            status_code=409,
            detail=(
                "Garmin has never been authenticated. Run "
                "`docker compose run --rm cli ledger garmin-login` once — it is "
                "interactive and may ask for an MFA code."
            ),
        )

    _sync_running = True
    background.add_task(_run_sync, max(1, min(30, days)))
    return {"started": True, "days": max(1, min(30, days))}


@app.get("/api/report/weekly", response_class=HTMLResponse)
def weekly_report(
    conn: DB, week_of: str | None = None, fmt: str = Query("html", alias="format")
) -> Response:
    """The weekly report. `format=text` is the same report `ledger report`
    prints, for a reader that wants prose rather than markup."""
    end = date.fromisoformat(week_of) if week_of else None
    rep = weekly.build_report(conn, end, cfg.planned_per_week)
    if fmt == "text":
        return PlainTextResponse(weekly.render_text(rep))
    return HTMLResponse(weekly.render_html(rep))


if (WEB_DIR / "index.html").exists():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
else:
    # Phase 1 has not shipped. Until it does, the weekly report is the app —
    # send the root there rather than serving a 404 from an empty directory.
    @app.get("/", include_in_schema=False)
    def root() -> RedirectResponse:
        return RedirectResponse("/api/report/weekly")
