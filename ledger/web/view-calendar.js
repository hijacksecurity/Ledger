/* Calendar — the record laid out the way it was lived, on dates.
 *
 * Every other page aggregates: a week total, a monthly column, a rolling mean.
 * Those answer "how much" and cannot answer "when" — which days stacked up,
 * which were empty, whether the hard sessions cluster or spread. A notebook
 * answered that by being a calendar, and this is the page that puts it back.
 *
 * Three grains, because the question changes with the span:
 *
 *   Week   every session listed, in full. What actually happened.
 *   Month  the default. One cell a day, each carrying its modalities and its
 *          load — a month's shape readable without scrolling.
 *   Year   twelve small months. Only density and dominant modality survive at
 *          that size, and pretending otherwise would be decoration.
 *
 * Colour is the modality palette throughout, the same hue that means running
 * on every chart in the app. It never carries anything alone: a day's cell
 * lists its kinds as text in the tooltip, and the month grid prints the count.
 */

import {
  el, clear, busy, fmt, colorOf, KINDS, todayISO, addDays, weekStart, dateOf,
  isoOf, attachTip, icon, orderKinds, api, qs,
} from './core.js';
import {
  panel, panelError, statStrip, segmented, emptyNote, skeletonBlock, kindName,
  sessionList, setTimeframe, dowBadge,
} from './ui.js';
import { sessionsIn } from './dataset.js';
import { dayCell, daySymbol, hueOf, hueStyle, STATES } from './habits.js';

const GRAINS = [['week', 'Week'], ['month', 'Month'], ['year', 'Year']];

/* The habit overlay is read-only here, and that is the point rather than a
   shortfall. The calendar answers "when" — which days stacked up, which were
   empty, whether the habits track the training or drift away from it. Marking
   a day is a different job with a different page, and putting a control on a
   14px cell would make the grid harder to read to save one tap. `#/habits` is
   a link away, on this page's own nav.
 *
 * The year grain gets no overlay at all. A day is four pixels there, which the
 * page already says is enough for density and a dominant modality and nothing
 * else; three more marks in that space would be decoration pretending to be
 * data. */
const HABIT_GRAINS = new Set(['week', 'month']);

/** First of the month containing `iso`. */
const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
/** Last day of that month. */
function monthEnd(iso) {
  const d = dateOf(monthStart(iso));
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  return isoOf(d);
}
const shiftMonths = (iso, n) => {
  const d = dateOf(monthStart(iso));
  d.setMonth(d.getMonth() + n);
  return isoOf(d);
};

export function mount(host, route, { setQuery }) {
  const q = route.query;
  const state = {
    grain: GRAINS.some(([k]) => k === q.get('by')) ? q.get('by') : 'month',
    /* The anchor is always a real date inside the period on screen; each grain
       widens it to its own bounds. Stored rather than derived so stepping back
       and forth is lossless. */
    anchor: q.get('on') || todayISO(),
    sessions: [],
    /* Default on: the overlay is the reason to look at a calendar rather than
       a list, and a feature hidden behind a control nobody finds is a feature
       nobody has. `habits=0` in the URL turns it off and survives a reload. */
    showHabits: q.get('habits') !== '0',
    habits: null,
  };
  let alive = true;

  const nav = el('div', { class: 'weeknav calnav' });
  const btnPrev = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Previous period' }, [icon('left')]);
  const btnNext = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Next period' }, [icon('right')]);
  const label = el('div', { class: 'weeknav-label' }, [
    el('strong', { class: 'calnav-title' }),
    el('span', { class: 'weeknav-rel calnav-rel' }),
  ]);
  const btnToday = el('button', { class: 'btn btn-quiet', type: 'button', text: 'Today' });
  const grainCtl = el('div', { class: 'filter' });
  const habitCtl = el('div', { class: 'filter' });

  nav.append(btnPrev, label, btnNext, el('div', { class: 'weeknav-spacer' }),
             habitCtl, grainCtl, btnToday);

  const stripHost = el('div', { class: 'strip-host' });
  const pGrid = panel({ title: 'Calendar', sub: ' ', wide: true, kicker: 'Log' });

  host.append(nav, stripHost, pGrid);
  skeletonBlock(96, stripHost);
  skeletonBlock(360, pGrid.body);

  /* ── bounds ── */

  function bounds() {
    if (state.grain === 'week') {
      const from = weekStart(state.anchor);
      return { from, to: addDays(from, 6) };
    }
    if (state.grain === 'year') {
      const y = state.anchor.slice(0, 4);
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    return { from: monthStart(state.anchor), to: monthEnd(state.anchor) };
  }

  function step(dir) {
    if (state.grain === 'week') state.anchor = addDays(state.anchor, dir * 7);
    else if (state.grain === 'year') {
      state.anchor = `${Number(state.anchor.slice(0, 4)) + dir}${state.anchor.slice(4)}`;
    } else state.anchor = shiftMonths(state.anchor, dir);
    push();
    load();
  }

  const push = () => setQuery({
    by: state.grain, on: state.anchor, habits: state.showHabits ? null : '0',
  });

  btnPrev.addEventListener('click', () => step(-1));
  btnNext.addEventListener('click', () => step(1));
  btnToday.addEventListener('click', () => { state.anchor = todayISO(); push(); load(); });

  function buildGrainCtl() {
    clear(grainCtl);
    grainCtl.append(segmented(GRAINS, state.grain, (v) => {
      state.grain = v;
      push();
      load();
    }, 'Calendar grain'));

    clear(habitCtl);
    if (!HABIT_GRAINS.has(state.grain)) return;
    habitCtl.append(el('button', {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(state.showHabits),
      text: 'Habits',
      title: state.showHabits ? 'Hide the habit marks' : 'Show the habit marks',
      on: {
        click: () => {
          state.showHabits = !state.showHabits;
          push();
          buildGrainCtl();
          paint();
        },
      },
    }));
  }

  /* ── data ── */

  async function load() {
    const { from, to } = bounds();
    buildGrainCtl();
    busy(true);
    /* The overlay is fetched for every grain the calendar can show it on, and
       a failure here degrades the overlay alone — the calendar is not a habits
       page and must still draw when that endpoint is down. */
    const [res, hab] = await Promise.all([
      sessionsIn({ from, to }),
      HABIT_GRAINS.has(state.grain)
        ? api(`/api/habits${qs({ from, to })}`)
        : Promise.resolve({ ok: false }),
    ]);
    busy(false);
    if (!alive) return;
    if (!res.ok) {
      clear(stripHost);
      panelError(pGrid.body, res.res, 'The session log');
      return;
    }
    state.sessions = res.items || [];
    state.timeframe = res.timeframe;
    state.habits = hab.ok ? (hab.data.habits || []) : null;
    paint();
  }

  /** The habits to overlay, or an empty list when there is nothing to draw. */
  function overlay() {
    if (!state.showHabits || !HABIT_GRAINS.has(state.grain)) return [];
    return state.habits || [];
  }

  /**
   * One row of habit marks for a day.
   *
   * Read-only spans, drawn by the same `dayCell` the widget and the Habits page
   * use, so a met Tuesday is the same shape everywhere it appears.
   */
  function habitMarks(iso, { compact = true } = {}) {
    const list = overlay();
    if (!list.length) return null;
    const row = el('div', { class: 'calhabits' });
    for (const h of list) {
      /* Named in the week grain, where there is room for words, and a mark
         with a tooltip in the month grid, where a cell is 60px wide. */
      const cell = dayCell(h, iso, (h.days || {})[iso], { compact });
      if (compact) { row.append(cell); continue; }
      row.append(el('span', { class: 'calhabit-named', style: hueStyle(h) }, [
        cell, el('span', { text: h.name }),
      ]));
    }
    return row;
  }

  /**
   * Habit rows for a day's tooltip.
   *
   * The habit is named on the left, in its own hue, and the right-hand side is
   * the fact and nothing else — a tick, a dash, or the hours. It used to spell
   * out "clean day" and "not marked clean" beside every name, which on a month
   * grid is three sentences per cell to say what three marks already said.
   *
   * The name is still there in full, so the colour is never carrying the row on
   * its own.
   */
  function habitTipRows(iso) {
    return overlay().map((h) => {
      const d = (h.days || {})[iso];
      return [h.name, daySymbol(h, d) || '—', hueOf(h)];
    });
  }

  /** Sessions keyed by date, in the order they were logged. */
  function byDay() {
    const m = new Map();
    for (const s of state.sessions) {
      if (!m.has(s.date)) m.set(s.date, []);
      m.get(s.date).push(s);
    }
    return m;
  }

  /* ── paint ── */

  function paint() {
    const { from, to } = bounds();
    const days = byDay();
    const today = todayISO();

    /* header */
    const title = state.grain === 'week'
      ? `${fmt.date(from)} – ${fmt.dateY(to)}`
      : state.grain === 'year'
        ? from.slice(0, 4)
        : dateOf(from).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    nav.querySelector('.calnav-title').textContent = title;
    const isNow = today >= from && today <= to;
    nav.querySelector('.calnav-rel').textContent = isNow
      ? `current ${state.grain}`
      : (to < today ? fmt.relDays(to) : fmt.relDays(from));
    btnNext.disabled = from > today;

    setTimeframe(pGrid, state.timeframe);
    paintStrip(from, to, today);

    clear(pGrid.body);
    pGrid.head.querySelector('.sub').textContent = state.grain === 'week'
      ? 'every session, in the order it was logged'
      : state.grain === 'month'
        ? 'one cell a day — colour is the modality, the number is how many'
        : 'twelve months at a glance; a day is one mark';

    if (state.grain === 'week') paintWeek(from, days, today);
    else if (state.grain === 'year') paintYear(from, days, today);
    else paintMonth(from, to, days, today);
  }

  /** Totals for whatever is on screen, so the grid always has a summary. */
  function paintStrip(from, to, today) {
    const list = state.sessions;
    const km = list.reduce((a, s) => a + Number(s.distance_km || 0), 0);
    const load = list.reduce((a, s) => a + Number(s.load || 0), 0);
    const active = new Set(list.map((s) => s.date)).size;
    /* Days that have actually happened — a month three days in is not
       twenty-eight days of rest. */
    const span = Math.round((dateOf(to > today ? today : to) - dateOf(from)) / 86400000) + 1;
    const kinds = orderKinds([...new Set(list.map((s) => s.kind))]);

    clear(stripHost);
    stripHost.append(statStrip([
      { label: 'Activities', value: fmt.int(list.length),
        note: kinds.length
          ? `${kinds.length} modalit${kinds.length === 1 ? 'y' : 'ies'}`
          : 'nothing logged' },
      { label: 'Active days', value: fmt.int(active),
        note: span > 0 ? `of ${span} elapsed` : 'none elapsed yet' },
      { label: 'On foot', value: km ? fmt.one(km) : '—', unit: km ? 'km' : '',
        note: 'every kilometre logged in this period' },
      { label: 'Load', value: fmt.int(load), unit: 'AU',
        note: 'summed over the sessions below' },
    ]));
  }

  /* ── week: everything, listed ── */

  function paintWeek(from, days, today) {
    const wrap = el('div', { class: 'calweek' });
    for (let i = 0; i < 7; i += 1) {
      const iso = addDays(from, i);
      const list = days.get(iso) || [];
      const future = iso > today;
      const col = el('section', {
        class: `calday${iso === today ? ' is-today' : ''}${future ? ' is-future' : ''}`,
      });
      col.append(el('div', { class: 'calday-head' }, [
        dowBadge(iso),
        el('span', { class: 'calday-date', text: fmt.date(iso) }),
        list.length
          ? el('b', { class: 'calday-n num', text: String(list.length) })
          : null,
      ].filter(Boolean)));
      const marks = future ? null : habitMarks(iso, { compact: false });
      if (marks) col.append(marks);
      if (list.length) col.append(sessionList(list));
      else {
        col.append(el('p', { class: 'empty calday-empty', text: future ? '—' : 'rest' }));
      }
      wrap.append(col);
    }
    pGrid.body.append(wrap);
  }

  /* ── month: the default ── */

  function paintMonth(from, to, days, today) {
    const grid = el('div', { class: 'calmonth' });
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      grid.append(el('div', { class: 'calmonth-dow', text: d }));
    }
    /* Monday-first, matching every week boundary in the app. */
    const pad = (dateOf(from).getDay() + 6) % 7;
    for (let i = 0; i < pad; i += 1) grid.append(el('div', { class: 'calcell is-pad' }));

    for (let iso = from; iso <= to; iso = addDays(iso, 1)) {
      const list = days.get(iso) || [];
      const future = iso > today;
      const kinds = orderKinds([...new Set(list.map((s) => s.kind))]);
      const load = list.reduce((a, s) => a + Number(s.load || 0), 0);
      const km = list.reduce((a, s) => a + Number(s.distance_km || 0), 0);

      const cell = el('div', {
        class: `calcell${iso === today ? ' is-today' : ''}`
          + `${future ? ' is-future' : ''}${list.length ? ' has-work' : ''}`,
        tabindex: list.length ? '0' : null,
        /* The cell's own date, so an audit can key a mark to a day without
           counting grid positions. `scripts/check_habits.py` was written
           against this and silently checked nothing until it existed. */
        'data-date': iso,
      });
      cell.append(el('div', { class: 'calcell-top' }, [
        el('span', { class: 'calcell-day num', text: String(Number(iso.slice(8, 10))) }),
        list.length ? el('b', { class: 'calcell-n num', text: String(list.length) }) : null,
      ].filter(Boolean)));

      if (kinds.length) {
        const bar = el('div', { class: 'calcell-kinds' });
        for (const k of kinds) {
          bar.append(el('i', { style: `background:${colorOf(k)}`, title: kindName(k) }));
        }
        cell.append(bar);
        /* Distance where there is distance, load where there is only load,
           and nothing where there is neither — a fasting day carries no load
           and no kilometres, and "0 AU" under it is noise pretending to be a
           measurement. The swatch and the count already say the day happened. */
        const fig = km ? `${fmt.one(km)} km` : (load > 0 ? `${fmt.int(load)} AU` : '');
        if (fig) cell.append(el('span', { class: 'calcell-fig num', text: fig }));
      }

      const marks = future ? null : habitMarks(iso);
      if (marks) {
        cell.append(marks);
        if (!cell.hasAttribute('tabindex')) cell.setAttribute('tabindex', '0');
      }

      /* The tooltip is where a day says what it was in words — the swatches
         alone would be colour carrying meaning on its own. The habit marks are
         held to the same rule and name themselves here. */
      attachTip(cell, () => ({
        title: `${fmt.weekday(iso)}, ${fmt.dateY(iso)}`,
        rows: [
          ...(list.length
            ? kinds.map((k) => [kindName(k), list.filter((s) => s.kind === k).length])
            : []),
          ...(future ? [] : habitTipRows(iso)),
        ],
        note: list.length
          ? `${fmt.int(load)} AU${km ? ` · ${fmt.one(km)} km` : ''}`
          : (future ? 'ahead of today' : 'nothing logged'),
      }));
      grid.append(cell);
    }
    pGrid.body.append(grid);
    pGrid.body.append(legend());
  }

  /* ── year: twelve small months ── */

  function paintYear(from, days, today) {
    const year = Number(from.slice(0, 4));
    const wrap = el('div', { class: 'calyear' });
    for (let m = 0; m < 12; m += 1) {
      const mStart = `${year}-${String(m + 1).padStart(2, '0')}-01`;
      const mEnd = monthEnd(mStart);
      const box = el('section', { class: 'calyear-m' });
      const total = [];
      for (let iso = mStart; iso <= mEnd; iso = addDays(iso, 1)) {
        total.push(...(days.get(iso) || []));
      }
      box.append(el('div', { class: 'calyear-h' }, [
        el('b', { text: dateOf(mStart).toLocaleDateString(undefined, { month: 'short' }) }),
        el('span', { class: 'num', text: total.length ? String(total.length) : '' }),
      ]));

      const g = el('div', { class: 'calyear-g' });
      const pad = (dateOf(mStart).getDay() + 6) % 7;
      for (let i = 0; i < pad; i += 1) g.append(el('i', { class: 'is-pad' }));
      for (let iso = mStart; iso <= mEnd; iso = addDays(iso, 1)) {
        const list = days.get(iso) || [];
        /* One mark per day, coloured by the modality that carried the most
           load — at four pixels a stacked split would be a smudge. */
        const top = list.slice().sort((a, b) => (b.load || 0) - (a.load || 0))[0];
        const dot = el('i', {
          class: `${iso === today ? 'is-today' : ''}${iso > today ? ' is-future' : ''}`.trim() || null,
          style: top ? `background:${colorOf(top.kind)}` : null,
          title: list.length
            ? `${fmt.dateY(iso)} — ${list.length} ${list.length === 1 ? 'activity' : 'activities'}`
            : fmt.dateY(iso),
        });
        g.append(dot);
      }
      box.append(g);
      wrap.append(box);
    }
    pGrid.body.append(wrap);
    pGrid.body.append(legend());
  }

  /** Which hue is which modality — colour never stands alone. */
  function legend() {
    const present = orderKinds([...new Set(state.sessions.map((s) => s.kind))]);
    const marks = overlay();
    if (!present.length && !marks.length) return emptyNote('Nothing logged in this period.');

    const wrap = el('div', { class: 'callegends' });
    if (present.length) {
      const ul = el('ul', { class: 'legend callegend' });
      for (const k of present) {
        const n = state.sessions.filter((s) => s.kind === k).length;
        ul.append(el('li', {}, [
          el('i', { style: `background:${colorOf(k)}` }),
          el('span', { text: kindName(k) }),
          el('b', { class: 'num', text: String(n) }),
        ]));
      }
      wrap.append(ul);
    }

    /* The habit marks sit in a fixed order down every cell, so the legend is
       that order read left to right — it names which position is which habit,
       which is the only thing a reader cannot work out from the grid. */
    if (marks.length) {
      const ul = el('ul', { class: 'legend callegend calhablegend' });
      for (const h of marks) {
        ul.append(el('li', {}, [
          /* A swatch, not a day: a legend mark that announced itself as a
             date would be a second Tuesday on the page. */
          el('span', { class: `hbcell is-${STATES.met.mark} is-compact`, 'aria-hidden': 'true' },
             [el('i')]),
          el('span', { text: h.name }),
          el('b', { class: 'num', text: `${h.totals.met}/${h.totals.scored}` }),
        ]));
      }
      wrap.append(ul);
    }
    return wrap;
  }

  buildGrainCtl();
  load();

  return {
    destroy() { alive = false; },
    refresh: load,
    keys(e) {
      if (e.key === 'ArrowLeft') { step(-1); return true; }
      if (e.key === 'ArrowRight') { step(1); return true; }
      if (e.key === 't') { btnToday.click(); return true; }
      return false;
    },
  };
}
