/* Recovery — the derived layer for the watch's nightly numbers.
 *
 * Pure functions over `/api/metrics` rows and `/api/sessions` items. No DOM,
 * no network, so every figure on #/recovery can be checked by reading one
 * file. The rules it plays by:
 *
 *   · Garmin's scores are read on Garmin's scale. Readiness, sleep score,
 *     stress and body battery each come with published, named bands
 *     (Prime / High / Moderate / Low / Poor and so on), and the page uses
 *     those names rather than inventing its own.
 *   · Personal thresholds are Garmin's personal thresholds. A night's HRV is
 *     judged against the wearer's own balanced range and a night's length
 *     against the wearer's own sleep need — both fitted by the watch, both
 *     stored with the row. Nothing here uses "eight hours" or "50 ms".
 *   · Resting heart rate has no Garmin band, so it is read against the
 *     wearer's own 28-night mean, and the page says so.
 *   · Nulls are gaps. A night the watch was not worn contributes nothing to
 *     any mean, and every mean carries its own count.
 *
 * Which night is which: a `metric_daily` row dated D holds the night that
 * *ended* on the morning of D. So the night *before* a session on D is row D,
 * and the night *after* a day D is row D+1.
 */

import { dateOf, addDays } from './core.js';
import { WEEKDAYS } from './dataset.js';

/* ── arithmetic ─────────────────────────────────────────────────────────── */

export const isNum = (v) => v != null && Number.isFinite(Number(v));

export function mean(values) {
  const xs = values.filter(isNum).map(Number);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(values) {
  const xs = values.filter(isNum).map(Number).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** {value, n} for one column over a list of rows. */
export function summarise(rows, key) {
  const xs = rows.map((r) => r[key]).filter(isNum).map(Number);
  return { value: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, n: xs.length };
}

/** The most recent row that has a value for `key`. */
export function latest(rows, key) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i][key];
    if (isNum(v) || (typeof v === 'string' && v)) return rows[i];
  }
  return null;
}

/** Extremes of one column: {min:{date,value}, max:{date,value}} or null. */
export function extremes(rows, key) {
  let lo = null;
  let hi = null;
  for (const r of rows) {
    if (!isNum(r[key])) continue;
    const v = Number(r[key]);
    if (!lo || v < lo.value) lo = { date: r.date, value: v };
    if (!hi || v > hi.value) hi = { date: r.date, value: v };
  }
  return lo ? { min: lo, max: hi } : null;
}

/* ── Garmin's bands ──────────────────────────────────────────────────────── */

/* Each band: the lowest value that belongs to it, its Garmin name, and the
   tone it maps to on the app's five-step ramp. Listed from the top down;
   `bandFor` takes the first whose floor the value reaches. The tone is the
   only thing the page adds: Garmin colours its own bands similarly. */
export const BANDS = {
  sleep_score: [
    { min: 90, label: 'Excellent', tone: 'strong' },
    { min: 80, label: 'Good', tone: 'solid' },
    { min: 60, label: 'Fair', tone: 'mixed' },
    { min: 0, label: 'Poor', tone: 'poor' },
  ],
  readiness: [
    { min: 95, label: 'Prime', tone: 'strong' },
    { min: 75, label: 'High', tone: 'solid' },
    { min: 50, label: 'Moderate', tone: 'mixed' },
    { min: 25, label: 'Low', tone: 'thin' },
    { min: 0, label: 'Poor', tone: 'poor' },
  ],
  /* Lower is better, so the ramp runs the other way. */
  stress_avg: [
    { min: 76, label: 'High', tone: 'poor' },
    { min: 51, label: 'Medium', tone: 'thin' },
    { min: 26, label: 'Low', tone: 'mixed' },
    { min: 0, label: 'Rest', tone: 'solid' },
  ],
  body_battery: [
    { min: 76, label: 'Very high', tone: 'strong' },
    { min: 51, label: 'High', tone: 'solid' },
    { min: 26, label: 'Medium', tone: 'thin' },
    { min: 0, label: 'Low', tone: 'poor' },
  ],
};

/** The band a value falls in, or null. */
export function bandFor(scale, value) {
  if (!isNum(value)) return null;
  const v = Number(value);
  const bands = BANDS[scale] || [];
  return bands.find((b) => v >= b.min) || null;
}

/**
 * Garmin's personal HRV range, as carried on the row — or the most recent
 * row that has one, since the range moves slowly and the backfill may not
 * have reached every night.
 */
export function hrvRange(rows, row) {
  const pick = (r) => (r && isNum(r.hrv_balanced_low) && isNum(r.hrv_balanced_high)
    ? { low: Number(r.hrv_balanced_low), high: Number(r.hrv_balanced_high), lowUpper: isNum(r.hrv_low_upper) ? Number(r.hrv_low_upper) : null, from: r.date }
    : null);
  if (row) {
    const own = pick(row);
    if (own) return own;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = pick(rows[i]);
    if (r) return r;
  }
  return null;
}

/** A night's HRV against the personal range. Garmin's names. */
export function hrvBand(value, range) {
  if (!isNum(value) || !range) return null;
  const v = Number(value);
  if (v > range.high) return { label: 'Above range', tone: 'mixed' };
  if (v >= range.low) return { label: 'Balanced', tone: 'solid' };
  if (range.lowUpper != null && v < range.lowUpper) return { label: 'Low', tone: 'poor' };
  return { label: 'Below range', tone: 'thin' };
}

/** Garmin's sleep need for a night, in hours — the row's own, or the latest. */
export function sleepNeed(rows, row) {
  const pick = (r) => (r && isNum(r.sleep_need_min) ? Number(r.sleep_need_min) / 60 : null);
  if (row) {
    const own = pick(row);
    if (own) return own;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = pick(rows[i]);
    if (v) return v;
  }
  return null;
}

/** A night's length against the need: met, within an hour, or more short. */
export function sleepBand(hours, need) {
  if (!isNum(hours) || !need) return null;
  const h = Number(hours);
  if (h >= need) return { label: 'Need met', tone: 'solid' };
  if (h >= need - 1) return { label: '<1 h short', tone: 'mixed' };
  return { label: '>1 h short', tone: 'poor' };
}

/** Resting HR against the wearer's own 28-night mean. Lower is better. */
export function rhrBand(value, baselineMean) {
  if (!isNum(value) || !isNum(baselineMean)) return null;
  const d = Number(value) - Number(baselineMean);
  if (d >= 5) return { label: '5+ over mean', tone: 'poor' };
  if (d >= 3) return { label: '3–4 over mean', tone: 'thin' };
  if (d <= -3) return { label: '3+ under mean', tone: 'solid' };
  return { label: 'Near mean', tone: null };
}

/* ── sleep structure ─────────────────────────────────────────────────────── */

/** Light sleep is what is left once deep and REM are taken out. */
export function lightMinutes(row) {
  if (!isNum(row.sleep_hours) || !isNum(row.deep_min) || !isNum(row.rem_min)) return null;
  return Math.max(0, Math.round(Number(row.sleep_hours) * 60) - Number(row.deep_min) - Number(row.rem_min));
}

/** Mean minutes per stage over the nights that have stages. */
export function stageSplit(rows) {
  const staged = rows.filter((r) => isNum(r.deep_min) && isNum(r.rem_min) && isNum(r.sleep_hours));
  const of = rows.filter((r) => isNum(r.sleep_hours)).length;
  if (!staged.length) return { n: 0, of, parts: null };
  return {
    n: staged.length,
    of,
    parts: {
      deep: mean(staged.map((r) => r.deep_min)),
      rem: mean(staged.map((r) => r.rem_min)),
      light: mean(staged.map(lightMinutes)),
      awake: mean(staged.map((r) => (isNum(r.awake_min) ? r.awake_min : null))) ?? 0,
    },
  };
}

/* ── by weekday ──────────────────────────────────────────────────────────── */

/** Mean of `key` per weekday. The row dated D is the night ending on D, so a
 *  "Thursday" figure is the night of Wednesday into Thursday. */
export function byWeekday(rows, key) {
  const out = WEEKDAYS.map((label) => ({ key: label, label, values: [], n: 0, value: null }));
  for (const r of rows) {
    if (!isNum(r[key])) continue;
    const i = (dateOf(r.date).getDay() + 6) % 7;
    out[i].values.push(Number(r[key]));
  }
  for (const o of out) { o.n = o.values.length; o.value = mean(o.values); }
  return out;
}

/* ── training ↔ night ────────────────────────────────────────────────────── */

/** Daily load and what was done, keyed by date. */
export function daysOfTraining(sessions) {
  const days = new Map();
  for (const s of sessions) {
    if (s.kind === 'fast') continue;   // a fast is a day's state, not a session
    const d = days.get(s.date) || { date: s.date, load: 0, kinds: new Set(), sessions: [] };
    d.load += Number(s.load || 0);
    d.kinds.add(s.kind);
    d.sessions.push(s);
    days.set(s.date, d);
  }
  return days;
}

/**
 * Classify each calendar day in [from, to] by what was done on it:
 * `match` (a soccer session), `hard` / `easy` (a training day at or above /
 * below the median daily load of non-match training days in the window),
 * `rest`. The split point is returned so the table can print it.
 */
export function classifyDays(sessions, from, to) {
  const trained = daysOfTraining(sessions);
  const loads = [...trained.values()].filter((d) => !d.kinds.has('soccer')).map((d) => d.load);
  const split = median(loads);
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const t = trained.get(d);
    let kind = 'rest';
    if (t) {
      if (t.kinds.has('soccer')) kind = 'match';
      else kind = split != null && t.load >= split ? 'hard' : 'easy';
    }
    out.push({ date: d, kind, load: t ? t.load : 0, kinds: t ? [...t.kinds] : [] });
  }
  return { days: out, split };
}

export const DAY_KINDS = [
  ['match', 'Match day'],
  ['hard', 'Hard training day'],
  ['easy', 'Easy training day'],
  ['rest', 'Rest day'],
];

/**
 * The morning after. For each day D of each class, the row D+1 — the night
 * that followed. Means with counts for sleep, HRV, resting HR and readiness.
 */
export function nightAfter(rows, sessions, from, to) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const { days, split } = classifyDays(sessions, from, to);
  const groups = Object.fromEntries(DAY_KINDS.map(([k]) => [k, []]));
  for (const d of days) {
    const next = byDate.get(addDays(d.date, 1));
    if (next) groups[d.kind].push(next);
  }
  const table = DAY_KINDS.map(([k, label]) => ({
    key: k, label, days: groups[k].length,
    sleep: summarise(groups[k], 'sleep_hours'),
    score: summarise(groups[k], 'sleep_score'),
    hrv: summarise(groups[k], 'hrv_ms'),
    rhr: summarise(groups[k], 'resting_hr'),
    readiness: summarise(groups[k], 'readiness'),
  }));
  return { table, split, days };
}

/**
 * How many nights a match costs. HRV and readiness on the first, second and
 * third morning after a match day, each against the rest-day morning mean.
 * Only mornings that did not follow *another* training day are counted at
 * D+2 and D+3, so a Thursday match followed by a Saturday run does not get
 * the run's night filed under the match.
 */
export function matchRecovery(rows, sessions, from, to) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const { days } = classifyDays(sessions, from, to);
  const kindOf = new Map(days.map((d) => [d.date, d.kind]));
  const restMornings = days.filter((d) => d.kind === 'rest').map((d) => byDate.get(addDays(d.date, 1))).filter(Boolean);
  const after = [1, 2, 3].map((k) => {
    const mornings = [];
    for (const d of days) {
      if (d.kind !== 'match') continue;
      let clean = true;
      for (let j = 1; j < k; j++) {
        const between = kindOf.get(addDays(d.date, j));
        if (between && between !== 'rest') clean = false;
      }
      if (!clean) continue;
      const row = byDate.get(addDays(d.date, k));
      if (row) mornings.push(row);
    }
    return { k, hrv: summarise(mornings, 'hrv_ms'), readiness: summarise(mornings, 'readiness'), rhr: summarise(mornings, 'resting_hr') };
  });
  return {
    rest: { hrv: summarise(restMornings, 'hrv_ms'), readiness: summarise(restMornings, 'readiness'), rhr: summarise(restMornings, 'resting_hr') },
    after,
  };
}

/** Goals plus assists on a soccer session, or null when neither is recorded. */
export function involvement(s) {
  const d = s.detail || {};
  const g = isNum(d.goals) ? Number(d.goals) : null;
  const a = isNum(d.assists) ? Number(d.assists) : null;
  return g == null && a == null ? null : (g || 0) + (a || 0);
}

function sessionFacts(list) {
  const runs = list.filter((s) => s.kind === 'run' && isNum(s.pace_s_per_km));
  const matches = list.filter((s) => s.kind === 'soccer' && involvement(s) != null);
  return {
    sessions: list.length,
    rpe: { value: mean(list.map((s) => s.rpe)), n: list.filter((s) => isNum(s.rpe)).length },
    load: { value: mean(list.map((s) => s.load)), n: list.filter((s) => isNum(s.load)).length },
    pace: { value: mean(runs.map((s) => s.pace_s_per_km)), n: runs.length },
    ga: { value: mean(matches.map(involvement)), n: matches.length },
  };
}

/**
 * The day after a night. Every session on D is paired with row D — the night
 * before it. Two cuts, each on Garmin's personal threshold rather than a
 * median: a night that met the sleep need against one that did not, and a
 * night with HRV in the balanced range against one below it.
 */
export function dayAfterNight(rows, sessions) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const paired = sessions
    .filter((s) => s.kind !== 'fast')
    .map((s) => ({ s, night: byDate.get(s.date) }))
    .filter((p) => p.night);
  /* Garmin moves the need and the range night by night, so each night is
     judged on its own threshold; a night without one borrows the window's
     median need, or the nearest range. The label quotes the median so the
     reader knows roughly where the line sat. */
  const needs = rows.map((r) => (isNum(r.sleep_need_min) ? Number(r.sleep_need_min) / 60 : null)).filter(isNum);
  const need = needs.length ? median(needs) : null;
  const needOf = (row) => (isNum(row.sleep_need_min) ? Number(row.sleep_need_min) / 60 : need);
  const range = hrvRange(rows);
  const table = [];
  if (need) {
    const met = paired.filter((p) => isNum(p.night.sleep_hours) && Number(p.night.sleep_hours) >= needOf(p.night)).map((p) => p.s);
    const short = paired.filter((p) => isNum(p.night.sleep_hours) && Number(p.night.sleep_hours) < needOf(p.night)).map((p) => p.s);
    table.push({ key: 'full', label: 'Night met the sleep need', note: `Garmin's need that night, median ${need.toFixed(1)} h`, ...sessionFacts(met) });
    table.push({ key: 'short', label: 'Night fell short of it', note: 'under that night\'s need', ...sessionFacts(short) });
  }
  if (range) {
    const inRange = (p) => { const b = hrvBand(p.night.hrv_ms, hrvRange(rows, p.night)); return b && b.label !== 'Below range' && b.label !== 'Low'; };
    const balanced = paired.filter((p) => isNum(p.night.hrv_ms) && inRange(p)).map((p) => p.s);
    const below = paired.filter((p) => isNum(p.night.hrv_ms) && !inRange(p)).map((p) => p.s);
    table.push({ key: 'highhrv', label: 'HRV in your balanced range', note: `that night's range, latest ${range.low}–${range.high} ms`, ...sessionFacts(balanced) });
    table.push({ key: 'lowhrv', label: 'HRV below it', note: 'under that night\'s range', ...sessionFacts(below) });
  }
  return { table, need, range, paired: paired.length };
}

/* ── findings ────────────────────────────────────────────────────────────── */

const h1 = (v) => (v == null ? '—' : `${Number(v).toFixed(1)} h`);
const ms = (v) => (v == null ? '—' : `${Math.round(v)} ms`);
const bpm = (v) => (v == null ? '—' : `${Math.round(v)} bpm`);
const hm = (hours) => {
  const m = Math.round(Math.abs(hours) * 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
};

/**
 * Where you stand this morning, from last night and the week so far. Each
 * line is a fact with its threshold named, followed where it is warranted by
 * what to do about it. Written to be read at breakfast.
 *
 * `nextMatch` is `{date, opponent, time_text}` or null; `fmtDate` renders an
 * ISO date for prose.
 */
export function todayFindings({ baseRows, today, nextMatch = null, fmtDate = (d) => d }) {
  const out = [];
  const last = latest(baseRows, 'sleep_hours') || latest(baseRows, 'resting_hr');
  if (!last) return out;
  const stale = last.date !== today;

  /* HRV against the personal range, over the last three nights. */
  const range = hrvRange(baseRows, last);
  const lastThree = baseRows.filter((r) => r.date > addDays(last.date, -3) && isNum(r.hrv_ms));
  if (range && lastThree.length) {
    const under = lastThree.filter((r) => { const b = hrvBand(r.hrv_ms, hrvRange(baseRows, r)); return b && (b.label === 'Below range' || b.label === 'Low'); });
    const lastBand = hrvBand(last.hrv_ms, range);
    if (under.length >= 2) {
      out.push({
        tone: 'poor', kind: 'today', metric: 'hrv_ms',
        headline: `HRV has sat under your balanced range on ${under.length} of the last ${lastThree.length} nights.`,
        detail: `Last night ${ms(last.hrv_ms)} against a range of ${range.low}–${range.high} ms that Garmin fits to your own history. Two or more nights below it is the signal Garmin itself reads as strain; an easy day, or a rest day, is the usual answer.`,
      });
    } else if (lastBand && lastBand.label === 'Balanced') {
      const inside = lastThree.filter((r) => { const b = hrvBand(r.hrv_ms, hrvRange(baseRows, r)); return b && b.label === 'Balanced'; }).length;
      out.push({
        tone: 'solid', kind: 'today', metric: 'hrv_ms',
        headline: `HRV ${ms(last.hrv_ms)} last night — inside your balanced range of ${range.low}–${range.high} ms.`,
        detail: lastThree.length >= 3 && inside === 3
          ? 'Three nights running inside it. Nothing in the nervous system is arguing against a hard session.'
          : `${inside} of the last ${lastThree.length} nights inside it, none below. Garmin fits the range to your own three-week history, so this is you against you.`,
      });
    } else if (lastBand) {
      out.push({
        tone: lastBand.tone, kind: 'today', metric: 'hrv_ms',
        headline: `HRV ${ms(last.hrv_ms)} last night — ${lastBand.label.toLowerCase()} for you (${range.low}–${range.high} ms).`,
        detail: 'One night out of range is noise as often as signal. It becomes a finding on the second.',
      });
    }
  }

  /* Resting HR against the 28-night mean. */
  const rhrBase = summarise(baseRows, 'resting_hr');
  if (isNum(last.resting_hr) && rhrBase.n >= 7) {
    const d = Number(last.resting_hr) - rhrBase.value;
    if (d >= 5) {
      out.push({
        tone: 'poor', kind: 'today', metric: 'resting_hr',
        headline: `Resting heart rate ${last.resting_hr} is ${Math.round(d)} over your 28-night mean of ${Math.round(rhrBase.value)}.`,
        detail: 'Five or more beats over your own mean is the most reliable overnight sign of fighting something off or of not having recovered. Treat today as light and look again tomorrow.',
      });
    } else if (d >= 3) {
      out.push({
        tone: 'thin', kind: 'today', metric: 'resting_hr',
        headline: `Resting heart rate ${last.resting_hr}, ${Math.round(d)} over your 28-night mean of ${Math.round(rhrBase.value)}.`,
        detail: 'Worth noticing, not yet acting on.',
      });
    }
  }

  /* Sleep debt this week, against Garmin's personal need. */
  const need = sleepNeed(baseRows, last);
  if (need) {
    const weekFrom = addDays(last.date, -((dateOf(last.date).getDay() + 6) % 7));
    const weekRows = baseRows.filter((r) => r.date >= weekFrom && r.date <= last.date && isNum(r.sleep_hours));
    const debt = weekRows.reduce((a, r) => a + Math.max(0, sleepNeed(baseRows, r) - Number(r.sleep_hours)), 0);
    const lastBand = sleepBand(last.sleep_hours, need);
    if (weekRows.length >= 2 && debt >= 2) {
      out.push({
        tone: debt >= 4 ? 'poor' : 'mixed', kind: 'today', metric: 'sleep_hours',
        headline: `${hm(debt)} short of your sleep need so far this week, over ${weekRows.length} nights.`,
        detail: `Garmin puts your need at ${h1(need)} a night; the shortfall is the sum of every night under it since Monday, with long nights not credited back.${nextMatch ? ` ${nextMatch.nightsAway <= 3 ? `The match on ${fmtDate(nextMatch.date)} is ${nextMatch.nightsAway} night${nextMatch.nightsAway === 1 ? '' : 's'} away — the nights before it are the ones to protect.` : ''}` : ''}`,
      });
    } else if (lastBand && lastBand.tone === 'solid' && isNum(last.sleep_hours)) {
      out.push({
        tone: 'solid', kind: 'today', metric: 'sleep_hours',
        headline: `${h1(last.sleep_hours)} last night, against a need of ${h1(need)}.`,
        detail: `${isNum(last.sleep_score) ? `Garmin scored the night ${last.sleep_score}${bandFor('sleep_score', last.sleep_score) ? ` — ${bandFor('sleep_score', last.sleep_score).label.toLowerCase()}` : ''}.` : 'Need met.'}`,
      });
    } else if (lastBand && isNum(last.sleep_hours)) {
      out.push({
        tone: lastBand.tone, kind: 'today', metric: 'sleep_hours',
        headline: `${h1(last.sleep_hours)} last night, ${hm(need - Number(last.sleep_hours))} under your need of ${h1(need)}.`,
        detail: isNum(last.sleep_score) ? `Garmin scored the night ${last.sleep_score}.` : '',
      });
    }
  }

  /* Readiness and stress, on Garmin's own scale. */
  if (isNum(last.readiness)) {
    const b = bandFor('readiness', last.readiness);
    out.push({
      tone: b.tone, kind: 'today', metric: 'readiness',
      headline: `Readiness ${last.readiness} this morning — ${b.label} on Garmin's scale.`,
      detail: 'Garmin builds this from its own sleep, HRV, recovery-time, load and stress model; it is shown here as it came, not re-derived.',
    });
  }

  if (stale) {
    out.push({ tone: null, kind: 'today', headline: `Nothing newer than ${fmtDate(last.date)} has synced.`, detail: 'The nightly sync pulls the last three days; press ⟳ to pull now.' });
  }
  return out;
}

/**
 * What the record says about nights and training together, over a range.
 * Every finding states its counts and only fires when there is enough of
 * them; a difference inside noise is not reported.
 */
export function patternFindings({ rows, sessions, from, to, fmtDate = (d) => d }) {
  const out = [];

  /* The cost of a match, in nights. */
  const rec = matchRecovery(rows, sessions, from, to);
  const d1 = rec.after[0];
  if (rec.rest.hrv.n >= 5 && d1.hrv.n >= 4) {
    const drop = rec.rest.hrv.value - d1.hrv.value;
    const d2 = rec.after[1];
    const back = d2.hrv.n >= 3 ? (rec.rest.hrv.value - d2.hrv.value) : null;
    if (Math.abs(drop) >= 3) {
      out.push({
        tone: null, kind: 'pattern', metric: 'hrv_ms',
        headline: `The morning after a match your HRV reads ${ms(d1.hrv.value)}, ${drop > 0 ? `${Math.round(drop)} ms under` : `${Math.round(-drop)} ms over`} your rest-day mornings (${ms(rec.rest.hrv.value)}).`,
        detail: `${d1.hrv.n} match mornings against ${rec.rest.hrv.n} rest mornings.${back != null ? ` By the second morning it is ${Math.abs(back) < 3 ? 'back within noise of the rest-day figure' : `still ${Math.round(Math.abs(back))} ms ${back > 0 ? 'under' : 'over'}`} (${d2.hrv.n} clean mornings).` : ''}${drop > 0 && back != null && Math.abs(back) < 3 ? ' One night is the cost of a match; the hard run belongs two days out, not one.' : ''}`,
      });
    }
    if (rec.rest.readiness.n >= 5 && d1.readiness.n >= 4 && rec.rest.readiness.value - d1.readiness.value >= 8) {
      out.push({
        tone: null, kind: 'pattern', metric: 'readiness',
        headline: `Readiness the morning after a match averages ${Math.round(d1.readiness.value)} against ${Math.round(rec.rest.readiness.value)} after a rest day.`,
        detail: `${d1.readiness.n} match mornings, ${rec.rest.readiness.n} rest mornings. Garmin's scale: ${bandFor('readiness', d1.readiness.value).label} against ${bandFor('readiness', rec.rest.readiness.value).label}.`,
      });
    }
  }

  /* Sleep and the next day's session. */
  const after = dayAfterNight(rows, sessions);
  const full = after.table.find((r) => r.key === 'full');
  const short = after.table.find((r) => r.key === 'short');
  if (full && short) {
    if (full.ga.n >= 4 && short.ga.n >= 4 && full.ga.value != null && short.ga.value != null) {
      const diff = full.ga.value - short.ga.value;
      if (Math.abs(diff) >= 0.5) {
        out.push({
          tone: null, kind: 'pattern', metric: 'sleep_hours',
          headline: `Goal involvement runs ${full.ga.value.toFixed(1)} a match after a night that met your sleep need, ${short.ga.value.toFixed(1)} after one that did not.`,
          detail: `${full.ga.n} and ${short.ga.n} matches with a goal line, split at Garmin's need of ${after.need.toFixed(1)} h for the night before. ${diff > 0 ? 'Sleep the night before a match is the cheapest form on offer.' : 'The record does not reward the longer night here; small samples swing.'}`,
        });
      }
    }
    if (full.rpe.n >= 6 && short.rpe.n >= 6 && full.load.n && short.load.n) {
      const rpeDiff = short.rpe.value - full.rpe.value;
      const loadRatio = short.load.value / full.load.value;
      if (rpeDiff >= 0.4 && loadRatio <= 1.1) {
        out.push({
          tone: null, kind: 'pattern', metric: 'sleep_hours',
          headline: `Sessions after a short night feel harder: RPE ${short.rpe.value.toFixed(1)} against ${full.rpe.value.toFixed(1)}, for ${loadRatio >= 0.9 ? 'about the same' : 'less'} load.`,
          detail: `${short.rpe.n} sessions after a night under your need, ${full.rpe.n} after one that met it; load per session ${Math.round(short.load.value)} against ${Math.round(full.load.value)} AU.`,
        });
      }
    }
  }
  const balanced = after.table.find((r) => r.key === 'highhrv');
  const below = after.table.find((r) => r.key === 'lowhrv');
  if (balanced && below && balanced.pace.n >= 4 && below.pace.n >= 4) {
    const diff = below.pace.value - balanced.pace.value;
    if (Math.abs(diff) >= 10) {
      const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
      out.push({
        tone: null, kind: 'pattern', metric: 'hrv_ms',
        headline: `Runs after a night with HRV below your range average ${mmss(below.pace.value)}/km; after a balanced night, ${mmss(balanced.pace.value)}/km.`,
        detail: `${below.pace.n} and ${balanced.pace.n} runs. Pace is what was recorded, not effort-adjusted, so an easy run on a low morning counts the same as a slow one.`,
      });
    }
  }

  /* The weekday that costs the most sleep. */
  const wd = byWeekday(rows, 'sleep_hours').filter((w) => w.n >= 4);
  if (wd.length >= 5) {
    const lo = wd.reduce((a, b) => (a.value <= b.value ? a : b));
    const others = mean(wd.filter((w) => w !== lo).map((w) => w.value));
    if (others - lo.value >= 0.8) {
      const prev = WEEKDAYS[(WEEKDAYS.indexOf(lo.label) + 6) % 7];
      out.push({
        tone: null, kind: 'pattern', metric: 'sleep_hours',
        headline: `Nights into ${lo.label} run ${hm(others - lo.value)} shorter than the rest of the week — ${h1(lo.value)} over ${lo.n} nights.`,
        detail: `That is ${prev} night. ${prev === 'Thu' ? 'The men\'s league plays on Thursday evening; the night after it is the one the record keeps losing.' : prev === 'Wed' ? 'Wednesday was the men\'s league night before the Fall 2026 venue move.' : 'If something fixed sits on that evening, it is the night to protect.'}`,
      });
    }
  }

  /* High-stress days and the night that follows. */
  const withStress = rows.filter((r) => isNum(r.stress_avg));
  if (withStress.length >= 14) {
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const split = median(withStress.map((r) => r.stress_avg));
    const nightsAfter = (pick) => withStress.filter(pick).map((r) => byDate.get(addDays(r.date, 1))).filter((n) => n && isNum(n.sleep_score));
    const calm = summarise(nightsAfter((r) => r.stress_avg < split), 'sleep_score');
    const tense = summarise(nightsAfter((r) => r.stress_avg >= split), 'sleep_score');
    if (calm.n >= 5 && tense.n >= 5 && calm.value - tense.value >= 5) {
      out.push({
        tone: null, kind: 'pattern', metric: 'stress_avg',
        headline: `After a day with stress at or above your median (${Math.round(split)}), the sleep score averages ${Math.round(tense.value)}; after a calmer day, ${Math.round(calm.value)}.`,
        detail: `${tense.n} and ${calm.n} nights. Garmin's daily stress is heart-rate variability through the waking day, so a long hard session inflates it; a calm rest day with a poor score is the one to look at.`,
      });
    }
  }

  return out;
}

/* ── read-out ────────────────────────────────────────────────────────────── */

/** Flat sentences about the window. `fmtDate` renders an ISO date. */
export function recoveryReadout(rows, { fmtDate = (d) => d } = {}) {
  const lines = [];
  const nights = rows.filter((r) => isNum(r.sleep_hours));
  if (!nights.length) return lines;

  const s = summarise(rows, 'sleep_hours');
  const sx = extremes(rows, 'sleep_hours');
  const need = sleepNeed(rows);
  const met = need ? nights.filter((r) => Number(r.sleep_hours) >= sleepNeed(rows, r)).length : null;
  lines.push(`${h1(s.value)} mean sleep over ${s.n} nights — shortest ${h1(sx.min.value)} on ${fmtDate(sx.min.date)}, longest ${h1(sx.max.value)} on ${fmtDate(sx.max.date)}.${met != null ? ` ${met} of ${s.n} met Garmin's need of ${h1(need)}.` : ''}`);

  const hv = summarise(rows, 'hrv_ms');
  if (hv.n) {
    const hx = extremes(rows, 'hrv_ms');
    const range = hrvRange(rows);
    const inRange = range ? rows.filter((r) => { const b = hrvBand(r.hrv_ms, hrvRange(rows, r)); return b && b.label === 'Balanced'; }).length : null;
    lines.push(`${ms(hv.value)} mean HRV over ${hv.n} nights, from ${ms(hx.min.value)} to ${ms(hx.max.value)}.${inRange != null ? ` ${inRange} of ${hv.n} inside your balanced range of ${range.low}–${range.high} ms.` : ''}`);
  }

  const rh = summarise(rows, 'resting_hr');
  if (rh.n) {
    const rx = extremes(rows, 'resting_hr');
    lines.push(`${bpm(rh.value)} mean resting heart rate over ${rh.n} nights — lowest ${rx.min.value} on ${fmtDate(rx.min.date)}, highest ${rx.max.value} on ${fmtDate(rx.max.date)}.`);
  }

  const rd = summarise(rows, 'readiness');
  if (rd.n) {
    const counts = {};
    for (const r of rows) { const b = bandFor('readiness', r.readiness); if (b) counts[b.label] = (counts[b.label] || 0) + 1; }
    const parts = BANDS.readiness.map((b) => (counts[b.label] ? `${counts[b.label]} ${b.label.toLowerCase()}` : null)).filter(Boolean);
    lines.push(`Readiness averaged ${Math.round(rd.value)} over ${rd.n} mornings: ${parts.join(', ')}.`);
  }

  const st = summarise(rows, 'stress_avg');
  if (st.n) lines.push(`${Math.round(st.value)} mean daily stress (${bandFor('stress_avg', st.value).label.toLowerCase()} on Garmin's scale) over ${st.n} days with a reading.`);
  return lines;
}

/** Which of the newer columns a window actually has, as "n of m nights". */
export function coverage(rows, key) {
  const of = rows.filter((r) => isNum(r.sleep_hours) || isNum(r.resting_hr)).length;
  const n = rows.filter((r) => isNum(r[key]) || (typeof r[key] === 'string' && r[key])).length;
  return { n, of };
}

/** The next unplayed fixture across every league, with nights until it. */
export function nextFixture(leagues, today) {
  let best = null;
  for (const lg of leagues || []) {
    for (const f of lg.my_fixtures || []) {
      if (f.played || !f.date || f.date < today) continue;
      if (!best || f.date < best.date) best = { ...f, league: lg.fixture };
    }
  }
  if (!best) return null;
  const nightsAway = Math.round((dateOf(best.date) - dateOf(today)) / 86400000);
  return { ...best, nightsAway };
}
