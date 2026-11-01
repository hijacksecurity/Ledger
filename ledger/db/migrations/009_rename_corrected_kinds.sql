-- 009_rename_corrected_kinds.sql
--
-- Bring already-corrected sessions in line with the rename rule.
--
-- Correcting a modality now renames it too, when the name is still the watch's:
-- Garmin files ab work as "Strength", so a session corrected to `ab` read
-- "Ab attack" in its title and "Strength" underneath — the same session
-- disagreeing with itself in two places on one row.
--
-- Sessions corrected *before* that rule existed still carry the watch's name.
-- This applies the rule to them once, and only where it is provably safe:
--
--   kind_locked = 1        a person chose this modality
--   notes = garmin_name    the name is still exactly what the watch sent
--
-- The second condition is the whole safety of it. Anything the user typed —
-- "felt easy, legs ok", "mon game", "pickup, 2W 1L" — differs from the
-- watch's label and is left untouched. A note is not a label, and this must
-- never overwrite one.
--
-- Rows whose `garmin_name` was never recorded are skipped rather than guessed
-- at; the next sync records it, and correcting the kind again renames them
-- through the live path.

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
