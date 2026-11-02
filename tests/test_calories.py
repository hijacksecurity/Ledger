"""The calorie arithmetic, which lives in one place and is tested there.

The interesting cases are the ones where Garmin's figure is not the day's
burn: an unfinished day (bmr pro-rated, active still rising), a three-hour
row the nightly wrote for "today", a past day the watch has nothing for. Each
of those used to be a way to print a wrong number with a straight face.

All figures invented.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from ledger.db import queries as q
from ledger.report import calories

TODAY = "2026-03-20"
NOW = datetime(2026, 3, 20, 18, 36, tzinfo=UTC)


def _finished_days(conn, n=7, bmr=2180, active=600, start_back=1):
    """`n` finished days before TODAY, newest first offsets from start_back."""
    base = datetime.fromisoformat(TODAY).date()
    for i in range(start_back, start_back + n):
        day = (base - timedelta(days=i)).isoformat()
        q.upsert_metric_daily(
            conn, day, calories_bmr=bmr + (i % 3) - 1, calories_active=active,
            calories_total=bmr + (i % 3) - 1 + active, day_elapsed_min=1440,
            calories_fetched_at=f"{day}T23:59:00+00:00",
        )


def _day(conn, day=TODAY, **kw):
    kw.setdefault("today", TODAY)
    kw.setdefault("now", NOW)
    return calories.build(conn, day, day, **kw)["days"][0]


# --- the baseline -----------------------------------------------------------


def test_a_finished_day_uses_garmin_total_as_is(conn):
    _finished_days(conn, n=1)
    yesterday = "2026-03-19"
    q.add_meal(conn, yesterday, 700, "breakfast")
    q.add_meal(conn, yesterday, 900, "dinner")
    d = _day(conn, yesterday)
    assert d["status"] == "complete"
    assert d["burn"]["estimated"] is False
    assert d["burn"]["source"] == "garmin"
    assert d["burn"]["total"] == d["burn"]["bmr"] + d["burn"]["active"]
    assert d["intake"] == 1600
    assert d["deficit"] == d["burn"]["total"] - 1600
    assert d["eat_up_to"] == d["burn"]["total"] - 500
    assert d["left"] == d["eat_up_to"] - 1600


def test_an_unfinished_day_uses_the_median_baseline_plus_active_so_far(conn):
    _finished_days(conn, n=7, bmr=2180)
    # 18:36 on the day: Garmin's bmr is pro-rated, active is the running total.
    q.upsert_metric_daily(conn, TODAY, calories_bmr=1690, calories_active=640,
                          calories_total=2330, day_elapsed_min=1116,
                          calories_fetched_at=NOW.isoformat())
    d = _day(conn)
    b = d["burn"]
    assert d["status"] == "partial"
    assert b["estimated"] is True
    assert b["source"] == "baseline"
    assert b["bmr"] == 2180                      # median of 2179/2180/2181, not 1690
    assert b["active"] == 640
    assert b["total"] == 2820
    assert b["so_far"] == 2330
    assert b["baseline_note"] == "median of 7 finished days"
    assert "est." in d["arithmetic"]
    assert d["note"]


def test_with_no_history_the_day_is_extrapolated_from_its_elapsed_minutes(conn):
    q.upsert_metric_daily(conn, TODAY, calories_bmr=1690, calories_active=640,
                          calories_total=2330, day_elapsed_min=1116)
    b = _day(conn)["burn"]
    assert b["source"] == "extrapolated"
    assert b["bmr"] == round(1690 * 1440 / 1116)  # 2181
    assert b["total"] == b["bmr"] + 640


def test_fewer_than_three_recent_finished_days_falls_back_to_the_wider_window(conn):
    # Two finished days in the last week, five more three weeks back.
    _finished_days(conn, n=2, bmr=2200)
    _finished_days(conn, n=5, bmr=2100, start_back=20)
    kcal, note = calories.baseline_bmr(conn, TODAY)
    assert note == "median of 7 finished days"
    assert 2099 <= kcal <= 2201


def test_today_without_a_row_is_the_baseline_and_no_activity(conn):
    _finished_days(conn, n=7, bmr=2180)
    q.add_meal(conn, TODAY, 500, "breakfast")
    d = _day(conn)
    assert d["burn"]["bmr"] == 2180
    assert d["burn"]["active"] == 0
    assert d["burn"]["total"] == 2180
    assert d["burn"]["stale"] is True
    assert d["deficit"] == 1680


def test_a_past_day_without_a_row_has_no_burn_and_no_deficit(conn):
    _finished_days(conn, n=7)
    gap = "2026-03-10"
    q.upsert_metric_daily(conn, gap, sleep_hours=7.0)   # the watch was on, but no stats
    q.add_meal(conn, gap, 800, "lunch")
    d = _day(conn, gap)
    assert d["status"] == "no_burn"
    assert d["burn"]["total"] is None
    assert d["deficit"] is None
    assert d["arithmetic"] is None
    assert d["intake"] == 800
    assert "No burn" in d["note"]


def test_a_three_hour_nightly_row_is_not_a_finished_day(conn):
    """The 03:00 nightly writes today's row with three hours on it. A past
    date is not enough to call that finished."""
    _finished_days(conn, n=7, bmr=2180, start_back=2)
    yesterday = "2026-03-19"
    q.upsert_metric_daily(conn, yesterday, calories_bmr=270, calories_active=5,
                          calories_total=275, day_elapsed_min=180)
    d = _day(conn, yesterday)
    assert d["burn"]["complete"] is False
    assert d["burn"]["estimated"] is True
    assert d["burn"]["bmr"] == 2180
    assert d["burn"]["total"] == 2185
    assert d["status"] == "partial"
    # And it does not feed the baseline.
    assert calories.baseline_bmr(conn, TODAY)[1] == "median of 7 finished days"


def test_a_row_from_before_the_elapsed_column_counts_by_its_date(conn):
    q.upsert_metric_daily(conn, "2026-03-19", calories_bmr=2180, calories_active=500,
                          calories_total=2680)
    assert calories.is_complete(q.metrics_between(conn, "2026-03-19", "2026-03-19")[0],
                                "2026-03-19", TODAY) is True
    q.upsert_metric_daily(conn, TODAY, calories_bmr=1500, calories_active=200,
                          calories_total=1700)
    assert calories.is_complete(q.metrics_between(conn, TODAY, TODAY)[0], TODAY, TODAY) is False


# --- the line and the figures ------------------------------------------------


def test_the_arithmetic_line_matches_the_figures(conn):
    _finished_days(conn, n=1, bmr=2180, active=712)
    q.add_meal(conn, "2026-03-19", 1_300, "lunch")
    q.add_meal(conn, "2026-03-19", 900, "dinner")
    d = _day(conn, "2026-03-19")
    bmr, active, total = d["burn"]["bmr"], d["burn"]["active"], d["burn"]["total"]
    assert d["arithmetic"] == (
        f"{bmr:,} baseline + {active:,} active = {total:,} burned · 2,200 eaten · "
        f"{total - 2200:,} under"
    )


def test_over_and_even_read_as_such():
    burn = {"bmr": 2000, "active": 500, "total": 2500, "complete": True}
    assert calories.arithmetic_line(burn, 2700, -200).endswith("· 2,700 eaten · 200 over")
    assert calories.arithmetic_line(burn, 2500, 0).endswith("· 2,500 eaten · even")
    assert calories.arithmetic_line({**burn, "total": None}, 100, None) is None


def test_standing_is_five_words_against_the_target():
    s = calories.standing_of
    assert s(None, 500) is None
    assert s(500, 500) == "met"
    assert s(900, 500) == "met"
    assert s(499, 500) == "close"
    assert s(250, 500) == "close"
    assert s(249, 500) == "short"
    assert s(0, 500) == "short"
    assert s(-1, 500) == "over"
    assert s(-499, 500) == "over"
    assert s(-500, 500) == "far_over"
    assert s(0, 0) == "met"          # a target of zero is met at even


def test_the_day_and_the_means_carry_a_standing(conn):
    _finished_days(conn, n=7, bmr=2180, active=600)
    for day in ("2026-03-19", "2026-03-18"):
        q.add_meal(conn, day, 2100, "all day")       # about 680 under
    out = calories.build(conn, "2026-03-19", TODAY, today=TODAY, now=NOW)
    assert out["days"][0]["standing"] == "met"
    assert out["days"][-1]["standing"] is None or out["days"][-1]["status"] != "no_burn"
    assert out["summary"]["standing_7"] == "met"
    assert out["summary"]["standing_28"] == "met"


def test_stale_is_ten_minutes_and_today_only(conn):
    q.upsert_metric_daily(conn, TODAY, calories_bmr=1690, calories_active=640,
                          calories_total=2330, day_elapsed_min=1116,
                          calories_fetched_at=(NOW - timedelta(minutes=9)).isoformat())
    assert _day(conn)["burn"]["stale"] is False
    q.upsert_metric_daily(conn, TODAY, calories_fetched_at=(NOW - timedelta(minutes=11)).isoformat())
    assert _day(conn)["burn"]["stale"] is True
    # Yesterday is never stale: it is finished, or it is not going to improve.
    q.upsert_metric_daily(conn, "2026-03-19", calories_bmr=2180, calories_active=500,
                          calories_total=2680, day_elapsed_min=1440,
                          calories_fetched_at="2026-03-01T00:00:00+00:00")
    assert _day(conn, "2026-03-19")["burn"]["stale"] is False


# --- the means ----------------------------------------------------------------


def test_an_unlogged_day_is_absent_from_the_means(conn):
    _finished_days(conn, n=10, bmr=2180, active=600)
    # Meals on three of the last seven days only.
    for day, kcal in (("2026-03-19", 2000), ("2026-03-18", 2300), ("2026-03-16", 2600)):
        q.add_meal(conn, day, kcal, "all day")
    s = calories.build(conn, TODAY, TODAY, today=TODAY, now=NOW)["summary"]
    assert s["days_counted_7"] == 3
    assert s["days_counted_28"] == 3
    # Each day's burn is 2179..2181 + 600; the mean is over the three logged days.
    assert 400 <= s["mean_deficit_7"] <= 520


def test_today_never_enters_the_means(conn):
    _finished_days(conn, n=7)
    q.add_meal(conn, TODAY, 300, "breakfast")
    s = calories.build(conn, TODAY, TODAY, today=TODAY, now=NOW)["summary"]
    assert s["days_counted_7"] == 0
    assert s["mean_deficit_7"] is None


def test_the_target_defaults_to_500_and_reads_the_setting(conn):
    assert calories.deficit_target(conn) == (500, True, None)
    q.set_setting(conn, calories.DEFICIT_TARGET_KEY, "450")
    kcal, is_default, updated = calories.deficit_target(conn)
    assert (kcal, is_default) == (450, False)
    assert updated
    _finished_days(conn, n=1, bmr=2180, active=600)
    d = _day(conn, "2026-03-19")
    assert d["target"] == 450
    assert d["eat_up_to"] == d["burn"]["total"] - 450


def test_the_window_is_filled_day_by_day_and_labelled(conn):
    out = calories.build(conn, "2026-03-14", TODAY, today=TODAY, now=NOW)
    assert [d["date"] for d in out["days"]][0] == "2026-03-14"
    assert len(out["days"]) == 7
    assert out["timeframe"]["label"].startswith("last 7 days")
    assert out["days"][-1]["weekday"] == "Fri"
