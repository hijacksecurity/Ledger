/* All time — the long view, and the home of the two numbers the user has
 * tracked continuously since 2025: activities per week, and bodyweight.
 *
 * Both get the full treatment: a tall primary chart, its raw input aligned
 * directly beneath it on the same x origin, extremes and endpoint labelled,
 * and a table. Neither is scored. The average cannot be reset and the weight
 * has no target — those are the two facts the whole design protects.
 */

import {
  el, clear, api, busy, fmt, colorOf, orderKinds, token, KINDS,
  getWeightUnit, setWeightUnit, inUnit, weekStart, addDays,
} from './core.js';
import {
  panel, panelError, statStrip, emptyNote, skeletonBlock, kindName, readout, segmented, subTabs,
  setTimeframe,
  setTools,
} from './ui.js';
import { figure, splitBar, dayGrid, gridScale } from './charts.js';
import {
  rolling28, normalizePoints, historyReadout, sessionsIn, lifetimeAveragePerWeek,
  weeklyCounts, bodyweightByMonth, fastingByMonth, monthSpan, weightReadout, metricByMonth, cached,
} from './dataset.js';
import { isNum, summarise, recoveryReadout } from './recovery.js';
import { METRICS, metricOf } from './recovery-cards.js';

/* A forced left pad, so the primary chart and the one beneath it share an
   x origin exactly. Alignment is what makes a small multiple readable. */
const PAD_L = 48;
const PAD_R = 14;

/* Date-keyed points get their year as the axis group, so a span of more than
   one year names each year where it begins (see `charts.js`). */
const byYear = (points) => points.map((p) => (
  /^\d{4}-/.test(String(p.key)) ? { ...p, group: String(p.key).slice(0, 4) } : p
));

const AVG_RANGES = [['all', 'All time'], ['104', '2 years'], ['52', '52 weeks'], ['26', '26 weeks']];

export function mount(host, route, { setQuery }) {
  const state = {
    avgRange: route.query.get('avg') || 'all',
    bwRange: route.query.get('bw') || 'all',
    unit: getWeightUnit(),
    /* Which of the watch's nightly measures the long view shows. */
    night: metricOf(route.query.get('night')) ? route.query.get('night') : 'sleep_hours',
  };
  let figs = [];
  let nightFigs = [];
  let alive = true;
  let data = null;

  const pAvg = panel({ title: 'Activities per week', sub: ' ', wide: true });
  const pWeight = panel({ title: 'Bodyweight', sub: ' ', wide: true });
  const pFast = panel({
    title: 'Bodyweight and fasting', wide: true,
    sub: 'the same months, one above the other — read together, not as cause and effect',
  });
  const pRoll = panel({
    title: 'Rolling 28-day count',
    sub: 'activities in the trailing four weeks, every day on record — a dip, never a reset',
    wide: true,
  });
  /* The nights, over the whole record. One measure at a time, picked in the
     header, and the same pick colours a grid of every night under each year
     below — the Recovery page reads a night; this is where a year of them
     can be looked at side by side. Means per month, each with the nights it
     rests on; no line is drawn through them. */
  const pNights = panel({ title: 'Nights by month', sub: ' ', wide: true });
  const pRead = panel({ title: 'Read-out', sub: 'the whole record, stated plainly', wide: true });
  const pMixYear = panel({ title: 'Mix by year', sub: 'share of entries by modality' });
  const pShape = panel({ title: 'Shape of the record', sub: 'coverage and gaps' });
  const pYears = panel({ title: 'Every day on record', sub: ' ', tools: gridScale(), wide: true });
  const statsHost = el('div', { class: 'strip-host' });

  host.append(
    subTabs('history', 'all'),
    pAvg, pWeight, pFast, statsHost, pRoll, pNights, pRead,
    el('div', { class: 'grid-2' }, [pMixYear, pShape]),
    pYears,
  );
  skeletonBlock(420, pAvg.body);
  skeletonBlock(420, pWeight.body);
  skeletonBlock(300, pFast.body);
  skeletonBlock(96, statsHost);
  skeletonBlock(220, pRoll.body);
  skeletonBlock(240, pNights.body);
  skeletonBlock(140, pRead.body);
  skeletonBlock(200, pMixYear.body);
  skeletonBlock(200, pShape.body);
  skeletonBlock(320, pYears.body);

  (async () => {
    busy(true);
    const [res, sess, met] = await Promise.all([
      api('/api/history'),
      sessionsIn({}),
      cached('metrics:all', '/api/metrics?all=1'),
    ]);
    busy(false);
    if (!alive) return;
    if (!res.ok) {
      clear(statsHost);
      panelError(pAvg.body, res, 'All-time history');
      panelError(pWeight.body, res, 'Bodyweight');
      clear(pFast.body); clear(pRoll.body); clear(pNights.body); clear(pRead.body);
      clear(pMixYear.body); clear(pShape.body); clear(pYears.body);
      return;
    }
    data = { h: res.data, sessions: sess.ok ? sess.items : [], nights: met.ok ? (met.data.days || []) : [] };
    paintAll();
  })();

  function dropFigs() {
    figs.forEach((f) => f.destroy && f.destroy());
    figs = [];
    dropNightFigs();
  }
  function dropNightFigs() {
    nightFigs.forEach((f) => f.destroy && f.destroy());
    nightFigs = [];
  }

  function paintAll() {
    dropFigs();
    /* The whole record, as the server describes it. The two flagship panels
       have their own window control and set their own label just below. */
    const tf = data.h.timeframe;
    for (const p of [pFast, pRoll, pRead, pMixYear, pShape, pYears]) setTimeframe(p, tf);
    paintAverage();
    paintWeight();
    paintFasting();
    paintRest();
    paintNights();
  }

  /* ══ the nights ════════════════════════════════════════════════════════ */

  /* Every measure that has at least one reading on record. */
  const nightMeasures = () => METRICS.filter((m) => (data.nights || []).some((r) => isNum(r[m.key])));
  const nightFmt = (m) => (v) => `${Number(v).toFixed(m.digits)}${m.unit ? ` ${m.unit}` : ''}`;

  /* Four steps across the measure's own record, by quartile, so a year's grid
     is read against every other year's on the same scale — darker is more.
     Magnitude only: this is not a reading on a scale, and carries no tone. */
  function nightLevels(rows, key) {
    const vals = rows.map((r) => r[key]).filter(isNum).map(Number).sort((a, b) => a - b);
    if (!vals.length) return null;
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
    const cuts = [q(0.25), q(0.5), q(0.75)];
    return {
      min: vals[0], max: vals[vals.length - 1],
      level: (v) => (!isNum(v) ? 0 : 1 + cuts.filter((c) => Number(v) > c).length),
    };
  }

  function paintNights() {
    dropNightFigs();
    const rows = data.nights || [];
    const have = nightMeasures();
    const m = have.find((x) => x.key === state.night) || have[0];
    setTools(pNights, have.length ? segmented(
      have.map((x) => [x.key, x.label]), m.key,
      (v) => { state.night = v; setQuery({ night: v }); paintNights(); },
      'Which nightly measure the long view shows',
    ) : null);
    clear(pNights.body);
    if (!m) {
      pNights.head.querySelector('.sub').textContent = ' ';
      pNights.body.append(emptyNote('No nights on record yet — these arrive with the first Garmin sync.'));
      paintYearNights(null);
      return;
    }
    const months = metricByMonth(rows, m.key);
    const nights = rows.filter((r) => isNum(r[m.key]));
    pNights.head.querySelector('.sub').textContent =
      `${m.label.toLowerCase()}, mean per calendar month over ${fmt.int(nights.length)} nights since ${fmt.dateY(nights[0].date)} — a month's mean on each column, the nights behind it in the table; a month with no night is left out, never drawn as zero`;
    const color = m.hue === 'ink-2' ? token('ink-2') : token(m.hue);
    nightFigs.push(figure(pNights.body, {
      type: 'columns',
      aria: `${m.label}, mean per month, every month with a night on record`,
      height: 240, unit: m.unit, periodLabel: 'Month', minSlot: 36,
      series: [{ key: 'v', label: m.label, color }],
      points: months.map((x) => ({
        key: x.key, label: fmt.monthYear(x.key), values: { v: Number(x.mean.toFixed(m.digits)) },
        note: `${x.n} night${x.n === 1 ? '' : 's'}`,
      })),
      format: nightFmt(m),
      formatShort: (v) => Number(v).toFixed(m.digits),
    }));
    paintYearNights(m);
  }

  /* The grid of nights under each year block, for the picked measure. Drawn
     here rather than in `yearBlock` so a change of measure redraws the grids
     and nothing else. */
  function paintYearNights(m) {
    const rows = data.nights || [];
    const lv = m ? nightLevels(rows, m.key) : null;
    for (const host of pYears.querySelectorAll('.nightgrid')) {
      clear(host);
      if (!m || !lv) continue;
      const year = host.dataset.year;
      const byDate = new Map(rows.filter((r) => r.date.startsWith(year) && isNum(r[m.key])).map((r) => [r.date, r]));
      if (!byDate.size) continue;
      const hue = m.hue === 'ink-2' ? token('ink-2') : token(m.hue);
      const f = nightFmt(m);
      host.append(el('div', { class: 'nightgrid-head' }, [
        el('span', { class: 'nightgrid-name', text: `${m.label}, by night` }),
        el('span', { class: 'nightgrid-n', text: `${fmt.int(byDate.size)} night${byDate.size === 1 ? '' : 's'}` }),
        gridScale({ lo: f(lv.min), hi: f(lv.max), hue }),
      ]));
      const grid = el('div');
      dayGrid(grid, {
        start: data.h.start, counts: [], year,
        from: host.dataset.from, to: host.dataset.to, today: data.h.today, hue, what: m.label,
        cell: (iso) => {
          const r = byDate.get(iso);
          const v = r ? r[m.key] : null;
          return {
            level: lv.level(v),
            rows: [[m.label, v == null ? '—' : f(v)]],
            note: v == null ? 'no reading' : null,
            aria: v == null ? 'no reading' : `${m.label} ${f(v)}`,
          };
        },
      });
      host.append(grid);
    }
  }

  /* ══ flagship 1 — the boxed number ═════════════════════════════════════ */

  function paintAverage() {
    const { h } = data;
    clear(pAvg.body);

    /* The server's own basis is handed to the series so its endpoint lands on
       the server's figure rather than near it — the tile below and the label
       on the line are the same number, because there is only one number. */
    let avg = lifetimeAveragePerWeek(h, h.average);
    if (!avg.length) {
      pAvg.body.append(emptyNote('Not enough history yet.'));
      return;
    }
    /* The counts beneath are the same weeks, on the same x origin. Aligning by
       key rather than by length is what keeps the small multiple honest. */
    const shown = new Set(avg.map((p) => p.key));
    let weeks = weeklyCounts(h).filter((p) => shown.has(p.key));
    const limit = state.avgRange === 'all' ? null : Number(state.avgRange);
    if (limit && avg.length > limit) {
      avg = avg.slice(-limit);
      weeks = weeks.slice(-limit);
    }

    const vals = avg.map((p) => p.values.avg);
    const current = vals[vals.length - 1];
    const hi = Math.max(...vals);
    const lo = Math.min(...vals);
    const hiAt = avg[vals.indexOf(hi)];
    const loAt = avg[vals.indexOf(lo)];

    /* This panel's window is narrowed in the browser, so there is no server
       label for it to print. It states the window it actually drew, built from
       the keys of the series itself — and `/api/history` growing a `weeks`
       parameter is filed in NOTES-FOR-BACKEND.md so this can go back to being
       one authoritative string like every other panel. */
    setTimeframe(pAvg, state.avgRange === 'all' ? data.h.timeframe
      : `${avg.length} weeks to ${fmt.dateY(avg[avg.length - 1].key)}`);
    pAvg.head.querySelector('.sub').textContent =
      'The number the notebook boxed on every page: activities through the end of the last completed '
      + `week, divided by the weeks completed. ${avg.length} weeks shown, `
      + `${fmt.dateY(avg[0].key)} to ${fmt.dateY(avg[avg.length - 1].key)}.`;
    setTools(pAvg, segmented(AVG_RANGES, state.avgRange, (v) => {
      state.avgRange = v; setQuery({ avg: v }); dropFigs(); paintAll();
    }, 'Average window'));

    /* Named `lifetime`, not `avg`: `avg` is already the plotted series in
       this function, and shadowing it blanked the whole page. */
    const lifetime = h.average || {};
    pAvg.body.append(statStrip([
      /* Straight from the server so this tile and the week hero cannot say
         different things about the same number. */
      { label: 'Now', value: fmt.two(h.average?.value ?? current),
        note: lifetime.activities != null && lifetime.weeks
          ? `${fmt.int(lifetime.activities)} ÷ ${fmt.int(lifetime.weeks)} weeks`
          : 'activities per week, lifetime' },
      { label: 'Highest', value: hi.toFixed(2), note: fmt.dateY(hiAt.key) },
      { label: 'Lowest', value: lo.toFixed(2), note: fmt.dateY(loAt.key) },
      {
        /* The same pair the average divides, not `h.total` over `h.weeks`.
           Those are a different numerator *and* a different denominator: 396
           counts the week in progress and 87 counts calendar weeks, so the
           tile read "396 activities over 87 weeks" — 4.55 — directly beside a
           Now tile reading 4.42. Two figures for one quantity, one card
           apart, which is this codebase's oldest failure. */
        label: 'Total activities', value: fmt.int(lifetime.activities ?? h.total),
        note: lifetime.weeks
          ? `through ${fmt.dateY(lifetime.through)} — what the average divides by ${fmt.int(lifetime.weeks)} weeks`
          : `over ${h.weeks} weeks`,
      },
    ]));

    const main = el('div', { class: 'fig-primary' });
    pAvg.body.append(main);
    figs.push(figure(main, {
      type: 'line',
      aria: 'Lifetime average activities per week, for every week on record',
      height: 300, unit: '/week', periodLabel: 'Week ending',
      padLeft: PAD_L, padRight: PAD_R,
      annotate: 'extremes',
      series: [{ key: 'avg', label: 'Lifetime average', color: colorOf('soccer') }],
      points: byYear(avg),
      format: (v) => v.toFixed(2),
      formatShort: (v) => v.toFixed(1),
    }));

    /* The record itself, under the line it feeds: every week's activities
       as a column, split by modality in the colours every chart uses, with
       the lifetime average drawn across them so each week reads at once as
       the kind of week it was and as above or below the number. The split
       comes from the session list and is checked against the server's day
       counts week by week: if they ever disagree the columns fall back to
       one plain series, because a stack that does not sum to the count
       would be the oldest failure in this codebase, drawn in colour. */
    const stacked = weeksByKind(weeks, data.sessions);
    const above = weeks.filter((p) => p.values.n >= current).length;
    const sub = el('div', { class: 'fig-secondary' });
    pAvg.body.append(
      el('p', { class: 'fig-sublabel', text:
        `Activities logged each week, by modality — the input the line above smooths. `
        + `${above} of ${weeks.length} weeks at or above the lifetime average.` }),
      sub,
    );
    figs.push(figure(sub, {
      type: 'columns',
      aria: 'Activities logged in each week, split by modality, with the lifetime average as a guide',
      height: 220, unit: 'activities', periodLabel: 'Week of',
      padLeft: PAD_L, padRight: PAD_R, minSlot: 1,
      series: stacked
        ? stacked.kinds.map((k) => ({ key: k, label: kindName(k), color: colorOf(k) }))
        : [{ key: 'n', label: 'Activities', color: colorOf('soccer') }],
      points: byYear(stacked ? stacked.points : weeks),
      /* The guide is named in the legend, not in a gutter beside the plot:
         a gutter would narrow this chart and break the shared x extent with
         the line above, which is the whole point of stacking the two. */
      guides: [{ value: current, color: token('ink-2'), dashed: true }],
      legendExtra: [{ label: `lifetime average ${current.toFixed(2)}`, shape: 'line', color: token('ink-2') }],
      format: (v) => fmt.int(v),
      formatShort: (v) => fmt.int(v),
      labels: 'none',
    }));

    pAvg.body.append(el('p', { class: 'sub', text:
      'A blank week pulls the line down a little and the next entry pulls it back. There is no streak here to break, '
      + 'which is the entire point: the metric measures the record, not the last few days of it.' }));
  }

  /**
   * The weekly counts split by kind, on exactly the weeks the counts cover.
   * A session belongs to the Mon–Sun week whose Sunday is the point's key.
   * Returns null if any week's split does not sum to the server's count for
   * it — then the caller draws the plain series rather than a wrong stack.
   */
  function weeksByKind(weeks, sessions) {
    if (!weeks.length || !(sessions || []).length) return null;
    const byWeek = new Map(weeks.map((p) => [p.key, {}]));
    for (const sess of sessions) {
      const key = addDays(weekStart(sess.date), 6);
      const bucket = byWeek.get(key);
      if (!bucket) continue;
      bucket[sess.kind] = (bucket[sess.kind] || 0) + 1;
    }
    const points = weeks.map((p) => {
      const values = byWeek.get(p.key) || {};
      const sum = Object.values(values).reduce((a, b) => a + b, 0);
      return sum === Number(p.values.n) ? { ...p, values, total: p.values.n } : null;
    });
    if (points.some((p) => p === null)) {
      console.warn('activities per week: session split disagrees with the day counts; drawing one series');
      return null;
    }
    const kinds = orderKinds(KINDS.filter((k) => points.some((p) => p.values[k] > 0)));
    return { kinds, points };
  }

  /* ══ flagship 2 — bodyweight ═══════════════════════════════════════════ */

  function unitCtl() {
    return segmented([['lb', 'lb'], ['kg', 'kg']], state.unit, (v) => {
      state.unit = setWeightUnit(v);
      dropFigs();
      paintAll();
    }, 'Weight units');
  }

  function paintWeight() {
    const { h } = data;
    clear(pWeight.body);
    let bw = (h.bodyweight || []).filter((p) => p.kg != null);
    if (bw.length < 2) {
      pWeight.body.append(emptyNote('No weigh-ins on record.'));
      return;
    }
    const limitWeeks = state.bwRange === 'all' ? null : Number(state.bwRange);
    if (limitWeeks) {
      const cutoff = new Date(new Date(`${bw[bw.length - 1].date}T00:00:00`).getTime()
        - limitWeeks * 7 * 86400000);
      bw = bw.filter((p) => new Date(`${p.date}T00:00:00`) >= cutoff);
    }

    const u = state.unit;
    const conv = (kg) => inUnit(kg, u);
    const last = bw[bw.length - 1];

    setTools(pWeight, [
      unitCtl(),
      segmented(
        [['all', 'All time'], ['104', '2 years'], ['52', '52 weeks'], ['12', '12 weeks']],
        state.bwRange, (v) => { state.bwRange = v; setQuery({ bw: v }); dropFigs(); paintAll(); },
        'Bodyweight window',
      ),
    ]);
    setTimeframe(pWeight, state.bwRange === 'all' ? data.h.timeframe
      : `${state.bwRange} weeks to ${fmt.dateY(last.date)}`);
    pWeight.head.querySelector('.sub').textContent =
      `Every weigh-in you logged or synced, as it was read. `
      + `${bw.length} weigh-ins, ${fmt.dateY(bw[0].date)} to ${fmt.dateY(last.date)}. Stored and plotted, never scored.`;

    const deltaTile = (label, weeks) => {
      const cutoff = new Date(new Date(`${last.date}T00:00:00`).getTime() - weeks * 7 * 86400000);
      const prior = bw.filter((p) => new Date(`${p.date}T00:00:00`) <= cutoff).pop();
      if (!prior) return { label, value: '—', note: 'not enough history in range' };
      /* Reading to reading. Both ends were measured, so the difference is one
         you could have worked out from two mornings on the scale. */
      return {
        label, value: fmt.wholeSigned(conv(last.kg) - conv(prior.kg)), unit: u,
        note: `from ${fmt.whole(conv(prior.kg))} on ${fmt.dateY(prior.date)}`,
      };
    };

    pWeight.body.append(statStrip([
      {
        /* The reading, not the curve. A weight nobody can reproduce by
           standing on the scale is the wrong answer to "what do I weigh". */
        label: 'Latest', value: fmt.whole(conv(last.kg)), unit: u,
        note: `${fmt.dateY(last.date)} · ${fmt.whole(inUnit(last.kg, u === 'kg' ? 'lb' : 'kg'))} ${u === 'kg' ? 'lb' : 'kg'}`,
      },
      deltaTile('4 weeks', 4),
      deltaTile('12 weeks', 12),
      deltaTile('52 weeks', 52),
    ]));

    const main = el('div', { class: 'fig-primary' });
    pWeight.body.append(main);
    figs.push(figure(main, {
      type: 'line',
      aria: `Bodyweight readings in ${u === 'kg' ? 'kilograms' : 'pounds'}, every weigh-in on record`,
      height: 300, unit: u, periodLabel: 'Date',
      padLeft: PAD_L, padRight: PAD_R,
      annotate: 'extremes',
      /* The readings, and only the readings. A seven-day trend used to run
         behind them; it was the last smoothed line on the site and the user
         asked for it to go — what the scale said is the number, and a line
         the scale never produced beside it reads as a second opinion. The
         server still publishes `ema`; nothing draws it. */
      series: [{ key: 'raw', label: 'Weigh-in', color: token('ink-2') }],
      points: bw.map((p) => ({
        key: p.date, label: fmt.date(p.date), group: p.date.slice(0, 4),
        values: { raw: conv(p.kg) },
        note: `${inUnit(p.kg, u === 'kg' ? 'lb' : 'kg').toFixed(1)} ${u === 'kg' ? 'lb' : 'kg'}`,
      })),
      format: (v) => `${v.toFixed(1)}`,
      formatShort: (v) => v.toFixed(0),
    }));

    pWeight.body.append(el('p', { class: 'sub', text:
      'One line, no commentary. The database and Garmin both work in kilograms; the notebook was written in pounds, '
      + 'so the toggle above converts the display and every reading carries the other unit in its tooltip.' }));
  }

  /* ══ bodyweight against fasting ════════════════════════════════════════ */

  function paintFasting() {
    const { h, sessions } = data;
    clear(pFast.body);
    const fasts = sessions.filter((s) => s.kind === 'fast' && (s.detail || {}).hours);
    const bwMonths = bodyweightByMonth(h.bodyweight || []);
    if (bwMonths.length < 4) {
      pFast.body.append(emptyNote('Not enough weigh-ins to line up against fasting.'));
      return;
    }
    const months = monthSpan(bwMonths[0].key, bwMonths[bwMonths.length - 1].key);
    const byMonth = new Map(bwMonths.map((b) => [b.key, b]));
    const fastRows = fastingByMonth(fasts, months);

    const u = state.unit;
    const conv = (kg) => inUnit(kg, u);

    const main = el('div', { class: 'fig-primary' });
    pFast.body.append(main);
    figs.push(figure(main, {
      type: 'line',
      aria: `Monthly mean bodyweight in ${u === 'kg' ? 'kilograms' : 'pounds'}`,
      height: 220, unit: u, periodLabel: 'Month',
      padLeft: PAD_L, padRight: PAD_R, hideAxis: true,
      series: [{ key: 'kg', label: 'Monthly mean weight', color: token('ink-2') }],
      points: months.map((m) => ({
        key: m, label: fmt.monthYear(m),
        values: { kg: byMonth.has(m) ? conv(byMonth.get(m).kg) : null },
        note: byMonth.has(m) ? `${byMonth.get(m).n} weigh-ins` : 'no weigh-in',
      })),
      format: (v) => v.toFixed(1),
      formatShort: (v) => v.toFixed(0),
    }));

    const sub = el('div', { class: 'fig-secondary' });
    pFast.body.append(
      el('p', { class: 'fig-sublabel', text: 'Fasting hours logged in the same month' }),
      sub,
    );
    figs.push(figure(sub, {
      type: 'columns',
      aria: 'Fasting hours per month',
      height: 150, unit: 'hours', periodLabel: 'Month',
      padLeft: PAD_L, padRight: PAD_R, minSlot: 1,
      series: [{ key: 'hours', label: 'Fasting', color: colorOf('fast') }],
      points: fastRows.map((r) => ({
        key: r.key, label: fmt.monthYear(r.key),
        values: { hours: r.hours }, total: r.hours,
        note: r.n ? `${r.n} fast${r.n === 1 ? '' : 's'}` : 'none logged',
      })),
      format: (v) => fmt.int(v),
      formatShort: (v) => fmt.int(v),
    }));

    pFast.body.append(readout(weightReadout(h.bodyweight || [], fasts, { unit: u, convert: conv })));
  }

  /* ══ the rest ══════════════════════════════════════════════════════════ */

  function paintRest() {
    const { h, sessions } = data;
    const years = h.years || [];
    const sum = (key) => years.reduce((a, y) => a + (Number(y[key]) || 0), 0);

    clear(statsHost);
    statsHost.append(statStrip([
      { label: 'Activities', value: fmt.int(h.total), note: h.start ? `since ${fmt.dateY(h.start)}` : '' },
      { label: 'Weeks logged', value: fmt.int(h.weeks), note: `${years.length} calendar year${years.length === 1 ? '' : 's'}` },
      /* Every kind that carries a distance, which now includes soccer and
         quick feet — the watch measures them. The caption said "running,
         biking and rucking" and predates that: 1,520 km under a note
         describing 1,390 of it. */
      { label: 'Distance', value: fmt.int(sum('distance_km')), unit: 'km',
        note: 'every kilometre logged, all modalities' },
      { label: 'Load', value: fmt.compact(sum('load')), unit: 'AU', note: 'training load, all modalities' },
      ...(nightsOnRecord(data.nights) ? [nightsOnRecord(data.nights)] : []),
    ]));

    clear(pRoll.body);
    const roll = rolling28(h, { step: (h.counts || []).length > 800 ? 2 : 1 });
    if (roll.length < 5) {
      pRoll.body.append(emptyNote('Not enough history for a 28-day window yet.'));
    } else {
      figs.push(figure(pRoll.body, {
        type: 'line',
        aria: 'Activities logged in the trailing 28 days, for every day on record',
        height: 220, unit: 'activities', periodLabel: 'Day', zeroBase: true,
        annotate: 'extremes',
        series: [{ key: 'n', label: 'Trailing 28 days', color: colorOf('soccer') }],
        points: byYear(roll),
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
      }));
    }

    clear(pRead.body);
    pRead.body.append(readout([
      ...historyReadout(h, sessions),
      ...recoveryReadout(data.nights || [], { fmtDate: fmt.dateY }),
    ]));

    clear(pMixYear.body);
    const yearKinds = orderKinds(KINDS.filter((k) => years.some((y) => (y.by_kind || {})[k] > 0)));
    if (years.length < 1 || yearKinds.length < 2) {
      pMixYear.body.append(emptyNote('Not enough variety on record to show a mix.'));
    } else {
      const asc = years.slice().sort((a, b) => (a.year < b.year ? -1 : 1));
      const norm = normalizePoints(asc.map((y) => ({ period: y.year, values: y.by_kind || {} })), yearKinds);
      figs.push(figure(pMixYear.body, {
        type: 'columns',
        aria: 'Share of logged entries by modality, per year',
        height: 200, unit: '%', periodLabel: 'Year', minSlot: 40,
        series: yearKinds.map((k) => ({ key: k, label: kindName(k), color: colorOf(k) })),
        points: norm.map((p, i) => ({
          key: p.period, label: p.period, values: p.values, total: p.total,
          note: `${fmt.int(asc[i].activities)} activities`,
        })),
        format: (v) => `${Math.round(v)}%`,
        formatShort: (v) => `${Math.round(v)}%`,
        labels: 'none',
      }));
    }

    clear(pShape.body);
    const counts = h.counts || [];
    const activeDays = counts.filter((n) => n > 0).length;
    const doubles = counts.filter((n) => n > 1).length;
    pShape.body.append(statStrip([
      {
        label: 'Days covered', value: `${Math.round((activeDays / (counts.length || 1)) * 100)}%`,
        note: `${fmt.int(activeDays)} of ${fmt.int(counts.length)} days`,
      },
      { label: 'Multi-session days', value: fmt.int(doubles), note: 'two or more entries' },
    ]));
    pShape.body.append(el('p', { class: 'sub', text:
      'Coverage is a rolling proportion of the whole record. It does not reset, and no single day changes it much.' }));

    clear(pYears.body);
    pYears.head.querySelector('.sub').textContent = h.start
      ? `${fmt.int(h.total)} activities across ${h.weeks} weeks, ${fmt.dateY(h.start)} to ${fmt.dateY(h.end)}`
      : 'Nothing on record yet.';
    if (!years.length) pYears.body.append(emptyNote('Nothing on record yet.'));
    else for (const y of years) pYears.body.append(yearBlock(h, y));
  }

  /** The nights tile for the strip, or null before the first sync. */
  function nightsOnRecord(rows) {
    const nights = (rows || []).filter((r) => isNum(r.sleep_hours) || isNum(r.resting_hr));
    if (!nights.length) return null;
    return { label: 'Nights', value: fmt.int(nights.length), note: `since ${fmt.dateY(nights[0].date)}, from the watch` };
  }

  /** A year's nights, as stats for its head: mean and count per measure. */
  function yearNightStats(year) {
    const rows = (data.nights || []).filter((r) => r.date.startsWith(year));
    const out = [];
    for (const key of ['sleep_hours', 'hrv_ms', 'resting_hr', 'readiness']) {
      const s = summarise(rows, key);
      if (!s.n) continue;
      const m = metricOf(key);
      out.push([m.label, `${nightFmt(m)(s.value)} ·${s.n}`]);
    }
    return out;
  }

  function yearBlock(h, y) {
    const byKind = y.by_kind || {};
    const parts = orderKinds(Object.keys(byKind)).filter((k) => byKind[k] > 0)
      .map((k) => ({ key: k, label: kindName(k), value: byKind[k], color: colorOf(k) }));

    const mix = el('div', { class: 'yearmix' });
    splitBar(mix, { parts, unit: '', format: (v) => fmt.int(v), emptyText: 'Nothing logged this year.' });

    const gridHost = el('div');
    const yearStart = `${y.year}-01-01`;
    const yearEnd = `${y.year}-12-31`;
    dayGrid(gridHost, {
      start: h.start, counts: h.counts || [], year: y.year,
      from: yearStart < h.start ? h.start : yearStart,
      to: yearEnd > h.end ? h.end : yearEnd,
      today: h.today,
    });

    const stat = (label, value) => el('div', { class: 'yearstat' }, [
      el('dt', { text: label }), el('dd', { class: 'num', text: value }),
    ]);
    const nightStats = yearNightStats(y.year);
    const nightHost = el('div', {
      class: 'nightgrid', 'data-year': y.year,
      'data-from': yearStart < h.start ? h.start : yearStart,
      'data-to': yearEnd > h.end ? h.end : yearEnd,
    });

    return el('div', { class: 'yearblock' }, [
      el('div', { class: 'yearhead' }, [
        el('div', { class: 'yearnum', text: y.year }),
        el('dl', { class: 'yearstats' }, [
          stat('Activities', fmt.int(y.activities)),
          stat('Per week', fmt.two(y.avg_per_week)),
          stat('Active days', fmt.int(y.active_days)),
          stat('Distance', `${fmt.int(y.distance_km)} km`),
          stat('Load', `${fmt.compact(y.load)} AU`),
          stat('Span', `${fmt.date(y.first)} – ${fmt.date(y.last)}`),
        ]),
        nightStats.length ? el('dl', { class: 'yearstats yearstats-nights' }, nightStats.map(([k, v]) => stat(k, v))) : null,
      ].filter(Boolean)),
      mix,
      gridHost,
      nightHost,
    ]);
  }

  return { destroy() { alive = false; dropFigs(); } };
}
