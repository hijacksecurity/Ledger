"""The activities-per-week figure, computed in exactly one place.

Three screens were showing three different numbers for the same thing — the
week hero said 4.20, the notebook page said 4.27, and the history page said
4.35 — because each divided a slightly different count by a slightly different
number of weeks. That is the failure this module exists to prevent.

The definition follows the paper notebook, verified against seven consecutive
of its pages:

    the figure on week N's header  =  activities through week N-1  ÷  (N-1)

Two details matter and neither is obvious:

  * The divisor is COMPLETED weeks. Week 86's header describes weeks 1-85, so
    it divides by 85. Including the week in progress drags the number down
    every Monday and lifts it back by Sunday — motion that says nothing about
    training.
  * The week number comes from the notebook page, not the calendar. Its
    counter runs about two ahead: the numbering slipped from 46 to 49 on
    2025-11-17, on consecutive Mondays. That is a known quirk, and carrying it
    forward is deliberate — an app that quietly disagrees with every page of
    the log it replaced is worse than one that inherits its arithmetic.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date, timedelta

from ledger.core.windows import to_date
from ledger.db import queries as q


@dataclass(frozen=True)
class Average:
    """The figure, plus everything needed to defend it."""

    value: float | None
    activities: int
    weeks: int | None
    through: str | None
    #: 'notebook' when divided by the page's own counter, 'elapsed' when it
    #: fell back to calendar weeks. Worth showing when the two disagree.
    basis: str

    def as_dict(self) -> dict[str, object]:
        return {
            "value": self.value,
            "activities": self.activities,
            "weeks": self.weeks,
            "through": self.through,
            "basis": self.basis,
        }


def activities_per_week(
    conn: sqlite3.Connection, week_start: str | date | None = None
) -> Average:
    """The lifetime average as of the week beginning `week_start`.

    Defaults to the current week, which is what "now" means on any screen.
    """
    first = q.first_session_date(conn)
    if not first:
        return Average(None, 0, None, None, "empty")

    if week_start is None:
        today = date.today()
        week_start = today - timedelta(days=today.weekday())
    start = to_date(week_start) if isinstance(week_start, str) else week_start

    through = (start - timedelta(days=1)).isoformat()
    activities = q.count_sessions_through(conn, through)

    page_number = q.week_number_for(conn, start.isoformat())
    if page_number and page_number > 1:
        weeks, basis = page_number - 1, "notebook"
    else:
        days = (to_date(through) - to_date(first)).days + 1
        weeks, basis = max(1, round(days / 7)), "elapsed"

    if weeks < 1 or activities == 0:
        return Average(None, activities, weeks, through, basis)

    return Average(round(activities / weeks, 2), activities, weeks, through, basis)
