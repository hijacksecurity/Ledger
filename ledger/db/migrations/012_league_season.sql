-- 012_league_season.sql
--
-- A league is a *season*, not a standing fixture.
--
-- The two league ids were hard-coded in `ledger/leagues.py::DEFAULT_LEAGUES`,
-- which was fine for exactly one season. The Summer Coed Open Lower Division
-- finished on 14 Sep 2026 and the nightly job carried on scraping it — a page
-- that will never change again — because nothing in the system knew a season
-- could end, let alone that a new one had started under a new id.
--
-- So `fixture` ('coed', 'mens') is the thing that persists, and a `league` row
-- is one season of it. Archiving rather than deleting: the summer table and
-- every result in it stay exactly as they were, and `league_fixture` keeps
-- pointing at the row it was scraped from. Only the *current* season is shown
-- and refreshed.
--
-- Discovery is gated on the team actually being in the standings, which is the
-- only signal that cannot pick the wrong division — the ezleagues venue runs a
-- Coed 30+ and a Coed Open on the same nights, and matching on a name like
-- "Coed" would eventually attach the wrong one. See leagues.py::discover.

ALTER TABLE league ADD COLUMN archived_at TEXT;

-- Which season this league is. Scraped from the page title, kept so two
-- seasons of one fixture can be told apart at a glance in the database.
ALTER TABLE league ADD COLUMN season TEXT;

-- The slug half of the URL. `refresh` needs it to build the page address, and
-- deriving it from `url` on every call is a parse that can only go wrong.
ALTER TABLE league ADD COLUMN path TEXT;

-- Backfill from what is already stored: everything on record right now is the
-- current season of its fixture, and the path is the tail of its URL.
UPDATE league
SET path = replace(
        substr(url, instr(url, '/leagues/') + length('/leagues/')),
        '.aspx', '')
WHERE path IS NULL AND url LIKE '%/leagues/%';
