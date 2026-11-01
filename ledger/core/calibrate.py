"""One load scale: Garmin's, with the gaps filled in.

The app used to publish its own Foster session-RPE figure (rpe x minutes)
alongside Garmin's training load and let them disagree — by a factor of 1.0 on
solo drills and 4.5 on a soccer match. Two numbers for one idea is worse than
either alone.

So Garmin's number is now the scale, for one plain reason: it is already
computed, it is consistent, and it is what the watch will keep saying. Where
Garmin recorded an activity, its figure is used unchanged and nothing here
overrides it. Where it did not — every notebook entry before the sync started,
and anything the watch never saw — a stand-in is derived from rpe x minutes
and *converted onto Garmin's scale* using the sessions where both numbers
exist.

The conversion is fitted from the record itself and improves every night. It
is fitted per modality because the relationship is not constant: an hour of
soccer and an hour of easy running produce very different EPOC for the same
perceived effort. Where a modality has too few paired samples, its factor is
pulled toward the overall one rather than trusting three data points.

Estimated values are always labelled. A stand-in is not a measurement.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field

#: Paired sessions needed before a modality gets its own factor. Below this the
#: fit is dominated by noise, so it borrows from the global one.
MIN_SAMPLES_FOR_KIND = 8

#: Sample count at which a modality's own factor is trusted completely. Between
#: MIN_SAMPLES and this, it is blended with the global factor in proportion.
FULL_TRUST_SAMPLES = 25

#: Used only before any paired data exists at all. Deliberately 1.0 — with
#: nothing to fit against, inventing a conversion is worse than admitting the
#: numbers are not yet comparable.
NEUTRAL = 1.0


@dataclass(frozen=True)
class Calibration:
    """Factors converting `rpe * minutes` onto Garmin's load scale."""

    overall: float = NEUTRAL
    by_kind: dict[str, float] = field(default_factory=dict)
    samples: dict[str, int] = field(default_factory=dict)
    total_samples: int = 0

    @property
    def fitted(self) -> bool:
        return self.total_samples > 0

    def factor(self, kind: str) -> float:
        return self.by_kind.get(kind, self.overall)

    def as_dict(self) -> dict[str, object]:
        return {
            "fitted": self.fitted,
            "overall": round(self.overall, 3),
            "by_kind": {k: round(v, 3) for k, v in self.by_kind.items()},
            "samples": self.samples,
            "total_samples": self.total_samples,
            "min_samples_for_kind": MIN_SAMPLES_FOR_KIND,
        }


def _pairs(conn: sqlite3.Connection) -> list[tuple[str, float, float]]:
    """(kind, foster, garmin) for every session carrying both numbers."""
    out: list[tuple[str, float, float]] = []
    for r in conn.execute(
        "SELECT kind, rpe, duration_min, detail FROM session "
        "WHERE rpe IS NOT NULL AND duration_min > 0 AND detail IS NOT NULL"
    ):
        try:
            detail = json.loads(r["detail"] or "{}")
        except json.JSONDecodeError:
            continue
        garmin = detail.get("garmin_load") if isinstance(detail, dict) else None
        if not garmin:
            continue
        # A session whose RPE was itself estimated from Garmin's own heart-rate
        # data would make the fit circular. Only hand-tapped RPEs are used.
        if isinstance(detail, dict) and detail.get("rpe_estimated"):
            continue
        foster = float(r["rpe"]) * float(r["duration_min"])
        if foster > 0:
            out.append((r["kind"], foster, float(garmin)))
    return out


def fit(conn: sqlite3.Connection) -> Calibration:
    """Fit rpe*minutes -> Garmin load from every paired session on record.

    Least squares through the origin (sum(xy) / sum(x^2)) rather than a mean of
    ratios: a short, light session has a tiny denominator and its ratio would
    otherwise swamp the fit.
    """
    pairs = _pairs(conn)
    if not pairs:
        return Calibration()

    def solve(rows: list[tuple[float, float]]) -> float | None:
        sxx = sum(x * x for x, _ in rows)
        sxy = sum(x * y for x, y in rows)
        return sxy / sxx if sxx > 0 else None

    overall = solve([(f, g) for _, f, g in pairs]) or NEUTRAL

    by_kind: dict[str, float] = {}
    samples: dict[str, int] = {}
    kinds = {k for k, _, _ in pairs}
    for kind in kinds:
        rows = [(f, g) for k, f, g in pairs if k == kind]
        samples[kind] = len(rows)
        if len(rows) < MIN_SAMPLES_FOR_KIND:
            continue
        own = solve(rows)
        if own is None:
            continue
        # Shrink toward the global factor until there is enough of this
        # modality to stand on its own.
        span = FULL_TRUST_SAMPLES - MIN_SAMPLES_FOR_KIND
        weight = min(1.0, (len(rows) - MIN_SAMPLES_FOR_KIND) / span) if span else 1.0
        by_kind[kind] = own * weight + overall * (1 - weight)

    return Calibration(
        overall=overall, by_kind=by_kind, samples=samples, total_samples=len(pairs)
    )


def session_load(
    kind: str,
    rpe: float | None,
    duration_min: float | None,
    garmin_load: float | None,
    calibration: Calibration,
) -> tuple[float | None, str]:
    """(load on Garmin's scale, where it came from).

    Source is 'garmin' when the watch measured it, 'estimated' when it was
    converted from perceived effort, and 'none' when there is nothing to go on.
    """
    if garmin_load:
        return round(float(garmin_load), 1), "garmin"

    if rpe is None or not duration_min:
        return None, "none"

    foster = float(rpe) * float(duration_min)
    if not calibration.fitted:
        # Nothing to convert with yet. Report the raw figure and say so, rather
        # than dressing it up as a Garmin-scale number.
        return round(foster, 1), "unscaled"

    return round(foster * calibration.factor(kind), 1), "estimated"
