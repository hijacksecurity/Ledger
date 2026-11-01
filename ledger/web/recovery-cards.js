/* Recovery cards — one card per measure: last night large, a meter showing
 * where it sits on its scale, then the windows beneath it, each read against
 * the scale named on the card.
 *
 * Shared by two pages. `#/recovery` draws all seven measures with its range
 * row; `#/week` draws six as the morning snapshot. One builder, one list of
 * measures and one `readingOf`, so the big number on the front page and the
 * same number on the Recovery page are the same DOM from the same rows and
 * cannot disagree — the failure this codebase has had most often is one
 * figure computed twice.
 *
 * Colour here is a reading on a published scale: Garmin's bands, the balanced
 * HRV range Garmin fits to the wearer, the sleep need it fits, or the
 * wearer's own 28-night resting-HR mean. Never a threshold the app chose.
 * The meter under each number draws that scale — its segments are the bands,
 * the shaded stretch is the range, the tick is the need or the mean — so the
 * reading can be seen before the word beside it is read. The word is still
 * printed; colour never carries it alone.
 */

import { el, icon, fmt, addDays } from './core.js';
import {
  isNum, summarise, latest, bandFor, hrvRange, hrvBand, sleepNeed, sleepBand, rhrBand, BANDS,
} from './recovery.js';

export const BASELINE_NIGHTS = 28;

/* One entry per measure, in the order the cards and the charts use. The
   icon and hue are fixed to the measure the way a kind's colour is fixed to
   its modality, so sleep is the same indigo moon on every surface. `meter`
   names which scale the bar under the number draws. */
export const METRICS = [
  { key: 'sleep_hours', label: 'Sleep', unit: 'h', digits: 1, icon: 'moon', hue: 'sleep', meter: 'need', against: (ctx) => (ctx.need ? `need ${ctx.need.toFixed(1)} h` : null) },
  { key: 'sleep_score', label: 'Sleep score', unit: '', digits: 0, icon: 'score', hue: 'sleep', meter: 'bands', scale: 'sleep_score', against: () => 'Garmin\'s bands' },
  { key: 'hrv_ms', label: 'HRV', unit: 'ms', digits: 0, icon: 'pulse', hue: 'hrv', meter: 'range', against: (ctx) => (ctx.range ? `balanced ${ctx.range.low}–${ctx.range.high} ms` : null) },
  { key: 'resting_hr', label: 'Resting HR', unit: 'bpm', digits: 0, icon: 'heart', hue: 'rhr', meter: 'mean', against: (ctx) => (ctx.rhrMean != null ? `28-night mean ${Math.round(ctx.rhrMean)}` : null) },
  { key: 'readiness', label: 'Readiness', unit: '', digits: 0, icon: 'gauge', hue: 'ink-2', meter: 'bands', scale: 'readiness', against: () => 'Garmin\'s bands' },
  { key: 'stress_avg', label: 'Stress', unit: '', digits: 0, icon: 'stress', hue: 'stress', meter: 'bands', scale: 'stress_avg', against: () => 'Garmin\'s bands' },
  { key: 'body_battery_wake', label: 'Body battery', unit: '', digits: 0, icon: 'battery', hue: 'battery', meter: 'bands', scale: 'body_battery', against: () => 'Garmin\'s bands' },
];
export const metricOf = (key) => METRICS.find((m) => m.key === key);

/* The six the front page shows — an even grid, three by two. Stress stays
   on #/recovery: it is a daytime figure on a panel about the night. */
export const SNAPSHOT_KEYS = ['sleep_hours', 'sleep_score', 'hrv_ms', 'resting_hr', 'readiness', 'body_battery_wake'];

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

/** A band as a reading: a dot in the tone and the band's own word. No
 *  band, no reading. `small` is the row form under the big number. */
export function tag(band, small = false) {
  if (!band) return null;
  return el('span', {
    class: `rc-read${small ? ' rc-read-sm' : ''}${band.tone ? ` tone-${band.tone}` : ' rc-read-none'}`,
    text: band.label,
  });
}

/** The newest night on record: the row the big numbers are read from. */
export const lastNight = (baseRows) => latest(baseRows, 'sleep_hours') || latest(baseRows, 'resting_hr');

/** "Sat, Oct 31 → Sun, Nov 1", with a note when that is not last night. */
export function nightOfText(last, today) {
  const nightOf = `${fmt.dowDate(addDays(last.date, -1))} → ${fmt.dowDate(last.date)}`;
  return `${nightOf}${last.date === today ? '' : ' — nothing newer has synced'}`;
}

const fmtV = (m, v) => (v == null ? '—' : `${Number(v).toFixed(m.digits)}`);
const pctN = (v, lo, hi) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
const pct = (v, lo, hi) => `${pctN(v, lo, hi).toFixed(1)}%`;

/* ── the meter ───────────────────────────────────────────────────────────── */

/* A segment of the track: `[lo, hi]` on the meter's own domain, in a tone.
   `on` lights it — the segment the reading falls in. */
const seg = (lo, hi, dLo, dHi, tone, on = false) => el('i', {
  class: `rc-seg${tone ? ` tone-${tone}` : ' tone-none'}${on ? ' is-on' : ''}`,
  style: `left:${pct(lo, dLo, dHi)};width:${(pctN(hi, dLo, dHi) - pctN(lo, dLo, dHi)).toFixed(1)}%`,
});
const tick = (v, dLo, dHi, label) => el('i', { class: 'rc-tick', style: `left:${pct(v, dLo, dHi)}`, title: label });
const mark = (v, dLo, dHi, tone) => el('b', { class: `rc-mark${tone ? ` tone-${tone}` : ' tone-none'}`, style: `left:${pct(v, dLo, dHi)}` });

/**
 * The scale under the number. Four kinds:
 *   bands — Garmin's 0–100 bands as segments, the one the value sits in lit;
 *   range — the balanced HRV range shaded on a track, the value as a mark;
 *   need  — hours filled toward the need, the need as a tick;
 *   mean  — the 28-night mean at centre, ±3 near it, the value as a mark.
 * With no value the track is drawn and nothing sits on it.
 */
export function meter(m, ctx, value, band) {
  const v = isNum(value) ? Number(value) : null;
  const tone = band ? band.tone : null;
  const track = el('div', { class: 'rc-meter', 'data-kind': m.meter, 'aria-hidden': 'true' });

  if (m.meter === 'bands') {
    const bands = [...(BANDS[m.scale] || [])].sort((a, b) => a.min - b.min);
    bands.forEach((b, i) => {
      const hi = i + 1 < bands.length ? bands[i + 1].min : 100;
      track.append(seg(b.min, hi, 0, 100, b.tone, band && band.label === b.label));
    });
    if (v != null) track.append(mark(v, 0, 100, tone));
    return track;
  }

  if (m.meter === 'range') {
    const r = ctx.range;
    if (!r) return track;
    const pad = Math.max(8, (r.high - r.low) * 0.6);
    const lo = Math.max(0, r.low - pad);
    const hi = r.high + pad;
    if (r.lowUpper != null && r.lowUpper > lo) {
      track.append(seg(lo, r.lowUpper, lo, hi, 'poor', band && band.label === 'Low'));
      track.append(seg(r.lowUpper, r.low, lo, hi, 'thin', band && band.label === 'Below range'));
    } else {
      track.append(seg(lo, r.low, lo, hi, 'thin', band && (band.label === 'Below range' || band.label === 'Low')));
    }
    track.append(seg(r.low, r.high, lo, hi, 'solid', band && band.label === 'Balanced'));
    track.append(seg(r.high, hi, lo, hi, 'mixed', band && band.label === 'Above range'));
    if (v != null) track.append(mark(v, lo, hi, tone));
    return track;
  }

  if (m.meter === 'need') {
    const need = ctx.need;
    if (!need) return track;
    const hi = Math.max(need, v || 0) * 1.12;
    track.append(seg(0, need - 1, 0, hi, 'poor', band && band.label === '>1 h short'));
    track.append(seg(need - 1, need, 0, hi, 'mixed', band && band.label === '<1 h short'));
    track.append(seg(need, hi, 0, hi, 'solid', band && band.label === 'Need met'));
    track.append(tick(need, 0, hi, `need ${need.toFixed(1)} h`));
    if (v != null) {
      track.append(el('i', { class: `rc-fill${tone ? ` tone-${tone}` : ''}`, style: `width:${pct(v, 0, hi)}` }));
      track.append(mark(v, 0, hi, tone));
    }
    return track;
  }

  if (m.meter === 'mean') {
    const mean = ctx.rhrMean;
    if (mean == null) return track;
    const lo = mean - 8; const hi = mean + 8;
    track.append(seg(lo, mean - 3, lo, hi, 'solid', band && band.label === '3+ under mean'));
    track.append(seg(mean - 3, mean + 3, lo, hi, null, band && band.label === 'Near mean'));
    track.append(seg(mean + 3, mean + 5, lo, hi, 'thin', band && band.label === '3–4 over mean'));
    track.append(seg(mean + 5, hi, lo, hi, 'poor', band && band.label === '5+ over mean'));
    track.append(tick(mean, lo, hi, `mean ${Math.round(mean)}`));
    if (v != null) track.append(mark(v, lo, hi, tone));
    return track;
  }
  return track;
}

/* ── sleep structure, for the sleep card ─────────────────────────────────── */

const hm = (min) => {
  const h = Math.floor(min / 60); const mm = Math.round(min % 60);
  return h ? `${h}h${String(mm).padStart(2, '0')}` : `${mm}m`;
};

/** Last night's stages as one bar: deep, REM, light, awake — when the row
 *  carries them. Light is what is left once deep and REM are taken out. */
function stagesBar(row) {
  if (!row || !isNum(row.deep_min) || !isNum(row.rem_min) || !isNum(row.sleep_hours)) return null;
  const asleep = Number(row.sleep_hours) * 60;
  const deep = Number(row.deep_min); const rem = Number(row.rem_min);
  const light = Math.max(0, asleep - deep - rem);
  const awake = isNum(row.awake_min) ? Number(row.awake_min) : 0;
  const total = deep + rem + light + awake;
  if (!total) return null;
  const parts = [['deep', deep], ['rem', rem], ['light', light], ['awake', awake]].filter(([, v]) => v > 0);
  return el('div', { class: 'rc-stages' }, [
    el('div', { class: 'rc-stages-bar' }, parts.map(([k, v]) => el('i', { class: `rc-st-${k}`, style: `width:${(v / total) * 100}%`, title: `${k} ${hm(v)}` }))),
    el('div', { class: 'rc-stages-key' }, parts.map(([k, v]) => el('span', { class: `rc-st-${k}` }, [
      el('i'), el('span', { text: `${k === 'rem' ? 'REM' : k} ${hm(v)}` }),
    ]))),
  ]);
}

/* ── the card ────────────────────────────────────────────────────────────── */

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
        s.value != null ? tag(band, true) : null,
      ].filter(Boolean)),
    ]);
  };

  const lastRow = latest(baseRows, m.key);
  const lastVal = lastRow && lastRow.date === last.date ? lastRow[m.key] : null;
  const band = lastVal != null ? readingOf(ctx, m.key, lastVal, last) : null;
  const against = m.against(ctx);
  const toned = band && band.tone ? ` is-toned tone-${band.tone}` : '';
  return el('article', { class: `rc-card${toned}`, 'data-key': m.key, style: `--rc-hue:var(--${m.hue})` }, [
    el('header', { class: 'rc-card-head' }, [
      el('span', { class: 'rc-ico' }, [icon(m.icon)]),
      el('span', { class: 'rc-card-name', text: m.label }),
      against ? document.createTextNode(' ') : null,
      against ? el('span', { class: 'rc-against', text: against }) : null,
    ].filter(Boolean)),
    el('div', { class: 'rc-card-now' }, [
      el('span', { class: 'rc-big-v' }, [
        el('span', { text: fmtV(m, lastVal) }),
        m.unit && lastVal != null ? document.createTextNode(' ') : null,
        m.unit && lastVal != null ? el('u', { text: m.unit }) : null,
      ].filter(Boolean)),
      document.createTextNode(' '),
      lastVal != null
        ? (tag(band) || el('span', { class: 'rc-read rc-read-none', text: 'no scale yet' }))
        : el('span', { class: 'rc-read rc-read-none', text: 'no reading last night' }),
    ].filter(Boolean)),
    meter(m, ctx, lastVal, band),
    m.key === 'sleep_hours' && lastVal != null ? stagesBar(last) : null,
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
