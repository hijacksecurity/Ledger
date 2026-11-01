/* Habits — the small daily things, and whether they are actually happening.
 *
 * The page is built around one requirement the user stated plainly: marking a
 * day has to be one tap and nothing else. So the top of the page is today, at
 * full size, with a button per habit — no date picker, no form, no confirm.
 * Everything below it is history you can correct, which is a different job and
 * sits in a different panel rather than competing with the tap.
 *
 * Two things this page deliberately does not have:
 *
 *   **No streak.** Rolling rates over the window on screen, which can fall and
 *   recover. There is nothing to protect and nothing that resets, which is the
 *   same rule the rest of the app has kept since the first commit — habits are
 *   simply where it is hardest to hold.
 *
 *   **No congratulation.** A perfect week reads "7 of 7". That is the whole
 *   sentence. The Scoreboard is the one place in this product that grades, and
 *   this page feeds it rather than duplicating it.
 *
 * Sleep is measured, not tapped: the nightly Garmin sync already writes
 * `metric_daily.sleep_hours`, so asking for a tick would be data entry for
 * something the watch knows. It stays correctable — tap the night and type
 * what actually happened, the same way an estimated RPE can be typed over.
 */

import {
  el, icon, clear, api, qs, busy, fmt, todayISO, addDays, weekStart, toast, token,
} from './core.js';
import { figure } from './charts.js';
import { habitsPillar } from './score.js';
import {
  panel, panelError, statStrip, segmented, emptyNote, skeletonBlock,
  setTimeframe, sectionRule, collapsible, readout,
} from './ui.js';
import {
  daysStrip, marksLegend, datesOf, ratePct, rateWords, targetText,
  valueText, dayWords, editable, checkBox, measureBox, hueStyle,
} from './habits.js';

/* Windows worth having. A week is the unit the rest of the app works in; 28
   days is the rhythm every rolling figure here uses; 12 weeks is long enough
   to see whether something stuck. Nothing longer — a habit you kept in March
   is not evidence about this month. */
const RANGES = [['week', 'This week'], ['28d', '28 days'], ['12w', '12 weeks']];

/* The grid panel's own heading, per window. It read "The week" over eighty-four
   days for one round — a title contradicting the thing under it, which is the
   one class of defect the audit here actually checks for. The timeframe line
   beneath still states the window verbatim from the server; this is only the
   noun the panel calls itself. */
const GRID_TITLE = {
  week: 'The week',
  '28d': 'The last four weeks',
  '12w': 'The last twelve weeks',
};

/** A target is a round figure somebody chose, so 8 prints as 8 and not 8.0. */
const whole = (v) => (Number.isInteger(v) ? String(v) : fmt.one(v));

function boundsFor(key, today) {
  if (key === 'week') {
    const from = weekStart(today);
    return { from, to: addDays(from, 6) };
  }
  if (key === '12w') return { from: addDays(today, -83), to: today };
  return { from: addDays(today, -27), to: today };
}

export function mount(host, route, { setQuery }) {
  const q = route.query;
  const state = {
    range: RANGES.some(([k]) => k === q.get('range')) ? q.get('range') : 'week',
    payload: null,
    trend: null,
    /* The night whose number is being corrected, or null. One at a time: an
       editor per row would be six inputs on screen to change one figure. */
    editing: null,
  };
  let alive = true;
  let figTrend = null;

  const today = todayISO();

  const nav = el('div', { class: 'weeknav habitnav' });
  const rangeCtl = el('div', { class: 'filter' });
  nav.append(
    el('div', { class: 'weeknav-label' }, [
      el('strong', { text: 'Habits' }),
      el('span', { class: 'weeknav-rel', text: 'one tap a day' }),
    ]),
    el('div', { class: 'weeknav-spacer' }),
    rangeCtl,
  );

  const stripHost = el('div', { class: 'strip-host' });

  const pToday = panel({
    title: 'Today',
    sub: ' ',
    kicker: 'One tap',
    wide: true,
  });
  const pGrid = panel({
    title: 'The week',
    sub: 'tap any day — today, or one you forgot',
    wide: true,
    kicker: 'Log',
  });
  /* How the habits are going over time. Weeks, not days: a day is a coin toss
     and a week is a habit. The column is the same figure the Scoreboard's
     habits pillar carries — `habitsPillar` is called on each week's totals, so
     a column and that pillar cannot drift apart. */
  const pTrend = panel({
    title: 'Week by week',
    sub: 'every habit, averaged, for each week you have been keeping them',
    wide: true,
    kicker: 'Trend',
  });

  const pManage = panel({
    title: 'The list',
    sub: 'add one, rename one, or put one away',
    kicker: 'Settings',
  });

  host.append(nav, stripHost, pToday, pGrid, sectionRule('Over time'), pTrend,
              sectionRule('Detail'), pManage);
  skeletonBlock(96, stripHost);
  skeletonBlock(170, pToday.body);
  skeletonBlock(200, pGrid.body);
  skeletonBlock(180, pTrend.body);
  skeletonBlock(90, pManage.body);

  /* ── data ── */

  function bounds() { return boundsFor(state.range, today); }

  async function load() {
    buildRangeCtl();
    const { from, to } = bounds();
    busy(true);
    const [res, tr] = await Promise.all([
      api(`/api/habits${qs({ from, to })}`),
      api('/api/habits/trend?weeks=12'),
    ]);
    busy(false);
    if (!alive) return;
    state.trend = tr.ok ? tr.data : null;
    if (!res.ok) {
      clear(stripHost);
      panelError(pToday.body, res, 'Habits');
      panelError(pGrid.body, res, 'The habit log');
      clear(pManage.body);
      return;
    }
    state.payload = res.data;
    paint();
  }

  /**
   * Write one day, then repaint from the server's answer.
   *
   * The response carries the whole window this page is showing, so nothing is
   * re-derived here — the tap does not compute what it thinks the new state is
   * and draw that. A UI that predicts its own writes is a UI that eventually
   * disagrees with the database.
   */
  async function write(habit, date, body) {
    const { from, to } = bounds();
    busy(true);
    const res = await api(`/api/habits/${habit.key}/${date}${qs({ from, to })}`, {
      method: 'PUT', body,
    });
    busy(false);
    if (!alive) return;
    if (!res.ok) { toast(res.error || 'Could not save that.'); return; }
    state.payload = res.data;
    paint();
  }

  const toggle = (habit, date, d) => {
    if (!editable(d)) return;
    if (habit.mode === 'metric') { state.editing = { key: habit.key, date }; paint(); return; }
    write(habit, date, { done: d.state !== 'met' });
  };

  /* ── controls ── */

  function buildRangeCtl() {
    clear(rangeCtl);
    rangeCtl.append(segmented(RANGES, state.range, (v) => {
      state.range = v;
      state.editing = null;
      setQuery({ range: v });
      load();
    }, 'Window'));
  }

  /* ── paint ── */

  function paint() {
    const p = state.payload;
    const habits = p.habits || [];
    const dates = datesOf(p);

    setTimeframe(pGrid, p.timeframe);
    pGrid.head.querySelector('h2').textContent = GRID_TITLE[state.range] || 'Every day';

    paintStrip(habits);
    paintToday(habits, dates);
    paintGrid(habits, dates);
    paintTrend();
    paintManage(habits);
  }

  /* Rates across the top, one tile per habit. Every tile prints its own
     division — the figure and the two numbers it came from — because a
     percentage with no denominator is the thing this codebase has been bitten
     by most often. */
  function paintStrip(habits) {
    clear(stripHost);
    if (!habits.length) return;
    stripHost.append(statStrip(habits.map((h) => {
      const pct = ratePct(h);
      return {
        label: h.name,
        value: pct == null ? '—' : fmt.int(pct),
        unit: pct == null ? '' : '%',
        note: rateWords(h, { noun: h.mode === 'metric' ? 'nights' : 'days' }),
      };
    })));
  }

  /* ── today ── */

  function paintToday(habits, dates) {
    clear(pToday.body);
    const p = state.payload;
    const inWindow = dates.includes(p.today);

    pToday.head.querySelector('.sub').textContent = inWindow
      ? fmt.dowDate(p.today)
      : 'not in this window';

    if (!inWindow) {
      pToday.body.append(emptyNote(
        'This window ends before today. Switch to This week to mark today off.',
      ));
      return;
    }

    const list = el('div', { class: 'hbtoday' });
    for (const h of habits) {
      const d = (h.days || {})[p.today] || {};
      const met = d.state === 'met';
      const measured = h.mode === 'metric';

      const row = el('div', {
        class: `hbtoday-row${met ? ' is-met' : ''}${measured ? ' is-measured' : ''}`,
      });

      /* The box leads the row, where a checklist puts it. Everything else on
         the line is description of the thing being checked. */
      row.append(measured
        ? measureBox(h, d)
        : checkBox(h, p.today, d, {
          size: 'lg',
          onTap: () => write(h, p.today, { done: !met }),
        }));

      row.append(el('div', { class: 'hbtoday-label' }, [
        el('b', { text: h.name }),
        el('span', {
          class: 'hbtoday-note',
          text: measured
            ? (d.source === 'manual' ? 'corrected by hand' : (d.source ? 'from Garmin' : 'not in yet — the watch reports overnight'))
            : dayWords(h, d),
        }),
      ]));

      /* Correcting a measured night is a rare action on a common page, so it
         is an icon at the end of the row rather than a button competing with
         the three that are pressed daily. */
      if (measured) {
        row.append(el('button', {
          class: 'iconbtn hbtoday-edit',
          type: 'button',
          title: `Correct ${h.name} for ${fmt.dowDate(p.today)}`,
          on: { click: () => { state.editing = { key: h.key, date: p.today }; paint(); } },
        }, [icon('edit'), el('span', { class: 'sr', text: `Correct ${h.name}` })]));
      }

      list.append(row);

      if (state.editing && state.editing.key === h.key && state.editing.date === p.today) {
        list.append(editorFor(h, p.today, d));
      }
    }
    pToday.body.append(list);
  }

  /* ── the grid ── */

  function paintGrid(habits, dates) {
    clear(pGrid.body);
    if (!habits.length) {
      pGrid.body.append(emptyNote('No habits yet. Add one below.'));
      return;
    }

    /* Seven days is a table you read across; eighty-four is a strip you scan.
       The two want different column widths, different headers and different
       cell contents, and pretending one layout serves both is what made the
       first version cramped at one end and empty at the other. */
    const short = dates.length <= 10;
    const today = state.payload.today;

    const wrap = el('div', { class: `hbgrid-wrap table-wrap scroll${short ? ' is-week' : ''}` });
    const grid = el('div', { class: `hbgrid${short ? ' is-week' : ''}` });

    const head = el('div', { class: 'hbgrid-row is-head' });
    head.append(el('div', { class: 'hbgrid-name' }));
    const cells = el('div', { class: `hbgrid-days${short ? '' : ' is-compact'}` });
    for (const date of dates) {
      const isMonday = weekStart(date) === date;
      const isToday = date === today;
      const cell = el('span', {
        class: `hbgrid-dh${isToday ? ' is-today' : ''}${isMonday ? ' is-weekstart' : ''}`,
        title: fmt.dowDate(date),
      });
      if (short) {
        /* Weekday over day-of-month: "which column is Wednesday" and "which
           day was that" are both questions you ask of a week, and a single
           letter answers only the first. */
        cell.append(
          el('b', { text: fmt.dow(date) }),
          el('span', { class: 'num', text: String(Number(date.slice(8, 10))) }),
        );
      } else if (isMonday) {
        cell.append(el('span', { class: 'num', text: fmt.date(date) }));
      }
      cells.append(cell);
    }
    head.append(cells);
    grid.append(head);

    for (const h of habits) {
      const row = el('div', { class: 'hbgrid-row', style: hueStyle(h) });
      row.append(el('div', { class: 'hbgrid-name' }, [
        el('span', { class: 'hbgrid-title' }, [
          el('i', { class: 'hbgrid-tick', 'aria-hidden': 'true' }),
          el('b', { text: h.name }),
        ]),
        targetText(h) ? el('span', { class: 'hbgrid-target', text: targetText(h) }) : null,
      ].filter(Boolean)));
      row.append(daysStrip(h, dates, {
        compact: !short,
        showValue: short,
        today,
        onTap: toggle,
      }));
      grid.append(row);
    }

    wrap.append(grid);
    pGrid.body.append(wrap);
    pGrid.body.append(marksLegend());
    pGrid.body.append(gridNotes(habits));

    if (state.editing) {
      const h = habits.find((x) => x.key === state.editing.key);
      const d = h ? (h.days || {})[state.editing.date] : null;
      if (h && d && state.editing.date !== state.payload.today) {
        pGrid.body.append(editorFor(h, state.editing.date, d));
      }
    }
  }

  /**
   * The two things the marks cannot say for themselves.
   *
   * The rates live in the tiles at the top of the page and are deliberately
   * not repeated here — a figure printed twice on one screen is how this app
   * has twice ended up with two numbers for one quantity. What is left is the
   * denominator (which days count) and the partial band (the only arithmetic
   * on the page you could not work out by counting marks).
   */
  function gridNotes(habits) {
    const p = state.payload;
    const notes = el('div', { class: 'hbnotes' });

    notes.append(el('p', {
      class: 'note',
      text: p.scored_through
        ? `Counted through ${fmt.dowDate(p.scored_through)}. Today is shown but not counted `
          + 'until it is over.'
        : 'Nothing in this window has finished yet, so there is no rate to show.',
    }));

    for (const h of habits.filter((x) => x.mode === 'metric' && x.target != null)) {
      notes.append(el('p', {
        class: 'note',
        text: `${h.name}: ${whole(h.target)}${h.unit || ''} earns the tick. `
          + (h.partial_at != null
            ? `Between ${whole(h.partial_at)}${h.unit || ''} and ${whole(h.target)}${h.unit || ''} `
              + 'the night earns part of one, so a short night reads as a short night '
              + 'rather than a failure. Below that it earns nothing. A night with no '
              + 'reading is left out of the division entirely.'
            : 'Anything below it earns nothing.'),
      }));
    }
    return notes;
  }

  /**
   * Correct one measured night.
   *
   * Two buttons, because there are two distinct things to do: write a number
   * the watch got wrong, or throw your correction away and let the sync's own
   * figure stand again. The second only appears when there is a correction to
   * throw away — a control that would do nothing is not offered.
   */
  function editorFor(h, date, d) {
    const box = el('form', { class: 'hbeditor' });
    const input = el('input', {
      class: 'input hbeditor-input', type: 'number', step: '0.05', min: '0', max: '24',
      value: d.value != null ? String(d.value) : '',
      'aria-label': `${h.name} on ${fmt.dowDate(date)}`,
    });

    box.append(
      el('div', { class: 'hbeditor-head' }, [
        el('b', { text: fmt.dowDate(date) }),
        el('span', {
          class: 'hbeditor-src',
          text: d.source === 'manual'
            ? 'corrected by hand'
            : (d.source === 'garmin' ? 'from Garmin' : 'nothing recorded'),
        }),
      ]),
      el('div', { class: 'hbeditor-row' }, [
        input,
        el('span', { class: 'hbeditor-unit', text: h.unit || '' }),
        el('button', { class: 'btn btn-primary', type: 'submit', text: 'Save' }),
        d.source === 'manual'
          ? el('button', {
            class: 'btn btn-quiet', type: 'button', text: "Use Garmin's",
            on: {
              click: () => { state.editing = null; write(h, date, { value: null }); },
            },
          })
          : null,
        el('button', {
          class: 'btn btn-quiet', type: 'button', text: 'Cancel',
          on: { click: () => { state.editing = null; paint(); } },
        }),
      ].filter(Boolean)),
    );

    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = input.value.trim();
      if (raw === '') { toast('Enter a number, or cancel.'); return; }
      state.editing = null;
      write(h, date, { value: Number(raw) });
    });
    setTimeout(() => input.focus(), 0);
    return box;
  }

  /* ── over time ── */

  /**
   * One column per week, each the mean of every habit's own rate for that week.
   *
   * Scored through `habitsPillar`, which is what the Scoreboard's habits pillar
   * uses, so the column for this week and the pillar on `#/score` are the same
   * number by construction rather than by agreement.
   *
   * A week nobody was keeping habits in is not a week scoring zero — the server
   * marks those days `untracked` and leaves them out of every denominator, so
   * such a week arrives with `rate: null` and is simply absent from the chart.
   * That is the whole of the empty state: a habit started on Monday has one
   * week of history and the panel says so in words rather than drawing eleven
   * columns of failure at something nobody was asked to do.
   */
  function paintTrend() {
    if (figTrend) { figTrend.destroy && figTrend.destroy(); figTrend = null; }
    clear(pTrend.body);

    const tr = state.trend;
    if (!tr) {
      pTrend.body.append(emptyNote('The week-by-week history could not be loaded.'));
      return;
    }
    setTimeframe(pTrend, tr.timeframe);

    /* The first Monday any habit was being kept. Weeks before it are drawn as
       empty slots on the axis rather than left out: the frame is the point on
       week one — you can see what is coming and watch it fill — and an empty
       slot is not a zero. */
    const since = (state.payload.habits || [])
      .map((h) => h.since).filter(Boolean).sort()[0] || null;

    const current = weekStart(tr.today);
    const weeks = (tr.weeks || []).map((w) => {
      const tracked = !since || w.week_end >= since;
      const pillar = tracked ? habitsPillar({ habits: w.habits }) : null;
      return {
        week: w.week_start,
        tracked,
        score: pillar ? pillar.score : null,
        detail: pillar ? pillar.detail : null,
      };
    });

    if (!weeks.length) {
      pTrend.body.append(emptyNote('No weeks to show yet.'));
      return;
    }

    const chart = el('div');
    pTrend.body.append(chart);
    figTrend = figure(chart, {
      type: 'columns',
      aria: `Habits kept, week by week, over the last ${weeks.length} weeks`,
      height: 210,
      unit: 'out of 100',
      periodLabel: 'Week of',
      labels: 'all',
      series: [{ key: 'score', label: 'Habits kept', color: token('ink-2') }],
      points: weeks.map((w) => ({
        key: w.week,
        label: fmt.date(w.week),
        /* `empty` is the difference between "nothing was kept" and "nothing
           was asked": an untracked week draws no column, no baseline tick and
           no label, and its slot simply waits. */
        empty: !w.tracked || w.score == null,
        values: { score: w.score == null ? 0 : Math.round(w.score) },
        total: w.score == null ? 0 : Math.round(w.score),
        note: !w.tracked
          ? 'before you started keeping habits'
          : w.score == null
            ? 'no day in this week has finished'
            : (w.week === current ? 'this week, still running' : w.detail),
      })),
      format: (v) => `${Math.round(v)} / 100`,
      formatShort: (v) => String(Math.round(v)),
    });

    /* What the chart cannot say yet. Finished weeks only — a week two days old
       is not a lower week, it is a shorter one. */
    const scored = weeks.filter((w) => w.score != null);
    const done = scored.filter((w) => w.week !== current);
    const lines = [];

    if (done.length >= 2) {
      const first = done[0];
      const last = done[done.length - 1];
      const move = Math.round(last.score - first.score);
      lines.push(
        `${Math.round(last.score)} out of 100 in the week of ${fmt.date(last.week)}, `
        + `against ${Math.round(first.score)} in the week of ${fmt.date(first.week)} — `
        + `${move > 0 ? `up ${move} points` : move < 0 ? `down ${-move} points` : 'level'} `
        + `over ${done.length} finished weeks.`,
      );
      const best = done.reduce((a, w) => (w.score > a.score ? w : a), done[0]);
      lines.push(`Best so far: ${Math.round(best.score)} in the week of ${fmt.date(best.week)}.`);
    } else if (done.length === 1) {
      lines.push(
        `One finished week so far, at ${Math.round(done[0].score)} out of 100. `
        + 'A direction needs two.',
      );
    }
    if (lines.length) pTrend.body.append(readout(lines));

    const running = scored.find((w) => w.week === current);
    pTrend.body.append(el('p', { class: 'note', text:
      (done.length === 0
        ? (running
          ? `This is the first week. It is running at ${Math.round(running.score)} out of 100 `
            + 'so far, and the empty columns fill in one a week from here.'
          : 'Nothing has finished yet. The first column appears once a day in this week is over.')
        : 'Each week is the mean of every habit\'s own rate that week — the same '
          + 'figure the Scoreboard scores habits on.')
      + ' A week before you started keeping a habit is left empty rather than '
      + 'counted as a zero.' }));
  }

  /* ── the list ── */

  function paintManage(habits) {
    clear(pManage.body);

    const rows = el('ul', { class: 'hblist' });
    for (const h of habits) {
      rows.append(el('li', { style: hueStyle(h) }, [
        el('div', { class: 'hblist-main' }, [
          el('i', { class: 'hblist-tick', 'aria-hidden': 'true' }),
          el('div', { class: 'hblist-text' }, [
            el('b', { text: h.name }),
            el('span', {
              class: 'hblist-mode',
              text: h.mode === 'metric'
                ? `measured — ${h.source_field} from the nightly sync`
                : (h.polarity === 'avoid' ? 'tapped — ticked for not doing it' : 'tapped'),
            }),
          ]),
        ]),
        el('button', {
          class: 'btn btn-quiet', type: 'button', text: 'Put away',
          title: `Stop tracking ${h.name}. Its history is kept.`,
          on: { click: () => archive(h) },
        }),
      ]));
    }
    pManage.body.append(rows);

    const form = el('form', { class: 'hbadd' });
    const name = el('input', {
      class: 'input', type: 'text', placeholder: 'Something else to keep',
      'aria-label': 'New habit name', maxlength: '60',
    });
    /* A chip rather than a checkbox. The native box is a 13px target — under
       the tap floor this app holds itself to — and chips are already how every
       other binary choice here is made. */
    let avoiding = false;
    const avoid = el('button', {
      class: 'chip hbadd-avoid', type: 'button', 'aria-pressed': 'false',
      title: 'Tick this habit for NOT doing the thing — a clean day',
      text: 'ticked for not doing it',
      on: {
        click: () => {
          avoiding = !avoiding;
          avoid.setAttribute('aria-pressed', String(avoiding));
        },
      },
    });
    form.append(name, avoid, el('button', { class: 'btn', type: 'submit', text: 'Add' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = name.value.trim();
      if (!text) return;
      busy(true);
      const res = await api('/api/habits', {
        method: 'POST',
        body: { name: text, polarity: avoiding ? 'avoid' : 'do' },
      });
      busy(false);
      if (!res.ok) { toast(res.error || 'Could not add that.'); return; }
      name.value = '';
      load();
    });

    pManage.body.append(collapsible('Add a habit', form));
    pManage.body.append(el('p', {
      class: 'note',
      text: 'Putting a habit away stops it being tracked and scored. Nothing is '
        + 'deleted — the weeks you did keep it stay exactly as they were.',
    }));
  }

  async function archive(h) {
    busy(true);
    const res = await api(`/api/habits/${h.key}`, { method: 'PATCH', body: { archived: true } });
    busy(false);
    if (!res.ok) { toast(res.error || 'Could not put that away.'); return; }
    toast(`${h.name} put away.`);
    load();
  }

  load();

  return {
    destroy() {
      alive = false;
      if (figTrend && figTrend.destroy) figTrend.destroy();
    },
    refresh: load,
  };
}
