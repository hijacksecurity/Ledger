-- 004_more_kinds.sql
--
-- "Quick feet" and "Ab attack" are regular, deliberate workouts — 30-odd of
-- them across the record — and filing both under 'other' made two of the five
-- things actually done every week invisible in every chart that splits by
-- modality.
--
-- Kinds after this: soccer, run, lift, ab, quickfeet, bike, ruck, fast, other.
-- 'other' goes back to meaning "genuinely one-off", which is what it is for.

CREATE TABLE session_new (
    id                 INTEGER PRIMARY KEY,
    date               TEXT NOT NULL,
    started_at         TEXT,
    ended_at           TEXT,
    kind               TEXT NOT NULL
        CHECK (kind IN ('lift','run','soccer','bike','ruck','fast',
                        'ab','quickfeet','other')),
    rpe                REAL CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10)),
    duration_min       REAL,
    notes              TEXT,
    garmin_activity_id TEXT UNIQUE,
    source             TEXT NOT NULL
        CHECK (source IN ('manual','garmin','notebook')),
    distance_km        REAL,
    pace_s_per_km      REAL,
    detail             TEXT
);

INSERT INTO session_new
SELECT id, date, started_at, ended_at, kind, rpe, duration_min, notes,
       garmin_activity_id, source, distance_km, pace_s_per_km, detail
FROM session;

DROP TABLE session;
ALTER TABLE session_new RENAME TO session;

CREATE INDEX idx_session_date ON session(date);
CREATE INDEX idx_session_kind_date ON session(kind, date);

-- Reclassify what is already recorded, by what the note says. Matching is
-- deliberately narrow: only the two names in question, and only sessions
-- currently filed as 'other', so nothing already classified is disturbed.
UPDATE session SET kind = 'quickfeet'
WHERE kind = 'other'
  AND (lower(notes) LIKE '%quick feet%' OR lower(notes) LIKE '%quickfeet%');

UPDATE session SET kind = 'ab'
WHERE kind = 'other'
  AND (lower(notes) LIKE '%ab attack%' OR lower(notes) LIKE '%abs%');
