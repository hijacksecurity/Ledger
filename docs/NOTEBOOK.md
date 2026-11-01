# The paper notebook — what the app expects to import

Ledger began as a replacement for a hand-written training log. This page
describes the shape of such a log and how it gets into the database, so that
anyone with a similar notebook can transcribe their own. It is written from
the one notebook the app was built around, with every figure below invented.

## What a page looks like

One week is a header line, a line per activity, and two optional trailing
blocks. A typical spread:

```
Week 12   3/17/2025   (200 lbs)↓   [3.45]↑
MON  GAME - W 5:3 - 2g 1a
WED  5.02km - 31:40 (6:18/km) - easy 5K      Z1 70% Z2 30%
FRI  Lift - upper
SAT  Bike 45:00 / Fasting
Totals:
Soccer 5.5km + Run 5.02 = 10.52km
Notes:
- Felt sharp Monday. Took Thursday off.
```

| Header field | Meaning |
|---|---|
| Week number | The writer's own count. It can skip or repeat — key everything on the date, never the number. |
| Date | The Monday the week starts on. |
| `(200 lbs)` | Start-of-week bodyweight, with an arrow for direction against the week before. Kept in pounds as written (`week.bodyweight_lbs`) so a transcribed page can be checked against its photo. |
| `[3.45]` | The boxed number: **activities so far ÷ weeks so far**, truncated to two decimals. The one headline the app carries forward from the paper — see `ledger/report/average.py`. |

Day lines carry a weekday, then free text. The import grammar in
`ledger/entry.py` reads what it can from that text — distance, time, pace,
a scoreline (`W 5:3`), goals and assists (`2g 1a`), heart-rate zones
(`Z1 70% Z2 30%`), an RPE — and keeps the rest as the session's note.

## Transcribing your own

1. Photograph each spread into `notebook/` (the folder is gitignored; see
   its README for a file-naming scheme).
2. Type each page into a plain-text file such as `notebook/2025.ledger`, one
   session per line in the bulk-entry format `ledger add` accepts:

   ```
   2025-03-17 soccer W5:3 2g1a 60min rpe=7 "mon game"
   2025-03-19 run 5.02km 31:40 z1=70 z2=30 rpe=6 "easy 5K"
   2025-03-21 lift 40min "upper"
   2025-03-22 bike 45:00 rpe=5 "fasting"
   ```

   The grammar is documented at the top of `ledger/entry.py`: a date, a kind,
   then any of `5.02km`, `31:40`, `60min`, `W5:3`, `2g1a`, `z1=70`, `rpe=6`,
   `72hr` (a fast), `16.5lb` (a ruck load), `+pickup` (which fixture), and a
   quoted note.

   `ledger add --dry-run file` parses and summarises without writing anything;
   drop `--dry-run` to import.
3. Check the import against the paper. The boxed number is the check the
   notebook carries itself: after every page, cumulative activities divided by
   pages so far must reproduce the figure in the box. A page that does not
   reproduce its own number is a transcription fault, not a rounding one.

## Pitfalls that cost real sessions

These are the mistakes found in the original transcription. Each one changed
the lifetime average the app shows, and none raised an error.

- **A multi-day fast written with a bracket** (`THU / FRI / SAT } 76 hrs`) is
  one line per day, not one session. The bracket is the fast's length.
- **Two activities on one line separated by a slash** (`Bike / Lift /
  Fasting`) is **one** session when the page counts it once. Where the writer
  wanted two, two lines were written.
- **Week numbers drift.** The original skipped two numbers midway and carried
  the offset for a year. Nothing downstream may use the week number as a
  count.
- **Cropped photos.** A page whose bottom edge is cut off still fixes its
  count through the boxed number on the next page; record the missing session
  as an unscored activity rather than leaving it out.
- **Pages that disagree with themselves** happen. One or two slips of the pen
  are normal over a long log; note them and make sure nothing derives from
  those figures.

## Where the schema departs from the original brief

The brief assumed a barbell log (weight × reps per set). A notebook like the
one above has none of that: it is soccer, running, cycling, fasting and
rep-count lifting. Migration `002_notebook_reality.sql` adapts the schema to
what is actually on the page; the e1RM and PR code stays built and tested for
the day barbell work is logged.
