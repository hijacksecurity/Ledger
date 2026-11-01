/* Lifting — the honest version.
 *
 * The brief assumed a barbell log. Eighty-four weeks of notebook contain no
 * weight×reps at all: lifting is recorded as a scope ("work lift", "small home
 * lift") plus, occasionally, a bare rep series. So this page reports scope,
 * frequency, duration and RPE, states plainly that there is no e1RM to compute,
 * and does not fabricate a strength metric out of session counts.
 *
 * It also states the layoff. Someone reading this page after an injury
 * wants the record, not encouragement — so the gap is a number and a date, and
 * there is a place to write down what the constraint is.
 */

import {
  el, icon, clear, api, qs, busy, fmt, colorOf, stepTowardInk, todayISO, toast,
} from './core.js';
import {
  panel, panelError, statStrip, segmented, emptyNote, skeletonBlock, readout,
  sportTabs, RANGE_PRESETS, resolveRange, dowBadge, sectionRule, collapsible,
  setTimeframe,
} from './ui.js';
import { figure, splitBar } from './charts.js';
import {
  sessionsIn, liftCategory, liftLabel, repSeries, liftReadout, byWeekday, meanRpe,
} from './dataset.js';

const CONSTRAINT_KEY = 'ledger.constraint';

const readConstraint = () => {
  try { return localStorage.getItem(CONSTRAINT_KEY) || ''; } catch { return ''; }
};
const writeConstraint = (v) => {
  try { if (v) localStorage.setItem(CONSTRAINT_KEY, v); else localStorage.removeItem(CONSTRAINT_KEY); return true; } catch { return false; }
};

export function mount(host, route, { setQuery }) {
  const state = { range: route.query.get('range') || 'all' };
  let figs = [];
  let alive = true;
  let seq = 0;

  const filters = el('div', { class: 'filterbar' });
  const pGap = panel({ title: 'Where this stands', sub: ' ', wide: true, accent: 'lift' });
  const statsHost = el('div', { class: 'strip-host' });
  const pFreq = panel({ title: 'Sessions over time', sub: ' ', wide: true, accent: 'lift' });
  const pScope = panel({ title: 'Scope', sub: 'what kind of session, as written in the note', accent: 'lift' });
  const pRhythm = panel({ title: 'When', sub: 'lifting sessions by day of week', accent: 'lift' });
  const pReps = panel({ title: 'Rep series', sub: ' ', accent: 'lift' });
  const pRead = panel({ title: 'Read-out', sub: 'stated plainly, including the gaps', accent: 'lift' });
  const pLog = panel({ title: 'Every session', sub: ' ', wide: true, accent: 'lift' });

  host.append(
    sportTabs('lifting'), filters, pGap, statsHost,
    sectionRule('Frequency'),
    pFreq,
    sectionRule('What kind'),
    el('div', { class: 'grid-2' }, [pScope, pRhythm]),
    sectionRule('Detail'),
    el('div', { class: 'grid-2' }, [pReps, pRead]),
    pLog,
  );
  skeletonBlock(120, pGap.body);
  skeletonBlock(96, statsHost);
  skeletonBlock(240, pFreq.body);
  skeletonBlock(200, pScope.body);
  skeletonBlock(200, pRhythm.body);
  skeletonBlock(140, pReps.body);
  skeletonBlock(160, pRead.body);
  skeletonBlock(240, pLog.body);

  function buildFilters() {
    clear(filters);
    filters.append(el('div', { class: 'filter' }, [
      el('span', { class: 'lbl', text: 'Range' }),
      segmented(RANGE_PRESETS, state.range, (v) => {
        state.range = v; setQuery({ range: v }); buildFilters(); load();
      }, 'Date range'),
    ]));
  }

  async function load() {
    const mine = ++seq;
    const { from, to } = resolveRange(state.range);
    busy(true);
    const trend = await api(`/api/trends${qs({ metric: 'count', grain: 'month', kind: 'lift', from, to })}`);
    const sess = await sessionsIn({ from, to, kind: 'lift' });
    busy(false);
    if (!alive || mine !== seq) return;
    if (!sess.ok) {
      panelError(pLog.body, sess.res, 'Lifting sessions');
      clear(pGap.body); clear(statsHost);
      return;
    }
    paint(trend.ok ? trend.data : null, sess.items, trend, sess.timeframe);
  }

  function paint(trend, lifts, trendRes, sessTf) {
    /* One window for the page. "Sessions over time" is bucketed by month and
       used to print its own "20 months to Aug 2026" beside six panels reading
       "most recent 65 sessions · 12 Mar 2025 to 12 Jun 2026" — two periods for
       one range control. The month grain is how that chart *draws* the range,
       not a different range; it is stated in the panel's subtitle instead. */
    for (const p of [pGap, pScope, pRhythm, pReps, pRead, pLog, pFreq]) {
      setTimeframe(p, sessTf);
    }
    figs.forEach((f) => f.destroy && f.destroy());
    figs = [];

    const today = todayISO();
    const sorted = lifts.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = sorted[sorted.length - 1] || null;
    const days = last ? Math.round((new Date(`${today}T00:00:00`) - new Date(`${last.date}T00:00:00`)) / 86400000) : null;

    /* ── the gap, and room to say why ── */
    clear(pGap.body);
    pGap.head.querySelector('.sub').textContent = last
      ? `Last lifting session ${fmt.dateY(last.date)}`
      : 'Nothing on record in this range';

    const gapWrap = el('div', { class: 'gapline' });
    if (last) {
      gapWrap.append(
        el('div', { class: 'gap-fig' }, [
          el('span', { class: 'gap-n', text: String(days) }),
          el('span', { class: 'gap-u', text: days === 1 ? 'day since' : 'days since' }),
        ]),
        el('p', { class: 'sub', text:
          `${last.notes || 'lifting session'} · ${fmt.mins(last.duration_min)}${last.rpe != null ? ` · RPE ${last.rpe}` : ''}. `
          + 'A gap is a fact about the record, not a score. Nothing here was lost by it.' }),
      );
    } else {
      gapWrap.append(el('p', { class: 'empty', text: 'No lifting in this range.' }));
    }
    pGap.body.append(gapWrap);

    const cInput = el('textarea', {
      class: 'input', id: 'lift-constraint', rows: '2',
      placeholder: 'e.g. knee — no running until cleared',
    });
    cInput.value = readConstraint();
    const cSave = el('button', { class: 'btn', type: 'button' }, [
      icon('check'), el('span', { text: 'Save note' }),
    ]);
    cSave.addEventListener('click', () => {
      const ok = writeConstraint(cInput.value.trim());
      toast(ok ? 'Note saved on this device.' : 'Could not save — storage unavailable.');
    });
    pGap.body.append(el('div', { class: 'notegrid' }, [
      el('div', { class: 'field field-wide' }, [
        el('label', { class: 'lbl', for: 'lift-constraint', text: 'Working around' }),
        cInput,
      ]),
      el('div', { class: 'field field-end' }, [cSave]),
    ]));
    pGap.body.append(el('p', { class: 'sub', text:
      'Kept on this device. There is no injury or availability table in the database — see NOTES-FOR-BACKEND.md. For anything you want in the record itself, use the week note.' }));

    /* ── stats ── */
    const minutes = lifts.reduce((a, s) => a + Number(s.duration_min || 0), 0);
    const load = lifts.reduce((a, s) => a + Number(s.load || 0), 0);
    const scoredCount = lifts.filter((s) => s.rpe != null).length;
    const wrpe = meanRpe(lifts);
    clear(statsHost);
    statsHost.append(statStrip([
      { label: 'Sessions', value: fmt.int(lifts.length), note: `in the selected range` },
      { label: 'Time', value: fmt.one(minutes / 60), unit: 'h', note: `${fmt.int(minutes)} minutes of lifting` },
      { label: 'Load', value: fmt.compact(load), unit: 'AU', note: 'training load' },
      {
        label: 'Mean RPE', value: wrpe == null ? '—' : fmt.one(wrpe),
        note: `time-weighted · ${scoredCount} of ${lifts.length} sessions scored`,
      },
    ]));

    /* ── frequency ── */
    clear(pFreq.body);
    pFreq.head.querySelector('.sub').textContent = 'Lifting sessions per month';
    if (!trend || !(trend.points || []).length) {
      if (trendRes && !trendRes.ok) panelError(pFreq.body, trendRes, 'Lifting frequency');
      else pFreq.body.append(emptyNote('No lifting in this range.'));
    } else {
      figs.push(figure(pFreq.body, {
        type: 'columns',
        aria: 'Lifting sessions per month',
        height: 230, unit: 'sessions', periodLabel: 'Month',
        series: [{ key: 'lift', label: 'Lift', color: colorOf('lift') }],
        points: trend.points.map((p) => ({
          key: p.period, label: fmt.monthYear(p.period),
          values: { lift: p.value }, total: p.value,
        })),
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
      }));
      const empty = trend.points.filter((p) => !p.value).length;
      if (empty) {
        pFreq.body.append(el('p', { class: 'sub', text:
          `${empty} of ${trend.points.length} months in this range recorded no lifting. Zero months are drawn, not skipped.` }));
      }
    }

    /* ── scope ── */
    clear(pScope.body);
    if (!lifts.length) {
      pScope.body.append(emptyNote('No lifting in this range.'));
    } else {
      const cats = {};
      for (const s of lifts) {
        const c = liftCategory(s);
        cats[c] = (cats[c] || 0) + 1;
      }
      const keys = Object.keys(cats).sort((a, b) => cats[b] - cats[a]);
      const base = colorOf('lift');
      splitBar(pScope.body, {
        parts: keys.map((k, i) => ({
          key: k, label: liftLabel(k), value: cats[k],
          color: i === 0 ? base : stepTowardInk(base, Math.min(0.6, 0.16 * i)),
        })),
        unit: '', format: (v) => `${fmt.int(v)} session${v === 1 ? '' : 's'}`,
        emptyText: 'No lifting in this range.',
      });
      pScope.body.append(el('p', { class: 'sub', text:
        'Read out of the session note. One hue, stepped — these are parts of one thing, not separate modalities.' }));
    }

    /* ── weekday ── */
    clear(pRhythm.body);
    if (!lifts.length) {
      pRhythm.body.append(emptyNote('No lifting in this range.'));
    } else {
      const wk = byWeekday(lifts);
      figs.push(figure(pRhythm.body, {
        type: 'columns',
        aria: 'Lifting sessions by day of the week',
        height: 210, unit: 'sessions', periodLabel: 'Day',
        series: [{ key: 'n', label: 'Sessions', color: colorOf('lift') }],
        points: wk.map((r) => ({
          key: r.key, label: r.label, values: { n: r.count }, total: r.count,
          note: r.minutes ? `${fmt.mins(r.minutes)} in total` : 'nothing logged',
        })),
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
        minSlot: 34,
      }));
    }

    /* ── rep series ── */
    clear(pReps.body);
    const reps = lifts.map((s) => ({ s, r: repSeries(s) })).filter((x) => x.r)
      .sort((a, b) => (a.s.date < b.s.date ? -1 : 1));
    pReps.head.querySelector('.sub').textContent =
      `${reps.length} of ${lifts.length} sessions wrote one down`;
    if (reps.length < 2) {
      pReps.body.append(emptyNote(
        'Almost nothing in this record counts reps. There is no weight×reps anywhere, so no e1RM is estimated and none is shown.',
      ));
    } else {
      figs.push(figure(pReps.body, {
        type: 'columns',
        aria: 'Total reps recorded per session',
        height: 180, unit: 'reps', periodLabel: 'Session',
        series: [{ key: 'reps', label: 'Reps', color: colorOf('lift') }],
        points: reps.map(({ s, r }) => ({
          key: String(s.id), label: fmt.date(s.date),
          values: { reps: r.reps }, total: r.reps,
          note: `${r.sets} sets · ${r.parts.join('/')}`,
        })),
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
        minSlot: 26,
      }));
    }

    /* ── read-out ── */
    clear(pRead.body);
    pRead.body.append(readout(liftReadout(lifts, today)));

    /* ── log ── */
    clear(pLog.body);
    pLog.head.querySelector('.sub').textContent = `${lifts.length} in this range, most recent first`;
    if (!lifts.length) {
      pLog.body.append(emptyNote('No lifting in this range.'));
    } else {
      pLog.body.append(collapsible(
        `Show all ${lifts.length} sessions`, liftTable(sorted.slice().reverse()),
      ));
    }
  }

  function liftTable(lifts) {
    const wrap = el('div', { class: 'table-wrap scroll' });
    const table = el('table', { class: 'data-table' });
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Day' }),
      el('th', { scope: 'col', text: 'Date' }),
      el('th', { scope: 'col', text: 'Scope' }),
      el('th', { scope: 'col', class: 'num', text: 'Time' }),
      el('th', { scope: 'col', class: 'num', text: 'RPE' }),
      el('th', { scope: 'col', class: 'num', text: 'Load' }),
      el('th', { scope: 'col', class: 'num', text: 'Reps' }),
      el('th', { scope: 'col', class: 'wrap', text: 'Note' }),
      el('th', { scope: 'col' }, [el('span', { class: 'sr', text: 'Edit' })]),
    ])]));
    const body = el('tbody');
    for (const s of lifts.slice(0, 300)) {
      const r = repSeries(s);
      body.append(el('tr', {}, [
        el('td', {}, [dowBadge(s.date)]),
        el('th', { scope: 'row', class: 'num nowrap', text: fmt.dateY(s.date) }),
        el('td', { text: liftLabel(liftCategory(s)) }),
        el('td', { class: 'num', text: s.duration_min ? fmt.mins(s.duration_min) : '—' }),
        el('td', { class: 'num', text: s.rpe == null ? '—' : String(s.rpe) }),
        el('td', { class: 'num', text: s.load ? fmt.int(s.load) : '—' }),
        el('td', { class: 'num', text: r ? `${fmt.int(r.reps)}` : '—' }),
        el('td', { class: 'wrap', text: s.notes || '' }),
        el('td', { class: 'num' }, [
          el('a', { class: 'btn btn-quiet btn-sm', href: `#/edit/${s.id}`, text: 'Edit',
            'aria-label': `Edit lifting session on ${fmt.dateY(s.date)}` }),
        ]),
      ]));
    }
    table.append(body);
    wrap.append(table);
    return wrap;
  }

  buildFilters();
  load();

  return { destroy() { alive = false; figs.forEach((f) => f.destroy && f.destroy()); }, refresh: load };
}
