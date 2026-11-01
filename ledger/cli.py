"""Ledger command line.

    ledger init                       apply migrations
    ledger garmin-login               one-time interactive Garmin auth
    ledger sync [--days 3]            nightly incremental sync
    ledger backfill --start --end     historical import, 30-day chunks
    ledger add [FILE]                 bulk-enter notebook lifts (stdin if no file)
    ledger rpe SESSION_ID VALUE       attach a session RPE after the fact
    ledger report [--week-of DATE]    weekly report to stdout (+ --html)
    ledger sync-log [-n 20]           recent sync activity
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING

from ledger.config import Config, load_config
from ledger.db import queries as q
from ledger.db.schema import open_db
from ledger.report import weekly

if TYPE_CHECKING:
    from ledger.entry import ParsedSession


def _force_utf8_stdout() -> None:
    """Windows consoles default to cp1252 and mangle the report's typography."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _client(cfg: Config):
    from ledger.garmin.client import GarminClient

    return GarminClient(cfg.garmin_token_dir, call_delay_s=cfg.sync_call_delay_s)


# --- commands -------------------------------------------------------------


def cmd_init(args: argparse.Namespace, cfg: Config) -> int:
    conn = open_db(cfg.db_path)
    applied = [row["filename"] for row in conn.execute("SELECT filename FROM _migration")]
    print(f"database: {cfg.db_path}")
    print(f"migrations applied: {', '.join(applied) or 'none'}")
    return 0


def cmd_garmin_login(args: argparse.Namespace, cfg: Config) -> int:
    if not cfg.garmin_email or not cfg.garmin_password:
        print(
            "GARMIN_EMAIL and GARMIN_PASSWORD must be set in .env.\n"
            "Tip: single-quote the password. Docker Compose reads the project's\n"
            "  .env for interpolation, so a bare $ eats the characters after it.",
            file=sys.stderr,
        )
        return 2

    from ledger.garmin.client import GarminMFARequired

    client = _client(cfg)
    code = args.mfa_code
    if code is None and sys.stdin.isatty():
        code = None  # a TTY can answer the prompt below if one is needed

    print(f"Logging in as {cfg.garmin_email}…")
    try:
        client.login_interactive(cfg.garmin_email, cfg.garmin_password, mfa_code=code)
    except GarminMFARequired:
        if not sys.stdin.isatty():
            print(
                "\nMFA is enabled on this account — the password is fine.\n"
                "Re-run with the code:\n"
                "  docker compose run --rm cli ledger garmin-login --mfa-code 123456",
                file=sys.stderr,
            )
            return 2
        typed = input("MFA code: ").strip()
        try:
            client.login_interactive(cfg.garmin_email, cfg.garmin_password, mfa_code=typed)
        except Exception as exc:
            print(f"\nLogin failed: {exc}", file=sys.stderr)
            return 1
    except Exception as exc:
        print(f"\nLogin failed: {exc}", file=sys.stderr)
        print(
            "\nDo not retry in a loop — repeated failures can lock the account\n"
            "or trigger a CAPTCHA.",
            file=sys.stderr,
        )
        return 1

    print(f"Tokens stored in {cfg.garmin_token_dir}. Future syncs resume from them.")
    print("Now run:  ledger sync --days 7")
    return 0


def cmd_doctor(args: argparse.Namespace, cfg: Config) -> int:
    """Check every part of the setup and name the next action.

    Exists because the nightly sync failed silently for its whole life: the
    failure was recorded but nothing ever asked the question out loud.
    """
    from ledger.garmin.status import build_status

    conn = open_db(cfg.db_path)
    checks: list[tuple[bool, str, str]] = []

    sessions = conn.execute("SELECT COUNT(*) AS n FROM session").fetchone()["n"]
    weeks = conn.execute("SELECT COUNT(*) AS n FROM week").fetchone()["n"]
    span = conn.execute("SELECT MIN(date) AS a, MAX(date) AS b FROM session").fetchone()
    applied = conn.execute("SELECT COUNT(*) AS n FROM _migration").fetchone()["n"]

    checks.append((cfg.db_path.exists(), "database", str(cfg.db_path)))
    checks.append((applied > 0, "migrations", f"{applied} applied"))
    checks.append(
        (sessions > 0, "activities",
         f"{sessions} sessions, {weeks} week headers"
         + (f", {span['a']} to {span['b']}" if span["a"] else "")),
    )

    status = build_status(conn, cfg.garmin_token_dir)
    checks.append(
        (status["authenticated"], "garmin auth",
         "tokens present" if status["authenticated"] else "never logged in"),
    )
    checks.append(
        (status["state"] == "ok", "garmin sync",
         status["state"].replace("_", " ")
         + (f" — last success {status['last_success']}" if status["last_success"] else "")),
    )

    creds = bool(cfg.garmin_email and cfg.garmin_password)
    checks.append((creds, "credentials", "set in .env" if creds else "GARMIN_EMAIL/PASSWORD empty"))

    backups = sorted(cfg.backup_dir.glob("ledger-*.db")) if cfg.backup_dir.exists() else []
    checks.append(
        (bool(backups), "backups",
         f"{len(backups)}, newest {backups[-1].name}" if backups else "none yet"),
    )

    width = max(len(name) for _, name, _ in checks)
    for ok, name, detail in checks:
        print(f"  {'OK ' if ok else '-- '} {name:<{width}}  {detail}")

    if status["next_action"]:
        print(f"\nNext: {status['next_action']}")
        return 1
    print("\nEverything is set up.")
    return 0


def cmd_leagues(args: argparse.Namespace, cfg: Config) -> int:
    """Refresh the league tables and schedules, then print what came back."""
    from ledger import leagues

    conn = open_db(cfg.db_path)
    if args.move:
        fixture, target = args.move
        try:
            sw = leagues.move(conn, fixture, target)
        except Exception as exc:
            print(f"not moved: {exc}", file=sys.stderr)
            return 1
        print(f"{sw['my_team']:<18} moved {sw['fixture']}: "
              f"{sw['from']} -> {sw['to']} · {sw['name']}")
        print()
    if not args.show:
        for team, outcome in leagues.refresh_all(conn):
            print(f"{team:<18} {outcome}")
        print()

    for lg in leagues.read(conn):
        played = [f for f in lg["my_fixtures"] if f["played"]]
        upcoming = [f for f in lg["my_fixtures"] if not f["played"]]
        print(f"{lg['my_team']} — {lg['fixture']}, position {lg['my_position']} "
              f"of {len(lg['standings'])}, {len(played)} played")
        for f in upcoming[:3]:
            home = f["home"] == lg["my_team"]
            print(f"    {f['date']}  {'vs' if home else 'at'} "
                  f"{f['away'] if home else f['home']}  {f['time_text']}")
        print()
    return 0


def cmd_sync(args: argparse.Namespace, cfg: Config) -> int:
    from ledger.garmin.client import GarminAuthError
    from ledger.garmin.sync import sync_recent

    conn = open_db(cfg.db_path)
    client = _client(cfg)
    try:
        client.resume()
    except GarminAuthError as exc:
        # Exit non-zero so cron surfaces it. Never retry with the password.
        print(f"auth failed: {exc}", file=sys.stderr)
        q.log_sync(conn, "login", "error", None, str(exc))
        return 1

    result = sync_recent(conn, client, trailing_days=args.days)
    print(result.summary())
    for err in result.errors:
        print(f"  ! {err}", file=sys.stderr)
    return 1 if result.errors else 0


def cmd_backfill(args: argparse.Namespace, cfg: Config) -> int:
    from ledger.garmin.client import GarminAuthError
    from ledger.garmin.sync import backfill

    conn = open_db(cfg.db_path)
    client = _client(cfg)
    try:
        client.resume()
    except GarminAuthError as exc:
        print(f"auth failed: {exc}", file=sys.stderr)
        return 1

    if args.metrics_only:
        # Daily metrics touch no session row, so the notebook-overlap guard
        # below does not apply: nothing here can duplicate an activity.
        from ledger.garmin.sync import METRIC_ENDPOINTS, METRIC_ENDPOINTS_CHEAP, backfill_metrics

        only = METRIC_ENDPOINTS_CHEAP
        if args.endpoints:
            only = frozenset(e.strip() for e in args.endpoints.split(",") if e.strip())
            unknown = only - METRIC_ENDPOINTS
            if unknown:
                print(f"unknown metric endpoint(s): {', '.join(sorted(unknown))}", file=sys.stderr)
                print(f"  choose from: {', '.join(sorted(METRIC_ENDPOINTS))}", file=sys.stderr)
                return 1
        print(
            f"re-reading daily metrics {args.start}..{args.end} — "
            f"{len(only)} call{'s' if len(only) != 1 else ''} a day, leave it running"
        )
        result = backfill_metrics(conn, client, args.start, args.end, cfg, only=only)
        print(result.summary())
        return 1 if result.errors else 0

    # A backfill over notebook-covered dates duplicates the record rather than
    # enriching it, and the duplicates are invisible to a (date, kind) check
    # because the two sources label the same session differently. Five rows got
    # in this way once and moved the lifetime average from 4.42 to 4.47 — a
    # figure the user reads every day and immediately knew was wrong.
    clash = q.manual_sessions_between(conn, args.start, args.end)
    if clash and not args.allow_overlap:
        print(
            f"refusing: {len(clash)} hand-entered sessions already cover "
            f"{args.start}..{args.end}.",
            file=sys.stderr,
        )
        print(
            "  For those dates the notebook is the record. Garmin's copy of the "
            "same session arrives as a second row, not a merge — a bike session "
            "written \"Power Zone + abs\" and the watch's 11-minute \"Strength\" "
            "are the same half-hour and nothing here can tell.",
            file=sys.stderr,
        )
        for r in clash[:5]:
            print(f"    {r['date']}  {r['kind']:<9} {r['notes'] or ''}"[:78], file=sys.stderr)
        if len(clash) > 5:
            print(f"    ... {len(clash) - 5} more", file=sys.stderr)
        print("", file=sys.stderr)
        print(
            "  Pick a range that starts after the notebook ends, or pass "
            "--allow-overlap if you have checked each one.",
            file=sys.stderr,
        )
        return 1

    print(f"backfilling {args.start}..{args.end} — this is deliberately slow, leave it running")
    result = backfill(conn, client, args.start, args.end, cfg)
    print(result.summary())
    return 1 if result.errors else 0


def cmd_add(args: argparse.Namespace, cfg: Config) -> int:
    from ledger.entry import EntryError, parse_entry, parse_weeks
    from ledger.ingest import save_session, save_week

    text = Path(args.file).read_text(encoding="utf-8") if args.file else sys.stdin.read()
    try:
        weeks = parse_weeks(text)
        sessions = parse_entry(text)
    except EntryError as exc:
        print(f"parse error: {exc}", file=sys.stderr)
        return 2

    if not sessions and not weeks:
        print("nothing to add")
        return 0

    if args.dry_run:
        for w in weeks:
            print(f"{w.start_date}  week header  {w.bodyweight_lbs or '-'}lb")
        for s in sessions:
            print(f"{s.date}  {_summarise(s)}")
        print(f"\n{len(weeks)} weeks, {len(sessions)} sessions parsed, nothing written")
        return 0

    conn = open_db(cfg.db_path)
    for w in weeks:
        save_week(conn, w)
    for s in sessions:
        session_id, hits = save_session(conn, s)
        total = sum(len(e.sets) for e in s.exercises)
        print(f"{s.date} {s.kind} -> session {session_id} ({total} sets)")
        for h in hits:
            print(f"    PR  {h.kind}: {h.value:g} {h.context}")
    return 0


def _summarise(session: ParsedSession) -> str:
    """One readable line per parsed session, whatever modality it is."""
    bits: list[str] = [f"{session.kind:<7}"]
    if session.distance_km:
        bits.append(f"{session.distance_km:.2f}km")
    if session.duration_min:
        bits.append(f"{session.duration_min:.0f}min")
    if session.pace_s_per_km:
        pace = round(session.pace_s_per_km)
        bits.append(f"{pace // 60}:{pace % 60:02d}/km")
    sets = sum(len(e.sets) for e in session.exercises)
    if sets:
        bits.append(f"{len(session.exercises)} exercises / {sets} sets")
    if d := session.detail:
        if "result" in d:
            bits.append(f"{d['result']} {d.get('gf')}:{d.get('ga')}")
        if "goals" in d:
            bits.append(f"{d['goals']}g{d['assists']}a")
        if "compliance_pct" in d:
            bits.append(f"{d['compliance_pct']}%")
    if session.rpe:
        bits.append(f"rpe {session.rpe:g}")
    return "  ".join(bits)


def cmd_rpe(args: argparse.Namespace, cfg: Config) -> int:
    conn = open_db(cfg.db_path)
    if not 0 <= args.value <= 10:
        print("rpe must be 0-10", file=sys.stderr)
        return 2
    q.set_session_rpe(conn, args.session_id, args.value)
    print(f"session {args.session_id} rpe = {args.value}")
    return 0


def cmd_report(args: argparse.Namespace, cfg: Config) -> int:
    conn = open_db(cfg.db_path)
    week_end = date.fromisoformat(args.week_of) if args.week_of else None
    rep = weekly.build_report(conn, week_end, cfg.planned_per_week)
    print(weekly.render_text(rep))
    if args.html:
        path = weekly.write_html(rep, Path(args.html))
        print(f"wrote {path}")
    return 0


def cmd_sync_log(args: argparse.Namespace, cfg: Config) -> int:
    conn = open_db(cfg.db_path)
    for row in q.recent_sync_log(conn, args.limit):
        detail = f"  {row['detail']}" if row["detail"] else ""
        print(
            f"{row['ran_at']}  {row['status']:<12} {row['endpoint']:<28} "
            f"{row['date_range'] or '':<24}{detail}"
        )
    return 0


# --- wiring ---------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ledger", description=__doc__)
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="create/upgrade the database").set_defaults(fn=cmd_init)
    sub.add_parser("doctor", help="check the setup and name the next action").set_defaults(
        fn=cmd_doctor
    )

    p = sub.add_parser("garmin-login", help="one-time login; mints the token files")
    p.add_argument("--mfa-code", help="one-time code, if the account has MFA enabled")
    p.set_defaults(fn=cmd_garmin_login)

    p = sub.add_parser("leagues", help="refresh league tables and fixtures")
    p.add_argument("--show", action="store_true", help="print what is stored, fetch nothing")
    p.add_argument(
        "--move", nargs=2, metavar=("FIXTURE", "LEAGUE"),
        help="move a fixture (coed, mens) onto a new season by hand: LEAGUE is the "
             "league page URL, its id/slug path, or daysmart:<id>; the team must be "
             "in its standings; the old season is archived",
    )
    p.set_defaults(fn=cmd_leagues)

    p = sub.add_parser("sync", help="incremental Garmin sync")
    p.add_argument("--days", type=int, default=3, help="trailing days to fetch")
    p.set_defaults(fn=cmd_sync)

    p = sub.add_parser("backfill", help="historical Garmin import")
    p.add_argument("--allow-overlap", action="store_true",
                   help="import over dates the notebook already covers (creates duplicates)")
    p.add_argument("--start", required=True, help="YYYY-MM-DD")
    p.add_argument("--end", required=True, help="YYYY-MM-DD")
    p.add_argument("--metrics-only", action="store_true",
                   help="daily metrics only; no activities, three calls a day")
    p.add_argument("--endpoints", default=None,
                   help="with --metrics-only: comma-separated Garmin endpoints to re-read "
                        "(default: get_stats_and_body,get_sleep_data,get_hrv_data)")
    p.set_defaults(fn=cmd_backfill)

    p = sub.add_parser("add", help="bulk-enter notebook sessions")
    p.add_argument("file", nargs="?", help="file to read; stdin if omitted")
    p.add_argument("--dry-run", action="store_true", help="parse and summarise, write nothing")
    p.set_defaults(fn=cmd_add)

    p = sub.add_parser("rpe", help="set a session RPE")
    p.add_argument("session_id", type=int)
    p.add_argument("value", type=float)
    p.set_defaults(fn=cmd_rpe)

    p = sub.add_parser("report", help="weekly report")
    p.add_argument("--week-of", help="any date in the target week, YYYY-MM-DD")
    p.add_argument("--html", metavar="DIR", help="also write HTML to this directory")
    p.set_defaults(fn=cmd_report)

    p = sub.add_parser("sync-log", help="recent sync activity")
    p.add_argument("-n", "--limit", type=int, default=20)
    p.set_defaults(fn=cmd_sync_log)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _force_utf8_stdout()
    _setup_logging(args.verbose)
    return int(args.fn(args, load_config()))


if __name__ == "__main__":
    raise SystemExit(main())
