/* Ledger — hand-rolled SVG charts.
 *
 * No charting library: a dependency that rots is the one thing this project
 * cannot afford. Everything here follows one mark spec —
 *
 *   bars ≤ 24px and capped, 4px rounded data-end square at the baseline,
 *   2px surface gap between stacked segments (a gap, never a stroke),
 *   2px lines, ≥ 8px markers ringed in the surface colour,
 *   hairline solid gridlines one step off the surface,
 *   direct labels only on the extreme and the endpoint,
 *   a legend whenever there are two or more series,
 *   and a table view on every figure.
 *
 * That last one is not a nicety. Three of the light-mode series hues sit under
 * 3:1 against the surface, so the table is the required relief.
 *
 * Charts render at device scale (viewBox == CSS pixels) so a "24px bar" is
 * actually 24px, and re-render on resize rather than stretching.
 */

import {
  el, clear, attachTip, hideTip, showTip, fmt, token, reducedMotion,
} from './core.js';

/* ── reference marks ─────────────────────────────────────────────────────── */

/**
 * A shaded horizontal band and a labelled horizontal rule, drawn under the
 * data. Both exist for the Recovery page, where a figure means nothing until
 * it is seen against the wearer's own range — HRV against Garmin's balanced
 * band, a night against its sleep need — and both are plainly reference, not
 * data: the band is a faint wash, the guide a dashed hairline with its own
 * label at the right edge.
 *
 *   spec.bands  = [{ from, to, color, label }]     from/to in data units
 *   spec.guides = [{ value, color, label, dashed }]
 *
 * A point may carry `group` — the year of a date-keyed series. When the
 * points span more than one group the axis gets a second row that names each
 * group where it begins, so "Oct 4" on a chart three years long is never read
 * as the wrong year. `spec.groups = false` turns the row off.
 */
const refLabelWidth = (text) => Math.round(text.length * 6.9) + 14;

/** Indexes at which a new group starts, or [] when the points carry none. */
const groupStarts = (points, spec) => (spec.groups === false ? [] : points.reduce((acc, p, i) => {
  if (p.group != null && (i === 0 || p.group !== points[i - 1].group)) acc.push(i);
  return acc;
}, []));
/** Height of the group row under the ticks. */
const GROUP_ROW = 14;

/* A plot narrower than this gets each mark's short label ("41–67") instead
   of the full one ("balanced 41–67 ms"); the legend still carries the full
   wording either way. */
const REF_FULL_MIN_WIDTH = 640;

const refText = (mark, width) => (width < REF_FULL_MIN_WIDTH && mark.short ? mark.short : mark.label);

/** The right-hand gutter the reference labels need, so they sit beside the
 *  plot — clear of the columns, their numbers, and the axis ticks on the
 *  left. Zero when nothing is labelled. */
function refGutter(spec, width) {
  const texts = [
    ...(spec.bands || []).map((b) => (b.label ? refText(b, width) : null)),
    ...(spec.guides || []).map((g) => (g.label ? refText(g, width) : null)),
  ].filter(Boolean);
  return texts.length ? Math.max(...texts.map(refLabelWidth)) + 10 : 0;
}

/**
 * A shaded horizontal band and a labelled horizontal rule, drawn under the
 * data. Both exist for the Recovery page, where a figure means nothing until
 * it is seen against the wearer's own range — HRV against Garmin's balanced
 * band, a night against its sleep need — and both are plainly reference, not
 * data: the band is a faint wash, the guide a dashed hairline.
 *
 * The label is a small boxed tag in the gutter to the right of the plot, on
 * the line it names (or centred in the band). Out there it cannot collide
 * with a column, a column's number, or a tick on the left axis, whatever
 * value the mark sits at.
 *
 *   spec.bands  = [{ from, to, color, label, short }]     from/to in data units
 *   spec.guides = [{ value, color, label, short, dashed }]
 */
function drawReference(svg, spec, { y, padL, plotW, clampLo, clampHi, width }) {
  const clamp = (v) => Math.max(clampLo, Math.min(clampHi, v));
  const labelBox = (mark, yMid, color) => {
    const text = refText(mark, width);
    const w = refLabelWidth(text);
    const g = el('g', { class: 'reflabel-g' });
    g.append(el('rect', {
      class: 'refbox', x: padL + plotW + 6, y: yMid - 9, width: w, height: 18, rx: 4,
      stroke: color || null,
    }));
    g.append(el('text', {
      class: 'reflabel', x: padL + plotW + 13, y: yMid + 4, 'text-anchor': 'start', text,
      fill: color || null,
    }));
    return g;
  };
  const labels = [];
  for (const b of spec.bands || []) {
    if (!Number.isFinite(b.from) || !Number.isFinite(b.to)) continue;
    const top = y(clamp(Math.max(b.from, b.to)));
    const bot = y(clamp(Math.min(b.from, b.to)));
    if (bot - top < 0.5) continue;
    svg.append(el('rect', {
      class: 'refband', x: padL, y: top, width: plotW, height: bot - top,
      fill: b.color || 'currentColor',
    }));
    svg.append(el('line', { class: 'refedge', x1: padL, x2: padL + plotW, y1: top, y2: top, stroke: b.color || null }));
    svg.append(el('line', { class: 'refedge', x1: padL, x2: padL + plotW, y1: bot, y2: bot, stroke: b.color || null }));
    if (b.label) labels.push(labelBox(b, (top + bot) / 2, b.color));
  }
  for (const g of spec.guides || []) {
    if (!Number.isFinite(g.value)) continue;
    const gy = y(clamp(g.value));
    svg.append(el('line', {
      class: 'refguide', x1: padL, x2: padL + plotW, y1: gy, y2: gy,
      stroke: g.color || null, 'stroke-dasharray': g.dashed === false ? null : '6 4',
    }));
    if (g.label) labels.push(labelBox(g, gy, g.color));
  }
  /* Returned, not appended: the caller adds them after the data so nothing
     drawn later can sit on top of one. */
  return labels;
}

/* ── scales & geometry ───────────────────────────────────────────────────── */

const STEPS = [1, 2, 2.5, 5, 10];

/** A round axis maximum and its tick values. */
export function niceScale(max, count = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = (STEPS.find((s) => raw <= s * mag) || 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { max: top, ticks };
}

/** Same, but for a band that need not include zero (bodyweight, e1RM). */
function niceBand(lo, hi, count = 4) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  const a = lo - pad;
  const b = hi + pad;
  const raw = (b - a) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = (STEPS.find((s) => raw <= s * mag) || 10) * mag;
  const min = Math.floor(a / step) * step;
  const max = Math.ceil(b / step) * step;
  const ticks = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { min, max, ticks };
}

/** Rect with the two top corners rounded — the data-end of a column. */
function topRoundedPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}a${rr},${rr} 0 0 1 ${rr},${-rr}h${w - 2 * rr}a${rr},${rr} 0 0 1 ${rr},${rr}V${y + h}Z`;
}

/** Rect with both right corners rounded — the data-end of a horizontal bar. */
function rightRoundedPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w, h / 2));
  return `M${x},${y}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - 2 * rr}a${rr},${rr} 0 0 1 ${-rr},${rr}h${-(w - rr)}Z`;
}

/* ── figure shell ────────────────────────────────────────────────────────── */

/**
 * The single public entry point. Renders a chart, its legend, a chart/table
 * switch and the table itself; re-renders on container resize.
 *
 * spec = {
 *   type: 'columns' | 'line',
 *   aria, height, emptyText, unit,
 *   series: [{key, label, color, dashed?}],
 *   points: [{key, label, values:{seriesKey: number}, total?, note?}],
 *   format(v), formatShort(v), periodLabel, zeroBase, minSlot
 * }
 */
export function figure(host, spec) {
  clear(host);
  host.classList.add('fig');

  const points = spec.points || [];
  const series = (spec.series || []).filter((s) => s.plot !== false);
  const tableSeries = spec.series || [];
  const hasData = points.some((p) => series.some((s) => Number(p.values?.[s.key] ?? 0) !== 0));

  if (!points.length || (!hasData && spec.type !== 'line')) {
    host.append(el('p', { class: 'empty', text: spec.emptyText || 'Nothing to plot.' }));
    return { destroy() {} };
  }

  const format = spec.format || ((v) => fmt.int(v));
  const formatShort = spec.formatShort || ((v) => fmt.compact(v));

  const plotWrap = el('div', { class: 'fig-plot' });
  const tableWrap = el('div', { class: 'fig-table', hidden: true });
  const live = el('div', { class: 'sr', 'aria-live': 'polite' });
  const foot = el('div', { class: 'fig-foot' });

  /* legend — always present for two or more series; one series is named by
     the panel title, so a single-swatch box would only restate it. */
  if (series.length > 1 || (spec.legendExtra && spec.legendExtra.length)) {
    const leg = el('ul', { class: 'legend' });
    for (const s of (series.length > 1 ? series : [])) {
      leg.append(el('li', {}, [
        /* A dashed series gets a dashed swatch. The dash is what separates
           "logged" from "planned" on the plot, so a solid chip beside it
           would be the legend disagreeing with the chart. */
        el('i', { class: s.dashed ? 'dash' : null, style: `background:${s.color}` }),
        el('span', { text: s.label }),
        s.total != null ? el('b', { class: 'num', text: s.total }) : null,
      ]));
    }
    if (spec.legendExtra) {
      for (const x of [].concat(spec.legendExtra)) {
        leg.append(el('li', {}, [
          el('i', {
            class: `lg-${x.shape || 'square'}`,
            style: x.shape === 'hollow'
              ? `border-color:${x.color}` : `background:${x.color}`,
          }),
          el('span', { text: x.label }),
        ]));
      }
    }
    foot.append(leg);
  } else {
    foot.append(el('span', {}));
  }

  const toggle = el('div', { class: 'seg fig-switch', role: 'group', 'aria-label': 'Figure view' });
  const bChart = el('button', { type: 'button', text: 'Chart', 'aria-pressed': 'true' });
  const bTable = el('button', { type: 'button', text: 'Table', 'aria-pressed': 'false' });
  toggle.append(bChart, bTable);
  foot.append(toggle);

  let showTable = false;
  const setMode = (table) => {
    showTable = table;
    bChart.setAttribute('aria-pressed', String(!table));
    bTable.setAttribute('aria-pressed', String(table));
    plotWrap.hidden = table;
    tableWrap.hidden = !table;
    hideTip();
    if (table && !tableWrap.childElementCount) tableWrap.append(buildTable(spec, tableSeries, format));
  };
  bChart.addEventListener('click', () => setMode(false));
  bTable.addEventListener('click', () => setMode(true));

  host.append(plotWrap, tableWrap, live, foot);

  const drawSpec = { ...spec, series };
  /* Columns grow from the baseline once, on first paint. A redraw is a resize,
     not an arrival, and re-running the animation means every chart on the page
     is momentarily empty whenever the window changes width — which reads as a
     panel with no data in it rather than as motion. */
  let drawn = false;
  const draw = () => {
    const width = plotWrap.clientWidth;
    if (!width) return;
    clear(plotWrap);
    /* Scroll only when the drawing is actually wider than the box.
       `.fig-plot` used to carry `overflow-x: auto` permanently, on every chart,
       including a seven-column week that could never need it — and because the
       rule also sets `overflow-y: hidden`, CSS promotes the other axis away
       from `visible`, so the element is a scroll container whether or not it
       has anything to scroll. Anything painting a pixel past the edge — a
       direct label centred on the last column, a rounding difference in a
       resize — then gets a scrollbar under a chart that fits. */
    const svg = spec.type === 'line'
      ? drawLine(drawSpec, width, format, formatShort, live)
      : drawColumns({ ...drawSpec, animate: !drawn }, width, format, formatShort);
    plotWrap.append(svg);
    /* `scroll` alongside `is-wide`: that class is how the rest of the app —
       and the audit — marks a container that scrolls deliberately, so a chart
       that genuinely needs it keeps the exemption while one that fits no
       longer claims it. */
    const wide = svg.clientWidth > plotWrap.clientWidth + 1;
    plotWrap.classList.toggle('is-wide', wide);
    plotWrap.classList.toggle('scroll', wide);
    /* A chart of nights opens on the latest night, not the oldest: the right
       edge is where today is and where the reference tags sit. Re-applied on
       every redraw, because a resize rebuilds the SVG and would otherwise
       leave the scroll at the left. */
    if (wide && spec.openAtEnd) plotWrap.scrollLeft = plotWrap.scrollWidth;
    drawn = true;
  };

  draw();

  let lastW = plotWrap.clientWidth;
  let raf = 0;
  const ro = new ResizeObserver(() => {
    const w = plotWrap.clientWidth;
    if (Math.abs(w - lastW) < 3) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (!showTable) draw(); });
  });
  ro.observe(plotWrap);

  return { destroy() { ro.disconnect(); }, redraw: draw };
}

function buildTable(spec, series, format) {
  /* No Total column on a grouped figure: the two series are not parts of one
     quantity, so their sum is a number that means nothing. Nor on a figure
     whose second series is the raw dots behind a smoothed line — a run's pace
     added to the mean of the last three printed "11:56/km" as a total. */
  const multi = series.length > 1 && spec.layout !== 'grouped'
    && !series.some((s) => s.mode === 'dots');
  const table = el('table');
  const head = el('tr', {}, [el('th', { scope: 'col', text: spec.periodLabel || 'Period' })]);
  for (const s of series) head.append(el('th', { scope: 'col', class: 'num', text: s.label }));
  if (multi) head.append(el('th', { scope: 'col', class: 'num', text: 'Total' }));
  table.append(el('thead', {}, [head]));

  const body = el('tbody');
  for (const p of spec.points) {
    const row = el('tr', { class: p.empty ? 'is-empty' : null },
                 [el('th', { scope: 'row', text: p.label })]);
    let total = 0;
    for (const s of series) {
      const v = Number(p.values?.[s.key] ?? 0);
      total += v;
      /* An `empty` point is a period with no data, not a period measuring nil.
         The chart already draws nothing for one; printing "0 / 100" here would
         give the table and the chart two different answers about the same
         week, which is the one thing a table view exists to prevent. */
      row.append(el('td', { class: 'num',
        text: p.empty || p.values?.[s.key] == null ? '—' : format(v) }));
    }
    if (multi) {
      row.append(el('td', { class: 'num',
        text: p.empty ? '—' : format(p.total ?? total) }));
    }
    body.append(row);
  }
  table.append(body);
  return table;
}

/* ── stacked / single columns ────────────────────────────────────────────── */

function drawColumns(spec, width, format, formatShort) {
  const points = spec.points;
  const series = spec.series;
  const n = points.length;

  /* Grouped columns are for two series that are not parts of a whole — goals
     for against goals against. Stacking those invents a total nobody asked
     for; side by side, the comparison is the mark. */
  const grouped = spec.layout === 'grouped' && series.length > 1;

  const totals = points.map((p) =>
    p.total != null ? p.total : series.reduce((a, s) => a + Number(p.values?.[s.key] ?? 0), 0));
  /* What the axis has to hold, and what a direct label reports: the stack
     total when stacked, the tallest single bar when grouped. */
  const heads = grouped
    ? points.map((p) => Math.max(...series.map((s) => Number(p.values?.[s.key] ?? 0)), 0))
    : totals;
  /* The axis has to hold the reference marks too, or a sleep need of 7.8 h
     would float above a chart whose tallest night was 7.5. `yMax` pins it
     outright for scores that are out of 100. */
  const refTop = Math.max(
    0,
    ...(spec.bands || []).map((b) => Number(b.to) || 0),
    ...(spec.guides || []).map((g) => Number(g.value) || 0),
  );
  const { max, ticks } = spec.yMax
    ? { max: spec.yMax, ticks: niceScale(spec.yMax).ticks.filter((t) => t <= spec.yMax) }
    : niceScale(Math.max(...heads, refTop, 0));

  const tickTexts = ticks.map(formatShort);
  const padL = spec.padLeft || Math.max(30, 10 + Math.max(...tickTexts.map((t) => t.length)) * 6.4);
  const padR = Math.max(spec.padRight || 10, refGutter(spec, width));
  const padT = 20;
  const starts = groupStarts(points, spec);
  const hasGroups = !spec.hideAxis && starts.length > 1;
  const padB = spec.hideAxis ? 10 : 26 + (hasGroups ? GROUP_ROW : 0);

  const minSlot = spec.minSlot || 11;
  let plotW = Math.max(60, width - padL - padR);
  let svgW = width;
  if (plotW / n < minSlot) {
    plotW = n * minSlot;
    svgW = plotW + padL + padR;
  }
  const height = spec.height || 240;
  const plotH = height - padT - padB;

  const y = (v) => padT + plotH - (v / max) * plotH;
  const slot = plotW / n;
  /* Mark width. A flat 24px cap is right for a dense chart — 52 weeks of load
     would otherwise become slabs — but wrong for a sparse one: thirteen months
     on a 1200px plot puts a 24px bar in a 95px slot, which the eye reads as a
     tick on an empty panel rather than as data. So the cap breathes with the
     slot and only ever grows; anything already dense is untouched. */
  const cap = Math.min(spec.maxBar || 44, Math.max(24, slot * 0.62));
  const barW = Math.max(2.5, Math.min(cap, slot - Math.min(6, slot * 0.28)));
  const subGap = grouped ? Math.min(3, barW * 0.06) : 0;
  const subW = grouped
    ? Math.max(2, (barW - subGap * (series.length - 1)) / series.length)
    : barW;

  const animate = spec.animate !== false && !reducedMotion();
  const svg = el('svg', {
    class: `plot${animate ? ' is-anim' : ''}`,
    viewBox: `0 0 ${svgW} ${height}`, width: svgW, height,
    role: 'img', 'aria-label': spec.aria || 'Chart',
  });

  /* gridlines: hairline, solid, one step off the surface */
  for (const t of ticks) {
    svg.append(el('line', { class: t === 0 ? 'axis' : 'grid', x1: padL, x2: padL + plotW, y1: y(t), y2: y(t) }));
    svg.append(el('text', { class: 'tick', x: padL - 8, y: y(t) + 3.5, 'text-anchor': 'end', text: formatShort(t) }));
  }
  const refLabels = drawReference(svg, spec, { y, padL, plotW, clampLo: 0, clampHi: max, width });

  /* Selective direct labels: the extreme and the endpoint, never every column.
     A normalised chart opts out — every total is 100% and saying so twice is
     noise; its relief is the table view, which is always present. */
  const lastIdx = n - 1;
  const maxIdx = heads.indexOf(Math.max(...heads));

  /* `labels: 'all'` puts the figure over every column that has one. Worth it
     on a short chart — seven days of a week read as seven numbers, and having
     to hover for six of them is the opposite of natural — but it is opt-in
     because the same treatment over fifty-two weekly bars is a smear. Even
     when asked for, labels are thinned to whatever the slot width can hold,
     so the option degrades instead of overlapping. */
  const labelStep = Math.max(1, Math.ceil((n * 30) / plotW));
  /* Numbers over the columns, by default.
     The original rule labelled only the peak and the endpoint, on the grounds
     that a chart is a shape and the table view carries the figures. In use
     that means hovering for every value you actually want, which is the
     opposite of at-a-glance — so the default is now every column that has one,
     and the thinning below keeps a 52-week chart from turning into a smear:
     labels drop to whatever the slot width can hold, always keeping the peak
     and the endpoint. `labels: 'none'` still opts out, and normalised charts
     still use it — every column reading 100% is not information. */
  const labelled = spec.labels === 'none'
    ? new Set()
    : spec.labels === 'extremes'
      ? new Set([maxIdx, lastIdx].filter((i) => heads[i] > 0))
      : new Set(points
        .map((_, i) => i)
        .filter((i) => heads[i] > 0 && (i % labelStep === 0 || i === maxIdx || i === lastIdx)));

  const labelEvery = Math.max(1, Math.ceil((n * 44) / plotW));
  const surface = token('surface');

  points.forEach((p, i) => {
    const x0 = padL + i * slot;
    const x = x0 + (slot - barW) / 2;
    const total = totals[i];

    const g = el('g', { class: 'col' });

    g.append(el('rect', {
      class: 'band', x: x0, y: padT, width: slot, height: plotH, rx: 4,
    }));

    const present = series.filter((s) => Number(p.values?.[s.key] ?? 0) > 0);

    if (grouped) {
      /* Every bar starts at the baseline, in series order, so the pair reads
         left-to-right in the same order as the legend on every column. */
      series.forEach((s, si) => {
        const v = Number(p.values?.[s.key] ?? 0);
        if (!(v > 0)) return;
        const bx = x + si * (subW + subGap);
        const yTop = y(v);
        const shape = el('path', {
          class: 'seg',
          d: topRoundedPath(bx, yTop, subW, padT + plotH - yTop, Math.min(4, subW / 2)),
          fill: s.color,
        });
        if (animate) shape.style.animationDelay = `${Math.min(i * 12, 320)}ms`;
        g.append(shape);
      });
    } else {
      let acc = 0;
      present.forEach((s, si) => {
        const v = Number(p.values[s.key]);
        const yTop = y(acc + v);
        const yBot = y(acc);
        acc += v;
        const isTop = si === present.length - 1;
        let h = yBot - yTop;
        if (si > 0) h -= 2;             // the surface gap, cut out of the fill
        if (h < 1.2) h = 1.2;

        /* A point may carry its own colour for a series — `p.colors.v` — which
           is how a column chart shows which band each night fell in without
           a series per band. The legend then names the bands, not the series. */
        const fill = (p.colors && p.colors[s.key]) || s.color;
        const shape = isTop
          ? el('path', { class: 'seg', d: topRoundedPath(x, yTop, barW, h, 4), fill })
          : el('rect', { class: 'seg', x, y: yTop, width: barW, height: h, fill });
        if (animate) shape.style.animationDelay = `${Math.min(i * 12, 320)}ms`;
        g.append(shape);
      });
    }

    /* A period with nothing in it draws a hairline on the baseline, so a zero
       week is stated rather than left blank. A period that was never *covered*
       is different and draws nothing at all: the habits trend runs twelve
       weeks back over habits three days old, and eleven baseline ticks would
       read as eleven weeks of zero at something nobody was keeping. `empty`
       is the point saying "no data here", as against "the data here is nil". */
    if (!present.length && total === 0 && !p.empty) {
      g.append(el('rect', { class: 'zero', x, y: padT + plotH - 1.5, width: barW, height: 1.5 }));
    }

    if (labelled.has(i) && !p.empty) {
      /* The endpoint label is pulled inside the plot only when it is one of
         just two on the chart, where it sits hard against the edge. With every
         column labelled the run has to stay centred, or the last number steps
         out of line with the rest. */
      const anchor = spec.labels === 'extremes' && i === lastIdx && i > n - 2 ? 'end' : 'middle';
      g.append(el('text', {
        class: 'dlabel',
        x: anchor === 'end' ? Math.min(x + barW, padL + plotW) : x + barW / 2,
        y: Math.max(10, y(heads[i]) - 7),
        'text-anchor': anchor, text: formatShort(heads[i]),
      }));
    }

    if (!spec.hideAxis && (i % labelEvery === 0 || i === lastIdx)) {
      g.append(el('text', {
        class: 'tick', x: x + barW / 2, y: height - 9 - (hasGroups ? GROUP_ROW : 0),
        'text-anchor': 'middle', text: p.label,
      }));
    }
    if (hasGroups && starts.includes(i)) {
      g.append(el('line', { class: 'grid-group', x1: x, x2: x, y1: height - 9 - GROUP_ROW - 8, y2: height - 4 }));
      g.append(el('text', {
        class: 'tick tick-group', x: x + 4, y: height - 5, 'text-anchor': 'start', text: String(p.group),
      }));
    }

    /* One tooltip per column, listing every series — and the hit target is the
       whole slot, not the 3px bar. */
    /* Stacked segments are listed top-down so the tooltip matches the mark;
       a grouped pair is listed in legend order, which is how it is drawn. */
    const rows = () => (grouped ? present : present.slice().reverse())
      .map((s) => [s.label, format(Number(p.values[s.key])), s.color]);
    const each = present.map((s) => `${s.label} ${format(Number(p.values[s.key]))}`).join(', ');
    const hit = el('rect', {
      class: 'hit', x: x0, y: padT, width: slot, height: plotH,
      tabindex: '0', role: 'img',
      'aria-label': grouped
        ? `${p.label}: ${each || 'nothing'}${spec.unit ? ` ${spec.unit}` : ''}`
        : `${p.label}: ${format(total)}${spec.unit ? ` ${spec.unit}` : ''}${
          present.length > 1 ? `. ${each}` : ''}`,
    });
    attachTip(hit, () => ({
      title: p.label,
      /* A grouped pair has no total worth printing — the whole point is that
         the two series are not parts of one quantity. */
      rows: [...rows(), !grouped && series.length > 1
        ? ['Total', `${format(total)}${spec.unit ? ` ${spec.unit}` : ''}`] : null]
        .filter(Boolean),
      note: p.note || null,
    }));
    g.append(hit);
    svg.append(g);
  });

  svg.dataset.surface = surface;
  svg.append(...refLabels);
  return svg;
}

/* ── lines ───────────────────────────────────────────────────────────────── */

function drawLine(spec, width, format, formatShort, live) {
  const points = spec.points;
  const series = spec.series;
  const n = points.length;

  const all = [];
  for (const p of points) for (const s of series) {
    const v = p.values?.[s.key];
    if (v != null && Number.isFinite(Number(v))) all.push(Number(v));
  }
  if (!all.length) {
    const svg = el('svg', { class: 'plot', viewBox: '0 0 10 10', role: 'img', 'aria-label': spec.aria || '' });
    return svg;
  }

  for (const b of spec.bands || []) { if (Number.isFinite(b.from)) all.push(b.from); if (Number.isFinite(b.to)) all.push(b.to); }
  for (const g of spec.guides || []) { if (Number.isFinite(g.value)) all.push(g.value); }
  const band = spec.zeroBase
    ? (() => { const s = niceScale(Math.max(...all)); return { min: 0, max: s.max, ticks: s.ticks }; })()
    : niceBand(Math.min(...all), Math.max(...all));

  const tickTexts = band.ticks.map(formatShort);
  /* padLeft can be forced so two stacked figures share an x origin exactly —
     that is what makes a small multiple readable instead of merely adjacent. */
  const padL = spec.padLeft || Math.max(30, 10 + Math.max(...tickTexts.map((t) => t.length)) * 6.4);
  const padR = Math.max(spec.padRight || 12, refGutter(spec, width));
  const padT = 16;
  const starts = groupStarts(points, spec);
  const hasGroups = !spec.hideAxis && starts.length > 1;
  const padB = spec.hideAxis ? 8 : 24 + (hasGroups ? GROUP_ROW : 0);
  const height = spec.height || 220;
  const plotW = Math.max(60, width - padL - padR);
  const plotH = height - padT - padB;

  const x = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - band.min) / (band.max - band.min || 1)) * plotH;

  const svg = el('svg', {
    class: 'plot', viewBox: `0 0 ${width} ${height}`, width, height,
    role: 'img', 'aria-label': spec.aria || 'Chart',
  });

  for (const t of band.ticks) {
    svg.append(el('line', { class: 'grid', x1: padL, x2: padL + plotW, y1: y(t), y2: y(t) }));
    svg.append(el('text', { class: 'tick', x: padL - 8, y: y(t) + 3.5, 'text-anchor': 'end', text: formatShort(t) }));
  }
  const refLabels = drawReference(svg, spec, { y, padL, plotW, clampLo: band.min, clampHi: band.max, width });

  if (!spec.hideAxis) {
    const labelEvery = Math.max(1, Math.ceil((n * 62) / plotW));
    points.forEach((p, i) => {
      if (i % labelEvery && i !== n - 1) return;
      /* The endpoint is always labelled, so a regular label that lands within
         one step of it is dropped: fourteen runs on a phone put "Oct 2" and
         "Oct 19" on top of each other and the axis read "Oct 2 9". */
      if (i !== n - 1 && n - 1 - i < labelEvery) return;
      svg.append(el('text', {
        class: 'tick', x: x(i), y: height - 8 - (hasGroups ? GROUP_ROW : 0),
        'text-anchor': i === n - 1 ? 'end' : 'middle', text: p.label,
      }));
    });
    /* The group row: a short rule where each group begins, and its name. */
    if (hasGroups) {
      for (const i of starts) {
        svg.append(el('line', {
          class: 'grid-group', x1: x(i), x2: x(i), y1: padT + plotH, y2: height - 4,
        }));
        svg.append(el('text', {
          class: 'tick tick-group', x: x(i) + 4, y: height - 5, 'text-anchor': 'start',
          text: String(points[i].group),
        }));
      }
    }
  }

  /* A named break in the x axis — "today", where the record stops and the
     projection starts. Drawn under the lines so it never reads as data, but
     labelled, because an unlabelled rule on a chart is a mystery. */
  if (spec.divider && spec.divider.index != null) {
    const dx = x(Math.max(0, Math.min(n - 1, spec.divider.index)));
    svg.append(el('line', {
      class: 'divider', x1: dx, x2: dx, y1: padT - 4, y2: padT + plotH,
    }));
    if (spec.divider.label) {
      svg.append(el('text', {
        class: 'divider-l', x: dx + 5, y: padT + 4, 'text-anchor': 'start',
        text: spec.divider.label,
      }));
    }
  }

  const cross = el('line', { class: 'cross', x1: 0, x2: 0, y1: padT, y2: padT + plotH, opacity: 0 });
  svg.append(cross);

  const marks = [];
  series.forEach((s) => {
    /* A 'dots' series is the raw observation behind a smoothed line: drawn as
       small ringed points, never joined, so it never reads as a second trend. */
    if (s.mode === 'dots') {
      points.forEach((p, i) => {
        const v = p.values?.[s.key];
        if (v == null || !Number.isFinite(Number(v))) return;
        svg.append(el('circle', {
          class: 'rawdot', cx: x(i), cy: y(Number(v)), r: 2.6, fill: s.color,
        }));
      });
      marks.push(null);
      return;
    }

    const seg = [];
    let run = [];
    points.forEach((p, i) => {
      const v = p.values?.[s.key];
      if (v == null || !Number.isFinite(Number(v))) { if (run.length) seg.push(run); run = []; return; }
      run.push([x(i), y(Number(v))]);
    });
    if (run.length) seg.push(run);
    if (!seg.length) { marks.push(null); return; }

    const d = seg.map((r) => r.map(([px, py], j) => `${j ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('')).join(' ');

    if (series.length === 1 && seg.length === 1) {
      const r = seg[0];
      svg.append(el('path', {
        class: 'area', fill: s.color,
        d: `${d}L${r[r.length - 1][0].toFixed(1)},${padT + plotH}L${r[0][0].toFixed(1)},${padT + plotH}Z`,
      }));
    }
    svg.append(el('path', { class: 'line', d, stroke: s.color, 'stroke-dasharray': s.dashed ? '4 4' : null }));

    /* `markers: true` rings every recorded value. For a sparse series of
       individual runs the points are the data and the line only joins them,
       so each one is shown rather than left to the crosshair to find. */
    if (spec.markers) {
      for (const r of seg) {
        for (const [px, py] of r) {
          svg.append(el('circle', { class: 'pt', cx: px, cy: py, r: 3.2, fill: s.color }));
        }
      }
    }

    const lastRun = seg[seg.length - 1];
    const [ex, ey] = lastRun[lastRun.length - 1];
    svg.append(el('circle', { class: 'end', cx: ex, cy: ey, r: 4, fill: s.color }));
    marks.push(el('circle', { class: 'focusdot', cx: 0, cy: 0, r: 4.5, fill: s.color, opacity: 0 }));
  });
  /* Deliberate points, marked as such. A planned down week is a decision, not
     a dip, so it gets its own mark — a hollow square, ringed in the surface
     colour, plainly a different object from the round data points — and it is
     named in the legend and in the tooltip. Shape, not colour. */
  points.forEach((p, i) => {
    if (!p.mark) return;
    const s = series.find((ss) => ss.key === p.mark.key) || series[0];
    const v = p.values?.[p.mark.key ?? s.key];
    if (v == null || !Number.isFinite(Number(v))) return;
    /* A star is the one celebratory mark in the app — the best run at a
       distance. Drawn last so it sits over the line, in its own gold rather
       than the series colour, and large enough to be a mark and not a dot. */
    if (p.mark.shape === 'star') {
      svg.append(el('path', {
        class: 'markstar', d: starPath(x(i), y(Number(v)), 7.5, 3.4),
      }));
      return;
    }
    svg.append(el('rect', {
      class: 'markpt', x: x(i) - 4.5, y: y(Number(v)) - 4.5, width: 9, height: 9, rx: 2,
      stroke: s.color,
    }));
  });

  marks.forEach((m) => m && svg.append(m));

  /* Direct labels: the endpoint always, and the two extremes when asked. Three
     labels on a long series is the most that stays readable. */
  const lastPoint = points[n - 1];
  const lead = series.find((s) => s.mode !== 'dots') || series[0];
  const leadVals = points.map((p) => {
    const v = p.values?.[lead.key];
    return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  });

  const putLabelAt = (i, key, text, dy = -9, cls = null) => {
    const raw = points[i]?.values?.[key];
    if (raw == null || !Number.isFinite(Number(raw))) return;
    const anchor = i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle';
    svg.append(el('text', {
      class: `dlabel${cls ? ` ${cls}` : ''}`,
      x: Math.max(padL, Math.min(x(i) + (anchor === 'end' ? 8 : 0), width - 2)),
      y: Math.max(10, y(Number(raw)) + dy), 'text-anchor': anchor, text,
    }));
  };
  const putLabel = (i, text, dy = -9) => putLabelAt(i, lead.key, text, dy);

  /* `labels: 'all'` prints the figure over every point, thinned to what the
     slot width can hold — the same rule as columns — always keeping the
     endpoint, and letting a caller's `labelPoints` replace the text at an
     index rather than print a second label beside it. Asked for by the
     reader of the pace figure: the numbers, not only the shape. */
  const allLabelled = new Set();
  if (spec.labels === 'all' && n > 0) {
    const step = Math.max(1, Math.ceil((n * 44) / plotW));
    const custom = new Set((spec.labelPoints || []).map((lp) => lp && lp.index));
    for (let i = 0; i < n; i += 1) {
      if (leadVals[i] == null) continue;
      if (i !== n - 1 && !custom.has(i) && (i % step || n - 1 - i < step)) continue;
      allLabelled.add(i);
      if (!custom.has(i)) putLabel(i, formatShort(leadVals[i]));
    }
  }

  if (spec.annotate === 'extremes' && leadVals.some((v) => v != null)) {
    const valid = leadVals.map((v, i) => [v, i]).filter(([v]) => v != null);
    const hi = valid.reduce((a, b) => (b[0] > a[0] ? b : a));
    const lo = valid.reduce((a, b) => (b[0] < a[0] ? b : a));
    if (hi[1] !== n - 1) putLabel(hi[1], format(hi[0]), -10);
    if (lo[1] !== n - 1 && lo[1] !== hi[1]) putLabel(lo[1], format(lo[0]), 16);
  }
  if (lead && leadVals[n - 1] != null && !allLabelled.size) putLabel(n - 1, format(leadVals[n - 1]));

  /* Caller-chosen direct labels, for a figure where the point worth naming is
     not the extreme of the lead series — the peak of a projection drawn behind
     eight weeks of history, for one. */
  for (const lp of spec.labelPoints || []) {
    if (lp && lp.index != null) putLabelAt(lp.index, lp.key || lead.key, lp.text, lp.dy, lp.cls);
  }

  /* crosshair layer: pointer + keyboard, same readout */
  const overlay = el('rect', {
    class: 'hit', x: padL, y: padT, width: plotW, height: plotH,
    tabindex: '0', role: 'img',
    'aria-label': `${spec.aria || 'Series'}. ${n} points from ${points[0].label} to ${lastPoint.label}. Use arrow keys to step through values.`,
  });

  let idx = n - 1;
  const place = (i, clientX, clientY) => {
    idx = Math.max(0, Math.min(n - 1, i));
    const p = points[idx];
    const px = x(idx);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('opacity', 1);
    series.forEach((s, si) => {
      const v = p.values?.[s.key];
      const dot = marks[si];
      if (!dot) return;
      if (v == null) { dot.setAttribute('opacity', 0); return; }
      dot.setAttribute('cx', px);
      dot.setAttribute('cy', y(Number(v)));
      dot.setAttribute('opacity', 1);
    });
    if (spec.onMove) spec.onMove(idx, p);
    const rows = series
      .filter((s) => p.values?.[s.key] != null)
      .map((s) => [s.label, `${format(Number(p.values[s.key]))}${spec.unit ? ` ${spec.unit}` : ''}`, s.color]);
    const box = overlay.getBoundingClientRect();
    showTip(
      clientX ?? box.left + (box.width * (idx / Math.max(1, n - 1))),
      clientY ?? box.top,
      { title: p.label, rows, note: p.note || null },
    );
    if (live) live.textContent = `${p.label}: ${rows.map(([l, v2]) => `${l} ${v2}`).join(', ')}`;
  };

  overlay.addEventListener('pointermove', (e) => {
    const box = overlay.getBoundingClientRect();
    const frac = (e.clientX - box.left) / (box.width || 1);
    place(Math.round(frac * (n - 1)), e.clientX, e.clientY);
  });
  overlay.addEventListener('pointerleave', () => {
    cross.setAttribute('opacity', 0);
    marks.forEach((m) => m && m.setAttribute('opacity', 0));
    hideTip();
  });
  overlay.addEventListener('focus', () => place(idx));
  overlay.addEventListener('blur', () => {
    cross.setAttribute('opacity', 0);
    marks.forEach((m) => m && m.setAttribute('opacity', 0));
    hideTip();
  });
  overlay.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1
      : e.key === 'Home' ? -n : e.key === 'End' ? n : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    place(idx + step);
  });
  svg.append(overlay);

  svg.append(...refLabels);
  return svg;
}

/** A five-point star centred on (cx, cy): outer radius ro, inner ri. */
function starPath(cx, cy, ro, ri) {
  const pts = [];
  for (let k = 0; k < 10; k += 1) {
    const r = k % 2 ? ri : ro;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return `M${pts.join('L')}Z`;
}

/* ── 100% split bar ──────────────────────────────────────────────────────── */

/**
 * The signature mark: one week's load, split by modality, on a single bar.
 * parts = [{key, label, value, color}]
 */
export function splitBar(host, { parts, total, unit = 'AU', format = fmt.int, emptyText }) {
  clear(host);
  const sum = total ?? parts.reduce((a, p) => a + p.value, 0);
  if (!sum) {
    host.append(el('p', { class: 'empty', text: emptyText || 'Nothing scored this week.' }));
    return;
  }

  const bar = el('div', { class: 'splitbar', role: 'img',
    'aria-label': parts.map((p) => `${p.label} ${Math.round((p.value / sum) * 100)}%`).join(', ') });

  parts.forEach((p) => {
    const pctv = (p.value / sum) * 100;
    const seg = el('div', {
      class: 'splitseg', style: `flex:${p.value};background:${p.color}`,
      tabindex: '0',
    });
    /* Only label a segment that can actually hold the text, and only in a
       colour that can actually be read on it — a clipped or a 3:1 label is
       worse than none, and the key below carries every value anyway. */
    const ink = onColor(p.color);
    if (pctv >= 12 && ink) {
      seg.append(el('span', { text: `${Math.round(pctv)}%` }));
      seg.style.color = ink;
    }
    attachTip(seg, () => ({
      title: p.label, swatch: p.color,
      rows: [['Load', `${format(p.value)} ${unit}`], ['Share', `${Math.round(pctv)}%`]],
    }));
    bar.append(seg);
  });
  host.append(bar);

  const key = el('ul', { class: 'splitkey' });
  parts.forEach((p) => {
    key.append(el('li', {}, [
      el('i', { style: `background:${p.color}` }),
      el('span', { text: p.label }),
      el('b', { class: 'num', text: `${Math.round((p.value / sum) * 100)}%` }),
      el('span', { class: 'muted num', text: `${format(p.value)}${unit ? ` ${unit}` : ''}` }),
    ]));
  });
  host.append(key);
}

/**
 * A label colour for text set inside a coloured fill — or null, meaning the
 * fill cannot carry text at all and the caller should not print any.
 *
 * This is the one place in the app where text sits on a series colour, and it
 * used to pick ink or white off a luminance threshold, which is not the same
 * question as "can this be read": a 0.42 cut put white on run-orange at
 * 3.2:1 and on lift-yellow at 2.2:1. So the ratio is measured against each
 * candidate and the best one wins, with the label dropped outright when even
 * the best is under 4.5:1. Nothing is lost by dropping it — the key beneath
 * the bar prints every value and every share.
 */
function relLum(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return 0;
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : (((v / 255) + 0.055) / 1.055) ** 2.4));
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function onColor(hex) {
  const bg = relLum(hex);
  const ratio = (fg) => {
    const a = relLum(fg);
    return (Math.max(a, bg) + 0.05) / (Math.min(a, bg) + 0.05);
  };
  const best = ['#0b0b0b', '#ffffff', '#000000']
    .map((c) => [c, ratio(c)])
    .reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] >= 4.5 ? best[0] : null;
}

/* ── sparkline ───────────────────────────────────────────────────────────── */

export function sparkline(host, values, { color, height = 44, label = '' } = {}) {
  clear(host);
  const vals = values.filter((v) => v != null && Number.isFinite(v));
  if (vals.length < 3) return;

  const W = 320;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const stroke = color || token('k-soccer');
  const x = (i) => (i / (vals.length - 1)) * W;
  const y = (v) => height - 5 - ((v - lo) / span) * (height - 12);

  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const svg = el('svg', {
    class: 'plot spark', viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': label,
  }, [
    el('path', { class: 'area', d: `${d}L${W},${height}L0,${height}Z`, fill: stroke }),
    el('path', { class: 'line', d, stroke, vectorEffect: 'non-scaling-stroke' }),
  ]);
  host.append(svg);

  const dot = el('span', { class: 'spark-dot', style: `background:${stroke}` });
  host.append(dot);
}

/* ── day grid (sequential, one hue) ──────────────────────────────────────── */

/**
 * A Mon–Sun column grid for one calendar year. Magnitude, so: one hue,
 * light → dark, with a scale legend rendered by the caller.
 */
/**
 * One cell per day. By default a day is its activity count from `counts`
 * (indexed from `start`), on four steps. Pass `cell(iso)` to colour the grid
 * by something else — a night's sleep, say — returning
 * `{ level: 0–4, rows: [[label, value]], note, aria }`; `hue` recolours the
 * sequential ramp for that grid alone.
 */
export function dayGrid(host, { start, counts, year, from, to, today, cell = null, hue = null, what = 'Activity' }) {
  clear(host);
  const wrap = el('div', { class: 'cal-wrap scroll', style: hue ? `--seq:${hue}` : null });
  const scroller = el('div', { class: 'cal-scroll' });
  /* A Mon/Wed/Fri rail down the left, because which weekday a mark sits on is
     the whole story on a page about fixtures. */
  const rail = el('div', { class: 'cal-rail', 'aria-hidden': 'true' });
  for (const d of ['Mon', '', 'Wed', '', 'Fri', '', 'Sun']) rail.append(el('div', { text: d }));
  const months = el('div', { class: 'cal-months' });
  const cal = el('div', { class: 'cal', role: 'img',
    'aria-label': `${what} calendar for ${year}` });

  const startD = new Date(`${start}T00:00:00`);
  const fromD = new Date(`${from}T00:00:00`);
  const toD = new Date(`${to}T00:00:00`);

  const pad = (fromD.getDay() + 6) % 7;
  for (let i = 0; i < pad; i++) cal.append(el('div', { class: 'cal-pad' }));

  let lastMonth = null;
  let i = 0;
  for (const day = new Date(fromD); day <= toD; day.setDate(day.getDate() + 1), i++) {
    const p2 = (x) => String(x).padStart(2, '0');
    const iso = `${day.getFullYear()}-${p2(day.getMonth() + 1)}-${p2(day.getDate())}`;
    const idx = Math.round((day - startD) / 86400000);
    const n = counts[idx] ?? 0;
    const own = cell ? cell(iso) : null;
    const level = own ? own.level : (n === 0 ? 0 : Math.min(4, n));
    const has = own ? own.level > 0 : n > 0;

    const node = el('div', {
      class: 'cal-day', 'data-n': level, tabindex: has ? '0' : null,
      role: has ? 'img' : null,
      'aria-label': has ? (own ? `${iso}, ${own.aria}` : `${iso}, ${n} ${n === 1 ? 'activity' : 'activities'}`) : null,
    });
    attachTip(node, () => ({
      title: `${fmt.weekday(iso)}, ${fmt.dateY(iso)}`,
      rows: own ? own.rows : [['Activities', n]],
      note: own ? own.note : (n ? null : (iso > today ? 'ahead of today' : 'nothing logged')),
    }));
    cal.append(node);

    if ((i + pad) % 7 === 0) {
      const m = iso.slice(0, 7);
      months.append(el('div', { text: m !== lastMonth ? fmt.month(iso) : '' }));
      lastMonth = m;
    }
  }

  scroller.append(months, cal);
  wrap.append(rail, scroller);
  host.append(wrap);
}

export function gridScale({ lo = 'none', hi = '4+ a day', hue = null } = {}) {
  const scale = el('div', { class: 'cal-scale', style: hue ? `--seq:${hue}` : null }, [el('span', { text: lo })]);
  for (const n of [0, 1, 2, 3, 4]) scale.append(el('i', { 'data-n': n }));
  scale.append(el('span', { text: hi }));
  return scale;
}
