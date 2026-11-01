"""Every SQL statement in the project lives here.

Rationale: the core/ modules stay pure and testable, and when the schema
changes there is exactly one file to grep. Nothing outside this module should
write SQL.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from ledger.core.e1rm import SetRow
from ledger.core.prs import PRHit, PriorBests
from ledger.entry import KIND_LABEL

# --- sync log -------------------------------------------------------------


def log_sync(
    conn: sqlite3.Connection,
    endpoint: str,
    status: str,
    date_range: str | None = None,
    detail: str | None = None,
) -> None:
    """Every sync call gets a row regardless of outcome (BRIEF §12).

    When something breaks months from now, this table is the only debugging
    surface. It is never conditional on success.
    """
    conn.execute(
        "INSERT INTO sync_log (ran_at, endpoint, date_range, status, detail) "
        "VALUES (?, ?, ?, ?, ?)",
        (
            datetime.now(UTC).isoformat(timespec="seconds"),
            endpoint,
            date_range,
            status,
            detail[:2000] if detail else None,
        ),
    )


def recent_sync_log(conn: sqlite3.Connection, limit: int = 50) -> list[sqlite3.Row]:
    return list(
        conn.execute("SELECT * FROM sync_log ORDER BY ran_at DESC, id DESC LIMIT ?", (limit,))
    )


# --- exercises ------------------------------------------------------------


def get_or_create_exercise(
    conn: sqlite3.Connection, name: str, modality: str = "barbell"
) -> int:
    """Exercises are created on first use from free text (BRIEF §2).

    There is no seeded taxonomy. Matching is case-insensitive on the canonical
    name, then on the alias list.
    """
    name = name.strip()
    row = conn.execute(
        "SELECT id FROM exercise WHERE lower(name) = lower(?)", (name,)
    ).fetchone()
    if row:
        return int(row["id"])

    match = find_exercise_by_alias(conn, name)
    if match is not None:
        return match

    cur = conn.execute(
        "INSERT INTO exercise (name, aliases, modality, created_at) VALUES (?, ?, ?, ?)",
        (name, json.dumps([]), modality, datetime.now(UTC).isoformat(timespec="seconds")),
    )
    return int(cur.lastrowid)


def find_exercise_by_alias(conn: sqlite3.Connection, text: str) -> int | None:
    needle = text.strip().lower()
    for row in conn.execute("SELECT id, aliases FROM exercise"):
        try:
            aliases = json.loads(row["aliases"] or "[]")
        except json.JSONDecodeError:
            continue
        if any(isinstance(a, str) and a.lower() == needle for a in aliases):
            return int(row["id"])
    return None


def add_alias(conn: sqlite3.Connection, exercise_id: int, alias: str) -> None:
    row = conn.execute("SELECT aliases FROM exercise WHERE id = ?", (exercise_id,)).fetchone()
    if row is None:
        return
    try:
        aliases = json.loads(row["aliases"] or "[]")
    except json.JSONDecodeError:
        aliases = []
    if alias not in aliases:
        aliases.append(alias)
    conn.execute("UPDATE exercise SET aliases = ? WHERE id = ?", (json.dumps(aliases), exercise_id))


def list_exercises(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return list(conn.execute("SELECT * FROM exercise ORDER BY name"))


# --- sessions -------------------------------------------------------------


def insert_session(
    conn: sqlite3.Connection,
    *,
    date: str,
    kind: str,
    source: str,
    started_at: str | None = None,
    ended_at: str | None = None,
    rpe: float | None = None,
    duration_min: float | None = None,
    notes: str | None = None,
    garmin_activity_id: str | None = None,
    distance_km: float | None = None,
    pace_s_per_km: float | None = None,
    detail: dict[str, Any] | None = None,
) -> int:
    cur = conn.execute(
        "INSERT INTO session "
        "(date, started_at, ended_at, kind, rpe, duration_min, notes, "
        " garmin_activity_id, source, distance_km, pace_s_per_km, detail) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            date,
            started_at,
            ended_at,
            kind,
            rpe,
            duration_min,
            notes,
            garmin_activity_id,
            source,
            distance_km,
            pace_s_per_km,
            json.dumps(detail, sort_keys=True) if detail else None,
        ),
    )
    return int(cur.lastrowid)


def upsert_garmin_session(
    conn: sqlite3.Connection,
    *,
    garmin_activity_id: str,
    date: str,
    kind: str,
    started_at: str | None,
    ended_at: str | None,
    duration_min: float | None,
    notes: str | None,
    distance_km: float | None = None,
    pace_s_per_km: float | None = None,
) -> int:
    """Insert or refresh a Garmin-sourced session. Idempotent by activity id.

    A user-supplied `rpe` is never touched here — re-running a sync must not
    wipe the one field the watch cannot provide.
    """
    conn.execute(
        "INSERT INTO session "
        "(date, started_at, ended_at, kind, duration_min, notes, "
        " garmin_activity_id, source, distance_km, pace_s_per_km) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'garmin', ?, ?) "
        "ON CONFLICT(garmin_activity_id) DO UPDATE SET "
        "  date = excluded.date, "
        "  started_at = excluded.started_at, "
        "  ended_at = excluded.ended_at, "
        # Never let the watch relabel a session a human classified. Garmin
        # reports solo ball work as `soccer`, so overwriting here turns quick
        # feet into a match on every sync — the bug this CASE exists to stop.
        #
        # `source = 'manual'` alone was not enough: it protects sessions typed
        # in by hand and misses the case that actually happens, a Garmin-sourced
        # session the user reclassified afterwards. Those stay
        # `source = 'garmin'`, so the correction was overwritten every night.
        # `kind_locked` is set the moment a person changes the kind, and it is
        # absolute. There was briefly an exception here: if the watch's activity
        # *name* resolved to a kind, that name overrode the lock, on the theory
        # that renaming an activity on the watch is the user classifying it
        # from the other device. It is not worth the cost. The name is fixed at
        # the moment the activity is recorded and every later sync replays it,
        # so the override did not read the user's latest intent — it replayed
        # their oldest one, forever, and a correction made in the app was undone
        # by the next sync with `kind_locked = 1` still set. That is the
        # "I fix it and it comes back" bug, and it survived every guard added
        # around it because the guard was the thing being overridden.
        #
        # Precedence is now, in order: a person's correction in the app, then
        # the watch's name, then Garmin's type. The last two are both resolved
        # in `mapping.map_kind` before they reach this statement, so this only
        # has to defend the first.
        "  kind = CASE WHEN session.source = 'manual' OR session.kind_locked = 1 "
        "              THEN session.kind ELSE excluded.kind END, "
        "  duration_min = excluded.duration_min, "
        "  distance_km = COALESCE(excluded.distance_km, session.distance_km), "
        "  pace_s_per_km = COALESCE(excluded.pace_s_per_km, session.pace_s_per_km), "
        "  notes = COALESCE(session.notes, excluded.notes)",
        (date, started_at, ended_at, kind, duration_min, notes,
         garmin_activity_id, distance_km, pace_s_per_km),
    )
    row = conn.execute(
        "SELECT id FROM session WHERE garmin_activity_id = ?", (garmin_activity_id,)
    ).fetchone()
    return int(row["id"])


def attach_garmin_to_session(
    conn: sqlite3.Connection,
    session_id: int,
    garmin_activity_id: str,
    duration_min: float | None,
    started_at: str | None,
    ended_at: str | None,
    distance_km: float | None = None,
    pace_s_per_km: float | None = None,
) -> None:
    """Merge case (BRIEF §5): keep the manual session, add the watch's data.

    COALESCE throughout: what was typed in by hand wins, and the watch only
    fills the blanks. The exception is distance — a GPS track beats a figure
    copied off a notebook page, and soccer has no hand-written distance at all.
    """
    conn.execute(
        "UPDATE session SET "
        "  garmin_activity_id = ?, "
        "  duration_min = COALESCE(duration_min, ?), "
        "  started_at = COALESCE(started_at, ?), "
        "  ended_at = COALESCE(ended_at, ?), "
        "  distance_km = COALESCE(?, distance_km), "
        "  pace_s_per_km = COALESCE(?, pace_s_per_km) "
        "WHERE id = ?",
        (garmin_activity_id, duration_min, started_at, ended_at,
         distance_km, pace_s_per_km, session_id),
    )


def manual_sessions_on(
    conn: sqlite3.Connection, date: str, kind: str | None = None
) -> list[sqlite3.Row]:
    """Manual sessions on a date that no Garmin activity has claimed yet."""
    sql = ("SELECT * FROM session WHERE date = ? AND source = 'manual' "
           "AND garmin_activity_id IS NULL")
    params: list[Any] = [date]
    if kind:
        sql += " AND kind = ?"
        params.append(kind)
    return list(conn.execute(sql, params))


def session_by_garmin_id(conn: sqlite3.Connection, activity_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM session WHERE garmin_activity_id = ?", (activity_id,)
    ).fetchone()


def set_session_rpe(conn: sqlite3.Connection, session_id: int, rpe: float) -> None:
    conn.execute("UPDATE session SET rpe = ? WHERE id = ?", (rpe, session_id))


def search_sessions(
    conn: sqlite3.Connection,
    *,
    start: str | None = None,
    end: str | None = None,
    kind: str | None = None,
    text: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> tuple[int, list[sqlite3.Row]]:
    """Filtered session log. Returns (total matching, page of rows)."""
    where: list[str] = []
    params: dict[str, Any] = {}
    if start:
        where.append("date >= :start")
        params["start"] = start
    if end:
        where.append("date <= :end")
        params["end"] = end
    if kind:
        where.append("kind = :kind")
        params["kind"] = kind
    if text:
        where.append("(notes LIKE :q OR detail LIKE :q OR kind LIKE :q)")
        params["q"] = f"%{text}%"
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    total = int(
        conn.execute(f"SELECT COUNT(*) AS n FROM session {clause}", params).fetchone()["n"]
    )
    rows = list(
        conn.execute(
            f"SELECT * FROM session {clause} ORDER BY date DESC, id DESC "
            "LIMIT :limit OFFSET :offset",
            {**params, "limit": limit, "offset": offset},
        )
    )
    return total, rows


def session_by_id(conn: sqlite3.Connection, session_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM session WHERE id = ?", (session_id,)).fetchone()


def update_session(conn: sqlite3.Connection, session_id: int, fields: dict[str, Any]) -> None:
    """Patch a session. Only known columns are writable.

    Changing `kind` locks it: a person has said what this session is, and the
    next sync must not map it back. `kind_locked` is set here rather than left
    to the caller so every edit path gets it — the API, the CLI, and whatever
    comes next.
    """
    allowed = {
        "date", "kind", "started_at", "ended_at", "rpe", "duration_min",
        "notes", "distance_km", "pace_s_per_km", "detail",
    }
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return
    if "kind" in updates:
        row = conn.execute(
            "SELECT kind, notes, detail FROM session WHERE id = ?", (session_id,)
        ).fetchone()
        # Only an actual change locks it. Re-saving a session without touching
        # the modality should not quietly pin whatever the watch guessed.
        if row is not None and row["kind"] != updates["kind"]:
            updates["kind_locked"] = 1

            # Correcting the modality renames it too, but only when the name is
            # still the watch's. Garmin files ab work as "Strength", so a
            # corrected session read "Ab attack" in its title and "Strength"
            # underneath — the same session disagreeing with itself. Anything
            # the user typed is left exactly alone: a note is not a label.
            #
            # This used to be guarded by `"notes" not in updates`, which meant
            # it never ran from the app at all: the edit form rebuilds the whole
            # session from its shorthand and so always sends `notes`, carrying
            # the watch's label straight back in. Judge the *incoming* note
            # instead — that is the one about to be stored, and it is still the
            # watch's label unless the user typed over it.
            try:
                det = json.loads(row["detail"] or "{}")
            except json.JSONDecodeError:
                det = {}
            watch_name = det.get("garmin_name") if isinstance(det, dict) else None
            incoming = updates["notes"] if "notes" in updates else row["notes"]
            current = (incoming or "").strip()
            if not current or (watch_name and current == watch_name.strip()):
                label = KIND_LABEL.get(updates["kind"])
                if label:
                    updates["notes"] = label
    sets = ", ".join(f"{k} = :{k}" for k in updates)
    conn.execute(f"UPDATE session SET {sets} WHERE id = :id", {**updates, "id": session_id})


def delete_session(conn: sqlite3.Connection, session_id: int) -> None:
    conn.execute("DELETE FROM session WHERE id = ?", (session_id,))


def trend_points(
    conn: sqlite3.Connection,
    *,
    metric: str,
    grain: str,
    start: str,
    end: str,
    kind: str | None = None,
) -> list[sqlite3.Row]:
    """Aggregate one metric per period, split by kind.

    `metric` and `grain` are validated against fixed maps rather than
    interpolated from the caller — these land in SQL.
    """
    expr = {
        "load": "COALESCE(SUM(rpe * duration_min), 0)",
        # Stored inside the detail blob, so it is pulled out with json_extract
        # rather than living in a column of its own — it only exists for the
        # minority of sessions the watch recorded.
        "garmin_load": "COALESCE(SUM(json_extract(detail, '$.garmin_load')), 0)",
        "distance": "COALESCE(SUM(distance_km), 0)",
        "duration": "COALESCE(SUM(duration_min), 0)",
        "count": "COUNT(*)",
    }[metric]
    # SQLite has no ISO-week function; the Monday of each week is date(d,'weekday 0','-6 days').
    period = {
        "week": "date(date, 'weekday 0', '-6 days')",
        "month": "substr(date, 1, 7)",
    }[grain]

    params: dict[str, Any] = {"start": start, "end": end}
    kind_clause = ""
    if kind:
        kind_clause = "AND kind = :kind"
        params["kind"] = kind

    return list(
        conn.execute(
            f"SELECT {period} AS period, kind, {expr} AS value "
            f"FROM session WHERE date BETWEEN :start AND :end {kind_clause} "
            "GROUP BY period, kind ORDER BY period",
            params,
        )
    )


def soccer_games(conn: sqlite3.Connection, start: str, end: str) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT * FROM session WHERE kind = 'soccer' AND date BETWEEN ? AND ? "
            "ORDER BY date, id",
            (start, end),
        )
    )


def sessions_between(conn: sqlite3.Connection, start: str, end: str) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT * FROM session WHERE date BETWEEN ? AND ? ORDER BY date, started_at",
            (start, end),
        )
    )


def session_events(conn: sqlite3.Connection, start: str, end: str) -> list[tuple[str, str]]:
    """(date, kind) pairs — the input to every rolling-window count."""
    return [
        (r["date"], r["kind"])
        for r in conn.execute(
            "SELECT date, kind FROM session WHERE date BETWEEN ? AND ?", (start, end)
        )
    ]


def session_loads(
    conn: sqlite3.Connection, start: str, end: str
) -> list[tuple[str, str, float]]:
    """(date, kind, load) on Garmin's scale, for every session that has one.

    Garmin's own figure where the watch recorded it, and a converted stand-in
    from rpe x minutes where it did not — the same single scale the session
    rows report. This used to return raw Foster AU, which made the weekly
    total disagree with the sessions it was a total of.
    """
    from ledger.core import calibrate

    cal = calibrate.fit(conn)
    out: list[tuple[str, str, float]] = []
    for r in conn.execute(
        "SELECT date, kind, rpe, duration_min, detail FROM session "
        "WHERE date BETWEEN ? AND ?",
        (start, end),
    ):
        try:
            detail = json.loads(r["detail"] or "{}")
        except json.JSONDecodeError:
            detail = {}
        garmin = detail.get("garmin_load") if isinstance(detail, dict) else None
        value, _ = calibrate.session_load(
            r["kind"], r["rpe"], r["duration_min"], garmin, cal
        )
        if value:
            out.append((r["date"], r["kind"], value))
    return out


def first_session_date(conn: sqlite3.Connection) -> str | None:
    row = conn.execute("SELECT MIN(date) AS d FROM session").fetchone()
    return row["d"] if row and row["d"] else None


def last_session_date(conn: sqlite3.Connection) -> str | None:
    row = conn.execute("SELECT MAX(date) AS d FROM session").fetchone()
    return row["d"] if row and row["d"] else None


def daily_counts(conn: sqlite3.Connection, start: str, end: str) -> dict[str, int]:
    """{date: activities} for every day that has any. Sparse by design."""
    return {
        r["date"]: int(r["n"])
        for r in conn.execute(
            "SELECT date, COUNT(*) AS n FROM session WHERE date BETWEEN ? AND ? GROUP BY date",
            (start, end),
        )
    }


def year_totals(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Per-calendar-year rollup. Rows appear as years do — nothing is hardcoded."""
    return list(
        conn.execute(
            "SELECT substr(date, 1, 4) AS year, "
            "       COUNT(*) AS activities, "
            "       COUNT(DISTINCT date) AS active_days, "
            "       COALESCE(SUM(distance_km), 0) AS distance_km, "
            "       COALESCE(SUM(rpe * duration_min), 0) AS load, "
            "       MIN(date) AS first, MAX(date) AS last "
            "FROM session GROUP BY year ORDER BY year"
        )
    )


def year_kind_totals(conn: sqlite3.Connection) -> dict[str, dict[str, int]]:
    """{year: {kind: activities}}."""
    out: dict[str, dict[str, int]] = {}
    for r in conn.execute(
        "SELECT substr(date, 1, 4) AS year, kind, COUNT(*) AS n "
        "FROM session GROUP BY year, kind"
    ):
        out.setdefault(r["year"], {})[r["kind"]] = int(r["n"])
    return out


def count_sessions_through(conn: sqlite3.Connection, end: str) -> int:
    """Every session logged up to and including `end`.

    The numerator of the notebook's activities-per-week figure.
    """
    return int(
        conn.execute("SELECT COUNT(*) AS n FROM session WHERE date <= ?", (end,)).fetchone()["n"]
    )


def sessions_missing_rpe(conn: sqlite3.Connection, start: str, end: str) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT * FROM session WHERE date BETWEEN ? AND ? AND rpe IS NULL "
            "ORDER BY date, started_at",
            (start, end),
        )
    )


# --- sets -----------------------------------------------------------------


def add_sets(conn: sqlite3.Connection, session_id: int, sets: list[SetRow]) -> None:
    conn.executemany(
        "INSERT INTO lift_set "
        "(session_id, exercise_id, set_index, weight, reps, rpe, is_warmup) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (session_id, s.exercise_id, i, s.weight, s.reps, s.rpe, int(s.is_warmup))
            for i, s in enumerate(sets, start=1)
        ],
    )


def session_sets(conn: sqlite3.Connection, session_id: int) -> dict[int, list[SetRow]]:
    out: dict[int, list[SetRow]] = {}
    for r in conn.execute(
        "SELECT * FROM lift_set WHERE session_id = ? ORDER BY set_index", (session_id,)
    ):
        out.setdefault(int(r["exercise_id"]), []).append(
            SetRow(
                exercise_id=int(r["exercise_id"]),
                weight=float(r["weight"]),
                reps=int(r["reps"]),
                is_warmup=bool(r["is_warmup"]),
                rpe=r["rpe"],
            )
        )
    return out


def session_has_sets(conn: sqlite3.Connection, session_id: int) -> bool:
    row = conn.execute(
        "SELECT 1 FROM lift_set WHERE session_id = ? LIMIT 1", (session_id,)
    ).fetchone()
    return row is not None


def last_session_sets(
    conn: sqlite3.Connection, exercise_id: int, before_session_id: int | None = None
) -> list[SetRow]:
    """The previous session's sets for an exercise — Phase 1's pre-fill source."""
    row = conn.execute(
        "SELECT ls.session_id AS sid FROM lift_set ls "
        "JOIN session s ON s.id = ls.session_id "
        "WHERE ls.exercise_id = ? AND (? IS NULL OR ls.session_id <> ?) "
        "ORDER BY s.date DESC, ls.session_id DESC LIMIT 1",
        (exercise_id, before_session_id, before_session_id),
    ).fetchone()
    if row is None:
        return []
    return session_sets(conn, int(row["sid"])).get(exercise_id, [])


# --- PRs ------------------------------------------------------------------

#: Bests strictly before a given session, ordered by (date, id) so that two
#: sessions on the same day are compared in the order they were logged.
_PRIOR_SCOPE = "(s.date < :date OR (s.date = :date AND s.id < :sid))"


def prior_bests(
    conn: sqlite3.Connection, exercise_id: int, date: str, session_id: int
) -> PriorBests:
    params = {"ex": exercise_id, "date": date, "sid": session_id}

    ever = conn.execute(
        "SELECT 1 FROM lift_set ls JOIN session s ON s.id = ls.session_id "
        f"WHERE ls.exercise_id = :ex AND {_PRIOR_SCOPE} LIMIT 1",
        params,
    ).fetchone()

    best_e1rm = conn.execute(
        "SELECT MAX(ls.weight * (1 + ls.reps / 30.0)) AS v "
        "FROM lift_set ls JOIN session s ON s.id = ls.session_id "
        f"WHERE ls.exercise_id = :ex AND ls.is_warmup = 0 AND ls.reps <= 10 "
        f"  AND ls.weight > 0 AND {_PRIOR_SCOPE}",
        params,
    ).fetchone()["v"]

    best_volume = conn.execute(
        "SELECT MAX(v) AS v FROM ("
        "  SELECT SUM(ls.weight * ls.reps) AS v "
        "  FROM lift_set ls JOIN session s ON s.id = ls.session_id "
        f"  WHERE ls.exercise_id = :ex AND ls.is_warmup = 0 AND {_PRIOR_SCOPE} "
        "  GROUP BY ls.session_id"
        ")",
        params,
    ).fetchone()["v"]

    reps_at_weight = {
        float(r["weight"]): int(r["reps"])
        for r in conn.execute(
            "SELECT ls.weight AS weight, MAX(ls.reps) AS reps "
            "FROM lift_set ls JOIN session s ON s.id = ls.session_id "
            f"WHERE ls.exercise_id = :ex AND ls.is_warmup = 0 AND {_PRIOR_SCOPE} "
            "GROUP BY ls.weight",
            params,
        )
    }

    return PriorBests(
        ever_logged=ever is not None,
        best_e1rm=float(best_e1rm) if best_e1rm is not None else None,
        best_session_volume=float(best_volume) if best_volume is not None else None,
        best_reps_at_weight=reps_at_weight,
    )


def record_prs(
    conn: sqlite3.Connection, hits: list[PRHit], session_id: int, date: str
) -> None:
    conn.executemany(
        "INSERT INTO pr (exercise_id, kind, value, context, session_id, date) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [(h.exercise_id, h.kind, h.value, h.context_json(), session_id, date) for h in hits],
    )


def clear_prs_for_session(conn: sqlite3.Connection, session_id: int) -> None:
    """Used when a session is re-scored, so PRs are not double-counted."""
    conn.execute("DELETE FROM pr WHERE session_id = ?", (session_id,))


def prs_between(conn: sqlite3.Connection, start: str, end: str) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT pr.*, e.name AS exercise_name FROM pr "
            "JOIN exercise e ON e.id = pr.exercise_id "
            "WHERE pr.date BETWEEN ? AND ? ORDER BY pr.date, e.name, pr.kind",
            (start, end),
        )
    )


# --- weeks ----------------------------------------------------------------


def upsert_week(
    conn: sqlite3.Connection,
    *,
    start_date: str,
    week_number: int | None = None,
    bodyweight_lbs: float | None = None,
    avg_activities_per_week: float | None = None,
    notes: str | None = None,
) -> None:
    conn.execute(
        "INSERT INTO week "
        "(start_date, week_number, bodyweight_lbs, avg_activities_per_week, notes) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(start_date) DO UPDATE SET "
        "  week_number = COALESCE(excluded.week_number, week.week_number), "
        "  bodyweight_lbs = COALESCE(excluded.bodyweight_lbs, week.bodyweight_lbs), "
        "  avg_activities_per_week = COALESCE("
        "      excluded.avg_activities_per_week, week.avg_activities_per_week), "
        "  notes = COALESCE(excluded.notes, week.notes)",
        (start_date, week_number, bodyweight_lbs, avg_activities_per_week, notes),
    )


# --- locked plan ----------------------------------------------------------


def replace_plan_weeks(
    conn: sqlite3.Connection, rows: list[dict[str, Any]], *, from_week: str
) -> int:
    """Commit a plan from `from_week` onward, replacing whatever was there.

    Weeks *before* `from_week` are left alone on purpose. They have already
    been lived, and overwriting the target you set for a week you then failed
    to hit turns the comparison into a formality. Re-planning changes the
    future; it does not rewrite what you committed to.
    """
    with conn:
        conn.execute("DELETE FROM plan_week WHERE week_start >= ?", (from_week,))
        conn.executemany(
            "INSERT INTO plan_week "
            "(week_start, target_km, is_deload, locked_at, base_km, pct, note) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    r["week_start"], float(r["target_km"]), int(bool(r.get("is_deload"))),
                    datetime.now(UTC).isoformat(timespec="seconds"),
                    r.get("base_km"), r.get("pct"), r.get("note"),
                )
                for r in rows
            ],
        )
    return len(rows)


def plan_weeks(
    conn: sqlite3.Connection, start: str | None = None, end: str | None = None
) -> list[sqlite3.Row]:
    sql = "SELECT * FROM plan_week"
    clauses, args = [], []
    if start:
        clauses.append("week_start >= ?")
        args.append(start)
    if end:
        clauses.append("week_start <= ?")
        args.append(end)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    return list(conn.execute(sql + " ORDER BY week_start", args))


def clear_plan_weeks(conn: sqlite3.Connection, from_week: str | None = None) -> int:
    with conn:
        cur = (
            conn.execute("DELETE FROM plan_week WHERE week_start >= ?", (from_week,))
            if from_week
            else conn.execute("DELETE FROM plan_week")
        )
    return cur.rowcount


# --- the rest of the plan: intent, day split, settings ----------------------
#
# Stored as the JSON the page writes, read back whole. See
# migrations/017_plan_intent.sql for why these are not columns per kind.


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def plan_intents(
    conn: sqlite3.Connection, start: str | None = None, end: str | None = None
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM plan_intent"
    clauses, args = [], []
    if start:
        clauses.append("week_start >= ?")
        args.append(start)
    if end:
        clauses.append("week_start <= ?")
        args.append(end)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    return [
        {
            "week_start": r["week_start"],
            "kinds": json.loads(r["kinds"]),
            "note": r["note"],
            "updated_at": r["updated_at"],
        }
        for r in conn.execute(sql + " ORDER BY week_start", args)
    ]


def put_plan_intent(
    conn: sqlite3.Connection, week_start: str, kinds: dict[str, int], note: str
) -> None:
    """One row per week; writing replaces."""
    conn.execute(
        "INSERT INTO plan_intent (week_start, kinds, note, updated_at) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(week_start) DO UPDATE SET "
        "kinds = excluded.kinds, note = excluded.note, updated_at = excluded.updated_at",
        (week_start, json.dumps(kinds, sort_keys=True), note, _now()),
    )


def delete_plan_intent(conn: sqlite3.Connection, week_start: str) -> int:
    return conn.execute("DELETE FROM plan_intent WHERE week_start = ?", (week_start,)).rowcount


def plan_days_rows(
    conn: sqlite3.Connection, start: str | None = None, end: str | None = None
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM plan_days"
    clauses, args = [], []
    if start:
        clauses.append("week_start >= ?")
        args.append(start)
    if end:
        clauses.append("week_start <= ?")
        args.append(end)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    return [
        {
            "week_start": r["week_start"],
            "km": json.loads(r["km"]),
            "match": json.loads(r["match"]),
            "updated_at": r["updated_at"],
        }
        for r in conn.execute(sql + " ORDER BY week_start", args)
    ]


def put_plan_days(
    conn: sqlite3.Connection, week_start: str, km: dict[str, float], match: list[str]
) -> None:
    conn.execute(
        "INSERT INTO plan_days (week_start, km, match, updated_at) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(week_start) DO UPDATE SET "
        "km = excluded.km, match = excluded.match, updated_at = excluded.updated_at",
        (week_start, json.dumps(km, sort_keys=True), json.dumps(sorted(match)), _now()),
    )


def delete_plan_days(conn: sqlite3.Connection, week_start: str) -> int:
    return conn.execute("DELETE FROM plan_days WHERE week_start = ?", (week_start,)).rowcount


def get_setting(conn: sqlite3.Connection, key: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM setting WHERE key = ?", (key,)).fetchone()


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, value, _now()),
    )


def delete_setting(conn: sqlite3.Connection, key: str) -> int:
    return conn.execute("DELETE FROM setting WHERE key = ?", (key,)).rowcount


def weeks_between(conn: sqlite3.Connection, start: str, end: str) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT * FROM week WHERE start_date BETWEEN ? AND ? ORDER BY start_date",
            (start, end),
        )
    )


def week_row(conn: sqlite3.Connection, start_date: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM week WHERE start_date = ?", (start_date,)).fetchone()


# --- metrics --------------------------------------------------------------

_METRIC_COLUMNS = (
    "bodyweight_kg",
    "hrv_ms",
    "resting_hr",
    "readiness",
    "body_battery_high",
    "body_battery_low",
    "sleep_hours",
    # 015 — same two payloads, more of what they carry.
    "sleep_score",
    "deep_min",
    "rem_min",
    "awake_min",
    "sleep_start_local",
    "sleep_end_local",
    "stress_avg",
    "steps",
    "intensity_moderate_min",
    "intensity_vigorous_min",
    "body_battery_wake",
    "body_battery_charged",
    # 016 — Garmin's personal thresholds.
    "hrv_status",
    "hrv_balanced_low",
    "hrv_balanced_high",
    "hrv_low_upper",
    "sleep_need_min",
)


def upsert_metric_daily(conn: sqlite3.Connection, date: str, **values: Any) -> None:
    """Write only the fields present. A missing field never overwrites data.

    Garmin backfills and revises overnight metrics, so a later sync legitimately
    updates a row — but a metric that failed to fetch must leave the existing
    value alone rather than nulling it.
    """
    fields = {k: v for k, v in values.items() if k in _METRIC_COLUMNS and v is not None}
    if not fields:
        return
    cols = ", ".join(fields)
    placeholders = ", ".join("?" for _ in fields)
    updates = ", ".join(f"{c} = excluded.{c}" for c in fields)
    conn.execute(
        f"INSERT INTO metric_daily (date, {cols}) VALUES (?, {placeholders}) "
        f"ON CONFLICT(date) DO UPDATE SET {updates}",
        (date, *fields.values()),
    )


def metrics_between(conn: sqlite3.Connection, start: str, end: str) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT * FROM metric_daily WHERE date BETWEEN ? AND ? ORDER BY date",
            (start, end),
        )
    )


def bodyweight_series(conn: sqlite3.Connection, start: str, end: str) -> list[tuple[str, float]]:
    return [
        (r["date"], float(r["bodyweight_kg"]))
        for r in conn.execute(
            "SELECT date, bodyweight_kg FROM metric_daily "
            "WHERE date BETWEEN ? AND ? AND bodyweight_kg IS NOT NULL ORDER BY date",
            (start, end),
        )
    ]


# --- analysis -------------------------------------------------------------


def top_exercises(
    conn: sqlite3.Connection, start: str, end: str, limit: int = 5
) -> list[sqlite3.Row]:
    """Most-trained exercises by working-set count in the range."""
    return list(
        conn.execute(
            "SELECT e.id, e.name, COUNT(*) AS sets FROM lift_set ls "
            "JOIN session s ON s.id = ls.session_id "
            "JOIN exercise e ON e.id = ls.exercise_id "
            "WHERE s.date BETWEEN ? AND ? AND ls.is_warmup = 0 "
            "GROUP BY e.id, e.name ORDER BY sets DESC, e.name LIMIT ?",
            (start, end, limit),
        )
    )


def e1rm_by_session(
    conn: sqlite3.Connection, exercise_id: int, start: str, end: str
) -> list[tuple[str, float]]:
    """(date, best e1RM) per session. Epley inline; mirrors core.e1rm exactly.

    Only working sets at 10 reps or fewer, per BRIEF §6.
    """
    return [
        (r["date"], float(r["v"]))
        for r in conn.execute(
            "SELECT s.date AS date, MAX(ls.weight * (1 + ls.reps / 30.0)) AS v "
            "FROM lift_set ls JOIN session s ON s.id = ls.session_id "
            "WHERE ls.exercise_id = ? AND s.date BETWEEN ? AND ? "
            "  AND ls.is_warmup = 0 AND ls.reps <= 10 AND ls.weight > 0 "
            "GROUP BY s.id, s.date HAVING v IS NOT NULL ORDER BY s.date",
            (exercise_id, start, end),
        )
    ]


# --- week notes (bullets) -------------------------------------------------


def week_notes(conn: sqlite3.Connection, week_start: str) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT * FROM week_note WHERE week_start = ? ORDER BY position, id",
            (week_start,),
        )
    )


def add_week_note(conn: sqlite3.Connection, week_start: str, text: str) -> int:
    """Append a bullet. Position is assigned, not supplied, so it cannot clash."""
    nxt = conn.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM week_note WHERE week_start = ?",
        (week_start,),
    ).fetchone()["n"]
    cur = conn.execute(
        "INSERT INTO week_note (week_start, position, text, created_at) "
        "VALUES (?, ?, ?, ?)",
        (week_start, int(nxt), text.strip(),
         datetime.now(UTC).isoformat(timespec="seconds")),
    )
    return int(cur.lastrowid)


def update_week_note(conn: sqlite3.Connection, note_id: int, **fields: Any) -> None:
    allowed = {k: v for k, v in fields.items() if k in ("text", "position")}
    if not allowed:
        return
    sets = ", ".join(f"{k} = :{k}" for k in allowed)
    conn.execute(f"UPDATE week_note SET {sets} WHERE id = :id", {**allowed, "id": note_id})


def delete_week_note(conn: sqlite3.Connection, note_id: int) -> None:
    conn.execute("DELETE FROM week_note WHERE id = ?", (note_id,))


def week_note_by_id(conn: sqlite3.Connection, note_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM week_note WHERE id = ?", (note_id,)).fetchone()


def enrich_from_garmin(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    estimated_rpe: float | None = None,
    rpe_method: str | None = None,
    garmin_load: float | None = None,
    zones: dict[str, int] | None = None,
    garmin_name: str | None = None,
) -> None:
    """Attach the watch's intensity signal without overwriting a real RPE.

    A perceived-exertion number the user actually tapped always wins; this
    only fills a blank. The estimate records how it was derived so the UI can
    say so, and Garmin's own load is stored beside it rather than merged into
    it — different scales, different meanings (see mapping.garmin_load).
    """
    row = conn.execute(
        "SELECT rpe, detail FROM session WHERE id = ?", (session_id,)
    ).fetchone()
    if row is None:
        return

    try:
        detail = json.loads(row["detail"] or "{}")
    except json.JSONDecodeError:
        detail = {}
    if not isinstance(detail, dict):
        detail = {}

    if garmin_load is not None:
        detail["garmin_load"] = garmin_load

    # What the watch called this activity, kept so a later rename can tell an
    # untouched Garmin label from something the user actually wrote.
    if garmin_name:
        detail["garmin_name"] = garmin_name

    # A hand-written split wins: the notebook is the user's own reading of the
    # session and the watch only fills a blank, the same rule RPE follows.
    #
    # But a split the watch itself wrote is the watch's to correct. Without
    # `zones_source` the first version written was permanent, so a parsing fix
    # could never reach the rows it was written to fix — and re-syncing, the
    # one thing anybody would try, would silently do nothing.
    if zones and (not detail.get("zones") or detail.get("zones_source") == "garmin"):
        detail["zones"] = zones
        detail["zones_source"] = "garmin"

    set_rpe = row["rpe"] is None and estimated_rpe is not None
    if set_rpe:
        detail["rpe_source"] = rpe_method
        detail["rpe_estimated"] = True

    conn.execute(
        "UPDATE session SET detail = ?, rpe = COALESCE(rpe, ?) WHERE id = ?",
        (json.dumps(detail, sort_keys=True), estimated_rpe, session_id),
    )


def manual_sessions_between(
    conn: sqlite3.Connection, start: str, end: str
) -> list[sqlite3.Row]:
    """Hand-entered sessions in a date range.

    Used to stop a Garmin backfill running over dates the notebook already
    covers. For those weeks the notebook is the record — the watch's version of
    the same session arrives as a *second* row, because `_merge_target` only
    joins a Garmin strength activity to a manual lift and nothing else. A
    "Power Zone + abs" bike session and the watch's 11-minute "Strength" are the
    same half-hour, and no rule in this codebase can see that.
    """
    return list(conn.execute(
        "SELECT id, date, kind, duration_min, notes FROM session "
        "WHERE source = 'manual' AND date BETWEEN ? AND ? ORDER BY date",
        (start, end),
    ))


def week_number_for(conn: sqlite3.Connection, week_start: str) -> int | None:
    """The notebook's own week number for a Monday.

    A page that has not been written yet still has a number: the counter
    continues from the last page that was. Without this, the current week
    silently falls back to counting calendar weeks, which is a *different*
    basis — 84 rather than 86 — and the average jumps every Monday for no
    reason the user can see.
    """
    row = conn.execute(
        "SELECT week_number FROM week WHERE start_date = ?", (week_start,)
    ).fetchone()
    if row and row["week_number"]:
        return int(row["week_number"])

    latest = conn.execute(
        "SELECT start_date, week_number FROM week "
        "WHERE week_number IS NOT NULL AND start_date < ? "
        "ORDER BY start_date DESC LIMIT 1",
        (week_start,),
    ).fetchone()
    if not latest:
        return None

    weeks_since = (
        datetime.fromisoformat(week_start).date()
        - datetime.fromisoformat(latest["start_date"]).date()
    ).days // 7
    return int(latest["week_number"]) + weeks_since


# --- habits ---------------------------------------------------------------

#: Fields a habit definition will accept from the API. `key` and `mode` are
#: fixed at creation: the key addresses the habit from the front end and from
#: the score, and the mode decides which of `habit_day`'s two columns means
#: anything for it. Changing either under an existing history would silently
#: reinterpret every day already recorded.
_HABIT_FIELDS = (
    "name",
    "source_field",
    "target",
    "partial_at",
    "unit",
    "polarity",
    "position",
    "archived_at",
)


def habits(conn: sqlite3.Connection, *, include_archived: bool = False) -> list[sqlite3.Row]:
    sql = "SELECT * FROM habit"
    if not include_archived:
        sql += " WHERE archived_at IS NULL"
    return list(conn.execute(f"{sql} ORDER BY position, id"))


def habit_by_key(conn: sqlite3.Connection, key: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM habit WHERE key = ?", (key,)).fetchone()


def habit_by_id(conn: sqlite3.Connection, habit_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM habit WHERE id = ?", (habit_id,)).fetchone()


def add_habit(
    conn: sqlite3.Connection,
    key: str,
    name: str,
    *,
    mode: str = "manual",
    polarity: str = "do",
    source_field: str | None = None,
    target: float | None = None,
    partial_at: float | None = None,
    unit: str | None = None,
) -> int:
    """Create a habit. Position is assigned, never supplied, so it cannot clash."""
    nxt = conn.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM habit"
    ).fetchone()["n"]
    cur = conn.execute(
        "INSERT INTO habit (key, name, mode, source_field, target, partial_at, "
        "unit, polarity, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (key, name.strip(), mode, source_field, target, partial_at, unit, polarity,
         int(nxt), datetime.now(UTC).isoformat(timespec="seconds")),
    )
    return int(cur.lastrowid)


def update_habit(conn: sqlite3.Connection, habit_id: int, **fields: Any) -> None:
    allowed = {k: v for k, v in fields.items() if k in _HABIT_FIELDS}
    if not allowed:
        return
    sets = ", ".join(f"{k} = :{k}" for k in allowed)
    conn.execute(f"UPDATE habit SET {sets} WHERE id = :id", {**allowed, "id": habit_id})


def habit_days(conn: sqlite3.Connection, start: str, end: str) -> list[sqlite3.Row]:
    """Every recorded day in the window, for every habit including archived ones.

    Archived habits are included deliberately: a window that covers weeks when
    the habit was live still has to be able to show what happened in them.
    Filtering is the caller's decision, and `report/habits.py` makes it once.
    """
    return list(
        conn.execute(
            "SELECT hd.*, h.key FROM habit_day hd JOIN habit h ON h.id = hd.habit_id "
            "WHERE hd.date BETWEEN ? AND ? ORDER BY hd.date",
            (start, end),
        )
    )


def mark_habit_day(
    conn: sqlite3.Connection,
    habit_id: int,
    day: str,
    *,
    done: bool | None = None,
    value: float | None = None,
) -> None:
    """Record one day. Replaces whatever was there — a day has one answer.

    `done` is for a manual habit, `value` for an override of a measured one.
    Passing both is accepted rather than refused: the row keeps both columns,
    and `resolve_day` reads only the one its mode makes meaningful.
    """
    conn.execute(
        "INSERT INTO habit_day (habit_id, date, done, value, marked_at) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(habit_id, date) DO UPDATE SET "
        "done = excluded.done, value = excluded.value, marked_at = excluded.marked_at",
        (habit_id, day, None if done is None else int(done), value,
         datetime.now(UTC).isoformat(timespec="seconds")),
    )


def clear_habit_day(conn: sqlite3.Connection, habit_id: int, day: str) -> None:
    """Unmark a day. The row goes rather than being set to zero.

    For a manual habit those are the same thing; for a metric one they are not
    — deleting the override hands the day back to the sync's own number, which
    is what "undo my correction" has to mean.
    """
    conn.execute("DELETE FROM habit_day WHERE habit_id = ? AND date = ?", (habit_id, day))
