-- 011_habits.sql
--
-- Daily habits: the small things that hold the training up.
--
-- These are deliberately NOT sessions. A habit tick carries no load, no RPE and
-- no duration, and it never reaches `session` — so it cannot inflate the
-- activities-per-week figure the whole record is built on, cannot move ACWR,
-- and cannot appear in the log. Stretching for thirty minutes is a thing you
-- did; it is not a training session, and the moment it becomes one the boxed
-- number on every page means something different than it did last week.
--
-- ── Two kinds of habit, one table ────────────────────────────────────────────
--
-- `mode = 'manual'` is tapped. A row in `habit_day` means the day was marked;
-- no row means it was not. There is no third state, because three states is
-- two taps and the whole point of this feature is one.
--
-- `mode = 'metric'` is measured. Sleep is already synced nightly into
-- `metric_daily.sleep_hours` — 242 nights of it before this table existed — so
-- asking the user to tick a box for something the watch already knows would
-- be data entry for its own sake. A metric habit reads `source_field` out of
-- `metric_daily` and decides the day from `target` and `partial_at`. A row in
-- `habit_day` for a metric habit is an OVERRIDE and nothing else: `value`
-- holds the hand-entered number, the same way a session's RPE can be typed
-- over the one Garmin inferred. The sync never touches it.
--
-- That means `habit_day` columns mean different things per mode, which is
-- worth the discomfort of writing down rather than splitting into two tables
-- nobody would keep in step:
--
--   manual habit → `done` is the answer.        `value` is NULL.
--   metric habit → `value` is the answer.       `done` is NULL.
--
-- `ledger/report/habits.py::resolve_day` is the only thing that applies that
-- rule. Nothing else in the codebase reads these columns directly.
--
-- ── Why there is no streak column ────────────────────────────────────────────
--
-- Habits are where streaks get into a product. BRIEF and CLAUDE.md both rule
-- them out, and the Scoreboard's exception did not extend to them: rolling
-- rates over 7 and 28 days only, which can fall and recover without anything
-- resetting to zero and without a run of good days becoming a thing to
-- protect. There is nothing here to count consecutively from, on purpose.

CREATE TABLE habit (
    id           INTEGER PRIMARY KEY,
    -- Stable slug. The UI and the score address a habit by this, never by id,
    -- so a rename cannot orphan a surface.
    key          TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    mode         TEXT NOT NULL CHECK (mode IN ('manual', 'metric')),

    -- Metric habits only. `source_field` must be a column of `metric_daily`.
    source_field TEXT,
    -- The number that earns the tick. 8 hours of sleep.
    target       REAL,
    -- The number below which the day earns nothing. Between this and `target`
    -- the day earns partial credit, so a 7.5 h night reads as progress rather
    -- than a failure — without moving the tick, which stays at `target`.
    partial_at   REAL,
    unit         TEXT,

    -- 'avoid' reverses only the words, never the arithmetic: the tick still
    -- means "a good day", it is just earned by not doing the thing.
    polarity     TEXT NOT NULL DEFAULT 'do' CHECK (polarity IN ('do', 'avoid')),

    position     INTEGER NOT NULL DEFAULT 0,
    -- Archived rather than deleted: dropping a habit must not rewrite the
    -- weeks you kept it. An archived habit stops being scored and stops being
    -- offered; its history stays readable.
    archived_at  TEXT,
    created_at   TEXT NOT NULL
);

CREATE TABLE habit_day (
    habit_id  INTEGER NOT NULL REFERENCES habit(id) ON DELETE CASCADE,
    date      TEXT NOT NULL,             -- YYYY-MM-DD local, as everywhere
    done      INTEGER CHECK (done IN (0, 1)),
    value     REAL,
    marked_at TEXT NOT NULL,
    PRIMARY KEY (habit_id, date)
);

CREATE INDEX idx_habit_day_date ON habit_day (date);

-- The three the user asked for. Seeded rather than left to the UI so a fresh
-- database opens on a working page instead of an empty state with a form.
INSERT INTO habit (key, name, mode, source_field, target, partial_at, unit, polarity, position, created_at)
VALUES
    ('stretch',      'Stretch 30 min', 'manual', NULL,          NULL, NULL, NULL, 'do',    0, datetime('now')),
    ('sleep',        'Sleep 8h',       'metric', 'sleep_hours', 8.0,  7.0,  'h',  'do',    1, datetime('now')),
    ('no_takeout',   'No takeout',     'manual', NULL,          NULL, NULL, NULL, 'avoid', 2, datetime('now'));
