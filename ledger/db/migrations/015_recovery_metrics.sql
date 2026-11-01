-- 015_recovery_metrics.sql
--
-- The sync already pulls get_stats_and_body and get_sleep_data every night
-- and keeps one number from each. The same payloads carry the rest of what a
-- recovery page needs, so these columns cost no extra API call:
--
--   from get_sleep_data        sleep_score, deep_min, rem_min, awake_min,
--                              sleep_start_local, sleep_end_local
--   from get_stats_and_body    stress_avg, steps, intensity_moderate_min,
--                              intensity_vigorous_min, body_battery_wake,
--                              body_battery_charged
--
-- Minutes, not seconds, so a row reads the way the page prints it. Light
-- sleep is the remainder: sleep_hours*60 - deep - rem - awake. Timestamps are
-- local ISO ("2026-10-29T23:59"), which is what bedtime consistency needs.
--
-- Everything stays nullable. A night the watch was not worn is a null, never
-- a zero, so no average is dragged down by a missing row.

ALTER TABLE metric_daily ADD COLUMN sleep_score            INTEGER;
ALTER TABLE metric_daily ADD COLUMN deep_min               INTEGER;
ALTER TABLE metric_daily ADD COLUMN rem_min                INTEGER;
ALTER TABLE metric_daily ADD COLUMN awake_min              INTEGER;
ALTER TABLE metric_daily ADD COLUMN sleep_start_local      TEXT;
ALTER TABLE metric_daily ADD COLUMN sleep_end_local        TEXT;
ALTER TABLE metric_daily ADD COLUMN stress_avg             INTEGER;
ALTER TABLE metric_daily ADD COLUMN steps                  INTEGER;
ALTER TABLE metric_daily ADD COLUMN intensity_moderate_min INTEGER;
ALTER TABLE metric_daily ADD COLUMN intensity_vigorous_min INTEGER;
ALTER TABLE metric_daily ADD COLUMN body_battery_wake      INTEGER;
ALTER TABLE metric_daily ADD COLUMN body_battery_charged   INTEGER;
