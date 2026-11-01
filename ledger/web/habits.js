/* Habits — the display rules for a day, and nothing else.
 *
 * The *resolution* of a day lives in `ledger/report/habits.py` and only there:
 * whether a night counts, whether a tap was recorded, whether the watch had
 * anything to say. This module never re-decides any of that. It takes the
 * state the server returned and answers two questions the browser has to
 * answer for itself — what mark to draw, and what words to put beside it.
 *
 * That split is deliberate and it is the reason the Week widget, the calendar
 * overlay, the Scoreboard pillar and the Habits page cannot disagree about a
 * day: there is one decision, made once, server-side. Three surfaces once
 * scored the same week at 69, 74 and 68 because they shared a formula but not
 * its inputs. Sharing the *answer* is what actually fixes that.
 */

import { el, icon, fmt } from './core.js';

/* ── the six states ──────────────────────────────────────────────────────── */

/**
 * One entry per state `resolve_day` can return.
 *
 * `mark` is what the cell draws. It is a shape, never only a colour: met is a
 * filled square, partial is half of one, missed is an empty outline, and the
 * two that are not scored at all are a dot and a blank. Somebody reading this
 * in greyscale, or colour-blind, gets the same information.
 *
 * `scored` says whether the day is in the denominator. It exists so no caller
 * has to remember that an unrecorded night is not a missed one — the single
 * most important rule on this page, and the easiest to get wrong by accident.
 */
export const STATES = {
  met: { mark: 'full', label: 'met', scored: true },
  partial: { mark: 'half', label: 'part way', scored: true },
  missed: { mark: 'empty', label: 'not met', scored: true },
  open: { mark: 'open', label: 'today, not yet', scored: false },
  unrecorded: { mark: 'none', label: 'not recorded', scored: false },
  ahead: { mark: 'blank', label: 'ahead of today', scored: false },
  /* Before the habit existed. Not a miss and not a gap in the record — there
     was simply nothing being kept, so it is drawn like a day that has not
     happened and counted like one. */
  untracked: { mark: 'blank', label: 'not tracked yet', scored: false },
};

export const stateOf = (d) => STATES[(d || {}).state] || STATES.ahead;

/**
 * The habit's own hue, as a CSS variable reference.
 *
 * Keyed off `position`, which is assigned once at creation and never
 * renumbered — so adding a fourth habit cannot repaint the first three, the
 * same guarantee the modality palette gives by fixing slot order. Every
 * surface calls this, so a habit is one colour across the page, the widget and
 * the calendar.
 */
export const hueOf = (habit) => `var(--hb-${((habit.position || 0) % 8) + 1})`;

/** Sets `--hb` on a node, which is all the CSS below needs. */
export const hueStyle = (habit) => `--hb:${hueOf(habit)}`;

/** Is this day one you can change? Future days are not. */
export const editable = (d) => (d || {}).state !== 'ahead';

/* ── words ───────────────────────────────────────────────────────────────── */

/**
 * What a habit's tick means, in the habit's own direction.
 *
 * An `avoid` habit is ticked for *not* doing the thing, so "missed" reading as
 * "you did not avoid takeout" needs different words from "you did not
 * stretch". The arithmetic is identical — only the sentence changes, which is
 * the whole of what polarity is for.
 */
export function dayWords(habit, d) {
  const s = (d || {}).state;
  const avoid = habit.polarity === 'avoid';

  if (s === 'met') return avoid ? 'clean day' : 'done';
  if (s === 'partial') return 'part way';
  if (s === 'missed') return avoid ? 'not marked clean' : 'not done';
  if (s === 'open') return 'today — not marked yet';
  if (s === 'unrecorded') return 'nothing recorded';
  if (s === 'untracked') return 'not tracked yet';
  return 'ahead of today';
}

/**
 * A number with its unit, with a whole number left whole.
 *
 * `fmt.one` is right for a measurement — 7.5 h is not 8 h — and wrong for a
 * target, which is a round figure somebody chose. "8.0h earns the tick" reads
 * like a reading; "8h earns the tick" reads like the decision it is.
 */
const num = (v, unit) => `${Number.isInteger(v) ? String(v) : fmt.one(v)}${unit || ''}`;

/**
 * One day, as short as it can honestly be said.
 *
 * For a tooltip or a hover title, where the habit is already named on the left
 * and the only question is what happened. "clean day", "not marked clean",
 * "today — not marked yet" are the right words for a row on a page with space
 * for them, and they are far too much to read off a calendar cell under a
 * pointer — six habits over seven days is forty-two little sentences.
 *
 * A measured habit answers with its number, because that IS the fact; the tick
 * rides along only when it was earned. A tapped one answers with the tick or a
 * dash. Two glyphs and a number, both glyphs safe in the system font stack —
 * no box-drawing, no half-circle that renders as a rectangle on someone's
 * phone.
 *
 * `dayWords` is still what every `aria-label` uses. A screen reader should hear
 * "not marked clean", not "em dash".
 */
export function daySymbol(habit, d) {
  const state = (d || {}).state;

  if (habit.mode === 'metric') {
    const v = (d || {}).value;
    if (v == null) return '—';
    const num = `${fmt.one(v)}${habit.unit || ''}`;
    return state === 'met' ? `${num} ✓` : num;
  }

  if (state === 'met') return '✓';
  if (state === 'open') return '·';
  if (state === 'ahead' || state === 'untracked') return '';
  return '—';
}

/** "8.8 h" / "7.5 h" — a measured habit's number, in its own unit. */
export function valueText(habit, d) {
  const v = (d || {}).value;
  if (v == null) return null;
  return `${fmt.one(v)}${habit.unit ? ` ${habit.unit}` : ''}`;
}

/**
 * The target, spelled out. Printed beside every measured habit rather than
 * held in the name, because "Sleep 8h" in a title bar is a label and this is
 * the arithmetic — and the arithmetic is always shown.
 */
export function targetText(habit) {
  if (habit.mode !== 'metric' || habit.target == null) return null;
  const u = habit.unit || '';
  if (habit.partial_at == null) return `${num(habit.target, u)} earns the tick`;
  return `${num(habit.target, u)} ticks · part credit from ${num(habit.partial_at, u)}`;
}

/* ── rates ───────────────────────────────────────────────────────────────── */

/**
 * A habit's rate over whatever window the server was asked for, as a
 * percentage — or null when nothing in the window has finished yet.
 *
 * Reads `totals`, never the days. The server publishes the numerator and the
 * denominator together for exactly this reason: a rate whose denominator is
 * recomputed downstream is two figures for one quantity, which is this
 * codebase's oldest failure.
 */
export const ratePct = (h) => (h && h.totals && h.totals.rate != null ? h.totals.rate * 100 : null);

/**
 * "2 of 4 days" — the division behind a rate, in words.
 *
 * `met` and `credit` differ whenever a measured habit landed in its partial
 * band, and hiding that would make the rate impossible to check by hand. So
 * where they differ, both are printed.
 */
export function rateWords(h, { noun = 'days' } = {}) {
  const t = (h || {}).totals || {};
  if (!t.scored) return 'nothing has finished yet';
  const base = `${t.met} of ${t.scored} ${noun}`;
  if (Math.abs((t.credit || 0) - t.met) < 0.005) return base;
  return `${base} · ${fmt.two(t.credit)} of ${t.scored} with partial credit`;
}

/* ── the control ─────────────────────────────────────────────────────────── */

/**
 * The checkbox. One control, built once, used on the Habits page and on the
 * Week widget so marking a day is the same gesture and the same shape in both
 * places.
 *
 * It is a box that fills in — not a button with a word on it. "Mark" and
 * "Done" are two different strings in the same spot meaning opposite things,
 * so the control changes its own label as you use it and you have to read it
 * to know the state. A box is empty or it is full: no reading, and the answer
 * is legible from across the room, which is the whole requirement.
 *
 * It fills with ink rather than with green. A filled box is a *state*; a green
 * one is a verdict, and verdicts live on `#/score` and nowhere else in this
 * app.
 */
export function checkBox(habit, date, d, { onTap, size = '' } = {}) {
  const met = (d || {}).state === 'met';
  return el('button', {
    class: `hbcheck${met ? ' is-met' : ''}${size ? ` hbcheck-${size}` : ''}`,
    style: hueStyle(habit),
    type: 'button',
    'aria-pressed': String(met),
    'aria-label': `${habit.name} — ${dayWords(habit, d)}`,
    title: `${habit.name} — ${dayWords(habit, d)}`,
    on: { click: () => onTap(habit, date, d) },
  }, [icon('check')]);
}

/**
 * What a measured habit shows instead of a checkbox: the number.
 *
 * Sleep is not something you tap, so it gets no tap target pretending
 * otherwise. The figure sits in the same slot the box would, at the same size,
 * marked by the same four states — so a row of habits still reads down a
 * single column even though one of them is measured rather than kept.
 */
export function measureBox(habit, d) {
  const st = stateOf(d);
  const v = (d || {}).value;
  return el('div', {
    class: `hbmeasure is-${st.mark}`,
    style: hueStyle(habit),
    title: `${habit.name} — ${dayWords(habit, d)}`,
  }, [
    el('b', { class: 'num', text: v == null ? '—' : fmt.one(v) }),
    v != null && habit.unit ? el('span', { text: habit.unit }) : null,
  ].filter(Boolean));
}

/* ── marks ───────────────────────────────────────────────────────────────── */

/**
 * One day's cell. Used by the widget, the page grid and the calendar overlay,
 * so a Tuesday looks the same wherever it is drawn.
 *
 * `onTap` makes it a button; without one it is a plain span, because a cell
 * you cannot change must not look like a control.
 */
export function dayCell(habit, date, d, {
  onTap = null, compact = false, showValue = false, showDow = false, today = null,
} = {}) {
  const st = stateOf(d);
  const words = dayWords(habit, d);
  /* The hover title is a glance, the aria-label is a sentence. They differ on
     purpose: pointing at a mark should not make you read. */
  const title = `${fmt.dowDate(date)} · ${daySymbol(habit, d) || '—'}`;
  const spoken = `${fmt.dowDate(date)} — ${words}`;

  /* A measured habit at week grain prints the number under its mark. There is
     room for it over seven columns and it is the thing actually worth knowing
     about a night — "6.0" says more than a second empty square. It is dropped
     on the long windows, where the columns are 15px wide. */
  /* The weekday under the mark. The user refers to days as Mon, Tue, Wed —
     "did I stretch Wednesday" is the actual question — so a strip of seven
     unlabelled squares makes you count across from Monday to answer it. The
     label is part of the cell rather than a header row above it, which is what
     keeps it aligned with its own mark on every width. */
  const kids = [el('i', { 'aria-hidden': 'true' })];
  if (showDow) {
    kids.push(el('span', {
      class: `hbcell-d${today && date === today ? ' is-today' : ''}`,
      'aria-hidden': 'true',
      text: fmt.dow(date),
    }));
  }
  /* Only where there is a reading. A night the watch missed already says so
     with its own mark — a dash underneath it is the same nothing, said twice. */
  if (showValue && habit.mode === 'metric' && (d || {}).value != null) {
    kids.push(el('span', { class: 'hbcell-v num', 'aria-hidden': 'true', text: fmt.one(d.value) }));
  }

  /* A part-way day fills by however much it actually earned, rather than by a
     fixed half. 7.5 h of an 8 h target is 0.75 and the mark is three quarters
     full — so the picture and the arithmetic are the same statement, and a
     6.9 h night does not look like a 7.9 h one. */
  const fill = st.mark === 'half' && (d || {}).credit != null
    ? `${Math.round(d.credit * 100)}%`
    : null;

  const attrs = {
    class: `hbcell is-${st.mark}${compact ? ' is-compact' : ''}`
      + `${showValue && habit.mode === 'metric' ? ' has-v' : ''}`
      + `${today && date === today ? ' is-today' : ''}`,
    style: `${hueStyle(habit)}${fill ? `;--fill:${fill}` : ''}`,
    title,
    'data-state': (d || {}).state || 'ahead',
  };

  if (!onTap) return el('span', { ...attrs, 'aria-label': spoken, role: 'img' }, kids);

  return el('button', {
    ...attrs,
    type: 'button',
    'aria-pressed': String((d || {}).state === 'met'),
    'aria-label': spoken,
    on: { click: () => onTap(habit, date, d) },
  }, kids);
}

/**
 * The week strip: seven cells, Monday first.
 *
 * Days outside the habit's payload render as `ahead` rather than being
 * skipped, so the strip is always seven wide and a Wednesday sits under a
 * Wednesday on every row.
 */
export function daysStrip(habit, dates, opts = {}) {
  const wrap = el('div', { class: `hbstrip${opts.compact ? ' is-compact' : ''}` });
  for (const date of dates) {
    wrap.append(dayCell(habit, date, (habit.days || {})[date], opts));
  }
  return wrap;
}

/**
 * The legend. Shape carries the state, so the legend names the shapes.
 *
 * Deliberately drawn in ink rather than in any habit's hue: these five marks
 * are about the *day*, and painting them one habit's colour would suggest the
 * meanings differ per habit. Which habit is which is the other legend's job.
 */
export function marksLegend(states = ['met', 'partial', 'missed', 'open', 'unrecorded']) {
  const ul = el('ul', { class: 'legend hblegend' });
  for (const key of states) {
    const st = STATES[key];
    if (!st) continue;
    /* "Today, not yet" is an ordinary unmarked day wearing the accent ring —
       that ring IS the whole difference, so the swatch has to carry it or the
       legend prints two identical marks under two different names. */
    ul.append(el('li', {}, [
      el('span', {
        class: `hbcell is-${st.mark} is-compact is-neutral${key === 'open' ? ' is-today' : ''}`,
      }, [el('i', { 'aria-hidden': 'true' })]),
      el('span', { text: st.label }),
    ]));
  }
  return ul;
}

/* ── windows ─────────────────────────────────────────────────────────────── */

/** Every date the payload covers, ascending. */
export function datesOf(payload) {
  const first = (payload.habits || [])[0];
  return first ? Object.keys(first.days || {}).sort() : [];
}

/** Find one habit by its key. */
export const habitOf = (payload, key) =>
  (payload.habits || []).find((h) => h.key === key) || null;
