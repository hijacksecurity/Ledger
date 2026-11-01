-- 001_init.sql — initial schema (BRIEF §4).
--
-- Everything else is a view or a computed query. Do not add tables until an
-- actual query becomes impossible. Resist normalizing further.
--
-- All weights are stored in kilograms. Display unit is a config value.
-- All dates are LOCAL date strings 'YYYY-MM-DD'. Never store UTC: a 21:30
-- soccer game must aggregate to the day it was played (BRIEF §5).

CREATE TABLE exercise (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,       -- canonical, e.g. "Barbell Back Squat"
    aliases     TEXT,                       -- JSON array: ["squat","bb squat","sq"]
    modality    TEXT NOT NULL
        CHECK (modality IN ('barbell','dumbbell','machine','bodyweight','cable')),
    created_at  TEXT NOT NULL
);

CREATE TABLE session (
    id                 INTEGER PRIMARY KEY,
    date               TEXT NOT NULL,       -- local date, YYYY-MM-DD
    started_at         TEXT,                -- ISO8601 local
    ended_at           TEXT,
    kind               TEXT NOT NULL
        CHECK (kind IN ('lift','run','soccer','other')),
    rpe                REAL CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10)),
    duration_min       REAL,
    notes              TEXT,
    garmin_activity_id TEXT UNIQUE,         -- NULL for manually logged lifts
    source             TEXT NOT NULL
        CHECK (source IN ('manual','garmin'))
);

CREATE INDEX idx_session_date ON session(date);
CREATE INDEX idx_session_kind_date ON session(kind, date);

CREATE TABLE lift_set (
    id          INTEGER PRIMARY KEY,
    session_id  INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercise(id),
    set_index   INTEGER NOT NULL,
    weight      REAL NOT NULL,              -- kg
    reps        INTEGER NOT NULL,
    rpe         REAL CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10)),
    is_warmup   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_lift_set_session ON lift_set(session_id);
CREATE INDEX idx_lift_set_exercise ON lift_set(exercise_id);

CREATE TABLE metric_daily (
    date              TEXT PRIMARY KEY,     -- YYYY-MM-DD local
    bodyweight_kg     REAL,
    hrv_ms            REAL,
    resting_hr        INTEGER,
    readiness         INTEGER,
    body_battery_high INTEGER,
    body_battery_low  INTEGER,
    sleep_hours       REAL
);

CREATE TABLE pr (
    id          INTEGER PRIMARY KEY,
    exercise_id INTEGER NOT NULL REFERENCES exercise(id),
    kind        TEXT NOT NULL
        CHECK (kind IN ('e1rm','reps_at_weight','session_volume','first_time')),
    value       REAL NOT NULL,
    context     TEXT,                       -- JSON, e.g. {"weight":100,"reps":8}
    session_id  INTEGER REFERENCES session(id),
    date        TEXT NOT NULL
);

CREATE INDEX idx_pr_exercise_kind ON pr(exercise_id, kind);
CREATE INDEX idx_pr_date ON pr(date);

CREATE TABLE sync_log (
    id         INTEGER PRIMARY KEY,
    ran_at     TEXT NOT NULL,
    endpoint   TEXT NOT NULL,
    date_range TEXT,
    status     TEXT NOT NULL
        CHECK (status IN ('ok','error','rate_limited','skipped')),
    detail     TEXT
);

CREATE INDEX idx_sync_log_ran_at ON sync_log(ran_at);
