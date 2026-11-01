-- 008_zones_source.sql
--
-- Mark the HR zone splits that came off the watch, so a later sync can correct
-- them.
--
-- `enrich_from_garmin` refuses to overwrite an existing zone split, which is
-- right for a hand-written one: the notebook is the user's own reading of a
-- session and the watch must not overrule it. It was wrong for the watch's own
-- data, because it made the *first* split ever written permanent — a parsing
-- fix could never reach the rows it was written to fix, and re-syncing, the one
-- thing anybody would try, did nothing at all.
--
-- The code now records `zones_source` and refreshes its own work. Rows written
-- by the first version predate that field, so they are stranded: no source, so
-- not refreshable, so still carrying the bug that fix was for (a zone holding a
-- few seconds rounds to 0% and sits in the split as a band with no width).
--
-- Only `source = 'garmin'` rows are touched. A notebook split lives on a
-- manually entered session — `2026-08-01` is one, `z1=31 z2=42` typed off a
-- page — and marking those would hand the watch permission to overwrite them,
-- which is the exact opposite of the rule being preserved here.

UPDATE session
   SET detail = json_set(detail, '$.zones_source', 'garmin')
 WHERE source = 'garmin'
   AND json_valid(detail)
   AND json_extract(detail, '$.zones') IS NOT NULL
   AND json_extract(detail, '$.zones_source') IS NULL;
