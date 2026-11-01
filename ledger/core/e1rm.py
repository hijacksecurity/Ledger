"""Estimated 1RM (BRIEF §6).

Epley: e1rm = weight * (1 + reps / 30)

This is the primary strength signal — it makes 5x5 at 100kg comparable to 3x3
at 110kg. Raw volume must not be the headline metric; volume rewards junk sets
and penalises intensity blocks.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Above this rep count Epley degrades badly. Return None rather than a
#: confidently wrong number.
MAX_REPS_FOR_E1RM = 10


def epley(weight_kg: float, reps: int) -> float | None:
    """Estimated 1RM in kg, or None where the estimate is not meaningful.

    None is returned for: bodyweight/unloaded sets (weight <= 0), non-positive
    reps, and sets above MAX_REPS_FOR_E1RM.
    """
    if weight_kg <= 0 or reps <= 0 or reps > MAX_REPS_FOR_E1RM:
        return None
    return weight_kg * (1 + reps / 30)


@dataclass(frozen=True)
class SetRow:
    """A single logged set. Mirrors the `lift_set` columns the math needs."""

    exercise_id: int
    weight: float
    reps: int
    is_warmup: bool = False
    rpe: float | None = None

    @property
    def volume(self) -> float:
        return self.weight * self.reps


def set_e1rm(s: SetRow) -> float | None:
    """e1RM for a set, honouring the working-sets-only rule."""
    if s.is_warmup:
        return None
    return epley(s.weight, s.reps)


def best_e1rm(sets: list[SetRow]) -> float | None:
    """Highest e1RM among working sets. None if nothing qualifies."""
    values = [v for v in (set_e1rm(s) for s in sets) if v is not None]
    return max(values) if values else None
