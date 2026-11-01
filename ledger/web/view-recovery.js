/* Recovery — what the watch measured while you slept, and what it has to do
 * with the training.
 *
 * Three hundred nights of sleep, HRV, resting heart rate and readiness were
 * in the database and showed up as one line of footnote on the Week page.
 * This is the page for them.
 *
 * Two rules the page is built on:
 *
 *   · Every figure is read against a named threshold, and the threshold is
 *     printed next to it. Garmin's scores use Garmin's bands (Prime, High,
 *     Moderate, Low, Poor). HRV uses the balanced range Garmin fits to you.
 *     Sleep uses the need Garmin fits to you. Resting HR uses your own
 *     28-night mean. A number with no threshold is a number nobody can read.
 *   · Every window is named where it is used. The table at the top has three
 *     fixed ones — last night, this week, the last 28 nights. Every chart
 *     below it uses the range picked in the control and repeats it under its
 *     title, with "this week" beside it so the two can be compared.
 *
 * Colour here is a reading on a published scale, which is why this page is
 * allowed to tint figures when the rest of the app is not: the scale is
 * Garmin's or your own history, never a verdict the app invented.
 */

import {
  el, clear, qs, busy, fmt, token, mixColors, addDays, todayISO, weekStart, KIND_LABEL, icon,
} from './core.js';
import {
  panel, panelError, segmented, emptyNote, skeletonBlock, readout,
  resolveRange, dowBadge, kindDot, sectionRule, collapsible, setTimeframe,
} from './ui.js';
import { figure, splitBar } from './charts.js';
import { cached, sessionsIn } from './dataset.js';
import {
  isNum, summarise, stageSplit, byWeekday, nightAfter, dayAfterNight,
  recoveryReadout, coverage, lightMinutes, DAY_KINDS, BANDS, sleepBand,
  todayFindings, patternFindings, nextFixture,
} from './recovery.js';
import {
  metricOf, recoveryContext, readingOf, lastNight, nightOfText, measureCards, BASELINE_NIGHTS,
} from './recovery-cards.js';

const RANGES = [
  ['4w', '4 weeks'], ['12w', '12 weeks'], ['26w', '26 weeks'], ['52w', '52 weeks'], ['all', 'All time'],
];
const toneColor = (tone) => (tone ? token(`tone-${tone}`) : null);

export function mount(host, route, { setQuery }) {
  const state = { range: RANGES.some(([k]) => k === route.query.get('range')) ? route.query.get('range') : '4w' };
  let figs = [];
  let alive = true;
  let seq = 0;

  const filters = el('div', { class: 'filterbar' });

  const pNow = panel({
    title: 'Last night, and the longer term', wide: true,
    sub: 'one card per measure: last night large, then this week, the last 28 nights and the range below it — each read against the scale named on the card',
  });
  const pToday = panel({ title: 'This morning', wide: true, sub: 'what last night and the week so far say about today' });
  const pSleep = panel({ title: 'Sleep', sub: 'hours asleep each night, against the sleep need Garmin fits to you', wide: true, accent: 'sleep' });
  const pScore = panel({ title: 'Sleep score', sub: 'Garmin\'s 0–100 for the night, on Garmin\'s bands', accent: 'sleep', wide: true });
  const pHrv = panel({ title: 'HRV', sub: 'overnight average, against your balanced range', accent: 'hrv', wide: true });
  const pRhr = panel({ title: 'Resting heart rate', sub: 'the night\'s low, against your own 28-night mean', accent: 'rhr', wide: true });
  const pReady = panel({ title: 'Readiness', sub: 'Garmin\'s 0–100 for the morning, on Garmin\'s bands', wide: true });
  const pStress = panel({ title: 'Stress', sub: 'Garmin\'s daily average, on Garmin\'s bands', accent: 'stress', wide: true });
  const pBattery = panel({ title: 'Body battery at wake', sub: 'what you woke up with, on Garmin\'s bands', accent: 'battery', wide: true });
  const pStages = panel({ title: 'Sleep stages', sub: 'mean minutes per stage over the range', accent: 'sleep' });
  const pWeekday = panel({ title: 'Sleep by weekday', sub: 'mean hours, by the morning the night ended on', accent: 'sleep' });
  const pPatterns = panel({ title: 'What the record says', wide: true, sub: 'nights and training together, over the range — each finding names its counts' });
  const pAfterDay = panel({
    title: 'The morning after', wide: true,
    sub: 'the night that followed a match, a hard day, an easy day, a rest day',
  });
  const pAfterNight = panel({
    title: 'The day after', wide: true,
    sub: 'sessions after a night that met your sleep need and after one that did not; then the same cut on HRV',
  });
  const pRead = panel({ title: 'Read-out', sub: 'flat, with every denominator', wide: true });
  const pNights = panel({ title: 'Every night', sub: ' ', wide: true });

  host.append(
    filters,
    pNow, pToday,
    sectionRule('Nights', 'one column per night, a number on every column, over the range picked above'),
    pSleep, pScore, pHrv, pRhr, pReady, pStress, pBattery,
    sectionRule('Shape', 'the same range, folded'),
    el('div', { class: 'grid-2' }, [pStages, pWeekday]),
    sectionRule('With the training', 'the night after a day, the day after a night'),
    pPatterns, pAfterDay, pAfterNight,
    sectionRule('The record', 'every figure above, in words and in rows'),
    pRead, pNights,
  );
  skeletonBlock(200, pNow.body);
  skeletonBlock(120, pToday.body);
  for (const p of [pSleep, pPatterns, pAfterDay, pAfterNight]) skeletonBlock(240, p.body);
  for (const p of [pScore, pHrv, pRhr, pReady, pStress, pBattery, pWeekday]) skeletonBlock(220, p.body);
  skeletonBlock(120, pStages.body);
  skeletonBlock(140, pRead.body);
  skeletonBlock(120, pNights.body);

  function buildFilters() {
    clear(filters);
    filters.append(
      el('div', { class: 'filter' }, [
        el('span', { class: 'lbl', text: 'Range' }),
        segmented(RANGES, state.range, (v) => {
          state.range = v; setQuery({ range: v }); buildFilters(); load();
        }, 'Date range for every chart on this page'),
      ]),
    );
  }

  async function load() {
    const mine = ++seq;
    const today = todayISO();
    /* "4 weeks" is 28 nights ending tonight. `resolveRange` counts back 28
       days and keeps today as well, which is 29 — right for a session window
       that wants both ends, wrong for a chart whose unit is the night. */
    const weeks = /^(\d+)w$/.exec(state.range);
    const { from, to } = weeks
      ? { from: addDays(today, -(7 * Number(weeks[1]) - 1)), to: today }
      : resolveRange(state.range, today);
    busy(true);
    const [win, base, sess, lg] = await Promise.all([
      cached(`metrics:${from}:${to}`, `/api/metrics${from ? qs({ from, to }) : '?all=1'}`),
      cached(`metrics:base:${today}`, `/api/metrics${qs({ from: addDays(today, -(BASELINE_NIGHTS - 1)), to: today })}`),
      /* One day earlier than the metrics, so the night after the day before
         the window — row `from` — has a day to belong to. */
      sessionsIn({ from: from ? addDays(from, -1) : null, to }),
      cached('leagues', '/api/leagues'),
    ]);
    busy(false);
    if (!alive || mine !== seq) return;

    const all = [pNow, pToday, pSleep, pScore, pHrv, pRhr, pReady, pStress, pBattery, pStages, pWeekday, pPatterns, pAfterDay, pAfterNight, pRead, pNights];
    if (!win.ok) {
      for (const p of all) panelError(p.body, win, 'Daily metrics');
      return;
    }
    const rows = win.data.days || [];
    const tf = win.data.timeframe;
    const baseRows = base.ok ? (base.data.days || []) : [];
    const sessions = sess.ok ? sess.items : [];
    const nextMatch = lg.ok ? nextFixture(lg.data.leagues, today) : null;
    /* All time starts where the *nights* start, not where the table does:
       weigh-ins run a year ahead of the watch's first night, and a sleep
       chart opening on twelve empty months is a chart about the scale. */
    const firstNight = rows.find((r) => isNum(r.sleep_hours) || isNum(r.hrv_ms) || isNum(r.resting_hr));
    const span = {
      from: (state.range === 'all' && firstNight) ? firstNight.date : (tf.from || (rows[0] && rows[0].date) || today),
      to: tf.as_of || tf.to || today,
    };
    const rangeLabel = RANGES.find(([k]) => k === state.range)[1].toLowerCase();
    const week = { from: weekStart(today), to: today };
    /* Garmin's thresholds, resolved in one place (`recovery-cards.js`) so
       the Week page's snapshot reads a night exactly the way this page does. */
    const ctx = { rows, baseRows, tf, span, week, today, rangeLabel, ...recoveryContext(baseRows, rows) };

    for (const f of figs) f.destroy();
    figs = [];

    paintNow(ctx);
    paintToday(ctx, nextMatch);
    paintSleep(ctx);
    paintBanded(pScore, ctx, { key: 'sleep_score', label: 'Sleep score', scale: 'sleep_score', color: token('sleep'), cover: true });
    paintHrv(ctx);
    paintRhr(ctx);
    paintBanded(pReady, ctx, { key: 'readiness', label: 'Readiness', scale: 'readiness', color: token('ink-3'), periodLabel: 'Morning of' });
    paintBanded(pStress, ctx, { key: 'stress_avg', label: 'Stress', scale: 'stress_avg', color: token('stress'), periodLabel: 'Day', cover: true });
    paintBanded(pBattery, ctx, { key: 'body_battery_wake', label: 'At wake', scale: 'body_battery', color: token('battery'), periodLabel: 'Morning of', cover: true });
    paintStages(ctx);
    paintWeekday(ctx);
    const after = nightAfter(rows, sessions, span.from, span.to);
    const before = dayAfterNight(rows, sessions);
    paintPatterns(ctx, sessions);
    paintAfterDay(after, tf);
    paintAfterNight(before, tf);
    paintRead(ctx);
    paintNights(ctx, sessions);
  }

  /* ── reading a figure ────────────────────────────────────────────────── */

  /* `readingOf` and the measure list live in `recovery-cards.js`, shared
     with the Week page's snapshot. */

  const inWeek = (rows, week) => rows.filter((r) => r.date >= week.from && r.date <= week.to);

  /** "This week 7.0 h (5 nights) · 4 weeks 7.2 h (28 nights)." */
  function weekVsRange({ rows, week, rangeLabel }, key, digits, unit) {
    const w = summarise(inWeek(rows, week), key);
    const r = summarise(rows, key);
    const show = (s) => (s.n ? `${s.value.toFixed(digits)}${unit ? ` ${unit}` : ''} (${s.n} night${s.n === 1 ? '' : 's'})` : 'no nights yet');
    return `This week ${show(w)} · ${rangeLabel} ${show(r)}.`;
  }

  function paintNow(ctx) {
    const { rows, baseRows, week, today, rangeLabel } = ctx;
    clear(pNow.body);
    const last = lastNight(baseRows);
    if (!last) { pNow.body.append(emptyNote('No nights on record yet — these arrive with the first Garmin sync.')); return; }
    const showRange = state.range !== '4w';
    const nightOf = nightOfText(last, today);
    const cards = measureCards(ctx, {
      last, baseRows,
      rows: [
        ['This week', inWeek(baseRows, week)],
        ['Last 28 nights', baseRows],
        showRange ? [rangeLabel[0].toUpperCase() + rangeLabel.slice(1), rows] : null,
      ].filter(Boolean),
    });
    pNow.body.prepend(el('p', { class: 'sub rc-nightof' }, [el('b', { text: 'Last night ' }), el('span', { text: nightOf })]));
    pNow.body.append(cards, el('p', { class: 'sub', text:
      `Last night is ${nightOf}. This week is Monday to today; the small count is the nights a mean rests on. `
      + 'A mean is tagged on the same scale as a single night, so "Fair" beside a 28-night sleep score is the average night, not the best or worst.' }));
  }

  function findingList(items) {
    const ul = el('ul', { class: 'rc-findings' });
    for (const f of items) {
      const m = f.metric ? metricOf(f.metric) : null;
      ul.append(el('li', { class: `${f.tone ? `tone-${f.tone}` : 'tone-none'}${m ? ' has-icon' : ''}` }, [
        el('i', { 'aria-hidden': 'true' }, m ? [icon(m.icon)] : []),
        el('div', {}, [
          el('p', { class: 'rc-head', text: f.headline }),
          f.detail ? el('p', { class: 'rc-detail', text: f.detail }) : null,
        ].filter(Boolean)),
      ]));
    }
    return ul;
  }

  function paintToday(ctx, nextMatch) {
    clear(pToday.body);
    const items = todayFindings({ baseRows: ctx.baseRows, today: ctx.today, nextMatch, fmtDate: fmt.dowDate });
    if (!items.length) { pToday.body.append(emptyNote('No night on record yet.')); return; }
    pToday.body.append(findingList(items));
    if (nextMatch) {
      pToday.body.append(el('p', { class: 'sub' }, [
        kindDot('soccer'), document.createTextNode(' '),
        el('b', { text: 'Next match ' }),
        el('span', { text: `${fmt.dowDate(nextMatch.date)}${nextMatch.time_text ? `, ${nextMatch.time_text}` : ''} v ${nextMatch.opponent || '—'} — ${nextMatch.nightsAway === 0 ? 'tonight' : `${nextMatch.nightsAway} night${nextMatch.nightsAway === 1 ? '' : 's'} away`}.` }),
      ]));
    }
  }

  /* ── nightly figures ─────────────────────────────────────────────────── */

  /* Axis labels are "Sun, Oct 4" while a fortnight fits, "Oct 4" beyond
     that: the axis thins labels by width and a weekday prefix on twenty-eight
     columns in a half-width panel runs the dates into one another. */
  const nightLabel = (d, n) => (n <= 14 ? fmt.dowDate(d) : fmt.date(d));
  const spanDays = (span) => Math.round((new Date(span.to) - new Date(span.from)) / 86400000) + 1;

  /* One point per calendar day in the span, so a night the watch missed is a
     visible gap rather than two neighbours drawn closer together. Each
     column carries the colour of the band its night fell in. */
  function bandedPoints(ctx, key, neutral) {
    const { rows, span } = ctx;
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const n = spanDays(span);
    const pts = [];
    for (let d = span.from; d <= span.to; d = addDays(d, 1)) {
      const r = byDate.get(d);
      const v = r && isNum(r[key]) ? Number(r[key]) : null;
      const band = v != null ? readingOf(ctx, key, v, r) : null;
      pts.push({
        key: d, label: nightLabel(d, n),
        values: { v },
        colors: { v: (band && toneColor(band.tone)) || neutral },
        note: band ? band.label : (r ? null : 'no reading'),
  });
    }
    return pts;
  }

  const bandLegend = (scale) => BANDS[scale].map((b) => ({ label: `${b.label} ${b.min}+`, color: toneColor(b.tone) })).reverse();

  /* Every column carries its number, which needs about 34px of slot; the
     chart grows past the panel and scrolls rather than thinning the labels,
     and opens at its right edge, where last night is. */
  const DENSITY = { labels: 'all', minSlot: 34, openAtEnd: true };

  function coverNote(rows, key) {
    const c = coverage(rows, key);
    if (!c.of || c.n === c.of) return null;
    return `${c.n} of ${c.of} nights have this; the rest arrive as the backfill runs.`;
  }

  function paintSleep(ctx) {
    const { rows, tf, need } = ctx;
    clear(pSleep.body);
    setTimeframe(pSleep, tf);
    const pts = bandedPoints(ctx, 'sleep_hours', token('sleep'));
    if (!pts.some((x) => x.values.v != null)) { pSleep.body.append(emptyNote('No nights in this window.')); return; }
    figs.push(figure(pSleep.body, {
      aria: 'Hours asleep each night, against your sleep need',
      height: 280, unit: 'h', periodLabel: 'Night ending', ...DENSITY,
      series: [{ key: 'v', label: 'Asleep', color: token('sleep') }],
      points: pts,
      guides: need ? [{ value: need, label: `need ${need.toFixed(1)} h`, short: `${need.toFixed(1)} h` }] : [],
      legendExtra: [
        ...(need ? [{ label: `Your need ${need.toFixed(1)} h`, color: token('ink-3'), shape: 'line' }] : []),
        ...(need ? [
          { label: 'Need met', color: toneColor('solid') },
          { label: 'Short by under an hour', color: toneColor('mixed') },
          { label: 'Short by more than an hour', color: toneColor('poor') },
        ] : []),
      ],
      format: (v) => v.toFixed(1),
      formatShort: (v) => (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)),
    }));
    const met = need ? rows.filter((r) => { const b = readingOf(ctx, 'sleep_hours', r.sleep_hours, r); return b && b.tone === 'solid'; }).length : null;
    const of = rows.filter((r) => isNum(r.sleep_hours)).length;
    pSleep.body.append(el('p', { class: 'sub', text:
      `${weekVsRange(ctx, 'sleep_hours', 1, 'h')}${need ? ` ${met} of ${of} nights met the need Garmin puts at ${need.toFixed(1)} h.` : ' Garmin\'s sleep need arrives with the next sync.'}` }));
  }

  function paintBanded(p, ctx, { key, label, scale, color, periodLabel = 'Night ending', cover = false }) {
    const { rows, tf } = ctx;
    clear(p.body);
    setTimeframe(p, tf);
    const pts = bandedPoints(ctx, key, color);
    if (!pts.some((x) => x.values.v != null)) {
      p.body.append(emptyNote(cover ? 'Not in the record yet — arrives with the next sync and the backfill.' : 'No readings in this window.'));
      return;
    }
    figs.push(figure(p.body, {
      aria: `${label} per night, coloured by Garmin's band`,
      height: 240, unit: '', periodLabel, yMax: 100, ...DENSITY,
      series: [{ key: 'v', label, color }],
      points: pts,
      legendExtra: bandLegend(scale),
      format: (v) => String(Math.round(v)), formatShort: (v) => String(Math.round(v)),
    }));
    const extra = cover ? coverNote(rows, key) : null;
    p.body.append(el('p', { class: 'sub', text: `${weekVsRange(ctx, key, 0, '')}${extra ? ` ${extra}` : ''}` }));
  }

  function paintHrv(ctx) {
    const { rows, tf, range } = ctx;
    clear(pHrv.body);
    setTimeframe(pHrv, tf);
    const pts = bandedPoints(ctx, 'hrv_ms', token('hrv'));
    if (!pts.some((x) => x.values.v != null)) { pHrv.body.append(emptyNote('No readings in this window.')); return; }
    figs.push(figure(pHrv.body, {
      aria: 'Overnight HRV per night, against your balanced range',
      height: 260, unit: 'ms', periodLabel: 'Night ending', ...DENSITY,
      series: [{ key: 'v', label: 'HRV', color: token('hrv') }],
      points: pts,
      bands: range ? [{ from: range.low, to: range.high, color: toneColor('solid'), label: `balanced ${range.low}–${range.high} ms`, short: `${range.low}–${range.high}` }] : [],
      legendExtra: range ? [
        { label: `Balanced range ${range.low}–${range.high} ms`, color: toneColor('solid'), shape: 'band' },
        { label: 'Balanced', color: toneColor('solid') },
        { label: 'Below range', color: toneColor('thin') },
        { label: 'Low', color: toneColor('poor') },
        { label: 'Above range', color: toneColor('mixed') },
      ] : [],
      format: (v) => String(Math.round(v)), formatShort: (v) => String(Math.round(v)),
    }));
    const inRange = range ? rows.filter((r) => { const b = readingOf(ctx, 'hrv_ms', r.hrv_ms, r); return b && b.label === 'Balanced'; }).length : null;
    const of = rows.filter((r) => isNum(r.hrv_ms)).length;
    pHrv.body.append(el('p', { class: 'sub', text:
      `${weekVsRange(ctx, 'hrv_ms', 0, 'ms')}${range ? ` ${inRange} of ${of} nights inside the ${range.low}–${range.high} ms range Garmin fits to you.` : ' Garmin\'s balanced range arrives with the next sync.'}` }));
  }

  function paintRhr(ctx) {
    const { tf, rhrMean } = ctx;
    clear(pRhr.body);
    setTimeframe(pRhr, tf);
    const pts = bandedPoints(ctx, 'resting_hr', token('rhr'));
    if (!pts.some((x) => x.values.v != null)) { pRhr.body.append(emptyNote('No readings in this window.')); return; }
    figs.push(figure(pRhr.body, {
      aria: 'Resting heart rate per night, against your 28-night mean',
      height: 240, unit: 'bpm', periodLabel: 'Night ending', ...DENSITY,
      series: [{ key: 'v', label: 'Resting HR', color: token('rhr') }],
      points: pts,
      guides: rhrMean != null ? [{ value: rhrMean, label: `28-night mean ${Math.round(rhrMean)}`, short: `mean ${Math.round(rhrMean)}` }] : [],
      legendExtra: rhrMean != null ? [
        { label: `28-night mean ${Math.round(rhrMean)}`, color: token('ink-3'), shape: 'line' },
        { label: '3+ under', color: toneColor('solid') },
        { label: 'Near mean', color: token('rhr') },
        { label: '3–4 over', color: toneColor('thin') },
        { label: '5+ over', color: toneColor('poor') },
      ] : [],
      format: (v) => String(Math.round(v)), formatShort: (v) => String(Math.round(v)),
    }));
    pRhr.body.append(el('p', { class: 'sub', text: `${weekVsRange(ctx, 'resting_hr', 0, 'bpm')} Lower is better; a night five or more over your own mean is the one to notice.` }));
  }

  /* ── shape ───────────────────────────────────────────────────────────── */

  function paintStages({ rows, tf }) {
    clear(pStages.body);
    setTimeframe(pStages, tf);
    const split = stageSplit(rows);
    if (!split.parts) {
      pStages.body.append(emptyNote('Not in the record yet — stages arrive with the next sync and the backfill.'));
      return;
    }
    const sleep = token('sleep');
    const surface = token('surface') || '#ffffff';
    const parts = [
      { label: 'Deep', value: split.parts.deep, color: sleep },
      { label: 'REM', value: split.parts.rem, color: token('sa-plum') },
      { label: 'Light', value: split.parts.light, color: mixColors(sleep, surface, 0.55) },
      { label: 'Awake', value: split.parts.awake, color: token('ink-3') },
    ];
    splitBar(pStages.body, { parts, unit: '', format: (v) => fmt.mins(v) });
    const total = parts.slice(0, 3).reduce((a, p) => a + p.value, 0);
    pStages.body.append(el('p', { class: 'sub', text:
      `${fmt.mins(total)} asleep on an average night: ${fmt.mins(split.parts.deep)} deep, ${fmt.mins(split.parts.rem)} REM, `
      + `${fmt.mins(split.parts.light)} light, plus ${fmt.mins(split.parts.awake)} awake. `
      + `${split.n === split.of ? `${split.n} nights` : `${split.n} of ${split.of} nights have stages`}.` }));
  }

  function paintWeekday({ rows, tf, need }) {
    clear(pWeekday.body);
    setTimeframe(pWeekday, tf);
    const wd = byWeekday(rows, 'sleep_hours');
    if (!wd.some((w) => w.n)) { pWeekday.body.append(emptyNote('No nights in this window.')); return; }
    figs.push(figure(pWeekday.body, {
      aria: 'Mean hours asleep by weekday',
      height: 200, unit: 'h', periodLabel: 'Morning', labels: 'all',
      series: [{ key: 'h', label: 'Mean asleep', color: token('sleep') }],
      points: wd.map((w) => ({
        key: w.key, label: w.label, values: { h: w.value },
        colors: { h: (sleepBand(w.value, need) && toneColor(sleepBand(w.value, need).tone)) || token('sleep') },
        note: `${w.n} night${w.n === 1 ? '' : 's'}`,
      })),
      guides: need ? [{ value: need, label: `need ${need.toFixed(1)} h`, short: `${need.toFixed(1)} h` }] : [],
      format: (v) => v.toFixed(1), formatShort: (v) => (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)),
    }));
    const have = wd.filter((w) => w.n);
    const lo = have.reduce((a, b) => (a.value <= b.value ? a : b));
    const hi = have.reduce((a, b) => (a.value >= b.value ? a : b));
    pWeekday.body.append(el('p', { class: 'sub', text:
      `Shortest into ${lo.label} (${lo.value.toFixed(1)} h over ${lo.n}), longest into ${hi.label} (${hi.value.toFixed(1)} h over ${hi.n}). A Thursday column is the night of Wednesday into Thursday.` }));
  }

  /* ── with the training ───────────────────────────────────────────────── */

  function paintPatterns(ctx, sessions) {
    const { rows, tf, span } = ctx;
    clear(pPatterns.body);
    setTimeframe(pPatterns, tf);
    const items = patternFindings({ rows, sessions, from: span.from, to: span.to, fmtDate: fmt.dowDate });
    if (!items.length) {
      pPatterns.body.append(emptyNote('Nothing in this range clears the bar — a finding needs enough nights on each side of a split to mean something. Widen the range.'));
      return;
    }
    pPatterns.body.append(findingList(items));
  }

  const cell = (value, unit, n, digits = 0) => el('td', { class: 'num' }, [
    el('span', { text: value == null ? '—' : `${Number(value).toFixed(digits)}${unit}` }),
    n ? document.createTextNode(' ') : null,
    n ? el('span', { class: 'rc-n', text: `·${n}` }) : null,
  ].filter(Boolean));

  function paintAfterDay(after, tf) {
    clear(pAfterDay.body);
    setTimeframe(pAfterDay, tf);
    const { table, split } = after;
    if (!table.some((r) => r.days)) { pAfterDay.body.append(emptyNote('No days in this window.')); return; }
    const t = el('table', { class: 'data-table rc-table' });
    t.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Day' }),
      el('th', { scope: 'col', class: 'num', text: 'Days' }),
      el('th', { scope: 'col', class: 'num', text: 'Sleep after' }),
      el('th', { scope: 'col', class: 'num', text: 'Sleep score' }),
      el('th', { scope: 'col', class: 'num', text: 'HRV after' }),
      el('th', { scope: 'col', class: 'num', text: 'Resting HR after' }),
      el('th', { scope: 'col', class: 'num', text: 'Readiness after' }),
    ])]));
    const body = el('tbody');
    for (const r of table) {
      const label = DAY_KINDS.find(([k]) => k === r.key)[1];
      body.append(el('tr', {}, [
        el('th', { scope: 'row' }, [
          r.key === 'match' ? kindDot('soccer') : null,
          r.key === 'match' ? document.createTextNode(' ') : null,
          el('span', { text: label }),
          r.key === 'hard' && split != null ? el('span', { class: 'muted', text: ` · ${fmt.int(split)} AU or more` }) : null,
          r.key === 'easy' && split != null ? el('span', { class: 'muted', text: ` · under ${fmt.int(split)} AU` }) : null,
        ].filter(Boolean)),
        el('td', { class: 'num', text: String(r.days) }),
        cell(r.sleep.value, ' h', r.sleep.n, 1),
        cell(r.score.value, '', r.score.n),
        cell(r.hrv.value, ' ms', r.hrv.n),
        cell(r.rhr.value, '', r.rhr.n),
        cell(r.readiness.value, '', r.readiness.n),
      ]));
    }
    t.append(body);
    pAfterDay.body.append(el('div', { class: 'scroll is-wide' }, [t]), el('p', { class: 'sub', text:
      'Each row is the night that followed. The small count beside a figure is how many nights had that reading. A match day is any day with a soccer session; hard and easy split at the median load of the other training days in this range.' }));
  }

  function paintAfterNight(before, tf) {
    clear(pAfterNight.body);
    setTimeframe(pAfterNight, tf);
    const { table, paired } = before;
    if (!table.length || !paired) { pAfterNight.body.append(emptyNote('Needs Garmin\'s sleep need and HRV range on the nights in this window — they arrive with the next sync.')); return; }
    const t = el('table', { class: 'data-table rc-table' });
    t.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Night before' }),
      el('th', { scope: 'col', class: 'num', text: 'Sessions' }),
      el('th', { scope: 'col', class: 'num', text: 'RPE' }),
      el('th', { scope: 'col', class: 'num', text: 'Load / session' }),
      el('th', { scope: 'col', class: 'num', text: 'Run pace' }),
      el('th', { scope: 'col', class: 'num', text: 'G+A / match' }),
    ])]));
    const body = el('tbody');
    for (const r of table) {
      body.append(el('tr', {}, [
        el('th', { scope: 'row' }, [el('span', { text: r.label }), el('span', { class: 'muted', text: ` · ${r.note}` })]),
        el('td', { class: 'num', text: String(r.sessions) }),
        cell(r.rpe.value, '', r.rpe.n, 1),
        cell(r.load.value, ' AU', r.load.n),
        el('td', { class: 'num' }, [
          el('span', { text: r.pace.value == null ? '—' : fmt.pace(r.pace.value) }),
          r.pace.n ? document.createTextNode(' ') : null,
          r.pace.n ? el('span', { class: 'rc-n', text: `·${r.pace.n}` }) : null,
        ].filter(Boolean)),
        cell(r.ga.value, '', r.ga.n, 2),
      ]));
    }
    t.append(body);
    pAfterNight.body.append(el('div', { class: 'scroll is-wide' }, [t]), el('p', { class: 'sub', text:
      `${paired} sessions in this range have a measured night before them. The count beside each figure is the sessions that carried it. A session appears once in the sleep pair and once in the HRV pair.` }));
  }

  function paintRead({ rows, tf }) {
    clear(pRead.body);
    setTimeframe(pRead, tf);
    pRead.body.append(readout(recoveryReadout(rows, { fmtDate: fmt.dowDate })));
  }

  /* ── every night ─────────────────────────────────────────────────────── */

  function paintNights({ rows, tf }, sessions) {
    clear(pNights.body);
    setTimeframe(pNights, tf);
    const nights = rows.filter((r) => isNum(r.sleep_hours) || isNum(r.resting_hr) || isNum(r.hrv_ms));
    if (!nights.length) { pNights.body.append(emptyNote('No nights in this window.')); return; }
    const trained = new Map();
    for (const s of sessions) {
      if (s.kind === 'fast') continue;
      if (!trained.has(s.date)) trained.set(s.date, []);
      trained.get(s.date).push(s.kind);
    }
    const t = el('table', { class: 'data-table rc-table rc-nights' });
    const cols = ['Night ending', 'Trained that day', 'Asleep', 'Need', 'Score', 'Deep', 'REM', 'Light', 'Awake', 'HRV', 'Range', 'RHR', 'Ready', 'Batt. wake', 'Stress', 'Steps'];
    t.append(el('thead', {}, [el('tr', {}, cols.map((c, i) => el('th', { scope: 'col', class: i >= 2 ? 'num' : null, text: c })))]));
    const body = el('tbody');
    const num = (v, digits = 0) => el('td', { class: 'num', text: isNum(v) ? Number(v).toFixed(digits) : '—' });
    for (const r of [...nights].reverse()) {
      const kinds = [...new Set(trained.get(r.date) || [])];
      body.append(el('tr', {}, [
        el('th', { scope: 'row' }, [dowBadge(r.date), document.createTextNode(' '), el('span', { text: fmt.date(r.date) })]),
        el('td', {}, kinds.length
          ? kinds.flatMap((k) => [kindDot(k), el('span', { class: 'muted', text: ` ${KIND_LABEL[k] || k} ` })])
          : [el('span', { class: 'muted', text: 'rest' })]),
        num(r.sleep_hours, 1), num(isNum(r.sleep_need_min) ? r.sleep_need_min / 60 : null, 1), num(r.sleep_score),
        num(r.deep_min), num(r.rem_min), num(lightMinutes(r)), num(r.awake_min),
        num(r.hrv_ms),
        el('td', { class: 'num', text: isNum(r.hrv_balanced_low) ? `${r.hrv_balanced_low}–${r.hrv_balanced_high}` : '—' }),
        num(r.resting_hr), num(r.readiness),
        num(r.body_battery_wake), num(r.stress_avg), num(r.steps),
      ]));
    }
    t.append(body);
    const wrap = el('div', { class: 'scroll is-wide' }, [t]);
    pNights.body.append(collapsible(`${nights.length} nights, newest first — hours asleep, minutes per stage, Garmin's need and range for the night`, wrap));
  }

  buildFilters();
  load();

  return {
    destroy() { alive = false; for (const f of figs) f.destroy(); },
  };
}
