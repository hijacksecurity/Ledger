"""Persisting a parsed session: sets, then PR detection (BRIEF §6).

PR detection runs after every session write. It is deliberately a separate,
re-runnable step so a corrected entry can be re-scored without leaving stale
PRs behind.
"""

from __future__ import annotations

import sqlite3

from ledger.core.e1rm import SetRow
from ledger.core.prs import PRHit, detect_session_prs
from ledger.db import queries as q
from ledger.db.schema import transaction
from ledger.entry import ParsedSession, ParsedWeek


def _guess_modality(sets: list[SetRow]) -> str:
    """Only used at exercise-creation time; the user can correct it later."""
    return "bodyweight" if all(s.weight == 0 for s in sets) else "barbell"


def save_session(conn: sqlite3.Connection, parsed: ParsedSession) -> tuple[int, list[PRHit]]:
    """Write one parsed session and its PRs atomically."""
    with transaction(conn):
        session_id = q.insert_session(
            conn,
            date=parsed.date,
            kind=parsed.kind,
            source="manual",
            started_at=parsed.started_at,
            rpe=parsed.rpe,
            duration_min=parsed.duration_min,
            notes=parsed.notes,
            distance_km=parsed.distance_km,
            pace_s_per_km=parsed.pace_s_per_km,
            detail=parsed.detail or None,
        )

        rows: list[SetRow] = []
        for exercise in parsed.exercises:
            placeholder = [
                SetRow(exercise_id=0, weight=s.weight_kg, reps=s.reps, is_warmup=s.is_warmup)
                for s in exercise.sets
            ]
            exercise_id = q.get_or_create_exercise(
                conn, exercise.name, _guess_modality(placeholder)
            )
            rows.extend(
                SetRow(
                    exercise_id=exercise_id,
                    weight=s.weight_kg,
                    reps=s.reps,
                    rpe=s.rpe,
                    is_warmup=s.is_warmup,
                )
                for s in exercise.sets
            )

        if rows:
            q.add_sets(conn, session_id, rows)

        hits = _score(conn, session_id, parsed.date)

    return session_id, hits


def save_week(conn: sqlite3.Connection, week: ParsedWeek) -> None:
    """Write a notebook page header.

    The weigh-in also lands in `metric_daily` so bodyweight has a single
    source for the 7-day EMA (BRIEF §7), whether it came from the scale via
    Garmin or off a notebook page.
    """
    with transaction(conn):
        q.upsert_week(
            conn,
            start_date=week.start_date,
            week_number=week.week_number,
            bodyweight_lbs=week.bodyweight_lbs,
            avg_activities_per_week=week.avg_activities_per_week,
            notes=week.notes,
        )
        if week.bodyweight_kg is not None:
            q.upsert_metric_daily(conn, week.start_date, bodyweight_kg=week.bodyweight_kg)


def rescore_session(conn: sqlite3.Connection, session_id: int) -> list[PRHit]:
    """Recompute PRs for an existing session, replacing any it previously set."""
    row = conn.execute("SELECT date FROM session WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise ValueError(f"no session {session_id}")
    with transaction(conn):
        q.clear_prs_for_session(conn, session_id)
        return _score(conn, session_id, row["date"])


def _score(conn: sqlite3.Connection, session_id: int, date: str) -> list[PRHit]:
    """Caller must hold a transaction."""
    by_exercise = q.session_sets(conn, session_id)
    if not by_exercise:
        return []
    priors = {
        exercise_id: q.prior_bests(conn, exercise_id, date, session_id)
        for exercise_id in by_exercise
    }
    hits = detect_session_prs(by_exercise, priors)
    if hits:
        q.record_prs(conn, hits, session_id, date)
    return hits
