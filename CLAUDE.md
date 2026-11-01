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

**When a data field changes, `docs/DATA-MAP.md` says what else depends on it.**
Fixing one surface and leaving four wrong is this project's most repeated
failure — zones, soccer distance, bodyweight, the load scale. Find the field,
treat every surface under it as suspect, check each against the API. Add new
panels to the map; `scripts/inventory.py --check` fails when one is missing, so
the index cannot rot quietly.

**`agents/data-auditor` walks the whole site and verifies figures against the
API.** Run it after any change to a field, a Garmin mapping rule, an aggregate,
or a sync. It reports only defects it has proven, with both values side by side.

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
