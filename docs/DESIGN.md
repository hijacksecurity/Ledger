# Design — how Ledger looks, and the rules behind it

**Read this before building or restyling anything in `ledger/web/`.** It is
the one place the visual rules live. The reasoning behind each past decision
is in `ledger/web/README.md` ("Design decisions, and why"); the behavioural
conventions (remembered windows, timeframe lines, deep links) are in
`CLAUDE.md`. This file is the look.

These rules were stated by the user many times, piecemeal, and kept being
missed because they were scattered across a README, a project file and
session notes. A page that follows the code conventions and ignores these
ships "correct and plain", and plain has been rejected every time.

---

## 1. The standard: understood at first look

Every surface is read at arm's length, on a phone, in a second or two. The
test is not "is the information there" but "does a stranger get it before
reading a word".

- **Colour does the first reading, words the second.** If a surface needs to
  be read to be understood, it is not finished.
- **Never plain.** Identical grey tiles, uniform type and an absence of hue
  have been rejected outright, more than once. Propose a designed treatment
  up front; do not wait to be asked twice.
- **Big enough to see.** A widget that is technically compact but squints is
  wrong. Size the lead figure for a glance; keep the whole thing tight by
  cutting chrome (footers, borders around every cell), not by shrinking type.

## 2. Hierarchy: one lead, styled apart

- Each surface has **one lead figure**, larger and styled differently from
  everything around it — the best run is gold with a medal; the current
  temperature is big and in its band colour; today's calories figure is
  coloured by standing.
- The lead and its supporting figures **never share a style**. "Best" and
  "latest" must not look alike; "now" and "later" must not look alike.
- Figures are set in the **display face** (`--display`, Bahnschrift), heavy,
  tabular (`font-variant-numeric: lining-nums tabular-nums`). Body text,
  tables and ticks stay in the UI sans.
- Print the number on every point of a chart, not only the endpoint.

## 3. Colour: true of its subject, always keyed

- **Hue means something, and only one thing.** Modality hues (`--k-*`) mean
  the modality on every screen. A panel takes a colour only when that colour
  is true of its subject.
- **Every colour on a screen is explained by a key on the same screen**, in
  words. A key lists only what is on screen.
- **Verdict colours** (good / bad) are confined to the published-scale
  exceptions in `CLAUDE.md`: the Scoreboard, Recovery's published bands, and
  Calories' standing. Load and ACWR are never tinted.
- **Descriptive colours** — colour that encodes *what something is*, not
  whether it is good — are welcome wherever they help a glance: the sky in
  its own colours, temperature on the weather-map ramp, rain in blue. They
  are not verdicts and still get a key.
- **A tint has to be visible.** 6% washes read as no colour at all; washes
  are 13–16%, borders match.
- **Verify a colour by its computed value and a screenshot**, never by its
  class name.
- Both themes are designed; values are re-picked per theme, not dimmed.

## 4. Words

- Real words, no codes: "Activity", not "ACT"; day names are three letters
  (Mon … Sun), never two.
- No bare numbers: a figure carries its unit and an icon or word saying what
  it is. A column of figures may carry a bare degree sign (`54°`) once the
  lead beside it names the unit.
- No "trailing"; windows are named in plain words ("last 28 days · 4 Oct to
  31 Oct").
- **No vendor or plumbing names on screen.** Where a figure comes from is
  shown only when the user acts on it — Garmin is the user's watch and its
  named scales are cited. A forecast provider, a scraper or a library is
  never named on a page; it belongs in the API payload and the docs.
- Spaces between adjacent text nodes, so `textContent` never runs words
  together.
- No hype, no congratulation, no streak language.

## 5. Layout

- Phone first, then 1280 (laptop) and 1440. Nothing scrolls the page
  sideways; a wide figure scrolls inside its own card.
- Tap targets ≥ 40 px.
- A widget that shares a row on desktop restacks on a phone rather than
  shrinking below legibility.

## 6. Traps that have already cost a release

- **Icon size.** `styles.css` sizes every icon with
  `svg:not(.sprite):not(.plot)` (specificity 0,2,1). A plain `.my-icon` rule
  loses to it silently. Size icons as `svg.my-icon:not(.plot)`.
- **Absolute children in a scroller.** An absolutely positioned child whose
  containing block lies outside an `overflow: auto` box escapes the clip and
  scrolls the whole page. Make the scroller `position: relative`.
- **Stale CSS in the test browser.** Before judging a screenshot, unregister
  the service worker, clear caches and `fetch(url, {cache: 'reload'})` each
  changed file.

## 7. The weather (worked example)

`weather.js`, from `ledger/weather.py`:

| Element | Treatment |
|---|---|
| Sky icon | Parts in their own colours: `--wx-sun` gold, `--wx-moon`, `--wx-rain` blue, `--wx-snow` ice, `--wx-bolt` amber; cloud in ink |
| Temperature | Display face, coloured by band on the weather-map ramp (`--tb-freezing` … `--tb-very-hot`); bands and ranges come from the server and are keyed on screen |
| Rain | Blue, stronger with the chance on the NWS scale: faint for a slight chance, solid and bold from "chance", filled drop from "likely" |
| Lead | Now: large icon, large figure, the word, feels-like; a sun or moon wash behind it |
| Headline | One server sentence in the NWS's words ("Rain likely from 2 pm"), blue when it is not dry |
