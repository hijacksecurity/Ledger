/* Trends — the flexible slice. One filter row scopes everything below it.
 *
 * Four metrics × two grains × seven modalities × five ranges is the whole
 * point: the same record, asked a different question, without leaving the page.
 */

import {
  el, clear, api, qs, busy, fmt, colorOf, orderKinds, KINDS, periodLabel,
} from './core.js';
import {
  panel, panelError, statStrip, segmented, kindFilter, emptyNote, readout,
  skeletonBlock, kindName, RANGE_PRESETS, resolveRange, subTabs, setTimeframe,
  rememberedChoice, rememberChoice,
} from './ui.js';
import { figure, splitBar } from './charts.js';
import {
  sessionsIn, byWeekday, rpeHistogram, normalizePoints, trendsReadout,
} from './dataset.js';

const METRICS = [
  ['load', 'Load'], ['distance', 'Distance'], ['count', 'Activities'], ['duration', 'Time'],
];

const FORMATTERS = {
  load: { full: (v) => fmt.int(v), short: (v) => fmt.compact(v), unit: 'AU' },
  distance: { full: (v) => `${fmt.one(v)}`, short: (v) => fmt.compact(v), unit: 'km' },
  count: { full: (v) => fmt.int(v), short: (v) => fmt.int(v), unit: '' },
  duration: { full: (v) => fmt.mins(v), short: (v) => fmt.compact(v / 60), unit: 'h' },
};

export function mount(host, route, { setQuery }) {
  const q = route.query;
  const state = {
    /* Metric, grain and range are choices and are remembered; the modality
       is a filter and starts clear. The URL still wins. */
    metric: rememberedChoice('ledger.trends.metric', route, 'metric', (v) => METRICS.some(([m]) => m === v), 'load'),
    grain: rememberedChoice('ledger.trends.grain', route, 'grain', (v) => v === 'week' || v === 'month', 'week'),
    kind: KINDS.includes(q.get('kind')) ? q.get('kind') : null,
    range: rememberedChoice('ledger.trends.range', route, 'range', (v) => RANGE_PRESETS.some(([k]) => k === v), '52w'),
  };
  let figs = [];
  let alive = true;
  let seq = 0;

  const filters = el('div', { class: 'filterbar', role: 'group', 'aria-label': 'Trend filters' });
  const statsHost = el('div', { class: 'strip-host' });
  const pChart = panel({ title: ' ', sub: ' ', wide: true });
  const pMix = panel({
    title: 'Mix over time', sub: 'each period rescaled to 100% — the drift, not the volume', wide: true,
  });
  const pRhythm = panel({ title: 'Weekday rhythm', sub: 'load by day of week, in this window' });
  const pRpe = panel({ title: 'How hard', sub: 'sessions by recorded RPE' });
  const pSplit = panel({ title: 'Share of the range', sub: 'total by modality across the selected window' });
  const pRead = panel({ title: 'Read-out', sub: 'what this window says' });
  const rowA = el('div', { class: 'grid-2' }, [pRhythm, pRpe]);
  const rowB = el('div', { class: 'grid-2' }, [pSplit, pRead]);

  host.append(subTabs('history', 'trends'), filters, statsHost, pChart, pMix, rowA, rowB);
  skeletonBlock(96, statsHost);
  skeletonBlock(280, pChart.body);
  skeletonBlock(200, pMix.body);
  skeletonBlock(200, pRhythm.body);
  skeletonBlock(200, pRpe.body);
  skeletonBlock(80, pSplit.body);
  skeletonBlock(120, pRead.body);

  function buildFilters() {
    clear(filters);
    filters.append(
      labelled('Metric', segmented(METRICS, state.metric, (v) => update({ metric: v }), 'Metric')),
      labelled('Grain', segmented([['week', 'Weekly'], ['month', 'Monthly']], state.grain,
        (v) => update({ grain: v }), 'Grain')),
      labelled('Range', segmented(RANGE_PRESETS, state.range, (v) => update({ range: v }), 'Date range')),
      labelled('Modality', kindFilter(KINDS, state.kind, (v) => update({ kind: v === state.kind ? null : v }))),
    );
  }

  function labelled(text, control) {
    return el('div', { class: 'filter' }, [el('span', { class: 'lbl', text }), control]);
  }

  function update(patch) {
    Object.assign(state, patch);
    for (const k of ['metric', 'grain', 'range']) if (k in patch) rememberChoice(`ledger.trends.${k}`, patch[k]);
    setQuery({
      metric: state.metric, grain: state.grain,
      kind: state.kind || '', range: state.range,
    });
    buildFilters();
    load();
  }

  async function load() {
    const mine = ++seq;
    const { from, to } = resolveRange(state.range);
    busy(true);
    /* Sequential, not Promise.all. The API shares one SQLite connection across
       FastAPI's threadpool and two in-flight requests intermittently 500 with
       a thread-affinity error (see NOTES-FOR-BACKEND.md §1). Overlapping these
       two made it reproducible, so they wait for each other until that is
       fixed; on a same-origin container the cost is a few milliseconds. */
    const res = await api(`/api/trends${qs({
      metric: state.metric, grain: state.grain, kind: state.kind, from, to,
    })}`);
    const sess = await sessionsIn({ from, to, kind: state.kind });
    busy(false);
    if (!alive || mine !== seq) return;

    if (!res.ok) {
      clear(statsHost);
      panelError(pChart.body, res, 'Trends');
      clear(pMix.body); clear(pRhythm.body); clear(pRpe.body);
      clear(pSplit.body); clear(pRead.body);
      return;
    }
    paint(res.data, sess.ok ? sess.items : [], sess.timeframe);
  }

  function paint(d, sessions, sessTf) {
    /* One window for the page, set by the range control and nothing else.
       `/api/trends` and `/api/sessions` describe the same span two ways —
       "53 weeks to 11 Aug 2026" against "12 Aug 2025 to 11 Aug 2026" — and
       printing both put two different-looking periods on one screen for what
       is the same range. The trend payload's label wins because the range
       control is quoted in weeks. */
    for (const p of [pChart, pMix, pSplit, pRhythm, pRpe, pRead]) {
      setTimeframe(p, d.timeframe || sessTf);
    }
    figs.forEach((f) => f.destroy && f.destroy());
    figs = [];
    const points = d.points || [];
    const f = FORMATTERS[state.metric] || FORMATTERS.load;
    const unit = d.unit || f.unit;

    const kindsPresent = orderKinds(
      KINDS.filter((k) => points.some((p) => (p.by_kind || {})[k] > 0)),
    );
    const series = (state.kind ? [state.kind] : kindsPresent)
      .map((k) => ({ key: k, label: kindName(k), color: colorOf(k) }));

    /* headline numbers, summed from the same points the chart draws */
    const values = points.map((p) => Number(p.value) || 0);
    const total = values.reduce((a, b) => a + b, 0);
    const active = values.filter((v) => v > 0).length;
    const peakIdx = values.indexOf(Math.max(...values, 0));
    const grainWord = state.grain === 'month' ? 'month' : 'week';

    clear(statsHost);
    statsHost.append(statStrip([
      { label: 'Total', value: f.full(total), unit, note: `${points.length} ${grainWord}s in range` },
      {
        label: `Mean per ${grainWord}`,
        value: f.full(points.length ? total / points.length : 0), unit,
        note: `${active} of ${points.length} ${grainWord}s had activity`,
      },
      {
        label: `Peak ${grainWord}`,
        value: points.length ? f.full(values[peakIdx]) : '—', unit,
        note: points.length ? periodLabel(points[peakIdx].period, state.grain) : '',
      },
      {
        label: 'Modalities', value: String(kindsPresent.length),
        note: kindsPresent.map(kindName).join(', ') || 'none',
      },
    ]));

    const metricLabel = (METRICS.find(([m]) => m === state.metric) || [])[1] || state.metric;
    const scope = state.kind ? kindName(state.kind) : 'all modalities';
    pChart.head.querySelector('h2').textContent = `${metricLabel} — ${scope}`;
    pChart.head.querySelector('.sub').textContent =
      `${state.grain === 'month' ? 'By month' : 'By week'}${unit ? `, in ${unit}` : ''}${
        d.start ? ` · ${fmt.dateY(d.start)} to ${fmt.dateY(d.end)}` : ''}`;

    clear(pChart.body);
    if (!points.length) {
      pChart.body.append(emptyNote('Nothing in this range.'));
    } else {
      figs.push(figure(pChart.body, {
        type: 'columns',
        aria: `${metricLabel} by ${grainWord} for ${scope}`,
        height: 280,
        unit,
        periodLabel: state.grain === 'month' ? 'Month' : 'Week of',
        series,
        points: points.map((p) => ({
          key: p.period,
          label: periodLabel(p.period, state.grain),
          values: p.by_kind || {},
          total: p.value,
        })),
        format: f.full,
        formatShort: f.short,
        emptyText: 'Nothing in this range.',
      }));
    }

    /* mix over time — the chart that shows soccer taking over */
    clear(pMix.body);
    if (state.kind) {
      pMix.body.append(emptyNote(
        `Filtered to ${kindName(state.kind)} — clear the modality filter to see the mix.`));
    } else if (kindsPresent.length < 2) {
      pMix.body.append(emptyNote('Only one modality in this range; there is no mix to show.'));
    } else {
      const norm = normalizePoints(
        points.map((p) => ({ ...p, values: p.by_kind || {} })), kindsPresent,
      );
      figs.push(figure(pMix.body, {
        type: 'columns',
        aria: 'Share of each period by modality',
        height: 200, unit: '%', periodLabel: state.grain === 'month' ? 'Month' : 'Week of',
        series: kindsPresent.map((k) => ({ key: k, label: kindName(k), color: colorOf(k) })),
        points: norm.map((p) => ({
          key: p.period, label: periodLabel(p.period, state.grain),
          values: p.values, total: p.total,
          note: p.absolute ? `${f.full(p.absolute)} ${unit} in total` : 'nothing logged',
        })),
        format: (v) => `${Math.round(v)}%`,
        formatShort: (v) => `${Math.round(v)}%`,
        labels: 'none',
        emptyText: 'Nothing in this range.',
      }));
    }

    /* weekday rhythm */
    clear(pRhythm.body);
    if (!sessions.length) {
      pRhythm.body.append(emptyNote('No sessions in this range.'));
    } else {
      const wk = byWeekday(sessions);
      const rhythmKinds = orderKinds(KINDS.filter((k) => wk.some((r) => r.values[k] > 0)));
      figs.push(figure(pRhythm.body, {
        type: 'columns',
        aria: 'Training load by day of the week',
        height: 200, unit: 'AU', periodLabel: 'Day',
        series: rhythmKinds.map((k) => ({ key: k, label: kindName(k), color: colorOf(k) })),
        points: wk.map((r) => ({
          key: r.key, label: r.label, values: r.values, total: r.total,
          note: `${r.count} session${r.count === 1 ? '' : 's'}`,
        })),
        format: (v) => fmt.int(v),
        emptyText: 'No scored sessions in this range.',
      }));
    }

    /* RPE distribution — the input the whole load model rests on */
    clear(pRpe.body);
    const hist = rpeHistogram(sessions);
    if (!hist.scored) {
      pRpe.body.append(emptyNote('No session in this range carries an RPE.'));
    } else {
      const rpeKinds = orderKinds(KINDS.filter((k) => hist.rows.some((r) => r.values[k] > 0)));
      figs.push(figure(pRpe.body, {
        type: 'columns',
        aria: 'Number of sessions at each recorded RPE',
        height: 200, unit: 'sessions', periodLabel: 'RPE',
        series: rpeKinds.map((k) => ({ key: k, label: kindName(k), color: colorOf(k) })),
        points: hist.rows,
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
        emptyText: 'No RPE recorded in this range.',
      }));
      pRpe.body.append(el('p', { class: 'sub', text:
        `${hist.scored} of ${sessions.length} sessions carry an RPE${
          hist.unscored ? `; ${hist.unscored} are unscored and carry no load` : ''}.` }));
    }

    /* read-out */
    clear(pRead.body);
    pRead.body.append(readout(trendsReadout(d, sessions, {
      metric: state.metric, grain: state.grain, kind: state.kind,
    })));

    /* share of the range */
    clear(pSplit.body);
    const totals = {};
    for (const p of points) {
      for (const [k, v] of Object.entries(p.by_kind || {})) totals[k] = (totals[k] || 0) + Number(v || 0);
    }
    const parts = orderKinds(Object.keys(totals))
      .filter((k) => totals[k] > 0)
      .map((k) => ({ key: k, label: kindName(k), value: totals[k], color: colorOf(k) }));
    splitBar(pSplit.body, {
      parts, unit, format: f.full,
      emptyText: 'Nothing in this range.',
    });
    pSplit.head.querySelector('.sub').textContent =
      state.kind ? `Filtered to ${kindName(state.kind)}` : 'Total by modality across the selected window';
  }

  buildFilters();
  load();

  return {
    destroy() { alive = false; figs.forEach((f) => f.destroy && f.destroy()); },
    refresh: load,
  };
}
