"""Windows that mean "now" have to end on the same day.

Twelve of them did not. On Tuesday 11 August 2026, panels sitting side by side
on the same screen said:

    week            to 16 Aug   (the coming Sunday — five days that had not happened)
    12-week load    to 16 Aug
    26-week average to 16 Aug
    all time        to 16 Aug
    trailing 28d    to 11 Aug   (right)
    soccer          to 11 Aug   (right)
    sessions        to 10 Aug   (the last logged session)
    runs            to  9 Aug   (the last logged *run*)
    plan history    to 10 Aug   (the Monday the final bucket starts on)

Five different dates for one moment. Nothing was arithmetically wrong — the
figures were fine — but a reader cannot line up two panels whose windows are
described differently, and "is this twelve weeks or a year?" was exactly the
question the timeframe line was added to answer.

The rule, enforced in `report/timeframe.py` rather than at ten call sites:

    A window over the past ends today. It never claims days that have not
    happened, and it never stops short at the last row of data.

with two exceptions that have to be asked for explicitly — a forecast, and
`one_week()`, which names a calendar unit and reports `as_of` instead.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from ledger.report import timeframe

#: A Tuesday, two days into the week of 10-16 August.
TODAY = date(2026, 8, 11)
MONDAY = date(2026, 8, 10)
SUNDAY = date(2026, 8, 16)


def test_a_window_never_ends_in_the_future():
    tf = timeframe.window(date(2026, 5, 25), SUNDAY, "week", 12, today=TODAY)

    assert tf.end == TODAY.isoformat()
    assert tf.label == "12 weeks to 11 Aug 2026"


def test_all_time_stops_today_too():
    tf = timeframe.all_time(date(2025, 1, 1), SUNDAY, "day", today=TODAY)

    assert tf.end == TODAY.isoformat()
    assert "to 11 Aug 2026" in tf.label


def test_every_retrospective_window_agrees_on_where_now_is():
    """The actual complaint: same moment, same date, whatever the grain."""
    windows = [
        timeframe.window(date(2026, 5, 25), SUNDAY, "week", 12, today=TODAY),
        timeframe.window(date(2026, 2, 9), SUNDAY, "week", 26, today=TODAY),
        timeframe.window(date(2026, 7, 15), TODAY, "day", 28, today=TODAY),
        timeframe.window(date(2025, 1, 1), SUNDAY, "month", 20, today=TODAY),
        timeframe.window(date(2025, 1, 1), SUNDAY, "session", 371, today=TODAY),
        timeframe.all_time(date(2025, 1, 1), SUNDAY, "day", today=TODAY),
    ]

    assert {w.end for w in windows} == {TODAY.isoformat()}
    assert {w.as_of for w in windows} == {TODAY.isoformat()}


def test_a_finished_window_keeps_its_own_end():
    """Clamping pulls back; it never pushes forward to today."""
    tf = timeframe.window(date(2026, 1, 1), date(2026, 3, 31), "month", 3, today=TODAY)

    assert tf.end == "2026-03-31"
    assert tf.as_of == "2026-03-31"


def test_a_forecast_is_allowed_to_be_in_the_future():
    tf = timeframe.window(
        date(2026, 8, 17), date(2026, 10, 11), "week", 8, today=TODAY, forecast=True
    )

    assert tf.end == "2026-10-11"
    # Nothing in it has happened, so there is no "as of" to report.
    assert tf.as_of is None


def test_a_named_week_keeps_its_sunday_but_says_how_far_in_it_is():
    """The one exception. The week of 10-16 Aug is called that on the Tuesday
    as much as on the Sunday, so the label and `to` do not move — but `as_of`
    must not claim the five days still to come."""
    tf = timeframe.one_week(MONDAY, SUNDAY, today=TODAY)

    assert tf.end == SUNDAY.isoformat()
    assert tf.label == "week of 10–16 Aug 2026"
    assert tf.as_of == TODAY.isoformat()


def test_a_finished_week_is_as_of_its_own_sunday():
    tf = timeframe.one_week(date(2026, 8, 3), date(2026, 8, 9), today=TODAY)

    assert tf.as_of == "2026-08-09"


@pytest.mark.parametrize("grain", ["day", "week", "month", "session"])
def test_the_label_quotes_the_clamped_end_not_the_requested_one(grain):
    """A label built from the unclamped end would put the right dates in
    `from`/`to` and the wrong one in the sentence the user actually reads."""
    tf = timeframe.window(date(2026, 1, 1), SUNDAY, grain, 5, today=TODAY)

    assert "16 Aug" not in tf.label
    assert tf.end in (TODAY.isoformat(),)


def test_a_window_entirely_in_the_future_has_no_data_yet():
    tf = timeframe.window(date(2026, 9, 1), date(2026, 9, 30), "week", 4, today=TODAY)

    assert tf.label == "no data yet"


def test_a_counted_window_reports_the_rows_it_found():
    """"Most recent 20 runs" ending three days ago is a fact about the runs,
    not a window that has gone stale — so this one is not stretched to today."""
    tf = timeframe.counted(20, "sessions", date(2026, 6, 1), date(2026, 8, 9),
                           today=TODAY)

    assert tf.end == "2026-08-09"
    assert "9 Aug 2026" in tf.label


def test_as_of_is_published_so_the_ui_can_show_it():
    assert "as_of" in timeframe.window(MONDAY, SUNDAY, "week", 1, today=TODAY).as_dict()


def test_the_clamp_defaults_to_the_real_today():
    """No `today` passed is the production path; it must still not run ahead."""
    far = date.today() + timedelta(days=90)
    tf = timeframe.window(date.today() - timedelta(days=7), far, "week", 14)

    assert tf.end == date.today().isoformat()
