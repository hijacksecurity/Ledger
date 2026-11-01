"""Weekly report (BRIEF §9).

The Phase 0 deliverable and the thing that validates the whole project.

The section ordering is load-bearing, not cosmetic. Consistency leads; PRs
follow. A report headed by PRs has nothing to say during a deload — precisely
when it most needs to still be worth opening. If you reorder these sections,
you have changed what the tool is for.

Tone rules, enforced by review not by code:
  * Factual and specific. "Squat e1RM 142kg, up 4kg over 4 weeks", never
    "Crushing it!".
  * A week with zero PRs is a normal week. Leave the section empty. Never add
    encouragement copy to compensate — sections 1-3 already carry the week.
  * Bodyweight gets one line and no commentary.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from ledger.core import load as load_mod
from ledger.core.windows import (
    consistency,
    ema_series,
    rolling_count_by_kind,
    window_start,
)
from ledger.db import queries as q
from ledger.report.average import activities_per_week

TEMPLATE_PATH = Path(__file__).resolve().parent / "template.html"

#: Display order. Must list every kind the schema allows, or that kind is
#: silently dropped from the Sessions section — a report that quietly omits
#: work is worse than no report.
KIND_ORDER = ["soccer", "run", "stairs", "lift", "ab", "quickfeet", "bike",
              "ruck", "fast", "other"]


def ordered_kinds(*maps: dict[str, int]) -> list[str]:
    """KIND_ORDER first, then anything unexpected, so nothing is ever hidden."""
    seen = {k for m in maps for k in m}
    known = [k for k in KIND_ORDER if k in seen]
    return known + sorted(seen - set(KIND_ORDER))
PR_LABEL = {
    "e1rm": "e1RM",
    "reps_at_weight": "reps at weight",
    "session_volume": "session volume",
    "first_time": "first time logged",
}


@dataclass
class WeeklyReport:
    week_start: str
    week_end: str
    #: Last day the rolling windows actually cover — the week's Sunday once it
    #: has passed, today while the week is still running. Every "trailing N
    #: days" figure below ends here, and the UI labels them with it.
    as_of: str = ""
    sessions_this_week: dict[str, int] = field(default_factory=dict)
    sessions_28d: dict[str, int] = field(default_factory=dict)
    #: The notebook's boxed number, continued: lifetime activities per week.
    avg_per_week: float | None = None
    total_activities: int = 0
    #: Activities through the end of the previous week — the basis for
    #: avg_per_week, kept separate from the all-time count.
    completed_activities: int = 0
    #: Weeks the average was divided by — the notebook's counter when it has
    #: one, so the figure matches the paper page.
    weeks_divisor: int | None = None
    consistency_28d: dict[str, tuple[int, float]] = field(default_factory=dict)
    week_load: float = 0.0
    load_split: dict[str, float] = field(default_factory=dict)
    acwr: load_mod.ACWR | None = None
    unscored_sessions: int = 0
    prs: list[dict[str, Any]] = field(default_factory=list)
    e1rm_trends: list[dict[str, Any]] = field(default_factory=list)
    recovery: dict[str, tuple[float | None, float | None]] = field(default_factory=dict)
    bodyweight_ema: float | None = None
    bodyweight_delta_4w: float | None = None


def week_bounds(end: date | None = None) -> tuple[str, str]:
    """The Monday-Sunday week containing `end` (defaults to today)."""
    end = end or date.today()
    monday = end - timedelta(days=end.weekday())
    return monday.isoformat(), (monday + timedelta(days=6)).isoformat()


def build_report(
    conn: sqlite3.Connection,
    week_end: date | None = None,
    planned_per_week: dict[str, int] | None = None,
    today: date | None = None,
) -> WeeklyReport:
    planned_per_week = planned_per_week or {}
    start, end = week_bounds(week_end)

    # Rolling windows are anchored at the last day that has actually happened,
    # not at the Sunday the week will eventually end on.
    #
    # Viewing the current week on a Monday, `end` is six days in the future, so
    # "trailing 7 days" spanned one real day and six empty ones and acute:chronic
    # read 0.00 every Monday morning. That is a window resetting on a calendar
    # boundary, which is the exact thing BRIEF §6 rules out. Anchored at today
    # instead, Monday's acute window is last Tuesday through today and the ratio
    # carries the week that just finished. For any past week `as_of` is that
    # week's own Sunday and nothing changes.
    as_of = min(end, (today or date.today()).isoformat())
    d28_start = window_start(as_of, 28)

    rep = WeeklyReport(week_start=start, week_end=end, as_of=as_of)

    # 1 — sessions this week, with the trailing-28-day rolling count.
    week_events = q.session_events(conn, start, end)
    events_28 = q.session_events(conn, d28_start, as_of)
    rep.sessions_this_week = rolling_count_by_kind(week_events, end, 7)
    rep.sessions_28d = rolling_count_by_kind(events_28, as_of, 28)

    # The paper log's own headline, carried forward (docs/NOTEBOOK.md).
    #
    # Counted through the END OF THE PREVIOUS WEEK, not this one. The notebook
    # writes this figure in the header when the page is started, so it always
    # describes completed weeks. Including the current week divides by a week
    # that has barely begun, which drags the number down every Monday and lifts
    # it again by Sunday — motion that says nothing about training.
    first_ever = q.first_session_date(conn)
    prev_end = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
    rep.total_activities = q.count_sessions_through(conn, end)
    rep.completed_activities = q.count_sessions_through(conn, prev_end)

    # Divide by the notebook's own week counter when the page has one. It runs
    # about two ahead of the calendar — the numbering slipped from 46 to 49 on
    # 2025-11-17, on consecutive Mondays — but it is the denominator every page
    # of the paper log has used for 84 weeks, and an app that quietly disagrees
    # with the notebook is worse than one that carries its quirk forward.
    # One definition, one implementation — see report/average.py. Three
    # screens once showed three different numbers for this.
    avg = activities_per_week(conn, start)
    rep.avg_per_week = avg.value
    rep.weeks_divisor = avg.weeks
    rep.completed_activities = avg.activities

    # 2 — consistency, completed vs planned over 28 days.
    rep.consistency_28d = consistency(events_28, planned_per_week, as_of, 28)

    # 3 — load. The week's own totals span the whole week; the ratio underneath
    # them is a rolling window and stops at `as_of`.
    loads_28 = q.session_loads(conn, d28_start, max(end, as_of))
    rep.week_load = sum(v for d, _, v in loads_28 if start <= d <= end)
    rep.load_split = load_mod.load_by_kind(loads_28, start, end)
    history_days = (
        (date.fromisoformat(as_of) - date.fromisoformat(first_ever)).days + 1
        if first_ever
        else 0
    )
    rep.acwr = load_mod.compute_acwr(
        [(d, v) for d, _, v in loads_28 if d <= as_of], as_of, history_days
    )
    rep.unscored_sessions = len(q.sessions_missing_rpe(conn, start, end))

    # 4 — PRs hit this week. Empty is a valid, normal result.
    rep.prs = [
        {
            "exercise": r["exercise_name"],
            "kind": r["kind"],
            "value": r["value"],
            "context": _safe_json(r["context"]),
            "date": r["date"],
        }
        for r in q.prs_between(conn, start, end)
    ]

    # 5 — e1RM movement, top 5 most-trained exercises, 4-week trend.
    for row in q.top_exercises(conn, d28_start, end, limit=5):
        series = q.e1rm_by_session(conn, int(row["id"]), d28_start, end)
        if not series:
            continue
        rep.e1rm_trends.append(
            {
                "exercise": row["name"],
                "sets_28d": int(row["sets"]),
                "current": series[-1][1],
                "delta_4w": series[-1][1] - series[0][1] if len(series) > 1 else None,
                "series": series,
            }
        )

    # 6 — recovery context: this week's average vs the 28-day baseline.
    rep.recovery = _recovery(conn, start, end, d28_start)

    # 7 — bodyweight: 7-day EMA and its 4-week direction. One line.
    bw = q.bodyweight_series(conn, window_start(end, 56), end)
    smoothed = ema_series(bw, span=7)
    if smoothed:
        rep.bodyweight_ema = round(smoothed[-1][1], 2)
        four_weeks_ago = window_start(end, 28)
        earlier = [v for d, v in smoothed if d <= four_weeks_ago]
        if earlier:
            rep.bodyweight_delta_4w = round(smoothed[-1][1] - earlier[-1], 2)

    return rep


def _safe_json(text: str | None) -> dict[str, Any]:
    try:
        value = json.loads(text or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _recovery(
    conn: sqlite3.Connection, start: str, end: str, d28_start: str
) -> dict[str, tuple[float | None, float | None]]:
    """{metric: (this week mean, 28-day mean)}. None where there is no data."""
    week = q.metrics_between(conn, start, end)
    baseline = q.metrics_between(conn, d28_start, end)

    def mean(rows: list[sqlite3.Row], column: str) -> float | None:
        values = [r[column] for r in rows if r[column] is not None]
        return round(sum(values) / len(values), 1) if values else None

    return {
        column: (mean(week, column), mean(baseline, column))
        for column in ("hrv_ms", "resting_hr", "readiness", "sleep_hours")
    }


# --- rendering ------------------------------------------------------------


def _fmt_delta(value: float | None, unit: str = "kg", digits: int = 1) -> str:
    if value is None:
        return "no comparison yet"
    return f"{value:+.{digits}f}{unit} over 4 weeks"


def render_text(rep: WeeklyReport) -> str:
    lines: list[str] = []
    add = lines.append

    add(f"LEDGER — week of {rep.week_start} to {rep.week_end}")
    add("=" * 52)
    add("")

    if rep.avg_per_week is not None:
        add(
            f"{rep.avg_per_week:.2f} activities/week all-time "
            f"({rep.total_activities} logged)"
        )
        add("")

    add("SESSIONS")
    kinds = ordered_kinds(rep.sessions_this_week, rep.sessions_28d)
    if not kinds:
        add("  no sessions logged")
    for kind in kinds:
        week = rep.sessions_this_week.get(kind, 0)
        rolling = rep.sessions_28d.get(kind, 0)
        add(f"  {kind:<8} {week} this week    {rolling} in trailing 28d")
    add("")

    add("CONSISTENCY (trailing 28 days)")
    if not rep.consistency_28d:
        add("  no plan configured")
    for kind, (done, planned) in rep.consistency_28d.items():
        if planned:
            add(f"  {kind:<8} {done} of {planned:.0f} planned  ({done / planned:.0%})")
        else:
            add(f"  {kind:<8} {done} completed  (unplanned)")
    add("")

    add("LOAD")
    add(f"  week total     {rep.week_load:,.0f} AU")
    if rep.acwr:
        if rep.acwr.available:
            add(f"  acute:chronic  {rep.acwr.ratio:.2f}  ({rep.acwr.band})")
        else:
            add(
                f"  acute:chronic  building baseline "
                f"({rep.acwr.days_of_history}/{load_mod.MIN_DAYS_FOR_ACWR} days)"
            )
    split = load_mod.modality_split(rep.load_split)
    if split:
        parts = "  ".join(f"{k} {frac:.0%}" for k, frac in split.items())
        add(f"  split          {parts}")
    if rep.unscored_sessions:
        add(f"  {rep.unscored_sessions} session(s) this week have no RPE and are not in the total")
    add("")

    add("PRs THIS WEEK")
    for pr in rep.prs:
        add(f"  {pr['exercise']} — {PR_LABEL.get(pr['kind'], pr['kind'])}: {_pr_value(pr)}")
    add("")

    add("e1RM — TOP 5 BY VOLUME OF WORK (4-week trend)")
    if not rep.e1rm_trends:
        add("  no working sets in the last 28 days")
    for t in rep.e1rm_trends:
        add(f"  {t['exercise']}: {t['current']:.0f}kg, {_fmt_delta(t['delta_4w'])}")
    add("")

    add("RECOVERY (this week vs 28-day baseline)")
    labels = {
        "hrv_ms": ("HRV", "ms"),
        "resting_hr": ("resting HR", "bpm"),
        "readiness": ("readiness", ""),
        "sleep_hours": ("sleep", "h"),
    }
    for key, (week, base) in rep.recovery.items():
        label, unit = labels[key]
        if week is None and base is None:
            continue
        week_s = f"{week}{unit}" if week is not None else "—"
        base_s = f"{base}{unit}" if base is not None else "—"
        add(f"  {label:<12} {week_s:<8} baseline {base_s}")
    add("")

    add("BODYWEIGHT")
    if rep.bodyweight_ema is None:
        add("  no readings")
    else:
        direction = (
            f", {rep.bodyweight_delta_4w:+.1f}kg over 4 weeks"
            if rep.bodyweight_delta_4w is not None
            else ""
        )
        add(f"  {rep.bodyweight_ema:.1f}kg 7-day EMA{direction}")

    return "\n".join(lines) + "\n"


def _pr_value(pr: dict[str, Any]) -> str:
    ctx = pr["context"]
    kind = pr["kind"]
    if kind == "e1rm":
        detail = f" ({ctx['weight']:g}kg x {ctx['reps']})" if "weight" in ctx else ""
        return f"{pr['value']:.1f}kg{detail}"
    if kind == "reps_at_weight":
        return f"{int(pr['value'])} reps at {ctx.get('weight', 0):g}kg"
    if kind == "session_volume":
        return f"{pr['value']:,.0f}kg total"
    if kind == "first_time":
        return "first session logged"
    return f"{pr['value']:g}"


def render_html(rep: WeeklyReport) -> str:
    from jinja2 import Environment

    # Autoescape: exercise names and notes are typed by hand and this page is
    # served as HTML by the API, so nothing in it may be read as markup.
    template = Environment(autoescape=True).from_string(
        TEMPLATE_PATH.read_text(encoding="utf-8")
    )
    return template.render(
        r=rep,
        kind_order=ordered_kinds(rep.sessions_this_week, rep.sessions_28d),
        pr_label=PR_LABEL,
        pr_value=_pr_value,
        split=load_mod.modality_split(rep.load_split),
        min_days_for_acwr=load_mod.MIN_DAYS_FOR_ACWR,
    )


def write_html(rep: WeeklyReport, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"week-{rep.week_start}.html"
    path.write_text(render_html(rep), encoding="utf-8")
    return path
