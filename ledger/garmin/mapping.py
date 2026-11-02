"""Garmin response -> ledger domain mapping (BRIEF §5).

Everything in here is pure and defensive. It is an unofficial API: fields
appear, vanish and change type without notice. Nothing in this module may
raise on unexpected input — a surprise returns None and the caller logs it to
`sync_log` and moves on.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

#: Garmin activityType.typeKey -> session.kind. Anything unlisted -> 'other'.
KIND_BY_TYPE_KEY: dict[str, str] = {
    "running": "run",
    "treadmill_running": "run",
    "indoor_running": "run",
    "trail_running": "run",
    "track_running": "run",
    "virtual_run": "run",
    "soccer": "soccer",
    "indoor_soccer": "soccer",
    "strength_training": "lift",
    # No Garmin ride has synced yet — every bike session on record came off the
    # notebook — so this is latent rather than live. Left out, the first ride
    # would file itself as `other` and quietly leave the distance totals.
    "cycling": "bike",
    "road_biking": "bike",
    "indoor_cycling": "bike",
    "mountain_biking": "bike",
    "gravel_cycling": "bike",
    "virtual_ride": "bike",
    # A stair session on the watch. It carries a distance and it is on the
    # legs, so it is a kind of its own rather than 'other', which every
    # distance total ignores (migration 014).
    "floor_climbing": "stairs",
    "stair_climbing": "stairs",
    "walking": "other",
    "indoor_cardio": "other",
}

#: Fraction of a Garmin strength activity's duration that must overlap a manual
#: lift session before the two are treated as the same session (BRIEF §5).
MERGE_OVERLAP_THRESHOLD = 0.70


def kind_from_name(name: Any) -> str | None:
    """The kind a Garmin activity *name* states outright, or None.

    Uses the same alias table the notebook grammar does, so "Ab attack",
    "ab-attack" and "abs" all land on `ab` while "Riverside Running" lands on
    nothing and the caller falls back to the activity type.
    """
    from ledger.entry import KIND_ALIASES, VALID_KINDS

    if not isinstance(name, str):
        return None
    key = re.sub(r"[^a-z]", "", name.lower())
    if key in VALID_KINDS:
        return key
    return KIND_ALIASES.get(key)


def map_kind(type_key: Any, name: Any = None) -> str:
    """Garmin's activity type, overridden by its name where the name is a kind.

    Garmin has no ab-attack or quick-feet activity type, so both arrive as
    `strength_training` or `soccer`. The user works around that on the watch,
    by *naming* the activity "Ab attack" or "Quick Feet" — and the name was
    landing in `notes` while the kind was mapped from the type alone. So a
    session the user had already labelled correctly still imported as `lift`
    and had to be corrected again by hand.

    The name wins only when it resolves to a kind we know, through the same
    alias table the notebook grammar uses. "Riverside Running" and "Soccer/Football"
    resolve to nothing and fall through to the type key, which is right: a name
    is a label, not a free-text classifier, and guessing from it would be worse
    than ignoring it.
    """
    named = kind_from_name(name)
    if named:
        return named

    if not isinstance(type_key, str):
        return "other"
    return KIND_BY_TYPE_KEY.get(type_key.strip().lower(), "other")


def _num(value: Any) -> float | None:
    """Coerce to float, tolerating strings and rejecting bools/junk."""
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out else None  # drop NaN


def dig(payload: Any, *path: str) -> Any:
    """Walk nested dicts without raising. Returns None on any miss."""
    cur = payload
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def parse_local_datetime(value: Any) -> datetime | None:
    """Garmin returns local time in a handful of shapes. Accept them all."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "").replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


@dataclass(frozen=True)
class GarminSession:
    """A Garmin activity reduced to the columns `session` actually stores."""

    garmin_activity_id: str
    date: str  # local YYYY-MM-DD
    started_at: str | None
    ended_at: str | None
    kind: str
    duration_min: float | None
    notes: str | None
    distance_km: float | None = None
    pace_s_per_km: float | None = None
    #: True when the kind came from the activity's *name* rather than its type.
    #: Informational only. The name outranks Garmin's type map — `map_kind`
    #: resolves that here — but it does not outrank a correction made in the
    #: app. It briefly did, and that is what made manual fixes reappear as the
    #: watch's answer on the next sync; see the CASE in queries.upsert.
    kind_from_name: bool = False


def hr_zones(activity: Any) -> dict[str, int] | None:
    """Time in each HR zone, as whole percentages of the session.

    Garmin publishes `hrTimeInZone_1..5` in seconds on every activity the
    watch recorded, running and soccer alike. The notebook grammar has always
    written zones as *percentages* (`z1=31 z2=42`), and `dataset.js::zoneSplit`
    sums them across sessions to draw one split — so storing seconds here would
    add 377 to 31 and call the result a proportion. Converting on the way in
    keeps one unit in the column and needs no change downstream.

    Returns None when the watch recorded no zone time at all, so a manual
    session stays absent rather than becoming five zeroes.
    """
    if not isinstance(activity, dict):
        return None
    secs = {}
    for i in range(1, 6):
        v = _num(activity.get(f"hrTimeInZone_{i}"))
        if v and v > 0:
            secs[f"z{i}"] = v
    total = sum(secs.values())
    if not total:
        return None
    zones = {k: round(v / total * 100) for k, v in secs.items()}
    # A few seconds in zone 5 rounds to 0%. Keeping it would put a band with no
    # width in the split and a "z5 0" in the tooltip — a measurement that says
    # nothing. The seconds are real but the percentage is not, so it goes.
    zones = {k: v for k, v in zones.items() if v > 0}
    if not zones:
        return None
    # Rounding can drift a point either way; put the difference on the largest
    # zone so the split always sums to 100.
    drift = 100 - sum(zones.values())
    if drift:
        top = max(zones, key=lambda k: zones[k])
        zones[top] += drift
    return zones


def parse_activity(activity: Any) -> GarminSession | None:
    """Map one activity dict. None means 'unusable, skip and log it'."""
    if not isinstance(activity, dict):
        return None

    activity_id = activity.get("activityId")
    if activity_id is None:
        return None

    start = parse_local_datetime(activity.get("startTimeLocal"))
    if start is None:
        # Without a local start time we cannot attribute the session to a day,
        # and a wrong day is worse than a missing session.
        return None

    duration_s = _num(activity.get("duration")) or _num(activity.get("elapsedDuration"))
    duration_min = round(duration_s / 60, 2) if duration_s else None

    end = None
    if duration_s:
        end = (start + timedelta(seconds=duration_s)).isoformat(timespec="seconds")

    # Garmin reports distance in metres. This is the field that fills the
    # soccer-distance gap the notebook never had — matches carry real distance.
    metres = _num(activity.get("distance"))
    distance_km = round(metres / 1000, 3) if metres and metres > 0 else None
    pace = (
        round(duration_s / (metres / 1000), 1)
        if distance_km and duration_s else None
    )

    type_key = dig(activity, "activityType", "typeKey")
    name = activity.get("activityName")

    return GarminSession(
        garmin_activity_id=str(activity_id),
        date=start.date().isoformat(),
        started_at=start.isoformat(timespec="seconds"),
        ended_at=end,
        kind=map_kind(type_key, name),
        kind_from_name=kind_from_name(name) is not None,
        duration_min=duration_min,
        notes=name if isinstance(name, str) and name.strip() else None,
        distance_km=distance_km,
        pace_s_per_km=pace,
    )


def overlap_fraction(
    a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime
) -> float:
    """Overlap as a fraction of A's duration. 0.0 when A has no duration."""
    a_seconds = (a_end - a_start).total_seconds()
    if a_seconds <= 0:
        return 0.0
    latest_start = max(a_start, b_start)
    earliest_end = min(a_end, b_end)
    overlap = (earliest_end - latest_start).total_seconds()
    return max(0.0, overlap) / a_seconds


def should_merge(
    garmin_start: datetime,
    garmin_end: datetime,
    manual_start: datetime,
    manual_end: datetime,
) -> bool:
    """True when a Garmin strength activity is the same session as a manual lift.

    Measured as a fraction of the Garmin activity's duration, per BRIEF §5.
    """
    return (
        overlap_fraction(garmin_start, garmin_end, manual_start, manual_end)
        > MERGE_OVERLAP_THRESHOLD
    )


# --- daily metrics --------------------------------------------------------
# Field names below are best-effort against the current unofficial API shape.
# Each is a list of candidate paths tried in order; add to a list rather than
# replacing one when Garmin changes something, so old exports still parse.

BODYWEIGHT_PATHS = [("totalAverage", "weight"), ("weight",)]
HRV_PATHS = [("hrvSummary", "lastNightAvg"), ("lastNightAvg",)]
READINESS_PATHS = [("score",), ("trainingReadinessScore",)]
RHR_PATHS = [("restingHeartRate",), ("allMetrics", "metricsMap")]
SLEEP_SECONDS_PATHS = [
    ("dailySleepDTO", "sleepTimeSeconds"),
    ("sleepTimeSeconds",),
]
BODY_BATTERY_HIGH_PATHS = [("bodyBatteryHighestValue",), ("charged",)]
BODY_BATTERY_LOW_PATHS = [("bodyBatteryLowestValue",), ("drained",)]


def first_number(payload: Any, paths: list[tuple[str, ...]]) -> float | None:
    """First path that yields a number. None if none do."""
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    for path in paths:
        value = _num(dig(payload, *path))
        if value is not None:
            return value
    return None


def parse_bodyweight_kg(payload: Any) -> float | None:
    """get_stats_and_body returns grams. Convert; reject implausible values."""
    grams = first_number(payload, BODYWEIGHT_PATHS)
    if grams is None:
        return None
    kg = grams / 1000
    return round(kg, 2) if 20 <= kg <= 300 else None


def parse_sleep_hours(payload: Any) -> float | None:
    seconds = first_number(payload, SLEEP_SECONDS_PATHS)
    if seconds is None or not (0 < seconds <= 24 * 3600):
        return None
    return round(seconds / 3600, 2)


def parse_hrv_ms(payload: Any) -> float | None:
    value = first_number(payload, HRV_PATHS)
    return round(value, 1) if value is not None and 0 < value <= 400 else None


def parse_readiness(payload: Any) -> int | None:
    value = first_number(payload, READINESS_PATHS)
    return round(value) if value is not None and 0 <= value <= 100 else None


def parse_resting_hr(payload: Any) -> int | None:
    value = first_number(payload, [("restingHeartRate",), ("value",)])
    if value is None:
        series = dig(payload, "allMetrics", "metricsMap", "WELLNESS_RESTING_HEART_RATE")
        if isinstance(series, list) and series:
            value = _num(dig(series[-1], "value"))
    return round(value) if value is not None and 20 <= value <= 120 else None


def parse_body_battery(payload: Any) -> tuple[int | None, int | None]:
    """(high, low) for the day, or (None, None)."""
    def pct(value: float | None) -> int | None:
        return int(value) if value is not None and 0 <= value <= 100 else None

    return (
        pct(first_number(payload, BODY_BATTERY_HIGH_PATHS)),
        pct(first_number(payload, BODY_BATTERY_LOW_PATHS)),
    )


def _minutes(seconds: Any) -> int | None:
    value = _num(seconds)
    return round(value / 60) if value is not None and 0 <= value <= 24 * 3600 else None


def _local_iso(ms: Any) -> str | None:
    """Garmin's *Local timestamps are epoch-ms already shifted to local time,
    so they are read as UTC to get wall-clock digits. Minute precision."""
    value = _num(ms)
    if value is None or value <= 0:
        return None
    from datetime import UTC, datetime

    try:
        return datetime.fromtimestamp(value / 1000, tz=UTC).strftime("%Y-%m-%dT%H:%M")
    except (OverflowError, OSError, ValueError):
        return None


def parse_sleep_detail(payload: Any) -> dict[str, Any]:
    """Everything else get_sleep_data says about one night. Missing -> absent.

    Minutes rather than seconds, so the row reads as the page prints it.
    Light sleep is not stored: it is sleep minus deep, REM and awake.
    """
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    dto = dig(payload, "dailySleepDTO")
    if not isinstance(dto, dict):
        dto = payload if isinstance(payload, dict) else {}
    out: dict[str, Any] = {}
    score = _num(dig(dto, "sleepScores", "overall", "value"))
    if score is not None and 0 <= score <= 100:
        out["sleep_score"] = round(score)
    for key, src in (
        ("deep_min", "deepSleepSeconds"),
        ("rem_min", "remSleepSeconds"),
        ("awake_min", "awakeSleepSeconds"),
    ):
        mins = _minutes(dto.get(src))
        if mins is not None:
            out[key] = mins
    start = _local_iso(dto.get("sleepStartTimestampLocal"))
    end = _local_iso(dto.get("sleepEndTimestampLocal"))
    if start:
        out["sleep_start_local"] = start
    if end:
        out["sleep_end_local"] = end
    need = _num(dig(dto, "sleepNeed", "actual"))
    if need is None:
        need = _num(dig(dto, "sleepNeed", "baseline"))
    if need is not None and 60 <= need <= 16 * 60:
        out["sleep_need_min"] = round(need)
    return out


def parse_hrv_detail(payload: Any) -> dict[str, Any]:
    """Garmin's status word and the personal balanced range behind it.

    `lastNightAvg` is parsed by `parse_hrv_ms`; this is the rest of the
    summary. The range is what makes a night readable — 47 ms means nothing
    until you know this wearer's balanced band runs 42 to 66.
    """
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    summary = dig(payload, "hrvSummary")
    if not isinstance(summary, dict):
        summary = payload if isinstance(payload, dict) else {}
    out: dict[str, Any] = {}
    status = summary.get("status")
    if isinstance(status, str) and status.strip():
        out["hrv_status"] = status.strip().upper()[:32]
    base = dig(summary, "baseline")
    if isinstance(base, dict):
        for key, src in (
            ("hrv_balanced_low", "balancedLow"),
            ("hrv_balanced_high", "balancedUpper"),
            ("hrv_low_upper", "lowUpper"),
        ):
            value = _num(base.get(src))
            if value is not None and 0 < value <= 400:
                out[key] = round(value)
    return out


def parse_daily_stats(payload: Any) -> dict[str, Any]:
    """The day-level numbers from get_stats_and_body beyond weight and the
    body-battery extremes. Missing -> absent, implausible -> absent."""
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    if not isinstance(payload, dict):
        return {}
    out: dict[str, Any] = {}

    def take(key: str, src: str, lo: float, hi: float) -> None:
        value = _num(payload.get(src))
        if value is not None and lo <= value <= hi:
            out[key] = round(value)

    take("stress_avg", "averageStressLevel", 0, 100)
    take("steps", "totalSteps", 0, 200_000)
    take("intensity_moderate_min", "moderateIntensityMinutes", 0, 1440)
    take("intensity_vigorous_min", "vigorousIntensityMinutes", 0, 1440)
    take("body_battery_wake", "bodyBatteryAtWakeTime", 0, 100)
    take("body_battery_charged", "bodyBatteryChargedValue", 0, 100)
    # 018 — burn. As reported at fetch time: on an unfinished day Garmin
    # pro-rates bmrKilocalories to the hours elapsed and activeKilocalories is
    # the running total, so day_elapsed_min travels with them to say how much
    # of the day the figures cover. report/calories.py reads all four together.
    take("calories_total", "totalKilocalories", 0, 15_000)
    take("calories_active", "activeKilocalories", 0, 10_000)
    take("calories_bmr", "bmrKilocalories", 0, 5_000)
    # Up to 25 hours: the day the clocks go back is 1500 minutes long, and a
    # 24-hour ceiling left that day's finished row looking unfinished.
    ms = _num(payload.get("durationInMilliseconds"))
    if ms is not None and 0 < ms <= 90_000_000:
        out["day_elapsed_min"] = round(ms / 60_000)
    return out


@dataclass(frozen=True)
class ParsedSet:
    """One set as the watch recorded it."""

    exercise_name: str
    weight_kg: float
    reps: int


def parse_exercise_sets(payload: Any) -> list[ParsedSet]:
    """Sets from a watch-logged strength activity.

    Garmin reports weight in grams and names exercises by an enum-ish category
    such as BENCH_PRESS. Rest sets are dropped. Anything unparseable is skipped
    silently — a partial set list beats aborting the sync.
    """
    raw = dig(payload, "exerciseSets")
    if not isinstance(raw, list):
        return []

    out: list[ParsedSet] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("setType", "")).upper() == "REST":
            continue

        reps = _num(entry.get("repetitionCount"))
        if reps is None or reps < 1:
            continue

        grams = _num(entry.get("weight")) or 0.0
        exercises = entry.get("exercises")
        category = None
        if isinstance(exercises, list) and exercises:
            category = dig(exercises[0], "category") or dig(exercises[0], "name")
        if not isinstance(category, str) or not category.strip():
            continue

        out.append(
            ParsedSet(
                exercise_name=humanise_category(category),
                weight_kg=round(grams / 1000, 2),
                reps=int(reps),
            )
        )
    return out


def humanise_category(category: str) -> str:
    """BENCH_PRESS -> 'Bench Press'. Good enough; the user can rename later."""
    return " ".join(part.capitalize() for part in category.strip().split("_") if part)


# --- intensity ------------------------------------------------------------
#
# Session load needs an RPE, and the user does not record one. Garmin cannot
# report perceived exertion — nothing can — but it does report how long the
# heart spent in each zone, which is the standard objective stand-in.
#
# Edwards' zone weighting: zone 1 counts once, zone 5 counts five times.
# Dividing by total time gives a 1-5 intensity, which doubles to the 0-10
# session-RPE scale Foster's method expects. It is an estimate and is always
# labelled as one; a real post-session tap should overwrite it.

ZONE_KEYS = tuple(f"hrTimeInZone_{i}" for i in range(1, 6))


def estimate_rpe(activity: Any) -> tuple[float | None, str | None]:
    """(rpe, method). None when the activity carries no intensity signal."""
    if not isinstance(activity, dict):
        return None, None

    seconds = [_num(activity.get(k)) or 0.0 for k in ZONE_KEYS]
    total = sum(seconds)
    if total > 0:
        weighted = sum(s * (i + 1) for i, s in enumerate(seconds)) / total
        return round(min(10.0, max(1.0, weighted * 2)), 1), "hr_zones"

    # Training Effect is a 0-5 aerobic scale; doubling lands on the same 0-10.
    te = _num(activity.get("aerobicTrainingEffect"))
    if te:
        return round(min(10.0, max(1.0, te * 2)), 1), "training_effect"

    return None, None


def garmin_load(activity: Any) -> float | None:
    """Garmin's own training load, kept as its own number.

    Never blended into the Foster figure: they measure different things on
    different scales, and the gap between them is the whole point — soccer is
    most of this user's load and the watch counts it worst.
    """
    if not isinstance(activity, dict):
        return None
    value = _num(activity.get("activityTrainingLoad"))
    return round(value, 1) if value else None
