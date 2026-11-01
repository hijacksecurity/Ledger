-- 016_garmin_bands.sql
--
-- The two personal thresholds Garmin computes and the Recovery page reads
-- figures against. Neither is a population number:
--
--   hrv_balanced_low / hrv_balanced_high   the night's HRV is "balanced" when
--                                          it sits inside this range, which
--                                          Garmin fits to the wearer's own
--                                          three-week history; hrv_low_upper
--                                          is the top of its "low" band
--   hrv_status                             Garmin's word for the night, kept
--                                          verbatim (BALANCED, UNBALANCED, LOW,
--                                          POOR, ...) so a changed vocabulary
--                                          shows up as a new string, not a
--                                          silent misclassification
--   sleep_need_min                         how much sleep Garmin says this
--                                          wearer needed that night, in
--                                          minutes — the line a night is
--                                          judged short or full against
--
-- From get_hrv_data and get_sleep_data, both already fetched nightly.

ALTER TABLE metric_daily ADD COLUMN hrv_status        TEXT;
ALTER TABLE metric_daily ADD COLUMN hrv_balanced_low  INTEGER;
ALTER TABLE metric_daily ADD COLUMN hrv_balanced_high INTEGER;
ALTER TABLE metric_daily ADD COLUMN hrv_low_upper     INTEGER;
ALTER TABLE metric_daily ADD COLUMN sleep_need_min    INTEGER;
