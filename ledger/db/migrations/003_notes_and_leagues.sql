-- 003_notes_and_leagues.sql
--
-- Two changes, both driven by how the record is actually kept.
--
-- 1. Week notes were a single text blob, so the notebook's "Notes:" block —
--    which is always a list of separate observations — could only be edited
--    all-or-nothing. Each bullet is now its own row: addable, editable and
--    deletable on its own. The start-of-week weigh-in stays where it was, on
--    `week`, because it is one number per week and not a note.
--
-- 2. Two standing fixtures have public league pages carrying the schedule and
--    the table. Those are external facts about a season, not sessions, and
--    they cannot be derived from anything already stored — so they get tables
--    rather than being forced into `session`.

CREATE TABLE week_note (
    id         INTEGER PRIMARY KEY,
    week_start TEXT NOT NULL,              -- Monday, matches week.start_date
    position   INTEGER NOT NULL DEFAULT 0, -- order as written on the page
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_week_note_week ON week_note(week_start, position);

-- Carry the existing blobs across as bullets, splitting on newlines and on the
-- leading "- " the notebook uses. Anything without a separator becomes a
-- single bullet, so nothing written so far is lost.
INSERT INTO week_note (week_start, position, text, created_at)
SELECT start_date, 0, trim(notes), datetime('now')
FROM week
WHERE notes IS NOT NULL AND trim(notes) <> '';

CREATE TABLE league (
    id          INTEGER PRIMARY KEY,
    provider_id TEXT NOT NULL UNIQUE,      -- provider league id, e.g. '123456' or 'daysmart:42'
    name        TEXT NOT NULL,
    my_team     TEXT NOT NULL,             -- the team to highlight
    fixture     TEXT,                      -- maps to session detail.team
    url         TEXT NOT NULL,
    fetched_at  TEXT
);

CREATE TABLE league_standing (
    league_id INTEGER NOT NULL REFERENCES league(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    team      TEXT NOT NULL,
    gp        INTEGER, w INTEGER, l INTEGER, t INTEGER,
    gf        INTEGER, ga INTEGER, pts INTEGER, gd INTEGER,
    wp        REAL,
    PRIMARY KEY (league_id, team)
);

CREATE TABLE league_fixture (
    id          INTEGER PRIMARY KEY,
    league_id   INTEGER NOT NULL REFERENCES league(id) ON DELETE CASCADE,
    date        TEXT,                      -- local YYYY-MM-DD, as everywhere
    time_text   TEXT,                      -- kickoff or final score, as printed
    home        TEXT NOT NULL,
    away        TEXT NOT NULL,
    home_score  INTEGER,
    away_score  INTEGER,
    played      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (league_id, date, home, away)
);

CREATE INDEX idx_league_fixture_date ON league_fixture(date);
