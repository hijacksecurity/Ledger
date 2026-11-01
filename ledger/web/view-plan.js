/* Plan — the planning assistant, and the only forward-looking view.
 *
 * The question is "how much further can I go next week, and the week after, and
 * where does that land me in two months?" — so the page is one control and one
 * chart. Drag the weekly increase, watch eight real weeks continue into a
 * projection, and read the number that actually decides whether the plan is
 * sane: the multiplier. Ten per cent a week sounds modest and finishes at 1.77
 * times where you are now; compounding is the thing people misjudge, so it is
 * the biggest number on the page rather than a line in a table.
 *
 * ── One authoritative projection ──────────────────────────────────────────
 * Every figure here — every target, every increment, every ratio, the peak,
 * the total and the multiplier — comes from `GET /api/plan/distance`. Nothing
 * is re-derived in the browser, not even the arithmetic that would be four
 * lines of JavaScript. This app has been bitten three times by one figure
 * existing in two places, and a planner whose chart disagreed with its own
 * table would be worse than no planner. The controls choose parameters; the
 * server does the maths.
 *
 * Nothing here is a target the record grades you against, and nothing is
 * coloured by whether it is "good". A down week is drawn as a deliberate mark,
 * not as a dip. The acute:chronic figure is reported as a position, never as
 * an alarm.
 *
 * Everything planned lives here: the week's counts per modality, the running
 * distance ramp and its committed targets, and the goal weight. The counts and
 * the goal are still in this browser's localStorage — there is no plan table on
 * the server; see NOTES-FOR-BACKEND.md.
 */

import {
  el, icon, clear, api, qs, busy, fmt, colorOf, mixColors, token,
  KINDS, ON_FOOT, weekStart, addDays, todayISO, toast, debounce,
} from './core.js';
import {
  panel, panelError, statStrip, segmented, emptyNote, kindName, skeletonLines,
  skeletonBlock, sectionRule, sectionGroup, collapsible, setTimeframe,
  weekPosition, nowTag,
} from './ui.js';
import { figure } from './charts.js';
import { weekIntent, goalWeightLb, setGoalWeightLb } from './dataset.js';
import { attainTone } from './score.js';

const PLAN_KEY = 'ledger.plan';

const HORIZONS = [[4, '4 weeks'], [8, '8 weeks'], [12, '12 weeks'], [26, '26 weeks']];
const DELOADS = [[0, 'None'], [3, 'Every 3rd'], [4, 'Every 4th']];

const readPlans = () => {
  try { return JSON.parse(localStorage.getItem(PLAN_KEY) || '{}'); } catch { return {}; }
};
const writePlans = (plans) => {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(plans)); return true; } catch { return false; }
};

/* The day-by-day split of a week's committed distance:
   `{ weekStart: { km: { date: n }, match: [dates] } }`.

   Separate from `ledger.plan` because it answers a different question: that one
   is how many sessions, this one is how far on which day. `match` is the days
   you know you are playing that the league has not published a fixture for —
   the schedule is one source of matches and you are the other, and a week
   planned around only the published half puts a match's kilometres onto a run.
   Same device, same reason — see NOTES-FOR-BACKEND.md. */
const DAY_KEY = 'ledger.plan.days';

const readDays = () => {
  try { return JSON.parse(localStorage.getItem(DAY_KEY) || '{}'); } catch { return {}; }
};
const writeDays = (days) => {
  try { localStorage.setItem(DAY_KEY, JSON.stringify(days)); return true; } catch { return false; }
};

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Divide `total` into `n` parts of one decimal place that still sum to `total`.
 *
 * Rounding each part independently does not: 37.7 over 4 days is 9.425 each,
 * which rounds to 9.4 and sums to 37.6 — a tenth short, printed beside a target
 * it is supposed to add up to. Two figures for one quantity is this codebase's
 * oldest failure, and a planner whose days do not add up to its own total is
 * the purest form of it.
 *
 * So each part is taken as the difference between the running total and where
 * the cumulative sum *should* be, which absorbs the rounding as it goes.
 */
export function evenSplit(total, n) {
  const out = [];
  if (n <= 0) return out;
  let placed = 0;
  for (let i = 1; i <= n; i++) {
    const v = Math.max(0, Math.round(((total * i) / n - placed) * 10) / 10);
    out.push(v);
    placed += v;
  }
  return out;
}

/**
 * Choose `n` of `count` slots, spread as evenly as they go.
 *
 * Three runs across five free days should be Mon/Wed/Fri, not Mon/Tue/Wed —
 * the point of planning the week is to space the load, and stacking the runs at
 * the front is the one arrangement nobody would choose by hand.
 */
export function spreadPick(count, n) {
  if (n >= count) return [...Array(count).keys()];
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(((i + 0.5) * count) / n));
  return [...new Set(out)];
}

/* `Number(null)` is 0, not NaN, so an absent query parameter has to be caught
   before it is read as a number — otherwise "no pct in the URL" silently
   becomes "0% a week" and the page opens on a flat plan. */
const clampPct = (v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(25, Math.max(0, Math.round(n * 2) / 2));
};
const oneOf = (list, v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback;
  return list.includes(Number(v)) ? Number(v) : fallback;
};

export function mount(host, route, { setQuery }) {
  const q = route.query;
  const state = {
    pct: clampPct(q.get('pct'), 10),
    weeks: oneOf([4, 8, 12, 26], q.get('weeks'), 8),
    deload: oneOf([0, 3, 4], q.get('deload'), 4),
    /* Which week the ramp is built from. Null means the server's own default:
       the week containing today. */
    weekOf: q.get('week') || null,
    baseKm: q.get('base') ? Number(q.get('base')) : null,
    autoBased: false,
    data: null,
    bases: null,          // {thisWeek, lastFull} — for the "build from" control
    locked: null,         // the committed plan, from /api/plan/locked
    /* Whether the ramp is on screen at all.
       A committed plan is the answer to the question this page asks, and once
       it exists the planner is a tool you need a few times a year — but it was
       always open, always re-projecting from the last complete week, and always
       putting a "Proposed" column of numbers beside the committed ones that
       disagreed with them by construction. So it folds away once something is
       committed, and comes back when you say you are re-planning. */
    replanning: false,
  };
  let figs = [];
  let alive = true;
  let seq = 0;

  /* ── frame ── */

  const pctOut = el('output', { class: 'pct-n num', for: 'pct-range' });
  const slider = el('input', {
    class: 'rng', type: 'range', id: 'pct-range',
    min: '0', max: '25', step: '0.5', value: String(state.pct),
    'aria-label': 'Weekly increase, per cent',
  });
  const pctBar = el('div', { class: 'pctbar' }, [
    el('div', { class: 'pctbar-top' }, [
      el('label', { class: 'lbl', for: 'pct-range', text: 'Weekly increase' }),
      el('div', { class: 'pct-fig' }, [pctOut, el('u', { text: '% a week' })]),
    ]),
    slider,
    /* Six evenly spaced labels on a 0–25 scale land exactly on 0/5/10/15/20/25,
       so space-between puts each one where its value actually is. Three labels
       put "10%" at the halfway mark, which is a lie about the track. */
    el('div', { class: 'pct-scale' },
      ['0', '5', '10', '15', '20', '25'].map((t) => el('span', { text: `${t}%` }))),
  ]);

  const controls = el('div', { class: 'filterbar' });
  const baseBar = el('div', { class: 'basebar' });
  /* Everything that only matters while re-planning, in one box that can be
     hidden as a unit. */
  const planner = el('div', { class: 'planner' });
  const plannerBar = el('div', { class: 'plannerbar' });

  const pRamp = panel({ title: 'Where this ends up', sub: ' ', wide: true });
  const pChart = panel({
    title: 'Week by week',
    sub: 'eight logged weeks, then the projection — one line, same scale',
    wide: true,
  });
  const pTable = panel({ title: 'The plan, in numbers', sub: ' ', wide: true });

  /* What the ramp is actually built on. The projection above says where the
     next weeks go; this says where the last six months went, and splits it by
     what put the kilometres on the legs — a 30 km week of matches and a 30 km
     week of runs are the same point on the line above and different training
     underneath it. */
  const pMix = panel({
    title: 'Distance over time',
    sub: 'every on-foot kilometre per week, split by modality',
    wide: true,
    kicker: 'Logged',
  });

  /* The week's committed distance, spread over its seven days.
     Everything else on this page answers "how far this week"; a week is not
     run in one piece, and the number that actually gets acted on is how far
     today. Matches are the fixed points — they are scheduled, and they put
     kilometres on the legs whether or not they were planned as running — so
     they are placed first and the rest of the target divides around them. */
  const pDays = panel({
    title: 'The week, day by day',
    sub: ' ',
    wide: true,
    kicker: 'This week',
    accent: 'run',
  });

  /* ── the hand-written week intent, kept and demoted ── */
  const thisWeekISO = weekStart(todayISO());
  const intent = {
    week: q.get('week_intent') || thisWeekISO,
    plans: readPlans(),
    latest: null,
    actual: null,
  };
  const picker = el('div', { class: 'weekpicker scroll', role: 'group', 'aria-label': 'Week to plan' });
  const pIntent = panel({ title: 'Intent', sub: ' ', wide: true });
  const pActual = panel({
    title: 'Against the record',
    sub: 'this week planned beside this week logged — neither is a score',
  });
  const pAll = panel({ title: 'Every plan on this device', sub: ' ' });

  /* Moved here from the Scoreboard. A goal is a thing you plan toward, so it
     belongs on the page where planning happens; the Scoreboard reads it and
     scores movement against it, but setting it there put a control on a page
     whose whole job is reporting. */
  /* No title: the section rule immediately above already says "Goal weight",
     and a panel repeating it is the same duplicate heading the league cards
     had. The rule keeps the heading; the panel keeps the control. */
  const pGoal = panel({
    sub: 'scored by movement toward it, never by the number itself',
    kicker: 'Setting',
  });

  /* The committed plan. Everything above it re-projects on every slider move,
     which is what makes it useless for holding yourself to anything; this is
     the copy that stops moving. Server-side, so it is the same plan on the
     phone as on the laptop. */
  /* One table, one row per week. There used to be two — "The plan, in numbers"
     and "Committed plan" — listing the same weeks with an overlapping set of
     columns, one of them called "Committed" in both. Two tables of the same
     thing is not two views of it; it is a puzzle. Committed, logged and
     proposed are three facts about one week, so they are three columns. */
  const pLocked = panel({
    title: 'The weeks, in numbers',
    sub: 'what is committed, what was logged, and what the slider would change',
    wide: true,
    kicker: 'Committed plan',
  });

  /* One page for everything planned. The week's counts and the running ramp
     used to be two routes, on the grounds that each deserved a single window
     and a single control. They are the same job — deciding what the next weeks
     look like — and splitting them meant the page called "Plan" held only the
     running half of the plan. `#/intent` still resolves here so old links and
     bookmarks keep working; it just lands on the whole page now.

     Order is by how often it is touched: the week's counts every Monday, the
     distance ramp when the block changes, the goal weight almost never. */
  /* Three groups, because there are three decisions on this page and they are
     not related to each other: how many sessions, how far on foot, and what the
     scale is heading toward. "Commit" sits inside the running group rather than
     beside it — it locks the running targets and nothing else, and as its own
     section it read like a third, separate thing. */
  host.append(
    el('div', { class: 'plan-head' }, [
      el('h2', { class: 'h2', text: 'Plan' }),
      el('p', { class: 'sub', text:
        'What the coming weeks are meant to look like: how many of each activity, how far on '
        + 'foot, and what the scale is heading toward. The counts and the goal are yours to set; '
        + 'the ramp is arithmetic, run on the server so the chart and the table cannot disagree.' }),
    ]),
    sectionGroup(
      {
        title: 'Sessions this week',
        note: 'how many of each — carried forward until you change it',
        accent: 'sa-indigo',
      },
      [picker, pIntent, el('div', { class: 'grid-2' }, [pActual, pAll])],
    ),
    sectionGroup(
      { title: 'Running distance', note: 'how far on foot, week by week', accent: 'run' },
      [
        pDays,
        plannerBar,
        planner,
        pMix,
        pLocked,
      ],
    ),
    sectionGroup(
      {
        title: 'Goal weight',
        note: 'what the bodyweight pillar on the Scoreboard measures against',
        accent: 'sa-plum',
      },
      [pGoal],
    ),
  );
  skeletonLines(3, pIntent.body);
  skeletonLines(3, pActual.body);
  skeletonLines(3, pAll.body);
  planner.append(
    pctBar, controls, baseBar,
    pRamp, pChart,
    sectionRule('Commit', 'lock these targets so they stop moving when the slider does'),
  );
  skeletonBlock(120, pRamp.body);
  skeletonBlock(280, pChart.body);
  skeletonBlock(240, pMix.body);
  skeletonLines(3, pLocked.body);
  skeletonBlock(150, pDays.body);
  buildGoal();

  /**
   * Show the ramp, or a one-line reason it is not showing.
   *
   * With nothing committed the planner *is* the page, so it stays open. With a
   * plan committed it folds to a sentence and a button: the committed table
   * below already answers "what am I doing", and a slider that re-projects on
   * every move only muddies it.
   */
  function paintPlanner() {
    const weeks = (state.locked && state.locked.weeks) || [];
    const open = !weeks.length || state.replanning;
    planner.hidden = !open;
    clear(plannerBar);
    if (open) {
      if (weeks.length) {
        const stop = el('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, [
          el('span', { text: 'Done re-planning' }),
        ]);
        stop.addEventListener('click', () => {
          state.replanning = false;
          paintPlanner();
          paintWeeks();
        });
        plannerBar.append(el('div', { class: 'plannerbar-in' }, [
          el('span', { class: 'plannerbar-say', text:
            'Re-planning. Nothing changes until you commit — the table below still shows what is '
            + 'committed today, with the proposal beside it.' }),
          stop,
        ]));
      }
      return;
    }

    const s2 = state.locked.summary || {};
    const go = el('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, [
      icon('edit'), el('span', { text: 'Re-plan' }),
    ]);
    go.addEventListener('click', () => {
      state.replanning = true;
      paintPlanner();
      paintWeeks();
      planner.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    plannerBar.append(el('div', { class: 'plannerbar-in' }, [
      el('span', { class: 'plannerbar-say', text:
        `${s2.weeks_locked} weeks committed`
        + `${state.locked.pct != null ? ` at ${fmt.one(state.locked.pct)}% a week` : ''}`
        + `${state.locked.base_km != null ? ` from a ${fmt.one(state.locked.base_km)} km base` : ''}`
        + '. The ramp is put away until you need it.' }),
      go,
    ]));
  }

  /* ── goal weight ── */

  function buildGoal() {
    clear(pGoal.body);
    const input = el('input', {
      class: 'input', type: 'number', min: '80', max: '400', step: '1',
      value: goalWeightLb() == null ? '' : String(goalWeightLb()), 'aria-label': 'Goal weight in pounds',
    });
    const save = el('button', { class: 'btn btn-primary', type: 'button', text: 'Save' });
    const say = el('p', { class: 'sub' });

    const describe = () => {
      say.textContent = goalWeightLb() == null
        ? 'No goal is set, so the Scoreboard has no bodyweight pillar. Set one and it scores which way '
          + 'the four-week average is moving — never the number itself.'
        : `The Scoreboard's bodyweight pillar scores which way the four-week average `
          + `is moving relative to ${goalWeightLb()} lb. It never scores the number itself, so a `
          + 'heavy week cannot be a failure — only a heavy week that is getting heavier.';
    };
    describe();

    save.addEventListener('click', () => {
      if (!setGoalWeightLb(input.value)) { toast('Enter a weight in pounds.'); return; }
      describe();
      toast(`Goal weight set to ${goalWeightLb()} lb.`);
    });

    pGoal.body.append(
      el('div', { class: 'row-wrap' }, [
        el('div', { class: 'suffixed' }, [input, el('span', { text: 'lb' })]), save,
      ]),
      say,
    );
  }

  /* ── controls ── */

  function syncPct() {
    pctOut.textContent = fmt.one(state.pct);
    slider.value = String(state.pct);
  }

  const debouncedLoad = debounce(() => load(), 120);

  slider.addEventListener('input', () => {
    state.pct = clampPct(slider.value, state.pct);
    /* The number under the thumb tracks the thumb; the fetch does not. */
    pctOut.textContent = fmt.one(state.pct);
    pushQuery();
    debouncedLoad();
  });
  slider.addEventListener('change', () => { state.pct = clampPct(slider.value, state.pct); load(); });

  function pushQuery() {
    setQuery({
      pct: state.pct === 10 ? '' : String(state.pct),
      weeks: state.weeks === 8 ? '' : String(state.weeks),
      deload: state.deload === 4 ? '' : String(state.deload),
      week: state.weekOf || '',
      base: state.baseKm == null ? '' : String(state.baseKm),
    });
  }

  function buildControls() {
    clear(controls);
    controls.append(
      el('div', { class: 'filter' }, [
        el('span', { class: 'lbl', text: 'Horizon' }),
        segmented(HORIZONS, state.weeks, (v) => {
          state.weeks = v; pushQuery(); buildControls(); load();
        }, 'How many weeks to project'),
      ]),
      el('div', { class: 'filter' }, [
        el('span', { class: 'lbl', text: 'Down weeks' }),
        segmented(DELOADS, state.deload, (v) => {
          state.deload = v; pushQuery(); buildControls(); load();
        }, 'How often to plan a lighter week'),
      ]),
    );
  }

  /**
   * Which week the ramp is built from — secondary, because the answer is
   * almost always "the obvious one".
   *
   * It stops being obvious on a Monday. A week that is one day old has almost
   * nothing in it, and a projection compounding upward from ~0 km is not a
   * plan, it is a division by nearly nothing. So when the current week is
   * still empty the page builds from the last complete week instead and says
   * that outright, in the control, where it can be changed back in one tap.
   */
  function buildBaseBar() {
    clear(baseBar);
    const b = state.bases;
    if (!b) return;

    /* Short labels, kilometres on the line below. Putting "· 29.2 km" inside
       each button pushed the control past a 390px screen. */
    const opts = [];
    if (b.thisWeek) opts.push([`week:${b.thisWeek.week_start}`, 'This week']);
    if (b.lastFull) opts.push([`week:${b.lastFull.week_start}`, 'Last full week']);
    opts.push(['custom', 'Set a number']);

    const active = state.baseKm != null
      ? 'custom'
      : `week:${state.weekOf || (b.thisWeek ? b.thisWeek.week_start : '')}`;

    const row = el('div', { class: 'filter' }, [
      el('span', { class: 'lbl', text: 'Build from' }),
      segmented(opts, active, (v) => {
        if (v === 'custom') {
          state.baseKm = state.data && state.data.base_km ? Number(state.data.base_km) : 20;
          state.weekOf = null;
        } else {
          state.baseKm = null;
          state.weekOf = v.slice(5);
        }
        state.autoBased = false;
        pushQuery();
        buildBaseBar();
        load();
      }, 'Which week the ramp is built from'),
    ]);
    baseBar.append(row);

    if (state.baseKm != null) {
      const input = el('input', {
        class: 'input basebar-km num', type: 'number', id: 'base-km',
        min: '0', max: '400', step: '0.5', inputmode: 'decimal',
        value: String(state.baseKm), 'aria-label': 'Base kilometres for the ramp',
      });
      const apply = () => {
        const n = Number(input.value);
        if (!Number.isFinite(n) || n < 0) { input.value = String(state.baseKm); return; }
        state.baseKm = Math.round(n * 10) / 10;
        pushQuery();
        load();
      };
      input.addEventListener('change', apply);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
      baseBar.append(el('div', { class: 'filter' }, [
        el('label', { class: 'lbl', for: 'base-km', text: 'Base' }),
        el('span', { class: 'basebar-field' }, [input, el('span', { class: 'basebar-u', text: 'km' })]),
      ]));
    }

    const known = [
      b.thisWeek ? `this week ${fmt.one(b.thisWeek.km)} km so far` : null,
      b.lastFull ? `last full week ${fmt.one(b.lastFull.km)} km` : null,
    ].filter(Boolean).join(' · ');
    const why = state.baseKm != null
      ? `Building from ${fmt.one(state.baseKm)} km, which you set by hand rather than from the record. On foot: ${known}.`
      : (state.weekOf && b.thisWeek && state.weekOf === b.thisWeek.week_start
        ? `On foot: ${known}. Building from a week still in progress, which counts only the days so far — `
          + 'the default is the last complete week for that reason.'
        : `On foot: ${known}. The default builds from the last complete week, never the one in progress.`);
    baseBar.append(el('p', { class: 'basebar-note', text: why }));
  }

  /* ── data ── */

  const planPath = () => `/api/plan/distance${qs({
    pct: state.pct,
    weeks: state.weeks,
    deload_every: state.deload,
    base_km: state.baseKm == null ? null : state.baseKm,
    week_of: state.weekOf,
  })}`;

  async function load() {
    const mine = ++seq;
    busy(true);
    const res = await api(planPath());
    busy(false);
    if (!alive || mine !== seq) return;
    if (!res.ok) {
      clear(pRamp.body); clear(pChart.body); clear(pTable.body);
      panelError(pRamp.body, res, 'The distance plan');
      return;
    }
    state.data = res.data;
    paint();
  }

  /* One reference fetch with no base override, purely so the "build from"
     control can name both weeks and their kilometres. */
  async function boot() {
    busy(true);
    const res = await api(`/api/plan/distance${qs({ pct: state.pct, weeks: state.weeks, deload_every: state.deload })}`);
    busy(false);
    if (!alive) return;
    if (!res.ok) {
      clear(pRamp.body); clear(pChart.body); clear(pTable.body);
      panelError(pRamp.body, res, 'The distance plan');
      return;
    }
    /* `history` is complete weeks only — the server never builds on a week in
       progress — so the live week comes from its own field rather than off the
       end of that list. Reading hist[-1] as "this week" was right until the
       server stopped including it, and would have quietly relabelled last week
       as this one. */
    const hist = res.data.history || [];
    state.bases = {
      thisWeek: res.data.current_week || null,
      lastFull: hist[hist.length - 1] || null,
    };

    /* The Monday workaround used to live here: if this week was still empty,
       re-request the plan built from the last complete week. The server does
       that by default now — always, not just when the current week is empty —
       so the second round trip is gone. */
    buildBaseBar();
    if (!state.weekOf && state.baseKm == null) { state.data = res.data; paint(); } else await load();
  }

  /* ── paint ── */

  /** Committed weeks by `week_start`. Empty until `/api/plan/locked` lands. */
  function lockedByWeek() {
    const weeks = (state.locked && state.locked.weeks) || [];
    return new Map(weeks.map((w) => [w.week_start, w]));
  }

  /**
   * What actually governs the weeks this projection covers.
   *
   * The projection re-plans from the last complete week every time the slider
   * moves, so it will happily restate a week that was committed weeks ago at a
   * different number — 25.0 against a locked 35.3, because the base week came
   * up short and the projection follows the record while the commitment does
   * not. Both are honest; only one is the target. This says which, before the
   * table rather than after it.
   */
  function commitmentNote(pts) {
    const locked = lockedByWeek();
    if (!locked.size || !pts.length) return null;
    const clash = pts.filter((p) => {
      const lw = locked.get(p.week_start);
      return lw && Math.abs(Number(lw.target_km) - Number(p.target_km)) >= 0.1;
    });
    if (!clash.length) return null;
    const first = clash[0];
    const lw = locked.get(first.week_start);
    return el('p', { class: 'plan-note', text:
      `${clash.length === 1 ? 'One week below is' : `${clash.length} weeks below are`} already committed, `
      + `and the commitment is the target: the week of ${fmt.dateY(first.week_start)} is `
      + `${fmt.one(lw.target_km)} km, not the ${fmt.one(first.target_km)} km proposed here. `
      + 'This projection re-plans from the last complete week whenever the slider moves; it becomes '
      + 'the plan only if you commit it, which replaces what is committed from this week forward.' });
  }

  function paint() {
    const d = state.data;
    figs.forEach((f) => f.destroy && f.destroy());
    figs = [];
    syncPct();
    buildBaseBar();

    /* With no base there is no projection, so the chart is eight logged weeks
        and nothing else — and it says so rather than claiming a window it did
        not draw. */
    const projects = Number(d.base_km) > 0
      && (d.points || []).some((p) => Number(p.target_km) > 0);
    /* One window for the page, set by the horizon control. The chart draws the
       logged weeks and the projection on a single axis, so it takes the single
       continuous span the server publishes for exactly that — it used to print
       both halves either side of an arrow, which read as two periods on a page
       that has one control. Which side of the break is which is said by the
       chart itself: there is a labelled divider, a dashed line and a legend. */
    const tf = d.timeframes || {};
    for (const p of [pRamp, pChart, pTable, pLocked]) {
      setTimeframe(p, projects ? (tf.span || tf.projection) : tf.history);
    }

    paintRamp(d);
    paintChart(d);
    paintTable(d);
  }

  /**
   * The multiplier, given the room it deserves.
   *
   * "Ten per cent" reads as small and "1.77×" does not, and they are the same
   * sentence. It is the figure that stops a plan being agreed to by accident,
   * so it is the largest thing on the page, with the server's own sentence
   * printed underneath it in words.
   */
  function paintRamp(d) {
    clear(pRamp.body);
    const s = d.summary || {};
    const pts = d.points || [];

    if (!pts.length || s.multiplier == null || !d.base_km) {
      pRamp.body.append(el('p', { class: 'empty', text: d.note || 'Nothing to project yet.' }));
      pRamp.body.append(el('p', { class: 'sub', text:
        'Pick a week with distance in it, or set a base by hand, and the ramp will build from that.' }));
      return;
    }

    const peakPoint = pts.find((p) => p.target_km === s.peak_km) || pts[pts.length - 1];
    const last = pts[pts.length - 1];

    /* The server's sentence is the sentence. It already names the percentage,
       the horizon, the peak and the multiplier, so writing a second one beside
       it would be two voices saying the same thing slightly differently —
       which is how a figure ends up existing in two places. */
    pRamp.body.append(el('div', { class: 'mult' }, [
      el('div', { class: 'mult-fig' }, [
        el('div', { class: 'mult-n' }, [
          el('b', { class: 'num', text: fmt.two(s.multiplier) }),
          el('u', { text: '×' }),
        ]),
        el('p', { class: 'mult-cap', text: `peak week, against ${fmt.one(d.base_km)} km now` }),
      ]),
      el('div', { class: 'mult-say' }, [
        d.note ? el('p', { class: 'mult-lead', text: d.note }) : null,
      ]),
    ]));

    pRamp.body.append(statStrip([
      {
        label: 'Peak week', value: fmt.one(s.peak_km), unit: 'km',
        note: `week of ${fmt.dateY(peakPoint.week_start)}`,
      },
      {
        label: 'Last week of the plan', value: fmt.one(s.final_km), unit: 'km',
        note: `week of ${fmt.dateY(last.week_start)}${last.is_deload ? ' · a planned down week' : ''}`,
      },
      {
        label: 'Total over the plan', value: fmt.int(s.total_km), unit: 'km',
        note: `across ${pts.length} week${pts.length === 1 ? '' : 's'}`,
      },
      {
        label: 'Highest acute : chronic', value: s.max_acwr ? fmt.two(s.max_acwr) : '—',
        note: 'a position on a scale, not a verdict',
      },
    ]));

    pRamp.body.append(el('p', { class: 'sub', text:
      `On foot means ${ON_FOOT.filter((k) => k !== 'other').map(kindName).map((k) => k.toLowerCase()).join(', ')}, `
      + 'and anything logged as other that carries a distance. '
      + 'Biking is excluded by design — the legs are what the ramp is about. '
      + `Down weeks are set to ${Math.round((d.deload_factor ?? 0.7) * 100)}% of the week before them.` }));
  }

  /**
   * One line: eight logged weeks continuing into the projection, on one scale,
   * with a named break where the record stops. Solid for what happened, dashed
   * and lighter for what is only planned — and the two share a point, so it
   * reads as one continuous thing rather than two charts side by side.
   */
  function paintChart(d) {
    clear(pChart.body);
    const hist = d.history || [];
    const pts = d.points || [];
    if (!hist.length && !pts.length) {
      pChart.body.append(emptyNote('Nothing on record and nothing to project.'));
      return;
    }

    const solid = colorOf('run');
    /* Lighter, not a second hue: the plan is the same quantity, less certain. */
    const planned = mixColors(solid, token('surface'), 0.32);

    /* With no base there is no projection — and a flat line of zeroes labelled
       "0.0 peak" is not an empty state, it is an unrendered one. The eight
       logged weeks are still worth drawing, so they are, on their own. */
    if (!(Number(d.base_km) > 0 && pts.some((p) => Number(p.target_km) > 0))) {
      const bare = el('div', { class: 'fig-primary' });
      pChart.body.append(bare);
      figs.push(figure(bare, {
        type: 'line',
        aria: `On-foot distance per week over the last ${hist.length} logged weeks`,
        height: 260, unit: 'km', periodLabel: 'Week of', zeroBase: true,
        series: [{ key: 'logged', label: 'Logged', color: solid }],
        points: hist.map((h) => ({
          key: h.week_start, label: fmt.date(h.week_start), values: { logged: Number(h.km) },
        })),
        format: (v) => fmt.one(v),
        formatShort: (v) => fmt.compact(v),
        emptyText: 'Nothing on record for these modalities.',
      }));
      pChart.body.append(el('p', { class: 'sub', text:
        'Only the logged weeks are drawn — there is no base to project from, and a flat line of zeroes '
        + 'would be a plan-shaped hole rather than a plan.' }));
      return;
    }

    const anchorIdx = hist.findIndex((h) => h.week_start === d.base_week);
    const joins = anchorIdx >= 0 && Math.abs(Number(hist[anchorIdx].km) - Number(d.base_km)) < 0.15;

    const rows = [];
    hist.forEach((h, i) => {
      rows.push({
        key: h.week_start,
        label: fmt.date(h.week_start),
        values: {
          logged: Number(h.km),
          plan: joins && i === anchorIdx ? Number(d.base_km) : null,
        },
        note: 'logged',
      });
    });
    const breakAt = hist.length ? hist.length - 1 : 0;
    /* The break falls at the end of the record, which is the last *complete*
       week — so the week being lived sits on the projected side of it. Labelled
       "plan", that read as though today were already in the past. It says what
       the line actually is: everything right of here has not happened yet,
       starting with this week. */
    const dividerLabel = 'now \u2192 planned';

    for (const p of pts) {
      rows.push({
        key: p.week_start,
        label: fmt.date(p.week_start),
        values: { logged: null, plan: Number(p.target_km) },
        mark: p.is_deload ? { key: 'plan' } : null,
        note: [
          p.is_deload ? 'planned down week' : `${fmt.signed(p.add_km, ' km')} on the week before`,
          p.acwr == null ? null : `acute:chronic ${fmt.two(p.acwr)} · ${p.acwr_band}`,
        ].filter(Boolean).join(' · '),
      });
    }

    const s = d.summary || {};
    const peakIdx = pts.findIndex((p) => p.target_km === s.peak_km);
    const labelPoints = [];
    if (peakIdx >= 0 && peakIdx !== pts.length - 1) {
      labelPoints.push({ index: hist.length + peakIdx, key: 'plan', text: `${fmt.one(s.peak_km)} peak`, dy: -11 });
    }
    if (pts.length) {
      labelPoints.push({ index: rows.length - 1, key: 'plan', text: fmt.one(s.final_km) });
    }

    const chartHost = el('div', { class: 'fig-primary' });
    pChart.body.append(chartHost);
    figs.push(figure(chartHost, {
      type: 'line',
      aria: `On-foot distance per week: ${hist.length} logged weeks followed by a `
        + `${pts.length}-week projection at ${fmt.one(state.pct)} per cent a week`,
      height: 300, unit: 'km', periodLabel: 'Week of', zeroBase: true,
      series: [
        { key: 'logged', label: 'Logged', color: solid },
        { key: 'plan', label: 'Planned', color: planned, dashed: true },
      ],
      legendExtra: pts.some((p) => p.is_deload)
        ? [{ label: 'Planned down week', shape: 'hollow', color: planned }]
        : null,
      divider: { index: breakAt, label: dividerLabel },
      labelPoints,
      points: rows,
      format: (v) => fmt.one(v),
      formatShort: (v) => fmt.compact(v),
      emptyText: 'Nothing to plot.',
    }));

    pChart.body.append(el('p', { class: 'sub', text:
      'Left of the break is what is on record; right of it is arithmetic. '
      + 'A square marks a week the plan deliberately drops — those are planned, not missed.' }));
  }

  /* Kept as a shim: `paint()` calls it whenever the projection changes, and
     the merged table below is what actually redraws. */
  function paintTable() { paintWeeks(); }

  /**
   * On-foot kilometres per week, stacked by modality.
   *
   * Straight from `/api/distance`, whose `points[].by_kind` already splits it
   * and whose `on_foot_kinds` decides what counts — the same list the target
   * on the Running page is measured against, so this chart and that number
   * cannot disagree about what "on foot" means.
   */
  async function loadMix() {
    const res = await api('/api/distance?weeks=26');
    if (!alive) return;
    clear(pMix.body);
    if (!res.ok) { panelError(pMix.body, res, 'On-foot distance'); return; }

    const d = res.data;
    const pts = (d.points || []).filter((x) => !x.in_progress);
    if (!pts.length) {
      pMix.body.append(emptyNote('No on-foot distance on record yet.'));
      return;
    }
    setTimeframe(pMix, d.timeframe);

    const kinds = (d.on_foot_kinds || ON_FOOT)
      .filter((k) => pts.some((x) => (x.by_kind || {})[k] > 0));
    const totals = Object.fromEntries(kinds.map((k) => [
      k, pts.reduce((a, x) => a + ((x.by_kind || {})[k] || 0), 0),
    ]));
    const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;

    const host2 = el('div');
    pMix.body.append(host2);
    figs.push(figure(host2, {
      type: 'columns',
      aria: 'On-foot kilometres per week, split by modality',
      height: 260, unit: 'km', periodLabel: 'Week of',
      series: kinds.map((k) => ({
        key: k, label: kindName(k), color: colorOf(k),
        total: `${Math.round((totals[k] / grand) * 100)}%`,
      })),
      points: pts.map((x) => ({
        key: x.week_start, label: fmt.date(x.week_start),
        values: x.by_kind || {}, total: x.km,
        note: x.matches ? `${x.matches} match${x.matches === 1 ? '' : 'es'}` : null,
      })),
      format: (v) => `${fmt.one(v)} km`,
      formatShort: (v) => fmt.one(v),
      emptyText: 'No on-foot distance in this window.',
    }));

    pMix.body.append(el('p', { class: 'sub', text:
      `${fmt.one(grand)} km over ${pts.length} finished weeks — `
      + kinds.map((k) => `${kindName(k)} ${fmt.one(totals[k])}`).join(', ')
      + '. The week in progress is left out: a partial week plotted beside whole '
      + 'ones reads as a collapse rather than as a Tuesday.' }));
  }

  /* ══ committed plan ════════════════════════════════════════════════════ */

  /**
   * Lock the projection currently on screen.
   *
   * Commits exactly the parameters the controls are set to, so what gets
   * written down is what is being looked at. Locking covers the week being
   * lived and the ones after it — the server refuses to rewrite weeks already
   * past, which is what keeps a missed target on the record instead of
   * quietly restating it.
   */
  async function lockPlan() {
    const path = `/api/plan/lock${qs({
      pct: state.pct,
      weeks: state.weeks,
      deload_every: state.deload,
      base_km: state.baseKm == null ? null : state.baseKm,
      week_of: state.weekOf,
    })}`;
    busy(true);
    const res = await api(path, { method: 'POST' });
    busy(false);
    if (!alive) return;
    if (!res.ok) { toast(res.error || 'Could not commit the plan.'); return; }
    state.locked = res.data;
    toast(`Committed ${res.data.locked} weeks.`);
    paintLocked();
  }

  async function unlockPlan() {
    busy(true);
    const res = await api('/api/plan/lock', { method: 'DELETE' });
    busy(false);
    if (!alive) return;
    if (!res.ok) { toast(res.error || 'Could not clear the plan.'); return; }
    state.locked = null;
    toast('Committed plan cleared.');
    await loadLocked();
  }

  async function loadLocked() {
    const res = await api('/api/plan/locked');
    if (!alive) return;
    state.locked = res.ok ? res.data : null;
    if (!res.ok) { clear(pLocked.body); panelError(pLocked.body, res, 'The committed plan'); return; }
    paintLocked();
    /* The projection is usually on screen before this resolves, and it cannot
       name what is committed until it has this. Repaint it rather than leave
       a table whose Committed column never appeared. */
    if (state.data) paintTable(state.data);
    /* Same for the day grid: it divides the committed target, so until this
       lands it has nothing to divide. */
    buildDays();
  }

  const lockBtn = () => el('button', {
    class: 'btn btn-primary', type: 'button',
    text: state.locked && state.locked.weeks && state.locked.weeks.length
      ? 'Re-commit from this week' : 'Commit this plan',
    on: { click: lockPlan },
  });

  function paintLocked() { paintWeeks(); paintPlanner(); }

  /**
   * One table, one row per week.
   *
   * There used to be two: a projection table and a committed table, listing
   * the same weeks with an overlapping set of columns and the word "Committed"
   * appearing in both. Reading them meant holding one in your head while
   * looking at the other, and the whole point of a plan is that you can see it.
   *
   * Committed, logged and proposed are three facts about a single week, so the
   * week gets one row and they get three columns. `Committed` is what is
   * locked; `Logged` is what happened, blank until the week is over; `Proposed`
   * is what the slider above would write if you re-commit, and it only prints
   * when it differs from what is already committed — a column full of numbers
   * identical to the one beside it is noise.
   */
  function paintWeeks() {
    const d = state.data;
    const lockedData = state.locked;
    const lockedWeeks = (lockedData && lockedData.weeks) || [];
    const pts = (d && d.points) || [];
    if (!lockedWeeks.length && !pts.length) return;

    clear(pLocked.body);

    const proposed = new Map(pts.map((x) => [x.week_start, x]));
    const committed = new Map(lockedWeeks.map((w) => [w.week_start, w]));
    const weeks = [...new Set([...committed.keys(), ...proposed.keys()])].sort();

    const s2 = (lockedData && lockedData.summary) || {};
    pLocked.head.querySelector('.sub').textContent = lockedWeeks.length
      ? `${s2.weeks_locked} weeks committed${lockedData.pct != null ? ` at ${fmt.one(lockedData.pct)}% a week` : ''}`
        + `${lockedData.base_km != null ? ` from a ${fmt.one(lockedData.base_km)} km base` : ''}`
      : 'Nothing committed yet — the column below is what the slider would write';

    if (!lockedWeeks.length) {
      pLocked.body.append(emptyNote(
        'The ramp above re-projects every time you move the slider, so the target for any week is '
        + 'whatever the slider says today. Committing writes the numbers down: they stop moving, '
        + 'and "did I hit it?" gets an answer.',
      ));
    } else if (s2.weeks_done) {
      /* Finished weeks only. A week two days in would drag the comparison down
         by five days of not having happened yet. */
      pLocked.body.append(statStrip([
        { label: `Committed, ${s2.weeks_done} finished ${s2.weeks_done === 1 ? 'week' : 'weeks'}`,
          value: fmt.one(s2.target_km_done), unit: 'km' },
        { label: 'Logged over the same weeks', value: fmt.one(s2.actual_km_done), unit: 'km' },
        { label: 'Difference',
          value: fmt.signed(s2.actual_km_done - s2.target_km_done, ''), unit: 'km' },
      ]));
    }

    /* Only while actually re-planning. A permanent "Proposed" column is a
       column of numbers that disagree with the committed ones by construction
       — the ramp rebuilds from the last complete week every time — so it read
       as an error in the plan rather than as a hypothetical. */
    const differs = (!committed.size && proposed.size) || (state.replanning && weeks.some((w) => {
      const c = committed.get(w); const x = proposed.get(w);
      return c && x && Math.abs(Number(c.target_km) - Number(x.target_km)) >= 0.1;
    }));

    const wrap = el('div', { class: 'table-wrap scroll' });
    const table = el('table', { class: 'data-table' });
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Week of' }),
      el('th', { scope: 'col', class: 'num', text: 'Committed' }),
      el('th', { scope: 'col', class: 'num', text: 'Logged' }),
      el('th', { scope: 'col', class: 'num', text: 'Difference' }),
      differs ? el('th', { scope: 'col', class: 'num', text: 'Proposed' }) : null,
      el('th', { scope: 'col', class: 'wrap', text: 'State' }),
    ].filter(Boolean))]));

    const body = el('tbody');
    for (const w of weeks) {
      const c = committed.get(w);
      const x = proposed.get(w);
      /* Whose down week? The committed plan and the live projection each run
         their own "every 4th" count from their own base, so their deload weeks
         fall out of phase — and OR-ing the two flags tagged Sep 7 as a down
         week while the number printed beside it was its committed 42.7, the
         biggest figure in the column. The row shows what is committed, so the
         tag describes what is committed; the proposal only speaks for weeks
         that have none. */
      /* Strictly the committed plan. Falling back to the projection for an
         uncommitted week put a "down week" tag on Oct 5 — a row whose target
         is an em dash, because nothing is committed for it — and landed it
         directly under the genuinely committed deload on Sep 28. Two adjacent
         down weeks, from two plans whose every-fourth-week counts start at
         different bases.

         A week with no committed target cannot be a down week of anything.
         Committed deloads are every fourth by construction, so with only this
         source they can never be adjacent. */
      const deload = !!(c && c.is_deload);
      /* Where the week sits relative to now. Taken from the server's own
         `state` where the week is committed, and from the date otherwise, so
         an uncommitted future week is still visibly future. */
      /* The server's own `state` where the week is committed — it knows what
         has been logged — and the shared rule otherwise, so an uncommitted
         week still reads past or future rather than blank. */
      const when = c ? c.state : weekPosition(w, thisWeekISO);
      const state_ = c
        ? (c.state === 'done' ? 'finished'
          : c.state === 'current' ? 'this week, still running' : 'still ahead')
        : (when === 'done' ? 'past, never committed' : 'not committed');
      const gap = c && x && Math.abs(Number(c.target_km) - Number(x.target_km)) >= 0.1;
      /* Logged is coloured by how close it came to what was committed, which
         is the one question a row of two identical-looking numbers could not
         answer: 22.7 beside 32.1 and 29.4 beside 35.3 were the same shade of
         ink, so "did I make it" needed arithmetic every time. Only where the
         week has actually run — a week two days in has not missed anything. */
      /* Already past the committed target, whether or not the week has run
         out of days. */
      const over = !!(c && c.actual_km != null && Number(c.target_km) > 0
        && Number(c.actual_km) >= Number(c.target_km));
      const hitTone = c && c.actual_km != null && Number(c.target_km) > 0
        && (c.state === 'done' || c.state === 'current')
        ? attainTone((Number(c.actual_km) / Number(c.target_km)) * 100)
        : null;

      body.append(el('tr', { class: `wk-${when}${deload ? ' is-deload' : ''}` }, [
        el('th', { scope: 'row', class: 'num nowrap' }, [
          el('span', { text: fmt.dateY(w) }),
          when === 'current' ? document.createTextNode(' ') : null,
          when === 'current' ? nowTag() : null,
        ]),
        el('td', { class: 'num', text: c ? fmt.one(c.target_km) : '—' }),
        el('td', { class: `num${hitTone ? ` attain tone-${hitTone}` : ''}`,
          text: c && c.actual_km != null ? fmt.one(c.actual_km) : '—' }),
        /* Blank until the week is over — but only for a shortfall. A week two
           days in is not behind, because the rest of it has not happened yet;
           a week already *past* its target is past it, and no amount of
           remaining days can undo that. Hiding an overage until Sunday told
           you nothing while you were over, which is the one moment the column
           has something certain to say. */
        el('td', {
          class: `num${over ? ` attain tone-${attainTone(100)}` : ''}`,
          text: c && c.delta_km != null ? fmt.signed(c.delta_km, '')
            : (over ? fmt.signed(Number(c.actual_km) - Number(c.target_km), '') : '—'),
        }),
        differs
          ? el('td', { class: `num${gap ? ' is-changed' : ''}`, text: x ? fmt.one(x.target_km) : '—' })
          : null,
        /* "down week" used to hang off the date, which forced that cell onto
           two lines and left every deload row taller than its neighbours with a
           tag pointing the opposite way from the date above it. It is a fact
           about the *state* of the week, so it lives in the state column and
           every row stays one line high. */
        /* The space between these two is a real text node, not a margin. Two
           adjacent spans with nothing between them concatenate in
           `textContent`: the cell read "still aheaddown week" to anything that
           reads text rather than pixels — copy and paste, a screen reader, the
           table view, and the audit rule written to catch exactly this. A 7px
           margin makes it *look* separated without making it *be* separated. */
        el('td', { class: 'wrap' }, [
          el('span', { class: `wkstate wk-${when}`, text: state_ }),
          deload ? document.createTextNode(' ') : null,
          deload ? document.createTextNode(' ') : null,
          deload ? el('span', { class: 'downtag', text: 'down week' }) : null,
        ].filter(Boolean)),
      ].filter(Boolean)));
    }
    table.append(body);
    wrap.append(table);
    pLocked.body.append(wrap);

    pLocked.body.append(el('p', { class: 'sub', text:
      (differs && committed.size
        ? 'Proposed is what the slider above would write if you re-commit; it only appears when it '
          + 'differs from what is committed. '
        : '')
      + 'A shortfall appears only once a week has finished — a week two days in is not behind, it '
      + 'is two days in — but a week already past its target says so straight away, because that '
      + 'cannot be undone by the days still to come. Re-committing replaces this week and the ones after it and leaves earlier '
      + 'weeks exactly as they were, so a target you set and missed stays on the record.' }));

    pLocked.body.append(el('div', { class: 'plan-actions' }, [
      lockBtn(),
      committed.size
        ? el('button', { class: 'btn', type: 'button', text: 'Clear', on: { click: unlockPlan } })
        : null,
    ].filter(Boolean)));
  }

  /* ══ week intent — unchanged behaviour, folded away ════════════════════ */

  function buildPicker() {
    clear(picker);
    for (let i = -2; i <= 7; i++) {
      const start = addDays(thisWeekISO, i * 7);
      const plan = intent.plans[start];
      const plannedN = plan ? sumPlan(plan) : 0;
      const label = i === 0 ? 'This week' : i === 1 ? 'Next week' : fmt.date(start);
      /* Same three states as every other week on the site. The picker used to
         mark only the selected chip, so finding today meant reading dates. */
      const when = weekPosition(start, thisWeekISO);
      picker.append(el('button', {
        class: `chip weekchip wk-${when}`, type: 'button',
        'aria-pressed': String(start === intent.week),
        title: when === 'done' ? 'a week that has finished'
          : when === 'current' ? 'the week you are in'
            : 'a week that has not started',
        on: {
          click: () => {
            intent.week = start;
            buildPicker();
            buildIntent();
            loadActual();
            loadDays();
          },
        },
      }, [
        el('span', { text: label }),
        plannedN ? el('b', { class: 'num', text: String(plannedN) }) : null,
      ]));
    }
  }

  function buildIntent() {
    const start = intent.week;
    const end = addDays(start, 6);
    /* Carried forward, not blank. These targets barely move week to week, and
       making them be retyped every Monday is how a planning feature stops
       being used by the second week. An untouched week shows the last one it
       inherits from; saving makes the numbers its own. */
    const plan = weekIntent(start, intent.plans);
    clear(pIntent.body);
    pIntent.head.querySelector('.sub').textContent =
      `${fmt.dateY(start)} – ${fmt.dateY(end)}${start === thisWeekISO ? ' · the current week' : ` · ${fmt.relDays(start)}`}`;

    if (plan.inherited) {
      pIntent.body.append(el('p', { class: 'plan-note', text:
        `Carried forward from the week of ${fmt.dateY(plan.week)}. These apply until you change them — `
        + 'save to make them this week\'s own.' }));
    }

    const grid = el('div', { class: 'plangrid' });
    const draft = { kinds: { ...(plan.kinds || {}) }, note: plan.note || '' };

    for (const k of KINDS) {
      const value = draft.kinds[k] || 0;
      const out = el('output', { class: 'plan-n num', text: String(value), for: `plan-${k}` });
      const bump = (delta) => {
        const next = Math.max(0, Math.min(21, (draft.kinds[k] || 0) + delta));
        draft.kinds[k] = next;
        out.textContent = String(next);
        row.classList.toggle('has', next > 0);
      };
      const row = el('div', { class: `planrow${value > 0 ? ' has' : ''}` }, [
        el('span', { class: 'planrow-k' }, [
          el('i', { style: `background:${colorOf(k)}` }),
          el('span', { text: kindName(k) }),
        ]),
        el('div', { class: 'stepper stepper-sm' }, [
          el('button', { class: 'btn stepper-btn', type: 'button', text: '−',
            'aria-label': `One fewer planned ${kindName(k)}`, on: { click: () => bump(-1) } }),
          out,
          el('button', { class: 'btn stepper-btn', type: 'button', text: '+', id: `plan-${k}`,
            'aria-label': `One more planned ${kindName(k)}`, on: { click: () => bump(1) } }),
        ]),
      ]);
      grid.append(row);
    }

    const note = el('textarea', {
      class: 'input', id: 'plan-note', rows: '3',
      placeholder: 'What this week is for. Deload, a race, two games, whatever it is.',
    });
    note.value = draft.note;
    note.addEventListener('input', () => { draft.note = note.value; });

    const save = el('button', { class: 'btn btn-primary', type: 'button' }, [
      icon('check'), el('span', { text: 'Save plan' }),
    ]);
    save.addEventListener('click', () => {
      const kinds = {};
      for (const [k, v] of Object.entries(draft.kinds)) if (v > 0) kinds[k] = v;
      if (!Object.keys(kinds).length && !draft.note.trim()) delete intent.plans[start];
      else intent.plans[start] = { kinds, note: draft.note.trim() };
      if (!writePlans(intent.plans)) { toast('Could not save — storage is unavailable.'); return; }
      toast('Plan saved on this device.');
      buildPicker();
      buildAll();
      buildActual();
    });

    const clearBtn = el('button', { class: 'btn btn-quiet', type: 'button', text: 'Clear this week' });
    clearBtn.addEventListener('click', () => {
      delete intent.plans[start];
      writePlans(intent.plans);
      buildPicker(); buildIntent(); buildAll(); buildActual();
      toast('Plan cleared.');
    });

    pIntent.body.append(
      grid,
      el('div', { class: 'field field-wide' }, [
        el('label', { class: 'lbl', for: 'plan-note', text: 'Plan note' }), note,
      ]),
      el('div', { class: 'plan-actions' }, [save, clearBtn]),
    );
  }

  async function loadActual() {
    const end = addDays(intent.week, 6);
    const future = intent.latest && end > intent.latest;
    intent.future = !!future;
    /* Nothing is fetched for a week that has not started. A reference column —
       last week's counts beside next week's plan — was tried and removed: you
       are setting a plan, and putting another week's numbers next to it moves
       the goalposts mid-decision. The panel shows the plan. */
    if (future) { intent.actual = null; buildActual(); return; }
    busy(true);
    const res = await api(`/api/summary${qs({ week_of: end, weeks: 1 })}`);
    busy(false);
    if (!alive) return;
    intent.actual = res.ok ? res.data : null;
    if (res.ok) intent.latest = res.data.latest_week_end;
    buildActual();
  }

  function buildActual() {
    clear(pActual.body);
    const start = intent.week;
    /* Carried forward, like the editor above it. Reading `intent.plans[start]`
       directly meant a week that inherits its counts showed "—" in the Planned
       column while the editor two panels up showed the numbers it inherited —
       the same week, planned and not planned at once. */
    const plan = weekIntent(start, intent.plans);
    const future = !!intent.future;

    const logged = (intent.actual && intent.actual.sessions_this_week) || {};
    const keys = [...new Set([...Object.keys(plan.kinds || {}), ...Object.keys(logged)])];
    if (!keys.length) {
      pActual.body.append(emptyNote('Nothing planned and nothing logged for this week.'));
      return;
    }

    pActual.head.querySelector('.sub').textContent = future
      ? 'what this week is set to — it has not started yet'
      : 'this week planned beside this week logged — neither is a score';

    const table = el('table', { class: 'data-table' });
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Modality' }),
      el('th', { scope: 'col', class: 'num', text: 'Planned' }),
      future ? null : el('th', { scope: 'col', class: 'num', text: 'Logged' }),
    ].filter(Boolean))]));
    const body = el('tbody');
    for (const k of KINDS.filter((x) => keys.includes(x))) {
      body.append(el('tr', {}, [
        el('th', { scope: 'row' }, [
          el('span', { class: 'kdot', style: `background:${colorOf(k)}` }),
          el('span', { text: ` ${kindName(k)}` }),
        ]),
        el('td', { class: 'num', text: String(plan.kinds?.[k] ?? '—') }),
        /* Same question, same colours: did this modality make its count.
           There is no such column on a week that has not started. */
        future ? null : el('td', {
          class: `num${plan.kinds?.[k] > 0
            ? ` attain tone-${attainTone(((logged[k] ?? 0) / plan.kinds[k]) * 100)}` : ''}`,
          text: String(logged[k] ?? 0),
        }),
      ].filter(Boolean)));
    }
    table.append(body);
    pActual.body.append(table);
    if (plan.note) {
      pActual.body.append(el('p', { class: 'sub', text: `Plan note: ${plan.note}` }));
    }
  }

  function buildAll() {
    clear(pAll.body);
    const entries = Object.entries(intent.plans)
      .filter(([, p]) => sumPlan(p) > 0 || p.note)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1));
    pAll.head.querySelector('.sub').textContent =
      `${entries.length} week${entries.length === 1 ? '' : 's'} planned · stored in this browser`;
    if (!entries.length) {
      pAll.body.append(emptyNote('No plans written yet.'));
      return;
    }
    for (const [start, p] of entries.slice(0, 20)) {
      const bits = KINDS.filter((k) => p.kinds?.[k])
        .map((k) => `${p.kinds[k]} ${kindName(k).toLowerCase()}`).join(', ');
      pAll.body.append(el('button', {
        class: 'planitem', type: 'button',
        on: { click: () => { intent.week = start; buildPicker(); buildIntent(); loadActual(); } },
      }, [
        el('span', { class: 'planitem-d num', text: fmt.dateY(start) }),
        el('span', { class: 'planitem-b', text: bits || '—' }),
        p.note ? el('span', { class: 'planitem-n', text: p.note }) : null,
      ]));
    }
  }

  /* ══ the week, day by day ══════════════════════════════════════════════ */

  const days = {
    saved: readDays(),
    logged: new Map(),     // date -> on-foot km actually logged
    loggedRuns: 0,
    fixtures: [],          // scheduled matches, all leagues
    typicalSoccer: null,   // median match distance, from the record
    typicalN: 0,
  };

  /* On foot, not runs-only. The committed target counts every kilometre on the
     legs — `ramp.ON_FOOT`, matches and quick feet included — so a day grid that
     divided it while counting only runs would be dividing one number by the
     denominator of another. */
  async function loadDays() {
    const start = intent.week;
    const end = addDays(start, 6);
    const [sess, hist, lg] = await Promise.all([
      api(`/api/sessions${qs({ from: start, to: end, limit: 100 })}`),
      days.typicalSoccer == null
        ? api(`/api/sessions${qs({ kind: 'soccer', limit: 60 })}`)
        : Promise.resolve(null),
      days.fixtures.length ? Promise.resolve(null) : api('/api/leagues'),
    ]);
    if (!alive) return;

    days.logged = new Map();
    days.loggedRuns = 0;
    if (sess.ok) {
      for (const x of sess.data.items || []) {
        if (x.kind === 'run') days.loggedRuns += 1;
        if (!ON_FOOT.includes(x.kind) || !x.distance_km) continue;
        days.logged.set(x.date, (days.logged.get(x.date) || 0) + Number(x.distance_km));
      }
    }

    /* What a match costs, taken from the record rather than assumed. The median
       and not the mean: one 0.52 km match — a watch started late — drags an
       average down in a way it does not drag the next match down. */
    if (hist && hist.ok) {
      const km = (hist.data.items || [])
        .map((x) => Number(x.distance_km))
        .filter((n) => n > 0);
      days.typicalSoccer = median(km);
      days.typicalN = km.length;
    }

    if (lg && lg.ok) {
      for (const league of lg.data.leagues || []) {
        for (const f of league.my_fixtures || []) {
          if (!f.played) days.fixtures.push({ ...f, league: league.name, team: league.my_team });
        }
      }
    }
    buildDays();
  }

  const weekFixtures = (start) => {
    const end = addDays(start, 6);
    const out = new Map();
    for (const f of days.fixtures) {
      if (f.date >= start && f.date <= end && !out.has(f.date)) out.set(f.date, f);
    }
    return out;
  };

  const weekEntry = (start) => {
    const w = days.saved[start] || {};
    return { km: w.km || {}, match: w.match || [] };
  };

  /** The seven days of the week on screen, with everything known about each. */
  function weekRows(start) {
    const today = todayISO();
    const { km, match } = weekEntry(start);
    const fixtures = weekFixtures(start);
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      const loggedKm = days.logged.get(date) || 0;
      const fixture = fixtures.get(date) || null;
      rows.push({
        date,
        when: date < today ? 'done' : date === today ? 'now' : 'ahead',
        loggedKm,
        fixture,
        marked: match.includes(date),
        /* Published or told to us, it costs the same. */
        isMatch: !!fixture || match.includes(date),
        planned: km[date] == null ? null : Number(km[date]),
        /* A day that has been run is not a day to plan. It contributes what it
           contributed; the rest of the week divides around it. */
        settled: loggedKm > 0,
      });
    }
    return rows;
  }

  /** Write one day's planned distance, dropping empties so a week can go back
      to having no split at all rather than seven zeroes. */
  function setDay(start, date, value) {
    const w = days.saved[start] || (days.saved[start] = {});
    w.km = w.km || {};
    if (value == null) delete w.km[date];
    else w.km[date] = value;
    if (!Object.keys(w.km).length && !(w.match || []).length) delete days.saved[start];
    if (!writeDays(days.saved)) toast('Could not save — storage is unavailable.');
  }

  /** Mark or unmark a day as one you are playing on. */
  function toggleMatch(start, date) {
    const w = days.saved[start] || (days.saved[start] = {});
    w.match = w.match || [];
    const at = w.match.indexOf(date);
    if (at >= 0) {
      w.match.splice(at, 1);
      /* The distance was put there for the match, so it goes with it. */
      if (w.km) delete w.km[date];
    } else {
      w.match.push(date);
      w.km = w.km || {};
      w.km[date] = Math.round((days.typicalSoccer || 0) * 10) / 10;
    }
    if (!Object.keys(w.km || {}).length && !w.match.length) delete days.saved[start];
    if (!writeDays(days.saved)) toast('Could not save — storage is unavailable.');
    buildDays();
  }

  /* Rounded here, once, and every total built from the rounded value.
     Summing the raw distances and rounding the sum prints a total the days
     visibly do not add up to: the week of 17 Aug logs 35.35 km across five
     days, which is 35.3 on the tiles and 35.4 in a raw sum — one panel, two
     figures for one quantity, the oldest failure in this codebase. The cells
     print exactly what this returns, so the column and its total cannot
     disagree. It costs at most a tenth against the week's canonical total,
     which is noted in DATA-MAP.md. */
  /* A day that has gone by without a run is no longer *placed* — the distance
     it was holding needs a new home — so it contributes 0 here. What it was
     planned for is NOT forgotten: it is still in storage, still printed on the
     cell, and still counted as a miss. Deleting it was tried and was wrong:
     the whole point of planning a week is being able to see, on Thursday, that
     Wednesday was supposed to carry 5 km and did not. */
  const rowKm = (r) => {
    if (r.settled) return Math.round(r.loggedKm * 10) / 10;
    if (r.when === 'done') return 0;
    return Math.round((r.planned || 0) * 10) / 10;
  };

  /**
   * Fill the week in: matches at their usual cost, the rest spread over the
   * days that can still take it.
   *
   * Days already run keep what they logged, and days that have gone by without
   * a run contribute nothing — which is the useful part on a Thursday, when the
   * question is no longer how to divide the week but how to divide what is left
   * of it.
   */
  function suggest(start, target) {
    const today = todayISO();
    const next = {};
    const free = [];
    let spoken = 0;

    for (const r of weekRows(start)) {
      if (r.settled) { spoken += r.loggedKm; continue; }
      if (r.date < today) continue;
      if (r.isMatch) {
        const v = Math.round((days.typicalSoccer || 0) * 10) / 10;
        next[r.date] = v;
        spoken += v;
        continue;
      }
      free.push(r.date);
    }

    const remaining = Math.max(0, Math.round((target - spoken) * 10) / 10);
    /* How many of those free days should carry a run, from the counts set at
       the top of this page — the plan you already chose, not a fresh guess.
       Runs already logged this week come off it. */
    const wanted = Number((weekIntent(start, intent.plans).kinds || {}).run || 0)
      - days.loggedRuns;
    const n = wanted > 0 ? Math.min(free.length, wanted) : free.length;
    const slots = spreadPick(free.length, n);
    const parts = evenSplit(remaining, slots.length);
    slots.forEach((slot, i) => { next[free[slot]] = parts[i]; });

    days.saved[start] = { km: next, match: weekEntry(start).match };
    if (!writeDays(days.saved)) toast('Could not save — storage is unavailable.');
    buildDays();
  }

  /**
   * The week's committed distance, laid out over the days that can still take
   * it.
   *
   * One question: how much of this week is still to run, and which of the days
   * left is carrying it. So it is a form with one readout rather than a
   * dashboard — a single figure, seven cells, and one sentence reconciling the
   * two. Four tiles, a proportional bar per day and a two-row stacked bar were
   * each tried above this grid and each removed: every one of them added
   * something to read in a panel whose whole job is to be read at a glance.
   *
   * Hierarchy here is size, weight and whitespace. The only colour in the
   * panel is the soccer dot on a match day, because hue means modality
   * everywhere else in this app and there is no legal colour for "behind".
   */
  function buildDays() {
    const start = intent.week;
    const end = addDays(start, 6);
    clear(pDays.body);
    pDays.head.querySelector('.sub').textContent =
      `${fmt.dateY(start)} – ${fmt.dateY(end)} · the week chosen at the top of this page`;

    const locked = ((state.locked && state.locked.weeks) || [])
      .find((w) => w.week_start === start) || null;

    if (!locked) {
      pDays.body.append(emptyNote(
        'Nothing is committed for this week, so there is no distance to divide. '
        + 'Commit a plan below and the days fill in.'));
      return;
    }

    const target = Number(locked.target_km) || 0;
    const rows = weekRows(start);
    /* What the week has actually logged, from the server — the same figure
       `#/week` and `#/running` print, never a sum of the seven cells. */
    const done = Math.round((Number(locked.actual_km) || 0) * 10) / 10;

    /* A week that has finished is a record, not a plan. */
    const over = end < todayISO();

    /* Distance that had a day and lost it: planned onto a day that has since
       gone by without a run. It is not placed any more and it is the reason a
       week goes off course, so it gets counted and said out loud rather than
       quietly dropped. */
    const orphaned = Math.round(rows
      .filter((r) => !r.settled && r.when === 'done')
      .reduce((a, r) => a + (r.planned || 0), 0) * 10) / 10;

    const deload = locked.is_deload ? ' · a down week' : '';

    /* The three planning figures, in the order the question is asked:
       what did I commit to, how much of it has a day, how much still needs
       one. `Placed` counts a day that has already been run — it happened
       there, so it is as placed as a day can be — plus the plans on days that
       can still take one. It does NOT count a plan stranded on a dead day;
       that distance is back in "still to place", which is exactly where the
       user needs to see it when a week slips. */
    const readout = statStrip(over
      ? [
        { label: 'Committed', value: fmt.one(target), unit: 'km',
          note: `on foot, matches included${deload}` },
        { label: 'Logged', value: fmt.one(done), unit: 'km',
          note: 'what the week actually came to' },
        { label: done >= target ? 'Over by' : 'Short by',
          value: fmt.one(Math.abs(Math.round((done - target) * 10) / 10)), unit: 'km',
          note: 'against what was committed' },
      ]
      : [
        { label: 'Committed', value: fmt.one(target), unit: 'km',
          note: `on foot, matches included${deload}` },
        { label: 'Placed', value: '—', unit: 'km', id: 'placed',
          note: done > 0 ? `${fmt.one(done)} km of it already run` : 'across the seven days' },
        { label: 'Still to place', value: '—', unit: 'km', id: 'open',
          note: 'not yet on a day' },
      ]);
    pDays.body.append(readout);

    /* The two live tiles. Their figures move as you type into a day, so the
       week re-totals under your hand instead of after a save. */
    const tiles = [...readout.querySelectorAll('.stat')];
    const placedVal = tiles[1] && tiles[1].querySelector('.stat-value > span');
    const openVal = tiles[2] && tiles[2].querySelector('.stat-value > span');
    const openLabel = tiles[2] && tiles[2].querySelector('.stat-label');
    const openNote = tiles[2] && tiles[2].querySelector('.stat-note');

    /* Every field on screen, so the sentence under the grid can be recomputed
       from what is being typed rather than from what has been saved. */
    const fields = new Map();
    const grid = el('div', { class: 'daygrid' });

    /* Four slots, always present even when empty. A cell that skips its match
       row is forty pixels shorter than its neighbours, which puts one of the
       seven figures off the line — and the line across the seven figures is
       what makes the week readable as a week. */
    for (const r of rows) {
      const plannable = !r.settled && r.when !== 'done';

      const head = el('div', { class: 'daycell-h' }, [
        el('span', { class: 'daycell-d', text: fmt.dow(r.date) }),
        el('span', { class: 'daycell-n num', text: String(Number(r.date.slice(8, 10))) }),
      ]);

      /* A published fixture is a fact and is stated. A day you know about but
         the league has not posted is a control, because only you can say so. */
      let mark = null;
      if (r.fixture) {
        mark = el('span', { class: 'daycell-fx' }, [
          el('i', { style: `background:${colorOf('soccer')}` }),
          el('span', { text: r.fixture.time_text || 'Match' }),
        ]);
      } else if (plannable) {
        mark = el('button', {
          class: `daycell-fx daycell-mark${r.marked ? ' is-on' : ''}`, type: 'button',
          'aria-pressed': String(r.marked),
          title: r.marked ? 'Not a match after all' : 'I am playing on this day',
        }, [
          el('i', { style: `background:${r.marked ? colorOf('soccer') : 'transparent'}` }),
          el('span', { text: r.marked ? 'Match' : 'Match?' }),
        ]);
        mark.addEventListener('click', () => toggleMatch(start, r.date));
      }

      let fig;
      let caption;
      if (r.settled) {
        fig = el('b', { class: 'daycell-fig num', text: fmt.one(rowKm(r)) });
        /* A day that was run against a plan says both. Planning a week is only
           worth doing if you can see, afterwards, where it went — and "6.0"
           alone hides that Monday was meant to be 8.0. Days run without a plan
           on them just say what they were. */
        caption = (r.planned || 0) > 0
          && Math.abs(r.planned - rowKm(r)) >= 0.05
          ? `of ${fmt.one(r.planned)} planned`
          : 'km done';
      } else if (!plannable) {
        fig = el('span', { class: 'daycell-fig is-none', text: '—' });
        /* A day that went by with a plan on it says what it was for. Without
           this the week loses the one thing that explains why it is behind:
           Wednesday was meant to carry 5 km. */
        caption = (r.planned || 0) > 0
          ? `${fmt.one(r.planned)} planned, missed`
          : 'no run';
      } else {
        /* A box with a background, because it is one. A dashed rule under the
           number was tried instead and read as a stray dotted line nobody
           could name. */
        fig = el('input', {
          type: 'number', class: 'input daycell-fig daycell-in num',
          step: '0.1', min: '0', max: '99', inputmode: 'decimal',
          'aria-label': `Kilometres planned for ${fmt.weekday(r.date)}`,
        });
        /* One decimal, like the six figures beside it. `String(18)` is "18",
           and a lone whole number in a row of 6.0 / 5.1 / 6.6 reads as a
           different kind of quantity. `toFixed` rather than `fmt.one`, because
           the value of a number field has to parse as a number in any locale
           and `Intl` will hand back "18,0" in half of them. */
        fig.value = r.planned == null ? '' : Number(r.planned).toFixed(1);
        /* Typing touches the sentence and nothing else. Re-rendering the grid
           on `input` replaces the field under the cursor, which takes the
           focus and the caret with it halfway through a number. */
        fig.addEventListener('input', paintSentence);
        fig.addEventListener('change', () => {
          const raw = fig.value.trim();
          const n = Number(raw);
          const v = raw === '' || !Number.isFinite(n) || n <= 0
            ? null : Math.min(99, Math.round(n * 10) / 10);
          setDay(start, r.date, v);
          /* Written back at the precision it is stored at, so the cell cannot
             show 7.55 for a day the week counts as 7.6. Setting the value of a
             focused field does not blur it, so Enter is safe. */
          fig.value = v == null ? '' : v.toFixed(1);
          paintSentence();
        });
        fields.set(r.date, fig);
        caption = 'km planned';
      }

      grid.append(el('div', { class: `daycell dc-${r.when}` }, [
        head,
        el('div', { class: 'daycell-mk' }, mark ? [mark] : []),
        fig,
        el('span', { class: 'daycell-cap', text: caption }),
        r.when === 'now' ? nowTag() : null,
      ]));
    }
    pDays.body.append(grid);

    if (over) return;

    /* The grid's own reconciliation, in prose, with the two figures set as
       numerals so they can be found without reading the sentence. It is the
       only place either one appears. */
    const sentence = el('p', { class: 'dayrec', 'aria-live': 'polite' });

    function paintSentence() {
      clear(sentence);
      const num = (v) => el('b', { class: 'dayrec-n num', text: `${fmt.one(v)} km` });

      /* Read the fields, not storage: the totals have to move while a number
         is being typed, which is the whole of "watch the week develop". */
      let ahead = 0;
      for (const input of fields.values()) {
        const n = Number(String(input.value).trim());
        if (Number.isFinite(n) && n > 0) ahead += Math.round(n * 10) / 10;
      }
      ahead = Math.round(ahead * 10) / 10;

      const placed = Math.round((done + ahead) * 10) / 10;
      const open = Math.round((target - placed) * 10) / 10;

      if (placedVal) placedVal.textContent = fmt.one(placed);
      if (openVal) openVal.textContent = fmt.one(Math.abs(open));
      if (openLabel) openLabel.textContent = open < 0 ? 'Over-placed' : 'Still to place';
      if (openNote) {
        openNote.textContent = open > 0 ? 'not yet on a day'
          : open < 0 ? 'more than the week committed to'
            : 'the whole week has a day';
      }

      /* The line under the grid is where the week's *story* goes: what is on
         the days ahead, and — the part the planner exists for — what fell off
         a day that has gone by. */
      if (!fields.size) {
        sentence.append(document.createTextNode(
          'No day left in this week can still take a run.'));
      } else {
        sentence.append(
          num(ahead),
          document.createTextNode(
            ` ${ahead === 1 ? 'is' : 'is'} on the ${fields.size === 1 ? 'one day' : `${fields.size} days`} still ahead`),
        );
        if (open > 0) {
          sentence.append(
            document.createTextNode(', and '), num(open),
            document.createTextNode(' of the week has no day yet.'),
          );
        } else if (open < 0) {
          sentence.append(
            document.createTextNode(' — '), num(-open),
            document.createTextNode(' more than the week committed to.'),
          );
        } else {
          sentence.append(document.createTextNode('. The whole week has a day.'));
        }
      }

      if (orphaned > 0) {
        sentence.append(el('span', { class: 'dayrec-miss' }, [
          el('b', { class: 'dayrec-n num', text: `${fmt.one(orphaned)} km` }),
          document.createTextNode(' was planned on days that have gone by. '),
          document.createTextNode('It is back in what still needs a day.'),
        ]));
      }
    }
    paintSentence();
    pDays.body.append(sentence);

    /* One line, and only while a match is still ahead. It exists to say where
       the number already in that day's field came from; a paragraph about
       matches on a week with none was three sentences of nothing. */
    const ahead = rows.filter((r) => r.isMatch && !r.settled && r.when !== 'done');
    if (ahead.length && days.typicalSoccer != null) {
      const names = ahead.map((r) => fmt.weekday(r.date));
      pDays.body.append(el('p', { class: 'dayrec-sub', text:
        `${names.join(' and ')} ${names.length > 1 ? 'are match days' : 'is a match day'}, `
        + `held at ${fmt.one(days.typicalSoccer)} km — the median of your last `
        + `${days.typicalN} matches.` }));
    }

    const go = el('button', { class: 'btn btn-primary', type: 'button' }, [
      icon('check'), el('span', { text: 'Re-spread what is left' }),
    ]);
    go.addEventListener('click', () => {
      suggest(start, target);
      toast('Spread over the days still ahead.');
    });
    const wipe = el('button', { class: 'btn btn-quiet', type: 'button', text: 'Clear the days',
      title: 'Removes the distances and any match day you marked yourself' });
    wipe.addEventListener('click', () => {
      delete days.saved[start];
      writeDays(days.saved);
      buildDays();
    });
    pDays.body.append(el('div', { class: 'plan-actions' }, [go, wipe]));
  }

  /* ── boot ── */

  /* One page, so both halves boot. The intent half needs only the latest week
     to build its picker; the ramp half is the slow one and is not waited on. */
  /* Drawn first, fetched after. The intent editor needs only `latest_week_end`
     to decide how far forward the week picker runs, and waiting on a request
     for that left three panels sitting as skeletons behind a call they barely
     used. They render from what is already known — this week, and whatever is
     in localStorage — and the picker widens when the answer arrives. */
  buildPicker();
  buildIntent();
  buildAll();
  loadActual();
  (async () => {
    const res = await api('/api/summary?weeks=1');
    if (!alive || !res.ok) return;
    intent.latest = res.data.latest_week_end;
    buildPicker();
  })();
  paintPlanner();
  syncPct();
  buildControls();
  boot();
  loadLocked();
  loadMix();
  loadDays();

  return {
    destroy() { alive = false; figs.forEach((f) => f.destroy && f.destroy()); },
    refresh() { loadActual(); load(); loadLocked(); loadMix(); loadDays(); },
  };
}

const sumPlan = (p) => Object.values(p?.kinds || {}).reduce((a, b) => a + Number(b || 0), 0);
