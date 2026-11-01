"""Every windowed payload says what window it is.

Ten of the app's charts did not state their period, and the ones that did said
it three different ways — "12 weeks", "last 12 weeks", "trailing 28 days". A
chart whose timeframe you have to infer is a chart you cannot trust, and the
inference is usually wrong.

So each endpoint that returns a window also returns one of these, and the UI
renders `label` verbatim. One string, one source, no paraphrasing downstream.

## Where a window ends

Stating the period was only half of it. Twelve windows that all meant "now"
used to end on five different dates — the coming Sunday, today, the last logged
session, the last logged *run*, the Monday the final bucket starts on — so
panels sitting side by side read "to 16 Aug", "to 11 Aug", "to 10 Aug" and
"to 9 Aug" on the same Tuesday.

One rule now, applied here rather than at ten call sites:

    A window over the past ends today. It never claims days that have not
    happened, and it never stops short at the last row of data.

Two deliberate exceptions, both of which have to say so at the call site:

* `forecast=True` — a projection is *supposed* to be in the future.
* `one_week()` — names a calendar unit, so it keeps its Monday-to-Sunday `to`.
  It reports `as_of` for the part that has actually happened.

`as_of` is on every window: the last day genuinely covered. For a finished
period it equals `to`; for one still running it is today. It is the same
anchor `report/weekly.py` uses for the rolling load windows, for the same
reason — a window that resets or runs ahead of the calendar is not a window.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from ledger.core.windows import to_date

#: Grains the app actually uses. `session` means one row per activity rather
#: than a bucketed period.
GRAINS = ("day", "week", "month", "session", "match")


@dataclass(frozen=True)
class Timeframe:
    start: str | None
    end: str | None
    label: str
    grain: str
    periods: int | None = None
    #: True when the window is the whole record rather than a fixed span.
    all_time: bool = False
    #: Last day actually covered. Equals `end` for a finished period, today for
    #: one still running, None for a forecast (none of it has happened).
    as_of: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "from": self.start,
            "to": self.end,
            "label": self.label,
            "grain": self.grain,
            "periods": self.periods,
            "all_time": self.all_time,
            "as_of": self.as_of,
        }


def _d(value: str | date | None) -> date | None:
    if value is None:
        return None
    return to_date(value) if isinstance(value, str) else value


def _clamp(end: date | None, today: str | date | None) -> date | None:
    """Pull a window's end back to today. The one rule, in one place."""
    if end is None:
        return None
    now = _d(today) or date.today()
    return min(end, now)


def _short(d: date) -> str:
    return f"{d.day} {d:%b} {d.year}"


def _month(d: date) -> str:
    return f"{d:%b} {d.year}"


def window(
    start: str | date | None,
    end: str | date | None,
    grain: str = "week",
    periods: int | None = None,
    *,
    today: str | date | None = None,
    forecast: bool = False,
) -> Timeframe:
    """A fixed span, described the way a person would say it out loud.

    The end is pulled back to today unless `forecast=True`. Callers pass the
    nominal end of the last bucket — the Sunday the final week finishes on, not
    the Monday it starts — and this decides how much of it to claim.
    """
    s, e = _d(start), _d(end)
    if s is None or e is None:
        return Timeframe(None, None, "no data yet", grain, periods)

    if not forecast:
        e = _clamp(e, today)
        if e < s:               # the whole window is still ahead of us
            return Timeframe(s.isoformat(), s.isoformat(), "no data yet", grain, periods)

    if grain == "month":
        n = periods if periods is not None else _months_between(s, e)
        label = f"{n} months to {_month(e)}"
    elif grain == "week":
        n = periods if periods is not None else max(1, ((e - s).days + 1) // 7)
        label = f"{n} weeks to {_short(e)}"
    elif grain == "day":
        n = periods if periods is not None else (e - s).days + 1
        label = f"last {n} day{'s' if n != 1 else ''} · {_short(s)} to {_short(e)}"
    else:
        label = f"{_short(s)} to {_short(e)}"

    return Timeframe(
        s.isoformat(), e.isoformat(), label, grain, periods,
        as_of=None if forecast else e.isoformat(),
    )


def all_time(
    start: str | date | None, end: str | date | None, grain: str = "week",
    *, today: str | date | None = None,
) -> Timeframe:
    """The whole record. Says so, and says how long that is."""
    s, e = _d(start), _d(end)
    if s is None or e is None:
        return Timeframe(None, None, "no data yet", grain, None, all_time=True)

    e = max(_clamp(e, today), s)
    weeks = max(1, ((e - s).days + 1) // 7)
    label = f"all time · {_short(s)} to {_short(e)} · {weeks} weeks"
    return Timeframe(
        s.isoformat(), e.isoformat(), label, grain, weeks,
        all_time=True, as_of=e.isoformat(),
    )


def one_week(start: str | date, end: str | date,
             *, today: str | date | None = None) -> Timeframe:
    """A single Monday-Sunday week, named as a date range.

    The one exception to the clamp: this names a calendar unit, and the week of
    10-16 Aug is called that on the Tuesday as much as on the Sunday. `to` stays
    the Sunday; `as_of` carries how far into it we actually are.
    """
    s, e = _d(start), _d(end)
    if s is None or e is None:
        return Timeframe(None, None, "no data yet", "day", 7)

    if s.month == e.month and s.year == e.year:
        label = f"week of {s.day}–{e.day} {e:%b} {e.year}"
    else:
        label = f"week of {_short(s)} to {_short(e)}"
    return Timeframe(
        s.isoformat(), e.isoformat(), label, "day", 7,
        as_of=max(s, _clamp(e, today)).isoformat(),
    )


def counted(n: int, noun: str, start: str | date | None = None,
            end: str | date | None = None,
            *, today: str | date | None = None) -> Timeframe:
    """For lists whose window is a count, not a span — "most recent 5 matches".

    Here the span really is the rows, so it is reported as found rather than
    stretched to today: "most recent 20 runs · to 9 Aug" is a fact about the
    runs, not a window that has gone stale.
    """
    s, e = _d(start), _d(end)
    label = f"most recent {n} {noun}"
    if s and e:
        label += f" · {_short(s)} to {_short(e)}"
    return Timeframe(
        s.isoformat() if s else None, e.isoformat() if e else None,
        label, "match" if noun.startswith("match") else "session", n,
        as_of=_clamp(e, today).isoformat() if e else None,
    )


def _months_between(s: date, e: date) -> int:
    return (e.year - s.year) * 12 + (e.month - s.month) + 1
