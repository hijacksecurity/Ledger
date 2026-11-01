-- 013_mens_league_moves_venue.sql
--
-- Men's league leaves the ezleagues venue for the DaySmart venue.
--
-- The summer men's season (ezleagues 479012, Wednesdays) finished on
-- 9 Sep 2026. The fixture carries on as a Thursday men's league at a venue
-- that publishes through the DaySmart "Dash" app rather than ezleagues, under
-- a new team name. The ids and names below are the ones that were live at the
-- time; on any other database the guard makes this a no-op.
--
-- `leagues.discover()` cannot make this switch: it keeps a fixture with its
-- provider and matches on the team name, and both changed at once. So it is
-- done here, once, by hand — the summer season is archived exactly as
-- `discover()` would have archived it, and the new league row is seeded with
-- no standings or fixtures so the next refresh fills it from the API.
--
-- Guarded on the summer league being present: a fresh database gets the same
-- league from `leagues.DEFAULT_LEAGUES` instead, and a test database gets
-- nothing at all.

UPDATE league
SET archived_at = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
WHERE provider_id = '479012' AND archived_at IS NULL;

INSERT INTO league (provider_id, name, my_team, fixture, url, fetched_at, path)
SELECT
    'daysmart:1457',
    'Thursday Men''s - Adult Fall 2026 Leagues - Indoor venue',
    'Night Owls',
    'mens',
    'https://apps.daysmartrecreation.com/dash/x/example/leagues/1457',
    NULL,
    '1457'
WHERE EXISTS (SELECT 1 FROM league WHERE provider_id = '479012')
  AND NOT EXISTS (SELECT 1 FROM league WHERE provider_id = 'daysmart:1457');
