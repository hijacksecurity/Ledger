"""What a habit day is worth, and what it is not worth.

Habits are the feature where two things this project has ruled out normally get
in: a streak, and a day that reads as a failure because nobody was there to
record it. These pin both shut, plus the partial band — the one piece of
arithmetic the user will actually check against the page.

The seeded habits are the three the user asked for, so the fixtures below use
them rather than inventing a fourth: the migration is part of what is tested.
"""

from __future__ import annotations

from datetime import date, timedelta

from ledger.db import queries as q
from ledger.report import habits

#: A Monday, and a Friday inside that week.
MONDAY = date(2026, 9, 7)
TODAY = date(2026, 9, 11)
SUNDAY = MONDAY + timedelta(days=6)


def _day(n: int) -> str:
    return (MONDAY + timedelta(days=n)).isoformat()


def _kept_since(conn, day="2026-01-01"):
    """Back-date the seeded habits so the week under test is inside tracking.

    The migration stamps `created_at` with the clock, and a habit is not scored
    before it existed — so without this every fixture week sits in the
    untracked window and every assertion below is about the wrong thing. The
    pre-creation window has its own tests further down.
    """
    conn.execute("UPDATE habit SET created_at = ?", (f"{day}T00:00:00+00:00",))


def _build(conn, **kw):
    _kept_since(conn)
    return habits.build(
        conn, MONDAY.isoformat(), SUNDAY.isoformat(), today=TODAY.isoformat(), **kw
    )


def _of(payload, key):
    return next(h for h in payload["habits"] if h["key"] == key)


# --- the seed -------------------------------------------------------------


def test_the_three_habits_are_seeded(conn):
    keys = [h["key"] for h in _build(conn)["habits"]]
    assert keys == ["stretch", "sleep", "no_takeout"]


def test_sleep_is_measured_and_the_other_two_are_tapped(conn):
    payload = _build(conn)
    assert _of(payload, "sleep")["mode"] == "metric"
    assert _of(payload, "sleep")["target"] == 8.0
    assert _of(payload, "stretch")["mode"] == "manual"
    assert _of(payload, "no_takeout")["polarity"] == "avoid"


# --- manual habits --------------------------------------------------------


def test_a_tapped_day_is_met_and_an_untapped_past_day_is_missed(conn):
    with conn:
        q.mark_habit_day(conn, 1, _day(0), done=True)
    days = _of(_build(conn), "stretch")["days"]
    assert days[_day(0)]["state"] == "met"
    assert days[_day(0)]["credit"] == 1.0
    assert days[_day(1)]["state"] == "missed"
    assert days[_day(1)]["credit"] == 0.0


def test_today_is_open_not_missed(conn):
    """The day is not over. Grading it would make every morning a failure."""
    days = _of(_build(conn), "stretch")["days"]
    assert days[TODAY.isoformat()]["state"] == "open"
    assert days[TODAY.isoformat()]["credit"] is None


def test_tomorrow_is_ahead_not_missed(conn):
    days = _of(_build(conn), "stretch")["days"]
    assert days[SUNDAY.isoformat()]["state"] == "ahead"
    assert days[SUNDAY.isoformat()]["credit"] is None


def test_clearing_a_day_removes_it_rather_than_zeroing_it(conn):
    with conn:
        q.mark_habit_day(conn, 1, _day(0), done=True)
        q.clear_habit_day(conn, 1, _day(0))
    assert _of(_build(conn), "stretch")["days"][_day(0)]["state"] == "missed"
    assert q.habit_days(conn, _day(0), _day(0)) == []


# --- the measured habit ---------------------------------------------------


def _sleep(conn, n: int, hours: float) -> None:
    q.upsert_metric_daily(conn, _day(n), sleep_hours=hours)


def test_eight_hours_earns_the_tick(conn):
    with conn:
        _sleep(conn, 0, 8.0)
        _sleep(conn, 1, 8.75)
    days = _of(_build(conn), "sleep")["days"]
    assert days[_day(0)]["state"] == "met"
    assert days[_day(1)]["state"] == "met"
    assert days[_day(1)]["credit"] == 1.0


def test_the_partial_band_ramps_between_seven_and_eight(conn):
    """7 h is half a day, 8 h is a whole one, 7.5 h is three quarters.

    The user picked "met at 7 h, full marks at 8 h" and then asked for the
    check itself to stay at 8. Both hold here: credit moves through the band,
    and only `met` is ever the tick.
    """
    with conn:
        _sleep(conn, 0, 7.0)
        _sleep(conn, 1, 7.5)
        _sleep(conn, 2, 6.99)
    days = _of(_build(conn), "sleep")["days"]
    assert {k: days[_day(0)][k] for k in ("state", "credit", "value", "source")} == {
        "state": "partial", "credit": 0.5, "value": 7.0, "source": "garmin"}
    assert days[_day(1)]["credit"] == 0.75
    assert days[_day(2)]["state"] == "missed"
    assert days[_day(2)]["credit"] == 0.0
    assert {d["state"] for d in days.values()} & {"met"} == set()


def test_a_night_with_no_reading_is_not_a_miss(conn):
    """The watch was on the charger. That is not a night you slept badly."""
    with conn:
        _sleep(conn, 0, 8.0)
    days = _of(_build(conn), "sleep")["days"]
    assert days[_day(1)]["state"] == "unrecorded"
    assert days[_day(1)]["credit"] is None


def test_an_unrecorded_night_leaves_the_denominator(conn):
    with conn:
        _sleep(conn, 0, 8.0)
        _sleep(conn, 1, 8.0)
    totals = _of(_build(conn), "sleep")["totals"]
    assert totals == {"met": 2, "scored": 2, "credit": 2.0, "rate": 1.0}


def test_a_hand_entered_value_outranks_the_watch(conn):
    with conn:
        _sleep(conn, 0, 5.0)
        q.mark_habit_day(conn, 2, _day(0), value=8.25)
    day = _of(_build(conn), "sleep")["days"][_day(0)]
    assert day["state"] == "met"
    assert day["value"] == 8.25
    assert day["source"] == "manual"


def test_clearing_an_override_hands_the_day_back_to_the_sync(conn):
    with conn:
        _sleep(conn, 0, 5.0)
        q.mark_habit_day(conn, 2, _day(0), value=8.25)
        q.clear_habit_day(conn, 2, _day(0))
    day = _of(_build(conn), "sleep")["days"][_day(0)]
    assert day["value"] == 5.0
    assert day["source"] == "garmin"
    assert day["state"] == "missed"


# --- totals ---------------------------------------------------------------


def test_totals_count_completed_days_only(conn):
    """Four days have finished in this week. Today and the weekend have not."""
    with conn:
        q.mark_habit_day(conn, 1, _day(0), done=True)
        q.mark_habit_day(conn, 1, _day(2), done=True)
        q.mark_habit_day(conn, 1, TODAY.isoformat(), done=True)
    totals = _of(_build(conn), "stretch")["totals"]
    assert totals["scored"] == 4
    assert totals["met"] == 2
    assert totals["rate"] == 0.5


def test_a_week_with_nothing_finished_scores_nothing(conn):
    """Monday morning. There is no rate, rather than a rate of zero."""
    _kept_since(conn)
    payload = habits.build(
        conn, MONDAY.isoformat(), SUNDAY.isoformat(), today=MONDAY.isoformat()
    )
    assert payload["scored_through"] is None
    for h in payload["habits"]:
        assert h["totals"]["scored"] == 0
        assert h["totals"]["rate"] is None


def test_partial_credit_reaches_the_rate(conn):
    with conn:
        _sleep(conn, 0, 8.0)   # 1.0
        _sleep(conn, 1, 7.5)   # 0.75
        _sleep(conn, 2, 4.0)   # 0.0
        _sleep(conn, 3, 7.0)   # 0.5
    totals = _of(_build(conn), "sleep")["totals"]
    assert totals["credit"] == 2.25
    assert totals["scored"] == 4
    assert totals["rate"] == 0.5625
    assert totals["met"] == 1


# --- the rules that must not move -----------------------------------------


def test_nothing_here_counts_consecutively(conn):
    """No streak, by construction: the payload has nowhere to put one."""
    with conn:
        for n in range(4):
            q.mark_habit_day(conn, 1, _day(n), done=True)
    h = _of(_build(conn), "stretch")
    assert "streak" not in h
    assert "streak" not in h["totals"]
    assert set(h["totals"]) == {"met", "scored", "credit", "rate"}


def test_a_habit_tick_is_not_a_session(conn):
    """The load scale and the boxed activities-per-week figure stay untouched."""
    with conn:
        for n in range(4):
            q.mark_habit_day(conn, 1, _day(n), done=True)
            q.mark_habit_day(conn, 3, _day(n), done=True)
    assert conn.execute("SELECT COUNT(*) FROM session").fetchone()[0] == 0


# --- archiving ------------------------------------------------------------


def test_an_archived_habit_leaves_the_page_but_keeps_its_history(conn):
    with conn:
        q.mark_habit_day(conn, 1, _day(0), done=True)
        q.update_habit(conn, 1, archived_at="2026-09-11T00:00:00+00:00")

    assert [h["key"] for h in _build(conn)["habits"]] == ["sleep", "no_takeout"]

    kept = _of(_build(conn, include_archived=True), "stretch")
    assert kept["archived"] is True
    assert kept["days"][_day(0)]["state"] == "met"


# --- the window -----------------------------------------------------------


def test_a_calendar_week_keeps_its_sunday(conn):
    """`one_week` names the unit; a trailing window clamps to today."""
    week = _build(conn)["timeframe"]
    assert week["label"] == "week of 7–13 Sep 2026"
    assert week["to"] == SUNDAY.isoformat()
    assert week["as_of"] == TODAY.isoformat()

    trailing = habits.build(
        conn, _day(1), TODAY.isoformat(), today=TODAY.isoformat()
    )["timeframe"]
    assert trailing["label"] == "last 4 days · 8 Sep 2026 to 11 Sep 2026"


# --- before the habit existed ---------------------------------------------


def test_a_day_before_the_habit_existed_is_not_a_miss(conn):
    """The seeded habits are created "now"; a week in 2020 predates all of them.

    Without this the twelve-week chart opens with eleven weeks of failure at
    something nobody was being asked to do — every past day resolving as
    `missed` purely because no row exists for it.
    """
    payload = habits.build(conn, "2020-01-06", "2020-01-12", today="2026-09-13")
    for h in payload["habits"]:
        assert {d["state"] for d in h["days"].values()} == {"untracked"}
        assert h["totals"]["scored"] == 0
        assert h["totals"]["rate"] is None


def test_a_night_before_tracking_is_shown_but_not_scored(conn):
    """Garmin had months of sleep before sleep was a goal.

    Hiding it would throw away the history the user wants to look at; scoring
    it would grade them against a target that did not exist. So the night keeps
    its reading and its state, and carries `counts: False`.
    """
    with conn:
        q.upsert_metric_daily(conn, "2020-01-06", sleep_hours=9.0)
    day = habits.build(conn, "2020-01-06", "2020-01-06", today="2026-09-13")
    sleep = _of(day, "sleep")
    assert sleep["days"]["2020-01-06"]["value"] == 9.0
    assert sleep["days"]["2020-01-06"]["state"] == "met"
    assert sleep["days"]["2020-01-06"]["counts"] is False
    assert sleep["totals"]["scored"] == 0


def test_tracking_starts_on_the_monday_of_the_week_it_was_created(conn):
    """A habit set up on a Friday covers that whole week, not just Friday on."""
    with conn:
        conn.execute("UPDATE habit SET created_at = ?", (_day(4) + "T09:00:00+00:00",))
    h = _of(habits.build(conn, MONDAY.isoformat(), SUNDAY.isoformat(),
                         today=TODAY.isoformat()), "stretch")
    assert h["since"] == MONDAY.isoformat()
    assert h["days"][_day(0)]["state"] == "missed"      # Monday counts
    assert h["days"][_day(0)]["counts"] is True


def test_the_habit_publishes_the_day_it_started(conn):
    for h in _build(conn)["habits"]:
        assert h["since"] is not None


def test_a_habit_added_this_week_covers_the_whole_week(conn):
    """Week-anchored, so a habit added on Wednesday still owns its Monday.

    The previous rule dated tracking from the creation *day*, which put a hole
    in the middle of the user's own first week — marked Monday, marked
    Tuesday, untracked Thursday — and hid every night of sleep before it.
    """
    with conn:
        _kept_since(conn)
        q.add_habit(conn, "mobility", "Ten minutes of mobility")
        conn.execute("UPDATE habit SET created_at = ? WHERE key = 'mobility'",
                     (_day(2) + "T00:00:00+00:00",))
    h = _of(habits.build(conn, MONDAY.isoformat(), SUNDAY.isoformat(),
                         today=TODAY.isoformat(), include_archived=True), "mobility")
    assert h["since"] == MONDAY.isoformat()
    assert h["days"][_day(1)]["state"] == "missed"
    assert h["totals"]["scored"] == 4   # Mon-Thu; Fri is today


def test_the_week_before_it_was_added_is_still_untracked(conn):
    with conn:
        _kept_since(conn)
        q.add_habit(conn, "mobility", "Ten minutes of mobility")
        conn.execute("UPDATE habit SET created_at = ? WHERE key = 'mobility'",
                     (_day(2) + "T00:00:00+00:00",))
    prev = (MONDAY - timedelta(days=7)).isoformat()
    h = _of(habits.build(conn, prev, (MONDAY - timedelta(days=1)).isoformat(),
                         today=TODAY.isoformat(), include_archived=True), "mobility")
    assert {d["state"] for d in h["days"].values()} == {"untracked"}
    assert h["totals"]["scored"] == 0


# --- the weekly trend ------------------------------------------------------


def test_the_trend_returns_one_entry_per_week(conn):
    _kept_since(conn)
    out = habits.trend(conn, weeks=4, today=TODAY.isoformat())
    assert len(out["weeks"]) == 4
    assert out["weeks"][-1]["week_start"] == MONDAY.isoformat()
    assert out["weeks"][0]["week_start"] == (MONDAY - timedelta(days=21)).isoformat()


def test_the_trend_carries_no_day_maps(conn):
    """Twelve weeks of eighty-four day records is a payload nobody reads."""
    _kept_since(conn)
    week = habits.trend(conn, weeks=4, today=TODAY.isoformat())["weeks"][0]
    for h in week["habits"]:
        assert "days" not in h
        assert set(h["totals"]) == {"met", "scored", "credit", "rate"}


def test_weeks_before_tracking_began_are_empty_not_zero(conn):
    """The user's actual situation: habits started this week."""
    _kept_since(conn, MONDAY.isoformat())
    out = habits.trend(conn, weeks=4, today=TODAY.isoformat())
    earlier = out["weeks"][:-1]
    assert earlier, "expected weeks before the current one"
    for w in earlier:
        for h in w["habits"]:
            assert h["totals"]["scored"] == 0
            assert h["totals"]["rate"] is None


def test_the_trend_agrees_with_build_for_the_same_week(conn):
    """One definition of a week's totals, reachable two ways."""
    with conn:
        _kept_since(conn)
        q.mark_habit_day(conn, 1, _day(0), done=True)
    trend_week = habits.trend(conn, weeks=1, today=TODAY.isoformat())["weeks"][-1]
    direct = _build(conn)
    for a, b in zip(trend_week["habits"], direct["habits"], strict=True):
        assert a["key"] == b["key"]
        assert a["totals"] == b["totals"]
