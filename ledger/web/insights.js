/* Ledger — the findings engine.
 *
 * Everything here runs on this device against the user's own record. There is
 * no model and no network call: the rule for this project is that it still runs
 * in five years with no maintenance, and a remote service is the first thing
 * that stops being true. What this gives up in cleverness it gets back in
 * being reproducible — every finding below is arithmetic you could redo by
 * hand from the session log.
 *
 * Three rules hold for every generator:
 *
 *   1. Nothing is reported below its minimum sample size. A finding drawn from
 *      four matches is not a finding.
 *   2. Every finding carries its denominator, and the interface prints it.
 *   3. Nothing claims causation. Two things moving in the same window are
 *      described as moving in the same window, and the page says so outright.
 *
 * Each generator returns null or {id, section, headline, detail, n, weight}.
 * `weight` is only used for ordering within a section — bigger effect and
 * bigger sample float up.
 */

import { fmt, KINDS, dateOf, addDays, kgToLb } from './core.js';
import {
  teamOf, teamLabel, soccerByTeam, byWeekday, meanRpe, rollingSum,
  liftCategory, liftLabel, repSeries, bodyweightByMonth, fastingByMonth, monthSpan,
} from './dataset.js';

const pct = (x) => `${Math.round(x * 100)}%`;
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const dayName = (k) => ({
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
}[k] || k);

const finding = (o) => ({ weight: 1, ...o });

/* ══ soccer ═══════════════════════════════════════════════════════════════ */

function soccerTeams(ctx) {
  const allRows = soccerByTeam(ctx.soccer);
  /* Compared only across fixtures with enough matches to compare, but the
     overall record below has to reconcile with /api/soccer, so it sums all. */
  const rows = allRows.filter((r) => r.played >= 6);
  if (rows.length < 2) return null;
  const best = rows.slice().sort((a, b) => b.winRate - a.winRate)[0];
  const worst = rows.slice().sort((a, b) => a.winRate - b.winRate)[0];
  if (best.key === worst.key) return null;
  return finding({
    id: 'soccer-teams', section: 'Soccer',
    headline: `${best.label} is the fixture you win most — ${pct(best.winRate)} of ${best.played} matches.`,
    detail: `${worst.label} sits at ${pct(worst.winRate)} of ${worst.played}. Across every fixture the record is `
      + `${allRows.reduce((a, r) => a + r.w, 0)}W ${allRows.reduce((a, r) => a + r.l, 0)}L ${allRows.reduce((a, r) => a + r.d, 0)}D`
      + `${allRows.length > rows.length ? `, including ${allRows.length - rows.length} fixture with too few matches to rank` : ''}.`,
    n: allRows.reduce((a, r) => a + r.played, 0),
    weight: Math.abs(best.winRate - worst.winRate) * Math.min(best.played, worst.played),
  });
}

function soccerInvolvementByTeam(ctx) {
  const rows = soccerByTeam(ctx.soccer).filter((r) => r.scored >= 5);
  if (rows.length < 2) return null;
  const top = rows.slice().sort((a, b) => b.involvementsPerGame - a.involvementsPerGame)[0];
  const low = rows.slice().sort((a, b) => a.involvementsPerGame - b.involvementsPerGame)[0];
  if (top.key === low.key) return null;
  return finding({
    id: 'soccer-ga-team', section: 'Soccer',
    headline: `You are on the scoresheet most in ${top.label}: ${top.involvementsPerGame.toFixed(2)} goals plus assists per match.`,
    detail: `${top.goals} goals and ${top.assists} assists across ${top.scored} matches there, against `
      + `${low.involvementsPerGame.toFixed(2)} per match in ${low.label} over ${low.scored}.`,
    n: rows.reduce((a, r) => a + r.scored, 0),
    weight: (top.involvementsPerGame - low.involvementsPerGame) * Math.min(top.scored, low.scored),
  });
}

function soccerScoringAndResult(ctx) {
  const games = ctx.soccer.filter((s) => (s.detail || {}).result && (s.detail || {}).goals != null);
  const on = games.filter((g) => Number(g.detail.goals) > 0);
  const off = games.filter((g) => Number(g.detail.goals) === 0);
  if (on.length < 5 || off.length < 5) return null;
  const rate = (l) => l.filter((g) => g.detail.result === 'W').length / l.length;
  const delta = rate(on) - rate(off);
  return finding({
    id: 'soccer-scoring', section: 'Soccer',
    headline: `When you score, the team wins ${pct(rate(on))} of the time; when you do not, ${pct(rate(off))}.`,
    detail: `${on.length} matches with a goal against ${off.length} without. Which way that runs is not something `
      + 'this can tell you — a team that is winning creates more chances too.',
    n: games.length,
    weight: Math.abs(delta) * games.length,
  });
}

function soccerCloseGames(ctx) {
  const games = ctx.soccer.filter((s) => {
    const d = s.detail || {};
    return d.result && d.gf != null && d.ga != null;
  });
  if (games.length < 12) return null;
  const close = games.filter((g) => Math.abs(g.detail.gf - g.detail.ga) <= 1);
  const wide = games.filter((g) => Math.abs(g.detail.gf - g.detail.ga) >= 4);
  if (close.length < 5) return null;
  const rate = (l) => (l.length ? l.filter((g) => g.detail.result === 'W').length / l.length : 0);
  return finding({
    id: 'soccer-close', section: 'Soccer',
    headline: `${close.length} of ${games.length} matches were decided by a goal or fewer — you win ${pct(rate(close))} of those.`,
    detail: wide.length >= 4
      ? `In the ${wide.length} matches decided by four or more, the record is ${pct(rate(wide))}.`
      : 'Not enough blowouts on record to compare against.',
    n: games.length,
    weight: close.length / games.length * games.length,
  });
}

function soccerGoalsAgainst(ctx) {
  const games = ctx.soccer.filter((s) => (s.detail || {}).gf != null && (s.detail || {}).ga != null);
  if (games.length < 12) return null;
  const gf = games.reduce((a, g) => a + Number(g.detail.gf), 0);
  const ga = games.reduce((a, g) => a + Number(g.detail.ga), 0);
  return finding({
    id: 'soccer-scorelines', section: 'Soccer',
    headline: `Your matches average ${(gf / games.length).toFixed(1)} scored and ${(ga / games.length).toFixed(1)} conceded — ${((gf + ga) / games.length).toFixed(1)} goals a game.`,
    detail: `${gf} for and ${ga} against across ${games.length} matches with a scoreline. `
      + `These are high-scoring formats; the concession rate is the side of it that moves the record.`,
    n: games.length,
    weight: Math.abs(gf - ga) / games.length * 10,
  });
}

function soccerRest(ctx) {
  const games = ctx.soccer.filter((s) => (s.detail || {}).result)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (games.length < 14) return null;
  const dates = ctx.all.map((s) => s.date).sort();
  const short = [];
  const rested = [];
  for (const g of games) {
    const prior = dates.filter((d) => d < g.date);
    if (!prior.length) continue;
    const gap = Math.round((dateOf(g.date) - dateOf(prior[prior.length - 1])) / 86400000);
    (gap <= 1 ? short : rested).push(g);
  }
  if (short.length < 6 || rested.length < 6) return null;
  const rate = (l) => l.filter((g) => g.detail.result === 'W').length / l.length;
  return finding({
    id: 'soccer-rest', section: 'Soccer',
    headline: `With a day or less since the last session you win ${pct(rate(short))} of matches; with two or more, ${pct(rate(rested))}.`,
    detail: `${short.length} matches on short turnaround against ${rested.length} on a longer one. `
      + 'Fixtures are not randomly assigned to rest, so read this as a pattern in the calendar rather than an effect of it.',
    n: short.length + rested.length,
    weight: Math.abs(rate(short) - rate(rested)) * (short.length + rested.length),
  });
}

function soccerBestSpell(ctx) {
  const games = ctx.soccer.filter((s) => (s.detail || {}).goals != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (games.length < 12) return null;
  const vals = games.map((g) => Number(g.detail.goals || 0) + Number(g.detail.assists || 0));
  const win = 5;
  const sums = rollingSum(vals, win);
  let bestI = -1;
  let best = -1;
  sums.forEach((v, i) => { if (v != null && v > best) { best = v; bestI = i; } });
  if (bestI < 0) return null;
  return finding({
    id: 'soccer-spell', section: 'Soccer',
    headline: `Your densest five-match spell produced ${best} goals and assists, ending ${fmt.dateY(games[bestI].date)}.`,
    detail: `Across all ${games.length} matches with goal data you average `
      + `${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)} involvements a match. `
      + 'A rolling window, not a streak — it cannot be broken, only bettered.',
    n: games.length,
    weight: best,
  });
}

/* ══ load ═════════════════════════════════════════════════════════════════ */

function loadShare(ctx) {
  const scored = ctx.all.filter((s) => s.load);
  if (scored.length < 30) return null;
  const by = {};
  for (const s of scored) by[s.kind] = (by[s.kind] || 0) + Number(s.load);
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const [topKind, topLoad] = ranked[0];
  const counts = {};
  for (const s of scored) counts[s.kind] = (counts[s.kind] || 0) + 1;
  return finding({
    id: 'load-share', section: 'Training load', pin: true,
    headline: `${cap(topKind)} is ${pct(topLoad / total)} of your training load from ${pct(counts[topKind] / scored.length)} of your sessions.`,
    detail: `${fmt.int(topLoad)} of ${fmt.int(total)} AU across ${counts[topKind]} of ${scored.length} scored sessions. `
      + 'A watch that only counts what it recorded reports a very different training week from this one.',
    n: scored.length,
    weight: 100,
  });
}

function loadConcentration(ctx) {
  const scored = ctx.all.filter((s) => s.load).sort((a, b) => b.load - a.load);
  if (scored.length < 40) return null;
  const total = scored.reduce((a, s) => a + Number(s.load), 0);
  const tenth = Math.max(1, Math.round(scored.length * 0.1));
  const top = scored.slice(0, tenth).reduce((a, s) => a + Number(s.load), 0);
  const kinds = {};
  for (const s of scored.slice(0, tenth)) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  const dominant = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0];
  return finding({
    id: 'load-concentration', section: 'Training load',
    headline: `The heaviest 10% of your sessions carry ${pct(top / total)} of all training load.`,
    detail: `${tenth} sessions out of ${scored.length}, and ${dominant[1]} of them are ${dominant[0]}. `
      + 'Volume in this record is made by a small number of long, hard sessions rather than by many small ones.',
    n: scored.length,
    weight: (top / total) * 40,
  });
}

function loadWeekday(ctx) {
  const scored = ctx.all.filter((s) => s.load);
  if (scored.length < 40) return null;
  const wk = byWeekday(scored);
  const total = wk.reduce((a, r) => a + r.total, 0) || 1;
  const ranked = wk.slice().sort((a, b) => b.total - a.total);
  const quiet = wk.slice().sort((a, b) => a.total - b.total)[0];
  return finding({
    id: 'load-weekday', section: 'Training load',
    headline: `${dayName(ranked[0].key)} and ${dayName(ranked[1].key)} carry ${pct((ranked[0].total + ranked[1].total) / total)} of everything you do.`,
    detail: `${dayName(quiet.key)} is the quietest at ${pct(quiet.total / total)} `
      + `(${quiet.count} session${quiet.count === 1 ? '' : 's'}). Your week has a fixed shape, and it is built around the fixtures.`,
    n: scored.length,
    weight: (ranked[0].total + ranked[1].total) / total * 30,
  });
}

function biggestWeek(ctx) {
  const weeks = ctx.loadWeeks || [];
  if (weeks.length < 8) return null;
  const top = weeks.reduce((a, w) => (w.total > a.total ? w : a));
  if (!top.total) return null;
  const parts = Object.entries(top.by_kind || {}).sort((a, b) => b[1] - a[1]);
  const mean = weeks.reduce((a, w) => a + w.total, 0) / weeks.length;
  return finding({
    id: 'load-peak', section: 'Training load',
    headline: `Your heaviest week in this window was ${fmt.int(top.total)} AU, beginning ${fmt.dateY(top.week_start)}.`,
    detail: `${parts.map(([k, v]) => `${k} ${fmt.int(v)}`).join(', ')}. `
      + `The typical week over the same span is ${fmt.int(mean)} AU, so that one was ${(top.total / mean).toFixed(1)}× normal.`,
    n: weeks.length,
    weight: top.total / (mean || 1) * 5,
  });
}

function rpeProfile(ctx) {
  const rows = KINDS.map((k) => {
    const list = ctx.all.filter((s) => s.kind === k && s.rpe != null && s.duration_min);
    return { k, n: list.length, rpe: meanRpe(list) };
  }).filter((r) => r.n >= 8 && r.rpe != null);
  if (rows.length < 2) return null;
  const hard = rows.slice().sort((a, b) => b.rpe - a.rpe)[0];
  const easy = rows.slice().sort((a, b) => a.rpe - b.rpe)[0];
  return finding({
    id: 'rpe-profile', section: 'Training load',
    headline: `${cap(hard.k)} is what you rate hardest — a time-weighted mean RPE of ${hard.rpe.toFixed(1)}.`,
    detail: `${cap(easy.k)} sits at ${easy.rpe.toFixed(1)}. Full ranking: `
      + rows.slice().sort((a, b) => b.rpe - a.rpe).map((r) => `${r.k} ${r.rpe.toFixed(1)} (n=${r.n})`).join(', ') + '.',
    n: rows.reduce((a, r) => a + r.n, 0),
    weight: (hard.rpe - easy.rpe) * 6,
  });
}

function unscored(ctx) {
  const miss = ctx.all.filter((s) => s.rpe == null && s.kind !== 'fast');
  if (miss.length < 5) return null;
  const by = {};
  for (const s of miss) by[s.kind] = (by[s.kind] || 0) + 1;
  const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  return finding({
    id: 'unscored', section: 'Training load',
    headline: `${miss.length} sessions carry no RPE, so they contribute nothing to load.`,
    detail: `Mostly ${top[0]} (${top[1]}). Every one of those is real training that the unified-load number cannot see. `
      + 'An RPE added later on the edit screen fixes it retroactively.',
    n: ctx.all.length,
    weight: miss.length / ctx.all.length * 25,
  });
}

/* ══ body & fasting ═══════════════════════════════════════════════════════ */

function weightRange(ctx) {
  const pts = (ctx.bodyweight || []).filter((p) => p.kg != null);
  if (pts.length < 12) return null;
  const u = ctx.unit;
  const conv = (kg) => (u === 'kg' ? kg : kgToLb(kg));
  const kgs = pts.map((p) => p.kg);
  const hi = pts[kgs.indexOf(Math.max(...kgs))];
  const lo = pts[kgs.indexOf(Math.min(...kgs))];
  const last = pts[pts.length - 1];
  const span = hi.kg - lo.kg;
  const posn = span ? (last.kg - lo.kg) / span : 0;
  return finding({
    id: 'weight-range', section: 'Bodyweight & fasting',
    headline: `Your weight has moved between ${conv(lo.kg).toFixed(1)} and ${conv(hi.kg).toFixed(1)} ${u} — a spread of ${conv(span).toFixed(1)} ${u}.`,
    detail: `The low was ${fmt.dateY(lo.date)}, the high ${fmt.dateY(hi.date)}, and the latest reading sits `
      + `${pct(posn)} of the way up that range. Stated, not scored.`,
    n: pts.length,
    weight: 20,
  });
}

function weightVsFasting(ctx) {
  const bw = bodyweightByMonth(ctx.bodyweight);
  const fasts = ctx.all.filter((s) => s.kind === 'fast' && (s.detail || {}).hours);
  if (bw.length < 8 || fasts.length < 6) return null;
  const months = bw.map((b) => b.key);
  const fast = fastingByMonth(fasts, months);
  const rows = [];
  for (let i = 1; i < bw.length; i++) {
    rows.push({ month: bw[i].key, delta: bw[i].kg - bw[i - 1].kg, hours: fast[i] ? fast[i].hours : 0 });
  }
  const withF = rows.filter((r) => r.hours > 0);
  const without = rows.filter((r) => r.hours === 0);
  if (withF.length < 3 || without.length < 3) return null;
  const u = ctx.unit;
  const conv = (kg) => (u === 'kg' ? kg : kgToLb(kg));
  const mean = (l) => l.reduce((a, r) => a + r.delta, 0) / l.length;
  const a = mean(withF);
  const b = mean(without);
  return finding({
    id: 'weight-fasting', section: 'Bodyweight & fasting',
    headline: `Months containing a fast moved your weight by ${fmt.signed(conv(a), ` ${u}`, 2)} on average; months without, ${fmt.signed(conv(b), ` ${u}`, 2)}.`,
    detail: `${withF.length} months with fasting against ${without.length} without, across ${fasts.length} logged fasts. `
      + 'These are two numbers from the same calendar. Fasting is far more likely in months you were already trying to move the weight, so this is co-occurrence and nothing stronger.',
    n: rows.length,
    weight: Math.abs(a - b) * 30,
  });
}

function fastingHabit(ctx) {
  const fasts = ctx.all.filter((s) => s.kind === 'fast' && (s.detail || {}).hours);
  if (fasts.length < 8) return null;
  const hours = fasts.map((f) => Number(f.detail.hours));
  const total = hours.reduce((a, b) => a + b, 0);
  const longest = Math.max(...hours);
  const byYear = {};
  for (const f of fasts) byYear[f.date.slice(0, 4)] = (byYear[f.date.slice(0, 4)] || 0) + 1;
  const years = Object.keys(byYear).sort();
  return finding({
    id: 'fasting-habit', section: 'Bodyweight & fasting',
    headline: `${fasts.length} fasts on record, ${fmt.int(total)} hours in total, the longest ${fmt.int(longest)} hours.`,
    detail: `Typical length ${(total / fasts.length).toFixed(0)} hours. By year: `
      + `${years.map((y) => `${y} ${byYear[y]}`).join(', ')}.`
      + (years.length >= 2 && byYear[years[1]] < byYear[years[0]] / 2
        ? ' The habit has thinned out considerably.' : ''),
    n: fasts.length,
    weight: 18,
  });
}

function weightVsLoad(ctx) {
  const bw = bodyweightByMonth(ctx.bodyweight);
  if (bw.length < 10) return null;
  const loadByMonth = {};
  for (const s of ctx.all) {
    if (!s.load) continue;
    const k = s.date.slice(0, 7);
    loadByMonth[k] = (loadByMonth[k] || 0) + Number(s.load);
  }
  const rows = bw.map((b) => ({ key: b.key, kg: b.kg, load: loadByMonth[b.key] || 0 }))
    .filter((r) => r.load > 0);
  if (rows.length < 8) return null;
  const medLoad = rows.map((r) => r.load).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  const heavy = rows.filter((r) => r.load >= medLoad);
  const light = rows.filter((r) => r.load < medLoad);
  if (heavy.length < 3 || light.length < 3) return null;
  const u = ctx.unit;
  const conv = (kg) => (u === 'kg' ? kg : kgToLb(kg));
  const mean = (l) => l.reduce((a, r) => a + r.kg, 0) / l.length;
  return finding({
    id: 'weight-load', section: 'Bodyweight & fasting',
    headline: `In your higher-load months you weigh ${conv(mean(heavy)).toFixed(1)} ${u}; in lower-load months, ${conv(mean(light)).toFixed(1)} ${u}.`,
    detail: `${heavy.length} months above the median of ${fmt.int(medLoad)} AU against ${light.length} below it. `
      + 'Both numbers are monthly means over the same period — which one leads the other is not something a calendar can answer.',
    n: rows.length,
    weight: Math.abs(mean(heavy) - mean(light)) * 25,
  });
}

/* ══ consistency ══════════════════════════════════════════════════════════ */

function bestWindow(ctx) {
  const h = ctx.history;
  const counts = (h && h.counts) || [];
  if (counts.length < 60) return null;
  const roll = rollingSum(counts, 28);
  let bestI = -1;
  let best = -1;
  roll.forEach((v, i) => { if (v != null && v > best) { best = v; bestI = i; } });
  if (bestI < 0) return null;
  const end = addDays(h.start, bestI);
  /* The window ending *today*, not the last one in the series. `/api/history`
     runs to the end of the current calendar week, so the final entry is a
     window ending five days in the future — it had already dropped five real
     sessions off its start and gained nothing. That read "the current 28-day
     window holds 26" beside a Week-page tile saying 31. */
  const todayI = ctx.today ? Math.round(
    (dateOf(ctx.today) - dateOf(h.start)) / 86400000) : roll.length - 1;
  const curI = Math.min(roll.length - 1, Math.max(0, todayI));
  const current = roll[curI];
  return finding({
    id: 'best-window', section: 'Consistency',
    headline: `Your densest four weeks held ${best} activities, ending ${fmt.dateY(end)}.`,
    detail: `The current 28-day window holds ${current}. This is a rolling count, so it never resets — `
      + 'a quiet fortnight lowers it and the next entry starts lifting it again.',
    n: counts.length,
    weight: 30,
  });
}

function gapsFinding(ctx) {
  const counts = (ctx.history && ctx.history.counts) || [];
  if (counts.length < 60) return null;
  const active = [];
  for (let i = 0; i < counts.length; i++) if (counts[i] > 0) active.push(i);
  if (active.length < 20) return null;
  const diffs = [];
  for (let i = 1; i < active.length; i++) diffs.push(active[i] - active[i - 1]);
  const longest = Math.max(...diffs);
  const at = addDays(ctx.history.start, active[diffs.indexOf(longest) + 1]);
  const sorted = diffs.slice().sort((a, b) => a - b);
  const back = diffs.filter((d) => d === 1).length;
  return finding({
    id: 'gaps', section: 'Consistency',
    headline: `You have logged something on ${pct(active.length / counts.length)} of all days since the record began.`,
    detail: `${back} of those were back-to-back days. The typical gap between entries is `
      + `${sorted[Math.floor(sorted.length / 2)]} day${sorted[Math.floor(sorted.length / 2)] === 1 ? '' : 's'}; the longest was ${longest}, ending ${fmt.dateY(at)}.`,
    n: counts.length,
    weight: 26,
  });
}

function seasonality(ctx) {
  const counts = {};
  for (const s of ctx.all) {
    const m = Number(s.date.slice(5, 7));
    counts[m] = (counts[m] || 0) + 1;
  }
  const months = Object.keys(counts).map(Number);
  if (months.length < 10) return null;
  const name = (m) => dateOf(`2025-${String(m).padStart(2, '0')}-01`)
    .toLocaleDateString(undefined, { month: 'long' });
  const ranked = months.slice().sort((a, b) => counts[b] - counts[a]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return finding({
    id: 'seasonality', section: 'Consistency',
    headline: `${name(ranked[0])} is your busiest month of the year across the whole record — ${counts[ranked[0]]} activities.`,
    detail: `${name(ranked[ranked.length - 1])} is the thinnest at ${counts[ranked[ranked.length - 1]]}. `
      + `Counted across every year on record, ${total} activities in total.`,
    n: total,
    weight: (counts[ranked[0]] - counts[ranked[ranked.length - 1]]) / 2,
  });
}

function doubleDays(ctx) {
  const byDate = {};
  for (const s of ctx.all) byDate[s.date] = (byDate[s.date] || 0) + 1;
  const days = Object.values(byDate);
  const multi = days.filter((n) => n > 1).length;
  if (multi < 5) return null;
  const most = Math.max(...days);
  const day = Object.keys(byDate).find((d) => byDate[d] === most);
  return finding({
    id: 'double-days', section: 'Consistency',
    headline: `${multi} of your ${days.length} active days held more than one session.`,
    detail: `The fullest was ${fmt.dateY(day)} with ${most}. `
      + 'Stacking sessions is a real part of how this record is built, not an exception.',
    n: days.length,
    weight: multi / days.length * 20,
  });
}

/* ══ running ══════════════════════════════════════════════════════════════ */

function paceByDistance(ctx) {
  const runs = ctx.all.filter((s) => s.kind === 'run' && s.distance_km && s.pace_s_per_km);
  if (runs.length < 20) return null;
  const short = runs.filter((r) => r.distance_km < 5);
  const long = runs.filter((r) => r.distance_km >= 5);
  if (short.length < 6 || long.length < 6) return null;
  const wpace = (l) => l.reduce((a, r) => a + r.duration_min * 60, 0) / l.reduce((a, r) => a + r.distance_km, 0);
  return finding({
    id: 'pace-distance', section: 'Running',
    headline: `Runs under 5 km average ${fmt.pace(wpace(short))}; 5 km and over average ${fmt.pace(wpace(long))}.`,
    detail: `${short.length} short runs against ${long.length} longer ones, `
      + `${fmt.one(runs.reduce((a, r) => a + r.distance_km, 0))} km of running in total.`,
    n: runs.length,
    weight: Math.abs(wpace(short) - wpace(long)) / 10,
  });
}

function paceDrift(ctx) {
  const runs = ctx.all.filter((s) => s.kind === 'run' && s.distance_km && s.duration_min)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (runs.length < 24) return null;
  const half = Math.floor(runs.length / 2);
  const wpace = (l) => l.reduce((a, r) => a + r.duration_min * 60, 0) / l.reduce((a, r) => a + r.distance_km, 0);
  const a = wpace(runs.slice(0, half));
  const b = wpace(runs.slice(half));
  return finding({
    id: 'pace-drift', section: 'Running',
    headline: `Your first ${half} runs averaged ${fmt.pace(a)}; the most recent ${runs.length - half} average ${fmt.pace(b)}.`,
    detail: `A difference of ${Math.abs(Math.round(a - b))} seconds a kilometre. `
      + 'Distance-weighted across every logged run, so long easy work counts for more than a short quick one — and the mix of run types changed over that time too.',
    n: runs.length,
    weight: Math.abs(a - b) / 4,
  });
}

function complianceFinding(ctx) {
  const runs = ctx.all.filter((s) => s.kind === 'run' && (s.detail || {}).compliance_pct != null);
  if (runs.length < 8) return null;
  const vals = runs.map((r) => Number(r.detail.compliance_pct));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const under = vals.filter((v) => v < 80).length;
  return finding({
    id: 'compliance', section: 'Running',
    headline: `Where a coached run recorded compliance, it averages ${Math.round(mean)}% to plan.`,
    detail: `${runs.length} runs carry the figure and ${under} of them came in under 80%. `
      + `The other ${ctx.all.filter((s) => s.kind === 'run').length - runs.length} runs were logged without one.`,
    n: runs.length,
    weight: 14,
  });
}

/* ══ lifting ══════════════════════════════════════════════════════════════ */

function liftingLayoff(ctx) {
  const lifts = ctx.all.filter((s) => s.kind === 'lift').sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!lifts.length) return null;
  const last = lifts[lifts.length - 1];
  const days = Math.round((dateOf(ctx.today) - dateOf(last.date)) / 86400000);
  if (days < 21) return null;
  const byYear = {};
  for (const s of lifts) byYear[s.date.slice(0, 4)] = (byYear[s.date.slice(0, 4)] || 0) + 1;
  const years = Object.keys(byYear).sort();
  return finding({
    id: 'lift-layoff', section: 'Lifting',
    headline: `No lifting logged for ${days} days — the last was ${fmt.dateY(last.date)}.`,
    detail: `By year: ${years.map((y) => `${y} ${byYear[y]} sessions`).join(', ')}. `
      + 'The record simply shows the gap. Nothing in this app accumulates, so nothing was lost while it was open.',
    n: lifts.length,
    weight: days,
  });
}

function liftingScope(ctx) {
  const lifts = ctx.all.filter((s) => s.kind === 'lift');
  if (lifts.length < 12) return null;
  const cats = {};
  for (const s of lifts) {
    const c = liftCategory(s);
    cats[c] = (cats[c] || 0) + 1;
  }
  const ranked = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const withReps = lifts.map(repSeries).filter(Boolean);
  return finding({
    id: 'lift-scope', section: 'Lifting',
    headline: `${pct(ranked[0][1] / lifts.length)} of your lifting is "${liftLabel(ranked[0][0]).toLowerCase()}" — ${ranked[0][1]} of ${lifts.length} sessions.`,
    detail: `Full split: ${ranked.map(([k, v]) => `${liftLabel(k).toLowerCase()} ${v}`).join(', ')}. `
      + (withReps.length
        ? `${withReps.length} sessions wrote down a rep series; none anywhere records a weight.`
        : 'No session anywhere records a weight, so there is no strength number to estimate.'),
    n: lifts.length,
    weight: 12,
  });
}

/* ══ registry ═════════════════════════════════════════════════════════════ */

const GENERATORS = [
  loadShare, soccerTeams, soccerInvolvementByTeam, soccerScoringAndResult,
  soccerCloseGames, soccerGoalsAgainst, soccerRest, soccerBestSpell,
  loadConcentration, loadWeekday, biggestWeek, rpeProfile, unscored,
  weightRange, weightVsFasting, weightVsLoad, fastingHabit,
  bestWindow, gapsFinding, seasonality, doubleDays,
  paceByDistance, paceDrift, complianceFinding,
  liftingLayoff, liftingScope,
];

export const SECTIONS = [
  'Training load', 'Soccer', 'Bodyweight & fasting',
  'Consistency', 'Running', 'Lifting',
];

/**
 * ctx = {all, soccer, bodyweight, history, loadWeeks, today, unit}
 * Returns findings grouped by section, ordered by weight, pinned first.
 */
export function buildInsights(ctx) {
  const found = [];
  for (const gen of GENERATORS) {
    let f = null;
    try { f = gen(ctx); } catch { f = null; }   // one bad slice must not empty the page
    if (f) found.push(f);
  }
  const grouped = SECTIONS.map((section) => ({
    section,
    items: found.filter((f) => f.section === section)
      .sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || b.weight - a.weight),
  })).filter((g) => g.items.length);
  return { grouped, count: found.length, attempted: GENERATORS.length };
}
