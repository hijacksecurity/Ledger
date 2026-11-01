-- 007_kind_locked.sql
--
-- Remember that a human chose the modality, so the watch stops overruling it.
--
-- `upsert_garmin_session` already refuses to relabel a session, but only when
-- `source = 'manual'`. That protects sessions typed in by hand and misses the
-- case that actually happens: a Garmin-sourced session the user reclassified
-- afterwards. Those keep `source = 'garmin'`, so every nightly sync wrote the
-- mapped kind straight back over the correction.
--
-- Concretely: Garmin has no quick-feet activity type, so quick feet is recorded
-- on the watch as a soccer activity named "Quick Feet". Correcting it to
-- `quickfeet` held until 02:00 and then reverted, three nights running. It is
-- not only a labelling problem — those sessions then counted as matches in the
-- record, in the goal tallies, and in the soccer share of training load.
--
-- A flag rather than a `source` change: the session genuinely did come from
-- Garmin, and rewriting its provenance to protect its kind would be lying about
-- where the duration and distance came from. This says exactly what happened —
-- the kind was set by a person — and nothing more.

ALTER TABLE session ADD COLUMN kind_locked INTEGER NOT NULL DEFAULT 0;

-- Anything already reclassified away from what the watch would map is locked
-- retroactively, so the correction survives the next sync without being redone
-- by hand. Garmin maps its `soccer` type to our `soccer`, so a Garmin-sourced
-- session sitting on `quickfeet` can only have got there by human action.
UPDATE session
   SET kind_locked = 1
 WHERE source = 'garmin'
   AND kind IN ('quickfeet', 'ab', 'other');
