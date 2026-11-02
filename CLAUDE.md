# Ledger

## Response style

**TL;DR always. Short and concise.**

- Lead with the answer or the result. No preamble.
- Bullets over paragraphs. Tables over bullets where they fit.
- Report what changed and what broke. Skip the narration of how.
- Flag caveats in one line, not a section.
- No recaps of code already written. No restating the request.

Detail only when asked for it, or when a caveat genuinely risks data loss or a
wrong decision.

## Project

Single-user self-hosted training tracker. Soccer, running, biking, lifting,
rucking, fasting on one load scale (Foster session-RPE: `load = rpe × minutes`).

- Frontend: `ledger/web/` — vanilla HTML/CSS/ES modules, no build step, no npm,
  no external network requests. See `ledger/web/README.md`.
- Backend asks go in `ledger/web/NOTES-FOR-BACKEND.md`, not into Python.
- Philosophy: no streaks, rolling windows only, no hype copy, ACWR is a
  heuristic and never a verdict.

## This is a public repository — nothing personal, nothing secret

The repo is public open source. Every tracked file, every commit message and
every screenshot is on the internet. The one person it was built for is not
in it, and must not get back in. Before any commit:

- **No real training data.** No sessions, scorelines, weights, paces, sleep
  or heart figures from a real record — not in docs, tests, comments,
  fixtures or images. Screenshots come from `scripts/demo_data.py`, never
  from a live database.
- **No identity.** No names, handles, emails, team names, opponents, venues,
  towns, league ids, device ids or local paths. Fixtures and docs use the
  invented set: Sparrows FC / Sparrows United / Night Owls / Harbour Lights,
  "the ezleagues venue", "the DaySmart venue", "Riverside". Anything per
  person or per venue is configuration in `.env` with a placeholder default
  in `.env.example`, never a constant in code.
- **No health details and no quotes.** No injuries, conditions, fasting
  lengths, bodyweight readings, or remarks attributed to the user. Write
  "the user", describe decisions, do not quote them.
- **No secrets.** `.env`, tokens, databases, backups and `notebook/` are
  gitignored; keep them that way and never paste their contents anywhere.
- **History counts.** Git history is public too, and GitHub serves dropped
  commits by hash until it collects them. If something personal lands in a
  commit, say so immediately — the fix is a history rewrite and a repo
  recreate, not a follow-up commit.

Before pushing, sweep: `git ls-files | xargs grep -n -i "<the terms above>"`
and `git status` for anything untracked that should be ignored.

## Verify before reporting — not optional

Every change is checked before it is called done. Not "it should work", not
"the code looks right": run it and look at the result. This rule exists because
a run of defects shipped that a thirty-second check would have caught — two
adjacent "down week" tags on rising numbers, `still aheaddown week` with no
space in it, a score reading 88 on one page and 89 on another, and a tile
saying 375 beside a note dividing by 339.

**The floor for any change:**

1. `.venv/Scripts/python.exe scripts/qa.py` — and know what it does *not* cover.
   It is a **rendering** audit: overflow, clipped text, dead panels, stuck
   skeletons, contrast, tap targets, timeframe labels, `undefined`/`NaN` leaks,
   and two semantic rules (a label contradicting its number, words run together
   across elements). It cannot tell whether a figure is *correct*.
   **"QA: no findings" means it renders cleanly, never that it is right.**
2. Drive the actual page in Playwright and read the values back — the numbers,
   the classes, the computed styles. Assertions on the DOM, not on intent.
3. **Look at a screenshot** of anything visual. Alignment, spacing and colour
   are not verifiable from a diff.
4. Touched Python? `.venv/Scripts/python.exe -m pytest`.
5. Touched `ledger/web/`? `.venv/Scripts/python.exe scripts/conventions.py --check`
   (remembered controls, service-worker shell, qa routes, data map), then the
   `agents/ui-critic` agent on the working copy, then the roll-out below.

## Front-end conventions — the floor for any view, new or changed

**How it should look is in `docs/DESIGN.md` — read it before building or
restyling anything.** Understood at first look, one lead figure styled apart,
colour that does the first reading and is always keyed, never plain. A view
that follows every rule below and ignores that file has shipped plain, and
plain has been rejected every time.

These are what the rest of the app already does. Read `ledger/web/ui.js` end
to end and two sibling `view-*.js` files before building; the user notices
every one that is missed.

- **Develop off the live mount.** `./ledger/web` is bind-mounted into the
  running container: a save is on the phone. Work in a copy served on port
  8001 against `data/demo.db`, look at it, then copy over and bump `sw.js`
  VERSION and `app.js` BUILD.
- **Look at it as a stranger, on a phone, in both themes**, before it goes
  live — and at a laptop width (1280) too: anything that widens the top bar
  or a row has to fit there, not only at 1440. Every number, mark and colour must say what it is and which way is
  good without the source code. Screenshots, not diffs.
- **A chosen window is remembered** across visits (`rememberedChoice` /
  `rememberChoice`, or the Sports pair). The URL still wins. A position in
  time (the week, the day) is not remembered.
- **Day names are at least three letters** — Mon, Tue … Sun — never two.
- **No bare numbers.** A figure carries its unit and an icon or a word that
  says what it is; a colour is explained by a key on the same screen.
- **Verify a colour by its computed value and the screenshot, never by its
  class name.** A cell classed green rendered grey for a release because a
  later rule reset `--tone`; `qa.py` now flags any `tone-*` element whose
  `--tone` does not resolve to that tone.
- **Spaces between adjacent text nodes**, so `textContent` never runs words
  together (the audit checks this).
- The usual: timeframe line under the title (`setTimeframe`, verbatim from
  the server), deep links through the hash, a Table toggle on every figure,
  tap targets ≥ 40 px, nothing computed in the browser that the API already
  publishes, every panel title in `docs/DATA-MAP.md`.

**When a data field changes, `docs/DATA-MAP.md` says what else depends on it.**
Fixing one surface and leaving four wrong is this project's most repeated
failure — zones, soccer distance, bodyweight, the load scale. Find the field,
treat every surface under it as suspect, check each against the API. Add new
panels to the map; `scripts/inventory.py --check` fails when one is missing, so
the index cannot rot quietly.

**`agents/data-auditor` walks the whole site and verifies figures against the
API.** Run it after any change to a field, a Garmin mapping rule, an aggregate,
or a sync. It reports only defects it has proven, with both values side by side.

**`agents/mcp-keeper` keeps `ledger/mcp/` in step with the API.** Run it after
any endpoint, response shape or field changes. Every GET route has a tool
(`tests/test_mcp_server.py::test_every_get_endpoint_has_a_tool` fails when one
is missing), every tool returns what the API returns, and the descriptions and
server instructions still tell the truth. It fixes drift and reports proof.

**Checks that have caught real bugs, and are worth repeating:**

- Print every row of a table rather than eyeballing it. The second adjacent
  down week only appeared once every row was listed with its flag.
- Show the same figure on both pages that display it, side by side, and compare.
- When a ratio is added, print its denominator next to any total already on the
  same screen. Two figures for one quantity is this codebase's oldest failure.
- After writing a new audit rule, **re-inject the bug and confirm the rule
  fires**, then confirm it stays quiet otherwise. Two rules written here failed
  silently on their first attempt — one matched nothing, one matched 736 false
  positives.

State plainly what was verified and what was not. An unverified change is
reported as unverified.

### The Scoreboard is the one exception, and it was asked for

`#/score` grades. It was requested directly, as a way to see at a glance
whether a week went well, and building it overruled two rules that used to
sit in this list. Both are recorded here so nobody treats the page as
a defect and quietly reverts it:

- **"Bodyweight is plotted and never scored" is superseded**, narrowly. The
  bodyweight pillar scores *movement of the four-week average toward a goal*,
  never the number itself. The original rule was protecting against a heavy
  week reading as a failure; scoring direction rather than level keeps that
  protection, and stops scoring you at all once you arrive.
- **"There is no such thing as done versus planned — it is just done" is
  superseded** by the plan-adherence pillar, again by direct request. Counts
  are set on the Plan page and carry forward; two of two is perfect and three
  of two is still perfect, because the plan was two.

### Recovery reads figures on published scales, and that is the second exception

`#/recovery` tints numbers and columns — green, amber, red — and it was asked
for: a good night should read as a good night at a glance. The rule that
keeps it from being a verdict machine: **a tone there is always a reading on
a scale somebody else published or the wearer's own history, never a
threshold this app chose.** Readiness, sleep score, stress and body battery
use Garmin's named bands. HRV uses the balanced range Garmin fits to the
wearer, stored per night. Sleep uses Garmin's per-night sleep need. Resting
HR uses the wearer's own 28-night mean. The scale is printed beside every
tinted figure. Load, ACWR and anything the app computes itself stay untinted
everywhere, including on that page.

### Calories reads against the user's own target, and that is the third exception

`#/calories` and the Calories widget on `#/week` tint by **standing**: where
a day's deficit sits against the daily target (500 kcal unless set). It was
asked for directly — the page has to be read at arm's length without reading
— after a first version shipped untinted. The rules that keep it honest:

- The standing is computed once, server-side (`report/calories.py::standing_of`),
  in five words — met, close, short, over, far_over — and drawn in **three
  colours everybody already knows**: green for a deficit at or past the
  target, amber for a smaller deficit, red for a day that ate more than it
  burned. A key on the same screen names the target in kcal.
- Today is tinted on its projection and is labelled as one — "so far" in its
  cell, "burn (est)" under the bar — because it is not over.
- Bodyweight on that page is green or red only for direction *toward or away
  from the goal weight*, and untinted while no goal is set.
- The target is the user's own number, printed on the page beside the
  figures. Nothing else on the page carries a hue it has not earned; meal
  hues mean *which meal*, never how big.

What did **not** change, and must not:

- **No streaks.** The week score moves freely up and down. The level is built
  only from lifetime totals that cannot fall, so a bad week earns fewer points
  and removes none. Nothing resets and there is nothing to protect.
- **Colour as verdict is still confined to that page**, plus the published-scale
  readings on `#/recovery` described above. The five-step tone ramp is a
  scoreboard device. ACWR keeps its own rule: a position, never an alarm.
- **The arithmetic is always shown.** Every pillar prints the division behind
  it, and a pillar with no data is absent — with its weight redistributed —
  rather than scored zero.
