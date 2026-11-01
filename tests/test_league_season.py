"""A league is a season, and seasons end.

The two league ids were constants, so when the Summer Coed Open Lower Division
finished on 14 Sep 2026 the nightly job kept scraping a page that would never
change again. These pin the rollover, and in particular the one rule that makes
automatic discovery safe rather than reckless: a fixture only moves to a league
whose standings actually contain the team.

The ezleagues venue runs a **Coed 30+** division on the same nights as **Coed
Open Lower**. Any rule that matched on the division's name would eventually
attach the wrong one and start reporting strangers' results as the user's, so
several of these exist purely to prove that cannot happen.
"""

from __future__ import annotations

import pytest

from ledger import leagues
from ledger.leagues import Fixture, League, Standing

TODAY = "2026-09-20"

#: The finished season, and the one that replaced it.
SUMMER = "479009"
FALL = "481400"
#: A different division running on the same nights. Never the answer.
COED_30 = "480383"


def _league(provider_id, name, teams, dates, *, played=True):
    return League(
        provider_id=provider_id,
        url=leagues.BASE.format(path=f"{provider_id}/{name.replace(' ', '-')}"),
        name=name,
        standings=[
            Standing(position=i + 1, team=t, gp=6, w=3, l=2, t=1, gf=20, ga=18,
                     pts=10, gd=2, wp=0.5)
            for i, t in enumerate(teams)
        ],
        fixtures=[
            Fixture(date=d, time_text="7:30 PM", home=teams[0], away=teams[1],
                    played=played)
            for d in dates
        ],
    )


SUMMER_LEAGUE = _league(
    SUMMER, "Summer Session Coed Open Lower Division",
    ["Sparrows FC", "Kamikazes", "Barcelona"],
    ["2026-08-31", "2026-09-14"],
)
FALL_LEAGUE = _league(
    FALL, "Fall Session Coed Open Lower Division",
    ["Sparrows FC", "Shockers", "Wild Storm"],
    ["2026-09-28", "2026-11-09"], played=False,
)
COED_30_LEAGUE = _league(
    COED_30, "Fall Session Coed 30+ Division",
    ["Wolfpack", "Goal Ninjas", "Sparrows United"],
    ["2026-09-11", "2026-10-23"], played=False,
)


@pytest.fixture
def seeded(conn):
    """A database holding the finished summer season, and nothing else."""
    leagues.upsert(conn, SUMMER_LEAGUE, "Sparrows FC", "coed")
    return conn


def _discovery(conn, listing_pages, **kw):
    """Run discover() against a fake venue listing. No network."""
    pages = {pid: lg for pid, lg in listing_pages.items()}

    def fake_listing(url=None):
        return sorted((pid, f"{pid}/slug") for pid in pages)

    def fake_fetch(provider_id, url):
        return provider_id  # the parser is stubbed out below

    def fake_parse(page, provider_id, url):
        return pages[page]

    orig_listing, orig_parse = leagues.listing, leagues.parse
    leagues.listing, leagues.parse = fake_listing, fake_parse
    try:
        return leagues.discover(conn, fetcher=fake_fetch, **kw)
    finally:
        leagues.listing, leagues.parse = orig_listing, orig_parse


# --- the config lives in the database -------------------------------------


def test_seeds_are_used_only_until_a_league_exists(conn, monkeypatch):
    monkeypatch.setattr(leagues, "DEFAULT_LEAGUES", [
        {"provider_id": SUMMER, "my_team": "Sparrows FC", "fixture": "coed",
         "path": f"{SUMMER}/Summer-Session-Coed-Open-Lower-Division"},
        {"provider_id": "daysmart:1457", "my_team": "Night Owls", "fixture": "mens",
         "path": "1457"},
    ])
    assert [c["provider_id"] for c in leagues.configured(conn)] == \
        [s["provider_id"] for s in leagues.DEFAULT_LEAGUES]

    leagues.upsert(conn, SUMMER_LEAGUE, "Sparrows FC", "coed")
    assert [c["provider_id"] for c in leagues.configured(conn)] == [SUMMER]


def test_the_path_survives_a_round_trip(seeded):
    """`refresh` builds its URL from the path; losing it 404s the league."""
    assert leagues.configured(seeded)[0]["path"] == \
        f"{SUMMER}/Summer-Session-Coed-Open-Lower-Division"


# --- when to look ---------------------------------------------------------


def test_a_season_with_a_game_still_to_come_is_not_over(seeded):
    assert leagues.season_over(seeded, SUMMER, today="2026-09-10") is False


def test_a_season_past_its_last_fixture_is_over(seeded):
    assert leagues.season_over(seeded, SUMMER, today=TODAY) is True


def test_nothing_is_fetched_while_a_season_is_running(seeded):
    """The listing is not even read — there is nothing to look for yet."""
    def explode(url=None):
        raise AssertionError("discovery looked for a new season mid-season")

    orig = leagues.listing
    leagues.listing = explode
    try:
        assert leagues.discover(seeded, today="2026-09-10") == []
    finally:
        leagues.listing = orig


# --- the switch -----------------------------------------------------------


def test_a_finished_season_is_replaced_by_the_new_one(seeded):
    switches = _discovery(seeded, {FALL: FALL_LEAGUE}, today=TODAY)

    assert len(switches) == 1
    assert switches[0]["from"] == SUMMER
    assert switches[0]["to"] == FALL
    assert switches[0]["fixture"] == "coed"
    assert [c["provider_id"] for c in leagues.configured(seeded)] == [FALL]


def test_the_old_season_is_archived_not_deleted(seeded):
    _discovery(seeded, {FALL: FALL_LEAGUE}, today=TODAY)

    row = seeded.execute(
        "SELECT archived_at FROM league WHERE provider_id = ?", (SUMMER,)
    ).fetchone()
    assert row is not None and row["archived_at"] is not None

    kept = seeded.execute(
        "SELECT COUNT(*) AS n FROM league_fixture f JOIN league l ON l.id = f.league_id "
        "WHERE l.provider_id = ?", (SUMMER,)
    ).fetchone()["n"]
    assert kept == 2


def test_only_the_current_season_is_read(seeded):
    _discovery(seeded, {FALL: FALL_LEAGUE}, today=TODAY)
    names = [lg["name"] for lg in leagues.read(seeded)]
    assert names == ["Fall Session Coed Open Lower Division"]


# --- the safety rule ------------------------------------------------------


def test_a_division_without_your_team_is_never_chosen(seeded):
    """Coed 30+ runs the same nights. It is not your league and never becomes it."""
    switches = _discovery(seeded, {COED_30: COED_30_LEAGUE}, today=TODAY)

    assert switches == []
    assert [c["provider_id"] for c in leagues.configured(seeded)] == [SUMMER]


def test_the_right_division_is_picked_out_of_several(seeded):
    switches = _discovery(
        seeded, {COED_30: COED_30_LEAGUE, FALL: FALL_LEAGUE}, today=TODAY
    )
    assert [s["to"] for s in switches] == [FALL]


def test_a_near_miss_on_the_team_name_does_not_count(seeded):
    """"Sparrows United" is a real, different team in this venue's leagues."""
    decoy = _league(
        "481999", "Fall Session Coed Open Middle Division",
        ["Sparrows United", "Shockers"], ["2026-09-28"], played=False,
    )
    assert _discovery(seeded, {"481999": decoy}, today=TODAY) == []


def test_the_venues_own_typo_still_counts(seeded):
    """Fall 2026 was entered as "Sparrosw FC". Three days of no schedule.
    The switch happens, and the row carries the name the page prints."""
    typo = _league(
        "480727", "Fall Session Coed Open Lower Division I",
        ["Sparrosw FC", "Sparrows United", "Shockers"], ["2026-09-21", "2026-10-27"],
        played=False,
    )
    switches = _discovery(seeded, {"480727": typo}, today=TODAY)
    assert [(s["to"], s["my_team"]) for s in switches] == [("480727", "Sparrosw FC")]
    (out,) = leagues.read(seeded)
    assert out["my_team"] == "Sparrosw FC"
    assert out["my_position"] == 1
    assert [f["opponent"] for f in out["my_fixtures"]] == ["Sparrows United"] * 2
    assert leagues.configured(seeded)[0]["my_team"] == "Sparrosw FC"


def test_how_far_a_name_may_drift():
    same = leagues.same_team
    assert same("Sparrosw FC", "Sparrows FC")          # swapped neighbours
    assert same("Sparrow FC", "Sparrows FC")           # one letter short
    assert same("Sparrows  FC Team".replace(" Team", ""), "sparrows fc")
    assert not same("Sparrows United", "Sparrows FC")      # a real other team
    assert not same("Sparrows Co", "Sparrows FC")          # two letters off
    assert not same("Night Owls FC", "Night Owls")         # more than a slip
    assert not same("FC B", "FC A")                        # too short to allow


def test_the_later_season_wins_when_two_both_contain_you(seeded):
    older = _league(
        "481100", "Fall Session Coed Open Lower Division",
        ["Sparrows FC", "Shockers"], ["2026-09-21", "2026-10-05"], played=False,
    )
    switches = _discovery(seeded, {"481100": older, FALL: FALL_LEAGUE}, today=TODAY)
    assert [s["to"] for s in switches] == [FALL]


def test_a_league_already_on_record_is_not_reconsidered(seeded):
    """The finished summer league still lists the team; it must not be re-picked."""
    assert _discovery(seeded, {SUMMER: SUMMER_LEAGUE}, today=TODAY) == []
    assert [c["provider_id"] for c in leagues.configured(seeded)] == [SUMMER]


def test_nothing_published_yet_changes_nothing(seeded):
    """Exactly the state on 11 Sep 2026: season over, successor not created."""
    assert _discovery(seeded, {}, today=TODAY) == []
    assert [c["provider_id"] for c in leagues.configured(seeded)] == [SUMMER]


def test_one_unparseable_page_does_not_abandon_the_search(seeded):
    """A league page that has changed layout is skipped, not fatal."""
    pages = {"481999": None, FALL: FALL_LEAGUE}

    def fake_listing(url=None):
        return sorted((pid, f"{pid}/slug") for pid in pages)

    def fake_parse(page, provider_id, url):
        if pages[page] is None:
            raise leagues.LeagueParseError("no standings table")
        return pages[page]

    orig_listing, orig_parse = leagues.listing, leagues.parse
    leagues.listing, leagues.parse = fake_listing, fake_parse
    try:
        switches = leagues.discover(
            seeded, today=TODAY, fetcher=lambda pid, url: pid
        )
    finally:
        leagues.listing, leagues.parse = orig_listing, orig_parse

    assert [s["to"] for s in switches] == [FALL]


def test_two_fixtures_roll_over_independently(conn):
    """Coed's season can end while the men's league is still running."""
    leagues.upsert(conn, SUMMER_LEAGUE, "Sparrows FC", "coed")
    mens = _league(
        "479012", "Summer Session Mens Lower Division I",
        ["Harbour Lights", "Shooters"], ["2026-11-01"], played=False,
    )
    leagues.upsert(conn, mens, "Harbour Lights", "mens")

    switches = _discovery(conn, {FALL: FALL_LEAGUE}, today=TODAY)

    assert [s["fixture"] for s in switches] == ["coed"]
    assert sorted(c["provider_id"] for c in leagues.configured(conn)) == \
        sorted([FALL, "479012"])


def test_an_older_season_is_never_chosen(seeded):
    """Caught on the first live run, against the real venue.

    The men's fixture was moved from Summer back to the *Spring* session: the
    venue still publishes Spring, Harbour Lights are in its standings, and it
    was not yet on record — so it passed every rule there was. Being in the
    table says "your league"; only the date says "your next league".
    """
    spring = _league(
        "477677", "Spring Session Coed Open Lower Division",
        ["Sparrows FC", "Kamikazes"], ["2026-04-06", "2026-06-01"],
    )
    assert _discovery(seeded, {"477677": spring}, today=TODAY) == []
    assert [c["provider_id"] for c in leagues.configured(seeded)] == [SUMMER]


def test_an_older_season_does_not_hide_the_new_one(seeded):
    spring = _league(
        "477677", "Spring Session Coed Open Lower Division",
        ["Sparrows FC", "Kamikazes"], ["2026-04-06", "2026-06-01"],
    )
    switches = _discovery(
        seeded, {"477677": spring, FALL: FALL_LEAGUE}, today=TODAY
    )
    assert [s["to"] for s in switches] == [FALL]


def test_cards_keep_their_places_when_one_fixture_rolls_over(conn):
    """Coed has always been the first card. A new season gets a new row id,
    and ordering by id swapped the cards the day the fall coed league arrived."""
    leagues.upsert(conn, _league("100", "Mens Summer", ["Harbour Lights", "X"],
                                 ["2026-09-09"]), "Harbour Lights", "mens")
    leagues.upsert(conn, _league("200", "Coed Fall", ["Sparrosw FC", "Y"],
                                 ["2026-10-26"], played=False), "Sparrosw FC", "coed")
    assert [lg["fixture"] for lg in leagues.read(conn)] == ["coed", "mens"]


# --- moving by hand ----------------------------------------------------------


def _move(conn, fixture, target, pages):
    """Run move() against stubbed league pages. No network."""
    orig = leagues.parse
    leagues.parse = lambda page, pid, url: pages[pid]
    try:
        return leagues.move(conn, fixture, target, fetcher=lambda pid, url: pid)
    finally:
        leagues.parse = orig


def test_a_season_can_be_moved_by_hand_from_its_page_url(seeded):
    url = f"https://example.ezleagues.ezfacility.com/leagues/{FALL}/Fall-Session-Coed-Open.aspx"
    sw = _move(seeded, "coed", url, {FALL: FALL_LEAGUE})

    assert sw["from"] == SUMMER and sw["to"] == FALL and sw["fixture"] == "coed"
    assert [c["provider_id"] for c in leagues.configured(seeded)] == [FALL]
    # The path is read off the page the parser returned, not off the URL typed.
    assert leagues.configured(seeded)[0]["path"] == leagues._path_of(FALL_LEAGUE.url)
    old = seeded.execute(
        "SELECT archived_at FROM league WHERE provider_id = ?", (SUMMER,)
    ).fetchone()
    assert old["archived_at"] is not None


def test_a_hand_move_still_refuses_a_league_without_the_team(seeded):
    with pytest.raises(ValueError, match="not in the standings"):
        _move(seeded, "coed", f"{COED_30}/slug", {COED_30: COED_30_LEAGUE})
    assert [c["provider_id"] for c in leagues.configured(seeded)] == [SUMMER]


def test_a_hand_move_needs_a_current_season_for_that_fixture(seeded):
    with pytest.raises(ValueError, match="no current season"):
        _move(seeded, "mens", f"{FALL}/slug", {FALL: FALL_LEAGUE})


# --- the seasons on record --------------------------------------------------


def test_seasons_list_every_season_newest_first_with_the_final_table(seeded):
    _move(seeded, "coed", f"{FALL}/slug", {FALL: FALL_LEAGUE})
    ss = leagues.seasons(seeded, today=TODAY)

    assert [x["provider_id"] for x in ss] == [FALL, SUMMER]
    summer, fall = ss[1], ss[0]
    assert summer["archived"] is True and summer["complete"] is True
    assert summer["start"] == "2026-08-31" and summer["end"] == "2026-09-14"
    me = next(st for st in SUMMER_LEAGUE.standings if st.team == "Sparrows FC")
    assert summer["position"] == me.position
    assert summer["teams"] == len(SUMMER_LEAGUE.standings)
    assert summer["record"]["w"] == 3 and summer["record"]["pts"] == 10
    assert summer["logged"] == {"games": 0, "goals": 0, "assists": 0}
    # The whole table and every fixture travel with the season.
    assert [st["team"] for st in summer["standings"]] == [st.team for st in SUMMER_LEAGUE.standings]
    assert len(summer["my_fixtures"]) == 2
    assert all("opponent" in f and "home_game" in f for f in summer["my_fixtures"])
    assert fall["archived"] is False and fall["complete"] is False
    assert fall["played"] == 0 and fall["scheduled"] == 2


def test_each_fixture_carries_your_own_goals_and_assists_from_the_log(seeded):
    """2026-08-31 is a Monday, which the log reads as coed — the same rule the
    Soccer page uses — so the game lands on the summer fixture of that date."""
    from ledger.entry import parse_entry
    from ledger.ingest import save_session

    save_session(seeded, parse_entry("2026-08-31 soccer W3:1 2g1a 60min rpe=7")[0])
    [summer] = leagues.seasons(seeded, today=TODAY)
    by_date = {f["date"]: f["logged"] for f in summer["my_fixtures"]}
    assert by_date["2026-08-31"] == {"games": 1, "goals": 2, "assists": 1}
    assert by_date["2026-09-14"] is None
    assert summer["logged"] == {"games": 1, "goals": 2, "assists": 1}
    # The live card reads the same line for the same fixture.
    [card] = leagues.read(seeded)
    assert {f["date"]: f["logged"] for f in card["my_fixtures"]} == by_date


def test_a_season_with_no_schedule_yet_is_in_progress_not_finished(conn):
    bare = _league(FALL, "Winter Session Coed Open", ["Sparrows FC", "Shockers"], [])
    leagues.upsert(conn, bare, "Sparrows FC", "coed")
    [x] = leagues.seasons(conn, today=TODAY)
    assert x["start"] is None and x["complete"] is False and x["position"] is not None


# --- the schedule names the fixture ------------------------------------------


def test_a_league_game_on_an_odd_weekday_is_read_from_the_schedule(conn):
    """2026-09-29 is a Tuesday, which the weekday rule calls pickup. The
    league had a coed game that night, so the match is coed — and its goals
    count for the season."""
    from ledger.entry import parse_entry
    from ledger.ingest import save_session
    from ledger.report import views

    moved = _league(FALL, "Fall Session Coed Open", ["Sparrows FC", "Shockers"], ["2026-09-29"])
    leagues.upsert(conn, moved, "Sparrows FC", "coed")
    save_session(conn, parse_entry("2026-09-29 soccer W5:4 2g1a 60min rpe=7")[0])

    [game] = views.soccer(conn, "2026-09-29", "2026-09-29")["games"]
    assert game["fixture"] == "coed" and game["fixture_source"] == "schedule"
    assert game["pickup"] is False

    [season] = leagues.seasons(conn, today="2026-10-01")
    assert season["logged"] == {"games": 1, "goals": 2, "assists": 1}
    assert season["my_fixtures"][0]["logged"] == {"games": 1, "goals": 2, "assists": 1}


def test_an_explicit_fixture_still_beats_the_schedule(conn):
    from ledger.entry import parse_entry
    from ledger.ingest import save_session
    from ledger.report import views

    import json

    from ledger.db import queries as q

    leagues.upsert(conn, _league(FALL, "Fall Session Coed Open", ["Sparrows FC", "Shockers"],
                                 ["2026-09-29"]), "Sparrows FC", "coed")
    sid, _ = save_session(conn, parse_entry("2026-09-29 soccer W5:4 60min rpe=7")[0])
    detail = json.loads(q.session_by_id(conn, sid)["detail"] or "{}")
    q.update_session(conn, sid, {"detail": json.dumps({**detail, "team": "pickup"})})
    [game] = views.soccer(conn, "2026-09-29", "2026-09-29")["games"]
    assert game["fixture"] == "pickup" and game["fixture_source"] == "set"
