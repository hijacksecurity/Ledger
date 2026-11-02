/* Ledger — calories: the standing's tone and word, meal hues, the fuel bar,
 * and the week strip. Shared by `#/calories` and the Week widget, so a day
 * reads the same on both. Decides nothing: `standing` is the server's.
 *
 * Colour here was asked for. The page is meant to be read at arm's length
 * without reading, so a day's standing against the target takes the
 * Scoreboard's five-step ramp — the one ordered palette in the app — and the
 * word is always printed beside it. Meal hues are the habit slots: colour
 * there means *which meal*, never how big.
 */

import { el, icon, fmt } from './core.js';

/* standing → colour. Three colours everybody already knows, not five:
   green is a deficit at or past the target, amber a smaller deficit, red a
   day that ate more than it burned. The words are for titles, aria text and
   the past-day pill; the colour is what is read. */
export const STANDING = {
  met: { tone: 'strong', word: 'Target met' },
  close: { tone: 'mixed', word: 'Short of target' },
  short: { tone: 'mixed', word: 'Short of target' },
  over: { tone: 'poor', word: 'Ate more than burned' },
  far_over: { tone: 'poor', word: 'Ate more than burned' },
};
/* The legend, three entries, each naming the target in kcal so "amber" can
   never be read as "overate": amber is a deficit, just a smaller one. */
export const legendFor = (target) => [
  { tone: 'strong', label: `deficit ${fmt.int(target)}+` },
  { tone: 'mixed', label: `deficit under ${fmt.int(target)}` },
  { tone: 'poor', label: 'ate more than burned' },
];
/* Kept for the chart legend, which has no target in scope at import time. */
export const LEGEND = legendFor(500);

export const toneClass = (standing) => `tone-${(STANDING[standing] || {}).tone || 'none'}`;
export const standingWord = (standing) => (STANDING[standing] || {}).word || '—';

/* A hue per meal word, from the habit slots. Anything else is neutral. */
const MEAL_SLOT = { breakfast: 3, lunch: 8, snack: 6, dinner: 2, bedtime: 4 };
export const mealHue = (label) => {
  const slot = MEAL_SLOT[String(label || '').trim().toLowerCase()];
  return slot ? `var(--hb-${slot})` : 'var(--ink-3)';
};

/** A coloured dot for a meal label. */
export const mealDot = (label) => el('i', {
  class: 'mealdot', 'aria-hidden': 'true', style: `background:${mealHue(label)}`,
});

/**
 * The one big number, and what it is, decided once for both pages.
 *
 *   today, still going   kcal left to eat before the target deficit is
 *                        gone ("474 left to eat"), or how far past it
 *                        ("179 over target")
 *   a finished day       the deficit it ended on ("321 deficit"), or the
 *                        surplus when it ate more than it burned
 *
 * A finished day showing "+179" — kcal past a limit that no longer moves —
 * was the reading a stranger could not decode.
 */
export function heroOf(day, today) {
  const tone = day.deficit == null ? 'tone-none' : toneClass(day.standing);
  if (day.deficit == null) return { tone, value: '—', lines: ['kcal', 'no burn'] };
  const live = day.date === today && !(day.burn && day.burn.complete);
  if (live) {
    const left = day.left;
    return left >= 0
      ? { tone, value: fmt.int(left), lines: ['kcal', 'left to eat'] }
      : { tone, value: fmt.int(-left), lines: ['kcal', 'over target'] };
  }
  return day.deficit >= 0
    ? { tone, value: fmt.int(day.deficit), lines: ['kcal', 'deficit'] }
    : { tone, value: fmt.int(-day.deficit), lines: ['kcal', 'surplus'] };
}

/** Deficit and target side by side, so the gap between the big number and
 *  the deficit is never a mystery: 974 deficit, target 500 → 474 left. */
export function standingPill(day, today) {
  const d = day.deficit;
  if (d == null) return el('span', { class: 'calpill tone-none', title: 'no burn from the watch' }, [el('span', { text: 'no burn yet' })]);
  const live = day.date === today && !(day.burn && day.burn.complete);
  const words = `${fmt.int(Math.abs(d))} kcal ${d >= 0 ? 'deficit' : 'surplus'} · target ${fmt.int(day.target)} · ${standingWord(day.standing)}`;
  return el('span', {
    class: `calpill ${toneClass(day.standing)}`, title: words, 'aria-label': words,
  }, live ? [
    el('b', { text: fmt.int(Math.abs(d)) }),
    document.createTextNode(' '),
    el('span', { class: 'calpill-rel', text: d >= 0 ? 'deficit' : 'surplus' }),
    el('span', { class: 'calpill-sep', 'aria-hidden': 'true', text: '·' }),
    el('span', { class: 'calpill-rel is-quiet', text: `target ${fmt.int(day.target)}` }),
  ] : [
    el('span', { class: 'calpill-rel', text: d < 0 ? 'ate more than burned'
      : day.standing === 'met' ? `${fmt.int(day.target)} target met` : `short of ${fmt.int(day.target)} target` }),
  ]);
}

/**
 * The fuel bar. Whole width = the day's burn; the fill = what was eaten,
 * in the standing's tone; a tick at "eat up to" (burn − target). Below it,
 * three icon-and-number pairs: eaten, burned, limit. No sentences.
 */
export function fuelBar(day, { compact = false } = {}) {
  const b = day.burn || {};
  const wrap = el('div', { class: `calbar ${toneClass(day.standing)}${compact ? ' is-compact' : ''}` });
  if (b.total == null) {
    wrap.append(el('div', { class: 'calbar-ends' }, [
      pair('fork', day.intake, 'eaten'),
      pair('flame', null, 'no burn'),
    ]));
    return wrap;
  }
  const pct = (v) => Math.max(0, Math.min(100, (v / b.total) * 100));
  const tick = pct(day.eat_up_to);
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label',
    `${fmt.int(day.intake)} eaten of ${fmt.int(b.total)} burned; eat up to ${fmt.int(day.eat_up_to)}; ${standingWord(day.standing)}`);
  /* Three segments, in the three colours: green up to the limit, amber from
     the limit to the burn, red when the plate went past the burn — then the
     whole bar is red, because there is no more track to draw on. */
  const over = day.intake > b.total;
  const okW = over ? 0 : pct(Math.min(day.intake, day.eat_up_to));
  const warnW = over ? 0 : Math.max(0, pct(day.intake) - okW);
  wrap.classList.toggle('is-over', over);
  wrap.append(
    el('div', { class: 'track calbar-track' }, [
      el('div', { class: 'calbar-seg tone-strong', style: `width:${okW}%` }),
      el('div', { class: 'calbar-seg tone-mixed', style: `width:${warnW}%` }),
      over ? el('div', { class: 'calbar-seg tone-poor', style: 'width:100%' }) : null,
    ]),
    el('div', { class: 'calbar-tick', style: `left:${tick}%` }),
    el('div', { class: 'calbar-ends' }, [
      pair('fork', day.intake, 'eaten'),
      pair('target', day.eat_up_to, 'eat up to'),
      pair('flame', b.total, b.estimated ? 'burn (est)' : 'burn'),
    ]),
    /* What the burn is made of: the body's own day, and what was done on
       top of it. The two numbers the user asked to see. */
    el('div', { class: 'calbar-ends calbar-split' }, [
      pair('gauge', b.bmr, 'base'),
      pair('pulse', b.active, 'active'),
    ]),
  );
  return wrap;
}

/** icon + figure + one word. */
export function pair(name, value, word) {
  return el('span', { class: 'calpair', title: word }, [
    icon(name, 'calpair-i'),
    el('b', { class: 'num', text: value == null ? '—' : fmt.int(value) }),
    document.createTextNode(' '),
    el('span', { class: 'calpair-w', text: word }),
  ]);
}

/**
 * Seven cells, Monday to Sunday, named in full short form — MON, never MO,
 * by the user's rule. Each day shows the deficit it finished with, in its
 * colour: green under the limit, amber under the burn but past the limit,
 * red over the burn (the figure is then how far over). The key under the
 * strip says exactly that. Today is ringed; a day with nothing logged is a
 * hollow dash; a day ahead is empty.
 */
export function weekStrip(days, today, { onTap, current = null } = {}) {
  const strip = el('div', { class: 'calweek', role: 'list' });
  for (const d of days) {
    const logged = d.deficit != null && d.meals.length > 0;
    const future = d.date > today;
    const words = logged
      ? `${fmt.int(d.intake)} kcal eaten · ${fmt.int(Math.abs(d.deficit))} ${d.deficit < 0 ? 'over' : 'below'} the burn · ${standingWord(d.standing)}`
      : future ? 'ahead' : d.meals.length ? `${fmt.int(d.intake)} kcal eaten · no burn from the watch` : 'nothing logged';
    const cell = el(onTap ? 'button' : 'div', {
      class: `calweek-cell ${logged ? toneClass(d.standing) : 'tone-none'}`
        + `${d.date === today ? ' is-today' : ''}${d.date === current ? ' is-current' : ''}`
        + `${future ? ' is-ahead' : ''}${logged ? '' : ' is-empty'}`,
      role: 'listitem', type: onTap ? 'button' : null,
      title: `${fmt.dowDate(d.date)}: ${words}`, 'aria-label': `${fmt.dowDate(d.date)}: ${words}`,
      on: onTap ? { click: () => onTap(d) } : null,
    }, [
      el('span', { class: 'calweek-dow', text: fmt.dow(d.date) }),
      el('b', { class: 'calweek-n num', text: logged ? fmt.int(Math.abs(d.deficit)) : future ? '' : '–' }),
      /* Today's figure is a projection until midnight, and the cell says so
         in two words. A dashed rule was tried first and had to be asked
         about. */
      logged && d.burn && d.burn.estimated ? el('span', { class: 'calweek-est', text: 'so far' }) : null,
      el('i', { 'aria-hidden': 'true' }),
    ]);
    strip.append(cell);
  }
  return strip;
}

/** The three colours, named once, for under the strip and the chart. */
export function colourKey(target = 500) {
  const key = el('ul', { class: 'calkey', 'aria-label': 'Key' });
  key.append(el('li', { class: 'calkey-note' }, [el('span', { text: 'number = kcal deficit' })]));
  for (const k of legendFor(target)) {
    key.append(el('li', { class: `tone-${k.tone}` }, [
      el('i', { 'aria-hidden': 'true' }), el('span', { text: k.label }),
    ]));
  }
  return key;
}
