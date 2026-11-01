"""League scraping and the opponent summary.

Scraped pages change without warning, so the parser is tested against the
shapes the real site actually produced — including the two that bit us: a
kick-off time of "6:30" being read as a 6-30 scoreline, and a date printed as
"Mon-Jul 20" with no year at all.
"""

from __future__ import annotations

from datetime import date

from ledger.leagues import _parse_date, _parse_fixtures, describe_opponent

TOP = {"position": 1, "team": "Newsomecastle", "gp": 3, "w": 3, "l": 0, "t": 0,
       "gf": 32, "ga": 15, "pts": 9, "gd": 17}


def test_a_kickoff_time_is_not_a_scoreline():
    """'6:30' must never parse as 6-30 — it did, and produced absurd results."""
    rows = [
        ["Date", "Home", "", "Away", "Time/Status", "Venue"],
        ["Mon-Aug 10", "Newsomecastle", "", "Sparrows FC", "6:30 PM", "Indoor Field #2"],
    ]
    (f,) = _parse_fixtures(rows)
    assert f.played is False
    assert f.home_score is None and f.away_score is None
    assert f.venue == "Indoor Field #2"


def test_a_played_match_carries_its_score():
    rows = [
        ["Date", "Home", "", "Away", "Time/Status", "Venue"],
        ["Mon-Jul 20", "Sparrows FC", "4 - 4", "JT FC", "Complete", "Outdoor Field"],
    ]
    (f,) = _parse_fixtures(rows)
    assert (f.home_score, f.away_score, f.played) == (4, 4, True)


def test_the_away_team_does_not_slide_into_the_score_column():
    """The middle column is empty before kick-off; squeezing blanks shifted it."""
    rows = [
        ["Date", "Home", "", "Away", "Time/Status"],
        ["Wed-Aug 12", "FC Tavo's Tacos", "", "Harbour Lights", "6:30 PM"],
    ]
    (f,) = _parse_fixtures(rows)
    assert f.home == "FC Tavo's Tacos" and f.away == "Harbour Lights"


def test_dates_have_no_year_on_the_page():
    today = date(2026, 8, 9)
    assert _parse_date("Mon-Aug 10", today) == "2026-08-10"
    assert _parse_date("Mon-Jul 20", today) == "2026-07-20"
    # More than six months away belongs to the neighbouring year.
    assert _parse_date("Tue-Dec 30", date(2026, 1, 5)) == "2025-12-30"
    assert _parse_date("8/4/2026", today) == "2026-08-04"
    assert _parse_date("not a date", today) is None


# --- opponent summary -----------------------------------------------------


def test_unbeaten_opponent_is_described_flatly():
    note = describe_opponent(TOP, "Newsomecastle", [], "Sparrows FC")
    assert "1st, unbeaten in 3" in note
    assert "score 10.7 and concede 5.0" in note
    assert "not played them yet" in note
    # No predictions, no adjectives about difficulty.
    for word in ("tough", "easy", "should", "expect", "favourite"):
        assert word not in note.lower()


def test_a_winless_opponent_is_not_softened():
    winless = {**TOP, "position": 11, "w": 0, "l": 3, "pts": 0, "gf": 5, "ga": 30}
    note = describe_opponent(winless, "Strugglers", [], "Sparrows FC")
    assert "still looking for a win" in note
    assert "11th" in note


def test_a_previous_meeting_is_reported_either_way():
    fixtures = [
        {"date": "2026-07-20", "home": "Sparrows FC", "away": "Newsomecastle",
         "home_score": 7, "away_score": 30, "played": True},
    ]
    note = describe_opponent(TOP, "Newsomecastle", fixtures, "Sparrows FC")
    assert "They won 30-7 last time." in note

    fixtures[0].update(home_score=4, away_score=2)
    assert "You won 4-2 last time." in describe_opponent(
        TOP, "Newsomecastle", fixtures, "Sparrows FC")


def test_multiple_meetings_name_the_most_recent():
    fixtures = [
        {"date": "2026-06-01", "home": "Sparrows FC", "away": "Newsomecastle",
         "home_score": 1, "away_score": 0, "played": True},
        {"date": "2026-07-20", "home": "Newsomecastle", "away": "Sparrows FC",
         "home_score": 5, "away_score": 2, "played": True},
    ]
    note = describe_opponent(TOP, "Newsomecastle", fixtures, "Sparrows FC")
    assert "They won 5-2 in the most recent of 2 meetings." in note


def test_an_opponent_missing_from_the_table():
    note = describe_opponent(None, "New Team FC", [], "Sparrows FC")
    assert "not in the table yet" in note
