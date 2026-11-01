"""Bulk-entry parser for typing in a week of the notebook at once (BRIEF §10).

The grammar follows the paper, not the other way round — transcription is the
slow part, so the format mirrors how the pages are actually written. See
docs/NOTEBOOK.md for the source material this was designed against.

Blank lines and `# comments` are ignored (`#85` is a week number, not a
comment).

Week header — one per notebook page::

    week 2026-07-27 213lb 4.23 #85 "good mon game"

  * 213lb   start-of-week weigh-in, kept in pounds as written
  * 4.23    the boxed number: activities per week, stored as recorded
  * #85     the notebook's own week number (NOT contiguous — see NOTEBOOK.md)

Session header — one per activity, keyed on the date::

    2026-07-27 soccer W7:4 3g0a 60min rpe=9 "mon game"
    2026-07-29 run 5.43km 39:10 z1=76 z2=23 rpe=6 "5K w/ strides"
    2026-08-02 fast 72hr
    2026-09-15 ruck 16.5lb 3.92km 50:14

  * kind      lift | run | soccer | bike | ruck | fast | other (default lift)
  * 5.43km    distance; `mi` also accepted and converted
  * 39:10     elapsed time, mm:ss or h:mm:ss
  * W7:4      soccer result and scoreline
  * 3g0a      goals and assists
  * z1=76     time-in-HR-zone percentage
  * 77%       Garmin coach compliance
  * rpe=N     session RPE 0-10 — the input unified load depends on (BRIEF §8)
  * Nmin      duration, also accepted as dur=N
  * @HH:MM    start time
  * "..."     free-text notes

Set lines follow a session header, one exercise per line::

    squat 60x5w 100x5 100x5 100x5
    bench 3x80x5@8
    pullup bwx10 bwx8
    deadlift 225lbx5

  * WxR           one set: weight x reps
  * NxWxR         N identical sets
  * @R            per-set RPE
  * trailing w    warmup set (never counts toward a PR)
  * bw            bodyweight / unloaded
  * lb suffix     converted to kg on the spot; storage is always kg

Everything before the first set token on the line is the exercise name, taken
as free text. There is no exercise database to match against (BRIEF §2).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

LB_TO_KG = 0.45359237
VALID_KINDS = {"lift", "run", "soccer", "bike", "ruck", "fast",
               "ab", "quickfeet", "stairs", "other"}
#: How a kind is written when it has to be read as a name. The front end has
#: the same map in `core.js::KIND_LABEL`; both are short, fixed, and changing
#: one without the other would make a session read differently depending on
#: which side rendered it.
KIND_LABEL = {
    "soccer": "Soccer", "run": "Run", "lift": "Lift", "ab": "Ab attack",
    "quickfeet": "Quick feet", "stairs": "Stairs", "bike": "Bike",
    "ruck": "Ruck", "fast": "Fasting", "other": "Other",
}

#: Spellings people actually type, mapped onto a kind.
KIND_ALIASES = {"abs": "ab", "abattack": "ab", "ab-attack": "ab",
                "quick": "quickfeet", "quick-feet": "quickfeet",
                "feet": "quickfeet", "football": "soccer", "running": "run",
                "cycle": "bike", "cycling": "bike", "fasting": "fast",
                "stair": "stairs", "stairclimb": "stairs",
                "stairclimbing": "stairs", "floorclimb": "stairs",
                "floorclimbing": "stairs"}

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Endurance tokens, matching how the notebook writes them (docs/NOTEBOOK.md).
_DISTANCE = re.compile(r"^(\d+(?:\.\d+)?)(km|mi)$", re.IGNORECASE)
_ELAPSED = re.compile(r"^(?:(\d+):)?(\d{1,2}):(\d{2})$")      # 39:10 or 1:08:11
_SCORE = re.compile(r"^([WLD])(\d+):(\d+)$", re.IGNORECASE)   # W7:4
_GOALS = re.compile(r"^(\d+)g(\d+)a$", re.IGNORECASE)         # 3g0a
_ZONE = re.compile(r"^z([1-5])=(\d+)$", re.IGNORECASE)        # z2=41
_PERCENT = re.compile(r"^(\d{1,3})%$")                        # 77%  coach compliance
_LOAD_LBS = re.compile(r"^(\d+(?:\.\d+)?)lb$", re.IGNORECASE)  # 16.5lb  ruck load
_HOURS = re.compile(r"^(\d+(?:\.\d+)?)hr$", re.IGNORECASE)    # 72hr    fast length
_TEAM = re.compile(r"^\+([a-z][a-z0-9_-]*)$", re.IGNORECASE)  # +pickup which fixture

MI_TO_KM = 1.609344
_SET_TOKEN = re.compile(
    r"""^
    (?:(?P<count>\d+)x)?                        # 3x  -> three identical sets
    (?P<weight>bw|\d+(?:\.\d+)?)                # 100 | bw
    (?P<unit>kg|lb)?                            # optional unit
    x(?P<reps>\d+)                              # x5
    (?:@(?P<rpe>\d+(?:\.\d+)?))?                # @8
    (?P<warmup>w)?                              # trailing w
    $""",
    re.VERBOSE | re.IGNORECASE,
)
_TIME = re.compile(r"^@(\d{1,2}):(\d{2})$")
_DURATION = re.compile(r"^(?:dur=)?(\d+(?:\.\d+)?)(?:min|m)?$", re.IGNORECASE)


class EntryError(ValueError):
    """Raised with the offending line number so a typo is findable."""


@dataclass
class ParsedSet:
    weight_kg: float
    reps: int
    rpe: float | None = None
    is_warmup: bool = False


@dataclass
class ParsedExercise:
    name: str
    sets: list[ParsedSet]


@dataclass
class ParsedWeek:
    """A notebook page header.

        week 2026-07-27 213lb 4.23 #85 "good mon game"

    Kept 1:1 with the paper (docs/NOTEBOOK.md): the bodyweight stays in pounds
    and the average is stored as written rather than recomputed, so drift
    between the page and the database stays visible.
    """

    start_date: str
    week_number: int | None = None
    bodyweight_lbs: float | None = None
    avg_activities_per_week: float | None = None
    notes: str | None = None

    @property
    def bodyweight_kg(self) -> float | None:
        if self.bodyweight_lbs is None:
            return None
        return round(self.bodyweight_lbs * LB_TO_KG, 2)


@dataclass
class ParsedSession:
    date: str
    kind: str = "lift"
    rpe: float | None = None
    duration_min: float | None = None
    started_at: str | None = None
    notes: str | None = None
    exercises: list[ParsedExercise] = field(default_factory=list)
    distance_km: float | None = None
    #: Modality-specific fields; shape documented in 002_notebook_reality.sql.
    detail: dict[str, object] = field(default_factory=dict)

    @property
    def pace_s_per_km(self) -> float | None:
        if not self.distance_km or not self.duration_min:
            return None
        return round(self.duration_min * 60 / self.distance_km, 1)


def _to_kg(weight: str, unit: str | None) -> float:
    if weight.lower() == "bw":
        return 0.0
    value = float(weight)
    return round(value * LB_TO_KG, 2) if unit and unit.lower() == "lb" else value


def parse_set_token(token: str) -> list[ParsedSet] | None:
    """Expand one token into sets, or None if it is not a set token."""
    match = _SET_TOKEN.match(token)
    if not match:
        return None
    count = int(match.group("count") or 1)
    weight = _to_kg(match.group("weight"), match.group("unit"))
    reps = int(match.group("reps"))
    rpe = float(match.group("rpe")) if match.group("rpe") else None
    warmup = bool(match.group("warmup"))
    if reps < 1 or count < 1:
        return None
    return [ParsedSet(weight, reps, rpe, warmup) for _ in range(count)]


def _endurance_token(session: ParsedSession, token: str) -> bool:
    """Consume one notebook-style endurance token. False if it is not one.

    Ordering matters only in that `@HH:MM` (start time) is handled by the
    caller before this sees it; a bare `39:10` here is always elapsed time.
    """
    if m := _DISTANCE.match(token):
        value = float(m.group(1))
        session.distance_km = round(
            value * MI_TO_KM if m.group(2).lower() == "mi" else value, 3
        )
        return True

    if m := _ELAPSED.match(token):
        hours, minutes, seconds = m.groups()
        total = int(minutes) * 60 + int(seconds) + (int(hours) * 3600 if hours else 0)
        session.duration_min = round(total / 60, 2)
        return True

    if m := _SCORE.match(token):
        session.detail["result"] = m.group(1).upper()
        session.detail["gf"] = int(m.group(2))
        session.detail["ga"] = int(m.group(3))
        return True

    if m := _GOALS.match(token):
        session.detail["goals"] = int(m.group(1))
        session.detail["assists"] = int(m.group(2))
        return True

    if m := _ZONE.match(token):
        zones = session.detail.setdefault("zones", {})
        zones[f"z{m.group(1)}"] = int(m.group(2))  # type: ignore[index]
        return True

    if m := _PERCENT.match(token):
        session.detail["compliance_pct"] = int(m.group(1))
        return True

    if m := _LOAD_LBS.match(token):
        session.detail["load_lbs"] = float(m.group(1))
        return True

    if m := _HOURS.match(token):
        session.detail["hours"] = float(m.group(1))
        return True

    if m := _TEAM.match(token):
        # Which standing fixture a match belongs to (+pickup, +coed, +mens).
        # Free text on purpose: fixtures change, and a CHECK constraint on
        # them would mean a table rebuild the first time a league is renamed.
        session.detail["team"] = m.group(1).lower()
        return True

    return False


def _parse_header(tokens: list[str], lineno: int) -> ParsedSession:
    session = ParsedSession(date=tokens[0])
    notes: list[str] = []
    collecting_notes = False

    for token in tokens[1:]:
        if collecting_notes:
            notes.append(token)
            if token.endswith('"'):
                collecting_notes = False
            continue

        low = token.lower()
        if low in VALID_KINDS or low in KIND_ALIASES:
            session.kind = KIND_ALIASES.get(low, low)
        elif _endurance_token(session, token):
            pass
        elif low.startswith("rpe="):
            try:
                session.rpe = float(token.split("=", 1)[1])
            except ValueError as exc:
                raise EntryError(f"line {lineno}: bad rpe in {token!r}") from exc
            if not 0 <= session.rpe <= 10:
                raise EntryError(f"line {lineno}: rpe {session.rpe} outside 0-10")
        elif _TIME.match(token):
            hh, mm = _TIME.match(token).groups()  # type: ignore[union-attr]
            session.started_at = f"{session.date}T{int(hh):02d}:{mm}:00"
        elif token.startswith('"'):
            notes.append(token)
            collecting_notes = not token.endswith('"') or len(token) == 1
        elif _DURATION.match(token):
            session.duration_min = float(_DURATION.match(token).group(1))  # type: ignore[union-attr]
        else:
            raise EntryError(f"line {lineno}: unrecognised token {token!r} in session header")

    if notes:
        session.notes = " ".join(notes).strip('"').strip() or None
    return session


def _parse_exercise_line(line: str, lineno: int) -> ParsedExercise:
    tokens = line.split()
    first_set = next(
        (i for i, t in enumerate(tokens) if parse_set_token(t) is not None), None
    )
    if first_set is None or first_set == 0:
        raise EntryError(
            f"line {lineno}: expected '<exercise> <sets>' e.g. 'squat 100x5', got {line!r}"
        )

    name = " ".join(tokens[:first_set])
    sets: list[ParsedSet] = []
    for token in tokens[first_set:]:
        expanded = parse_set_token(token)
        if expanded is None:
            raise EntryError(f"line {lineno}: {token!r} is not a set (expected e.g. 100x5)")
        sets.extend(expanded)
    return ParsedExercise(name=name, sets=sets)


def parse_weeks(text: str) -> list[ParsedWeek]:
    """Second pass over the same text, reading only `week ...` header lines."""
    weeks: list[ParsedWeek] = []
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = _strip_comment(raw)
        tokens = line.split()
        if not tokens or tokens[0].lower() != "week":
            continue
        if len(tokens) < 2 or not _DATE.match(tokens[1]):
            raise EntryError(f"line {lineno}: week line needs a YYYY-MM-DD start date")

        week = ParsedWeek(start_date=tokens[1])
        notes: list[str] = []
        for token in tokens[2:]:
            if m := _LOAD_LBS.match(token):
                week.bodyweight_lbs = float(m.group(1))
            elif token.startswith("#") and token[1:].isdigit():
                week.week_number = int(token[1:])
            elif token.startswith('"') or notes:
                notes.append(token)
            else:
                try:
                    week.avg_activities_per_week = float(token)
                except ValueError as exc:
                    raise EntryError(
                        f"line {lineno}: unrecognised token {token!r} in week header"
                    ) from exc
        if notes:
            week.notes = " ".join(notes).strip('"').strip() or None
        weeks.append(week)
    return weeks


def _strip_comment(raw: str) -> str:
    """Drop a trailing `# comment`, but not a `#85` week-number token."""
    out: list[str] = []
    for token in raw.split():
        if token.startswith("#") and not token[1:].isdigit():
            break
        out.append(token)
    return " ".join(out).strip()


def parse_entry(text: str) -> list[ParsedSession]:
    """Parse a whole batch. Raises EntryError with a line number on bad input."""
    sessions: list[ParsedSession] = []
    current: ParsedSession | None = None

    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = _strip_comment(raw)
        if not line:
            continue

        tokens = line.split()
        if tokens[0].lower() == "week":
            continue  # handled by parse_weeks()
        if _DATE.match(tokens[0]):
            current = _parse_header(tokens, lineno)
            sessions.append(current)
            continue

        if current is None:
            raise EntryError(f"line {lineno}: set line before any session date")
        current.exercises.append(_parse_exercise_line(line, lineno))

    return sessions
