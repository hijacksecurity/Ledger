/* Running — the second-biggest thing in the record and, until now, only ever
 * visible as an orange band inside the load chart.
 *
 * Everything here is distance, time and pace: the three things every run in the
 * notebook actually carries. Zone splits and coach compliance appear on a
 * minority of runs, so those panels state their own coverage rather than
 * implying the whole set.
 */

import {
  el, clear, api, qs, busy, fmt, colorOf, stepTowardInk, token, icon, KINDS, ON_FOOT, dateOf, todayISO,
} from './core.js';
import {
  panel, panelError, statStrip, segmented, emptyNote, skeletonBlock, readout,
  sportTabs, RANGE_PRESETS, resolveRange, dowBadge, kindName,
  sectionRule, collapsible, setTimeframe, setTools,
} from './ui.js';
import { figure, splitBar } from './charts.js';
import {
  sessionsIn, paceByPeriod, distanceHistogram, zoneSplit, runReadout, byWeekday,
  KEY_DISTANCES, distanceSummary, pacePoints, paceOf,
} from './dataset.js';

const DIST_KEY = 'ledger.running.dist';
const readDist = () => { try { return localStorage.getItem(DIST_KEY); } catch { return null; } };
const saveDist = (k) => { try { localStorage.setItem(DIST_KEY, k); } catch { /* private mode */ } };

export function mount(host, route, { setQuery }) {
  const state = {
    range: route.query.get('range') || '52w',
    grain: route.query.get('by') === 'week' ? 'week' : 'month',
    /* The URL first, then whatever was picked last time, then 5 km. A page
       change or a refresh drops the query, and coming back to find the panel
       reset to a distance you were not looking at is a small, repeated
       annoyance; the last choice is kept on the device the way plans are. */
    dist: [route.query.get('dist'), readDist(), '5k']
      .find((k) => KEY_DISTANCES.some((d) => d.key === k)),
  };
  let figs = [];
  let alive = true;
  let seq = 0;

  const filters = el('div', { class: 'filterbar' });
  const statsHost = el('div', { class: 'strip-host' });
  /* The one panel the Group-by control does not reach, and it says so in its
     own subtitle rather than leaving the reader to work out why it did not
     move. It is not a volume chart: it is the committed plan, and the plan is
     written in weeks. Grouping it by month would be reporting against a target
     that does not exist. */
  const pWow = panel({
    title: 'On foot, week over week', wide: true,
    sub: 'every kilometre on your legs, against the committed weekly target — always weekly, '
      + 'because the plan is',
    accent: 'run' });
  const pVolume = panel({ title: 'Distance', sub: ' ', wide: true, accent: 'run' });
  const pPace = panel({ title: 'Pace', sub: ' ', accent: 'run' });
  /* The question behind the training: am I getting faster at the distances I
     race. Every run near a key distance, plotted at the pace it was recorded
     at and nothing else — a rolling mean was drawn through the points once
     and removed by the user's rule: what was recorded is the number. Whole
     runs only: the record carries no splits, so a 5 km here is a run of about
     five kilometres, never the quickest five inside a longer one. */
  const pAtDist = panel({
    title: 'Pace by distance', wide: true,
    sub: ' ', accent: 'run',
  });
  const pSpread = panel({ title: 'How far', sub: 'runs by distance band', accent: 'run' });
  const pRhythm = panel({ title: 'When', sub: 'runs by day of week', accent: 'run' });
  const pQuality = panel({ title: 'To plan', sub: ' ', accent: 'run' });
  const pZones = panel({ title: 'Heart-rate zones', sub: ' ', accent: 'run' });
  const pRead = panel({ title: 'Read-out', sub: 'what this window says about the running', accent: 'run' });
  const pLog = panel({ title: 'Every run', sub: ' ', wide: true, accent: 'run' });

  host.append(
    sportTabs('running'), filters, statsHost,
    sectionRule('Load', 'is the ramp sane'),
    pWow, pVolume,
    sectionRule('Shape', 'how far, how fast, how often'),
    pAtDist,
    el('div', { class: 'grid-2' }, [pPace, pSpread]),
    el('div', { class: 'grid-2' }, [pRhythm, pQuality]),
    sectionRule('Detail'),
    el('div', { class: 'grid-2' }, [pZones, pRead]),
    pLog,
  );
  skeletonBlock(96, statsHost);
  skeletonBlock(420, pWow.body);
  skeletonBlock(260, pVolume.body);
  skeletonBlock(200, pPace.body);
  skeletonBlock(320, pAtDist.body);
  skeletonBlock(200, pSpread.body);
  skeletonBlock(200, pRhythm.body);
  skeletonBlock(120, pQuality.body);
  skeletonBlock(120, pZones.body);
  skeletonBlock(140, pRead.body);
  skeletonBlock(240, pLog.body);

  function buildFilters() {
    clear(filters);
    filters.append(
      el('div', { class: 'filter' }, [
        el('span', { class: 'lbl', text: 'Group by' }),
        segmented([['week', 'Week'], ['month', 'Month']], state.grain, (v) => {
          state.grain = v; setQuery({ by: v }); buildFilters(); load();
        }, 'Group time-based charts by week or month'),
      ]),
      el('div', { class: 'filter' }, [
        el('span', { class: 'lbl', text: 'Range' }),
        segmented(RANGE_PRESETS, state.range, (v) => {
          state.range = v; setQuery({ range: v }); buildFilters(); load();
        }, 'Date range'),
      ]),
    );
  }

  async function load() {
    const mine = ++seq;
    const { from, to } = resolveRange(state.range);
    busy(true);
    /* No `kind` filter: unfiltered, `/api/trends` returns `by_kind` per
       period, which is what lets this panel cover every kilometre on the legs
       rather than runs alone. A "Distance" panel on a page whose headline
       panel counts on-foot, showing only runs, is two definitions of distance
       one scroll apart. */
    const trend = await api(`/api/trends${qs({
      metric: 'distance', grain: state.grain, from, to,
    })}`);
    const sess = await sessionsIn({ from, to, kind: 'run' });
    /* On-foot distance and the next-week target are the server's arithmetic,
       not this page's. It used to be recomputed here from every session in the
       record — a second implementation that had already drifted. */
    const dist = await api('/api/distance?weeks=26');
    /* The committed plan, so the target on this page is the one that was
       actually agreed to. `/api/distance` publishes a rolling +10% suggestion
       computed from last week's *actual* distance; `/api/plan/locked` holds
       what was locked in for this week and never rewrites itself. They are
       different questions and they diverge the moment a week is missed — a
       short week drags the suggestion down while the plan stands still — so
       the panel showed 25.0 km beside a plan of 35.3 with nothing saying they
       were not the same quantity. */
    const plan = await api('/api/plan/locked');
    busy(false);
    if (!alive || mine !== seq) return;

    if (!sess.ok) {
      clear(statsHost);
      panelError(pLog.body, sess.res, 'Runs');
      return;
    }
    paint(trend.ok ? trend.data : null, sess.items, trend, dist, sess.timeframe, plan);
  }

  function paint(trend, runs, trendRes, dist, sessTf, plan) {
    paintWow(dist, plan);

    /* One window for the page, set by the range control. Three used to be in
       play at once — the on-foot weeks `/api/distance` publishes, the trend
       range, and the session window — so the page showed "26 weeks",
       "13 months" and "12 Aug 2025 to 11 Aug 2026" side by side for one
       setting of one control. Grain is how a panel draws the range, not a
       range of its own, and it belongs in the subtitle. */
    for (const p of [pWow, pVolume, pAtDist, pPace, pSpread, pRhythm, pQuality, pZones, pRead, pLog]) {
      setTimeframe(p, sessTf);
    }
    figs.forEach((f) => f.destroy && f.destroy());
    figs = [];

    const withDist = runs.filter((r) => r.distance_km);
    const km = withDist.reduce((a, r) => a + Number(r.distance_km), 0);
    const sec = withDist.reduce((a, r) => a + Number(r.duration_min || 0) * 60, 0);
    const longest = withDist.length
      ? withDist.reduce((a, r) => (r.distance_km > a.distance_km ? r : a)) : null;
    const fastest = withDist.filter((r) => r.distance_km >= 3 && r.pace_s_per_km).length
      ? withDist.filter((r) => r.distance_km >= 3 && r.pace_s_per_km)
        .reduce((a, r) => (r.pace_s_per_km < a.pace_s_per_km ? r : a)) : null;

    clear(statsHost);
    statsHost.append(statStrip([
      { label: 'Distance', value: fmt.int(km), unit: 'km', note: `${runs.length} runs in range` },
      {
        label: 'Mean pace', value: km ? fmt.pace(sec / km).replace('/km', '') : '—', unit: '/km',
        note: 'distance-weighted, not an average of averages',
      },
      {
        label: 'Longest', value: longest ? fmt.one(longest.distance_km) : '—', unit: 'km',
        note: longest ? `${fmt.clock(longest.duration_min)} on ${fmt.dateY(longest.date)}` : 'nothing in range',
      },
      {
        label: 'Quickest 3 km+', value: fastest ? fmt.pace(fastest.pace_s_per_km).replace('/km', '') : '—', unit: '/km',
        note: fastest ? `${fmt.km(fastest.distance_km)} on ${fmt.dateY(fastest.date)}` : 'nothing in range',
      },
    ]));

    /* volume */
    clear(pVolume.body);
    const vPoints = (trend && trend.points) || [];
    /* On foot only. Biking is excluded by design — the legs are what the ramp
       is about — and it is stated rather than left to be inferred from a
       missing band. */
    const vKinds = ON_FOOT.filter((k) => vPoints.some((x) => (x.by_kind || {})[k] > 0));
    const vTotals = Object.fromEntries(vKinds.map((k) => [
      k, vPoints.reduce((a, x) => a + ((x.by_kind || {})[k] || 0), 0),
    ]));
    const vGrand = Object.values(vTotals).reduce((a, b) => a + b, 0);

    pVolume.head.querySelector('.sub').textContent =
      `Kilometres on foot per ${state.grain}, split by modality`;
    if (!vPoints.length || !vKinds.length) {
      if (trendRes && !trendRes.ok) panelError(pVolume.body, trendRes, 'Distance');
      else pVolume.body.append(emptyNote('No on-foot distance in this range.'));
    } else {
      figs.push(figure(pVolume.body, {
        type: 'columns',
        aria: `On-foot distance per ${state.grain}, split by modality`,
        height: 250, unit: 'km', periodLabel: state.grain === 'month' ? 'Month' : 'Week of',
        series: vKinds.map((k) => ({
          key: k, label: kindName(k), color: colorOf(k),
          total: `${fmt.one(vTotals[k])} km`,
        })),
        points: vPoints.map((x) => ({
          key: x.period,
          label: state.grain === 'month' ? fmt.monthYear(x.period) : fmt.date(x.period),
          values: Object.fromEntries(vKinds.map((k) => [k, (x.by_kind || {})[k] || 0])),
          total: vKinds.reduce((a, k) => a + ((x.by_kind || {})[k] || 0), 0),
        })),
        format: (v) => `${fmt.one(v)} km`,
        formatShort: (v) => fmt.compact(v),
      }));
      pVolume.body.append(el('p', { class: 'sub', text:
        `${fmt.one(vGrand)} km on foot in this range — `
        + vKinds.map((k) => `${kindName(k)} ${fmt.one(vTotals[k])}`).join(', ')
        + '. Biking is excluded: this is what the legs carried.' }));
    }

    /* pace */
    clear(pPace.body);
    const pace = paceByPeriod(runs, state.grain);
    pPace.head.querySelector('.sub').textContent =
      `distance-weighted mean pace per ${state.grain} — lower is faster`;
    if (pace.length < 2) {
      pPace.body.append(emptyNote('Not enough months of running in this range to plot a pace trend.'));
    } else {
      figs.push(figure(pPace.body, {
        type: 'line',
        aria: 'Distance-weighted mean pace per month',
        height: 210, unit: '/km', periodLabel: 'Month',
        series: [{ key: 'pace', label: 'Pace', color: colorOf('run') }],
        points: pace,
        format: (v) => fmt.pace(v),
        formatShort: (v) => fmt.pace(v).replace('/km', ''),
      }));
      pPace.body.append(el('p', { class: 'sub', text:
        'Total seconds divided by total kilometres in each month, so a long slow run counts for more than a short one.' }));
    }

    /* pace at the key distances */
    lastRuns = runs;
    paintAtDistance(runs);

    /* distance spread */
    clear(pSpread.body);
    const hist = distanceHistogram(withDist);
    if (!withDist.length) {
      pSpread.body.append(emptyNote('No runs with a distance in this range.'));
    } else {
      figs.push(figure(pSpread.body, {
        type: 'columns',
        aria: 'Number of runs by distance band',
        height: 210, unit: 'runs', periodLabel: 'Distance (km)',
        series: [{ key: 'n', label: 'Runs', color: colorOf('run') }],
        points: hist,
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
        minSlot: 40,
      }));
    }

    /* weekday */
    clear(pRhythm.body);
    if (!runs.length) {
      pRhythm.body.append(emptyNote('No runs in this range.'));
    } else {
      const wk = byWeekday(runs);
      figs.push(figure(pRhythm.body, {
        type: 'columns',
        aria: 'Number of runs by day of the week',
        height: 210, unit: 'runs', periodLabel: 'Day',
        series: [{ key: 'n', label: 'Runs', color: colorOf('run') }],
        points: wk.map((r) => ({
          key: r.key, label: r.label, values: { n: r.count }, total: r.count,
          note: r.total ? `${fmt.int(r.total)} AU · ${fmt.one(r.minutes / 60)} h` : 'nothing logged',
        })),
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
        minSlot: 34,
      }));
    }

    /* compliance */
    clear(pQuality.body);
    const comp = runs.filter((r) => (r.detail || {}).compliance_pct != null)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    pQuality.head.querySelector('.sub').textContent =
      `${comp.length} of ${runs.length} runs carry a coach-compliance figure`;
    if (comp.length < 2) {
      pQuality.body.append(emptyNote('Not enough runs in this range record how closely they followed the plan.'));
    } else {
      const mean = comp.reduce((a, r) => a + Number(r.detail.compliance_pct), 0) / comp.length;
      pQuality.body.append(statStrip([
        { label: 'Mean', value: `${Math.round(mean)}%`, note: `across ${comp.length} runs` },
        {
          label: 'Latest', value: `${comp[comp.length - 1].detail.compliance_pct}%`,
          note: fmt.dateY(comp[comp.length - 1].date),
        },
      ]));
      figs.push(figure(pQuality.body, {
        type: 'line',
        aria: 'Coach compliance per run',
        height: 150, unit: '%', periodLabel: 'Run', zeroBase: true,
        series: [{ key: 'c', label: 'To plan', color: colorOf('run') }],
        points: comp.map((r) => ({
          key: String(r.id), label: fmt.date(r.date),
          values: { c: r.detail.compliance_pct },
          note: `${fmt.km(r.distance_km)} · ${fmt.pace(r.pace_s_per_km)}`,
        })),
        format: (v) => `${Math.round(v)}%`,
        formatShort: (v) => `${Math.round(v)}%`,
      }));
    }

    /* zones */
    clear(pZones.body);
    const { totals, sessions: zoned, minutes: zMin, unweighable } = zoneSplit(runs);
    pZones.head.querySelector('.sub').textContent = zoned
      ? `${fmt.mins(zMin)} of running across ${zoned} of ${runs.length} runs`
      : `no zone data in ${runs.length} runs`;
    const zKeys = Object.keys(totals).sort();
    if (!zKeys.length) {
      pZones.body.append(emptyNote(
        'No run in this range recorded an HR zone split. The watch records one on every '
        + 'activity it captures heart rate for; runs logged by hand have none.',
      ));
    } else {
      const base = colorOf('run');
      splitBar(pZones.body, {
        parts: zKeys.map((z, i) => ({
          key: z, label: z.toUpperCase(), value: totals[z],
          color: i === 0 ? base : stepTowardInk(base, Math.min(0.62, 0.18 * i)),
        })),
        /* Empty unit, not omitted: `splitBar` defaults to 'AU', and `fmt.mins`
           already writes its own ("2h 12m"). Leaving it out read "2h 12m AU";
           passing 'min' read "2h 12m min". */
        unit: '', format: (v) => fmt.mins(v),
        emptyText: 'No zone data in this range.',
      });
      pZones.body.append(el('p', { class: 'sub', text:
        `Minutes in each zone, each run's split weighted by how long it lasted — so an hour at `
        + 'easy pace counts as an hour and not as one reading. '
        + `Covers the ${zoned} of ${runs.length} runs in this range that recorded a split`
        + `${unweighable ? `; ${unweighable} had one but no duration to weight it by` : ''}.` }));
    }

    /* read-out */
    clear(pRead.body);
    pRead.body.append(readout(runReadout(runs, longest)));

    /* log */
    clear(pLog.body);
    pLog.head.querySelector('.sub').textContent = `${runs.length} in this range, most recent first`;
    if (!runs.length) {
      pLog.body.append(emptyNote('No runs in this range.'));
    } else {
      /* Ninety rows is a reference, not something to scroll past on the way
         to nothing. Folded, with the count on the lid. */
      pLog.body.append(collapsible(
        `Show all ${runs.length} runs`,
        runTable(runs.slice().sort((a, b) => (a.date < b.date ? 1 : -1))),
      ));
    }
  }

  /* ── pace by distance ── */

  /* The runs of the last paint, so switching distance redraws without a
     refetch. The control lives in the panel head and only this panel moves. */
  let lastRuns = [];

  /**
   * The gap between two paces, as words with a direction. Taken between the
   * two paces as printed — each rounded to the second first — so 7:53 against
   * 5:11 reads 2:42, which is what the reader gets subtracting the figures on
   * screen. Under a minute in seconds; from a minute up as m:ss, because
   * "162 s/km" is a sum the reader has to do and "2:42/km" is the answer.
   * Lower is faster, so a faster run points down — the way it moved on the
   * chart. The glyph sits beside the words, never instead of them.
   */
  const secParts = (a, b) => {
    const delta = Math.round(a) - Math.round(b);
    const sec = Math.abs(delta);
    const n = sec >= 60 ? fmt.pace(sec).replace('/km', '') : String(sec);
    const word = sec === 0 ? 'level' : delta < 0 ? 'faster' : 'slower';
    return {
      delta,
      text: sec === 0 ? 'level' : sec >= 60 ? `${n}/km ${word}` : `${n} s/km ${word}`,
      glyph: sec === 0 ? '＝' : delta < 0 ? '▼' : '▲',
    };
  };
  const secWord = (a, b) => secParts(a, b).text;

  /**
   * The top of the panel: the best run as the lead, in gold, and the latest
   * beside it with both comparisons written under its figure. Four identical
   * tiles were here first and gave the reader nothing to look at first — the
   * best and the latest are different kinds of fact and are set differently:
   * one is a record, the other is news.
   */
  function paceLead({ best, latest, previous, name }) {
    const fig = (r) => el('div', { class: 'pace-fig' }, [
      el('b', { text: fmt.pace(paceOf(r)).replace('/km', '') }),
      el('u', { text: '/km' }),
    ]);
    const when = (r) => `${fmt.clock(r.duration_min)} · ${fmt.dateY(r.date)}`;

    const vsBest = secParts(paceOf(latest), paceOf(best));
    const vsPrev = previous ? secParts(paceOf(latest), paceOf(previous)) : null;
    const lines = el('ul', { class: 'pace-vs' });
    lines.append(latest === best
      ? el('li', { class: 'is-best' }, [
        el('i', { 'aria-hidden': 'true', text: '★' }), document.createTextNode(' '),
        el('b', { text: 'the best' }), document.createTextNode(` ${name} run in this range`),
      ])
      : el('li', {}, [
        el('i', { 'aria-hidden': 'true', text: vsBest.glyph }), document.createTextNode(' '),
        el('b', { text: vsBest.text }), document.createTextNode(' than the best'),
      ]));
    lines.append(vsPrev
      ? el('li', {}, [
        el('i', { 'aria-hidden': 'true', text: vsPrev.glyph }), document.createTextNode(' '),
        el('b', { text: vsPrev.text }),
        document.createTextNode(` than the run before, ${fmt.pace(paceOf(previous))} on ${fmt.date(previous.date)}`),
      ])
      : el('li', { class: 'muted' }, [el('span', { text: `only one ${name} run in this range` })]));

    return el('div', { class: 'pace-lead' }, [
      el('div', { class: 'pace-pane is-best' }, [
        el('span', { class: 'pace-lbl' }, [
          icon('medal', 'pace-icon'), document.createTextNode(' '), el('span', { text: 'Best' }),
        ]),
        fig(best),
        el('p', { class: 'pace-base', text: when(best) }),
      ]),
      el('div', { class: 'pace-pane' }, [
        el('span', { class: 'pace-lbl' }, [el('span', { text: 'Latest' })]),
        fig(latest),
        el('p', { class: 'pace-base', text: when(latest) }),
        lines,
      ]),
    ]);
  }

  function paintAtDistance(runs) {
    clear(pAtDist.body);
    const summaries = KEY_DISTANCES.map((d) => distanceSummary(runs, d));
    const cur = summaries.find((x) => x.d.key === state.dist) || summaries[1];
    const { d, matched, n, best, latest, previous, tolerance } = cur;

    setTools(pAtDist, segmented(
      KEY_DISTANCES.map((k) => [k.key, k.label]), d.key,
      (v) => { state.dist = v; saveDist(v); setQuery({ dist: v }); paintAtDistance(lastRuns); },
      'Key distance',
    ));
    const name = d.long || d.label;
    pAtDist.head.querySelector('.sub').textContent =
      `every ${name} run, at the pace it was recorded — lower is faster`;

    if (!n) {
      const withDist = runs.filter((r) => r.distance_km);
      const longest = withDist.length
        ? withDist.reduce((a, r) => (Number(r.distance_km) > Number(a.distance_km) ? r : a)) : null;
      pAtDist.body.append(emptyNote(
        `No ${name} yet in this range.`
        + (longest && Number(longest.distance_km) < d.km
          ? ` The longest run is ${fmt.km(longest.distance_km)}, on ${fmt.dateY(longest.date)}.` : ''),
      ));
    } else {
      pAtDist.body.append(paceLead({ best, latest, previous, name }));

      const points = pacePoints(matched);
      const bestIdx = matched.indexOf(best);
      /* The best run wears a gold star on the line and its label sits under
         the point, where nothing else can be: the fastest run is the lowest. */
      points[bestIdx].mark = { key: 'pace', shape: 'star' };
      const chartHost = el('div', { class: 'fig-primary' });
      pAtDist.body.append(chartHost);
      /* Not run-orange. The panel, its kicker and the whole page already are,
         and a figure the same colour as everything around it is wallpaper.
         `--pace` is a hue no other mark on this page uses. Every point
         carries its pace: the reader asked for the numbers, not the shape. */
      figs.push(figure(chartHost, {
        type: 'line',
        aria: `Recorded pace of every ${name} run, oldest to newest`,
        height: 250, unit: '', periodLabel: 'Run', markers: true, labels: 'all',
        series: [{ key: 'pace', label: 'Pace', color: token('pace') }],
        points,
        format: (v) => fmt.pace(v),
        formatShort: (v) => fmt.pace(v).replace('/km', ''),
        labelPoints: [{
          index: bestIdx, text: `★ ${fmt.pace(paceOf(best)).replace('/km', '')} best`,
          dy: 21, cls: 'is-best',
        }],
      }));
      pAtDist.body.append(el('p', { class: 'sub', text:
        `${n} run${n === 1 ? '' : 's'} of ${fmt.one(d.km - tolerance)} to ${fmt.one(d.km + tolerance)} km, `
        + 'oldest on the left. Nothing is smoothed; the note on each point says what the run was.' }));
    }

    pAtDist.body.append(distanceTable(summaries));
  }

  /**
   * Every key distance on one table, so the whole question — where is the
   * speed coming, where is it not — is answered without six clicks. Every
   * figure is a recorded run; the last column sets the latest against the
   * run before it.
   *
   * The cells are not all the same weight, on purpose. A first version set
   * best, latest, dates and counts in one face and the reader could not tell
   * the record from the news at a glance. Now the best is gold and bold with
   * the medal, the latest is strong ink, the dates and counts are small and
   * quiet, and in the comparison only the number is bold.
   */
  function distanceTable(summaries) {
    const wrap = el('div', { class: 'table-wrap scroll' });
    const table = el('table', { class: 'data-table dist-table' });
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Distance' }),
      el('th', { scope: 'col', class: 'num', text: 'Runs' }),
      el('th', { scope: 'col', class: 'num c-best', text: 'Best' }),
      el('th', { scope: 'col', class: 'c-when', text: 'When' }),
      el('th', { scope: 'col', class: 'num', text: 'Latest' }),
      el('th', { scope: 'col', class: 'c-when', text: 'When' }),
      el('th', { scope: 'col', text: 'Against the run before' }),
    ])]));
    const body = el('tbody');
    for (const x of summaries) {
      const b = x.best;
      const l = x.latest;
      const vs = x.previous ? secParts(paceOf(l), paceOf(x.previous)) : null;
      body.append(el('tr', { class: [x.d.key === state.dist ? 'is-open' : null, x.n ? null : 'is-empty']
        .filter(Boolean).join(' ') || null }, [
        el('th', { scope: 'row', class: 'nowrap', text: x.d.long
          ? `${x.d.label} (${fmt.one(x.d.km)} km)` : x.d.label }),
        el('td', { class: 'num c-runs', text: String(x.n) }),
        b
          ? el('td', { class: 'num c-best nowrap' }, [
            icon('medal', 'c-medal'), document.createTextNode(' '),
            el('span', { text: fmt.pace(paceOf(b)) }),
          ])
          : el('td', { class: 'num muted', text: '—' }),
        el('td', { class: `c-when${b ? ' nowrap' : ' muted'}`, text: b ? fmt.dateY(b.date) : 'none yet' }),
        el('td', { class: `num c-latest${l ? '' : ' muted'}`, text: l ? fmt.pace(paceOf(l)) : '—' }),
        el('td', { class: `c-when${l ? ' nowrap' : ' muted'}`, text: l ? fmt.dateY(l.date) : '—' }),
        vs
          ? el('td', { class: 'c-vs' }, [
            el('i', { 'aria-hidden': 'true', text: vs.glyph }), document.createTextNode(' '),
            el('b', { text: vs.text }),
            el('span', { text: ` than ${fmt.pace(paceOf(x.previous))} on ${fmt.dateY(x.previous.date)}` }),
          ])
          : el('td', { class: 'c-vs muted', text: x.n ? 'one run so far' : '—' }),
      ]));
    }
    table.append(body);
    wrap.append(table);
    wrap.append(el('p', { class: 'sub', text:
      'A run counts for a distance when it is within 0.15 km of it (0.32 km for the half, 0.63 km for the marathon).' }));
    return wrap;
  }

  /* ── week over week, on foot ── */

  /**
   * On-foot distance, and the thing actually asked for: how far to go next
   * week. Everything here comes from `GET /api/distance` — the weekly totals,
   * the change, the four-week mean, the ratio and both target bases. The page
   * derives none of it, because that figure has now been computed in two
   * places twice and disagreed both times.
   *
   * The target leads. Week-over-week change is the context for it, not the
   * headline. Nothing here is coloured by whether the number is "good": the
   * server's `verdict` is a plain phrase and it is printed as words.
   */
  function paintWow(res, planRes) {
    clear(pWow.body);
    if (!res || !res.ok) {
      panelError(pWow.body, res || {}, 'On-foot distance');
      return;
    }
    const d = res.data;
    /* No setTimeframe here: paint() stamps the page's window on this panel
       like every other. `/api/distance` fixes its own 26-week history, which
       is a property of that endpoint rather than a period the reader chose,
       and printing it here put a second window on the page. */
    const points = d.points || [];
    if (!points.length) {
      pWow.body.append(emptyNote('No distance on record for these modalities.'));
      return;
    }
    const cur = d.current || points[points.length - 1];
    /* The last week that actually finished. Every comparison on this panel is
       made against it rather than against the week in progress: on a Monday
       the current week holds nothing, and reporting that as "−100% on last
       week, no distance" is a calendar artefact dressed up as a collapse. */
    const done = d.last_complete_week
      || points.filter((p) => !p.in_progress).slice(-1)[0]
      || cur;
    const partial = !!cur.in_progress;
    const kinds = KINDS.filter((k) => points.some((p) => (p.by_kind || {})[k] > 0));

    pWow.body.append(targetBlock(d, planRes && planRes.ok ? planRes.data : null));

    pWow.body.append(statStrip([
      {
        label: 'Last full week', value: fmt.one(done.km), unit: 'km',
        note: `week of ${fmt.dateY(done.week_start)}${
          done.matches ? ` · ${done.matches} match${done.matches === 1 ? '' : 'es'}` : ''} · ${done.verdict || 'on foot'}`,
      },
      {
        label: 'On the week before',
        value: done.delta_pct == null ? '—' : signedPct(done.delta_pct),
        /* No percentage against a zero week — the em dash is the honest
           answer and the note says why rather than printing an infinity. */
        note: done.delta_pct == null ? 'nothing on foot the week before'
          : `${fmt.signed(done.delta_km, ' km')} on the week before`,
      },
      partial ? {
        label: 'This week so far', value: fmt.one(cur.km), unit: 'km',
        note: `week of ${fmt.dateY(cur.week_start)} · still in progress`,
      } : {
        label: '4-week mean', value: done.mean_4w == null ? '—' : fmt.one(done.mean_4w), unit: 'km',
        note: 'the four weeks ending with that one',
      },
      {
        label: 'Acute : chronic', value: d.acwr && d.acwr.ratio != null ? fmt.two(d.acwr.ratio) : '—',
        /* Anchored on the last completed week, never on the one being lived —
           otherwise this read 0.00 every Monday. Naming the week it came from
           is the whole point; "still in progress" told you it was meaningless
           without giving you a meaningful number instead. */
        note: d.acwr && d.acwr.week_start
          ? `week of ${fmt.dateY(d.acwr.week_start)} ÷ the four weeks ending with it`
          : 'building the baseline — four completed weeks needed',
      },
    ]));

    const chartHost = el('div', { class: 'fig-primary' });
    pWow.body.append(chartHost);
    figs.push(figure(chartHost, {
      type: 'columns',
      aria: 'Distance covered on foot each week, by modality',
      height: 240, unit: 'km', periodLabel: 'Week of',
      series: kinds.map((k) => ({ key: k, label: kindName(k), color: colorOf(k) })),
      points: points.map((w) => ({
        key: w.week_start, label: fmt.date(w.week_start),
        values: w.by_kind || {}, total: w.km,
        /* An unfinished week is named as one, and its percentage against the
           week before is withheld — comparing four days to seven produces a
           number that is arithmetically fine and means nothing. */
        note: w.in_progress
          ? 'week still in progress — not comparable to a full week'
          : [w.verdict, w.delta_pct == null ? null : `${signedPct(w.delta_pct)} on the week before`]
            .filter(Boolean).join(' · ') || null,
      })),
      format: (v) => fmt.one(v),
      formatShort: (v) => fmt.compact(v),
      emptyText: 'No distance in this window.',
    }));

    pWow.body.append(wowTable(points.slice(-12).reverse()));

    const sc = d.soccer || {};
    const notes = [
      d.guidance || null,
      /* The gap closes as Garmin fills matches in, so the note carries the
         count with it rather than reading as a permanent state of affairs. */
      sc.note && sc.without_distance
        ? `${sc.note} ${sc.with_distance || 0} of ${sc.matches_in_range} matches `
          + `in this window ${sc.with_distance === 1 ? 'carries one' : 'carry one'} so far.`
        : null,
    ].filter(Boolean);
    for (const n of notes) pWow.body.append(el('p', { class: 'sub', text: n }));
  }

  const signedPct = (v) => `${Math.round(v) === 0 ? '' : v > 0 ? '+' : '−'}${Math.abs(Math.round(v))}%`;

  /**
   * The target, which is the question the panel exists to answer.
   *
   * One number now, not two. The API used to publish a second target built on
   * the four-week mean and the panel showed both side by side; it now builds a
   * single target on the last **complete** week and names both ends itself, in
   * `next_week.labels`. Those names are printed rather than assumed — the
   * panel spent a while saying "this week's 29.2 km" about a figure that was
   * last week's, which is precisely the kind of quiet drift this page exists
   * to avoid. Neither the target nor the base is an instruction.
   *
   * With no distance in the base week there is no percentage to add: the
   * figure is an em dash and the server's sentence says why. A 0.0 km target
   * would be a number that means nothing.
   */
  /**
   * What is left of the committed week, and a few ways to divide it.
   *
   * This is the figure that actually gets used on a Wednesday — "how much have
   * I still got to run and over how many days" — which neither the target nor
   * the running total answers on its own. The splits are arithmetic offered as
   * options, not a prescription: two, three or four runs at an even distance,
   * so the shape of the rest of the week can be read at a glance and then
   * ignored.
   *
   * Only for the week actually in progress. A future committed week has all of
   * itself left, which is just the target again, and a finished one has a
   * result rather than a remainder.
   */
  function remainingPane(locked, tw) {
    if (!tw.is_current_week || locked.target_km == null) return null;

    const done = Number(locked.actual_km || 0);
    const left = Number(locked.target_km) - done;

    /* Days counted inclusive of today: a run can still happen today, so a
       Sunday is one day left rather than none. */
    const today = todayISO();
    const end = tw.end || locked.week_end;
    const days = end
      ? Math.max(0, Math.round((dateOf(end) - dateOf(today)) / 86400000) + 1)
      : null;

    if (left <= 0.05) {
      return el('div', { class: 'target-pane' }, [
        el('span', { class: 'lbl', text: 'Left this week' }),
        el('div', { class: 'target-fig' }, [
          el('b', { text: '0' }), el('u', { text: 'km' }),
        ]),
        el('p', { class: 'target-base', text: left < -0.05
          ? `${fmt.one(-left)} km past the committed ${fmt.one(locked.target_km)} km`
          : 'the committed distance is covered' }),
        days ? el('p', { class: 'target-base', text:
          `${days} ${days === 1 ? 'day' : 'days'} left in the week, through ${fmt.dateY(end)}` }) : null,
      ].filter(Boolean));
    }

    /* Even splits, only where they are worth offering. A 2 km remainder does
       not want to be four runs, so a split is dropped once it falls below a
       distance anybody would set out to do. */
    const splits = [2, 3, 4]
      .filter((n) => left / n >= 3 && n <= (days || 7))
      .map((n) => `${fmt.one(left / n)} km × ${n}`);

    return el('div', { class: 'target-pane' }, [
      el('span', { class: 'lbl', text: 'Left this week' }),
      el('div', { class: 'target-fig' }, [
        el('b', { text: fmt.one(left) }), el('u', { text: 'km' }),
      ]),
      el('p', { class: 'target-base', text:
        `${fmt.one(locked.target_km)} km committed − ${fmt.one(done)} km done` }),
      days ? el('p', { class: 'target-base', text:
        `over ${days} ${days === 1 ? 'day' : 'days'}, through ${fmt.dateY(end)}`
        + (days > 1 ? ` — ${fmt.one(left / days)} km a day` : '') }) : null,
      splits.length ? el('p', { class: 'target-base', text: `or ${splits.join(', ')}` }) : null,
    ].filter(Boolean));
  }

  function targetBlock(d, plan) {
    const nx = d.next_week || {};
    const row = nx.from_base || nx.from_this_week || null;
    const labels = nx.labels || {};
    const wrap = el('div', { class: 'target' });

    const targetName = labels.target || 'next week';
    const baseName = labels.base || 'the base week';
    const tw = nx.target_week || {};

    /* The committed target for the same week, if one was locked. Matched on
       `week_start` rather than on position, because the plan runs further out
       than this endpoint's window. */
    const locked = tw.start && plan && Array.isArray(plan.weeks)
      ? plan.weeks.find((w) => w.week_start === tw.start) || null
      : null;

    /* A locked week is the target, full stop. The +10% ramp `/api/distance`
       publishes is a suggestion for what to *set* when nothing has been set —
       it recomputes every week from whatever was actually run, so a week that
       came up short drags it down. Printing it beside a committed figure gave
       the week two targets and made the smaller one look like a revision of
       the plan. It is not shown at all once a plan covers the week. */
    if (locked) {
      wrap.append(el('div', { class: 'target-panes' }, [
        el('div', { class: 'target-pane is-lead' }, [
          el('span', { class: 'lbl', text: `Target for ${targetName}` }),
          el('div', { class: 'target-fig' }, [
            el('b', { text: fmt.one(locked.target_km) }), el('u', { text: 'km' }),
          ]),
          el('p', { class: 'target-base', text:
            `committed plan${locked.is_deload ? ', deload week' : ''}`
            + (locked.locked_at ? `, locked ${fmt.dateY(String(locked.locked_at).slice(0, 10))}` : '') }),
          tw.start ? el('p', { class: 'target-base', text:
            `for the week of ${fmt.date(tw.start)} – ${fmt.dateY(tw.end)}` }) : null,
          locked.actual_km != null ? el('p', { class: 'target-base', text:
            `${fmt.one(locked.actual_km)} km so far` }) : null,
        ]),
        remainingPane(locked, tw),
      ].filter(Boolean)));
      return wrap;
    }

    wrap.append(el('div', { class: 'target-panes' }, [
      el('div', { class: 'target-pane is-lead' }, [
        el('span', { class: 'lbl', text: `Target for ${targetName}` }),
        row
          ? el('div', { class: 'target-fig' }, [
            el('b', { text: fmt.one(row.target_km) }), el('u', { text: 'km' }),
          ])
          : el('div', { class: 'target-fig target-none' }, [el('b', { text: '—' })]),
        el('p', { class: 'target-base', text: row
          ? `${baseName} ${fmt.one(row.base_km)} km + ${fmt.one(row.add_km)} km`
            + (nx.base_week ? `, week of ${fmt.dateY(nx.base_week)}` : '')
          : `no distance in ${baseName}, so there is nothing to add a percentage to` }),
        tw.start ? el('p', { class: 'target-base', text:
          `for the week of ${fmt.date(tw.start)} – ${fmt.dateY(tw.end)}` }) : null,
      ]),
    ]));

    if (nx.note) wrap.append(el('p', { class: 'target-note', text: nx.note }));
    return wrap;
  }

  function wowTable(weeks) {
    const wrap = el('div', { class: 'table-wrap scroll' });
    const table = el('table', { class: 'data-table' });
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Week of' }),
      el('th', { scope: 'col', class: 'num', text: 'km' }),
      el('th', { scope: 'col', class: 'num', text: 'Change' }),
      el('th', { scope: 'col', class: 'num', text: '%' }),
      el('th', { scope: 'col', class: 'num', text: '4-wk mean' }),
      el('th', { scope: 'col', text: 'Reads as' }),
    ])]));
    const body = el('tbody');
    for (const w of weeks) {
      const open = !!w.in_progress;
      body.append(el('tr', { class: open ? 'is-open' : null }, [
        el('th', { scope: 'row', class: 'num nowrap' }, [
          el('span', { text: fmt.dateY(w.week_start) }),
          open ? document.createTextNode(' ') : null,
          open ? el('span', { class: 'downtag', text: 'in progress' }) : null,
        ]),
        el('td', { class: 'num', text: fmt.one(w.km) }),
        el('td', { class: 'num', text: open || w.delta_km == null ? '—' : fmt.signed(w.delta_km, '') }),
        open || w.delta_pct == null
          ? el('td', { class: 'num muted', text: '—' })
          : el('td', { class: 'num' }, [el('span', { class: 'wow', text: signedPct(w.delta_pct) })]),
        el('td', { class: 'num', text: w.mean_4w == null ? '—' : fmt.one(w.mean_4w) }),
        /* The server's phrase, printed as words. No status colour: the same
           rule the ratio scale follows. An unfinished week gets no phrase at
           all rather than "no distance", which reads as a verdict on a week
           that has not happened. */
        el('td', { class: 'muted', text: open ? 'week not finished' : (w.verdict || '—') }),
      ]));
    }
    table.append(body);
    wrap.append(table);
    wrap.append(el('p', { class: 'sub', text:
      'Percentages are against the week before. A week following one with no distance has no percentage — '
      + 'dividing by zero would print a number that means nothing — and the week in progress has none '
      + 'either, because part of a week against a whole one is not a comparison.' }));
    return wrap;
  }

  function runTable(runs) {
    const wrap = el('div', { class: 'table-wrap scroll' });
    const table = el('table', { class: 'data-table' });
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Day' }),
      el('th', { scope: 'col', text: 'Date' }),
      el('th', { scope: 'col', class: 'num', text: 'Distance' }),
      el('th', { scope: 'col', class: 'num', text: 'Time' }),
      el('th', { scope: 'col', class: 'num', text: 'Pace' }),
      el('th', { scope: 'col', class: 'num', text: 'RPE' }),
      el('th', { scope: 'col', class: 'num', text: 'Load' }),
      el('th', { scope: 'col', class: 'wrap', text: 'Notes' }),
      el('th', { scope: 'col' }, [el('span', { class: 'sr', text: 'Edit' })]),
    ])]));
    const body = el('tbody');
    for (const r of runs.slice(0, 300)) {
      const d = r.detail || {};
      const extra = [];
      if (d.compliance_pct != null) extra.push(`${d.compliance_pct}% to plan`);
      if (d.zones) extra.push(Object.entries(d.zones).map(([z, v]) => `${z.toUpperCase()} ${v}%`).join(' '));
      body.append(el('tr', {}, [
        el('td', {}, [dowBadge(r.date)]),
        el('th', { scope: 'row', class: 'num nowrap', text: fmt.dateY(r.date) }),
        el('td', { class: 'num', text: r.distance_km ? fmt.one(r.distance_km) : '—' }),
        el('td', { class: 'num', text: r.duration_min ? fmt.clock(r.duration_min) : '—' }),
        el('td', { class: 'num', text: r.pace_s_per_km ? fmt.pace(r.pace_s_per_km) : '—' }),
        el('td', { class: 'num', text: r.rpe == null ? '—' : String(r.rpe) }),
        el('td', { class: 'num', text: r.load ? fmt.int(r.load) : '—' }),
        el('td', { class: 'wrap' }, [
          el('span', { text: r.notes || '' }),
          extra.length ? el('span', { class: 'muted', text: `${r.notes ? ' · ' : ''}${extra.join(' · ')}` }) : null,
        ]),
        el('td', { class: 'num' }, [
          el('a', { class: 'btn btn-quiet btn-sm', href: `#/edit/${r.id}`, text: 'Edit',
            'aria-label': `Edit run on ${fmt.dateY(r.date)}` }),
        ]),
      ]));
    }
    table.append(body);
    wrap.append(table);
    if (runs.length > 300) {
      wrap.append(el('p', { class: 'sub', text: `Showing the most recent 300 of ${runs.length}.` }));
    }
    return wrap;
  }

  buildFilters();
  load();

  return { destroy() { alive = false; figs.forEach((f) => f.destroy && f.destroy()); }, refresh: load };
}

