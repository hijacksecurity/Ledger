/* Scoreboard — how the week is going, and how far the record has come.
 *
 * The one page here that grades anything. Everything else in this app reports
 * and refuses to judge; this was asked for directly, so it judges — but on the
 * same terms as the rest: the arithmetic is always shown, nothing congratulates
 * anybody, and a weak pillar is named rather than softened.
 *
 * Three things, doing different jobs:
 *
 *   Week score   moves freely, up and down, every week. "How is this week."
 *   Trend        the same score over the last eight weeks, because one number
 *                on its own cannot tell you whether it is going anywhere.
 *   Level        built from lifetime totals that only ever increase, so it
 *                cannot fall. A bad week earns less; it takes nothing away,
 *                and there is no streak to break.
 *
 * All the arithmetic lives in `score.js`, which touches nothing and can be read
 * on its own — including the assembly of a week's inputs, so the trend, this
 * page and the Week view's widget cannot drift into scoring one week three
 * slightly different ways.
 */

import {
  el, clear, api, qs, busy, fmt, colorOf, token, weekStart, todayISO, addDays,
  ON_FOOT,
} from './core.js';
import {
  panel, panelError, statStrip, skeletonBlock, sectionGroup, setTimeframe, emptyNote,
} from './ui.js';
import { figure } from './charts.js';
import {
  weekIntent, goalWeightLb, latestWeighIn, weighInDelta, loadPlanState,
} from './dataset.js';
import {
  scoreWeek, lifetimeLevel, band, toKg, inputFromSummary, weightedPace,
  milestoneNames, milestoneGap,
} from './score.js';

const TREND_WEEKS = 8;

const PILLAR_LABEL = {
  soccer: 'Soccer',
  consistency: 'Consistency',
  running: 'Running',
  adherence: 'Plan adherence',
  habits: 'Habits',
  body: 'Bodyweight',
  load: 'Load',
};

/* Hue per pillar, from the modality palette wherever the pillar *is* a
   modality, so the colour means the same thing here as everywhere else. The
   rest stay neutral rather than borrowing a hue that already belongs to one. */
const PILLAR_ACCENT = {
  soccer: 'soccer', running: 'run',
  consistency: null, adherence: null, habits: null, body: null, load: null,
};

export function mount(host, route) {
  const state = {
    weekOf: route.parts[1] || weekStart(todayISO()),
    goalLb: goalWeightLb(),
    data: null,
    trend: null,
    lifetime: null,
    paceBefore: null,
  };
  let alive = true;
  let figs = [];

  const pHero = panel({ wide: true, className: 'panel-bare' });
  const pPillars = panel({
    title: 'Where the score came from', wide: true,
    sub: 'every pillar, its weight, and the arithmetic behind it',
    kicker: 'Scored',
  });
  const pTrend = panel({
    title: 'Week over week', wide: true,
    sub: `the same score over the last ${TREND_WEEKS} weeks`,
    kicker: 'Trend',
  });
  const pLevel = panel({
    title: 'Level', wide: true,
    sub: 'every week on record — totals that only ever rise, so nothing here can be lost',
    kicker: 'Lifetime',
  });

  host.append(
    pHero,
    sectionGroup({ title: 'This week', note: 'seven pillars, weighted', accent: 'sa-teal' }, [pPillars]),
    sectionGroup({
      title: 'Over time', note: 'one week is a reading; eight is a direction',
      accent: 'sa-indigo',
    }, [pTrend]),
    sectionGroup({
      title: 'The long run', note: 'what the whole record adds up to',
      accent: 'sa-plum',
    }, [pLevel]),
  );

  skeletonBlock(150, pHero.body);
  skeletonBlock(260, pPillars.body);
  skeletonBlock(200, pTrend.body);
  skeletonBlock(140, pLevel.body);

  /* ── data ── */

  async function load() {
    busy(true);
    /* The trailing runs are their own request: the pace baseline is the four
       weeks *before* the week being judged, and no endpoint publishes that as a
       figure. Keeping the week out of its own comparison matters — a mean that
       includes it moves toward it and flattens what it is measuring. */
    const [sum, soccer, locked, prior, hab] = await Promise.all([
      api(`/api/summary${qs({ week_of: state.weekOf, weeks: 12 })}`),
      api('/api/soccer'),
      api('/api/plan/locked'),
      api(`/api/sessions${qs({
        from: addDays(state.weekOf, -28), to: addDays(state.weekOf, -1),
        kind: 'run', limit: 200,
      })}`),
      api(`/api/habits${qs({ from: state.weekOf, to: addDays(state.weekOf, 6) })}`),
      /* The planned counts and the goal are on the server; both pillars that
         read them wait for the snapshot rather than scoring a blank. */
      loadPlanState(),
    ]);
    busy(false);
    if (!alive) return;
    state.goalLb = goalWeightLb();

    if (!sum.ok) {
      clear(pHero.body); clear(pLevel.body); clear(pTrend.body);
      panelError(pPillars.body, sum, 'The week');
      return;
    }
    state.paceBefore = prior.ok ? weightedPace(prior.data.items || []) : null;
    state.data = {
      summary: sum.data,
      soccer: soccer.ok ? soccer.data : null,
      locked: locked.ok ? locked.data : null,
      habits: hab.ok ? (hab.data.habits || []) : [],
    };
    state.weekOf = sum.data.week.start;
    paint();

    /* Both fill in a panel after the page is already usable, and neither is
       awaited before the first paint — neither answers the question the page
       opens on. */
    loadTrend();
    loadLifetime();
  }

  /**
   * The same score for the weeks behind this one, from one extra request.
   *
   * The first attempt fetched a `/api/summary` per week — nine heavy calls for
   * an eight-week strip, slow enough that the panel was still a skeleton when
   * the audit looked at it. Everything it needs is already published in bulk:
   * `load_by_week` carries twelve weeks of load, `bodyweight.series` the weekly
   * average, and one sessions call covers the whole span.
   *
   * Scored through the same `scoreWeek` as the current week. A trend built on a
   * second, simpler formula would be a different metric wearing this one's name.
   */
  async function loadTrend() {
    const d = state.data.summary;
    const weeks = [];
    for (let i = TREND_WEEKS - 1; i >= 0; i -= 1) weeks.push(addDays(state.weekOf, -7 * i));

    /* Habits are fetched one request per week rather than one over the whole
       span, because the *totals* are the part that matters and the server
       computes them per window — a denominator sliced apart in the browser is
       a second definition of the same figure, which is the failure this file
       already avoids for load and pace. Eight reads of a three-row table in
       parallel is not the nine heavy `/api/summary` calls this function was
       rewritten to stop making. */
    const [res, ...habWeeks] = await Promise.all([
      api(`/api/sessions${qs({
        from: addDays(weeks[0], -28), to: addDays(state.weekOf, 6), limit: 500,
      })}`),
      ...weeks.map((w) => api(`/api/habits${qs({ from: w, to: addDays(w, 6) })}`)),
    ]);
    if (!alive) return;
    const all = res.ok ? (res.data.items || []) : [];
    const habitsByWeek = new Map(
      weeks.map((w, i) => [w, habWeeks[i] && habWeeks[i].ok ? (habWeeks[i].data.habits || []) : []]),
    );

    const loadWeeks = d.load_by_week || [];
    const byWeek = new Map(loadWeeks.map((w) => [w.week_start, w]));
    const series = (d.bodyweight || {}).series || [];
    const soc = state.data.soccer;
    const lockedWeeks = (state.data.locked && state.data.locked.weeks) || [];

    /* Chronic load for a past week, from the weekly totals the server already
       publishes: the mean of the four weeks before it. The live `chronic_au` is
       a daily mean over a rolling 28 days and exists only for the current week,
       so this is the closest honest stand-in for an earlier one. */
    const chronicAt = (week) => {
      const prior = loadWeeks.filter((w) => w.week_start < week).slice(-4);
      if (!prior.length) return 0;
      return (prior.reduce((a, w) => a + (w.total || 0), 0) / prior.length) / 7;
    };

    state.trend = weeks.map((w) => {
      const end = addDays(w, 6);
      const sessions = all.filter((x) => x.date >= w && x.date <= end);
      const input = inputFromSummary({
        sessions,
        weekCount: sessions.length,
        avgPerWeek: d.headline.avg_per_week || 0,
        locked: lockedWeeks.find((x) => x.week_start === w) || null,
        careerPerMatch: soc ? (soc.involvements_per_match || 0) : 0,
        paceBefore: weightedPace(
          all.filter((x) => x.kind === 'run' && x.date >= addDays(w, -28) && x.date < w),
        ),
        /* Same derivation as the current week, anchored to this week's end. */
        bodyweight: d.bodyweight,
        asOf: end,
        goalKg: toKg(state.goalLb),
        weekLoad: (byWeek.get(w) || {}).total || 0,
        chronicPerDay: chronicAt(w),
        plannedKinds: weekIntent(w).kinds,
        habitList: habitsByWeek.get(w) || [],
      });
      return { week: w, score: scoreWeek(input).total };
    });
    paintTrend();
  }

  /**
   * Every kilometre ever logged, split into on-foot and bike.
   *
   * No endpoint publishes a lifetime distance — `/api/distance` covers a
   * rolling window — so it is summed from the sessions. Paged rather than
   * trusted to one call: the endpoint caps `limit` at 500, and a record that
   * outgrew it would start under-counting silently, which for a total that is
   * only supposed to rise is the worst way to be wrong.
   */
  async function loadLifetime() {
    let offset = 0;
    let footKm = 0;
    let bikeKm = 0;
    for (let page = 0; page < 8; page += 1) {
      const res = await api(`/api/sessions${qs({ from: '2000-01-01', limit: 500, offset })}`);
      if (!res.ok || !alive) break;
      const items = res.data.items || [];
      for (const s of items) {
        const km = Number(s.distance_km || 0);
        if (!km) continue;
        if (ON_FOOT.includes(s.kind)) footKm += km;
        else if (s.kind === 'bike') bikeKm += km;
      }
      offset += items.length;
      if (!items.length || offset >= (res.data.total || 0)) break;
    }
    if (!alive) return;
    state.lifetime = { footKm, bikeKm };
    paintLevel();
  }

  /* ── paint ── */

  function paint() {
    figs.forEach((f) => f.destroy && f.destroy());
    figs = [];

    const d = state.data.summary;
    const soc = state.data.soccer;
    const locked = ((state.data.locked && state.data.locked.weeks) || [])
      .find((w) => w.week_start === (d.week || {}).start) || null;
    const intent = weekIntent((d.week || {}).start);
    const bw = d.bodyweight || {};

    const result = scoreWeek(inputFromSummary({
      sessions: d.sessions || [],
      weekCount: d.headline.week_count,
      avgPerWeek: d.headline.avg_per_week,
      locked,
      careerPerMatch: soc ? (soc.involvements_per_match || 0) : 0,
      paceBefore: state.paceBefore,
      bodyweight: bw,
      goalKg: toKg(state.goalLb),
      weekLoad: d.load.week_total || 0,
      chronicPerDay: d.load.chronic_au || 0,
      plannedKinds: intent.kinds,
      habitList: state.data.habits || [],
    }));

    setTimeframe(pPillars, (d.timeframes || {}).week);
    paintHero(result, d);
    paintPillars(result, { intent });
    paintLevel();
    if (state.trend) paintTrend();
  }

  /**
   * The number, the word for it, and the one thing most worth doing about it.
   *
   * The verdict is a chip rather than bold text: it names a pillar and a score,
   * which is a different kind of statement from the sentence after it, and both
   * in the same ink read as one run-on line.
   */
  function paintHero(result, d) {
    clear(pHero.body);
    const b = band(result.total);
    const wrap = el('div', { class: `scorehero tone-${b.key}` });
    const prog = d.week_progress || {};

    wrap.append(el('div', { class: 'scorehero-fig' }, [
      el('b', { text: result.total == null ? '—' : String(Math.round(result.total)) }),
      el('span', { class: 'scorehero-of', text: '/ 100' }),
    ]));

    const aside = el('div', { class: 'scorehero-aside' });
    aside.append(el('div', { class: 'scorehero-word', text: b.label }));
    aside.append(el('p', { class: 'scorehero-week', text:
      `${fmt.dateY(d.week.start)} – ${fmt.dateY(d.week.end)}${prog.is_current_week
        ? ` · day ${prog.days_elapsed} of 7, still running` : ' · finished'}` }));

    if (result.weakest) {
      const w = result.weakest;
      aside.append(el('div', { class: 'verdict' }, [
        el('span', { class: `verdict-chip tone-${band(w.score).key}` }, [
          el('i', { 'aria-hidden': 'true' }),
          el('span', { class: 'verdict-name', text: PILLAR_LABEL[w.key] }),
          el('b', { class: 'num', text: String(Math.round(w.score)) }),
        ]),
        el('span', { class: 'verdict-say', text: w.nudge || w.detail }),
      ]));
    } else if (result.total != null) {
      aside.append(el('p', { class: 'scorehero-week', text:
        'Every pillar with data is at or near full marks.' }));
    }

    if (result.bonus) {
      aside.append(el('p', { class: 'scorehero-bonus', text:
        `+${result.bonus} for ${result.tripleDays} triple ${result.tripleDays === 1 ? 'day' : 'days'}.` }));
    }

    wrap.append(aside);
    pHero.body.append(wrap);

    if (prog.is_current_week && prog.days_elapsed < 7) {
      pHero.body.append(el('p', { class: 'sub', text:
        `Scored on ${prog.days_elapsed} of 7 days. Distance, load and consistency all count a week `
        + 'that has not finished, so this figure rises through the week by design.' }));
    }
  }

  /** Every pillar: weight, score, arithmetic, and what would move it. */
  function paintPillars(result, ctx) {
    clear(pPillars.body);
    const list = el('div', { class: 'pillars' });

    for (const p of result.pillars) {
      const accent = PILLAR_ACCENT[p.key];
      const tone = p.absent ? 'none' : band(p.score).key;
      const row = el('section', { class: `pillar${p.absent ? ' is-absent' : ''}` });

      row.append(el('div', { class: 'pillar-top' }, [
        el('div', { class: 'pillar-name' }, [
          el('i', { 'aria-hidden': 'true', class: 'pillar-tick',
            style: `background:${accent ? colorOf(accent) : 'var(--ink-3)'}` }),
          el('span', { text: PILLAR_LABEL[p.key] }),
          el('span', { class: 'pillar-weight', text: `${p.weight}%` }),
        ]),
        el('div', { class: `pillar-score num tone-${tone}` },
          [el('span', { text: p.absent ? '—' : String(Math.round(p.score)) })]),
      ]));

      if (!p.absent) {
        /* Toned by score — forbidden everywhere else in this app, because a
           colour that grades is a verdict. Here that is the job. */
        row.append(el('div', { class: `pillar-bar tone-${tone}` }, [
          el('div', { class: 'pillar-fill', style: `width:${Math.max(1.5, p.score)}%` }),
        ]));
      }

      const lines = el('ul', { class: 'pillar-lines' });
      if (p.absent) {
        lines.append(el('li', { text: absentReason(p.key, ctx) }));
      } else {
        for (const line of p.lines) lines.append(el('li', { text: line }));
        if (p.nudge) lines.append(el('li', { class: 'is-nudge', text: p.nudge }));
      }
      row.append(lines);
      list.append(row);
    }

    pPillars.body.append(list);
    pPillars.body.append(el('p', { class: 'sub', text:
      'A pillar with nothing to score is left out and its weight shared among the rest, so a week '
      + 'with no match is not a week you played badly. The total is what could be scored this week.' }));
  }

  /** Why a pillar has no score — always a fact, never a shrug. */
  function absentReason(key, ctx) {
    switch (key) {
      case 'soccer': return 'No match logged this week, so there is nothing to score. Its weight went to the other pillars.';
      case 'adherence': return ctx.intent && ctx.intent.week
        ? 'No counts set for this week.'
        : 'No plan has been set. Put planned counts on the Plan page and they carry forward from there.';
      case 'running': return 'No committed target and no run with a pace, so there is nothing to measure against.';
      case 'body': return 'No bodyweight trend yet — this needs a four-week average.';
      case 'load': return 'No scored load this week.';
      case 'consistency': return 'No lifetime average to compare against yet.';
      case 'habits': return 'No day in this week has finished with a habit to score. '
        + 'A Monday morning has nothing to count yet, and a night the watch did not record '
        + 'is left out rather than counted as a miss.';
      default: return 'Nothing to score.';
    }
  }

  /** The score, week over week. One reading is a number; eight is a direction. */
  function paintTrend() {
    clear(pTrend.body);
    const rows = (state.trend || []).filter((r) => r.score != null);
    if (rows.length < 2) {
      pTrend.body.append(emptyNote('Not enough scored weeks yet to show a direction.'));
      return;
    }

    const chart = el('div');
    pTrend.body.append(chart);
    figs.push(figure(chart, {
      type: 'columns',
      aria: `Week score over the last ${rows.length} weeks`,
      height: 200, unit: 'points', periodLabel: 'Week of', labels: 'all',
      series: [{ key: 'score', label: 'Week score', color: token('ink-2') }],
      points: rows.map((r) => ({
        key: r.week, label: fmt.date(r.week),
        values: { score: Math.round(r.score) }, total: Math.round(r.score),
        note: band(r.score).label,
      })),
      format: (v) => `${Math.round(v)} / 100`,
      formatShort: (v) => String(Math.round(v)),
    }));

    const mean = rows.reduce((a, r) => a + r.score, 0) / rows.length;
    const last = rows[rows.length - 1].score;
    const prev = rows.length > 1 ? rows[rows.length - 2].score : null;
    const best = rows.reduce((a, r) => (r.score > a.score ? r : a), rows[0]);

    pTrend.body.append(statStrip([
      { label: 'This week', value: String(Math.round(last)),
        note: prev == null ? 'no week before it'
          : `${last >= prev ? '+' : ''}${Math.round(last - prev)} on last week` },
      { label: `${rows.length}-week average`, value: String(Math.round(mean)),
        note: last >= mean ? 'this week is above it' : 'this week is below it' },
      { label: 'Best', value: String(Math.round(best.score)),
        note: `week of ${fmt.dateY(best.week)}` },
    ]));

    pTrend.body.append(el('p', { class: 'sub', text:
      'Every week here is scored by the same function as the one above, including the week still '
      + 'in progress — which is why the last column is usually the lowest until Sunday.' }));
  }

  /** The level, what bought it, and what would buy the next one. */
  function paintLevel() {
    if (!state.data) return;
    const d = state.data.summary;
    const soc = state.data.soccer;
    const lt = state.lifetime || { footKm: 0, bikeKm: 0 };
    const level = lifetimeLevel({
      activities: d.headline.total_activities,
      wins: soc ? (soc.record || {}).w : 0,
      draws: soc ? (soc.record || {}).d : 0,
      involvements: soc ? soc.goal_involvements : 0,
      footKm: lt.footKm,
      bikeKm: lt.bikeKm,
    });

    /* A level takes its name from the last real threshold the record crossed,
       so it says what you have done rather than only how much. Always literally
       true of the totals — nothing here is awarded. */
    const totals = {
      activities: d.headline.total_activities,
      wins: soc ? (soc.record || {}).w : 0,
      involvements: soc ? soc.goal_involvements : 0,
      footKm: lt.footKm,
      bikeKm: lt.bikeKm,
    };
    const ms = milestoneNames(totals);

    clear(pLevel.body);
    if (ms.current) {
      pLevel.body.append(el('div', { class: 'levelname' }, [
        el('span', { class: 'levelname-n', text: `Level ${level.level}` }),
        /* A real separator character, not an empty span with a background.
           An empty element between two labels separates them on screen and
           joins them in text: "Level 14A hundred and fifty involvements". */
        document.createTextNode(' · '),
        el('b', { class: 'levelname-t', text: ms.current.name }),
      ]));
      pLevel.body.append(el('p', { class: 'sub levelname-why', text:
        `Reached when your ${ms.current.noun} total passed `
        + `${fmt.int(ms.current.threshold)}${ms.current.unit ? ` ${ms.current.unit}` : ''}. `
        + `It now stands at ${fmt.int(ms.current.value)}${ms.current.unit ? ` ${ms.current.unit}` : ''}.` }));
    }

    pLevel.body.append(statStrip([
      { label: 'Level', value: String(level.level), note: `${fmt.int(level.points)} lifetime points` },
      { label: 'To the next', value: fmt.int(level.toNext), unit: 'pts',
        note: `level ${level.level + 1} at ${fmt.int(level.points + level.toNext)}` },
    ]));

    pLevel.body.append(el('div', { class: 'levelbar', role: 'img',
      'aria-label': `Level ${level.level}, ${Math.round(level.pct)} per cent toward level ${level.level + 1}` }, [
      el('div', { class: 'levelbar-fill', style: `width:${Math.max(1.5, level.pct)}%` }),
    ]));

    /* A number of points is not something anybody can act on. The same distance
       in things you would actually go and do is. */
    /* The next level is named for the nearest threshold still ahead, which is
       what turns "251 points away" into something you could go and do. */
    if (ms.next) {
      pLevel.body.append(el('p', { class: 'levelbar-cap' }, [
        el('span', { text: `Next: level ${level.level + 1} · ` }),
        el('b', { text: ms.next.name }),
        el('span', { text: ` — ${milestoneGap(ms.next)} to go. ` }),
        el('span', { text: `${fmt.int(level.toNext)} points, which is `
          + level.routes.map((r) => `${fmt.int(r.n)} ${r.label}`).join(', or ') + '.' }),
      ]));
    } else {
      pLevel.body.append(el('p', { class: 'levelbar-cap', text:
        `${fmt.int(level.toNext)} points to level ${level.level + 1} — `
        + level.routes.map((r) => `${fmt.int(r.n)} ${r.label}`).join(', or ') + '.' }));
    }

    const tbl = el('table', { class: 'data-table' });
    tbl.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'What' }),
      el('th', { scope: 'col', class: 'num', text: 'Count' }),
      el('th', { scope: 'col', class: 'num', text: 'Each' }),
      el('th', { scope: 'col', class: 'num', text: 'Points' }),
    ])]));
    const tb = el('tbody');
    for (const p of level.parts) {
      tb.append(el('tr', {}, [
        el('th', { scope: 'row', text: p.label }),
        el('td', { class: 'num', text: fmt.int(p.n) }),
        el('td', { class: 'num', text: p.each < 1 ? p.each.toFixed(1) : String(p.each) }),
        el('td', { class: 'num', text: fmt.int(p.points) }),
      ]));
    }
    tbl.append(tb);
    pLevel.body.append(el('div', { class: 'table-wrap scroll' }, [tbl]));

    pLevel.body.append(el('p', { class: 'sub', text:
      'Every line counts something done, and nothing counts time passing — a level you climb by '
      + 'waiting is not a level. Soccer is the only modality the record holds a result for, so it '
      + 'is the only one with wins to count; distance is what the rest have, and a kilometre on '
      + 'foot is worth more than one on a bike because it costs more. A poor week earns fewer '
      + 'points and removes none.' }));
  }

  load();

  return {
    destroy() { alive = false; figs.forEach((f) => f.destroy && f.destroy()); },
    refresh: load,
  };
}
