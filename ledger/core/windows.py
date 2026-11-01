"""Rolling-window aggregations (BRIEF §6).

Rolling windows only. No streaks. A 28-day rolling count dips when a week is
missed and recovers naturally — that is the desired behaviour, not a bug to
fix. Nothing in this module may ever reset to zero because of one missed day.

Everything here is pure and operates on local 'YYYY-MM-DD' strings, which sort
lexicographically in date order. Daily aggregation happens on that string and
never on a UTC timestamp (BRIEF §5).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, timedelta

ISO = "%Y-%m-%d"


def to_date(s: str) -> date:
    return date.fromisoformat(s)


def window_start(end: str | date, days: int) -> str:
    """First day of a `days`-long window ending on (and including) `end`."""
    end_d = to_date(end) if isinstance(end, str) else end
    return (end_d - timedelta(days=days - 1)).isoformat()


def day_range(end: str | date, days: int) -> list[str]:
    """Every date string in the window, oldest first."""
    end_d = to_date(end) if isinstance(end, str) else end
    return [(end_d - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]


def in_window(dates: Iterable[str], end: str | date, days: int) -> list[str]:
    start = window_start(end, days)
    end_s = end if isinstance(end, str) else end.isoformat()
    return [d for d in dates if start <= d <= end_s]


def rolling_count(dates: Iterable[str], end: str | date, days: int = 28) -> int:
    """How many events fall inside the trailing window. Duplicates count."""
    return len(in_window(dates, end, days))


def rolling_count_by_kind(
    events: Iterable[tuple[str, str]], end: str | date, days: int = 28
) -> dict[str, int]:
    """`events` is (date, kind) pairs -> {kind: count} inside the window."""
    start = window_start(end, days)
    end_s = end if isinstance(end, str) else end.isoformat()
    return dict(Counter(kind for d, kind in events if start <= d <= end_s))


def planned_in_window(planned_per_week: Mapping[str, int], days: int = 28) -> dict[str, float]:
    """Scale a weekly plan to the window length."""
    weeks = days / 7
    return {kind: n * weeks for kind, n in planned_per_week.items()}


def consistency(
    events: Iterable[tuple[str, str]],
    planned_per_week: Mapping[str, int],
    end: str | date,
    days: int = 28,
) -> dict[str, tuple[int, float]]:
    """{kind: (completed, planned)} over the trailing window.

    Returned as raw counts, not a percentage. The report decides how to phrase
    it; there is deliberately no pass/fail threshold in here.
    """
    done = rolling_count_by_kind(events, end, days)
    planned = planned_in_window(planned_per_week, days)
    kinds = set(done) | set(planned)
    return {k: (done.get(k, 0), planned.get(k, 0.0)) for k in sorted(kinds)}


def avg_activities_per_week(
    total_activities: int, first_date: str | None, end: str | date
) -> float | None:
    """The notebook's own headline number: lifetime activities per week.

    This is the boxed value on every page of the paper log — cumulative logged
    activities divided by weeks elapsed (see docs/NOTEBOOK.md). It is already
    exactly what BRIEF §6 argues for: an input count, never a performance
    measure, that dips on a bad week and recovers without ever resetting.

    Returns None before a full week of history exists.
    """
    if not first_date or total_activities < 0:
        return None
    end_d = to_date(end) if isinstance(end, str) else end
    days = (end_d - to_date(first_date)).days + 1
    if days < 7:
        return None
    return round(total_activities / (days / 7), 2)


def daily_totals(
    values: Iterable[tuple[str, float]], end: str | date, days: int
) -> list[tuple[str, float]]:
    """Sum values per day across the whole window, zero-filling empty days.

    Zero-filling matters: a rest day is a real zero for load purposes, and
    dropping it would inflate every mean (BRIEF §8).
    """
    totals: dict[str, float] = {}
    for d, v in values:
        totals[d] = totals.get(d, 0.0) + v
    return [(d, totals.get(d, 0.0)) for d in day_range(end, days)]


def ema(values: Sequence[float], span: int = 7) -> list[float]:
    """Exponential moving average, standard alpha = 2 / (span + 1).

    Seeded with the first observation, so the series is the same length as the
    input and the early values are simply less smoothed.
    """
    if not values:
        return []
    alpha = 2 / (span + 1)
    out = [float(values[0])]
    for v in values[1:]:
        out.append(alpha * v + (1 - alpha) * out[-1])
    return out


def ema_series(
    observations: Sequence[tuple[str, float]], span: int = 7
) -> list[tuple[str, float]]:
    """EMA over recorded observations in date order (BRIEF §7).

    Computed over the observations that exist rather than over a zero-filled
    calendar: a missed weigh-in is missing data, not a bodyweight of zero.
    """
    ordered = sorted(observations)
    smoothed = ema([v for _, v in ordered], span)
    return [(d, s) for (d, _), s in zip(ordered, smoothed, strict=True)]
