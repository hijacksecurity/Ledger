# Notes for the backend

Written by whoever built `ledger/web/`. Nothing in here was changed in Python —
these are requests, in priority order.

**One open bug — 0-BUG below**, and it is a one-liner. The three that used to
head this file are fixed and their front-end workarounds have been deleted; see
"Closed" below so nobody re-reports them.

---

## 0-BUG. Every write echoes an *uncalibrated* load, so a session shows two different figures

`_session_out()` (`api/main.py:152`) is what `POST` and `PATCH /api/sessions`
return, and it calls `views.session_dict(row)` **without a calibration**.
`session_dict` then falls back to `calibrate.Calibration()`, which is not
fitted, so `session_load()` takes its "nothing to convert with yet" branch and
returns the raw Foster figure marked `unscaled`. The list endpoint
(`views.py:118`) passes `cal` properly, so the same row reads differently
depending on which endpoint you asked:

```
PATCH /api/sessions/378  -> "load": 366.0, "load_source": "unscaled"
GET   /api/sessions      -> "load":  86.5, "load_source": "estimated"
```

Same session, same second, 4.2× apart. Nothing is stored wrong — `load` is
computed per request — but it is *shown* wrong at the one moment the user is
looking hardest:

- The "Added to the record" card after a save renders `sessionRow(saved)` from
  that echo, so it prints **366 AU `raw`** where every other screen prints
  **87 AU `est`**.
- `rememberSessions([saved])` seeds the client-side session cache from the same
  echo, so the wrong figure can outlive the card.

Fix is to thread the calibration through, as the list path already does:

```python
def _session_out(conn, session_id):
    ...
    return views.session_dict(row, calibrate.fit(conn))   # or whatever the list path uses
```

**No front-end workaround has been added for this**, deliberately. Recomputing
or suppressing the figure in the browser would put the load model in two places
— the exact failure documented in item 0 and in the deleted distance layer —
to paper over one missing argument.

**`/api/parse` is not one of them, though it looked like it for a while.** A
match lost its scoreline on the way into the record, and the endpoint was the
first suspect. It is clean: `13:5` on its own comes back as
`{"sessions": [], "error": "line 1: unrecognised token '13:5' in session
header"}` — no session, named token, and the entry form already renders that
and disables Save. The loss happened a step earlier, in `composeShorthand()`,
which emitted no scoreline token at all unless result, `gf` and `ga` were *all*
set; so a match with a score and no W/D/L composed a valid line with the score
simply missing, and nothing downstream had anything to complain about. Fixed in
`view-entry.js`. Recorded here only so the endpoint does not get re-investigated
for it.

---

## Closed — verified 11 Aug 2026, workarounds removed

| Was | Verified by | What came out of `ledger/web/` |
|---|---|---|
| `GET /api/sessions?from=…` with no `to` returned `timeframe: "no data yet"` | All four cases from the original report now return a real `from`/`to` and label | Nothing — `resolveRange()` keeps its explicit `to`, for a different and now-stated reason (below) |
| Timeframe labels arrived double-encoded (`â€“`, `Â·`) | Every string field on ten endpoints swept for the four latin-1 sequences: **zero hits**. The only non-ASCII served is the intended U+2013, U+2014 and U+00B7, as valid UTF-8 | `core.js::demojibake` **deleted**, with its fourteen call sites. Labels and prose now print verbatim |
| Shared SQLite connection 500'd on parallel requests | 36 concurrent reads across six endpoints, all 200. `api/main.py::get_db` opens per request with `same_thread=False`, and `tests/test_api_concurrency.py` guards it | The application-wide request queue **deleted**; panels fetch in parallel. The single retry stays — a transient failure still should not blank a populated panel |

And two more, closed the same day:

| Was | Now |
|---|---|
| `/api/plan/distance` defaulted its base to the week containing today, so on a Monday `base_km` was 0 and the whole projection was zeroes | The base is **always the last complete week**. The client's `week_of` workaround and its extra round trip are deleted; `history` is complete weeks only and the live week arrives as its own `current_week` field |
| Twelve windows that all meant "now" ended on five different dates — the coming Sunday, today, the last logged session, the last logged *run*, the Monday the final bucket starts on | One rule in `report/timeframe.py`: a window over the past ends today. Every window also carries `as_of`. Exceptions must be asked for — `forecast=True`, and `one_week()` which names a calendar unit |

Two notes on the encoding fix, so it does not get re-plastered:

- `demojibake` is not worth reviving. It rewrote byte patterns inside prose the
  user can type, and `leagues.py::fetch` — the one path ingesting outside text —
  decodes UTF-8 explicitly, so the pattern cannot re-enter that way either.
- `resolveRange()` still sends `to: today` for bounded presets. That is now a
  deliberate choice rather than a workaround: left open, the label ends at the
  last *logged session*, so "52 weeks" reads as ending last Tuesday. Naming
  today states what the control asked for. Same sessions either way.

---

## 0-BUG2. A sync overwrites `kind`, and quick feet cannot survive it

**Found live, on 23 Aug 2026.** Two sessions classified as `quickfeet` came back
as `soccer` after a sync, and the reclassification is not recoverable by
re-syncing — it happens again every time.

`mapping.py::from_activity` sets `kind=map_kind(type_key)` and uses the
activity **name** only for `notes`. Garmin has no quick-feet activity type, so
those sessions are recorded on the watch as a soccer activity named
"Quick Feet":

```
activityId 24090592582  activityName "Quick Feet"  typeKey "soccer"  1583 m
activityId 24090741342  activityName "Soccer/Football"  typeKey "soccer"  519 m
```

`KIND_BY_TYPE_KEY` has no `quickfeet` entry at all, so quick feet can only ever
arrive as soccer. Anything the user has corrected by hand is silently undone
on the next sync.

It is not only a labelling problem. `quickfeet` is a modality everywhere else in
the app — its own colour, its own band in the on-foot split, its own row in the
week's planned counts — and the Scoreboard's soccer pillar counts *matches*, so
a mislabelled quick-feet session dilutes the goals-and-assists expectation it
divides by.

**Asked for, in order of preference:**

1. **Never overwrite a `kind` that differs from the mapping on an existing
   row.** A sync should fill blanks and correct its own previous guesses, not
   overrule a human. This is the general fix and it protects every future
   hand-correction, not just this one.
2. A name rule alongside the type rule — `activityName` matching `quick ?feet`
   maps to `quickfeet` — so it lands right the first time.

**The merge SQL is fine and should not be touched.** `attach_garmin_to_session`
already does the right thing (`distance_km = COALESCE(?, distance_km)`, watch
wins; everything else COALESCEs the other way). The distance gap that led here
was a row the activity had simply never been attached to — no merge had run —
and a plain sync filled it correctly.

---

## 0-BUG3. HR zones are on every Garmin activity and we store none of them

The Running page's "Heart-rate zones" panel states its own coverage, and the
coverage is **1 run in 13**. That one came off a notebook page as `z1=31 z2=42`.
Every other run has zone data on the watch and we drop it.

The activity payload `sync.py` already fetches carries it:

```
"hrTimeInZone_1": 377.969,   "hrTimeInZone_2": 457.944,
"hrTimeInZone_3": 83.999,    "hrTimeInZone_4": 0.0,
"hrTimeInZone_5": 0.0
```

Seconds per zone, on running *and* soccer activities. There is also a dedicated
endpoint (`get_activity_hr_in_timezones`) returning the same figures plus each
zone's lower bound, but it costs an extra paced call per activity and the
summary already has what the panel needs.

**Asked for:** read those five fields in `mapping.py::from_activity` into
`detail.zones`, in the shape the notebook grammar already produces — the front
end reads `detail.zones` today and needs no change:

```python
zones = {f"z{i}": secs for i in range(1, 6) if (secs := _num(activity.get(f"hrTimeInZone_{i}")))}
```

Two details:

- **Store seconds, or store percentages, but say which.** The notebook's
  `z1=31 z2=42` are percentages of the session; Garmin's are seconds. Mixing
  the two silently would make the panel's split meaningless — worse than the
  gap it fills. Either normalise on the way in, or add `zones_unit` so the
  front end can.
- A manual session has no zone data. Leave it absent rather than zeroed, the
  same way `garmin_load` is.

---

## 0-REQ. `/api/history` has no window parameter, so two panels build their own label

The All-time page's two flagship panels (activities per week, bodyweight) have
a 26w / 52w / 2y / all-time control that slices the series **in the browser**,
because `/api/history` only ever returns the whole record. Every other charted
panel in the app now prints a server-published `timeframe.label` verbatim;
those two have to compose their own string when the control is not on "all
time", which is the one place the rule is broken.

`GET /api/history?weeks=52` returning the sliced series plus its own
`timeframe` would close it.

---

## 0. LIVE — half the app is on the calibrated load scale and half is not

`report/views.py::session_dict` returns the new figures: `load` on Garmin's
scale, `load_source`, `foster_au`. **`report/weekly.py` has not moved**, so
`/api/summary` still builds its load block from `core/load.py` — Foster
`rpe × minutes`. The two are on screen together and differ by roughly 4–5×:

```
GET /api/summary?week_of=2026-08-02
  load.week_total  1458      <- Foster
  sum(sessions[].load)  310  <- calibrated
```

Everything derived from that block is affected: `week_total`, `by_kind`,
`split`, `acwr`, `acute_au`, `chronic_au`, and every entry in `load_by_week`.
`/api/trends?metric=load` almost certainly too.

What the front end does in the meantime, so nothing on screen is a lie:

- Session rows show `load` with `load_source` marked — `est` for a converted
  figure, `raw` for one no factor could be fitted for, both with the dotted
  underline an estimated RPE already uses.
- The Sessions panel caption sums the rows it is actually rendering, because a
  caption that says "2,091 AU" over a list adding to 310 is indefensible.
- The Load tile and the unified-load chart keep quoting the server, and **say
  which scale that is**. The wording is chosen at runtime by comparing
  `load.week_total` against the sum of `sessions[].load`, so the moment
  `weekly.py` moves over, the note becomes "Garmin's training-load scale · N
  estimated" on its own with no front-end change.

Nothing is rescaled client-side. A global multiply would be wrong — the factor
is per modality — and inventing one is exactly how a figure ends up computed in
two places again.

**`unscored` needs a look too.** It counts sessions with no Foster load; under
the new model the equivalent is `load_source: "none"`, and the two will not
agree for long.

---

## Landed since the last pass — thank you

All of these are now consumed by the front end. Listed so nobody re-requests
them, and so it is clear where the numbers on each screen come from.

| Shipped | Where it shows up |
|---|---|
| `GET/POST /api/weeks/{start}/notes`, `PATCH`/`DELETE /api/notes/{id}` | Week view — notes are individual bullets now, editable and reorderable in place. The single-textarea shorthand path and its `localStorage` mirror are both deleted. |
| `PUT /api/weeks/{start}` | The start-of-week weigh-in writes here instead of composing a `week …` shorthand line. |
| `GET /api/history` → `average{value,activities,weeks,through,basis}` | The History page's "Now" tile, and the anchor for its 84-week series. |
| `load.acute_au` / `load.chronic_au` on `/api/summary` | The ACWR panel prints the division itself: `299 AU/day over 7 days ÷ 196 AU/day over 28`. |
| `detail.garmin_load` | A labelled chip on every session row that has one, and a Foster-vs-Garmin pair inside "Why this will not match Garmin" on the Week view. Never summed with AU. |
| `fixture.home_game` / `opponent` / `opponent_standing` on `/api/leagues` | The next-fixture block on each league card carries the opponent's position and record. |
| `GET /api/distance` | The Running page's "On foot, week over week" panel, target and all. |

Two notes on those:

- **The client-side distance layer has been deleted**, not left alongside the
  endpoint: `ON_FOOT_KINDS`, `distanceByWeek` and `distanceReadout` are gone
  from `dataset.js`. Its on-foot list had already drifted from the server's —
  it counted `other` and missed `quickfeet` — which is exactly the failure a
  second implementation produces. The **"Include bike" toggle went with it**,
  because `/api/distance` fixes `on_foot_kinds` server-side. If a bike view is
  wanted back, it needs a parameter on the endpoint rather than a second
  calculation in the browser.
- `guidance` on `/api/distance` arrives with the same double-encoded em-dash as
  `next_action` did (item 0b.1 below) — `â€"` rather than `—`. The front end
  repairs both through one shared helper, but the encoding is still wrong at
  the source.

### Still needed: the activities-per-week *series*

`average` publishes the current value, which is what the Week hero and the
History "Now" tile both read — one number, no reconciliation. The tall chart on
the History page still has to rebuild the 84-week series from `history.counts`,
because only the latest value is published.

It reproduces the server's definition (numerator stops at the end of the last
completed week) and anchors its divisor to `average.weeks`, so the endpoint of
the line equals `average.value` exactly. That anchor is a single integer offset
applied across the whole series, which is right at the end and approximate for
the early weeks, where the notebook's own counter moved differently.

```
GET /api/history → "average_series": [{week_start, value, activities, weeks}]
```

would let `lifetimeAveragePerWeek()` in `dataset.js` be deleted outright. It is
the last place the front end computes a headline figure the server owns.

---

## 0a. Store Garmin's own training load alongside the RPE load — **PARTLY DONE**

`detail.garmin_load` is now on `/api/sessions` and the front end shows it: a
labelled chip on any session row that carries one, and a side-by-side pair in
the Week view's "Why this will not match Garmin" panel. It is never converted,
never summed with AU and never fed into the load model — exactly as asked.

Four of 364 sessions carry it today, so there is not yet enough for the
"Foster vs Garmin" chart described below. **The `/api/summary` and
`/api/trends` parts of this request are still open** and are what that chart
needs:

- `load.garmin_week_total` and `load_by_week[].garmin_total`
- `metric=garmin_load` on `/api/trends`

`garmin_te_aerobic` / `garmin_te_anaerobic` are not needed by any view.

<details><summary>The original request</summary>

**Requested directly: an accurate load metric from Garmin, alongside the RPE
one.**

Right now `load` is only ever Foster session-RPE (`rpe x duration_min`). Garmin
computes its own load per activity — the EPOC-derived number behind
`activityTrainingLoad` / `trainingEffect` on the activity payload — and that
number is already flowing past `garmin/mapping.py` unread.

Requested: capture it per session and expose it, **as a second field, never as
a replacement**.

```sql
ALTER TABLE session ADD COLUMN garmin_load REAL;      -- activityTrainingLoad
ALTER TABLE session ADD COLUMN garmin_te_aerobic REAL;   -- optional
ALTER TABLE session ADD COLUMN garmin_te_anaerobic REAL; -- optional
```

- `session_dict()` gains `garmin_load`, so it lands in `/api/sessions`.
- `/api/summary` gains `load.garmin_week_total` and
  `load_by_week[].garmin_total` beside the existing figures.
- `/api/trends` gains `metric=garmin_load`.

**Please keep the two separate and do not blend them into one score.** They are
not the same measurement and the difference between them *is* the product:
Garmin only sees what the watch recorded, so soccer — 40% of this record's load
all-time, 72% in a heavy week — is largely invisible to it. With both numbers
stored, the app can plot them against each other and *show* the undercount
instead of asserting it, and the ACWR discrepancy the user asked about (the
watch reading 1.6 where this app read 1.36) stops being a mystery and becomes a
chart.

Two details that matter:

- Foster load must stay authoritative for `acwr`, `split` and `by_kind`.
  Garmin's figure is a comparison series, not an input.
- A manually logged session has no Garmin load. Leave it `NULL` rather than
  zero — zero would drag any comparison downward and read as "no effort".

The front end will add a "Foster vs Garmin" panel as soon as the field exists;
until then nothing references it.

</details>

---

## 0b. Two endpoints to trigger and inspect a Garmin sync

**Requested directly: a manual sync from Garmin to pull the latest activities,
prompted by a run that had just been recorded on the watch and was not yet in
the record.**

The engine is already there and looks complete — `ledger/garmin/sync.py` has
`sync_recent`, `sync_range` and `backfill`; `mapping.py` merges rather than
duplicating via `should_merge`/`overlap_fraction`; every call writes a
`sync_log` row; the CLI exposes `ledger sync --days N`; the cron sidecar runs it
nightly. **None of it is reachable over HTTP**, so the PWA cannot pull a run
finished an hour ago — the user has to go and find a terminal.

**Update: these landed while this was being written, and the front end has
been rewired to the shipped contract.** For the record, what `#/sync` now
talks to:

```
GET  /api/sync-status  → {state, healthy, authenticated, running, last_run,
                          last_success, hours_since_success, stale_after_hours,
                          last_error:{at,endpoint,status,detail},
                          next_action, next_scheduled}
GET  /api/sync-log?limit=N → {entries:[{at, endpoint, status, date_range, detail}]}
POST /api/sync?days=N  → {started, days}   409 if running or unauthenticated
```

Three small things:

1. **`next_action` comes back mojibake'd** — the em-dash arrives as
   `\u00e2\u20ac\u201d` (UTF-8 read as latin-1) and renders as `â€"`. The page
   repairs it client-side, but it should be fixed at the source; something in
   that path is encoding twice.
2. `days` is a query parameter, not a body field. Fine — just noting it,
   since the obvious guess from the docstring is a body.
3. Background task plus `_sync_running` as a module global means the flag is
   per-process. With one uvicorn worker that is correct; if a second worker is
   ever added, two syncs can start at once.

The page polls `/api/sync-status` every 1.5s (then every 4s) while `running`
is true, and stops on the transition, which the returned-immediately design
requires.

**The actual blocker is authentication, not the endpoints.** The token
volume `ledger_garth-tokens` is empty, `GARMIN_EMAIL` and `GARMIN_PASSWORD` in
`.env` are still the literal placeholders from `.env.example`, and the nightly
job has been failing all along:

```
2026-08-09T07:00:22+00:00  error  login  token resume failed: Username and password are required
```

Nothing has ever synced. That needs a human to fill in `.env` and run
`docker compose run --rm cli ledger garmin-login` once, interactively, because
it may prompt for MFA. Worth making that failure loud somewhere other than
`sync_log` — a nightly job that fails silently for months is how you end up
with a gap in the record you cannot reconstruct.

---

## 0c. Backfill a logged match's scoreline from the league fixture

**Requested directly**, after the league card showed a result for 17 Aug that
the match itself did not carry: the fixture had been synced with a score, so
the logged match should have carried it too. Two records of the same match, one
scraped and one typed, and nothing joins them.

The soccer page shows both, side by side, disagreeing:

- **Form in this league** (league card) — from `league_fixture`, so it moved
  the moment the tables were refreshed.
- **Form**, **Record**, win rate, every load figure — from `session`, which
  had no result for that date and so skipped the match entirely.

Where it stands today, on the live record:

```
played league fixtures carrying a score      7
logged soccer sessions                      59
sessions dated on a played league fixture    6
  of those, no result logged                 1   (2026-08-17)
  of those, scoreline disagrees with league  2   (2026-08-05 logged 8–4, league 6–4)
                                                (2026-07-22 logged 0–6, league 0–8)
```

**Asked for:** after a league refresh, fill a session's missing scoreline from
the matching fixture. Best run at the end of `leagues.refresh_all()` so it
happens on the nightly scrape *and* on the new Refresh button on `#/soccer`,
which is the moment the user expects it.

Matching rule: same `date`, and the league's `fixture` (`coed` / `mens`) equals
the session's resolved fixture. Pickup has no league page, so it is never a
candidate. `gf` / `ga` are taken from `my_team`'s side of the fixture and
`result` is the arithmetic on them.

Four things that matter more than the feature:

- **Fill nulls only. Never overwrite a typed value.** Those two disagreeing
  rows above are the whole reason. Whatever the truth is there, the user's own
  entry is not something a scraper gets to silently replace.
- **Never touch `goals` / `assists`.** The league site does not know who
  scored. The 17 Aug session already carried `3g0a` while having no scoreline —
  that hand-entered figure must survive untouched.
- **Say where it came from**, e.g. `detail.result_source: "logged" | "league"`.
  The soccer page marks a fixture it inferred with a `*` and explains it in the
  table footnote; a scoreline it did not get from the user deserves the same
  treatment, and the front end will add it as soon as the field exists.
- **Report the conflicts rather than swallowing them.** A count of sessions
  whose typed scoreline disagrees with the league — returned from
  `/api/leagues/refresh` alongside `results`, or written to a log — turns the
  two rows above into something the user can go and settle. Silently leaving
  them is how a record ends up with two answers and no note of it.

Until this exists the two form strips can disagree, and nothing on the page
says which one to believe.

---

## 1. BUG — SQLite connection is shared across threads (causes intermittent 500s)

**This is the highest-priority item and it is reproducible.** Two API requests
in flight at the same time intermittently return `500`:

```
File "/app/ledger/db/queries.py", line 354, in session_events
  for r in conn.execute(
sqlite3.ProgrammingError: SQLite objects created in a thread can only be used
in that same thread. The object was created in thread id 139885058848448 and
this is thread id 139885031491264.
```

FastAPI runs sync path operations in a threadpool, so a connection created once
and shared through the `DB` dependency gets used from whichever worker thread
picks up the request. Sequential curls hide it; anything that fetches two
endpoints in parallel hits it within a few tries.

The front end does fetch in parallel — the Trends view asks for `/api/trends`
and `/api/sessions` together, which is what surfaced this. Reproduce with:

```sh
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code} " "http://127.0.0.1:8000/api/summary?weeks=12" &
  curl -s -o /dev/null -w "%{http_code} " "http://127.0.0.1:8000/api/history" &
done; wait
```

Usual fixes: open the connection per request, use
`check_same_thread=False` **with** a lock, or keep a `threading.local()`
connection. A per-request connection is the simplest and SQLite opens are cheap.

**Mitigation already in the front end:** `api()` in `core.js` retries a failed
`GET` once after 260 ms. That hides most occurrences but it is a plaster, not a
fix — a retry can collide the same way, and it doubles latency when it fires.

---

## 2. Week notes and the week header cannot be read back — **DONE**

Shipped and consumed; kept here for the history of the request. Two small
things noticed while wiring it up:

- `PATCH /api/notes/{id} {position}` sets that row's position and does not
  renumber its siblings, so two rows can share a position and the resulting
  order is down to the tie-break. The front end therefore renumbers the whole
  list on a move — N requests for one reorder. A `PUT
  /api/weeks/{start}/notes/order {ids:[…]}` taking the full order in one call
  would be both cheaper and atomic.
- Every mutation returning the full `notes` array is exactly right — the client
  never has to guess at the new state. Please keep that.

<details><summary>The original request</summary>

`week` has exactly the fields the notebook page had — `start_date`,
`week_number`, `bodyweight_lbs`, `avg_activities_per_week`, `notes` — and they
can be *written* through `POST /api/sessions` with a `week …` shorthand line
plus `allow_empty: true`, which is what the Week view's **Week note** panel
does today. There is no way to read them back.

Requested:

```
GET  /api/weeks?from=&to=   → {weeks: [{start_date, week_number,
                                        bodyweight_lbs, avg_activities_per_week,
                                        notes}]}
GET  /api/weeks/{start_date}
PUT  /api/weeks/{start_date}  body {notes?, bodyweight_lbs?, week_number?}
```

Or, cheapest possible version: add the current week's row to `/api/summary`:

```json
"week": { "start": …, "end": …, "notes": …, "bodyweight_lbs": …, "week_number": … }
```

Until one of those exists, the Week view mirrors what *this browser* wrote into
`localStorage` so the field is not blank after a save, and says so in the panel.
That is a bad user experience on a second device and should not survive.

The user explicitly asked for **notes per week and per activity** to be
preserved. Per-activity notes are fine (`session.notes`, editable via `PATCH`).
Per-week notes are write-only today.

</details>

---

## 3. `GET /api/sessions/{id}`

Editing is deep-linked at `#/edit/{id}`. On a cold load with no in-memory cache
the front end currently has to fetch `/api/sessions?limit=500` and scan for the
id, because there is no way to ask for one session by id. A one-liner:

```
GET /api/sessions/{id} → session   (404 if absent)
```

---

## 4. A plan table, if planning is meant to persist — **DONE**

> **Update 3 — all of it persists.** Migration 017 added `plan_intent`,
> `plan_days` and `setting`, with `GET/PUT/DELETE /api/plan/intent/{monday}`,
> `GET/PUT/DELETE /api/plan/days/{monday}` and `GET/PUT/DELETE /api/plan/goal`.
> The shapes are the ones requested below. The front end reads all three into
> one snapshot (`dataset.js::loadPlanState`) and, on the first load after the
> move, pushes whatever was still in localStorage up for weeks the server
> does not have, then clears the local keys. The two "in the meantime" items
> under the day split (median match distance, fixture dates) still stand.
>
> **Update 2 — the distance plan now persists.** `plan_week` and three
> endpoints landed, and `#/plan` has a **Committed plan** panel under the
> projection:
>
> ```
> GET    /api/plan/locked            → {weeks:[{week_start, week_end, target_km,
>                                              is_deload, actual_km, delta_km,
>                                              state, locked_at}],
>                                       locked_at, base_km, pct, timeframe, summary}
> POST   /api/plan/lock?pct=&weeks=&deload_every=&base_km=&week_of=
> DELETE /api/plan/lock?from_week=
> ```
>
> Three things about it worth keeping:
> - **Locking never rewrites the past.** `POST` replaces the current week
>   forward only, so a target set and then missed stays on the record. That is
>   the entire reason to store it.
> - **`delta_km` is null until a week has finished.** A week two days in is not
>   behind, and the front end prints `—` rather than a shortfall.
> - **`timeframe` is `forecast: true`**, so the window is allowed to run into
>   the future while every retrospective window is clamped to today.
>
> The hand-written **week intent** below it (planned counts per modality) is
> unchanged. It is now joined by the **day split** — see below — and those two
> are the only things on the page in `localStorage`. The request below stands
> for both.


The user asked for a planning page. `#/plan` exists and stores plans in
`localStorage`, because there is nowhere to put them. The shape it uses:

```
{ "2026-08-10": { "kinds": {"run": 3, "soccer": 2}, "note": "two games" } }
```

If that should live on the server:

```
GET  /api/plan?from=&to=            → {plans: [{week_start, kinds, note}]}
PUT  /api/plan/{week_start}         body {kinds, note}
DELETE /api/plan/{week_start}
```

### The day split, `ledger.plan.days`

"The week, day by day" divides a week's committed distance over its seven days,
so the question "how far today" has an answer. It stores:

```
{ "2026-09-07": { "km": {"2026-09-08": 5.0, "2026-09-09": 5.0},
                  "match": ["2026-09-09"] } }
```

`km` is the planned distance per day; `match` is the days the user says they
are playing on. The league schedule supplies the rest — a day with a published
fixture is a match day without being listed here — and a match day is held at
the median distance of recent matches so the running days divide what is left.

Same request as above, and for the same reason: it is a plan, it belongs beside
the committed one on the server, and a phone and a laptop currently disagree
about it.

```
GET  /api/plan/days?from=&to=       → {weeks: [{week_start, km, match}]}
PUT  /api/plan/days/{week_start}    body {km, match}
DELETE /api/plan/days/{week_start}
```

Two things the front end has to do for itself in the meantime, either of which
would be better answered by the server:

- **The typical cost of a match.** Taken here as the median `distance_km` of
  the last 60 soccer sessions, fetched only to compute one number. A field on
  `/api/summary` — median on-foot distance per kind — would replace the whole
  request.
- **Which days have fixtures.** `/api/leagues` is fetched in full to read
  `my_fixtures`, which is a large payload for a list of dates. Anything that
  answers "what is scheduled between these two dates" would do.

**Please do not wire a plan into `/api/summary`'s `consistency` block.** The
user's stated decision: there is no done-versus-planned distinction — a session
is simply done. The Week view now shows counts only. `consistency` currently returns
`{kind: [done, planned]}` with a `planned` that comes from config, not from
anything the user set; the front end ignores the second element. If that field
is going away, `sessions_28d` and `sessions_this_week` already carry everything
the view needs.

---

## 5. Expose the two numbers behind ACWR — **DONE**

`acute_au` and `chronic_au` are on `/api/summary` and the panel now prints the
division under the ratio. Original request kept below.

<details><summary>The original request</summary>

`core/load.py` already computes `ACWR.acute` and `ACWR.chronic` (mean daily
load over the trailing 7 and 28 days). `/api/summary` publishes only the ratio
and the band.

The user asked why the app shows a different figure from the one on their
watch. It is not a bug — Garmin's ratio is heart-rate-derived and only covers
sessions the watch recorded, while this one is Foster session-RPE over
everything logged — but the panel can only *assert* that today. Returning the
inputs would let it show the arithmetic:

```json
"load": { …, "acwr": 1.36, "acute_au": 250.0, "chronic_au": 183.8, "band": "elevated" }
```

Then the Week view can print `250 AU/day over 7 days ÷ 184 AU/day over 28`,
which answers the question without anyone having to trust a sentence.

</details>

---

## 6. A `team` field on soccer sessions

The configured fixtures are three — **Monday coed, Tuesday pickup
(competitive), Thursday men's league (competitive too; recreational and on
Wednesdays until the Fall 2026 move to the DaySmart venue)** — plus occasional one-offs. Nothing in the schema records which is which.

The front end resolves it in this order, and shows which games were inferred:

1. `detail.team` if set (`coed` | `pickup` | `mens` | `other`)
2. a keyword in `notes` — `pickup`, `coed`, `men's`, `practice`
3. the weekday
4. `other`

That reproduces the real split exactly on the current 57 matches, and every
aggregate it produces reconciles with `/api/soccer` to the unit (18W 31L 4D,
85 goals, 39 assists, 319 GF, 374 GA). The edit form writes `detail.team`
through `PATCH`, so overrides already persist.

Two things would make it first-class:

- **A `team` token in the shorthand**, e.g. `team=pickup` or `+pickup`, so the
  text path can set it at creation. Today a new match is created by `POST`
  and then immediately `PATCH`ed to attach the fixture, which is two writes
  for one entry and can half-fail.
- **`team` echoed in `/api/soccer`'s `games[]`**, so per-fixture aggregates
  can come from the server rather than being derived. The soccer view
  currently pulls `/api/sessions?kind=soccer` purely to see `detail.team`.

If a `team` column ever lands, please keep the weekday fallback — 84 weeks of
imported notebook rows will never have it.

---

## 7. Injuries / availability

There is nowhere to record a limitation that affects what can be trained. The
Lifting page has a "Working around" note that lives in
`localStorage`, which is the wrong place for it.

Something as small as this would do:

```
GET  /api/notes?scope=lifting        → {notes: [{scope, text, from, to}]}
PUT  /api/notes/{scope}              body {text, from?, to?}
```

Related: the Lifting page reports scope ("work lift", "small home lift") and
rep series parsed out of `notes`, because that is genuinely all the notebook
contains. `9` of `67` sessions carry a rep series and none anywhere carries a
weight, so `e1rm` stays empty and the page says so outright rather than
inventing a strength metric. No change needed — just confirming that is
deliberate.

---

## 8. Smaller things

- **`/api/summary` week-count field.** `headline` has `week_count` (activities
  in the selected week) — the name reads like "number of weeks". A separate
  `weeks_logged` would let the Week view state the record's length without
  fetching `/api/history`.
- **Bodyweight entry.** There is no endpoint that writes a weigh-in directly;
  the only path is the `week … 200lb` shorthand. `POST /api/bodyweight
  {date, kg|lbs}` would let the entry form take it as a normal field. Note the
  user thinks in **pounds** and Garmin reports **kilograms** — the API should
  keep sending kg and let the client convert, which is what it does now.
- **`avg_history` is capped at 26 weeks** whatever `weeks` is passed. The
  boxed-number chart wants the whole record, so the All-time view rebuilds the
  series from `/api/history`'s daily `counts` (cumulative ÷ weeks elapsed) and
  checks its last value against `headline.avg_per_week` — they agree to the
  cent. Returning the full series, or accepting a `history_weeks` parameter,
  would remove that derivation.
- **`/api/soccer` `duration_min`/`rpe`** are already returned per match and are
  used. Thank you.
- **Zero-filled trend periods** are correct and load-bearing for the charts —
  please keep them.
- **`/api/plan/distance` defaults its base to the week containing today**, so
  on a Monday `base_km` is 0 and the whole projection is zeroes with an honest
  `note`. The planner renders that note rather than a flat plan, and defaults
  its own "build from" control to the last complete week (via `week_of`) so the
  page is usable on a Monday. A `base: "last_complete_week"` default, or a flag
  saying the base week is still in progress, would let the client stop making
  that choice.
- **`/api/plan/distance` history is always 8 weeks** whatever `weeks` is. That
  is the right length for the chart, so this is a note rather than a request —
  but it is worth a docstring line, because "weeks" reads like it governs both
  halves of the payload.
- **`next_week.from_4w_mean` disappeared** from `/api/distance` between two
  reads of the same endpoint, and `from_base` + `labels` + `target_week`
  appeared. Both are improvements — the target is built on the last *complete*
  week now, which was the bug — but the running panel rendered
  "this week's 29.2 km" about last week's figure for as long as the old key
  survived as an alias. If `from_this_week` is meant to be deprecated, please
  drop it rather than aliasing it; an alias that means something else is worse
  than a missing key, which fails loudly.
- **`detail` on `PATCH /api/sessions/{id}` replaces the whole blob.** That is
  what the edit form assumes (it rebuilds `detail` from the form). Worth a
  docstring line so nobody makes it a merge later.
