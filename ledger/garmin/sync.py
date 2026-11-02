"""Nightly Garmin sync (BRIEF §5).

Contract, in priority order:

  1. Never crash the whole run because one record surprised us. Log it to
     `sync_log`, skip that record, continue.
  2. Idempotent. Re-running over the same dates changes nothing.
  3. Never clobber user-entered data with watch data. The notebook is
     authoritative for lifts; Garmin fills in what the watch measures well.
  4. Every call gets a `sync_log` row, success or failure.

The nightly job pulls the trailing 3 days: activities sync late and Garmin
revises sleep and HRV after the fact. That is ~16 calls, well under 20.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from ledger.config import Config
from ledger.core.e1rm import SetRow
from ledger.db import queries as q
from ledger.garmin import mapping as m
from ledger.garmin.client import GarminClient, GarminRateLimited

log = logging.getLogger(__name__)

NIGHTLY_TRAILING_DAYS = 3

#: Kinds Garmin reports as `soccer` but which are training, not a match.
SOCCER_LOOKALIKE_KINDS = ("quickfeet",)
MAX_BACKFILL_CHUNK_DAYS = 30


@dataclass
class SyncResult:
    activities_seen: int = 0
    sessions_written: int = 0
    sessions_merged: int = 0
    metric_days: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)
    api_calls: int = 0

    def summary(self) -> str:
        return (
            f"{self.activities_seen} activities, {self.sessions_written} sessions "
            f"({self.sessions_merged} merged), {self.metric_days} metric days, "
            f"{self.skipped} skipped, {len(self.errors)} errors, "
            f"{self.api_calls} API calls"
        )


def _guarded(
    conn: sqlite3.Connection,
    result: SyncResult,
    endpoint: str,
    date_range: str | None,
    fn: Callable[[], Any],
) -> Any:
    """Run one API call, logging the outcome either way.

    Rate limiting propagates — it means stop for tonight. Everything else is
    recorded and swallowed so the remaining endpoints still run.
    """
    try:
        value = fn()
    except GarminRateLimited as exc:
        q.log_sync(conn, endpoint, "rate_limited", date_range, str(exc))
        raise
    except Exception as exc:
        q.log_sync(conn, endpoint, "error", date_range, f"{type(exc).__name__}: {exc}")
        result.errors.append(f"{endpoint}: {exc}")
        log.warning("%s failed for %s: %s", endpoint, date_range, exc)
        return None
    else:
        q.log_sync(conn, endpoint, "ok", date_range)
        return value


# --- activities -----------------------------------------------------------


def _merge_target(
    conn: sqlite3.Connection, parsed: m.GarminSession
) -> sqlite3.Row | None:
    """Find the manual session a Garmin activity is a second record of.

    BRIEF §5 wrote this rule for lifts, but the same double-entry happens for
    every modality once anything is logged by hand — a run typed in from the
    notebook and the same run recorded by the watch are one session, not two.
    So it applies to all kinds, matched within kind.

    Primary rule: >70% of the Garmin activity's duration overlaps the manual
    session. Fallback: notebook entries usually carry a date and no clock
    times, so a single unlinked manual session of the same kind on the same day
    is treated as the same session. Ambiguity (two or more untimed candidates)
    merges nothing — a duplicate is easy to spot and delete; a wrong merge is
    not.
    """
    candidates = q.manual_sessions_on(conn, parsed.date, parsed.kind)

    # The watch cannot tell solo ball work from a match — quick feet, dribbling
    # and cone drills all come back as `soccer`. When a manual session of one of
    # those kinds is sitting on the same day, prefer it: the hand-written kind
    # is the truthful one, and letting the watch win would file drills as
    # matches and corrupt the record, the goal tallies and the fixture table.
    if parsed.kind == "soccer":
        for solo in SOCCER_LOOKALIKE_KINDS:
            candidates += q.manual_sessions_on(conn, parsed.date, solo)
    if not candidates:
        return None

    g_start = m.parse_local_datetime(parsed.started_at)
    g_end = m.parse_local_datetime(parsed.ended_at)

    if g_start and g_end:
        for row in candidates:
            man_start = m.parse_local_datetime(row["started_at"])
            man_end = m.parse_local_datetime(row["ended_at"])
            if man_start and man_end and m.should_merge(g_start, g_end, man_start, man_end):
                return row

    untimed = [r for r in candidates if not r["started_at"]]
    return untimed[0] if len(untimed) == 1 else None


def sync_activities(
    conn: sqlite3.Connection,
    client: GarminClient,
    start: str,
    end: str,
    result: SyncResult,
) -> list[tuple[int, m.GarminSession]]:
    """Pull activities for a date range. Returns (session_id, parsed) pairs."""
    span = f"{start}..{end}"
    activities = _guarded(
        conn,
        result,
        "get_activities_by_date",
        span,
        lambda: client.call("get_activities_by_date", start, end),
    )
    if not isinstance(activities, list):
        return []

    written: list[tuple[int, m.GarminSession]] = []
    for raw in activities:
        estimated_rpe, rpe_method = m.estimate_rpe(raw)
        watch_load = m.garmin_load(raw)
        # Read off the same payload the RPE estimate already uses, so zones
        # cost no extra paced call.
        zones = m.hr_zones(raw)
        result.activities_seen += 1
        parsed = m.parse_activity(raw)
        if parsed is None:
            result.skipped += 1
            q.log_sync(
                conn,
                "parse_activity",
                "skipped",
                span,
                f"unparseable activity: {str(raw)[:400]}",
            )
            continue

        existing = q.session_by_garmin_id(conn, parsed.garmin_activity_id)
        if existing is None:
            target = _merge_target(conn, parsed)
            if target is not None:
                q.attach_garmin_to_session(
                    conn,
                    int(target["id"]),
                    parsed.garmin_activity_id,
                    parsed.duration_min,
                    parsed.started_at,
                    parsed.ended_at,
                    distance_km=parsed.distance_km,
                    pace_s_per_km=parsed.pace_s_per_km,
                )
                q.enrich_from_garmin(
                    conn, int(target["id"]),
                    estimated_rpe=estimated_rpe, rpe_method=rpe_method,
                    garmin_load=watch_load, zones=zones, garmin_name=parsed.notes,
                )
                result.sessions_merged += 1
                written.append((int(target["id"]), parsed))
                continue

        session_id = q.upsert_garmin_session(
            conn,
            garmin_activity_id=parsed.garmin_activity_id,
            date=parsed.date,
            kind=parsed.kind,
            started_at=parsed.started_at,
            ended_at=parsed.ended_at,
            duration_min=parsed.duration_min,
            notes=parsed.notes,
            distance_km=parsed.distance_km,
            pace_s_per_km=parsed.pace_s_per_km,
        )
        q.enrich_from_garmin(
            conn, session_id,
            estimated_rpe=estimated_rpe, rpe_method=rpe_method,
            garmin_load=watch_load, zones=zones, garmin_name=parsed.notes,
        )
        result.sessions_written += 1
        written.append((session_id, parsed))

    return written


def sync_exercise_sets(
    conn: sqlite3.Connection,
    client: GarminClient,
    session_id: int,
    activity_id: str,
    result: SyncResult,
) -> None:
    """Pull watch-logged sets, but only where the user has not logged any.

    Manual entry always wins: the notebook records intent (warmup vs working,
    real RPE) that the watch cannot see.
    """
    if q.session_has_sets(conn, session_id):
        return

    payload = _guarded(
        conn,
        result,
        "get_activity_exercise_sets",
        activity_id,
        lambda: client.call("get_activity_exercise_sets", activity_id),
    )
    if payload is None:
        return

    parsed_sets = m.parse_exercise_sets(payload)
    if not parsed_sets:
        return

    rows = [
        SetRow(
            exercise_id=q.get_or_create_exercise(conn, s.exercise_name),
            weight=s.weight_kg,
            reps=s.reps,
            is_warmup=False,
        )
        for s in parsed_sets
    ]
    q.add_sets(conn, session_id, rows)


# --- daily metrics --------------------------------------------------------


#: The endpoints that carry the 015 and 016 recovery columns. A metrics-only
#: backfill calls just these, so re-reading a year costs three calls a day.
METRIC_ENDPOINTS_CHEAP = frozenset({"get_stats_and_body", "get_sleep_data", "get_hrv_data"})
METRIC_ENDPOINTS = frozenset({
    "get_stats_and_body", "get_training_readiness", "get_hrv_data", "get_rhr_day", "get_sleep_data",
})


def sync_metrics_for_day(
    conn: sqlite3.Connection,
    client: GarminClient,
    day: str,
    result: SyncResult,
    only: frozenset[str] | None = None,
) -> None:
    """One day of recovery metrics. Each endpoint fails independently.

    `only` restricts which endpoints are called; everything else is skipped,
    not nulled — `upsert_metric_daily` never writes a None.
    """
    values: dict[str, Any] = {}

    def wanted(name: str) -> bool:
        return only is None or name in only

    stats = _guarded(
        conn, result, "get_stats_and_body", day, lambda: client.call("get_stats_and_body", day)
    ) if wanted("get_stats_and_body") else None
    if stats is not None:
        values["bodyweight_kg"] = m.parse_bodyweight_kg(stats)
        high, low = m.parse_body_battery(stats)
        values["body_battery_high"] = high
        values["body_battery_low"] = low
        values.update(m.parse_daily_stats(stats))
        # When the burn figures were pulled. The Calories page decides from
        # this whether today's row is worth re-reading.
        if any(k in values for k in ("calories_total", "calories_active", "calories_bmr")):
            values["calories_fetched_at"] = datetime.now(UTC).isoformat(timespec="seconds")

    readiness = None if not wanted("get_training_readiness") else _guarded(
        conn,
        result,
        "get_training_readiness",
        day,
        lambda: client.call("get_training_readiness", day),
    )
    if readiness is not None:
        values["readiness"] = m.parse_readiness(readiness)

    hrv = _guarded(
        conn, result, "get_hrv_data", day, lambda: client.call("get_hrv_data", day)
    ) if wanted("get_hrv_data") else None
    if hrv is not None:
        values["hrv_ms"] = m.parse_hrv_ms(hrv)
        values.update(m.parse_hrv_detail(hrv))

    rhr = _guarded(
        conn, result, "get_rhr_day", day, lambda: client.call("get_rhr_day", day)
    ) if wanted("get_rhr_day") else None
    if rhr is not None:
        values["resting_hr"] = m.parse_resting_hr(rhr)

    sleep = _guarded(
        conn, result, "get_sleep_data", day, lambda: client.call("get_sleep_data", day)
    ) if wanted("get_sleep_data") else None
    if sleep is not None:
        values["sleep_hours"] = m.parse_sleep_hours(sleep)
        values.update(m.parse_sleep_detail(sleep))

    if any(v is not None for v in values.values()):
        q.upsert_metric_daily(conn, day, **values)
        result.metric_days += 1


# --- entry points ---------------------------------------------------------


def sync_range(
    conn: sqlite3.Connection,
    client: GarminClient,
    start: str,
    end: str,
    result: SyncResult | None = None,
) -> SyncResult:
    """Sync one contiguous date range. Must be <= 30 days (BRIEF §5)."""
    result = result or SyncResult()
    if (date.fromisoformat(end) - date.fromisoformat(start)).days + 1 > MAX_BACKFILL_CHUNK_DAYS:
        raise ValueError(
            f"range {start}..{end} exceeds the {MAX_BACKFILL_CHUNK_DAYS}-day chunk limit"
        )

    try:
        written = sync_activities(conn, client, start, end, result)
        for session_id, parsed in written:
            if parsed.kind == "lift":
                sync_exercise_sets(
                    conn, client, session_id, parsed.garmin_activity_id, result
                )

        day = date.fromisoformat(start)
        last = date.fromisoformat(end)
        while day <= last:
            sync_metrics_for_day(conn, client, day.isoformat(), result)
            day += timedelta(days=1)
    except GarminRateLimited as exc:
        result.errors.append(f"aborted: {exc}")
        log.error("sync aborted, rate limited: %s", exc)

    result.api_calls = client.calls_made
    return result


def sync_recent(
    conn: sqlite3.Connection,
    client: GarminClient,
    today: date | None = None,
    trailing_days: int = NIGHTLY_TRAILING_DAYS,
) -> SyncResult:
    """The nightly job. Trailing few days only."""
    today = today or date.today()
    start = (today - timedelta(days=trailing_days - 1)).isoformat()
    return sync_range(conn, client, start, today.isoformat())


def backfill(
    conn: sqlite3.Connection,
    client: GarminClient,
    start: str,
    end: str,
    cfg: Config,
    sleep: Callable[[float], None] | None = None,
) -> SyncResult:
    """Historical import in <=30-day chunks with a long pause between them."""
    sleep = sleep or time.sleep
    result = SyncResult()

    cursor = date.fromisoformat(start)
    last = date.fromisoformat(end)
    first_chunk = True
    while cursor <= last:
        chunk_end = min(cursor + timedelta(days=MAX_BACKFILL_CHUNK_DAYS - 1), last)
        if not first_chunk:
            log.info("pausing %.0fs between chunks", cfg.sync_chunk_pause_s)
            sleep(cfg.sync_chunk_pause_s)
        first_chunk = False

        log.info("backfilling %s..%s", cursor, chunk_end)
        sync_range(conn, client, cursor.isoformat(), chunk_end.isoformat(), result)
        if any(e.startswith("aborted:") for e in result.errors):
            break
        cursor = chunk_end + timedelta(days=1)

    return result


def backfill_metrics(
    conn: sqlite3.Connection,
    client: GarminClient,
    start: str,
    end: str,
    cfg: Config,
    sleep: Callable[[float], None] | None = None,
    only: frozenset[str] = METRIC_ENDPOINTS_CHEAP,
) -> SyncResult:
    """Re-read daily metrics only — no activities, no sets.

    Exists for the 015 columns: a year of sleep and stress detail was already
    fetched once and thrown away, and pulling it back through `backfill` would
    re-pull every activity with it and risk the duplicate-session trap the CLI
    guards against. Two calls a day, same chunk pause, same rate-limit abort.
    """
    sleep = sleep or time.sleep
    result = SyncResult()
    cursor = date.fromisoformat(start)
    last = date.fromisoformat(end)
    first_chunk = True
    try:
        while cursor <= last:
            chunk_end = min(cursor + timedelta(days=MAX_BACKFILL_CHUNK_DAYS - 1), last)
            if not first_chunk:
                log.info("pausing %.0fs between chunks", cfg.sync_chunk_pause_s)
                sleep(cfg.sync_chunk_pause_s)
            first_chunk = False
            log.info("metrics %s..%s", cursor, chunk_end)
            day = cursor
            while day <= chunk_end:
                sync_metrics_for_day(conn, client, day.isoformat(), result, only=only)
                conn.commit()
                day += timedelta(days=1)
            cursor = chunk_end + timedelta(days=1)
    except GarminRateLimited as exc:
        result.errors.append(f"aborted: {exc}")
        log.error("metrics backfill aborted, rate limited: %s", exc)
    result.api_calls = client.calls_made
    return result
