-- 005_fixture_venue.sql
--
-- The league page prints which field each match is on — Outdoor Field,
-- Indoor Field #1, Indoor Field #2 — and it was parsed but thrown away.
-- It matters: indoor and outdoor are different games, and knowing the field
-- before you leave the house is half the point of showing the schedule.

ALTER TABLE league_fixture ADD COLUMN venue TEXT;
