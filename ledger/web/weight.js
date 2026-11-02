/* Ledger — bodyweight, specified once.
 *
 * Two pages draw the weigh-ins: All time, where the whole record sits under
 * the activities-per-week chart, and Calories, where the last few months sit
 * under the deficit they are supposed to follow. One spec and one set of
 * sums, so the line cannot be smoothed on one page and raw on the other, and
 * a pace quoted on one page is the pace on the other.
 *
 * Pure: returns specs and numbers for the views to draw. No DOM, no fetch.
 */

import { fmt, inUnit, lbToKg, token } from './core.js';

const DAY = 86400000;
const at = (iso) => new Date(`${iso}T00:00:00`).getTime();

/** Readings inside the last `weeks` weeks of the series, oldest first. */
export function weighInsWithin(series, weeks) {
  const bw = (series || []).filter((p) => p.kg != null);
  if (!weeks || !bw.length) return bw;
  const cutoff = at(bw[bw.length - 1].date) - weeks * 7 * DAY;
  return bw.filter((p) => at(p.date) >= cutoff);
}

/**
 * spec for a `figure()` of raw weigh-ins in `unit` ('lb' | 'kg').
 *
 *   goalLb     a goal weight in pounds, drawn as a dashed guide; null for none
 *   annotate   'extremes' labels the high, the low and the endpoint on the
 *              line (the All-time flagship); false leaves the line clean and
 *              lets the tiles carry the figures
 *   markers    ring every weigh-in
 *   padLeft /  forced so a stacked small multiple shares an x origin
 *   padRight
 */
export function weightFigureSpec(bw, unit, {
  goalLb = null, padLeft, padRight, height = 300, aria, annotate = 'extremes',
  markers = false, color = null,
} = {}) {
  const u = unit === 'kg' ? 'kg' : 'lb';
  const other = u === 'kg' ? 'lb' : 'kg';
  const conv = (kg) => inUnit(kg, u);
  const guides = [];
  if (goalLb != null) {
    const goal = inUnit(lbToKg(goalLb), u);
    /* The axis stretches to a goal only when it is close to the readings —
       within the readings' own spread, or a few pounds. Further away it is
       drawn at the chart's edge, labelled, and the line keeps its shape. */
    const vals = bw.map((p) => conv(p.kg));
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const reach = Math.max(hi - lo, u === 'kg' ? 1.5 : 3);
    const near = goal >= lo - reach && goal <= hi + reach;
    guides.push({
      value: goal, color: token('ink-3'), dashed: true, fit: near,
      label: near ? `goal ${fmt.whole(goal)} ${u}` : `goal ${fmt.whole(goal)} ${u} ${goal < lo ? '↓' : '↑'}`,
      short: `goal ${fmt.whole(goal)}${near ? '' : goal < lo ? ' ↓' : ' ↑'}`,
    });
  }
  return {
    type: 'line',
    aria: aria || `Bodyweight readings in ${u === 'kg' ? 'kilograms' : 'pounds'}`,
    height, unit: u, periodLabel: 'Date',
    padLeft, padRight,
    annotate,
    markers,
    guides,
    /* The readings, and only the readings. A seven-day trend used to run
       behind them; it was the last smoothed line on the site and the user
       asked for it to go — what the scale said is the number, and a line
       the scale never produced beside it reads as a second opinion. The
       server still publishes `ema`; nothing draws it. */
    series: [{ key: 'raw', label: 'Weigh-in', color: color || token('ink-2') }],
    points: bw.map((p) => ({
      key: p.date, label: fmt.date(p.date), group: p.date.slice(0, 4),
      values: { raw: conv(p.kg) },
      note: `${inUnit(p.kg, other).toFixed(1)} ${other}`,
    })),
    format: (v) => `${v.toFixed(1)}`,
    formatShort: (v) => v.toFixed(0),
  };
}

/**
 * A stat tile: the change from the last reading at least `weeks` ago to the
 * latest. Reading to reading — both ends were measured, so the difference is
 * one you could have worked out from two mornings on the scale.
 */
export function weightDeltaTile(bw, weeks, unit, label = `${weeks} weeks`) {
  const u = unit === 'kg' ? 'kg' : 'lb';
  const conv = (kg) => inUnit(kg, u);
  const last = bw[bw.length - 1];
  const cutoff = at(last.date) - weeks * 7 * DAY;
  const prior = bw.filter((p) => at(p.date) <= cutoff).pop();
  if (!prior) return { label, value: '—', note: 'not enough history in range' };
  return {
    label, value: fmt.wholeSigned(conv(last.kg) - conv(prior.kg)), unit: u,
    note: `from ${fmt.whole(conv(prior.kg))} on ${fmt.dateY(prior.date)}`,
  };
}

/**
 * The sums behind the Calories page's bodyweight panel, in `unit`:
 *
 *   latest        the last reading, and its date
 *   change        latest − first reading in the window (reading to reading)
 *   pacePerWeek   the least-squares slope over the window, per week; null
 *                 under three readings or under a week of span
 *   toGoal        goal − latest (negative = still to lose); null without a goal
 *   etaDate       the date the slope reaches the goal, or null when it is not
 *                 heading there (or is already there, or is too slow to say)
 *   direction     'toward' | 'away' | 'flat' — flat under 0.5 lb of change.
 *                 With no goal, down counts as toward: this panel sits on a
 *                 deficit page, and the title says so.
 *
 * Nothing here is smoothed onto the chart; these are figures for tiles.
 */
export function weightStats(bw, unit, { goalLb = null } = {}) {
  const u = unit === 'kg' ? 'kg' : 'lb';
  const conv = (kg) => inUnit(kg, u);
  if (!bw.length) return null;
  const last = bw[bw.length - 1];
  const first = bw[0];
  const latest = conv(last.kg);
  const change = latest - conv(first.kg);
  const spanDays = (at(last.date) - at(first.date)) / DAY;

  let pacePerWeek = null;
  if (bw.length >= 3 && spanDays >= 7) {
    const xs = bw.map((p) => (at(p.date) - at(first.date)) / DAY);
    const ys = bw.map((p) => conv(p.kg));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    pacePerWeek = den ? (num / den) * 7 : null;
  }

  const goal = goalLb == null ? null : inUnit(lbToKg(goalLb), u);
  const toGoal = goal == null ? null : goal - latest;
  const flatBelow = u === 'kg' ? 0.23 : 0.5;
  let direction = 'flat';
  if (Math.abs(change) >= flatBelow) {
    const want = toGoal == null ? -1 : Math.sign(toGoal);   // which way is "toward"
    direction = Math.sign(change) === want ? 'toward' : 'away';
  }

  let etaDate = null;
  if (toGoal != null && pacePerWeek != null && Math.abs(toGoal) >= flatBelow
      && Math.sign(pacePerWeek) === Math.sign(toGoal) && Math.abs(pacePerWeek) >= 0.05) {
    const weeks = toGoal / pacePerWeek;
    if (weeks <= 260) etaDate = new Date(at(last.date) + weeks * 7 * DAY);
  }

  return {
    unit: u, latest, latestDate: last.date, first: conv(first.kg), firstDate: first.date,
    change, pacePerWeek, goal, toGoal, etaDate, direction, count: bw.length,
    low: Math.min(...bw.map((p) => conv(p.kg))), high: Math.max(...bw.map((p) => conv(p.kg))),
  };
}

/** The tone a direction takes: toward is green, away red, flat none. */
export const directionTone = (direction) => (
  direction === 'toward' ? 'strong' : direction === 'away' ? 'poor' : 'none'
);
