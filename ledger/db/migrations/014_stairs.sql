-- 014_stairs.sql
--
-- Stairs is a kind.
--
-- The watch records a stair session as Garmin's `floor_climbing` type, which
-- the mapping filed under 'other' — and 'other' is the one kind that carries
-- no distance anywhere: the Running page, the weekly on-foot total, the ramp
-- and the plan all ignored the 1.3 km of "Riverside Floor Climb" on
-- 19 Sep 2026. It is on the legs, so it counts. Same reasoning as 004 gave
-- quick feet its own kind: a regular, deliberate workout should not be
-- invisible in every chart that splits by modality.
--
-- Kinds after this: soccer, run, stairs, lift, ab, quickfeet, bike, ruck,
-- fast, other. SQLite cannot alter a CHECK, so the table is rebuilt exactly
-- as 004 did, with the column 007 added kept in place.

CREATE TABLE session_new (
    id                 INTEGER PRIMARY KEY,
    date               TEXT NOT NULL,
    started_at         TEXT,
    ended_at           TEXT,
    kind               TEXT NOT NULL
        CHECK (kind IN ('lift','run','soccer','bike','ruck','fast',
                        'ab','quickfeet','stairs','other')),
    rpe                REAL CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10)),
    duration_min       REAL,
    notes              TEXT,
    garmin_activity_id TEXT UNIQUE,
    source             TEXT NOT NULL
        CHECK (source IN ('manual','garmin','notebook')),
    distance_km        REAL,
    pace_s_per_km      REAL,
    detail             TEXT,
    kind_locked        INTEGER NOT NULL DEFAULT 0
);

INSERT INTO session_new
SELECT id, date, started_at, ended_at, kind, rpe, duration_min, notes,
       garmin_activity_id, source, distance_km, pace_s_per_km, detail,
       kind_locked
FROM session;

DROP TABLE session;
ALTER TABLE session_new RENAME TO session;

CREATE INDEX idx_session_date ON session(date);
CREATE INDEX idx_session_kind_date ON session(kind, date);

-- Reclassify what is already recorded, by what the watch named it. Narrow on
-- purpose: only sessions currently filed as 'other', and only names that say
-- stairs or floor climb. Locked, so the next sync cannot write 'other' back.
UPDATE session
   SET kind = 'stairs', kind_locked = 1
 WHERE kind = 'other'
   AND (lower(notes) LIKE '%floor climb%' OR lower(notes) LIKE '%stair%');
