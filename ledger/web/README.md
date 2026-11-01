# Ledger — front end

Vanilla HTML, CSS and ES modules. No framework, no build step, no bundler, no
npm, no network requests to anywhere but this origin. It has to still run in
five years with nobody maintaining it, so the only dependency is the browser.

```
index.html      shell: sprite, top bar, tab bar, FAB, tooltip, toast
styles.css      tokens, reset, type, shell, generic controls
views.css       view-specific styles, figures, entry form
app.js          router, theme, units, keyboard, service-worker registration
core.js         DOM factory, formatters, palette, units, fetch layer, tooltip
ui.js           panels, stat tiles, session rows, read-outs, filters, sub-tabs
charts.js       hand-rolled SVG: columns, lines, split bars, day grid
dataset.js      cached fetches and the derived layer (teams, rhythm, rolling)
insights.js     the findings engine — 26 rules over the record
score.js        the week score and the level — pure functions, no DOM
habits.js       habit marks, words and hues — decides no day's state
recovery.js     the nightly numbers — bands, ranges, findings; pure, no DOM
recovery-cards.js  one card per measure, shared by #/recovery and #/week
view-*.js       one module per view
sw.js           offline shell, network-first
```

---

## Information architecture

Nine destinations. Two of them hold peer pages behind one tab row, so the top
level grows only when a page answers a genuinely new question rather than every
time a modality does. No modal dialogs anywhere.

| Route | View | Answers |
|---|---|---|
| `#/week` `#/week/YYYY-MM-DD` | **Week** | What happened this week, and how it sits against its own recent history |
| `#/habits` | **Habits** | Did the small things happen — today, and across the week |
| `#/plan` | **Plan** | How far to go next week, and the seven after it |
| `#/insights` | **Insights** | Everything the record will say about itself |
| `#/soccer` | **Sports → Soccer** | Record and goal involvement, split by fixture |
| `#/running` | **Sports → Running** | Distance, pace, spread, compliance, zones |
| `#/lifting` | **Sports → Lifting** | Scope, frequency, the layoff, what is actually recorded |
| `#/all` | **History → All time** | Activities per week, bodyweight, fasting, year rows, every day |
| `#/trends` | **History → Explore** | Any metric × grain × modality × range |
| `#/log` | **Log** | Find one session out of 363, then edit it |
| `#/sync` | **Sync** | Garmin state, a pull button, and the log — reached from ⟳ in the top bar |
| `#/add` `#/edit/{id}` | **Entry** | Get something into the record, fast |

Every view deep-links through the hash, including its filters
(`#/trends?metric=distance&grain=month&kind=run&range=all`,
`#/log?q=pickup&kind=soccer`), so back, forward, reload and bookmarking all do
the obvious thing. Filter changes use `replaceState` so a session of fiddling
with controls does not bury the previous *view* in history.

**Navigation.** Desktop: tabs in the top bar plus a filled *Add* button.
Phone: the bottom tab bar wraps its cells onto a second row rather than
scrolling or hiding any of them, and *Add* is a floating button above it at the
bottom-right — the easiest place a thumb reaches. Entry is a route, not an
overlay, so the tab bar and the floating button get out of the way while you
are typing.

---

## Design decisions, and why

**The record is the hero, not the achievement.** The largest thing on screen is
the lifetime average activities-per-week — the boxed number the paper notebook
carried on every page. It dips on a bad week and recovers. Nothing on any
screen resets to zero, because there are no streaks anywhere in the product.

**Two themes, both designed.** Light is warm paper (`#f9f9f7` page, `#fcfcfb`
surface, near-black ink); dark is warm charcoal (`#111110` / `#1a1a19`, with
`#c3c2b7` as secondary ink rather than a gray). The series hues are *re-picked*
per theme from the validated palette, not the same values dimmed. The toggle
persists in `localStorage`, is applied inline before first paint so there is no
flash, and updates `<meta name="theme-color">`.

**The Sports range is one choice, remembered.** Soccer, Running and Lifting
share the range picked in their filter bar (`ledger.sportsRange` in
`localStorage`, via `sportsRange()` / `rememberSportsRange()` in `ui.js`):
12 weeks on one is 12 weeks on the others and on the next visit, instead of
each page snapping back to its own default. A `range=` in the URL still wins,
so a shared link lands where it points.

**Colour is fixed to modality, never to rank.** Soccer is blue on every screen
whether or not anything else is present, so filtering a series out never
repaints the survivors. Both palettes were run through the validator: dark
passes all six checks; light passes five and warns that bike, lift and other
fall under 3:1 against the surface. That warning is why **every figure ships a
Table toggle and selective direct labels** — the relief is mandatory, not a
nicety.

**Charts are hand-rolled SVG at device scale.** The viewBox is in CSS pixels
and each figure redraws on resize rather than stretching, so a "24px bar" is
actually 24px. Mark spec throughout: a 4px rounded data-end square at the
baseline, a 2px surface *gap* between stacked segments (cut out of the geometry
— never a stroke drawn around a mark), 2px lines, markers ringed in the surface
colour, hairline solid gridlines, and direct labels only on the extreme and the
endpoint. Never a dual axis. Sequential scales (the day grid) are one hue
light→dark.

**The bar cap breathes with the slot.** A flat 24px cap is right for 52 weeks of
load and wrong for thirteen months of goals: a 24px mark in a 95px slot reads as
a tick on an empty panel, which is precisely how the monthly soccer figures were
landing. The cap is now `min(44, max(24, slot × 0.62))`, so it only ever grows
and only where there is room — dense charts are untouched.

**Stacking is for parts of a whole.** Goals and assists stack, because their sum
is involvements; wins, draws and losses stack, because their sum is matches
played. Goals for and goals against do **not** — their sum is a number nobody
wants — so that figure is grouped, and a grouped figure prints no total in its
tooltip and carries no Total column in its table.

**Columns grow from the baseline once.** The entry animation runs on first paint
and not on a redraw, because a redraw is a resize: re-running it meant every
chart on the page went momentarily empty whenever the window changed width,
which reads as missing data rather than as motion.

**Every figure is interactive and every figure is readable without the
interaction.** Columns give one tooltip per column listing all series, and the
hit target is the whole column slot rather than a 3px bar. Lines carry a
crosshair that also steps with the arrow keys and announces into a live region.
Wide charts scroll inside their own card; the page body never scrolls sideways.

**A number that would mislead does not get printed.** Percentages off a
near-zero baseline ("up 3213%") are replaced by the two absolute numbers, a
zero week is stated as a zero week rather than "down 100%", and the derived
layer never re-computes a figure the API already publishes — one authoritative
average per screen or none.

**ACWR is a position on a scale, not an alarm.** The typical 0.8–1.3 band is
shaded, the marker is ink, and the caption says outright that it is a heuristic
for how fast the ramp is, not a verdict on it. No status colour anywhere near
it.

**The two long-horizon numbers get flagship treatment.** *Activities per week*
and *bodyweight* are the two things tracked continuously since 2025, so both
open the All-time view with a tall primary chart, extremes and endpoint
labelled, and their raw input aligned directly beneath on a forced-identical
x origin — a small multiple, never a second y-axis.

- *Activities per week* is the notebook's boxed number. The current value comes
  from the server; the 84-week line is rebuilt from the daily counts because
  only that one value is published, and it is anchored to the server's own
  divisor so the endpoint of the line *is* the figure in the tile. Beneath it:
  the weekly counts it smooths.
- *Bodyweight* is the 7-day EMA with the raw weigh-ins as recessive dots,
  4/12/52-week deltas, and a lb ⇄ kg switch. Beneath it, on the same months,
  fasting hours — because the two are related, and small multiples are the
  honest way to say so.

**Bodyweight is one line and no commentary.** No goal weight, no direction
colouring, no delta framed as good or bad. The line is graphite rather than a
series hue, precisely because it is not part of the load system.

**Pounds by default, kilograms one tap away.** The notebook was written in lb
and the user thinks in lb; the database and Garmin are in kg. Everything is
stored and sent in kg and displayed in whichever unit is set — a switch in the
top bar, `u` on the keyboard, remembered, and the other unit always shown
alongside the headline figure.

**Soccer knows about fixtures.** The configured fixtures are Monday coed,
Tuesday pickup and Thursday men's league (Wednesday until the Fall 2026 move to
the DaySmart venue — the rule is dated, `MENS_ON_THURSDAY_FROM` in
`dataset.js`), and an escape hatch for the one-off game or the Monday that was
really pickup. The fixture resolves from an explicit `detail.team`, then a
keyword in the note, then the weekday — and the match table marks every one that was
inferred rather than stated. Per-fixture aggregates reconcile to the unit with
`/api/soccer`; the whole page filters by fixture, and goals and assists are
reported per match, not just as totals.

**"AI insights" is a local analysis engine, and the page says so.** Twenty-six
rules run on the device against the session log — no model, no network, nothing
to expire, and every number is arithmetic you can redo by hand. Three rules
hold: nothing is reported below its minimum sample size, every card prints its
denominator, and nothing claims causation. Where two things move in the same
window the card says exactly that and stops.

**Findings are not all the same size.** Twenty-five cards in six identical
stacks is a wall — nothing is the answer, so the page has to be read whole or
not at all. Each section now leads with one finding given room, and the rest sit
in two columns beneath it. The lead is *promoted, not chosen*: the rules already
sort by effect size inside a section, so it is the top of an order that already
existed. There is deliberately **no cross-section "top 3"** — a layoff measured
in days and a share of load are not comparable, and ranking them against each
other would be an invented ordering. An index of the six sections and their
counts sits above the fold instead.

**Am I getting faster is a question too, and it is asked per distance.** The
Running page's "Pace by distance" panel takes six key distances — 3, 5, 8 and
10 km, the half and the marathon; no mile, by the user's rule — and plots
every whole run that counts for one at the pace it was recorded, with the
figure printed on every point and the best run wearing a gold star — the one
mark in the app allowed to look pleased with itself, matched by a medal on the
Best pane. Above the chart the best leads in gold and the latest sits beside
it with both comparisons under its figure; below it one table sets all six
distances side by side. A grid of cards was tried in the table's place and
reverted at the user's request. Nothing is smoothed: a rolling mean was drawn
through the points once and taken out by the user's rule that the recorded
figure is the number and nothing derived from it is. The figure is violet
rather than run-orange, because on a page that is orange from the kicker down
an orange line is wallpaper. A run counts when it is within 0.15 km of the
distance, by the user's rule (5.03 is a 5 km), widening to 1.5% only above
10 km where a watch reads a race course long. The margin is absolute on purpose:
a 9.7 km interval session is not a 10 km. Progress is read from recorded runs
alone: the latest against the best, and the latest against the run before it.
A first-three-against-last-three average was tried and removed as not useful.
A distance with no run yet says so and
names the longest run instead, because the marathon row exists for the day it
stops being empty. Whole runs only: the record carries no splits, so a 5 km is
never the quickest five inside a ten.

**How far next week is a question, so it gets an answer.** The Running page's
on-foot panel leads with the target: the last **complete** week's distance plus
about ten per cent — 32.1 km from a 29.2 km base. It is one figure now rather
than two, and both ends of it are named from `next_week.labels` rather than
assumed, because the panel spent a while saying "this week's 29.2 km" about a
number that was last week's. A base week with no distance has no target and no
percentage change: `—`, and the server's sentence saying why, rather than a
0.0 km target or an infinity. Every figure on the panel — weekly totals, the
change, the four-week mean, the ratio and the ramp — comes from
`GET /api/distance`. The page derives none of it, because that number had
already been computed in two places and disagreed.

**The four figures are one bar, and the tiles are its legend.** Committed, Done,
Still to run and Still to plan are nested quantities, and as four plain numerals
in a row they read as four unrelated facts — which is exactly how they were
read. They are drawn now:

    row 1   the whole target       [ done │ still to run ]
    row 2   inside what is left    [ planned │ no day yet ]

Row 2 begins where row 1's second segment begins, so *"of the 18.0 left, 10.9
has a day and 7.1 does not"* is visible rather than inferred. Each segment is
the colour of the tile it belongs to and each tile carries that colour as a
short rule above its label — `--pb-done`, `--pb-left`, `--pb-planned` and
`--pb-open` are defined once, in `styles.css`, precisely so a tile's rule cannot
drift from its segment. Strength is certainty: what happened is solid, what is
planned is held back, what has no day yet carries no hue at all. The figures
themselves stay ink, because a coloured numeral at that size shouts and is
harder to read — the same reason `.pillar-score` uses a dot.

**A bar per day was tried first and removed.** Each cell carried one scaled to
the biggest day of the week, which is a denominator nobody has a question
about: knowing Monday was 55% of Sunday tells you nothing you wanted to know.
The week has one proportion worth drawing and it is the committed target.

**A day cell is a figure, not a line of text.** The distance was set in
`--t-lg` in the body font, which made a logged 6.0 km read as a caption. It is a
figure now, in the display face, with its unit stacked under it. The planning
input is a *field* — a box with a background — after a dashed rule under the
number was tried and read as a stray dotted line nobody could name.

**The tint had to be strong enough to see.** The first pass carried the hue at
6% and on a single edge, which on either theme is indistinguishable from the
card behind it — the panel stayed grey and the colour did no work at all. A run
day is now washed at 13% with a matching border; a planned day is washed at 5%
with a *dashed* one, because a plan is not a fact.

**The day cells take the modality palette.** Hue is what it is everywhere else
in this app — a match day is soccer blue, every other day is running orange —
and *fill* carries the state. A planned Sunday and a run Monday are the same
colour because they are the same kind of thing; what differs is whether it
happened. A day that is open or gone gets no hue at all: an empty Thursday is
not a running day until something is on it.

**Today is marked in ink, not in the accent.** The accent is blue, blue means
soccer, and a blue ring around a Saturday that was *run* reads as a match at a
glance. Today gets the NOW tag and a brighter surface — neither of which can be
mistaken for a sport.

**Planned, done, and still to run are three different numbers.** The day-by-day
panel had two tiles for three quantities and the middle one — "Placed" — meant
*done plus planned*, which is not a thing anybody needs. So it read
"Still to place 3.4 km" beside a week that still owed 18.0 km, and the user
read the small number as the distance left to run. It is one chain now, and
every tile is one step of it:

    Committed        42.7    the number you locked
      − Done         24.8    what is on the record
      = Still to run 18.0    what the week still owes
          − Planned  10.9    already written onto a day
          = To plan   7.1    still has no day

**Planned** counts only days that can still take a run. A day already run is
Done, not planned; a day that has gone by without one contributes nothing at
all — its cell shows a dash, and it used to be silently counted at whatever had
been *intended* for it, which is how seven cells visibly summing to 35.7 km
were reported as 51.6. A planning cell now says "km planned" under it, the way
a finished day says "km run", because next to each other a bare number box and
a logged distance looked like the same kind of figure.

**A locked plan replaces the ramp outright.** Those are two different questions
and the panel used to answer only the second under the first one's name.
`/api/distance` recomputes a +10% suggestion every week from what was
*actually* run; `/api/plan/locked` holds what was committed and never rewrites
itself. Miss a week and they separate immediately — a week locked at 35.3 km
sat under a panel headed "Target for this week: 25.0 km", because the previous
week came up 9.4 km short and dragged the ramp down with it. So when a locked
week covers the target week, the committed figure **is** the target and the
ramp is not shown at all. Printing them side by side was tried first and was
worse: it gave one week two targets and made the smaller, rolling one look like
a revision of the plan. The ramp is a suggestion for what to *set* when nothing
has been set, so it appears only when nothing is locked for that week — empty
`weeks`, a plan that starts later, or no endpoint at all — and then it leads
alone, exactly as before.

**What is left is the number you act on, so it sits beside the target.** A
committed 35.3 km and a running total of 16.5 km is two figures and a
subtraction; on a Wednesday the question is "how much is left and over how many
days", which neither one answers. So the pane beside the target reads
`18.8 km` — `35.3 committed − 16.5 done`, `over 5 days, through Aug 23`,
`3.8 km a day` — and then offers the even splits, `9.4 × 2, 6.3 × 3, 4.7 × 4`,
because the actual question behind it is how to break the rest of the week up.
The splits are options, not a prescription, and one is dropped once it falls
under 3 km or asks for more runs than there are days left. Covered weeks read
`0 km` and say so; a week run past its target says by how much rather than
showing a negative. It is shown only for the week in progress — a future
committed week has all of itself left, which is just the target again.

Note the scope, which the panel states above it: these are **on-foot**
kilometres, matches included. A week with a game still in it has less running
left than the figure suggests.

**The planner is one slider and one line.** `#/plan` answers the question the
user actually asks — how much further they can go, week by week, without doing
too much — by dragging a weekly increase from 0 to 25% and watching eight real
weeks continue into a projection. One continuous line: solid for what happened,
dashed and lighter for what is only planned, with a named break at the week the
record stops. A planned down week is drawn as a hollow square, because a
deliberate drop is a decision and not a dip, and it says so in the legend, in
the tooltip and in the table.

**The multiplier is the biggest number on the page.** "Ten per cent a week"
reads as modest; `1.77x` does not, and they are the same sentence. Compounding
is precisely the thing people misjudge, so the multiplier is set in display
size with the server's own sentence beside it — twenty-five per cent over
twenty-six weeks is `330.87x`, which is the kind of number that stops a plan
being agreed to by accident. Every figure on the page — target, increment,
peak, total, ratio, multiplier — comes from `GET /api/plan/distance`. The
projection is **not** reimplemented in the browser: ten tests cover it
server-side, and this app has been bitten three times by one figure existing in
two places.

**A commitment outranks a projection, and the table says so.** The projection
re-plans from the last *complete* week every time the slider moves, so it will
restate a week that was committed weeks ago at a different number — this week
read `25.0` here against a locked `35.3`, because the base week came up 9.4 km
short and the projection follows the record while the commitment does not. The
column is named **Proposed** rather than "Target" for that reason, a
**Committed** column beside it prints what each week is actually locked to, and
a line above the table names the first week that differs and states which
figure governs. With nothing committed, neither the column nor the line
appears — the proposal is all there is, which is exactly when it should lead.
The projection is still free to disagree: modelling a re-commit is what the
page is *for*. It just no longer does it under the word "target".

**A Monday is not a failure, so the planner says so.** The endpoint's default
base is the week containing today, which on a Monday is zero, and a ramp
compounding upward from nearly nothing is not a plan. So the page builds from
the last *complete* week instead, states that in the control, and leaves it one
tap from being changed back. Where there genuinely is no base, the chart draws
the eight logged weeks alone rather than a flat line of zeroes labelled "0.0
peak" — an empty state, not an unrendered one.

**Every charted panel states its period, in one place and in the server's own
words.** Ten of twenty-nine said nothing at all and the rest said it three
different ways, so "is this twelve weeks or a year?" was a question the
interface could not answer. The API publishes one authoritative label per
dataset (`timeframes` on `/api/summary` and `/api/plan/distance`, `timeframe`
everywhere else) and `ui.js::setTimeframe` is the only thing that renders it:
**verbatim**, never paraphrased, never recomputed from `from`/`to`. It sits in
one fixed slot — under the title, above the descriptive subtitle — so the eye
learns where to look once, and it moves when a control moves the window. A
panel with no real time window never calls it and gains no fake one.

**A fresh week reads as a fresh week.** The user opened the app on a Monday
and found the load reading 0.00. It was correct, and it read as a failure. The
Week view now uses `week_progress`: on a day with nothing logged it says *Day 1 of
7* in words, puts the last complete week's figures where this week's zeroes
were, replaces the empty split bar with last week's split for reference, and
names the ACWR window as one day old rather than letting 0.00 read as a
collapse. No encouragement — it states the fact and stops. The same rule holds
on the Running page, where the week in progress is marked as such and prints no
percentage against the week before: part of a week against a whole one is not a
comparison, and -100% is a calendar artefact dressed as a drop.

**Habits are kept in one tap, and the box fills rather than renaming itself.**
The decision was that a habit tracker should take one tap and no reading, so
the control is a checkbox: empty or full, legible at arm's length, no word to
read. The first version was a pill labelled *Mark*
that became *Done* once pressed — two strings in one place meaning opposite
things, so the state of a day could only be learnt by reading it. A box has no
such problem.

It fills with the habit's **own hue**, not with green. Colour here means *which
habit* — the same rule the modality palette follows, where a hue belongs to
running and not to rank — so stretch is green and no-takeout is amber on every
screen they appear on, and neither is "better". The five day-states are carried
by **shape**: filled, part-filled, outlined, dashed for today, a dot for
nothing recorded. Greyscale and colour-blind readers get the whole story; the
hue only tells them whose row they are in.

**A part-way day fills by what it actually earned.** 7.5 h against an 8 h
target is 0.75 and the mark is three-quarters full, along its length — so the
picture and the arithmetic are one statement, and a 6.9 h night cannot look
like a 7.9 h one. The fill runs left to right rather than bottom up because at
week grain these marks are 140px wide and 24px tall, where a bottom-up band is
something you have to measure against its own border to read.

**Sleep is measured, never tapped.** `metric_daily.sleep_hours` has been
arriving from the nightly Garmin sync since long before this page existed —
242 nights of it — so asking for a tick would be data entry for something the
watch already knows. Its slot in every row holds the *number* instead of a box,
at the size the box would have been, so a mixed list still reads down one
column. It stays correctable: type over the night and the sync never touches
that row again, the same way an estimated RPE can be typed over. "From Garmin"
and "corrected by hand" are different states and both are said out loud.

**Only finished days are scored, and an unrecorded night is not a failed one.**
Today is `open`, not missed — grading a day at nine in the morning would make
every morning a failure — so a Monday has nothing to score yet and the habits
pillar is *absent*, its weight redistributed, exactly as a week with no match
is. A night the watch did not record leaves the denominator entirely rather
than entering it as a zero: the score is about how you slept, not about whether
you wore a device.

**And there is still no streak.** Habits are where streaks get into a product,
and the rule held: rolling rates over the window on screen, which fall and
recover, with nothing that resets and nothing to protect. The payload has
nowhere to put a streak — it counts days, never runs of them — and a test
asserts that.

**The habits pillar is the mean of each habit's own rate**, never total ticks
over total days. Denominators differ — sleep can be missing two nights — and
pooling them would quietly weight the best-recorded habit highest.

**A habit tick is not a session.** Nothing on this path writes to `session`, so
it can never reach the activities-per-week figure the whole record is built on,
the load scale, ACWR, or the log. Stretching for thirty minutes is a thing you
did; it is not a training session, and the moment it became one the boxed
number on every page would mean something different than it did last week.

**There is no "planned".** The decision was that a thing is simply done or it
is not — there is no planned-versus-done to score. The Week view
shows counts per modality over a rolling 28 days, scaled to the largest, with
no denominator and no target. The only plan in the app is the one you write
yourself on the Plan page, and even there the two numbers sit side by side
without a score.

**The weekday is a label, not a detail.** In the configured fixtures Monday is
coed, Tuesday is pickup, Thursday is men's league — the weekday *is* the
fixture, so it appears as its own badge on every session row, as the heading of every day group, as a column
in every table, live beside the date field while you enter an activity, and as
a Mon/Wed/Fri rail down the side of the year grid. The three fixture days are
inked and the rest stay recessive, so the pattern reads down a column.

**Sync failures are loud.** The Garmin engine already exists in Python and runs
nightly, but a cron job that fails silently is worse than no cron job — this
one had been erroring at login since the first run with nothing in the
interface to say so. `#/sync` reports the state, names the failure, and prints
the exact command to fix it. Status is always a dot **and** a word.

**Leagues lead with the answer, not the table.** Each league is a card: your
position as a figure, the W/D/L/PTS cluster, a ladder bar, form in that league,
and the next fixture with its venue — indoor and outdoor are different games, so
the venue is a badge with the word on it. The next fixture also carries **who
they are**: the opponent's rank as a chip and their record on one line, in the
same W/D/L order as your own cluster above it. Position and record are the
useful part; it stops well short of a second table, because folding the table
away is the reason the card exists. A team with no standings row says so. The
fifteen-row standings and the full schedule stay behind a disclosure, where a
reference belongs.

**Leagues refresh themselves.** They used to update only when `ledger leagues`
was run by hand, so a Monday-night scoreline sat unread until you remembered.
Now the nightly job scrapes them, and `GET /api/leagues` starts a scrape behind
its own response whenever the stored rows are more than six hours old. That
response carries `refreshing`, and the page asks once more a few seconds later
so a result posted since your last visit lands on *this* one. The second answer
only repaints if `fetched_at` actually moved — a scrape can fail, and redrawing
the cards would collapse an open standings table to show identical numbers.

**A season ends, and the next one has a different id.** League ids used to be
constants, which works for exactly one season: the Summer Coed Open Lower
Division finished on 14 Sep 2026 and the nightly job carried on scraping a page
that would never change again. A `league` row is now one *season* of a fixture,
and once a season's last fixture is in the past the job looks for its successor
in the venue's own league list.

It switches only to a league that **contains your team in its standings** and
**runs later than the season being replaced**. Both halves earned their place by
failing: matching on the division name attaches Coed 30+ or the division
*Sparrows United* play in, and matching on the team alone walked the men's fixture
*backwards* into the Spring session on its first live run, because the venue
still publishes Spring and the team is in that table too. The old season is
archived rather than deleted — its results stay on record — and any switch is
reported by `ledger leagues` rather than happening quietly.

**And a Refresh button, for when six hours is too long to wait.** It sits on the
Leagues rule with the age of the tables beside it — "Pulled 4h ago" — because
without knowing how stale they are there is no way to tell whether pressing it
would change anything. It posts to `/api/leagues/refresh`, which ignores the
staleness window and blocks until both pages have been fetched, so the answer to
"is tonight's scoreline up yet" is a yes or a no rather than a maybe. A league
that fails is named, with the reason, above the cards it failed to update; the
other league still refreshes, and the stale cards stay on screen. The button is
disabled only while this page is waiting on its own request — a scrape running
behind someone else's response says so in the stamp but leaves the button live,
because the background poll gives up after two looks and a control that never
comes back is worse than a second scrape of two pages.

Nothing here beats the league admin typing the score in. This only stops you
waiting on us.

**One heading per thing.** The section rule above the league cards used to be
followed by a panel repeating it, so the page opened by saying "Leagues" twice.
The rule keeps the heading; the panel is a bare container, and the cards sit one
box shallower for it.

**Long pages have rhythm.** Labelled section rules (`Load` / `Shape` / `Detail`)
break the sport pages into groups, and every long table — 94 runs, 67 lifts,
61 matches — is folded behind its own count so a page ends rather than trailing off.

**An estimated RPE never looks like a tapped one.** Where Garmin inferred it
from heart-rate time-in-zone, it renders `RPE 4.2 est` with a dotted underline
and the source in the title. It is the one input the whole load model rests on.

**One load scale, and it is Garmin's.** The app does not compete with the
watch, it fills the watch's gaps: where Garmin recorded the activity its
training-load figure is used unchanged, and where it did not — every notebook
row, every session no watch saw — a stand-in is derived from rpe × minutes and
converted onto the same scale by a factor fitted from the sessions carrying
both numbers. A converted figure is **marked**, `115 AU ᴇsᴛ`, with the same
dotted underline an estimated RPE gets: a number that was inferred never looks
like one that was recorded. `raw` marks the rarer case where too few paired
sessions exist to fit a factor at all.

The scale is named once, on the Load tile, rather than on every figure carrying
`AU`. And because the factor refits nightly as the sync brings in more paired
sessions, **historical numbers move** — so the Sync page carries a Load
calibration panel with the paired-sample count, the factor and how far it is
from being fitted per modality. Watching that count climb is the difference
between "the estimate is getting better" and "why did last year change".

The ACWR panel answers the matching question by printing its own division. The
ratio still differs from the watch's, but for one reason now rather than two:
same scale, wider coverage.

**One activities-per-week number, everywhere.** The figure on week N is
activities through the end of week N−1 divided by N−1 — recalculated when a week
closes, which is why it does not sag every Monday and recover by Sunday. The
server computes it in one place (`report/average.py`); the Week hero and the
History page both read that, so they cannot disagree. There is no second figure
and no fine print reconciling one: three screens once showed 4.20, 4.27 and 4.35
for the same thing, and the fix was one definition, not a paragraph explaining
three. `headline.notebook_avg` stays in the payload as an integrity check and is
never rendered.

**Empty states state the fact and stop.** "None this week." "No matches with a
recorded result in this range." A dead endpoint degrades that one panel and
names what is missing; it never blanks the page.

**Motion is small and optional.** View entry is a 300 ms rise, columns grow
from the baseline with a capped stagger, the headline number counts up once.
All of it collapses under `prefers-reduced-motion`, and refetching keeps the
previous render on screen with a thin progress bar rather than flashing
skeletons.

---

## Adding an activity

Two paths, one ingest. The tap path composes the same notebook shorthand the
text path takes, shows it under the form, and both send `POST /api/sessions
{text}` — so the structured form quietly teaches the faster syntax, and there
is exactly one grammar to get wrong.

- Modality first, then only the fields that modality needs. Soccer gets result,
  score, goals, assists, duration, RPE; run gets distance, elapsed, compliance,
  RPE; fast gets hours and nothing else.
- **Quick add.** A rail of one-tap presets at the top of the form, built from
  the record itself: any session shape logged three or more times becomes a
  preset carrying its own typical duration and RPE, recency-weighted so a habit
  that stopped drops off by itself. Tapping one fills the whole form — *Quick
  feet* arrives as 20 minutes at RPE 4 because that is what quick feet has
  always been. Two are seeded by name (*Ab attack*, *Quick feet*), and any
  filled-in form can be pinned as a new one. It is a prefill, not a shortcut
  past the preview: the card still shows what will be saved.
- **RPE is eleven buttons, one tap.** It is the input the entire unified-load
  feature depends on, so it is never a dropdown. Native radio inputs, so arrow
  keys work.
- Date defaults to today with Today/Yesterday chips; duration and RPE prefill
  from the last session of that modality.
- Everything is previewed through `POST /api/parse` before it is saved — the
  card above the button is exactly what lands in the record, including the
  computed load.
- **A soccer scoreline is one token or nothing, so the form completes it.** The
  grammar has no way to say a score without a result — `W13:5` parses, a bare
  `13:5` is refused by name — and `composeShorthand()` used to emit the token
  only when W/D/L, goals for *and* goals against were all filled. Type 13–5,
  leave the radio alone, and the score was dropped before the request: a valid
  line, a clean preview, a save that said "Saved", and no result in the record.
  The letter is now derived from the score, which is arithmetic and not a guess
  — the league cards derive it the same way. The reverse has no rescue, so a
  result picked with an empty score is called out above the save button rather
  than discovered afterwards. Save stays enabled: the rest of the edit is
  still worth saving, and the warning says exactly what will not be.
- Failure is honest: the server's message is shown verbatim, the entry stays in
  the form, and the text draft survives in `localStorage`.
- Edit and delete live at `#/edit/{id}`, reachable by tapping any session row
  anywhere in the app. Delete is a two-step button, not a confirm dialog.

**Week notes are bullets, because that is what they are.** The Week view's
notes panel is a ruled list, one observation per line, each line directly
editable in place and each reorderable or removable on its own row — the same
shape the paper page had. It is not a form: the writing is the loudest thing on
the panel, the controls sit recessive at the end of the row and come forward on
hover or focus, and deleting is two clicks rather than a dialog. The
start-of-week weigh-in closes the panel as its own short row, because it is a
measurement rather than a note and it goes to the week header, not the note
list. Both read and write straight to the server.

---

## Keyboard

| Key | Does |
|---|---|
| `1`–`6` | Week · Plan · Insights · Sports · History · Log |
| `a` | Add an activity |
| `←` `→` | Previous / next week (Week view) |
| `t` | Jump to the current week |
| `/` | Focus the log search, switching view if needed |
| `d` | Toggle light / dark |
| `u` | Toggle pounds / kilograms |
| `?` | Shortcut panel |
| `Esc` | Close the panel, or cancel out of Add / Edit |
| `←` `→` `Home` `End` | Step the crosshair when a line chart has focus |

Shortcuts are suppressed while typing in a field. Every chart mark, filter and
session row is reachable by Tab with a visible focus ring.

---

## Offline

`sw.js` is **network-first for the shell as well as the API**, with the cache as
the fallback and a 3.5 s timeout so a flaky signal degrades to cached data
instead of hanging. A cache-first shell pins a returning visitor to whatever
build they happened to install — which looks exactly like "my changes didn't
deploy" and never heals — so it is deliberately not used here. `activate`
claims clients immediately. Navigations fall back to the cached shell so any
route still opens with no network.

**Bump `VERSION` in `sw.js` on every shell change.** It is currently
`ledger-v129`, and `SHELL` lists every module — a new `view-*.js` has to be
added there too.

---

## Workarounds, not design

Written up in `NOTES-FOR-BACKEND.md` and deleted as the API catches up. **One
is left.**

1. **One small thing lives in `localStorage` because there is nowhere else:**
   the "working around" note on the Lifting page (there is no server table
   for it). The week intent, the day split and the goal weight used to be
   here too; they are on the server since migration 017 (`/api/plan/intent`,
   `/api/plan/days`, `/api/plan/goal`), read through one snapshot in
   `dataset.js` so the phone and the desk show the same plan.

Struck through: gone, with the server fix that allowed it.

~~2. `api()` serialises every request.~~ **Fixed.** `get_db` opens a connection
   per request, 36 concurrent reads come back 200, and
   `tests/test_api_concurrency.py` guards it. Panels fetch in parallel. The
   single retry on a failed read stays on purpose — that is resilience, not a
   workaround.
~~3. Week notes are written to the database but read from `localStorage`.~~
   **Fixed.** Notes are individual rows on the server now, and both the
   shorthand write path and the browser mirror are deleted.
~~4. `resolveRange()` sends an explicit `to` of today.~~ **Still does, on
   purpose.** The open-ended label bug is fixed, but left open the window ends
   at the last *logged session*, so "52 weeks" reads as ending last Tuesday.
   Naming today states what the control asked for.
~~5. `demojibake` covers four byte sequences.~~ **Deleted**, with its fourteen
   call sites. Ten endpoints were swept for the four latin-1 sequences and came
   back with zero; the only non-ASCII served is the intended U+2013, U+2014 and
   U+00B7. Server text prints verbatim.

## Why the ACWR number will not match a watch

Asked and answered inside the app, under the ratio itself. Ledger's figure is
mean daily load over the last 7 days divided by mean daily load over the last
28, where load is Foster session-RPE — the RPE you entered times the duration —
across *every* logged session. Garmin's is heart-rate-derived and covers only
what the watch recorded, which is precisely the modality this record is mostly
made of. Different inputs and different scales: compare each against its own
history, not against the other.

---

## Verification

There is no test runner here by design, but nothing was shipped unlooked-at:

- `node --check` on every JS file.
- A static import/export linker check across all modules.
- The whole app booted in jsdom against the live API with 363 real activities,
  walking every route and asserting zero runtime errors, at both a desktop and
  a 358 px content width.
- Both palettes run through the dataviz validator for their own surface.
- Every shorthand string the tap form can compose round-tripped through
  `POST /api/parse`.
- Every derived soccer aggregate reconciled against `/api/soccer`: wins,
  losses, draws, played, logged, goals, assists, goals for and goals against
  all match exactly once split across the four fixtures.
- The 84-week activities-per-week series anchored to the server's own basis, so
  the endpoint of the line, the History "Now" tile and the Week hero all read
  4.20 — one number, checked in all three places.
- `scripts/qa.py` — every route x both themes x 1440px/390px, asserting no
  horizontal overflow, nothing off the right edge, no clipped text, no empty or
  skeleton-stuck panel, no `undefined`/`NaN` in the DOM, a stated timeframe on
  every charted panel, 40px tap targets on the phone, and measured contrast on
  real rendered pairs. Taken from 675 findings to 109, and every one of the 109
  is a false positive in the harness rather than a fault in the app — see
  below.
- Contrast measured independently with a probe that understands Chrome's
  `color(srgb ...)` serialisation of `color-mix()` and composites translucent
  backgrounds: **zero real failures** in either theme.
- The planner driven end to end in a real browser: slider, horizon, down-week
  and base controls each changing the projection, the URL round-tripping
  through a reload, and the three edge cases looked at — an empty base week, a
  hand-set base, and 25% over 26 weeks with no down weeks (330.87x).
- Every route walked in headless Chromium at 1440px and 390px, in both themes,
  with console errors and horizontal overflow asserted at zero.
- The week-notes panel driven end to end in a real browser: add by Enter and by
  button, edit in place, reorder, two-step delete — each checked against the API
  afterwards, with the record left as it was found.


---

## Known harness false positives

`scripts/qa.py` is newer than most of this code and two of its checks
misreport. Both are worth fixing in the harness rather than in the app.

**`color(srgb r g b / a)` is parsed as 0-255.** Chrome serialises any
`color-mix()` result — the translucent top bar, the tab bar, the form-strip
tints, the highlighted standings row — in that syntax, with 0-1 floats.
`qa_audit.js::parse()` does `c.match(/[\d.]+/g)` and reads `0.976` as a channel
value, so a white bar measures as black and every label on it fails. That is
all 107 remaining "low contrast" findings; `Ledger` at 1.06:1 is white text on
white. Two fixes: read `color(srgb ...)` by multiplying by 255, and composite a
translucent background over what is behind it rather than stopping at the first
non-zero alpha. A corrected probe reports **zero** real failures in either
theme, and both ink tokens were retuned against it — `--ink-3` moved for
exactly this reason, because that finding was real.

**A 1x1 visually hidden radio counts as a tap target.** The `.sr` inputs on the
entry form are 1px with `clip-path`; the visible target is the `<label>` beside
them. `visible()` only asks whether the rect is non-zero, so the input is
flagged and the label it controls is never measured. Skipping `.sr`, or
elements a `clip-path` hides, would fix it. Two findings.

Two checks were **correct and the app was wrong**, and both are fixed here: the
tap-target floor (35px icon buttons, 30px `Add` and `Save`, 32px segment
buttons, a 25px range slider) and the contrast floor on `--ink-3`, which
carried nearly every subtitle, axis tick and legend label in the app at
3.9-4.4:1 against the surfaces it actually sat on.

One more was a naming mismatch rather than a false positive: the audit exempts
`.tbl-wrap` from its off-the-right-edge check and this app calls it
`.table-wrap`. Rather than rename either, the four containers that genuinely
scroll sideways — `.table-wrap`, `.fig-plot`, `.cal-wrap` and `.weekpicker` —
now also carry a `.scroll` class, which the audit already knows about and which
says what they are.
