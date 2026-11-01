-- 017_plan_intent.sql
--
-- The rest of the plan moves to the server.
--
-- `plan_week` (006) holds the committed distance ramp, and that half of the
-- Plan page has always been shared between devices. The other half — how
-- many sessions of each kind a week is for, how a week's distance is spread
-- over its days, and the goal weight the Scoreboard scores movement toward —
-- lived in one browser's localStorage, so a plan written at a desk did not
-- exist on the phone. These three tables are that half, written down.
--
-- The shapes are exactly what the front end stored, as JSON text: the data
-- is small, read as a whole and never queried by field, and a column per
-- kind would have to change every time a kind is added.

-- Planned counts per modality for a week. A week with no row inherits the
-- most recent earlier one; that rule lives in the front end (`weekIntent`)
-- because it is a presentation of the record, not a fact in it.
CREATE TABLE plan_intent (
    -- The Monday.
    week_start  TEXT PRIMARY KEY,
    -- {"run": 3, "soccer": 2} — kind -> planned count, only kinds above zero.
    kinds       TEXT NOT NULL DEFAULT '{}',
    note        TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL
);

-- How a week's committed distance is spread over its seven days, and which
-- days the user says they are playing on (the league schedule supplies the
-- published ones).
CREATE TABLE plan_days (
    week_start  TEXT PRIMARY KEY,
    -- {"2026-09-08": 5.0} — date -> planned km.
    km          TEXT NOT NULL DEFAULT '{}',
    -- ["2026-09-09"] — match days the user marked.
    match       TEXT NOT NULL DEFAULT '[]',
    updated_at  TEXT NOT NULL
);

-- One-row-per-key settings. The goal weight is the first; anything else the
-- app has to remember for its one user and that is not a session, a week or
-- a habit belongs here rather than in a browser.
CREATE TABLE setting (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
