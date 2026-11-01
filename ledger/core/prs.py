"""PR detection (BRIEF §6).

Four kinds, checked after every session write:

  e1rm            best estimated 1RM for that exercise, ever
  reps_at_weight  most reps ever at that exact weight
  session_volume  highest total volume for that exercise in one session
  first_time      first ever logged instance of an exercise

A wide PR surface means there is usually something genuinely at an all-time
best, without fabricating anything. Never invent a PR to have something to
show: a report that celebrates nothing is more trustworthy than one that
always celebrates.

This module is pure. Callers load prior bests from the DB, pass them in, and
persist whatever comes back.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from ledger.core.e1rm import SetRow, set_e1rm

PRKind = str  # 'e1rm' | 'reps_at_weight' | 'session_volume' | 'first_time'


@dataclass(frozen=True)
class PriorBests:
    """All-time bests for one exercise, as of *before* the session in question."""

    ever_logged: bool = False
    best_e1rm: float | None = None
    best_session_volume: float | None = None
    #: weight (kg) -> most reps ever performed at exactly that weight
    best_reps_at_weight: dict[float, int] = field(default_factory=dict)


@dataclass(frozen=True)
class PRHit:
    exercise_id: int
    kind: PRKind
    value: float
    context: dict[str, float | int]

    def context_json(self) -> str:
        return json.dumps(self.context, sort_keys=True)


def _working(sets: list[SetRow]) -> list[SetRow]:
    return [s for s in sets if not s.is_warmup]


def detect_prs(
    exercise_id: int,
    session_sets: list[SetRow],
    prior: PriorBests,
) -> list[PRHit]:
    """PRs set by one exercise within one session.

    `session_sets` must be only that exercise's sets from that one session.
    Warmups never count toward any PR.
    """
    working = _working(session_sets)
    if not working:
        return []

    hits: list[PRHit] = []

    if not prior.ever_logged:
        hits.append(
            PRHit(exercise_id, "first_time", value=1.0, context={"sets": len(working)})
        )

    # --- e1rm -------------------------------------------------------------
    best: tuple[float, SetRow] | None = None
    for s in working:
        v = set_e1rm(s)
        if v is not None and (best is None or v > best[0]):
            best = (v, s)
    if best is not None and (prior.best_e1rm is None or best[0] > prior.best_e1rm):
        value, s = best
        hits.append(
            PRHit(
                exercise_id,
                "e1rm",
                value=round(value, 2),
                context={"weight": s.weight, "reps": s.reps},
            )
        )

    # --- reps_at_weight ---------------------------------------------------
    # Best reps per distinct weight *within this session*, then compared to the
    # all-time best at that same weight. One PR row per weight that improved.
    #
    # A weight never lifted before is deliberately NOT a PR. Treating it as one
    # means every novel load celebrates — 90x3 the week after 100x5 would come
    # back as a personal best, which is precisely the always-celebrates failure
    # mode that makes a report stop being read (BRIEF §6).
    per_weight: dict[float, int] = {}
    for s in working:
        if s.reps > per_weight.get(s.weight, 0):
            per_weight[s.weight] = s.reps
    for weight, reps in sorted(per_weight.items()):
        previous = prior.best_reps_at_weight.get(weight)
        if previous is not None and reps > previous:
            hits.append(
                PRHit(
                    exercise_id,
                    "reps_at_weight",
                    value=float(reps),
                    context={"weight": weight, "reps": reps},
                )
            )

    # --- session_volume ---------------------------------------------------
    volume = sum(s.volume for s in working)
    if volume > 0 and (
        prior.best_session_volume is None or volume > prior.best_session_volume
    ):
        hits.append(
            PRHit(
                exercise_id,
                "session_volume",
                value=round(volume, 2),
                context={"sets": len(working)},
            )
        )

    return hits


def detect_session_prs(
    sets_by_exercise: dict[int, list[SetRow]],
    priors: dict[int, PriorBests],
) -> list[PRHit]:
    """Run detection across every exercise touched in a session."""
    hits: list[PRHit] = []
    for exercise_id, sets in sets_by_exercise.items():
        hits.extend(detect_prs(exercise_id, sets, priors.get(exercise_id, PriorBests())))
    return hits
