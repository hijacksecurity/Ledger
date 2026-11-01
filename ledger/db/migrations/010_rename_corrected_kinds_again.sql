-- 010_rename_corrected_kinds_again.sql
--
-- Re-apply the rename rule from 009 to sessions corrected since it ran.
--
-- 009 was a one-off sweep, and migrations run once. Every session corrected
-- after it kept the watch's label, because the live path that should have
-- renamed them never fired: `update_session` guarded the rename with
-- `"notes" not in updates`, and the edit form rebuilds a session from its
-- shorthand and so always sends `notes`. The guard is gone — the rule now
-- judges the incoming note — but the rows corrected in between are still
-- sitting there reading "Ab attack" in the title and "Strength" underneath.
--
-- Same statement, same conditions, same safety: only where a person chose the
-- modality (`kind_locked = 1`) and the note is still exactly what the watch
-- sent. Anything typed by the user differs from `garmin_name` and is left
-- alone. A note is not a label.
--
-- This is idempotent: rows already carrying the right label are rewritten to
-- the same value.

UPDATE session
   SET notes = CASE kind
                 WHEN 'ab'        THEN 'Ab attack'
                 WHEN 'quickfeet' THEN 'Quick feet'
                 WHEN 'lift'      THEN 'Lift'
                 WHEN 'run'       THEN 'Run'
                 WHEN 'soccer'    THEN 'Soccer'
                 WHEN 'bike'      THEN 'Bike'
                 WHEN 'ruck'      THEN 'Ruck'
                 WHEN 'fast'      THEN 'Fasting'
                 ELSE notes
               END
 WHERE kind_locked = 1
   AND json_valid(detail)
   AND json_extract(detail, '$.garmin_name') IS NOT NULL
   AND notes = json_extract(detail, '$.garmin_name');
