-- 002_notebook_reality.sql
--
-- 001 implemented BRIEF §4, which assumed a barbell-centric log. The actual
-- notebook (84 weeks, 2025-01-01 .. 2026-08-03, transcribed from notebook/)
-- is activity-centric: soccer matches with scorelines and goal/assist counts,
-- runs with pace and Garmin coach compliance, Peloton bike rides, rucks,
-- fasts, and lifting recorded as rep-count series rather than weight x reps.
--
-- Rather than model each modality separately, `session` gains the two columns
-- every endurance entry needs (distance, pace) plus a `detail` JSON blob for
-- the modality-specific fields. See docs/NOTEBOOK.md for the full analysis.

-- --- session.kind gains the kinds the notebook actually uses -------------
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. This is
-- the only reason for a rebuild; do not make a habit of it.

CREATE TABLE session_new (
    id                 INTEGER PRIMARY KEY,
    date               TEXT NOT NULL,
    started_at         TEXT,
    ended_at           TEXT,
    kind               TEXT NOT NULL
        CHECK (kind IN ('lift','run','soccer','bike','ruck','fast','other')),
    rpe                REAL CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10)),
    duration_min       REAL,
    notes              TEXT,
    garmin_activity_id TEXT UNIQUE,
    source             TEXT NOT NULL
        CHECK (source IN ('manual','garmin','notebook')),

    -- New. Endurance entries are recorded as distance + time, never sets.
    distance_km        REAL,
    -- Derived from distance and duration, stored because every run line in
    -- the notebook records it explicitly and it is what the user compares.
    pace_s_per_km      REAL,

    -- Modality-specific fields as JSON. Keys by kind:
    --   soccer  {"result":"W|L|D","gf":7,"ga":4,"goals":3,"assists":0,
    --            "pickup":false}
    --   run     {"workout":"Easy Run","compliance_pct":77,
    --            "zones":{"z1":31,"z2":42},"surface":"treadmill"}
    --   bike    {"class":"30min Power Zone Endurance"}
    --   ruck    {"load_lbs":16.5}
    --   fast    {"hours":72}
    --   lift    {"reps":[30,100,95,45,75],"scope":"home|work|small home"}
    detail             TEXT
);

INSERT INTO session_new
    (id, date, started_at, ended_at, kind, rpe, duration_min, notes,
     garmin_activity_id, source)
SELECT id, date, started_at, ended_at, kind, rpe, duration_min, notes,
       garmin_activity_id, source
FROM session;

DROP TABLE session;
ALTER TABLE session_new RENAME TO session;

CREATE INDEX idx_session_date ON session(date);
CREATE INDEX idx_session_kind_date ON session(kind, date);

-- --- the week is the notebook's unit of record ---------------------------
-- One row per notebook page header. Kept 1:1 with the paper so a transcribed
-- week can be diffed against the photo. The `avg_activities_per_week` column
-- is the boxed number on each page: cumulative activities / weeks elapsed.
-- It is stored as written rather than recomputed, so drift between the paper
-- and the database is visible instead of silently corrected.

CREATE TABLE week (
    start_date              TEXT PRIMARY KEY,   -- Monday, YYYY-MM-DD
    week_number             INTEGER,            -- as written; NOT contiguous
    bodyweight_lbs          REAL,               -- start-of-week weigh-in
    avg_activities_per_week REAL,               -- the boxed number
    notes                   TEXT,               -- the Notes: block
    source                  TEXT NOT NULL DEFAULT 'notebook'
);

CREATE INDEX idx_week_number ON week(week_number);
