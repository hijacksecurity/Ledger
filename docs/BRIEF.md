# Build brief

**Placeholder — paste the original "LEDGER — Build Brief" here.**

The brief is the founding document for this repo and is referenced by section
number throughout the code (`BRIEF §4`, `BRIEF §6`, and so on). It has not been
reproduced here rather than risk a paraphrase drifting from the original: a
subtly wrong copy of the spec is worse than a pointer to it.

Section map, so the in-code references resolve until the real text lands:

| § | Topic |
|---|---|
| 1 | Why this exists — notebook, Garmin undercounting soccer, no unified load |
| 2 | Non-goals — no auth, no multi-tenancy, no exercise DB, no streaks, no scoring bodyweight |
| 3 | Stack — Python 3.11+, FastAPI, SQLite, plain SQL migrations, vanilla PWA, cron, Docker |
| 4 | Data model — `exercise`, `session`, `lift_set`, `metric_daily`, `pr`, `sync_log` |
| 5 | Garmin sync — auth, token persistence, rate limiting, endpoints, mapping rules |
| 6 | Scoring — score inputs vs report outputs, rolling windows, Epley e1RM, PR detection |
| 7 | Bodyweight — store, plot as 7-day EMA, never score |
| 8 | Unified load — Foster session-RPE, ACWR bands as heuristic not verdict |
| 9 | Weekly report — section ordering, consistency leads, PRs follow |
| 10 | Build phases — 0 sync+report, 1 PWA, 2 e1RM/PR, 3 unified load |
| 11 | Deployment — one container, Tailscale only, nightly backup to a private repo |
| 12 | Conventions — type hints, ruff, pytest, defensive parsing, always log to `sync_log` |

> **Where the brief and reality diverge:** §4 and §6 assume a barbell-centric
> log. The actual notebook contains no weight×reps data at all. See
> [NOTEBOOK.md](NOTEBOOK.md) — it is the authoritative description of the source
> data, and `002_notebook_reality.sql` follows it rather than §4.
>
> **§2 and §7, bodyweight:** it is now plotted as the readings themselves —
> the 7-day EMA is still published by the API but nothing draws it — and two
> pages colour it, both by direct request: the Scoreboard scores the
> four-week average's movement toward a goal weight, and the Calories page
> tints the latest reading green or red for direction toward that goal
> (untinted when none is set). Neither scores the number itself. `CLAUDE.md`
> records both exceptions and the rules that keep them honest.
