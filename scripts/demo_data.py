"""Build a demo database: a plausible, entirely invented training history.

    .venv/Scripts/python.exe scripts/demo_data.py                 # data/demo.db
    .venv/Scripts/python.exe scripts/demo_data.py --db /tmp/x.db --weeks 60

Then point the app at it and have a look around:

    LEDGER_DB_PATH=data/demo.db uvicorn ledger.api.main:app --port 8001

Everything here is made up with a fixed seed, so two runs give the same
record. It exists for two reasons: trying the app without a Garmin account or
a notebook, and taking screenshots that show the app rather than anyone's
real numbers. It goes through the same bulk-entry grammar a typed-in notebook
would (`ledger/entry.py`), so what it writes is exactly what a user could.
"""

from __future__ import annotations

import argparse
import pathlib
import random
import sys
from datetime import UTC, date, datetime, timedelta

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ledger.db import queries as q  # noqa: E402
from ledger.db.schema import open_db  # noqa: E402
from ledger.entry import parse_entry, parse_weeks  # noqa: E402
from ledger.ingest import save_session, save_week  # noqa: E402


def trunc2(x: float) -> float:
    return int(x * 100) / 100


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def pace_str(seconds_per_km: float) -> str:
    m, s = divmod(int(round(seconds_per_km)), 60)
    return f"{m}:{s:02d}"


def elapsed(km: float, pace_s: float) -> str:
    total = int(round(km * pace_s))
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def build_entry(rng: random.Random, weeks: int, end: date) -> tuple[str, list[str]]:
    """The notebook as text, one line per session, plus a header per week."""
    lines: list[str] = []
    start = monday_of(end) - timedelta(weeks=weeks - 1)
    cumulative = 0
    bodyweight = 214.0
    pace_base = 6 * 60 + 30          # s/km at the start, improving over time
    for wi in range(weeks):
        monday = start + timedelta(weeks=wi)
        progress = wi / max(1, weeks - 1)
        week_lines: list[str] = []
        count = 0

        def day(offset: int) -> str:
            return (monday + timedelta(days=offset)).isoformat()

        # Monday coed and Thursday men's — the two standing fixtures.
        for offset, fixture, p in ((0, "coed", 0.85), (3, "mens", 0.8), (1, "pickup", 0.35)):
            if (monday + timedelta(days=offset)) > end or rng.random() > p:
                continue
            gf, ga = rng.randint(3, 11), rng.randint(2, 10)
            if gf == ga:
                ga += rng.choice((-1, 1))
            res = "W" if gf > ga else "L"
            if rng.random() < 0.08:
                res, ga = "D", gf
            goals = min(gf, max(0, int(rng.gauss(2.2, 1.4))))
            assists = max(0, int(rng.gauss(0.9, 0.9)))
            rpe = rng.choice((7, 7, 8, 8, 9))
            note = {"coed": "coed league", "mens": "men's league", "pickup": "pickup"}[fixture]
            score = f" {res}{gf}:{ga} {goals}g{assists}a" if fixture != "pickup" or rng.random() < 0.5 else ""
            week_lines.append(f'{day(offset)} soccer{score} 60min rpe={rpe} +{fixture} "{note}"')
            count += 1

        # Two or three runs, getting quicker over the record.
        run_days = rng.sample((2, 4, 5, 6), k=rng.choice((2, 2, 3)))
        for offset in sorted(run_days):
            if (monday + timedelta(days=offset)) > end:
                continue
            km = rng.choice((3.1, 5.0, 5.1, 5.2, 8.0, 8.1, 10.0))
            pace = pace_base - progress * 75 + rng.gauss(0, 14) + (km - 5) * 4
            z1 = rng.randint(55, 80)
            z2 = max(0, min(100 - z1, rng.randint(15, 35)))
            z3 = max(0, 100 - z1 - z2)
            rpe = rng.choice((4, 5, 5, 6, 7))
            note = rng.choice(("easy", "tempo", "strides", "long and slow", "hills"))
            week_lines.append(
                f'{day(offset)} run {km}km {elapsed(km, pace)} z1={z1} z2={z2} z3={z3} rpe={rpe} "{note} {pace_str(pace)}/km"'
            )
            count += 1

        # A lift most weeks, and the odd extra.
        if rng.random() < 0.8:
            offset = rng.choice((2, 5))
            week_lines.append(f'{day(offset)} lift {rng.randint(32, 48)}min rpe=5 "{rng.choice(("upper", "lower", "full body"))}"')
            count += 1
        if rng.random() < 0.25:
            week_lines.append(f'{day(rng.choice((2, 6)))} quickfeet 35min rpe=5 "quick feet"')
            count += 1
        if rng.random() < 0.15:
            week_lines.append(f'{day(6)} bike 45min rpe=5 "easy spin"')
            count += 1
        if progress < 0.35 and rng.random() < 0.15:
            week_lines.append(f"{day(rng.choice((2, 3)))} fast 24hr")
            count += 1

        # Header: start-of-week weigh-in and the notebook's boxed number
        # (activities so far ÷ weeks so far, truncated — see docs/NOTEBOOK.md).
        bodyweight += rng.gauss(-0.18, 1.1)
        boxed = trunc2(cumulative / wi) if wi else None
        header = f"week {monday.isoformat()} {bodyweight:.0f}lb"
        if boxed is not None:
            header += f" {boxed:.2f}"
        header += f" #{wi + 1}"
        lines.append(header)
        lines.extend(sorted(week_lines))
        lines.append("")
        cumulative += count
    return "\n".join(lines), lines


def write_metrics(conn, rng: random.Random, days: int, end: date) -> None:
    """Nights for the Recovery page: invented, but shaped like a real record."""
    for i in range(days):
        d = end - timedelta(days=days - 1 - i)
        weekend = d.weekday() >= 5
        sleep = max(4.2, min(10.0, rng.gauss(7.4 if weekend else 7.0, 0.9)))
        need = rng.choice((450, 460, 470, 470, 480))
        score = int(max(20, min(98, rng.gauss(55 + sleep * 3, 9))))
        low, high = 41, 66
        hrv = max(22, min(85, rng.gauss(53, 10)))
        rhr = int(max(48, min(70, rng.gauss(59, 3.2))))
        readiness = int(max(3, min(99, rng.gauss(55 + (hrv - 53) * 1.1 + (sleep - 7) * 6, 12))))
        wake = int(max(10, min(100, rng.gauss(70 + (sleep - 7) * 10, 14))))
        deep = int(max(25, min(130, rng.gauss(sleep * 11, 15))))
        rem = int(max(20, min(140, rng.gauss(sleep * 9, 18))))
        q.upsert_metric_daily(
            conn, d.isoformat(),
            sleep_hours=round(sleep, 2), sleep_score=score, sleep_need_min=need,
            deep_min=deep, rem_min=rem, awake_min=int(max(0, rng.gauss(14, 10))),
            hrv_ms=round(hrv, 1), hrv_status="BALANCED" if low <= hrv <= high else "UNBALANCED",
            hrv_balanced_low=low, hrv_balanced_high=high, hrv_low_upper=37,
            resting_hr=rhr, readiness=readiness,
            body_battery_high=min(100, wake + rng.randint(0, 6)), body_battery_low=rng.randint(5, 30),
            body_battery_wake=wake, body_battery_charged=rng.randint(40, 95),
            stress_avg=int(max(10, min(70, rng.gauss(31, 9)))), steps=int(max(1500, rng.gauss(8500, 3200))),
            intensity_moderate_min=rng.randint(0, 25), intensity_vigorous_min=rng.randint(0, 70),
            bodyweight_kg=None,
        )


def write_calories(conn, rng: random.Random, days: int, end: date) -> None:
    """Burn and meals for the Calories page: invented, shaped like a record.

    Finished days carry a full-day BMR, more active calories on a session
    day, and 1440 elapsed minutes. The last day is written the way the sync
    finds it mid-afternoon: BMR pro-rated to the hours elapsed, active so
    far, so the page's baseline-and-projection path gets exercised.
    """
    session_days = {r[0] for r in conn.execute("SELECT DISTINCT date FROM session")}
    slots = (("breakfast", 450, 750), ("lunch", 600, 900), ("snack", 100, 300),
             ("dinner", 550, 900), ("bedtime", 150, 250))
    for i in range(days):
        d = end - timedelta(days=days - 1 - i)
        iso = d.isoformat()
        bmr = round(rng.gauss(2210, 25))
        active = int(max(150, rng.gauss(620 if iso in session_days else 380, 180)))
        last = d == end
        if last:
            now = datetime.now()
            elapsed = max(60, now.hour * 60 + now.minute)
            q.upsert_metric_daily(
                conn, iso, calories_bmr=round(bmr * elapsed / 1440),
                calories_active=round(active * elapsed / 1440),
                calories_total=round((bmr + active) * elapsed / 1440),
                day_elapsed_min=elapsed,
                calories_fetched_at=datetime.now(UTC).isoformat(timespec="seconds"),
            )
        else:
            q.upsert_metric_daily(
                conn, iso, calories_bmr=bmr, calories_active=active,
                calories_total=bmr + active, day_elapsed_min=1440,
                calories_fetched_at=f"{(d + timedelta(days=1)).isoformat()}T07:00:00+00:00",
            )
        if rng.random() > 0.9 and not last:
            continue  # a day nothing was logged on
        meals = [(label, rng.randint(lo, hi)) for label, lo, hi in slots]
        if rng.random() < 0.3:
            meals.insert(3, ("snack", rng.randint(100, 250)))
        if last:
            meals = meals[:3]
        else:
            # Nudge the day toward a deficit of about 420 ± 250 without
            # making every day identical.
            want = bmr + active - int(rng.gauss(420, 250))
            total = sum(k for _, k in meals)
            scale = want / total if total else 1
            meals = [(label, max(80, min(1500, round(k * scale)))) for label, k in meals]
        for label, kcal in meals:
            q.add_meal(conn, iso, kcal, label)
    q.set_setting(conn, "calories_deficit_target_kcal", "500")


def write_habits(conn, rng: random.Random, days: int, end: date) -> None:
    rows = conn.execute("SELECT id, key, mode FROM habit WHERE archived_at IS NULL").fetchall()
    stamp = datetime.now().isoformat(timespec="seconds")
    for i in range(days):
        d = (end - timedelta(days=days - 1 - i)).isoformat()
        for r in rows:
            if r["mode"] != "manual":
                continue
            p = 0.7 if r["key"] == "stretch" else 0.8
            conn.execute(
                "INSERT OR REPLACE INTO habit_day (habit_id, date, done, value, marked_at) VALUES (?, ?, ?, NULL, ?)",
                (r["id"], d, 1 if rng.random() < p else 0, stamp),
            )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", default=str(ROOT / "data" / "demo.db"))
    ap.add_argument("--weeks", type=int, default=95)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--end", default=date.today().isoformat(), help="last day of the record")
    args = ap.parse_args()

    db = pathlib.Path(args.db)
    if db.exists():
        db.unlink()
    db.parent.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    end = date.fromisoformat(args.end)

    text, _ = build_entry(rng, args.weeks, end)
    conn = open_db(db)
    weeks = parse_weeks(text)
    sessions = parse_entry(text)
    for w in weeks:
        save_week(conn, w)
    for s in sessions:
        save_session(conn, s)
    write_metrics(conn, rng, 300, end)
    write_habits(conn, rng, 120, end)
    write_calories(conn, rng, 120, end)
    conn.commit()
    n = conn.execute("SELECT COUNT(*) FROM session").fetchone()[0]
    print(f"{db}: {len(weeks)} weeks, {n} sessions, 300 nights, 120 days of habits and meals — all invented")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
