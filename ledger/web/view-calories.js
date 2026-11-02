/* Calories — what went in today against what the watch says went out.
 *
 * Built around one requirement the user stated plainly: the running count
 * was being kept in their head, and the page has to be read at arm's length
 * without reading. So the top of the page is one number — what is left to
 * eat today — in the colour of where the day stands, a bar, three icons with
 * figures under it, and a box that takes a number and an Add button. No
 * sentences on the fast path. Labels are chips, and they are labels, not
 * slots — a day can have two snacks.
 *
 *   **Colour was asked for.** A day's standing against the target takes the
 *   Scoreboard's five-tone ramp (`calories.js`), on the hero figure, the
 *   bar, the week strip and the history columns. The word is always printed
 *   beside it, and today carries an `est` tag because it is not over.
 *
 *   **It does not compute anything.** Intake, burn, deficit, "eat up to",
 *   the standing, the means and the arithmetic all come from `/api/calories`.
 *   A write repaints from the day the server returns. The pending row in the
 *   list is the only optimism here.
 *
 *   **It does not guess a finished day's burn.** A past day with no watch row
 *   has no deficit: a dash, not a number.
 */

import {
  el, icon, clear, api, qs, busy, fmt, todayISO, addDays, weekStart, toast, token,
  getWeightUnit, setWeightUnit, kgToLb, lbToKg,
} from './core.js';
import { figure } from './charts.js';
import {
  panel, panelError, statStrip, segmented, emptyNote, skeletonBlock,
  setTimeframe, setTools, sectionRule, rememberedChoice, rememberChoice,
} from './ui.js';
import { cached, invalidate, loadPlanState, goalWeightLb, setGoalWeightLb } from './dataset.js';
import { weighInsWithin, weightFigureSpec, weightStats, directionTone } from './weight.js';
import {
  STANDING, legendFor, toneClass, standingWord, standingPill, fuelBar, mealDot, weekStrip, colourKey,
  heroOf,
} from './calories.js';

const RANGES = [['7d', '7 days'], ['28d', '28 days'], ['12w', '12 weeks']];
const RANGE_DAYS = { '7d': 7, '28d': 28, '12w': 84 };
const BW_RANGES = [['4', '4w'], ['12', '12w'], ['26', '26w'], ['52', '52w']];
/* The two windows this page lets you pick, remembered across visits. */
const RANGE_KEY = 'ledger.calories.range';
const BW_KEY = 'ledger.calories.bw';
const isRange = (v) => RANGES.some(([k]) => k === v);
const isBwRange = (v) => BW_RANGES.some(([k]) => k === v);

/* The quick labels. Six words, no enum: anything typed over them is kept. */
const CHIPS = ['breakfast', 'snack', 'lunch', 'dinner', 'bedtime', 'other'];

/** The chip a meal logged right now most likely is. Past days get none. */
function chipForNow(isToday) {
  if (!isToday) return null;
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h < 10.5) return 'breakfast';
  if (h < 14.5) return 'lunch';
  if (h < 17.5) return 'snack';
  if (h < 21) return 'dinner';
  return 'bedtime';
}

const clampISO = (iso, today) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return today;
  return iso > today ? today : iso;
};

/** "14:32" in the viewer's clock, from a UTC ISO stamp. */
const clockOf = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

export function mount(host, route, { setQuery }) {
  const today = todayISO();
  const state = {
    date: clampISO(route.query.get('date'), today),
    range: rememberedChoice(RANGE_KEY, route, 'range', isRange, '28d'),
    bw: rememberedChoice(BW_KEY, route, 'bw', isBwRange, '12'),
    unit: getWeightUnit(),
    week: null,       // the seven days around state.date, as the server last said
    day: null,
    target: null,
    hist: null,
    weight: null,
    editing: null,
    pulling: false,
    pending: null,
    showSum: false,
  };
  let alive = true;
  let figs = [];

  const isToday = () => state.date === today;

  /* ── shell ── */

  const nav = el('div', { class: 'weeknav calnav' });
  const btnPrev = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Previous day' }, [icon('left')]);
  const btnNext = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Next day' }, [icon('right')]);
  const navLabel = el('div', { class: 'weeknav-label' }, [
    el('strong', { text: ' ' }),
    document.createTextNode(' '),
    el('span', { class: 'weeknav-rel', text: 'Calories' }),
  ]);
  const btnToday = el('button', { class: 'btn btn-quiet', type: 'button', text: 'Today' });
  nav.append(btnPrev, navLabel, btnNext, el('div', { class: 'weeknav-spacer' }), btnToday);

  const weekHost = el('div', { class: 'calweek-host' });

  const hero = el('section', { class: 'hero calhero' });
  const heroFig = el('div', { class: 'hero-figure' });
  const heroAside = el('div', { class: 'hero-aside' });
  hero.append(heroFig, heroAside);

  const pAdd = panel({ title: 'Add a meal', wide: true });
  const pMeals = panel({ title: 'Meals', sub: ' ', wide: true });
  const pTrend = panel({ title: 'Deficit, day by day', wide: true, kicker: 'Measured' });
  const pWeight = panel({ title: 'Bodyweight', wide: true });
  const pTarget = panel({ title: 'Daily target', kicker: 'Settings' });

  host.append(nav, weekHost, hero, pAdd, pMeals,
              sectionRule('Over time'), pTrend, pWeight,
              sectionRule('Settings'), pTarget);
  skeletonBlock(56, weekHost);
  skeletonBlock(120, heroFig);
  skeletonBlock(80, heroAside);
  skeletonBlock(120, pAdd.body);
  skeletonBlock(140, pMeals.body);
  skeletonBlock(220, pTrend.body);
  skeletonBlock(220, pWeight.body);
  skeletonBlock(70, pTarget.body);

  /* ── navigation ── */

  function goTo(iso) {
    state.date = clampISO(iso, today);
    state.editing = null;
    setQuery({ date: isToday() ? null : state.date });
    loadDay();
  }
  btnPrev.addEventListener('click', () => goTo(addDays(state.date, -1)));
  btnNext.addEventListener('click', () => goTo(addDays(state.date, 1)));
  btnToday.addEventListener('click', () => goTo(today));

  /* ── data ── */

  /** The week around the day, one request: the strip and the day both. */
  async function loadDay() {
    const from = weekStart(state.date);
    const to = addDays(from, 6);
    busy(true);
    const res = await api(`/api/calories${qs({ from, to })}`);
    busy(false);
    if (!alive) return;
    if (!res.ok) {
      clear(heroFig); clear(heroAside); clear(weekHost);
      panelError(pAdd.body, res, 'Calories');
      panelError(pMeals.body, res, 'The meal log');
      return;
    }
    state.week = res.data.days;
    state.day = state.week.find((d) => d.date === state.date);
    state.target = { kcal: res.data.target, isDefault: res.data.target_is_default };
    paintDay();
    paintTarget();
    /* Today's burn is pulled when the stored row is older than the server's
       own staleness rule, and only then. Not on every open, not on a timer —
       and not at all when Garmin was never signed in, which the Sync page
       already says. */
    if (isToday() && state.day.burn.stale && navigator.onLine !== false) {
      const st = await cached('sync:status', '/api/sync-status');
      if (alive && (!st.ok || st.data.authenticated !== false)) pull();
    }
  }

  /* Finished days only: the window ends yesterday, which is the window the
     rolling means are computed over, so the tile and the bars count the
     same days. Today is the estimate at the top of the page. */
  async function loadHistory() {
    const to = addDays(today, -1);
    const from = addDays(today, -RANGE_DAYS[state.range]);
    const res = await api(`/api/calories${qs({ from, to })}`);
    if (!alive) return;
    if (!res.ok) { panelError(pTrend.body, res, 'The deficit history'); return; }
    state.hist = res.data;
    paintTrend();
  }

  /* The goal is the Plan page's goal: the same snapshot (`loadPlanState`),
     which also carries a goal this browser saved before it moved to the
     server. One source, so the two pages cannot disagree. */
  async function loadWeight({ force = false } = {}) {
    const [h] = await Promise.all([
      cached('history', '/api/history'),
      loadPlanState({ force }),
    ]);
    if (!alive) return;
    if (!h.ok) { panelError(pWeight.body, h, 'Bodyweight'); return; }
    state.weight = { series: h.data.bodyweight || [], goalLb: goalWeightLb() };
    paintWeight();
  }

  /** Take a write's answer: the server's day replaces ours, nothing is
   *  derived; the history reloads since a day moved. */
  function applied(res, what) {
    if (!res.ok) { toast(res.error || what); return false; }
    if (res.data && res.data.day) takeDay(res.data.day);
    loadHistory();
    return true;
  }

  function takeDay(day) {
    const i = (state.week || []).findIndex((d) => d.date === day.date);
    if (i >= 0) state.week[i] = day;
    if (day.date === state.date) { state.day = day; paintDay(); }
  }

  async function pull() {
    if (state.pulling) return;
    state.pulling = true;
    paintStamp();
    const res = await api('/api/calories/refresh', { method: 'POST', body: { day: today } });
    if (!alive) return;
    state.pulling = false;
    if (!res.ok) { toast(res.error || 'Could not reach Garmin.'); paintStamp(); return; }
    if (res.data.errors && res.data.errors.length) toast(res.data.errors[0]);
    takeDay(res.data.day);
    if (!isToday()) paintWeek();
  }

  /* ── paint: the day ── */

  function paintDay() {
    const d = state.day;
    paintNav();
    paintWeek();
    paintHero(d);
    paintAdd(d);
    paintMeals(d);
  }

  function paintNav() {
    const strong = navLabel.querySelector('strong');
    const rel = navLabel.querySelector('.weeknav-rel');
    const relWord = fmt.relDays(state.date, today);
    strong.textContent = fmt.dowDate(state.date);
    rel.textContent = relWord === 'today' ? 'Today' : relWord;
    btnNext.disabled = isToday();
    btnToday.hidden = isToday();
  }

  /* The week the day sits in: seven toned cells, tap one to open it. */
  function paintWeek() {
    clear(weekHost);
    weekHost.append(weekStrip(state.week, today, {
      current: state.date,
      onTap: (d) => { if (d.date <= today) goTo(d.date); },
    }));
    weekHost.append(colourKey(state.target ? state.target.kcal : 500));
  }

  function paintHero(d) {
    clear(heroFig);
    /* What the big number is comes from `heroOf`, shared with the Week
       widget: left to eat today, the deficit on a finished day. The colour
       is the standing; the two words under "kcal" say what the figure is. */
    const h = heroOf(d, today);
    heroFig.append(
      el('div', { class: 'figure-row' }, [
        el('div', { class: `figure calfig ${h.tone}`, text: h.value }),
        el('div', { class: 'figure-unit' }, h.lines.map((t) => el('span', { text: t }))),
      ]),
      el('div', { class: 'calhero-pill' }, [standingPill(d, today)]),
    );

    clear(heroAside);
    heroAside.append(fuelBar(d));
    heroAside.append(el('div', { class: 'calstamp', id: 'cal-stamp' }));
    paintStamp();
  }

  /* One row: ⟳ and the time Garmin last answered, and a Σ that unfolds the
     arithmetic for anyone who wants to redo it. */
  function paintStamp() {
    const node = heroAside.querySelector('#cal-stamp');
    if (!node) return;
    clear(node);
    const d = state.day;
    const b = d && d.burn;
    if (!b) return;
    const when = clockOf(b.fetched_at);
    const row = el('div', { class: 'calstamp-row' });
    if (isToday()) {
      row.append(el('button', {
        class: `iconbtn iconbtn-sm calstamp-btn${state.pulling ? ' is-busy' : ''}`, type: 'button',
        title: "Pull today's burn from Garmin now",
        'aria-label': "Pull today's burn from Garmin now",
        disabled: state.pulling ? '' : null,
        on: { click: pull },
      }, [icon('sync')]));
    } else {
      row.append(icon('sync', 'calstamp-i'));
    }
    row.append(el('span', {
      class: 'calstamp-t',
      title: b.baseline_note ? `baseline: ${b.baseline_note}` : null,
      text: state.pulling ? 'syncing with Garmin…' : when ? `burn synced ${when}` : 'burn not synced yet',
    }));
    node.append(row);
  }

  /* ── paint: adding ── */

  function paintAdd(d) {
    clear(pAdd.body);
    const form = el('form', { class: 'mealadd', autocomplete: 'off' });
    const input = el('input', {
      class: 'input mealadd-kcal', type: 'text', inputmode: 'numeric', pattern: '[0-9]*',
      placeholder: 'kcal', 'aria-label': 'Calories', maxlength: '4', enterkeyhint: 'done',
    });
    let chip = chipForNow(isToday());
    const chips = el('div', { class: 'chip-row mealadd-chips', role: 'group', 'aria-label': 'Label' });
    const paintChips = () => {
      clear(chips);
      for (const c of CHIPS) {
        chips.append(el('button', {
          type: 'button', class: 'chip', 'aria-pressed': String(chip === c),
          on: { click: () => { chip = chip === c ? null : c; paintChips(); input.focus(); } },
        }, [mealDot(c), el('span', { text: c })]));
      }
    };
    paintChips();
    const add = el('button', { class: 'btn btn-primary btn-lg mealadd-btn', type: 'submit' }, [
      icon('plus'), el('span', { text: 'Add' }),
    ]);
    form.append(el('div', { class: 'mealadd-row' }, [input, add]), chips);
    if (!isToday()) {
      form.append(el('p', { class: 'calhint' }, [icon('week', 'calpair-i'), el('span', { text: ` ${fmt.dowDate(state.date)}` })]));
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = input.value.trim();
      const kcal = Number(raw);
      if (!raw || !Number.isInteger(kcal) || kcal < 1 || kcal > 5000) {
        toast('Whole number, 1 to 5,000.');
        input.focus();
        return;
      }
      const label = chip === 'other' ? '' : (chip || '');
      state.pending = { kcal, label };
      input.value = '';
      input.focus();
      paintMeals(state.day);
      busy(true);
      const res = await api(`/api/calories/${state.date}/meals`, { method: 'POST', body: { kcal, label } });
      busy(false);
      if (!alive) return;
      state.pending = null;
      if (!applied(res, 'Not saved')) {
        input.value = String(kcal);
        paintMeals(state.day);
      }
    });
    pAdd.body.append(form);
  }

  /* ── paint: the list ── */

  function paintMeals(d) {
    clear(pMeals.body);
    pMeals.head.querySelector('.sub').textContent = fmt.dowDate(state.date);
    const list = el('ul', { class: 'meals' });
    for (const m of d.meals) {
      list.append(mealRow(m));
      if (state.editing === m.id) list.append(mealEditor(m));
    }
    if (state.pending) {
      list.append(el('li', { class: 'meal-row is-pending', 'aria-busy': 'true' }, [
        mealDot(state.pending.label),
        el('span', { class: 'meal-label', text: state.pending.label || 'meal' }),
        document.createTextNode(' '),
        el('span', { class: 'meal-kcal num', text: fmt.int(state.pending.kcal) }),
      ]));
    }
    if (!d.meals.length && !state.pending) {
      pMeals.body.append(el('p', { class: 'empty calempty' }, [icon('fork', 'calpair-i'), el('span', { text: ' nothing yet' })]));
      return;
    }
    pMeals.body.append(list);
    pMeals.body.append(el('div', { class: 'meals-total' }, [
      el('span', { class: 'meals-total-k', text: 'Σ' }),
      document.createTextNode(' '),
      el('b', { class: 'num', text: fmt.int(d.intake) }),
      document.createTextNode(' '),
      el('span', { class: 'meals-total-u', text: 'kcal' }),
    ]));
  }

  function mealRow(m) {
    const row = el('li', { class: `meal-row${state.editing === m.id ? ' is-editing' : ''}` });
    row.append(
      mealDot(m.label),
      el('span', { class: 'meal-label', text: m.label || 'meal' }),
      document.createTextNode(' '),
      el('span', { class: 'meal-kcal num', text: fmt.int(m.kcal) }),
    );
    row.append(el('button', {
      class: 'iconbtn iconbtn-sm', type: 'button',
      title: 'Correct this meal', 'aria-label': `Correct ${m.label || 'meal'}, ${m.kcal} kcal`,
      on: { click: () => { state.editing = state.editing === m.id ? null : m.id; paintMeals(state.day); } },
    }, [icon('edit')]));

    /* Two steps, no dialog — the same pattern as deleting a note. The icon
       is the resting state; arming it prints the word. */
    const del = el('button', {
      class: 'iconbtn iconbtn-sm', type: 'button',
      title: 'Delete this meal', 'aria-label': `Delete ${m.label || 'meal'}, ${m.kcal} kcal`,
    }, [icon('trash')]);
    let armed = false;
    let timer = 0;
    const disarm = () => {
      armed = false; clear(del); del.append(icon('trash')); del.classList.remove('is-armed');
    };
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true; clear(del); del.append(el('span', { text: 'Delete?' }));
        del.classList.add('is-armed'); timer = setTimeout(disarm, 4000);
        return;
      }
      clearTimeout(timer);
      busy(true);
      const res = await api(`/api/meals/${m.id}`, { method: 'DELETE' });
      busy(false);
      if (!alive) return;
      applied(res, 'Not deleted');
    });
    row.append(del);
    return row;
  }

  function mealEditor(m) {
    const kcal = el('input', {
      class: 'input hbeditor-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*',
      value: String(m.kcal), 'aria-label': 'Calories', maxlength: '4',
    });
    const label = el('input', {
      class: 'input mealedit-label', type: 'text', value: m.label || '', placeholder: 'label',
      'aria-label': 'Label', maxlength: '40',
    });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Save' });
    const cancel = el('button', {
      class: 'btn btn-quiet', type: 'button', text: 'Cancel',
      on: { click: () => { state.editing = null; paintMeals(state.day); } },
    });
    const form = el('form', { class: 'hbeditor mealedit' }, [
      el('div', { class: 'hbeditor-row' }, [kcal, el('span', { class: 'hbeditor-unit', text: 'kcal' }), label, save, cancel]),
    ]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const n = Number(kcal.value.trim());
      if (!Number.isInteger(n) || n < 1 || n > 5000) { toast('Whole number, 1 to 5,000.'); return; }
      busy(true);
      const res = await api(`/api/meals/${m.id}`, { method: 'PATCH', body: { kcal: n, label: label.value.trim() } });
      busy(false);
      if (!alive) return;
      if (applied(res, 'Not saved')) { state.editing = null; paintMeals(state.day); }
    });
    const li = el('li', { class: 'meal-editor' }, [form]);
    setTimeout(() => kcal.focus(), 0);
    return li;
  }

  /* ── paint: over time ── */

  function dropFigs() { for (const f of figs) f.destroy(); figs = []; }

  /**
   * One column per finished, logged day: the size of the deficit, in the
   * tone of its standing. A day that ate over its burn draws the overshoot
   * in the over tones — red is the message, the height is by how much. Days
   * with nothing to say are gaps, not zeros. Today is the estimate above.
   */
  function paintTrend() {
    const h = state.hist;
    clear(pTrend.body);
    setTools(pTrend, segmented(RANGES, state.range, (v) => {
      state.range = v; rememberChoice(RANGE_KEY, v); setQuery({ range: v === '28d' ? null : v }); loadHistory();
    }, 'Window'));
    setTimeframe(pTrend, h.timeframe);

    const s = h.summary;
    const mean = (v, n, st, days) => ({
      label: `${days}-day mean`, value: v == null ? '—' : fmt.int(v), unit: v == null ? '' : 'kcal',
      note: n ? `${n} day${n === 1 ? '' : 's'}` : 'no days yet',
      tone: v == null ? null : (STANDING[st] || {}).tone,
    });
    pTrend.body.append(statStrip([
      mean(s.mean_deficit_7, s.days_counted_7, s.standing_7, 7),
      mean(s.mean_deficit_28, s.days_counted_28, s.standing_28, 28),
    ]));

    const days = h.days;
    const counted = days.filter((d) => d.status === 'complete' && d.meals.length);
    const figHost = el('div', { class: 'fig-primary' });
    pTrend.body.append(figHost);
    if (!counted.length) {
      figHost.append(emptyNote('No finished day with a burn and a meal in this window yet.'));
      return;
    }
    const toneColor = (st) => token(`tone-${(STANDING[st] || {}).tone || 'poor'}`);
    figs.push(figure(figHost, {
      type: 'columns', height: 230, unit: 'kcal', periodLabel: 'Day',
      /* Numbers on the highest and the latest bar only; the rest are in the
         Table. On a phone every bar labelled ran the figures together. */
      /* minSlot 2: every window fits the card without scrolling. A
         scrolling chart opened at the end hid its own axis on a phone. */
      labels: days.length > 10 ? 'none' : undefined, minSlot: 2,
      aria: 'Daily calorie deficit, burn minus intake, for finished days with a meal logged; colour is the standing against the target',
      series: [{ key: 'deficit', label: 'Deficit', color: token('ink-3') }],
      legendExtra: legendFor(h.target).map((v) => ({ label: v.label, color: token(`tone-${v.tone}`) })),
      guides: [{ value: h.target, color: token('ink-3'), label: `target ${fmt.int(h.target)}`, short: String(h.target) }],
      points: days.map((d) => {
        const on = d.status === 'complete' && d.meals.length > 0;
        return {
          key: d.date, label: fmt.date(d.date), group: d.date.slice(0, 4),
          values: { deficit: on ? Math.abs(d.deficit) : 0 },
          colors: on ? { deficit: toneColor(d.standing) } : null,
          note: on ? `${fmt.int(Math.abs(d.deficit))} ${d.deficit < 0 ? 'over' : 'under'} · ${standingWord(d.standing)}`
            : (d.meals.length ? 'no burn' : 'nothing logged'),
          empty: !on,
        };
      }),
      format: (v) => fmt.int(v),
      formatShort: (v) => fmt.compact(v),
    }));
    pTrend.body.append(el('p', { class: 'calcount' }, [
      el('b', { class: 'num', text: String(counted.length) }),
      el('span', { text: ` of ${days.length} days counted` }),
    ]));
  }

  /**
   * Bodyweight, read at a glance: the latest reading large, in the colour of
   * which way it is going; the change over the window as an arrow pill; three
   * tiles with icons — pace, to goal (with the date this pace gets there),
   * and the window's low and high; then the line, clean, every weigh-in
   * ringed, the goal dashed. The numbers live in the tiles so nothing is
   * printed on the line. The sums are `weight.js`, shared with All time.
   */
  function paintWeight() {
    const w = state.weight;
    clear(pWeight.body);
    const all = (w.series || []).filter((p) => p.kg != null);
    setTools(pWeight, [
      segmented([['lb', 'lb'], ['kg', 'kg']], state.unit, (v) => {
        state.unit = setWeightUnit(v); paintWeight();
      }, 'Weight units'),
      segmented(BW_RANGES, state.bw, (v) => {
        state.bw = v; rememberChoice(BW_KEY, v); setQuery({ bw: v === '12' ? null : v }); paintWeight();
      }, 'Bodyweight window'),
    ]);
    if (all.length < 2) {
      setTimeframe(pWeight, null);
      pWeight.body.append(emptyNote('No weigh-ins on record.'));
      pWeight.body.append(goalForm(null));
      return;
    }
    const u = state.unit;
    const bw = weighInsWithin(all, Number(state.bw));
    const st = weightStats(bw, u, { goalLb: w.goalLb });
    /* Green and red say "toward" and "away" — which only mean something
       against a goal. With none set, nothing is tinted. */
    const tone = w.goalLb == null ? 'none' : directionTone(st.direction);
    setTimeframe(pWeight, `${state.bw} weeks to ${fmt.dateY(st.latestDate)}`);
    const one = (v) => (v == null ? '—' : v.toFixed(1));

    /* The hero row: now, and which way. */
    const arrow = st.direction === 'flat' ? '→' : st.change < 0 ? '↓' : '↑';
    const sinceWords = `${fmt.signed(st.change, ` ${u}`, 1)} since ${fmt.dateY(st.firstDate)}`
      + (w.goalLb == null ? ' · no goal set, down counts as toward' : st.direction === 'toward' ? ' · toward the goal' : st.direction === 'away' ? ' · away from the goal' : '');
    pWeight.body.append(el('div', { class: `bwhero tone-${tone}` }, [
      el('div', {}, [
        el('div', { class: 'bwhero-fig' }, [
          icon('scale', 'bwhero-i'),
          el('b', { class: 'bwhero-n', text: one(st.latest) }),
          el('span', { class: 'bwhero-u', text: u }),
        ]),
        el('div', { class: 'bwhero-date' }, [icon('week', 'calpair-i'), el('span', { text: ` ${fmt.dowDate(st.latestDate)}` })]),
      ]),
      el('span', { class: `calpill tone-${tone}`, title: sinceWords, 'aria-label': sinceWords }, [
        el('span', { class: 'calpill-arrow', 'aria-hidden': 'true', text: arrow }),
        el('b', { text: `${one(Math.abs(st.change))} ${u}` }),
        document.createTextNode(' '),
        el('span', { class: 'calpill-rel is-quiet', text: `since ${fmt.date(st.firstDate)}` }),
      ]),
    ]));

    /* Three tiles, each with its icon and its own colour where it has one. */
    const pace = st.pacePerWeek;
    const toGoalNote = st.goal == null ? 'set one below ↓'
      : Math.abs(st.toGoal) < (u === 'kg' ? 0.23 : 0.5) ? 'there'
        : st.etaDate ? `at this pace: ${st.etaDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`
          : 'not heading there yet';
    pWeight.body.append(statStrip([
      {
        icon: 'spark', label: 'Pace', value: pace == null ? '—' : fmt.signed(pace, '', 1),
        unit: pace == null ? '' : `${u}/wk`, tone: pace == null ? null : tone, className: 'bwstat',
        note: pace == null ? 'needs 3 weigh-ins' : `${st.count} weigh-ins`,
      },
      {
        icon: 'target', label: 'To goal', value: st.goal == null ? '—' : one(Math.abs(st.toGoal)),
        unit: st.goal == null ? '' : u, tone: st.goal == null ? null : tone, className: 'bwstat',
        note: toGoalNote,
      },
      {
        icon: 'trends', label: 'Low · high', value: `${one(st.low)}–${one(st.high)}`, unit: u,
        note: 'in this window', className: 'bwstat',
      },
    ]));

    const figHost = el('div', { class: 'fig-primary fig-weight' });
    pWeight.body.append(figHost);
    figs.push(figure(figHost, weightFigureSpec(bw, u, {
      goalLb: w.goalLb, height: 240, annotate: false, markers: true, color: token('weight'),
      aria: `Bodyweight readings in ${u === 'kg' ? 'kilograms' : 'pounds'}, last ${state.bw} weeks`,
    })));
    pWeight.body.append(goalForm(st));
  }

  /** ◎ goal [   ] lb  Save — the one setting this panel has. Stored on the
   *  server in pounds (`/api/plan/goal`), shown in the unit on screen. */
  function goalForm(st) {
    const u = state.unit;
    const w = state.weight;
    const current = w.goalLb == null ? '' : (u === 'kg' ? lbToKg(w.goalLb) : w.goalLb).toFixed(1).replace(/\.0$/, '');
    const input = el('input', {
      class: 'input hbeditor-input', type: 'text', inputmode: 'decimal', value: current,
      placeholder: u === 'kg' ? '80' : '180', 'aria-label': `Goal weight in ${u}`, maxlength: '6',
    });
    const save = el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Save' });
    const form = el('form', { class: 'bwgoal' }, [
      icon('target', 'calpair-i'),
      el('span', { class: 'bwgoal-k', text: 'goal' }),
      input, el('span', { class: 'hbeditor-unit', text: u }), save,
      w.goalLb != null ? el('button', {
        class: 'btn btn-quiet btn-sm', type: 'button', text: 'Clear',
        on: { click: () => writeGoal(null) },
      }) : null,
    ]);
    const writeGoal = async (lb) => {
      busy(true);
      const ok = await setGoalWeightLb(lb == null ? null : Math.round(lb * 10) / 10);
      busy(false);
      if (!alive) return;
      if (!ok) { toast('Not saved'); return; }
      toast(lb == null ? 'Goal cleared' : `Goal ${fmt.whole(u === 'kg' ? lbToKg(lb) : lb)} ${u}`);
      loadWeight();
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const n = Number(input.value.trim().replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) { toast('A number, please.'); return; }
      writeGoal(u === 'kg' ? kgToLb(n) : n);
    });
    return form;
  }

  /* ── paint: settings ── */

  function paintTarget() {
    clear(pTarget.body);
    const t = state.target;
    const input = el('input', {
      class: 'input hbeditor-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*',
      value: String(t.kcal), 'aria-label': 'Daily deficit target in kcal', maxlength: '4',
    });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Save' });
    const form = el('form', { class: 'hbeditor-row caltarget' }, [
      icon('target', 'calpair-i'), input, el('span', { class: 'hbeditor-unit', text: 'kcal under, each day' }), save,
    ]);
    const write = async (value) => {
      busy(true);
      const res = await api('/api/calories/settings', { method: 'PUT', body: { deficit_target_kcal: value } });
      busy(false);
      if (!alive) return;
      if (!res.ok) { toast(res.error || 'Not saved'); return; }
      state.target = { kcal: res.data.deficit_target_kcal, isDefault: res.data.is_default };
      toast(`Target ${fmt.int(state.target.kcal)} kcal`);
      invalidate();
      loadDay();
      loadHistory();
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const n = Number(input.value.trim());
      if (!Number.isInteger(n) || n < 0 || n > 2000) { toast('Whole number, 0 to 2,000.'); return; }
      write(n);
    });
    pTarget.body.append(form);
    if (!t.isDefault) {
      pTarget.body.append(el('button', {
        class: 'btn btn-quiet btn-sm caltarget-reset', type: 'button', text: 'Back to 500',
        on: { click: () => write(null) },
      }));
    }
  }

  /* ── go ── */

  loadDay();
  loadHistory();
  loadWeight();

  return {
    destroy() { alive = false; dropFigs(); },
    refresh() { loadDay(); loadHistory(); },
  };
}
