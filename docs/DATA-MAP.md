# Data map — what breaks when a field changes

Written because a field arriving, changing shape or going missing kept being
fixed in one place and left wrong in four others. HR zones landed on every
Garmin activity and only the Running page noticed; soccer distance was restored
and the Scoreboard kept scoring the old number; bodyweight moved from an EMA to
a reading and three surfaces disagreed for a day.

The pattern is always the same: **one fix, then a manual hunt for everything
downstream, and the hunt misses things.** This is the index that ends the hunt.

## How to use it

1. A field changed — find it below.
2. Every surface listed under it is now suspect. Not "probably fine": suspect.
3. Check each one against the API, in the browser, with real numbers.
4. If you add a surface, add it here. An index nobody updates is worse than
   none, because it will be trusted.

`scripts/qa.py` cannot do step 3 for you. It is a **rendering** audit: it
proves a page draws cleanly, never that a figure is right. Two of its rules
touch meaning (a label contradicting its number, words run together); the rest
would pass a page showing entirely fabricated data.

---

## Field → surfaces

### `session.detail.zones`
Per-session HR zone split, whole percentages summing to 100. Written by the
sync from `hrTimeInZone_1..5`, or by the notebook grammar (`z1=76 z2=23`).

| Surface | Where | Notes |
|---|---|---|
| Heart-rate zones panel | `#/running` | Duration-weighted; reports minutes, not summed percentages |
| Run read-out line | `#/running` | Counts sessions with a split and their total minutes |
| `zoneSplit()` | `dataset.js` | The only aggregator. Weighted by `duration_min` |
| Entry form preservation | `view-entry.js` | **Not** a form-owned key — an edit must never drop it |

**Trap:** zones are percentages *of one session*. Summing them across sessions
is meaningless — that shipped, printing "365 pts" under a caption admitting it
was "not a total of anything". Weight by `duration_min` or do not aggregate.

### `session.distance_km`
| Surface | Where |
|---|---|
| Distance this week (tiles + per-day chart) | `#/week` |
| Distance panel, on-foot split, histogram, log | `#/running` |
| Pace by distance — which runs count for 3, 5, 8, 10 km, half, marathon (±0.15 km; 1.5% above 10 km) | `#/running` |
| Running pillar (distance half) | `#/score` |
| Level — kilometres on foot / on the bike | `#/score` |
| Calendar cell figures, On-foot tile | `#/calendar` |
| Distance over time, committed-plan actuals | `#/plan` |
| The week, day by day — the logged half of each cell | `#/plan` |
| Activities-per-week, day grid | `#/all` |

**Trap:** on-foot is `ON_FOOT` (soccer, run, stairs, quickfeet, ruck, and
`other` — which contributes only when it carries a distance, by the user's
rule that a one-off on the legs is still on the legs), never `run` alone.
`stairs` is Garmin's `floor_climbing`, a kind since migration 014. A panel counting runs beside one counting on-foot is two definitions of
distance on one page — that shipped too.

### `session.pace_s_per_km` / `session.duration_min`
Pace is stored per session by the sync; a hand-logged run has none and the
front end falls back to duration over distance (`paceOf()` in `dataset.js`).

| Surface | Where | Notes |
|---|---|---|
| Mean pace tile, Quickest 3 km+ tile | `#/running` | Distance-weighted |
| Pace panel | `#/running` | `paceByPeriod()`, total seconds over total km per period |
| Pace by distance — recorded pace per run, best, latest, run before, table | `#/running` | `distanceSummary()`; recorded runs only, nothing averaged or smoothed, by the user's rule |
| Pace by distance — the chosen distance | `#/running` | `?dist=` in the URL, else `ledger.running.dist` in localStorage, else 5 km |
| Every run log, To plan tooltips | `#/running` | Per-run figure |

**Trap:** a pace is never averaged as a pace. Three runs at 5:00, 6:00 and
7:00 are not a 6:00 run unless they were the same distance; sum the seconds
and the kilometres and divide once. Every aggregate above does.

### `session.detail.garmin_load`
| Surface | Where |
|---|---|
| Load chip on a session row | everywhere `sessionRow` renders |
| Foster-vs-Garmin comparison | `#/week` |
| Entry form preservation | `view-entry.js` — not form-owned |

### `session.detail.result` / `gf` / `ga`
| Surface | Where |
|---|---|
| Record, win rate, form strip, results-by-month | `#/soccer` |
| Share of team goals | `#/soccer` |
| Soccer pillar (result half) | `#/score` |
| Level — soccer wins, draws | `#/score` |
| Soccer insights (7 rules) | `#/insights` |

**Trap:** a match can carry a scoreline without goals, or goals without a
scoreline. Any ratio over both must state its denominator.

### `session.detail.goals` / `assists`
| Surface | Where |
|---|---|
| Goal involvement, involvement per match, share of team goals | `#/soccer` |
| Soccer pillar (involvement half) | `#/score` |
| Level — goals and assists | `#/score` |
| Soccer insights | `#/insights` |

### `session.kind`
Touches **every** view. A reclassification moves a session between the soccer
record, the load split, the activity mix, the on-foot totals, the calendar
legend and the planned-vs-logged counts simultaneously.

**Trap:** Garmin has no ab-attack or quick-feet type. Kind can be set by the
activity *name*, by the type map, or by hand. Precedence is **hand, then name,
then type**, and the first step is absolute: `kind_locked = 1` is never
overruled. The watch's name briefly outranked it, which meant a correction made
in the app was replayed away by the next sync — the name is fixed when the
activity is recorded, so the override served the user's oldest answer forever.
See the CASE in `queries.py::upsert_garmin_session`.

Correcting a kind also renames the session when its note is still the watch's
label, so a row cannot read "Ab attack" in its title and "Strength" underneath.
A note the user typed is never touched.

### `metric_daily` — the watch's nightly numbers  →  `GET /api/metrics`
`sleep_hours`, `hrv_ms`, `resting_hr`, `readiness`, `body_battery_high/low`
since 2026-01-01. Migration 015 adds `sleep_score`, `deep_min`, `rem_min`,
`awake_min`, `sleep_start_local`, `sleep_end_local`, `stress_avg`, `steps`,
`intensity_*_min`, `body_battery_wake`, `body_battery_charged`; 016 adds
Garmin's personal thresholds `hrv_status`, `hrv_balanced_low/high`,
`hrv_low_upper`, `sleep_need_min`. All from the payloads the nightly sync
already fetches; history filled by `ledger backfill --metrics-only`. Row
dated D is the night that **ended** on the morning of D.

| Surface | Where | Notes |
|---|---|---|
| Last night, and the longer term | `#/recovery` | Three fixed windows named in the column headers (plus the selected range when it is not 4 weeks); every figure carries the band it falls in |
| This morning | `#/recovery` | `todayFindings()` in `recovery.js`: HRV vs the stored balanced range over the last 3 nights, resting HR vs the 28-night mean, sleep debt this week vs `sleep_need_min`, readiness on Garmin's bands, next fixture from `/api/leagues` |
| Sleep, Sleep score, HRV, Resting heart rate, Readiness, Stress, Body battery at wake | `#/recovery` | One column per calendar day over the selected range, tinted by band; guide line = sleep need / 28-night RHR mean; shaded band = HRV balanced range; each prints "This week X · range Y" |
| Sleep stages, Sleep by weekday | `#/recovery` | Light sleep = asleep − deep − REM, computed in `recovery.js` |
| What the record says | `#/recovery` | `patternFindings()`: match recovery cost (D+1..D+3 vs rest mornings), G+A and RPE after nights that met / missed the need, run pace after balanced / below-range HRV, the weekday that costs sleep, stress → next night's score. Each has a minimum n and fires only past it |
| The morning after, The day after | `#/recovery` | Row D+1 grouped by what day D was; sessions on D paired with row D, split on `sleep_need_min` and the HRV range |
| Read-out, Every night | `#/recovery` | The table prints every row the charts drew, with Garmin's need and range per night |
| Recovery (six cards: sleep, sleep score, HRV, resting HR, readiness, body battery at wake) | `#/week` | `measureCards()` in `recovery-cards.js` — the **same builder and rows** as *Last night, and the longer term* on `#/recovery`; last night large, then the week on screen ("This week" or "Week of …") and the last 28 nights, each tagged on its scale and drawn on a meter of that scale (invariant 17) |
| Nights by month | `#/all` | `metricByMonth()` in `dataset.js`: mean per calendar month for the picked measure, the nights counted on every column; months with no night absent, never zero |
| Nights grid under each year, Nights tile, year head (Sleep / HRV / Resting HR / Readiness mean ·n), recovery lines in the Read-out | `#/all` | Every night of the year as a cell on a four-step ramp cut at the measure's own quartiles over the whole record — magnitude, never a reading, so no tone; the year head and the read-out are `summarise()` / `recoveryReadout()` from `recovery.js` |
| Week footnote (HRV, RHR, readiness, sleep: week vs 28-day) | `#/week` | Server-side `_recovery()` in `report/weekly.py` — equals the *This week* / *Last 28 nights* columns (invariant 16) |
| Sleep habit | `#/habits`, `#/week`, `#/calendar` | Reads `sleep_hours` against `habit.target` |

**Bands are Garmin's, and `recovery.js` is the only place they are written
down** (`BANDS`, `hrvBand`, `sleepBand`, `rhrBand`); `recovery-cards.js` is the
only place a row is turned into a reading (`readingOf`) and a card. Readiness: Poor 1–24,
Low 25–49, Moderate 50–74, High 75–94, Prime 95–100. Sleep score: Poor <60,
Fair 60–79, Good 80–89, Excellent 90+. Stress: Rest 0–25, Low 26–50,
Medium 51–75, High 76–100. Body battery: Low 0–25, Medium 26–50, High 51–75,
Very high 76–100. HRV: against the row's own `hrv_balanced_low/high`
(falling back to the latest row that has one). Sleep: against the row's own
`sleep_need_min`. Resting HR: against the 28-night mean, ±3 / 5 bpm.

**Trap:** the sync keeps a value it already has when Garmin returns nothing
(`upsert_metric_daily` never writes a None), so a column that is null is one
that was never fetched, not one that failed last night.

### `bodyweight` (`ema_kg`, `delta_4w_kg`, `series[].kg`)
| Surface | Where |
|---|---|
| Bodyweight tile | `#/week` |
| Bodyweight chart, delta tiles, fasting overlay | `#/all` |
| Bodyweight pillar | `#/score` |
| Weight insights | `#/insights` |

**Trap:** the server publishes an EMA and an EMA-to-EMA delta. Display uses
**readings** (`series[].kg`) throughout — since 2026-11-01 nothing draws the
EMA at all; the chart's seven-day trend line was the last use and was removed
at the user's request. Mixing the two makes two screens disagree by ~2 lb.

### `load` / `load_source` / `foster_au`
| Surface | Where |
|---|---|
| Load tile, split bar, ACWR | `#/week` |
| Load pillar | `#/score` |
| Load charts | `#/trends`, `#/all` |
| Calendar cell figures | `#/calendar` |
| Load insights | `#/insights` |

**Trap:** two scales are live at once — see `NOTES-FOR-BACKEND.md` §0. Any
surface printing a load total must say which scale.

### `/api/plan/locked` — `target_km`, `actual_km`, `is_deload`
| Surface | Where |
|---|---|
| Target and Left tiles, attainment tone | `#/week` |
| The weeks table, down-week tags | `#/plan` |
| Committed target on the on-foot panel | `#/running` |
| Running pillar denominator | `#/score` |
| The week, day by day — the target the days divide | `#/plan` |

**Trap:** the committed plan and the live projection are different quantities
with independent deload cadences. Never OR their flags — that put two adjacent
"down week" tags on rising numbers.

### `habit_day.done` / `habit_day.value`  →  `GET /api/habits`

One row per habit per day. What the two columns mean depends on the habit's
mode, and `report/habits.py::resolve_day` is the **only** thing in the codebase
that applies that rule — a tapped habit answers with `done`, a measured one
with `value`, and every surface below reads the resolved state rather than
either column.

The resolved states are `met`, `partial`, `missed`, `open`, `unrecorded`,
`ahead`. `totals` carries `met`, `scored`, `credit` and `rate` for the window
requested, and is the **only** place a rate is computed.

| Surface | Where |
|---|---|
| Today | `#/habits` — the one-tap row per habit |
| The week | `#/habits` — the seven-day grid, and where a past day is corrected |
| The list | `#/habits` — definitions, add, archive |
| Habits (widget) | `#/week` — the same seven days, and today's box |
| Habits pillar | `#/score` — 10% of the week score |
| Week score widget | `#/week` — the pillar strip includes Habits |
| Calendar overlay | `#/calendar` — week and month grains, read-only |
| `score.js::habitsPillar` | the only scorer; mean of each habit's own `rate` |
| `habits.js` | marks, words and hue — decides no day's state |

**Trap:** `unrecorded` is not `missed`. A night the watch did not record leaves
the denominator entirely; counting it as a zero grades you on whether you wore
a device. `open` (today) is likewise not a miss — only finished days score, so
a Monday morning has nothing to score and the pillar is *absent*, not nought.

**Trap:** the pillar is the mean of each habit's **own** rate, never total ticks
over total days. Habits have different denominators — sleep can be missing two
nights — and pooling them would silently weight the best-recorded habit highest.

**Trap:** a habit tick is not a session. Nothing in this path writes to
`session`, so it can never reach activities-per-week, the load scale, ACWR or
the log. If a habit ever needs to count as training, it gets logged as an
activity instead.

### `habit.target` / `habit.partial_at`

Sleep's 8 h tick and the 7 h floor under it. Moving either changes every `met`
and `partial` in history, because state is resolved at read time and not stored.

| Surface | Where |
|---|---|
| The week — target line under each name | `#/habits` |
| The partial-band note | `#/habits` |
| Sleep pillar line | `#/score` |
| `habits.js::targetText` | the only formatter |

**Trap:** sleep is read from `metric_daily.sleep_hours`, which the nightly
Garmin sync writes. A hand-entered `habit_day.value` overrides it and the sync
never touches that row — so "corrected by hand" and "from Garmin" are different
states and both are shown.

### `league.archived_at` / `league.path`  →  `GET /api/leagues`

A `league` row is one **season** of a fixture, not the fixture itself. `fixture`
('coed', 'mens') persists; the league id behind it changes every season, and
the old season is archived rather than deleted so its results stay readable.

Two providers feed the same tables. The ezleagues venue is scraped from
ezleagues (`leagues.parse`); the DaySmart venue is read from the DaySmart API
(`leagues.daysmart_league`, ids prefixed `daysmart:`). DaySmart publishes no
standings — the table is **computed from the fixtures** by Dash's own rule
(W 3, D 1; points, GD, wins, GF), so on a DaySmart card the standing and the
results strip can never disagree; if they do, the computation is wrong.

**Men's league moved** from the ezleagues venue (Wednesdays, Harbour Lights) to
the DaySmart venue (Thursdays, Night Owls) — last ezleagues game 2026-09-09,
first DaySmart game 2026-09-17. Migration 013 made the switch, and the weekday→fixture rule is
dated (`MENS_ON_THURSDAY_FROM` = 2026-09-10, in both
`report/views.py` and `web/dataset.js`) so summer Wednesdays still resolve to
men's league. **The league schedule outranks the weekday** (since 2026-11-01):
`views._scheduled_fixtures()` reads every season's fixtures for the team, so a
match logged on a date the league had a game is that league's fixture
(`fixture_source` = `schedule`), whatever the weekday says — a coed game moved
to a Tuesday was being filed as pickup and its goals left out of the season.
An explicit `detail.team` still wins over everything. Surfaces that read the rule: the Soccer page By-fixture panel and
match table, the entry form's implied fixture, `/api/views/soccer` `fixture`
and `fixture_source`.

| Surface | Where |
|---|---|
| League cards, standings, next fixture | `#/soccer` — current seasons only |
| `leagues.read()` | filters `archived_at IS NULL` |
| `leagues.configured()` | the current season per fixture; the seeds only until a row exists |
| `leagues.discover()` | the only thing that archives a season and names its successor |
| `ledger leagues` (CLI) | prints any switch |
| `ledger leagues --move FIXTURE LEAGUE` | the hand move: same writes as `discover()`, same rule (the team must be in the new standings); needed since the venue's listing page became a facility search in November 2026 |
| Seasons | `#/soccer` — a folded timeline, years newest first and seasons in the order played; each row opens onto the season's full `standings` and `my_fixtures`: `leagues.seasons()` via `GET /api/leagues/seasons`. Position and record are the stored standing row (the final table for an archived season); results are `league_fixture`; the logged goals/assists — per fixture (`my_fixtures[].logged`, by date) and the season total — are `views.soccer()` over the season's dates, filtered to the fixture, so they equal the Matches table for that window; the live cards' fixture lists carry the same per-game line |

**Trap:** a fixture moves to a new league **only** when that league's standings
contain `my_team` *and* it runs later than the season being replaced. Both
halves are load-bearing and both were proven by failure:

* Matching on the division's *name* attaches the wrong league — the
  ezleagues venue runs a Coed 30+ division on the same nights as Coed Open, and
  a team called **Sparrows United** plays in a different division from
  **Sparrows FC**.
* The team-name match allows exactly one typing slip (`leagues.same_team`):
  the venue entered the name with one letter dropped (**Sparows FC**) for Fall
  2026 and discovery sat on the finished summer league for three days. One
  swap, substitution, extra or missing letter on a name of eight or more;
  **Sparrows United** is six away and still never matches. The row then
  carries the spelling the new page prints, so every later exact match against
  its table and fixtures holds.
* Matching on the team alone walks *backwards*. The first live run moved the
  men's fixture from Summer to the **Spring** session, because the venue still
  publishes Spring and Harbour Lights are in its table.

**Trap:** the ezleagues listing (`LISTING_URL`) stopped listing leagues in
November 2026 — every path on the venue host lands on a facility search — so
`discover()` cannot find a successor until a new listing source is found. A
new session is attached with `ledger leagues --move`; the league pages
themselves still parse.

**Trap:** `DEFAULT_LEAGUES` in `ledger/leagues.py` is a seed, not the config.
Once a league row exists the database is the authority — editing the constant
to change seasons does nothing.

### `/api/plan/intent` — `kinds`, `note`
Planned session counts per kind for a week, one row per week written
explicitly. A week with no row **inherits the most recent earlier one**
(`dataset.js::weekIntent`), and every surface below reads through that one
function so they cannot disagree about what applies. Server-side since
migration 017; before that it was `ledger.plan` in one browser's localStorage,
and the phone never saw it. On first load after the move, `dataset.js`
pushes any plan still in localStorage up for weeks the server lacks, then
removes the local copy.

| Surface | Where |
|---|---|
| Week picker counts, Intent, Against the record, Every plan | `#/plan` |
| Plan-adherence pillar (planned counts) | `#/score`, the score tile on `#/week` |
| The week, day by day — how many run days to spread over | `#/plan` |

**Trap:** the endpoint reports what was *written*, not what *applies*. A
week that inherits is absent from `/api/plan/intent` and present on every
page; asking the API why a week "has a plan" means looking at the latest
earlier row.

### `/api/plan/goal` — `goal_weight_lb`
The goal the bodyweight pillar scores movement toward. Null until set; the
pillar is absent while it is null. Server-side since migration 017 (was
`ledger.goalWeightLb` in localStorage).

| Surface | Where |
|---|---|
| Goal weight setting | `#/plan` |
| Bodyweight pillar | `#/score`, the score tile on `#/week` |

### `/api/plan/days` — `km`, `match`
`{ week_start, km: { date: n }, match: [dates] }` — how a week's committed
distance is spread over its seven days, and which days the user marked as
match days. Written only by "The week, day by day" on `#/plan`. Server-side
since migration 017 (was `ledger.plan.days` in localStorage). Every date is
refused unless it falls inside the week.

| Surface | Where |
|---|---|
| The week, day by day | `#/plan` |

**Trap:** a day that has gone by without a run contributes **nothing**, and its
cell says so with a dash. Its stale `planned` value was still being summed, so
a week carrying 5.0 km on a dead Wednesday and 10.9 on a dead Friday reported
51.6 km "placed" across seven cells that visibly came to 35.7 — and then told
the user they were 8.9 km *over* a 42.7 km target they were in fact 18.0 km
short of. `rowKm()` is the only arithmetic the cells and the totals share, and
it returns 0 for `when === 'done'` without a logged run.

**Trap:** three quantities, and collapsing any two of them is what made this
panel unreadable. **Done** is what is on the record. **Planned** is what has
been written onto a day that can still take a run — never a day already run,
never a day that has gone by. **Still to run** is `Committed − Done`, and
**Still to plan** is a share of *that*, never of the whole target: a week owing
18.0 km with 10.9 on a day has 7.1 still to plan. The old panel printed
"Still to place 3.4 km" against a week that still owed 18.0.

**Trap:** "still to run" is `target − actual_km`, rounded **once**, from the raw
server figure. Subtracting the displayed 24.8 from 42.7 gives 17.9 where
`#/week` gives 18.0 — the same quantity on two screens with two values.

**Trap:** the cells and their total must be built from the *same* rounded
figures. Summing raw per-day distances and rounding the sum prints a total the
column visibly does not add up to — the week of 17 Aug logs 35.35 km, which is
35.3 across the tiles and 35.4 in a raw sum. `rowKm()` rounds once and every
total is built from it, which costs at most a tenth against the week's
canonical `actual_km` on `#/week` and `#/running`. That is deliberate: a panel
must first agree with itself.

**Trap:** matches come from two places. The league schedule publishes some
(`/api/leagues` → `my_fixtures`), and the user knows about the rest. Placing
only the published ones pushes an unplayed match's kilometres onto a run day —
three runs of 12.6 km instead of two matches and three runs of 10.9.

---

## Surfaces by page

Counts from `scripts/inventory.py`; run it after adding a panel.

| Page | Panels | Charts | Tables | Stat strips |
|---|---|---|---|---|
| `#/week` | 13 | 2 | 0 | 4 |
| `#/score` | 4 | 1 | 2 | 2 |
| `#/calendar` | 1 | 0 | 0 | 1 |
| `#/habits` | 3 | 0 | 0 | 1 |
| `#/recovery` | 16 | 4 | 8 | 0 |
| `#/plan` | 10 | 3 | 4 | 3 |
| `#/insights` | 2 | 0 | 0 | 0 |
| `#/soccer` | 9 | 4 | 5 | 2 |
| `#/running` | 10 | 7 | 5 | 3 |
| `#/lifting` | 7 | 3 | 2 | 1 |
| `#/trends` | 6 | 4 | 0 | 1 |
| `#/all` | 9 | 8 | 0 | 4 |
| `#/log` | 1 | 0 | 0 | 0 |
| `#/sync` | 6 | 0 | 2 | 2 |

---

## Every panel, by page

Generated by `scripts/inventory.py`; `--check` fails when a panel here is
missing, which is what stops the index above from quietly going stale. A panel
nobody indexed is a panel nobody will think to re-check when its data changes.

### `#/all`

- Activities per week
- Bodyweight
- Bodyweight and fasting
- Rolling 28-day count
- Nights by month
- Read-out
- Mix by year
- Shape of the record
- Every day on record

### `#/calendar`

- Calendar

### `#/entry`

- Added to the record
- Personal bests

### `#/habits`

- Today
- The week
- The list

### `#/insights`

- Insights

### `#/lifting`

- Where this stands
- Sessions over time
- Scope
- When
- Rep series
- Read-out
- Every session

### `#/log`

- Sessions

### `#/plan`

- The week, day by day
- Where this ends up
- Week by week
- The plan, in numbers
- Distance over time
- Intent
- Against the record
- Every plan
- The weeks, in numbers

### `#/recovery`

- Last night, and the longer term
- This morning
- Sleep
- Sleep score
- HRV
- Resting heart rate
- Readiness
- Stress
- Body battery at wake
- Sleep stages
- Sleep by weekday
- What the record says
- The morning after
- The day after
- Read-out
- Every night

### `#/running`

- On foot, week over week
- Distance
- Pace by distance
- Pace
- How far
- When
- To plan
- Heart-rate zones
- Read-out
- Every run

### `#/score`

- Where the score came from
- Week over week
- Level

### `#/soccer`

- Seasons
- By fixture
- Goal involvement
- Involvement per match
- Scored and conceded
- Results by month
- Form
- Read-out
- Matches

### `#/sync`

- Garmin
- Pull latest activities
- Sync log
- Load calibration
- What a sync does
- This build

### `#/trends`

-  
- Mix over time
- Weekday rhythm
- How hard
- Share of the range
- Read-out

### `#/week`

- Distance this week
- Habits
- Recovery
- Week score
- This week on one scale
- Acute : chronic
- Unified load
- Activity mix
- Read-out
- Sessions
- Personal bests
- Week notes
- Start-of-week weigh-in

---

## Cross-surface invariants

Things that must agree. Each one is here because it once did not.

| # | Invariant |
|---|---|
| 1 | Week score on `#/week` == week score on `#/score`, same week |
| 2 | Soccer record on `#/soccer` == wins/draws feeding the Level |
| 3 | Matches listed on `#/soccer` == `games` from `/api/soccer` |
| 4 | Share-of-team-goals denominator == the Team goals tile beside it |
| 5 | On-foot km this week: `#/week` tile == `#/plan` logged == `#/running` |
| 6 | Bodyweight: `#/week` tile == `#/all` Latest == `#/score` pillar |
| 7 | Committed target: `#/week` == `#/plan` == `#/running` |
| 8 | Activity counts on `#/calendar` == `/api/sessions` for that span |
| 9 | Every panel's timeframe label == the window it actually drew |
| 10 | A down-week tag never sits on a figure above the week before it |
| 11 | `#/plan` day-by-day is one chain: Committed − Done = Still to run; Still to run − planned-ahead = Still to plan |
| 12 | The cells reading "km run" sum to **Done**; the cells reading "km planned" sum to Still-to-run minus Still-to-plan |
| 13 | "Still to run" on `#/plan` == "Left" on `#/week` — one subtraction, rounded once, from `locked.actual_km` |
| 14 | A `#/plan` day cell showing "—" contributes 0 to every total on the panel |
| 13 | A habit day's state on `#/week`, `#/habits` and `#/calendar` is the same state — all three read `GET /api/habits`, none resolves a day itself |
| 14 | The Habits pillar on `#/week` == the Habits pillar on `#/score`, same week |
| 15 | A habit's rate == its own `totals.met`/`totals.scored`; no surface recomputes either |
| 16 | Recovery: the `#/week` footnote (week mean vs 28-day mean of HRV, resting HR, readiness, sleep) == the *This week* and *Last 28 nights* columns on `#/recovery` — verified equal on 2026-10-31; both are plain means over `metric_daily` with the same Monday and the same trailing window |
| 18 | Two activity totals on `#/all` are two quantities and are labelled as such: "In the average" is `history.average.activities` (through the last completed Sunday, what the lifetime average divides) and "Activities" is `history.total` (everything on record, the week in progress included); each tile names the gap between them |
| 17 | The six Recovery cards on `#/week` == the same six cards on `#/recovery` (last night, the week, the 28 nights, and every tag): one builder, `measureCards()` in `recovery-cards.js`, fed the same `/api/metrics` rows; neither page computes a reading itself |

## Verifying

`agents/data-auditor` walks all of it. Run it after any change to a data
field, a mapping rule, or an aggregate.
