"""The indoor venue publishes through DaySmart, not ezleagues.

The men's league moved there for Fall 2026. DaySmart has no standings endpoint
— the Dash app builds the table in the browser from the events — so the table
here is computed from the fixtures by the rule Dash prints under its own
table. These pin that rule, the shape of the API as read on 17 Sep 2026, and
the one thing discovery must never do: hand a fixture to the other provider.
"""

from __future__ import annotations

import pytest

from ledger import leagues
from ledger.leagues import Fixture, League, Standing

LEAGUE = "1457"
PID = "daysmart:1457"

#: Trimmed from the live API. Only the keys the reader touches are kept.
HEAD = {
    "data": {"type": "leagues", "id": LEAGUE,
             "attributes": {"name": "Thursday Men's", "facility_id": 1}},
    "included": [
        {"type": "seasons", "id": "233", "attributes": {"name": "Adult Fall 2026 Leagues"}},
        {"type": "facilities", "id": "1", "attributes": {"name": leagues.DAYSMART_PLACE}},
        {"type": "sports", "id": "1", "attributes": {"name": "Soccer, Indoor"}},
    ],
}
TEAMS = {
    "meta": {"page": {"last-page": 1}},
    "data": [
        {"type": "teams", "id": "9514", "attributes": {"name": "Night Owls", "status": "active"}},
        {"type": "teams", "id": "9504", "attributes": {"name": "Sporting Elm", "status": "active"}},
        {"type": "teams", "id": "9489", "attributes": {"name": "Primos", "status": "active"}},
        {"type": "teams", "id": "9507", "attributes": {"name": "Elm Lads", "status": "active"}},
    ],
}


def _event(eid, start, h, v, hs=None, vs=None, res="9", sub="regular"):
    return {"type": "events", "id": eid, "attributes": {
        "start": start, "hteam_id": int(h), "vteam_id": int(v),
        "home_score": hs, "visiting_score": vs, "resource_id": int(res),
        "sub_type": sub, "publish": True,
    }}


EVENTS = {
    "meta": {"page": {"last-page": 1}},
    "data": [
        _event("1", "2026-09-17T19:00:00", "9514", "9504", 7, 5),
        _event("2", "2026-09-17T21:00:00", "9489", "9507", 3, 3, res="10"),
        _event("3", "2026-09-24T20:00:00", "9489", "9514"),
        # A game against a team that withdrew: not in the active list.
        _event("4", "2026-09-24T21:00:00", "9444", "9507"),
        _event("5", "2026-11-12T20:00:00", "9514", "9507", res="13", sub="playoff"),
    ],
    "included": [
        {"type": "resources", "id": "9", "attributes": {"name": "Yellow Field", "facility_id": 1}},
        {"type": "resources", "id": "10", "attributes": {"name": "Blue Field", "facility_id": 1}},
        {"type": "resources", "id": "13", "attributes": {"name": "Main Field", "facility_id": 7}},
        {"type": "facilities", "id": "1", "attributes": {"name": leagues.DAYSMART_PLACE}},
        {"type": "facilities", "id": "7", "attributes": {"name": "Riverside Arena"}},
    ],
}


def fake_get(path, **params):
    if path == f"leagues/{LEAGUE}":
        return HEAD
    if path == "teams":
        assert params["filter[league_id]"] == LEAGUE
        assert params["filter[status]"] == "active"
        return TEAMS
    if path == "events":
        assert params["filter[or][homeTeam.league_id]"] == LEAGUE
        return EVENTS
    if path == "leagues":
        return LISTING
    raise AssertionError(f"unexpected call {path} {params}")


LISTING = {"meta": {"page": {"last-page": 1}},
           "data": [{"type": "leagues", "id": LEAGUE, "attributes": {"name": "Thursday Men's"}}]}


@pytest.fixture
def league():
    return leagues.daysmart_league(LEAGUE, get=fake_get)


# --- reading the API --------------------------------------------------------


def test_the_league_is_named_like_the_ezleagues_ones(league):
    assert league.provider_id == PID
    assert league.name == f"Thursday Men's - Adult Fall 2026 Leagues - {leagues.DAYSMART_PLACE}"
    assert league.url.endswith("/leagues/1457")


def test_a_played_game_carries_its_score_and_field(league):
    f = league.fixtures[0]
    assert (f.date, f.home, f.away) == ("2026-09-17", "Night Owls", "Sporting Elm")
    assert (f.home_score, f.away_score, f.played) == (7, 5, True)
    assert f.time_text == "Complete"
    assert f.venue == "Yellow Field (indoor)"


def test_an_unplayed_game_shows_its_kickoff(league):
    f = next(f for f in league.fixtures if f.date == "2026-09-24")
    assert (f.time_text, f.played, f.home_score) == ("8:00 PM", False, None)


def test_a_playoff_says_so(league):
    f = league.fixtures[-1]
    assert f.time_text == "8:00 PM · playoff"


def test_a_game_at_another_building_names_it(league):
    """One of the eight is across town. The field name alone would send you
    to the wrong building."""
    assert league.fixtures[-1].venue == "Main Field, Riverside Arena (indoor)"
    assert league.fixtures[0].venue == "Yellow Field (indoor)"


def test_a_withdrawn_team_is_not_on_the_schedule(league):
    assert not any("9444" in (f.home, f.away) for f in league.fixtures)
    assert len(league.fixtures) == 4


def test_every_active_team_is_in_the_table_even_before_it_plays(league):
    assert {s.team for s in league.standings} == {
        "Night Owls", "Sporting Elm", "Primos", "Elm Lads"}


def test_an_empty_league_fails_loudly():
    def nothing(path, **params):
        return {"data": {} if path.startswith("leagues/") else [], "meta": {"page": {}}}
    with pytest.raises(leagues.LeagueParseError):
        leagues.daysmart_league("999", get=nothing)


def test_pages_are_walked_by_number():
    calls = []

    def paged(path, **params):
        calls.append(params.get("page[number]"))
        n = int(params["page[number]"])
        return {"meta": {"page": {"last-page": 3}},
                "data": [{"type": "leagues", "id": str(n), "attributes": {}}]}

    assert [pid for pid, _ in leagues.daysmart_listing(get=paged)] == \
        ["daysmart:1", "daysmart:2", "daysmart:3"]
    assert calls == ["1", "2", "3"]


# --- the table, by Dash's rule ---------------------------------------------


def _fx(date, home, away, hs, vs):
    return Fixture(date=date, time_text="Complete", home=home, away=away,
                   home_score=hs, away_score=vs, played=True)


def test_three_for_a_win_one_for_a_draw(league):
    by = {s.team: s for s in league.standings}
    assert (by["Night Owls"].w, by["Night Owls"].pts, by["Night Owls"].gd) == (1, 3, 2)
    assert (by["Sporting Elm"].l, by["Sporting Elm"].pts, by["Sporting Elm"].gd) == (1, 0, -2)
    assert (by["Primos"].t, by["Primos"].pts) == (1, 1)
    assert by["Primos"].wp == 0.0 and by["Night Owls"].wp == 1.0
    assert by["Night Owls"].gf == 7 and by["Night Owls"].ga == 5


def test_ranked_by_points_then_gd_then_wins_then_gf():
    table = leagues.table_from_fixtures(["A", "B", "C", "D"], [
        _fx("2026-09-17", "A", "B", 2, 0),   # A 3 pts gd+2 · B 0 pts gd-2
        _fx("2026-09-17", "C", "D", 4, 3),   # C 3 pts gd+1 · D 0 pts gd-1
        _fx("2026-09-24", "B", "D", 1, 1),   # both +1
    ])
    assert [(s.position, s.team, s.pts, s.gd) for s in table] == [
        (1, "A", 3, 2), (2, "C", 3, 1), (3, "D", 1, -1), (4, "B", 1, -2)]


def test_a_team_with_no_result_yet_has_no_win_rate():
    table = leagues.table_from_fixtures(["A"], [])
    assert table == [Standing(position=1, team="A", gp=0, w=0, l=0, t=0,
                              gf=0, ga=0, pts=0, gd=0, wp=None)]


def test_a_pending_result_does_not_count():
    table = leagues.table_from_fixtures(["A", "B"], [
        Fixture(date="2026-09-17", time_text="7:00 PM", home="A", away="B"),
    ])
    assert all(s.gp == 0 for s in table)


# --- persistence and discovery ---------------------------------------------


def test_it_round_trips_through_the_database(conn, league):
    leagues.upsert(conn, league, "Night Owls", "mens")
    (out,) = leagues.read(conn)
    assert out["provider_id"] == PID
    assert out["my_position"] == 1
    assert [f["opponent"] for f in out["my_fixtures"]] == \
        ["Sporting Elm", "Primos", "Elm Lads"]
    assert out["my_fixtures"][0]["home_score"] == 7
    assert leagues.configured(conn) == [
        {"provider_id": PID, "my_team": "Night Owls", "fixture": "mens", "path": "1457"}]


def test_the_seed_for_mens_is_the_daysmart_league(monkeypatch):
    monkeypatch.setattr(leagues, "DEFAULT_LEAGUES", [
        {"provider_id": "479009", "my_team": "Sparrows FC", "fixture": "coed",
         "path": "479009/Summer-Session-Coed-Open-Lower-Division"},
        {"provider_id": PID, "my_team": "Night Owls", "fixture": "mens", "path": LEAGUE},
    ])
    mens = next(s for s in leagues.DEFAULT_LEAGUES if s["fixture"] == "mens")
    assert mens["provider_id"] == PID and mens["my_team"] == "Night Owls"


def _ez(pid, teams, dates):
    return League(
        provider_id=pid, url=leagues.BASE.format(path=f"{pid}/slug"), name="ez",
        standings=[Standing(position=i + 1, team=t) for i, t in enumerate(teams)],
        fixtures=[Fixture(date=d, time_text="7:30 PM", home=teams[0], away=teams[1])
                  for d in dates],
    )


def test_a_daysmart_fixture_never_moves_to_an_ezleagues_season(conn):
    """A finished DaySmart season with an ezleagues league that has the same team
    name in it. Wrong provider — it must be ignored, whatever it says."""
    old = League(provider_id=PID, url="x", name="old", standings=[
        Standing(position=1, team="Night Owls")],
        fixtures=[Fixture(date="2026-09-17", time_text="Complete",
                          home="Night Owls", away="Primos", played=True)])
    leagues.upsert(conn, old, "Night Owls", "mens")

    lure = _ez("490000", ["Night Owls", "Nobody"], ["2026-12-03", "2027-01-28"])
    orig_listing, orig_parse, orig_ds = leagues.listing, leagues.parse, leagues.daysmart_listing
    leagues.listing = lambda url=None: [("490000", "490000/slug")]
    leagues.parse = lambda page, pid, url: lure
    leagues.daysmart_listing = lambda get=None: []
    try:
        switches = leagues.discover(conn, today="2026-12-01", fetcher=lambda p, u: p)
    finally:
        leagues.listing, leagues.parse, leagues.daysmart_listing = orig_listing, orig_parse, orig_ds
    assert switches == []


def test_a_finished_daysmart_season_rolls_to_the_next_one(conn):
    old = League(provider_id="daysmart:1000", url="x", name="old", standings=[
        Standing(position=1, team="Night Owls")],
        fixtures=[Fixture(date="2026-09-17", time_text="Complete",
                          home="Night Owls", away="Primos", played=True)])
    leagues.upsert(conn, old, "Night Owls", "mens")

    def get(path, **params):
        if path == "leagues":
            return {"meta": {"page": {"last-page": 1}}, "data": [
                {"type": "leagues", "id": "1000", "attributes": {}},
                {"type": "leagues", "id": "1519", "attributes": {}},
                {"type": "leagues", "id": "1520", "attributes": {}},   # no teams yet
            ]}
        if path == "leagues/1519":
            return {"data": {"attributes": {"name": "Thursday - Men's"}}, "included": []}
        if path == "leagues/1520":
            return {"data": {"attributes": {"name": "Friday - Men's 30+"}}, "included": []}
        if path == "teams":
            if params["filter[league_id]"] == "1519":
                return {"meta": {"page": {}}, "data": [
                    {"id": "1", "attributes": {"name": "Night Owls"}},
                    {"id": "2", "attributes": {"name": "Primos"}}]}
            return {"meta": {"page": {}}, "data": []}
        if path == "events":
            if params["filter[or][league_id]"] == "1519":
                return {"meta": {"page": {}}, "data": [
                    _event("9", "2026-12-03T19:00:00", "1", "2")], "included": []}
            return {"meta": {"page": {}}, "data": [], "included": []}
        raise AssertionError(path)

    switches = leagues.discover(conn, today="2026-11-25", getter=get)
    assert [(s["from"], s["to"]) for s in switches] == [("daysmart:1000", "daysmart:1519")]
    assert leagues.configured(conn)[0]["provider_id"] == "daysmart:1519"
    archived = conn.execute(
        "SELECT archived_at FROM league WHERE provider_id = 'daysmart:1000'").fetchone()
    assert archived["archived_at"]


# --- the weekday rule is dated ---------------------------------------------


def test_mens_league_is_thursday_from_the_move_and_wednesday_before():
    from ledger.report.views import fixture_by_weekday
    assert fixture_by_weekday("2026-09-09") == "mens"    # a summer Wednesday
    assert fixture_by_weekday("2026-09-03") == "other"   # a summer Thursday
    assert fixture_by_weekday("2026-09-16") == "other"   # the Wednesday after
    assert fixture_by_weekday("2026-09-17") == "mens"    # first DaySmart Thursday
    assert fixture_by_weekday("2026-10-01") == "mens"
    assert fixture_by_weekday("2026-09-14") == "coed"    # Mondays are untouched
    assert fixture_by_weekday("2026-09-15") == "pickup"


def test_an_unplayed_opponent_gets_no_invented_position():
    note = leagues.describe_opponent(
        {"position": 10, "gp": 0, "w": 0, "l": 0, "t": 0, "pts": 0},
        "Sporting Elm", [], "Night Owls")
    assert note == "No games played yet. You have not played them yet this season."


def test_no_position_is_claimed_before_anyone_has_played(conn):
    fresh = League(provider_id=PID, url="x", name="fresh",
                   standings=leagues.table_from_fixtures(["B", "Night Owls", "A"], []))
    leagues.upsert(conn, fresh, "Night Owls", "mens")
    (out,) = leagues.read(conn)
    assert out["my_position"] is None
    assert len(out["standings"]) == 3
