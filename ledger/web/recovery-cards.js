/* Recovery cards — one card per measure: last night large, then the windows
 * beneath it, each read against the scale named on the card.
 *
 * Shared by two pages. `#/recovery` draws all seven measures with its range
 * row; `#/week` draws five as the morning snapshot. One builder, one list of
 * measures and one `readingOf`, so the big number on the front page and the
 * same number on the Recovery page are the same DOM from the same rows and
 * cannot disagree — the failure this codebase has had most often is one
 * figure computed twice.
 *
 * Colour here is a reading on a published scale: Garmin's bands, the balanced
 * HRV range Garmin fits to the wearer, the sleep need it fits, or the
 * wearer's own 28-night resting-HR mean. Never a threshold the app chose.
 */

import { el, icon, fmt, addDays } from './core.js';
import {
  isNum, summarise, latest, bandFor, hrvRange, hrvBand, sleepNeed, sleepBand, rhrBand,
} from './recovery.js';

export const BASELINE_NIGHTS = 28;

/* One entry per measure, in the order the cards and the charts use. The
   icon and hue are fixed to the measure the way a kind's colour is fixed to
   its modality, so sleep is the same indigo moon on every surface. */
export const METRICS = [
  { key: 'sleep_hours', label: 'Sleep', unit: 'h', digits: 1, icon: 'moon', hue: 'sleep', against: (ctx) => (ctx.need ? `need ${ctx.need.toFixed(1)} h` : null) },
  { key: 'sleep_score', label: 'Sleep score', unit: '', digits: 0, icon: 'score', hue: 'sleep', against: () => 'Garmin\'s bands' },
  { key: 'hrv_ms', label: 'HRV', unit: 'ms', digits: 0, icon: 'pulse', hue: 'hrv', against: (ctx) => (ctx.range ? `balanced ${ctx.range.low}–${ctx.range.high} ms` : null) },
  { key: 'resting_hr', label: 'Resting HR', unit: 'bpm', digits: 0, icon: 'heart', hue: 'rhr', against: (ctx) => (ctx.rhrMean != null ? `28-night mean ${Math.round(ctx.rhrMean)}` : null) },
  { key: 'readiness', label: 'Readiness', unit: '', digits: 0, icon: 'gauge', hue: 'ink-2', against: () => 'Garmin\'s bands' },
  { key: 'stress_avg', label: 'Stress', unit: '', digits: 0, icon: 'stress', hue: 'stress', against: () => 'Garmin\'s bands' },
  { key: 'body_battery_wake', label: 'Body battery', unit: '', digits: 0, icon: 'battery', hue: 'battery', against: () => 'Garmin\'s bands' },
];
export const metricOf = (key) => METRICS.find((m) => m.key === key);

/* The five the front page shows. Sleep score and stress stay on #/recovery:
   the score is Garmin's own roll-up of the sleep card beside it, and stress
   is a daytime figure on a page about the night. */
export const SNAPSHOT_KEYS = ['sleep_hours', 'hrv_ms', 'resting_hr', 'readiness', 'body_battery_wake'];

/** The thresholds every reading is made against: the wearer's 28-night
 *  resting-HR mean (only once seven nights back it), Garmin's sleep need and
 *  balanced HRV range — the latest the baseline rows carry, else the latest
 *  in the wider range, so a window the backfill has not reached is still read
 *  against something, and says what. */
export function recoveryContext(baseRows, rows = baseRows) {
  const rhrMean = summarise(baseRows, 'resting_hr');
  return {
    rhrMean: rhrMean.n >= 7 ? rhrMean.value : null,
    need: sleepNeed(baseRows) || sleepNeed(rows),
    range: hrvRange(baseRows) || hrvRange(rows),
  };
}

/* The band a value of `key` falls in, for the cards, the table and the
   charts alike. One function so the big number at the top and the column
   below it can never disagree about what a night was. */
export function readingOf(ctx, key, value, row = null) {
  const { rhrMean, need, range } = ctx;
  const ownNeed = row && isNum(row.sleep_need_min) ? Number(row.sleep_need_min) / 60 : null;
  if (key === 'sleep_hours') return sleepBand(value, ownNeed || need);
  if (key === 'hrv_ms') return hrvBand(value, (row && isNum(row.hrv_balanced_low)) ? hrvRange([], row) : range);
  if (key === 'resting_hr') return rhrBand(value, rhrMean);
  if (key === 'body_battery_wake') return bandFor('body_battery', value);
  return bandFor(key, value);
}

/** A band as a tag. No band, no tag. */
export const tag = (band) => (band
  ? el('span', { class: `rc-tag${band.tone ? ` tone-${band.tone}` : ' rc-tag-none'}`, text: band.label })
  : null);

/** The newest night on record: the row the big numbers are read from. */
export const lastNight = (baseRows) => latest(baseRows, 'sleep_hours') || latest(baseRows, 'resting_hr');

/** "Sat, Oct 31 → Sun, Nov 1", with a note when that is not last night. */
export function nightOfText(last, today) {
  const nightOf = `${fmt.dowDate(addDays(last.date, -1))} → ${fmt.dowDate(last.date)}`;
  return `${nightOf}${last.date === today ? '' : ' — nothing newer has synced'}`;
}

const fmtV = (m, v) => (v == null ? '—' : `${Number(v).toFixed(m.digits)}`);

/**
 * One card. `rows` is the list of windows under the big number, in order:
 * `[['This week', weekRows], ['Last 28 nights', baseRows], ...]`. The count
 * sits beside each mean, so the label stays a label.
 */
export function measureCard(m, ctx, { last, baseRows, rows }) {
  const row = (label, s) => {
    const band = readingOf(ctx, m.key, s.value);
    return el('div', {}, [
      el('dt', { text: label }),
      el('dd', { class: band && band.tone ? `is-toned tone-${band.tone}` : null }, [
        el('span', { class: 'rc-row-v', text: s.value == null ? '—' : `${fmtV(m, s.value)}${m.unit ? ` ${m.unit}` : ''}` }),
        s.value != null && s.n != null ? document.createTextNode(' ') : null,
        s.value != null && s.n != null ? el('span', { class: 'rc-n', text: `·${s.n}` }) : null,
        s.value != null ? document.createTextNode(' ') : null,
        s.value != null ? tag(band) : null,
      ].filter(Boolean)),
    ]);
  };

  const lastRow = latest(baseRows, m.key);
  const lastVal = lastRow && lastRow.date === last.date ? lastRow[m.key] : null;
  const band = lastVal != null ? readingOf(ctx, m.key, lastVal, last) : null;
  const against = m.against(ctx);
  return el('article', { class: 'rc-card', style: `--rc-hue:var(--${m.hue})` }, [
    el('header', { class: 'rc-card-head' }, [
      icon(m.icon),
      el('span', { class: 'rc-card-name', text: m.label }),
      against ? document.createTextNode(' ') : null,
      against ? el('span', { class: 'rc-against', text: against }) : null,
    ].filter(Boolean)),
    el('div', { class: `rc-card-now${band && band.tone ? ` is-toned tone-${band.tone}` : ''}` }, [
      el('span', { class: 'rc-big-v' }, [
        el('span', { text: fmtV(m, lastVal) }),
        m.unit && lastVal != null ? document.createTextNode(' ') : null,
        m.unit && lastVal != null ? el('u', { text: m.unit }) : null,
      ].filter(Boolean)),
      document.createTextNode(' '),
      lastVal != null ? tag(band) : el('span', { class: 'rc-tag rc-tag-none', text: 'no reading' }),
    ].filter(Boolean)),
    lastVal == null ? el('p', { class: 'rc-card-when', text: 'no reading last night' }) : null,
    el('dl', { class: 'rc-card-rows' }, rows.map(([label, list]) => row(label, summarise(list, m.key)))),
  ].filter(Boolean));
}

/**
 * The grid of cards. `keys` picks the measures (default: every one); a
 * measure with no reading in the baseline rows is left out rather than drawn
 * empty. `data-n` carries the count so the grid can take its track count from
 * how many cards there actually are.
 */
export function measureCards(ctx, { last, baseRows, rows, keys = null }) {
  const cards = el('div', { class: 'rc-cards' });
  const picked = keys ? keys.map(metricOf) : METRICS;
  for (const m of picked) {
    if (!baseRows.some((r) => isNum(r[m.key]))) continue;
    cards.append(measureCard(m, ctx, { last, baseRows, rows }));
  }
  cards.dataset.n = String(cards.children.length);
  return cards;
}
