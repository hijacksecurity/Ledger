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
  getWeightUnit, setWeightUnit, inUnit, stepTowardInk,
} from './core.js';
import {
  panel, panelError, statStrip, emptyNote, skeletonBlock, kindName, readout, segmented, subTabs,
  setTimeframe,
  setTools,
} from './ui.js';
import { figure, splitBar, dayGrid, gridScale } from './charts.js';
import {
  rolling28, normalizePoints, historyReadout, sessionsIn, lifetimeAveragePerWeek,
  weeklyCounts, bodyweightByMonth, fastingByMonth, monthSpan, weightReadout,
} from './dataset.js';

/* A forced left pad, so the primary chart and the one beneath it share an
   x origin exactly. Alignment is what makes a small multiple readable. */
const PAD_L = 48;
const PAD_R = 14;

const AVG_RANGES = [['all', 'All time'], ['104', '2 years'], ['52', '52 weeks'], ['26', '26 weeks']];

export function mount(host, route, { setQuery }) {
  const state = {
    avgRange: route.query.get('avg') || 'all',
    bwRange: route.query.get('bw') || 'all',
    unit: getWeightUnit(),
  };
  let figs = [];
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
  const pRead = panel({ title: 'Read-out', sub: 'the whole record, stated plainly', wide: true });
  const pMixYear = panel({ title: 'Mix by year', sub: 'share of entries by modality' });
  const pShape = panel({ title: 'Shape of the record', sub: 'coverage and gaps' });
  const pYears = panel({ title: 'Every day on record', sub: ' ', tools: gridScale(), wide: true });
  const statsHost = el('div', { class: 'strip-host' });

  host.append(
    subTabs('history', 'all'),
    pAvg, pWeight, pFast, statsHost, pRoll, pRead,
    el('div', { class: 'grid-2' }, [pMixYear, pShape]),
    pYears,
  );
  skeletonBlock(420, pAvg.body);
  skeletonBlock(420, pWeight.body);
  skeletonBlock(300, pFast.body);
  skeletonBlock(96, statsHost);
  skeletonBlock(220, pRoll.body);
  skeletonBlock(140, pRead.body);
  skeletonBlock(200, pMixYear.body);
  skeletonBlock(200, pShape.body);
  skeletonBlock(320, pYears.body);

  (async () => {
    busy(true);
    const res = await api('/api/history');
    const sess = await sessionsIn({});
    busy(false);
    if (!alive) return;
    if (!res.ok) {
      clear(statsHost);
      panelError(pAvg.body, res, 'All-time history');
      panelError(pWeight.body, res, 'Bodyweight');
      clear(pFast.body); clear(pRoll.body); clear(pRead.body);
      clear(pMixYear.body); clear(pShape.body); clear(pYears.body);
      return;
    }
    data = { h: res.data, sessions: sess.ok ? sess.items : [] };
    paintAll();
  })();

  function dropFigs() {
    figs.forEach((f) => f.destroy && f.destroy());
    figs = [];
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
        label: 'Counted', value: fmt.int(lifetime.activities ?? h.total),
        note: lifetime.weeks
          ? `through ${fmt.dateY(lifetime.through)}, over ${fmt.int(lifetime.weeks)} weeks`
          : `activities over ${h.weeks} weeks`,
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
      points: avg,
      format: (v) => v.toFixed(2),
      formatShort: (v) => v.toFixed(1),
    }));

    const sub = el('div', { class: 'fig-secondary' });
    pAvg.body.append(
      el('p', { class: 'fig-sublabel', text: 'Activities logged each week — the input the line above smooths' }),
      sub,
    );
    figs.push(figure(sub, {
      type: 'columns',
      aria: 'Activities logged in each week',
      height: 130, unit: 'activities', periodLabel: 'Week of',
      padLeft: PAD_L, padRight: PAD_R, minSlot: 1,
      series: [{ key: 'n', label: 'Activities', color: stepTowardInk(colorOf('soccer'), 0.42) }],
      points: weeks,
      format: (v) => fmt.int(v),
      formatShort: (v) => fmt.int(v),
      labels: 'none',
    }));

    pAvg.body.append(el('p', { class: 'sub', text:
      'A blank week pulls the line down a little and the next entry pulls it back. There is no streak here to break, '
      + 'which is the entire point: the metric measures the record, not the last few days of it.' }));
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
    const emaOf = (p) => p.ema ?? p.kg;
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
      `Every weigh-in you logged or synced, with a seven-day trend line behind them. `
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
      aria: `Bodyweight readings in ${u === 'kg' ? 'kilograms' : 'pounds'}, with a seven-day trend line behind them`,
      height: 300, unit: u, periodLabel: 'Date',
      padLeft: PAD_L, padRight: PAD_R,
      annotate: 'extremes',
      /* Readings lead. The EMA stays as a background guide — 97 weigh-ins
         swinging seven pounds inside a fortnight genuinely need a trend line
         to read a direction off — but it is behind the data now, not in front
         of it, and it is never called "your weight". */
      series: [
        { key: 'raw', label: 'Weigh-in', color: token('ink-2') },
        { key: 'ema', label: '7-day trend', color: token('ink-3'), dashed: true },
      ],
      points: bw.map((p) => ({
        key: p.date, label: fmt.date(p.date),
        values: { ema: conv(emaOf(p)), raw: conv(p.kg) },
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
        points: roll,
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
      }));
    }

    clear(pRead.body);
    pRead.body.append(readout(historyReadout(h, sessions)));

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
      ]),
      mix,
      gridHost,
    ]);
  }

  return { destroy() { alive = false; dropFigs(); } };
}
