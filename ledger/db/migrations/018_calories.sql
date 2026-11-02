-- 018_calories.sql
--
-- Calories: what the watch says went out, and what the user says went in.
--
-- The burn columns come from get_stats_and_body, which the nightly sync
-- already fetches, so they cost no extra call. They are what Garmin reports
-- AT FETCH TIME, and that matters: on an unfinished day Garmin pro-rates
-- bmrKilocalories to the hours elapsed (18:36 reads about three quarters of
-- the full-day figure) while activeKilocalories is the running total so far.
-- `day_elapsed_min` is durationInMilliseconds from the same payload, so a
-- row says how much of the day it describes; 1440 is a finished day. The
-- 03:00 nightly writes a three-hour row for "today" by design, and without
-- this column that would read as a day's burn.
--
-- `ledger/report/calories.py` is the only thing that interprets these.
-- Nothing else reads calories_total as a day's burn.

ALTER TABLE metric_daily ADD COLUMN calories_total      INTEGER;
ALTER TABLE metric_daily ADD COLUMN calories_active     INTEGER;
ALTER TABLE metric_daily ADD COLUMN calories_bmr        INTEGER;
ALTER TABLE metric_daily ADD COLUMN day_elapsed_min     INTEGER;
ALTER TABLE metric_daily ADD COLUMN calories_fetched_at TEXT;

-- A meal is a number on a day. Free rows rather than fixed slots, because a
-- day can have two snacks; `label` is a word from the quick chips or anything
-- typed, not an enum. Hard delete: a meal is the user's own entry, nothing
-- references it, no aggregate stores it (a day's sum is always recomputed),
-- and there is no kept history to protect the way an archived habit has.
CREATE TABLE meal (
    id          INTEGER PRIMARY KEY,
    date        TEXT NOT NULL,                       -- YYYY-MM-DD local
    label       TEXT NOT NULL DEFAULT '',
    kcal        INTEGER NOT NULL CHECK (kcal > 0 AND kcal <= 5000),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX idx_meal_date ON meal (date);
