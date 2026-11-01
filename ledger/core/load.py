"""Unified load and ACWR (BRIEF §8).

The reason this tool exists. Foster's session-RPE is modality-agnostic, which
puts a squat session, a tempo run and an indoor soccer match on one comparable
scale — and gives soccer sessions that Garmin's own model barely registers
their real weight.

    session_load = rpe * duration_minutes      # rpe on 0-10
    acute        = mean daily load, trailing 7 days
    chronic      = mean daily load, trailing 28 days
    acwr         = acute / chronic
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date

from ledger.core.windows import daily_totals

#: ACWR is not computed before this much history exists. An early ratio built
#: on a partial chronic window is not a small error, it is a wrong number.
MIN_DAYS_FOR_ACWR = 28

STEADY_LOW = 0.8
STEADY_HIGH = 1.3
SPIKE = 1.5


def session_load(rpe: float | None, duration_min: float | None) -> float | None:
    """Foster session-RPE load. None when either input is missing.

    Missing load is not zero load — a session logged without an RPE should be
    excluded from the mean, not counted as an easy day.
    """
    if rpe is None or duration_min is None:
        return None
    if rpe < 0 or duration_min <= 0:
        return None
    return rpe * duration_min


@dataclass(frozen=True)
class ACWR:
    acute: float
    chronic: float
    ratio: float | None
    days_of_history: int

    @property
    def available(self) -> bool:
        return self.ratio is not None

    @property
    def band(self) -> str:
        """A heuristic flag, never a verdict (BRIEF §8).

        Deliberately not colour-coded good/bad by this module. ACWR has real
        methodological criticism in the literature; it is one input among
        several, alongside HRV and readiness.
        """
        if self.ratio is None:
            return "building baseline"
        if self.ratio >= SPIKE:
            return "sharp increase"
        if STEADY_LOW <= self.ratio <= STEADY_HIGH:
            return "steady"
        if self.ratio < STEADY_LOW:
            return "below recent average"
        return "elevated"


def compute_acwr(
    loads: Iterable[tuple[str, float]],
    end: str | date,
    days_of_history: int,
) -> ACWR:
    """`loads` is (date, session_load) for every scored session.

    `days_of_history` is how many days of data the database actually holds —
    days since the first ever session, not the number of days with sessions.
    """
    acute_days = daily_totals(loads, end, 7)
    chronic_days = daily_totals(loads, end, 28)

    acute = sum(v for _, v in acute_days) / 7
    chronic = sum(v for _, v in chronic_days) / 28

    ratio: float | None = None
    if days_of_history >= MIN_DAYS_FOR_ACWR and chronic > 0:
        ratio = acute / chronic

    return ACWR(
        acute=acute, chronic=chronic, ratio=ratio, days_of_history=days_of_history
    )


def load_by_kind(
    sessions: Sequence[tuple[str, str, float]], start: str, end: str
) -> dict[str, float]:
    """(date, kind, load) -> {kind: total load} within [start, end] inclusive."""
    out: dict[str, float] = {}
    for d, kind, value in sessions:
        if start <= d <= end:
            out[kind] = out.get(kind, 0.0) + value
    return out


def modality_split(totals: dict[str, float]) -> dict[str, float]:
    """{kind: fraction of total load}. Empty dict when there is no load."""
    total = sum(totals.values())
    if total <= 0:
        return {}
    return {k: v / total for k, v in sorted(totals.items())}
