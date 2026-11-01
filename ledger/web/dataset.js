/* Ledger — the derived layer.
 *
 * Everything authoritative comes from the API. What lives here is the second
 * question you ask once the numbers are on screen: which weekday carries the
 * load, how hard the sessions actually are, whether the mix is drifting.
 *
 * Two rules hold throughout:
 *   · rolling windows only — nothing here resets to zero on a missed day;
 *   · every sentence names a number and a window, or it does not get written.
 */

import {
  api, qs, dateOf, isoOf, addDays, weekStart, fmt, KINDS,
  getWeightUnit, inUnit,
} from './core.js';
/* Imported *and* re-exported. `score.js` owns the definition of "what you
   weigh" because it is the module that must never hold two versions of a
   number; display code keeps importing it from here.
   `export ... from` alone re-exports without binding the name locally, so
   `weekReadout` below could not see it. */
import { latestWeighIn, weighInDelta } from './score.js';

export { latestWeighIn, weighInDelta };

/* ── cached fetches ──────────────────────────────────────────────────────── */

const cache = new Map();

/** Memoised GET. `key` also namespaces invalidation after a write. */
export async function cached(key, path) {
  if (cache.has(key)) return cache.get(key);
  const p = api(path).then((res) => {
    if (!res.ok) cache.delete(key);
    return res;
  });
  cache.set(key, p);
  return p;
}

export const invalidate = () => cache.clear();

/** Every session in a window, paged out of /api/sessions. */
export async function sessionsIn({ from = null, to = null, kind = null } = {}) {
  const key = `sessions:${from}:${to}:${kind}`;
  if (cache.has(key)) return cache.get(key);

  const run = (async () => {
    const items = [];
    let offset = 0;
    let total = Infinity;
    let guard = 0;
    /* The window these sessions came from, as the server states it. Panels
       built from this list print that label rather than describing the range
       in their own words — one wording per window, everywhere. It is taken
       from the first page, because paging does not change the window. */
    let timeframe = null;
    while (items.length < total && guard++ < 12) {
      const res = await api(`/api/sessions${qs({ from, to, kind, limit: 500, offset })}`);
      if (!res.ok) return { ok: false, res, items: [], timeframe: null };
      total = res.data.total || 0;
      if (!timeframe) timeframe = res.data.timeframe || null;
      const batch = res.data.items || [];
      items.push(...batch);
      if (!batch.length) break;
      offset = items.length;
    }
    return { ok: true, res: null, items, total, timeframe };
  })();

  cache.set(key, run);
  return run;
}

/* ── weekday rhythm ──────────────────────────────────────────────────────── */

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Load and session count per weekday, split by modality. */
export function byWeekday(sessions) {
  const rows = WEEKDAYS.map((label) => ({
    key: label, label, values: {}, count: 0, total: 0, minutes: 0,
  }));
  for (const s of sessions) {
    const i = (dateOf(s.date).getDay() + 6) % 7;
    const row = rows[i];
    const load = Number(s.load || 0);
    row.values[s.kind] = (row.values[s.kind] || 0) + load;
    row.total += load;
    row.count += 1;
    row.minutes += Number(s.duration_min || 0);
  }
  return rows;
}

/* ── RPE ─────────────────────────────────────────────────────────────────── */

/** How hard the sessions actually were — the input the whole load model rests on. */
export function rpeHistogram(sessions) {
  const rows = [];
  for (let r = 0; r <= 10; r++) {
    rows.push({ key: String(r), label: String(r), values: {}, total: 0 });
  }
  let scored = 0;
  for (const s of sessions) {
    if (s.rpe == null) continue;
    const r = Math.max(0, Math.min(10, Math.round(Number(s.rpe))));
    rows[r].values[s.kind] = (rows[r].values[s.kind] || 0) + 1;
    rows[r].total += 1;
    scored += 1;
  }
  return { rows, scored, unscored: sessions.length - scored };
}

/** Load-weighted mean RPE — the honest "how hard has this block been". */
export function meanRpe(sessions) {
  let num = 0;
  let den = 0;
  for (const s of sessions) {
    if (s.rpe == null || !s.duration_min) continue;
    num += Number(s.rpe) * Number(s.duration_min);
    den += Number(s.duration_min);
  }
  return den ? num / den : null;
}

/* ── rolling windows ─────────────────────────────────────────────────────── */

/** Trailing sum over `win` samples. Index i covers [i-win+1 … i]. */
export function rollingSum(values, win) {
  const out = new Array(values.length).fill(null);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += Number(values[i] || 0);
    if (i >= win) acc -= Number(values[i - win] || 0);
    if (i >= win - 1) out[i] = acc;
  }
  return out;
}

export function rollingMean(values, win) {
  return rollingSum(values, win).map((v) => (v == null ? null : v / win));
}

/** A trailing 28-day activity count for every day on record. No streaks: a
 *  missed day dips this line and the next entry lifts it. */
export function rolling28(history, { step = 1 } = {}) {
  const counts = history.counts || [];
  if (!counts.length) return [];
  const roll = rollingSum(counts, 28);
  const out = [];
  for (let i = 0; i < counts.length; i += step) {
    if (roll[i] == null) continue;
    const iso = isoOf(new Date(dateOf(history.start).getTime() + i * 86400000));
    out.push({ key: iso, label: fmt.date(iso), values: { n: roll[i] } });
  }
  return out;
}

/* ── gaps ────────────────────────────────────────────────────────────────── */

/** Longest and typical gap between logged days — the shape of the record's
 *  holes, stated rather than hidden behind a streak counter. */
export function gaps(history) {
  const counts = history.counts || [];
  const active = [];
  for (let i = 0; i < counts.length; i++) if (counts[i] > 0) active.push(i);
  if (active.length < 2) return null;
  const diffs = [];
  for (let i = 1; i < active.length; i++) diffs.push(active[i] - active[i - 1]);
  const sorted = diffs.slice().sort((a, b) => a - b);
  const longest = Math.max(...diffs);
  const at = active[diffs.indexOf(longest) + 1];
  const start = dateOf(history.start);
  return {
    longest,
    longestEnded: isoOf(new Date(start.getTime() + at * 86400000)),
    median: sorted[Math.floor(sorted.length / 2)],
    activeDays: active.length,
    coverage: active.length / counts.length,
  };
}

/* ── modality mix over time ──────────────────────────────────────────────── */

/** Each period rescaled to 100% — the chart that shows a mix drifting. */
export function normalizePoints(points, keys) {
  return points.map((p) => {
    const values = {};
    const total = keys.reduce((a, k) => a + Number(p.values?.[k] ?? p.by_kind?.[k] ?? 0), 0);
    for (const k of keys) {
      const v = Number(p.values?.[k] ?? p.by_kind?.[k] ?? 0);
      values[k] = total ? (v / total) * 100 : 0;
    }
    return { ...p, values, total: total ? 100 : 0, absolute: total };
  });
}

/* ── comparisons ─────────────────────────────────────────────────────────── */

/**
 * This period against the mean of the ones before it. Returns null rather than
 * a fabricated baseline when there is not enough history.
 */
export function versusBaseline(series, { window = 12 } = {}) {
  if (!series || series.length < 3) return null;
  const current = Number(series[series.length - 1] || 0);
  const prior = series.slice(Math.max(0, series.length - 1 - window), series.length - 1)
    .map((v) => Number(v || 0));
  if (prior.length < 2) return null;
  const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
  return {
    current, mean, weeks: prior.length,
    delta: current - mean,
    pct: mean ? ((current - mean) / mean) * 100 : null,
  };
}

/* ── distance, week over week ────────────────────────────────────────────── */

/* There used to be a client-side weekly-distance layer here — ON_FOOT_KINDS,
   distanceByWeek and distanceReadout. It has been deleted rather than kept
   alongside `GET /api/distance`, which now computes the same thing plus the
   next-week target. Its list of on-foot modalities had already drifted from
   the server's (it counted `other` and missed `quickfeet`), which is exactly
   the failure mode a second implementation produces. The Running view reads
   the endpoint. */

/* ── quick add ───────────────────────────────────────────────────────────── */

/* Things logged over and over deserve to be one tap, not a form. These are
   derived from the record rather than invented: the duration and RPE offered
   are the ones actually typical for that session, so "quick feet" prefills 20
   minutes at RPE 4 because that is what quick feet has always been.
   Two are seeded because the user asked for them by name. */

const SEED_PRESETS = [
  {
    key: 'ab-attack', label: 'Ab attack', kind: 'other', notes: 'ab attack',
    duration: 15, rpe: 6, sub: 'core',
  },
  {
    key: 'quick-feet', label: 'Quick feet', kind: 'other', notes: 'quick feet',
    duration: 20, rpe: 4, sub: 'soccer training — dribbling, cones, ladder',
  },
];

const CUSTOM_KEY = 'ledger.presets';

export const readCustomPresets = () => {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); } catch { return []; }
};
export function saveCustomPreset(preset) {
  try {
    const all = readCustomPresets().filter((p) => p.key !== preset.key);
    all.unshift(preset);
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(all.slice(0, 12)));
    return true;
  } catch { return false; }
}
export function deleteCustomPreset(key) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(readCustomPresets().filter((p) => p.key !== key)));
    return true;
  } catch { return false; }
}

const normNote = (n) => String(n || '').toLowerCase()
  .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

const median = (list) => {
  if (!list.length) return null;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const modal = (list) => {
  if (!list.length) return null;
  const c = {};
  for (const v of list) c[v] = (c[v] || 0) + 1;
  return Number(Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]);
};

/**
 * The session shapes worth a single tap, most-repeated first.
 * Recency-weighted, so a habit that stopped a year ago drops off on its own.
 */
export function quickAddPresets(sessions, { today = null, limit = 8 } = {}) {
  const cutoff = today ? addDays(today, -180) : null;
  const groups = new Map();

  for (const s of sessions || []) {
    const note = normNote(s.notes);
    if (!note || note.length < 3) continue;
    const key = `${s.kind}:${note}`;
    if (!groups.has(key)) groups.set(key, { kind: s.kind, note, rows: [], recent: 0 });
    const g = groups.get(key);
    g.rows.push(s);
    if (cutoff && s.date >= cutoff) g.recent += 1;
  }

  const derived = [...groups.values()]
    .filter((g) => g.rows.length >= 3)
    .map((g) => ({
      key: `${g.kind}:${g.note}`,
      label: g.note.replace(/^./, (c) => c.toUpperCase()),
      kind: g.kind,
      notes: g.rows[0].notes,
      duration: median(g.rows.map((r) => r.duration_min).filter(Boolean)),
      rpe: modal(g.rows.map((r) => r.rpe).filter((v) => v != null)),
      count: g.rows.length,
      score: g.rows.length + g.recent * 2,
      sub: `${g.rows.length} logged`,
    }))
    .sort((a, b) => b.score - a.score);

  const custom = readCustomPresets().map((p) => ({ ...p, custom: true, score: 1e6 }));

  const out = [];
  const seen = new Set();
  for (const p of [...custom, ...SEED_PRESETS.map((p) => ({ ...p, seeded: true })), ...derived]) {
    const id = `${p.kind}:${normNote(p.notes)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...p, duration: p.duration == null ? null : Math.round(p.duration) });
    if (out.length >= limit) break;
  }
  return out;
}

/* ── the boxed number ────────────────────────────────────────────────────── */

/**
 * The activities-per-week figure, for every week on record.
 *
 * One definition, and it belongs to the server (`ledger/report/average.py`):
 *
 *     the figure on week N  =  activities through week N-1  ÷  (N-1)
 *
 * Two things follow from that and both matter. The numerator stops at the end
 * of the last COMPLETED week, so the number is recalculated when a week closes
 * and does not sag every Monday and recover by Sunday. And the divisor is the
 * notebook page's own week counter, which started before the first logged
 * activity — so `basis.weeks`, the count the server divided by, is passed in
 * and anchors the whole series. The endpoint then equals the server's figure
 * exactly, which is the only acceptable outcome: there is one number.
 *
 * Deriving this at all is a workaround. The API publishes the current value
 * but not the series — see NOTES-FOR-BACKEND.md — and this function should be
 * deleted the day it does.
 *
 * The figure cannot be reset. A blank week pulls it down a little; the next
 * entry pulls it back. That is the philosophy of this app in one line.
 */
export function lifetimeAveragePerWeek(history, basis) {
  const counts = history.counts || [];
  if (!counts.length) return [];
  const start = dateOf(history.start);

  /* Close each Mon–Sun week and record what the log held at its end. */
  const closes = [];
  let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    cum += Number(counts[i] || 0);
    const day = new Date(start.getTime() + i * 86400000);
    if (day.getDay() !== 0) continue;
    closes.push({ iso: isoOf(day), cum });
  }
  if (closes.length < 2) return [];

  const last = closes.length - 1;
  const basisWeeks = basis && basis.weeks != null ? Number(basis.weeks) : null;
  /* One integer, taken from the server, carries the whole notebook offset. */
  const offset = basisWeeks != null ? basisWeeks - last : 0;

  const out = [];
  /* The first week has no completed predecessor, so it has no figure — the
     notebook's first page did not carry one either. */
  for (let i = 1; i <= last; i++) {
    const weeks = i + offset;
    if (weeks < 1) continue;
    const activities = closes[i - 1].cum;
    out.push({
      key: closes[i].iso, label: fmt.date(closes[i].iso),
      values: { avg: Number((activities / weeks).toFixed(2)) },
      note: `${fmt.int(activities)} activities through ${fmt.date(closes[i - 1].iso)}, over ${weeks} completed weeks`,
    });
  }
  return out;
}

/** Activities in each Mon–Sun week, on exactly the weeks the average uses. */
export function weeklyCounts(history) {
  const counts = history.counts || [];
  if (!counts.length) return [];
  const start = dateOf(history.start);
  const out = [];
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    acc += Number(counts[i] || 0);
    const day = new Date(start.getTime() + i * 86400000);
    if (day.getDay() !== 0) continue;
    const iso = isoOf(day);
    out.push({ key: iso, label: fmt.date(iso), values: { n: acc }, total: acc });
    acc = 0;
  }
  return out;
}

/* ── bodyweight & fasting ────────────────────────────────────────────────── */

/** Monthly mean of the EMA — the resolution that lines up with fasting blocks. */
export function bodyweightByMonth(series) {
  const bucket = new Map();
  for (const p of series || []) {
    const kg = p.ema ?? p.kg;
    if (kg == null) continue;
    const key = p.date.slice(0, 7);
    if (!bucket.has(key)) bucket.set(key, { sum: 0, n: 0 });
    const b = bucket.get(key);
    b.sum += Number(kg);
    b.n += 1;
  }
  return [...bucket.entries()].sort().map(([key, b]) => ({ key, kg: b.sum / b.n, n: b.n }));
}

/** A nightly measure's mean per calendar month, with the nights it rests on.
 *  Months with no reading are absent, not zero: a month of no nights is a gap,
 *  and a zero would plot as the worst month on record. */
export function metricByMonth(rows, key) {
  const bucket = new Map();
  for (const r of rows || []) {
    const v = r[key];
    if (v == null || !Number.isFinite(Number(v))) continue;
    const k = r.date.slice(0, 7);
    if (!bucket.has(k)) bucket.set(k, { sum: 0, n: 0 });
    const b = bucket.get(k);
    b.sum += Number(v);
    b.n += 1;
  }
  return [...bucket.entries()].sort().map(([k, b]) => ({ key: k, mean: b.sum / b.n, n: b.n }));
}

/** Fasting hours per month, zero-filled across the same months. */
export function fastingByMonth(fasts, months) {
  const bucket = new Map();
  for (const f of fasts || []) {
    const hours = Number((f.detail || {}).hours || 0);
    if (!hours) continue;
    const key = f.date.slice(0, 7);
    if (!bucket.has(key)) bucket.set(key, { hours: 0, n: 0 });
    const b = bucket.get(key);
    b.hours += hours;
    b.n += 1;
  }
  const keys = months && months.length ? months : [...bucket.keys()].sort();
  return keys.map((key) => {
    const b = bucket.get(key) || { hours: 0, n: 0 };
    return { key, hours: b.hours, n: b.n };
  });
}

/** Every month that either series touches, in order, with no gaps. */
export function monthSpan(from, to) {
  if (!from || !to) return [];
  const out = [];
  const cur = dateOf(`${from}-01`);
  const end = dateOf(`${to}-01`);
  while (cur <= end) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

/**
 * Facts about the weigh-in record and the fasting alongside it.
 *
 * Deliberately directionless: no goal weight, no "down is good", no colour.
 * The strongest thing said here is that two numbers moved in the same window,
 * and it says outright that this is not evidence one caused the other.
 */
export function weightReadout(series, fasts, { unit = 'lb', convert = (kg) => kg } = {}) {
  const out = [];
  const pts = (series || []).filter((p) => p.kg != null);
  if (pts.length < 2) return ['Not enough weigh-ins on record to say anything.'];

  const u = (kg, dp = 1) => `${convert(kg).toFixed(dp)} ${unit}`;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const emaOf = (p) => p.ema ?? p.kg;

  out.push(`${pts.length} weigh-ins between ${fmt.dateY(first.date)} and ${fmt.dateY(last.date)}.`);
  out.push(`Latest EMA ${u(emaOf(last))}, against ${u(emaOf(first))} at the first entry.`);

  const kgs = pts.map((p) => p.kg);
  const hi = pts[kgs.indexOf(Math.max(...kgs))];
  const lo = pts[kgs.indexOf(Math.min(...kgs))];
  out.push(`Range on record ${u(lo.kg)} on ${fmt.dateY(lo.date)} to ${u(hi.kg)} on ${fmt.dateY(hi.date)}, a spread of ${u(hi.kg - lo.kg)}.`);

  for (const [label, weeks] of [['4 weeks', 4], ['12 weeks', 12], ['52 weeks', 52]]) {
    const cutoff = addDays(last.date, -7 * weeks);
    const prior = pts.filter((p) => p.date <= cutoff).pop();
    if (!prior) continue;
    const delta = emaOf(last) - emaOf(prior);
    out.push(`Over ${label}: ${fmt.signed(convert(Math.abs(delta)) * Math.sign(delta) || 0, ` ${unit}`)}, from ${u(emaOf(prior))} on ${fmt.dateY(prior.date)}.`);
  }

  const withHours = (fasts || []).filter((f) => (f.detail || {}).hours);
  if (withHours.length) {
    const hours = withHours.reduce((a, f) => a + Number(f.detail.hours), 0);
    const longest = withHours.reduce((a, f) => (Number(f.detail.hours) > Number(a.detail.hours) ? f : a));
    out.push(`${withHours.length} fasts on record totalling ${fmt.int(hours)} hours; the longest was ${fmt.int(longest.detail.hours)} hours from ${fmt.dateY(longest.date)}.`);

    /* Same-window movement, stated as co-occurrence and nothing more. */
    const byYear = {};
    for (const f of withHours) {
      const y = f.date.slice(0, 4);
      byYear[y] = (byYear[y] || 0) + Number(f.detail.hours);
    }
    const years = Object.keys(byYear).sort();
    if (years.length >= 2) {
      out.push(`Fasting hours by year: ${years.map((y) => `${y} ${fmt.int(byYear[y])}h`).join(', ')}.`);
    }
    out.push('Fasting and bodyweight are plotted on the same months so they can be read together. Sitting side by side is not evidence that one moved the other.');
  } else {
    out.push('No fasts with a recorded length in this range.');
  }
  return out;
}

/* ── soccer teams ────────────────────────────────────────────────────────── */

/**
 * Three standing fixtures plus an escape hatch. The weekday is the rule, not a
 * guess: Monday coed, Tuesday pickup, Thursday men's league. Anything else —
 * a Wednesday game, a Monday that was actually pickup — resolves to whatever
 * the note or an explicit override says, which is the whole point of having
 * the override.
 *
 * Men's league was on Wednesdays at one venue until the Fall 2026 session
 * moved it to Thursdays at another. The rule is dated rather than
 * rewritten, so the summer's Wednesdays still read as men's league and a
 * Wednesday after the move does not. The date is the day after the last
 * Wednesday fixture (9 Sep 2026); the first Thursday fixture was the 17th.
 * Mirrors `fixture_by_weekday` in `report/views.py`; the two must not drift.
 */
export const MENS_ON_THURSDAY_FROM = '2026-09-10';
export const TEAMS = [
  { key: 'coed', label: 'Coed', note: 'Monday', day: 1 },
  { key: 'pickup', label: 'Pickup', note: 'Tuesday · competitive', day: 2 },
  { key: 'mens', label: "Men's league", note: 'Thursday · competitive', day: 4, dayBefore: 3 },
  { key: 'other', label: 'Other', note: 'one-off, guest or practice', day: null },
];

/** The weekday a fixture was played on as of `iso` — see MENS_ON_THURSDAY_FROM. */
export const fixtureDay = (t, iso) =>
  (t.dayBefore != null && iso < MENS_ON_THURSDAY_FROM ? t.dayBefore : t.day);

export const TEAM_KEYS = TEAMS.map((t) => t.key);
export const teamLabel = (key) => (TEAMS.find((t) => t.key === key) || {}).label || 'Other';

const NOTE_TEAM = [
  [/\bpick[\s-]?up\b/i, 'pickup'],
  [/\bco-?ed\b/i, 'coed'],
  [/\b(men'?s|mens)\b/i, 'mens'],
  [/\b(practice|scrimmage|tournament|friendly)\b/i, 'other'],
];

/**
 * Returns {team, source} so the interface can be honest about which games were
 * inferred from the calendar and which were stated outright.
 */
export function resolveTeam(session) {
  const detail = session.detail || {};
  if (detail.team && TEAM_KEYS.includes(detail.team)) {
    return { team: detail.team, source: 'set' };
  }
  const notes = session.notes || '';
  for (const [re, team] of NOTE_TEAM) {
    if (re.test(notes)) return { team, source: 'note' };
  }
  const day = dateOf(session.date).getDay();
  const byDay = TEAMS.find((t) => fixtureDay(t, session.date) === day);
  return byDay ? { team: byDay.key, source: 'weekday' } : { team: 'other', source: 'weekday' };
}

export const teamOf = (session) => resolveTeam(session).team;

/** Per-team record and goal involvement. Every rate carries its denominator. */
export function soccerByTeam(sessions, fixtureById = null) {
  const rows = new Map();
  const blank = (key) => ({
    key, label: teamLabel(key), logged: 0, played: 0, w: 0, l: 0, d: 0,
    gf: 0, ga: 0, goals: 0, assists: 0, scored: 0, minutes: 0, inferred: 0,
  });

  for (const s of sessions) {
    /* The server's resolution wins when it is available. `resolveTeam` mirrors
       it exactly today, and two copies of a rule that agree today are simply a
       disagreement that has not happened yet — the read-out and this table were
       already six-against-eight on "pickup" once. The local copy stays for rows
       held without a matching `/api/soccer` payload. */
    const fromServer = fixtureById && fixtureById.get(String(s.id));
    const { team, source } = fromServer
      ? { team: fromServer.fixture, source: fromServer.source }
      : resolveTeam(s);
    if (!rows.has(team)) rows.set(team, blank(team));
    const r = rows.get(team);
    const dt = s.detail || {};
    r.logged += 1;
    if (source !== 'set') r.inferred += 1;
    r.minutes += Number(s.duration_min || 0);
    if (dt.result === 'W') { r.w += 1; r.played += 1; } else if (dt.result === 'L') { r.l += 1; r.played += 1; } else if (dt.result === 'D') { r.d += 1; r.played += 1; }
    r.gf += Number(dt.gf || 0);
    r.ga += Number(dt.ga || 0);
    if (dt.goals != null || dt.assists != null) {
      r.goals += Number(dt.goals || 0);
      r.assists += Number(dt.assists || 0);
      r.scored += 1;
    }
  }

  return TEAM_KEYS.filter((k) => rows.has(k)).map((k) => {
    const r = rows.get(k);
    return {
      ...r,
      winRate: r.played ? r.w / r.played : null,
      goalsPerGame: r.scored ? r.goals / r.scored : null,
      assistsPerGame: r.scored ? r.assists / r.scored : null,
      involvementsPerGame: r.scored ? (r.goals + r.assists) / r.scored : null,
      gfPerGame: r.played ? r.gf / r.played : null,
      gaPerGame: r.played ? r.ga / r.played : null,
    };
  });
}

/**
 * Goal involvement per match, averaged over every match so far.
 *
 * A *running* average, not a rolling one, and the distinction is the whole
 * reason this exists. A five-match window divides by five; the "Your G+A per
 * match" tile divides by every match in the range. Those cannot agree, and
 * putting 3.60 beside 2.78 read as the app contradicting itself.
 *
 * This line's final point *is* the tile's figure, by construction — 125 ÷ 45.
 * Every earlier point is the same sum over the matches up to that date, so the
 * line shows how the average got where it is, and ends where the tile says.
 *
 * It settles as the record grows, which is honest: one big game moves it a lot
 * at match five and barely at match forty-five.
 */
export function runningInvolvement(sessions) {
  const games = sessions
    .filter((s) => (s.detail || {}).goals != null || (s.detail || {}).assists != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  let total = 0;
  return games.map((g, i) => {
    const here = Number((g.detail || {}).goals || 0) + Number((g.detail || {}).assists || 0);
    total += here;
    return {
      key: `${g.id}`,
      label: fmt.date(g.date),
      date: g.date,
      values: { rate: Number((total / (i + 1)).toFixed(2)) },
      note: `${here} in this match · ${i + 1} match${i ? 'es' : ''} so far · ${teamLabel(teamOf(g))}`,
    };
  });
}

/** Rolling mean of goal involvement per match — a window, never a streak. */
export function rollingInvolvement(sessions, win = 5) {
  const games = sessions
    .filter((s) => (s.detail || {}).goals != null || (s.detail || {}).assists != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (games.length < win) return [];
  const vals = games.map((g) => Number((g.detail || {}).goals || 0) + Number((g.detail || {}).assists || 0));
  const mean = rollingMean(vals, win);
  const out = [];
  games.forEach((g, i) => {
    if (mean[i] == null) return;
    out.push({
      key: `${g.id}`, label: fmt.date(g.date),
      /* The match this window ends on. The panel names it, because the window
         is five matches wide and has nothing to do with the page's date
         range. */
      date: g.date,
      values: { rate: Number(mean[i].toFixed(2)) },
      note: `${vals[i]} in this match · ${teamLabel(teamOf(g))}`,
    });
  });
  return out;
}

/* ── running ─────────────────────────────────────────────────────────────── */

/** Distance-weighted pace per month — the only honest way to average a pace. */
/**
 * Distance-weighted pace per period.
 *
 * Takes the grain rather than hardcoding months, because the page carries one
 * period control and every panel that buckets by time has to obey it. A chart
 * that silently stayed monthly while its neighbour switched to weeks is a
 * control the reader cannot trust: they have no way to tell what it changed
 * and what it did not.
 */
export function paceByPeriod(runs, grain = 'month') {
  const bucket = new Map();
  for (const r of runs) {
    if (!r.distance_km || !r.duration_min) continue;
    const key = grain === 'week' ? weekStart(r.date) : r.date.slice(0, 7);
    if (!bucket.has(key)) bucket.set(key, { km: 0, sec: 0, n: 0 });
    const b = bucket.get(key);
    b.km += Number(r.distance_km);
    b.sec += Number(r.duration_min) * 60;
    b.n += 1;
  }
  return [...bucket.entries()].sort().map(([key, b]) => ({
    key, label: grain === 'week' ? fmt.date(key) : fmt.monthYear(key),
    values: { pace: b.sec / b.km },
    note: `${b.n} run${b.n === 1 ? '' : 's'} · ${b.km.toFixed(1)} km`,
  }));
}

/** Kept for callers that genuinely want months. */
export const paceByMonth = (runs) => paceByPeriod(runs, 'month');

export const DISTANCE_BUCKETS = [
  { key: 'u3', label: 'under 3', min: 0, max: 3 },
  { key: '3-5', label: '3–5', min: 3, max: 5 },
  { key: '5-8', label: '5–8', min: 5, max: 8 },
  { key: '8-12', label: '8–12', min: 8, max: 12 },
  { key: 'o12', label: '12+', min: 12, max: Infinity },
];

export function distanceHistogram(runs) {
  const rows = DISTANCE_BUCKETS.map((b) => ({ key: b.key, label: b.label, values: { n: 0 }, total: 0 }));
  for (const r of runs) {
    if (!r.distance_km) continue;
    const i = DISTANCE_BUCKETS.findIndex((b) => r.distance_km >= b.min && r.distance_km < b.max);
    if (i < 0) continue;
    rows[i].values.n += 1;
    rows[i].total += 1;
  }
  return rows;
}

/** Aggregate HR zone split across whatever runs actually carry one. */
/**
 * Time in each heart-rate zone across a set of sessions.
 *
 * Weighted by duration, which is the only way the aggregate means anything.
 * Each session stores its zones as *percentages of that session*, so adding
 * them raw made a twelve-minute jog count as much as a hundred-minute match
 * and produced totals like "365 pts" — a unit that does not exist, under a
 * caption conceding it was "not a total of anything".
 *
 * Multiplying each share by that session's minutes gives minutes in zone,
 * which sums, compares, and answers the question the panel is actually asking:
 * how much of your training time was spent how hard.
 *
 * Sessions with zones but no duration are counted in `sessions` and excluded
 * from `totals` — they cannot be weighted, and weighting them as zero would
 * quietly shrink every share around them.
 */
export function zoneSplit(runs) {
  const totals = {};
  let sessions = 0;
  let minutes = 0;
  let unweighable = 0;
  for (const r of runs || []) {
    const z = (r.detail || {}).zones;
    if (!z || !Object.keys(z).length) continue;
    sessions += 1;
    const mins = Number(r.duration_min || 0);
    if (!mins) { unweighable += 1; continue; }
    /* Normalise first: a split that rounds to 99 or 101 must not tilt the
       weighting by a percent. */
    const share = Object.values(z).reduce((a, v) => a + Number(v || 0), 0);
    if (!share) continue;
    minutes += mins;
    for (const [k, v] of Object.entries(z)) {
      totals[k] = (totals[k] || 0) + (Number(v || 0) / share) * mins;
    }
  }
  return { totals, runs: sessions, sessions, minutes, unweighable };
}

export function runReadout(runs, longest) {
  const out = [];
  if (!runs.length) return out;
  const km = runs.reduce((a, r) => a + Number(r.distance_km || 0), 0);
  const sec = runs.reduce((a, r) => a + Number(r.duration_min || 0) * 60, 0);
  out.push(`${runs.length} runs, ${fmt.one(km)} km and ${fmt.mins(sec / 60)} of running in this window.`);
  if (km > 0) out.push(`Distance-weighted mean pace ${fmt.pace(sec / km)} across every logged kilometre.`);
  if (longest) {
    out.push(`Longest run ${fmt.km(longest.distance_km)} in ${fmt.clock(longest.duration_min)} on ${fmt.dateY(longest.date)}.`);
  }
  const rpe = meanRpe(runs);
  if (rpe != null) out.push(`Time-weighted mean RPE ${fmt.one(rpe)} for running.`);

  const comp = runs.filter((r) => (r.detail || {}).compliance_pct != null);
  if (comp.length >= 3) {
    const mean = comp.reduce((a, r) => a + Number(r.detail.compliance_pct), 0) / comp.length;
    out.push(`${comp.length} runs carry a coach-compliance figure, averaging ${Math.round(mean)}%.`);
  }
  const { sessions: zoned, minutes: zMin } = zoneSplit(runs);
  if (zoned) {
    out.push(`${zoned} run${zoned === 1 ? '' : 's'} recorded an HR zone split, `
      + `${fmt.mins(zMin)} of running in total; the rest were logged without one.`);
  }

  const wk = byWeekday(runs);
  const ranked = wk.slice().sort((a, b) => b.count - a.count);
  if (ranked[0] && ranked[0].count) {
    out.push(`${dayName(ranked[0].key)} is the most common running day — ${ranked[0].count} of ${runs.length}.`);
  }
  return out;
}

/* ── pace at the key distances ───────────────────────────────────────────── */

/**
 * The distances worth being faster at. Race distances plus the 3 km the
 * record already holds a handful of; no mile, by the user's rule. Every one
 * is a whole run: the record carries no splits, so a 5 km is a run of about
 * five kilometres, never the quickest five inside a ten.
 */
export const KEY_DISTANCES = [
  { key: '3k', label: '3 km', km: 3 },
  { key: '5k', label: '5 km', km: 5 },
  { key: '8k', label: '8 km', km: 8 },
  { key: '10k', label: '10 km', km: 10 },
  { key: 'half', label: 'Half', long: 'half marathon', km: 21.1 },
  { key: 'marathon', label: 'Marathon', long: 'marathon', km: 42.2 },
];

/**
 * How far off the nominal distance a run can be and still count for it.
 * ±0.15 km by the user's rule — 5.03 is a 5 km and so is 4.87. The margin is
 * absolute rather than proportional so a 9.7 km interval session is not called
 * a 10 km; it widens to 1.5% only where that is larger, which at these
 * distances means the half (±0.32 km) and the marathon (±0.63 km), because a
 * watch reads a half-marathon course at 21.3 or 21.4 as a matter of routine.
 */
export const DISTANCE_TOLERANCE_KM = 0.15;
export const toleranceFor = (km) => Math.max(DISTANCE_TOLERANCE_KM, km * 0.015);

/** Pace in s/km: the stored figure, else duration over distance. */
export function paceOf(r) {
  if (r.pace_s_per_km) return Number(r.pace_s_per_km);
  if (r.distance_km && r.duration_min) return (Number(r.duration_min) * 60) / Number(r.distance_km);
  return null;
}

/** Runs counting for one key distance, oldest first. */
export function runsAtDistance(runs, d) {
  const tol = toleranceFor(d.km);
  return runs
    .filter((r) => r.distance_km && Math.abs(Number(r.distance_km) - d.km) <= tol && paceOf(r))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
}

/**
 * Figure points for one distance: the recorded pace of every run, oldest
 * first. Nothing smoothed — a rolling mean was drawn through them once and
 * taken out by the user's rule: what was recorded is the number.
 */
export function pacePoints(matched) {
  return matched.map((r, i) => ({
    key: String(r.id ?? i),
    label: fmt.date(r.date),
    values: { pace: paceOf(r) },
    note: `${fmt.km(r.distance_km)} in ${fmt.clock(r.duration_min)}${r.notes ? ` · ${r.notes}` : ''}`,
  }));
}

/**
 * One distance, summarised from recorded runs only: how many, the best, the
 * latest, and the run before the latest. Nothing averaged — a first-three
 * against last-three comparison was here and was removed as not useful.
 */
export function distanceSummary(runs, d) {
  const matched = runsAtDistance(runs, d);
  const n = matched.length;
  const best = n ? matched.reduce((a, r) => (paceOf(r) < paceOf(a) ? r : a)) : null;
  return {
    d, matched, n, best,
    latest: n ? matched[n - 1] : null,
    previous: n > 1 ? matched[n - 2] : null,
    tolerance: toleranceFor(d.km),
  };
}

/* ── lifting ─────────────────────────────────────────────────────────────── */

/* The notebook has no weight×reps anywhere. What it does have is a scope
   written into the note — work, home, small home, hotel — so that is the
   structure this page reports on rather than inventing one. */
const LIFT_KINDS = [
  [/\bwork\b/i, 'work', 'Work'],
  [/\bsmall\s+home\b/i, 'smallhome', 'Small home'],
  [/\bhome\b/i, 'home', 'Home'],
  [/\bhotel\b/i, 'hotel', 'Hotel'],
  [/\b(pull\s?ups?|push\s?ups?|burnout|dips)\b/i, 'bodyweight', 'Bodyweight'],
];

export function liftCategory(session) {
  const n = session.notes || '';
  for (const [re, key] of LIFT_KINDS) if (re.test(n)) return key;
  return 'unlabelled';
}

export const liftLabel = (key) =>
  (LIFT_KINDS.find((k) => k[1] === key) || [])[2] || 'Unlabelled';

const REP_SERIES = /(?:^|[\s\-–])(\d{1,4}(?:\s*\/\s*\d{1,4}){1,})/;

/** "31/80/95/155/30/45/30" → {sets: 7, reps: 466}. Absent on most sessions. */
export function repSeries(session) {
  const m = REP_SERIES.exec(session.notes || '');
  if (!m) return null;
  const parts = m[1].split('/').map((p) => Number(p.trim())).filter((n) => Number.isFinite(n));
  if (parts.length < 2) return null;
  return { sets: parts.length, reps: parts.reduce((a, b) => a + b, 0), parts };
}

export function liftReadout(lifts, today) {
  const out = [];
  if (!lifts.length) {
    out.push('No lifting on record in this window.');
    return out;
  }
  const sorted = lifts.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = sorted[sorted.length - 1];
  const days = Math.round((dateOf(today) - dateOf(last.date)) / 86400000);

  out.push(`${lifts.length} lifting sessions in this window, ${fmt.mins(lifts.reduce((a, s) => a + Number(s.duration_min || 0), 0))} in total.`);
  out.push(`Last lifting session ${fmt.dateY(last.date)} — ${days} day${days === 1 ? '' : 's'} ago.`);

  const cats = {};
  for (const s of lifts) {
    const c = liftCategory(s);
    cats[c] = (cats[c] || 0) + 1;
  }
  const top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
  if (top) out.push(`Most common scope: ${liftLabel(top[0]).toLowerCase()}, ${top[1]} of ${lifts.length} sessions.`);

  const rpe = meanRpe(lifts);
  if (rpe != null) out.push(`Time-weighted mean RPE ${fmt.one(rpe)} for lifting.`);

  const withReps = lifts.map(repSeries).filter(Boolean);
  if (withReps.length) {
    const reps = withReps.reduce((a, r) => a + r.reps, 0);
    out.push(`${withReps.length} sessions record a rep series, ${fmt.int(reps)} reps across ${withReps.reduce((a, r) => a + r.sets, 0)} sets. The rest note only a scope.`);
  }
  out.push('No weight×reps exists anywhere in this record, so there is no e1RM to compute and none is shown.');
  return out;
}

/* ── read-outs ───────────────────────────────────────────────────────────── */

/**
 * Factual sentences. Each one names a figure and the window it came from; if
 * there is nothing specific to say, nothing is said.
 */
export function weekReadout(d) {
  const out = [];
  const weeks = d.load_by_week || [];
  const totals = weeks.map((w) => w.total || 0);
  const vs = versusBaseline(totals, { window: weeks.length - 1 });

  if (vs && vs.pct != null && Number.isFinite(vs.pct)) {
    const dir = vs.delta >= 0 ? 'above' : 'below';
    out.push(`Load ${fmt.int(vs.current)} AU, ${Math.abs(Math.round(vs.pct))}% ${dir} the ${vs.weeks}-week mean of ${fmt.int(vs.mean)} AU.`);
  }

  for (const k of KINDS) {
    const series = weeks.map((w) => (w.by_kind || {})[k] || 0);
    if (!series.some((v) => v > 0)) continue;
    const kv = versusBaseline(series, { window: weeks.length - 1 });
    if (!kv || !Number.isFinite(kv.mean) || kv.mean < 1) continue;

    /* A percentage off a near-zero baseline ("up 3213%") is arithmetically
       true and completely useless. Past 150% the two absolute numbers say
       more, and a zero week is stated as a zero week rather than "down 100%". */
    if (kv.current === 0) {
      out.push(`${cap(k)}: nothing this week, against ${article(kv.weeks)} ${kv.weeks}-week mean of ${fmt.int(kv.mean)} AU.`);
    } else if (kv.pct == null || Math.abs(kv.pct) > 150) {
      out.push(`${cap(k)} ${fmt.int(kv.current)} AU this week against ${article(kv.weeks)} ${kv.weeks}-week mean of ${fmt.int(kv.mean)} AU.`);
    } else if (Math.abs(kv.pct) >= 25) {
      const dir = kv.delta >= 0 ? 'up' : 'down';
      out.push(`${cap(k)} ${fmt.int(kv.current)} AU, ${dir} ${Math.abs(Math.round(kv.pct))}% on its ${kv.weeks}-week mean of ${fmt.int(kv.mean)} AU.`);
    }
  }

  const sessions = d.sessions || [];
  if (sessions.length) {
    const days = new Set(sessions.map((s) => s.date)).size;
    out.push(`${sessions.length} session${sessions.length === 1 ? '' : 's'} across ${days} day${days === 1 ? '' : 's'} of the week.`);
    const scored = sessions.filter((s) => s.load);
    if (scored.length > 1) {
      const top = scored.reduce((a, s) => (s.load > a.load ? s : a));
      out.push(`Heaviest single session ${fmt.int(top.load)} AU — ${top.kind} on ${fmt.dateY(top.date)}.`);
    }
  }

  const zero = weeks.filter((w) => !w.total).length;
  if (zero) out.push(`${zero} of the last ${weeks.length} weeks logged no scored load.`);

  /* The API sends kg because the database stores kg. Every other surface
     converts before printing; this line did not, so the read-out said 96.5 kg
     directly under a header saying 212.8 lb. */
  const bw = d.bodyweight || {};
  const u = getWeightUnit();
  /* Readings, like every other bodyweight surface. This line printed the
     server's seven-day EMA — "Bodyweight EMA 211.8 lb, −0.4 lb over four
     weeks" — beside a tile reading 210 lb built from the same block. There is
     no EMA fallback: if there are no readings there is no weight to report,
     and a curve through nothing is not a substitute. */
  const bwLast = latestWeighIn(bw.series);
  const bwDelta = weighInDelta(bw.series, 28);
  if (bwLast) {
    out.push(`Bodyweight ${fmt.whole(inUnit(bwLast.kg, u))} ${u}`
      + (bwDelta
        ? `, ${fmt.wholeSigned(inUnit(bwDelta.kg, u))} ${u} since ${fmt.dateY(bwDelta.from.date)}.`
        : '.'));
  }
  return out;
}

export function soccerReadout(d) {
  const out = [];
  const games = d.games || [];
  const rec = d.record || {};
  const played = d.games_played || 0;

  if (played) {
    out.push(`${rec.w}W ${rec.l}L ${rec.d}D across ${played} matches — a ${Math.round((d.win_rate || 0) * 100)}% win rate.`);
    out.push(`${fmt.int(d.goals_for)} scored against ${fmt.int(d.goals_against)} conceded, ${fmt.signed((d.goals_for || 0) - (d.goals_against || 0), '', 0)} difference.`);
  }
  /* The server's figure, not a second division. This line used to divide by
     `played` (54) while the stat tile above divided by matches carrying a goal
     line (45), so the same page said 2.31 here and 2.78 there. One number, and
     it names what it divided by. */
  if (d.goals != null && d.involvements_per_match != null) {
    out.push(`${fmt.int(d.goals)} goals and ${fmt.int(d.assists)} assists — `
      + `${fmt.two(d.involvements_per_match)} involvements per match, over the `
      + `${fmt.int(d.matches_with_involvement)} matches with a goal line. `
      + `The other ${fmt.int(played - d.matches_with_involvement)} of ${played} `
      + 'were logged without one, so they are unknown rather than zero.');
  }

  const last10 = games.filter((g) => g.result).slice(-10);
  if (last10.length === 10) {
    const w = last10.filter((g) => g.result === 'W').length;
    const l = last10.filter((g) => g.result === 'L').length;
    out.push(`Last ten matches: ${w}W ${l}L ${10 - w - l}D. Rolling window, not a streak.`);
  }

  /* `pickup` is the server's resolved fixture now — explicit field, then note,
     then weekday — which is what the By-fixture table groups by. It used to be
     a narrower rule here (field or the word in the note only), so this line
     said 6 pickup matches beside a table row saying 8. */
  const pickup = games.filter((g) => g.pickup && g.result);
  const organised = games.filter((g) => !g.pickup && g.result);
  if (pickup.length >= 3 && organised.length >= 3) {
    const rate = (list) => Math.round((list.filter((g) => g.result === 'W').length / list.length) * 100);
    out.push(`Pickup ${rate(pickup)}% won over ${pickup.length} matches; organised ${rate(organised)}% over ${organised.length}.`);
  }

  const scored = games.filter((g) => g.goals != null && g.result);
  if (scored.length >= 6) {
    const withGoal = scored.filter((g) => g.goals > 0);
    const without = scored.filter((g) => g.goals === 0);
    if (withGoal.length >= 3 && without.length >= 3) {
      const rate = (list) => Math.round((list.filter((g) => g.result === 'W').length / list.length) * 100);
      out.push(`When on the scoresheet the record is ${rate(withGoal)}% won over ${withGoal.length} matches; when not, ${rate(without)}% over ${without.length}.`);
    }
  }

  const scoredGames = games.filter((g) => g.gf != null && g.ga != null);
  if (scoredGames.length) {
    const best = scoredGames.reduce((a, g) => ((g.gf - g.ga) > (a.gf - a.ga) ? g : a));
    const worst = scoredGames.reduce((a, g) => ((g.gf - g.ga) < (a.gf - a.ga) ? g : a));
    out.push(`Widest margins: ${best.gf}–${best.ga} on ${fmt.dateY(best.date)}, ${worst.gf}–${worst.ga} on ${fmt.dateY(worst.date)}.`);
  }
  return out;
}

export function historyReadout(h, sessions) {
  const out = [];
  const years = h.years || [];
  /* No derived average here: /api/summary already publishes the authoritative
     one and a second, slightly different figure on the same screen is worse
     than no figure at all. */
  if (h.total && h.weeks) {
    out.push(`${fmt.int(h.total)} activities over ${h.weeks} weeks, ${fmt.dateY(h.start)} to ${fmt.dateY(h.end)}.`);
  }
  for (const y of years) {
    out.push(`${y.year}: ${fmt.int(y.activities)} activities at ${fmt.two(y.avg_per_week)} a week, ${fmt.int(y.active_days)} active days, ${fmt.int(y.distance_km)} km.`);
  }

  const g = gaps(h);
  if (g) {
    out.push(`Something logged on ${fmt.int(g.activeDays)} of ${fmt.int((h.counts || []).length)} days, ${Math.round(g.coverage * 100)}% coverage.`);
    out.push(`Longest gap between entries ${g.longest} days, ending ${fmt.dateY(g.longestEnded)}; the typical gap is ${g.median}.`);
  }

  if (years.length >= 2) {
    const a = years[0];
    const b = years[years.length - 1];
    const share = (y, k) => {
      const t = Object.values(y.by_kind || {}).reduce((x, v) => x + v, 0) || 1;
      return ((y.by_kind || {})[k] || 0) / t;
    };
    for (const k of KINDS) {
      const from = share(a, k);
      const to = share(b, k);
      if (Math.max(from, to) < 0.12) continue;
      if (Math.abs(to - from) < 0.08) continue;
      out.push(`${cap(k)} moved from ${Math.round(from * 100)}% of entries in ${a.year} to ${Math.round(to * 100)}% in ${b.year}.`);
    }
  }

  if (sessions && sessions.length) {
    const rpe = meanRpe(sessions);
    if (rpe != null) out.push(`Time-weighted mean RPE ${fmt.one(rpe)} across every scored minute on record.`);
    const wk = byWeekday(sessions);
    const top = wk.slice().sort((a, b) => b.total - a.total)[0];
    const grand = wk.reduce((x, r) => x + r.total, 0) || 1;
    if (top && top.total) {
      out.push(`${dayName(top.key)} carries the most load — ${Math.round((top.total / grand) * 100)}% of every AU logged.`);
    }
  }
  return out;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/* 8, 11 and 18 take "an"; everything else in this range takes "a". */
const article = (n) => (/^(8|11|18)/.test(String(n)) ? 'an' : 'a');
const dayName = (short) => ({
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
}[short] || short);

export function trendsReadout(d, sessions, { metric, grain, kind }) {
  const out = [];
  const points = d.points || [];
  const values = points.map((p) => Number(p.value) || 0);
  const grainWord = grain === 'month' ? 'month' : 'week';
  if (!points.length) return out;

  const total = values.reduce((a, b) => a + b, 0);
  const active = values.filter((v) => v > 0).length;
  const unit = d.unit || '';
  out.push(`${fmt.int(total)} ${unit} over ${points.length} ${grainWord}s, ${active} of which had activity.`);

  const half = Math.floor(points.length / 2);
  if (points.length >= 6) {
    const a = values.slice(0, half).reduce((x, v) => x + v, 0) / half;
    const b = values.slice(half).reduce((x, v) => x + v, 0) / (points.length - half);
    if (a > 0) {
      const pct = ((b - a) / a) * 100;
      out.push(`Second half of the window averaged ${fmt.int(b)} ${unit} a ${grainWord} against ${fmt.int(a)} in the first — ${fmt.signed(pct, '%', 0)}.`);
    }
  }

  const peak = Math.max(...values);
  const peakAt = points[values.indexOf(peak)];
  if (peak > 0) out.push(`Peak ${grainWord}: ${fmt.int(peak)} ${unit}, ${grain === 'month' ? fmt.monthYear(peakAt.period) : `week of ${fmt.dateY(peakAt.period)}`}.`);

  if (sessions && sessions.length) {
    const rpe = meanRpe(sessions);
    if (rpe != null) {
      out.push(`${fmt.int(sessions.length)} sessions in range at a time-weighted mean RPE of ${fmt.one(rpe)}.`);
    }
    const wk = byWeekday(sessions);
    const grand = wk.reduce((x, r) => x + r.total, 0) || 1;
    const ranked = wk.slice().sort((a, b) => b.total - a.total);
    if (ranked[0] && ranked[0].total) {
      out.push(`${dayName(ranked[0].key)} and ${dayName(ranked[1].key)} carry ${Math.round(((ranked[0].total + ranked[1].total) / grand) * 100)}% of the load in this window.`);
    }
    const empty = wk.filter((r) => !r.count);
    if (empty.length) out.push(`Nothing logged on ${empty.map((r) => dayName(r.key)).join(' or ')} in this window.`);
  }

  if (metric === 'load' && !kind) {
    const kinds = KINDS.filter((k) => points.some((p) => (p.by_kind || {})[k] > 0));
    const share = {};
    for (const k of kinds) share[k] = points.reduce((a, p) => a + ((p.by_kind || {})[k] || 0), 0);
    const grand = Object.values(share).reduce((a, b) => a + b, 0) || 1;
    const top = Object.entries(share).sort((a, b) => b[1] - a[1])[0];
    if (top) out.push(`${cap(top[0])} is ${Math.round((top[1] / grand) * 100)}% of all load in this window.`);
  }
  return out;
}

/* ── week intent ─────────────────────────────────────────────────────────── */

/* Planned counts per modality, written by #/intent into this browser's
   localStorage. Read here rather than in each view so the two pages that care
   — the intent editor and the scoreboard — cannot disagree about what was
   planned for a given week. */
const PLAN_KEY = 'ledger.plan';

export function readPlans() {
  try { return JSON.parse(localStorage.getItem(PLAN_KEY) || '{}'); } catch { return {}; }
}

/**
 * The intent that applies to a week — carried forward.
 *
 * Targets barely move week to week, and retyping them every Monday is how a
 * planning feature stops being used by the second week. So a week with no
 * entry of its own inherits the most recent earlier one, and says it inherited
 * it. Setting a week explicitly stops the inheritance from that week forward.
 *
 * Returns `{ kinds, note, week, inherited }`. `week` is the week the numbers
 * actually came from, which is the part the UI has to be able to name.
 */
export function weekIntent(weekISO, plans = readPlans()) {
  const own = plans[weekISO];
  if (own && Object.keys(own.kinds || {}).length) {
    return { kinds: { ...own.kinds }, note: own.note || '', week: weekISO, inherited: false };
  }
  const earlier = Object.keys(plans)
    .filter((w) => w < weekISO && Object.keys((plans[w] || {}).kinds || {}).length)
    .sort();
  const from = earlier[earlier.length - 1];
  if (!from) return { kinds: {}, note: '', week: null, inherited: false };
  return {
    kinds: { ...plans[from].kinds },
    note: (own && own.note) || '',
    week: from,
    inherited: true,
  };
}

/* ── goal weight ─────────────────────────────────────────────────────────── */

/* The target the bodyweight pillar scores movement toward. Set on the Plan
   page — planning is where a goal belongs — and read by the Scoreboard, so it
   lives here rather than in either view. Pounds, because the notebook is in
   pounds and so is the user's head; everything downstream converts. */
const GOAL_KEY = 'ledger.goalWeightLb';
/* No goal until one is set: the bodyweight pillar stays off the Scoreboard
   rather than scoring movement toward a number nobody chose. */
export const DEFAULT_GOAL_LB = null;

export function goalWeightLb() {
  let v = NaN;
  try { v = Number(localStorage.getItem(GOAL_KEY)); } catch { /* private mode */ }
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_GOAL_LB;
}

export function setGoalWeightLb(lb) {
  const v = Number(lb);
  if (!Number.isFinite(v) || v <= 0) return false;
  try { localStorage.setItem(GOAL_KEY, String(v)); return true; } catch { return false; }
}
