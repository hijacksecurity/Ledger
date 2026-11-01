/* Week view — the default. One week, in the order the paper notebook read:
 * how often, then how hard, then what actually happened, then what you wrote
 * about it.
 */

import {
  el, icon, clear, api, qs, busy, fmt, colorOf, orderKinds, KINDS, ON_FOOT,
  addDays, reducedMotion, rememberSessions, toast, bumpRevision,
  getWeightUnit, inUnit, dateOf, todayISO,
} from './core.js';
import {
  panel, panelError, statStrip, sessionList, factsLine, acwrMeter,
  countBars, readout, emptyNote, skeletonLines, skeletonBlock, kindName,
  setTimeframe,
} from './ui.js';
import { figure, splitBar, sparkline } from './charts.js';
import {
  weekReadout, invalidate, weekIntent, goalWeightLb, latestWeighIn, weighInDelta, cached,
} from './dataset.js';
import {
  recoveryContext, lastNight, nightOfText, measureCards, SNAPSHOT_KEYS, BASELINE_NIGHTS,
} from './recovery-cards.js';
import {
  scoreWeek, band, toKg, inputFromSummary, weightedPace, attainTone,
} from './score.js';
import {
  daysStrip, editable, checkBox, hueStyle, measureBox, ratePct,
} from './habits.js';

/* `ledger.loadWeeks` in localStorage is no longer read or written — the control
   that set it is gone with the chart it sized. Old entries are harmless. */

export function mount(host, route) {
  const state = {
    weekOf: route.parts[1] || null,
    /* Still sent to /api/summary because the read-out compares this week
       against a recent mean, and that mean needs a history to be a mean of.
       It is no longer a control: nothing on this page plots the span, so
       nothing on this page lets you change it. */
    weeks: 12,
    data: null,
    latest: null,
    /* `undefined` means the committed plan has not been fetched yet, which is
       not the same as "nothing is committed" — the panel holds its skeleton
       rather than flashing an empty state on every load. */
    locked: undefined,
    /* Same rule as `locked`: `undefined` is "not fetched", `null` is "asked
       and there was nothing". The widget holds its skeleton for the first and
       states the fact for the second. */
    habits: undefined,
    /* Same again for the nights: `undefined` until `/api/metrics` answers. */
    recovery: undefined,
  };
  let figures = [];
  let distFig = null;

  /* Names for the two pillars the widget shows. The full map lives on the
     Scoreboard; this is the short list, not a second copy of it. */
  const PILLAR_NAME = {
    soccer: 'Soccer', consistency: 'Consistency', running: 'Running',
    adherence: 'Plan adherence', habits: 'Habits', body: 'Bodyweight', load: 'Load',
  };
  /* Real words. Three-letter codes save about forty pixels and cost the reader
     a decoding step every time — "SOC / CON / PLN" is a chart legend nobody
     asked to learn. The strip wraps its labels instead. */
  const PILLAR_SHORT = {
    soccer: 'Soccer', consistency: 'Activity', running: 'Running',
    adherence: 'Plan', habits: 'Habits', body: 'Weight', load: 'Load',
  };
  let alive = true;

  /* ── frame ── */

  const nav = el('div', { class: 'weeknav' });
  const btnPrev = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Previous week' }, [icon('left')]);
  const btnNext = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Next week' }, [icon('right')]);
  const rangeLabel = el('div', { class: 'weeknav-label' }, [
    el('strong', { id: 'wk-range', text: ' ' }),
    el('span', { class: 'weeknav-rel', id: 'wk-rel' }),
  ]);
  const jump = el('input', {
    class: 'input weeknav-jump', type: 'date',
    'aria-label': 'Jump to the week containing this date',
  });
  const btnToday = el('button', { class: 'btn btn-quiet', type: 'button', text: 'This week' });
  nav.append(btnPrev, rangeLabel, btnNext, el('div', { class: 'weeknav-spacer' }));

  /* No context-depth control any more. It existed to size the load history
     chart, and that chart has moved off this page — leaving it would have been
     a control that changes a window the reader can no longer see. The week
     arrows are the only thing on this page that selects anything. */

  const hero = el('section', { class: 'hero' });
  const heroFig = el('div', { class: 'hero-figure' });
  const heroAside = el('div', { class: 'hero-aside' });
  hero.append(heroFig, heroAside);

  const stripHost = el('div', { class: 'strip-host' });

  /* Distance against the committed plan, high on the page because it is the
     one thing here that is actionable *during* the week: everything else on
     this view reports what happened, and this says what is still to do. */
  const pDist = panel({
    title: 'Distance this week',
    sub: 'against the committed plan',
    wide: true,
    /* No hue: the panel now splits by modality, and colouring the header with
       one of them would claim a subject it does not have. */
    kicker: 'Committed plan',
  });

  /* The score, at a glance. The whole system lives on `#/score`; this is the
     one number and the two chips, because "how is this week going" is a
     question the front page should answer without a second click. Anything
     more here would be the Scoreboard, twice. */
  const pScore = panel({ title: 'Week score', sub: ' ', kicker: 'Scored' });

  /* Habits sit directly under the distance panel, above everything that
     reports: both are things you can still do something about today, and the
     rest of this page is a record of what already happened. The widget is the
     whole of the daily interaction — one tap per habit — and `#/habits` is
     where the history and the corrections live. Putting the grid here too
     would be the Habits page, twice. */
  const pHabits = panel({
    title: 'Habits',
    sub: ' ',
    wide: true,
    kicker: 'One tap',
  });

  /* The morning's snapshot: five of the Recovery page's cards, built by the
     same code (`recovery-cards.js`) from the same rows, so the number here is
     the number there. Last night large, then the week and the 28 nights under
     it, each on the scale named on the card. It sits with Habits because both
     are about today; everything below reports what already happened. The
     charts, the findings and the other two measures stay on `#/recovery` —
     drawing them here would be that page, twice. */
  const pRecov = panel({
    title: 'Recovery', sub: ' ', wide: true, kicker: 'Last night',
  });

  const pSplit = panel({
    title: 'This week on one scale', sub: 'training load, split by modality',
    kicker: 'Measured',
  });
  /* Named for what it is. The number is a ratio of two rolling means and the
     brief is explicit that it never becomes a verdict, so the header says so
     before the figure is read rather than in a footnote after it. */
  const pAcwr = panel({ title: 'Acute : chronic', kicker: 'Heuristic' });
  /* Two compact verdict cards beside each other, then the split bar with a
     full row to itself. Adding the score to a two-up row and pushing
     acute:chronic onto a row of its own left that card at half width with
     an empty column beside it, which reads as a rendering fault. */
  const rowA = el('div', { class: 'grid-2' }, [pScore, pAcwr]);


  /* "Unified load" (12/26/52 weeks of bars) and "Activity mix" (a trailing
     28-day count) are built but no longer placed on this page. Both plot a span
     other than the week, which is the one thing this page is about, and both
     already exist on Trends under its own range control — "Load — all
     modalities" and "Mix over time" are the same charts against the same data.
     Keeping them here bought a duplicate and cost the page a single window.

     They are still constructed because `paint()` fills them; they simply never
     reach the DOM. Deleting the paint paths as well is the tidier follow-up. */
  const pLoad = panel({ title: 'Unified load', sub: ' ', wide: true });
  const pMix = panel({ title: 'Activity mix', sub: ' ' });

  const pRead = panel({
    title: 'Read-out', sub: 'this week against its own recent history', wide: true,
    kicker: 'Plain facts',
  });

  const pSessions = panel({ title: 'Sessions', sub: ' ', kicker: 'Log' });
  const pBests = panel({ title: 'Personal bests', kicker: 'Records' });

  const pNote = panel({
    title: 'Week notes',
    sub: 'the Notes: block from the notebook page — one line each',
    kicker: 'Your words',
  });
  const pWeigh = panel({
    title: 'Start-of-week weigh-in',
    sub: 'one reading, taken at the top of the week',
    kicker: 'Measurement',
  });

  /* Sessions is the one panel here with no ceiling — a heavy week is a long
     list — so everything short sits in a column beside it rather than under
     it. Left to its own row, notes ended up a long way below the sessions they
     are about, with a stranded half-row of white between them. */
  const rowB = el('div', { class: 'grid-week' }, [
    pSessions,
    el('div', { class: 'stack' }, [pNote, pWeigh, pBests]),
  ]);

  const foot = el('div', { class: 'footnotes' });

  nav.append(jump, btnToday);
  host.append(nav, hero, stripHost, pDist, pHabits, pRecov, rowA, pSplit, pRead, rowB, foot);

  heroFig.append(el('div', { class: 'sk', style: 'height:5.5rem;width:9rem' }));
  skeletonLines(2, heroAside);
  skeletonBlock(96, stripHost);
  skeletonBlock(190, pDist.body);
  skeletonBlock(120, pHabits.body);
  skeletonBlock(170, pRecov.body);
  skeletonBlock(120, pScore.body);
  skeletonBlock(90, pSplit.body);
  skeletonBlock(90, pAcwr.body);
  skeletonLines(4, pRead.body);
  skeletonLines(5, pSessions.body);
  skeletonLines(2, pBests.body);
  skeletonBlock(120, pNote.body);
  skeletonLines(2, pWeigh.body);

  /* ── data ── */

  async function fetchWeek({ keepFrame = false } = {}) {
    busy(true);
    const res = await api(`/api/summary${qs({ week_of: state.weekOf, weeks: state.weeks })}`);
    busy(false);
    if (!alive) return;
    if (!res.ok) {
      if (!keepFrame) {
        clear(heroFig); clear(heroAside); clear(stripHost);
        panelError(pLoad.body, res, 'The week summary');
        panelError(pSessions.body, res, 'Sessions');
        clear(pSplit.body); clear(pAcwr.body); clear(pMix.body);
        clear(pBests.body); clear(pRead.body); clear(pNote.body);
      }
      return;
    }
    state.data = res.data;
    state.weekOf = res.data.week.end;
    state.latest = res.data.latest_week_end;
    rememberSessions(res.data.sessions);
    paint();

    /* The committed plan is a second endpoint and a slower one, so it is not
       awaited before the page draws — the distance panel fills in when it
       lands. It is fetched once per week change rather than once per mount,
       because the target is per week. */
    /* The third request is the pace baseline. It is not optional: without it
       `runningPillar` drops its pace half and scores distance alone, so this
       page read 88 while the Scoreboard read 89 for the same week — the same
       function, fed different arguments. Sharing `inputFromSummary` stops the
       formula diverging; only passing identical inputs stops the *number*
       diverging, which is the part that matters. */
    const weekStartISO = (state.data.week || {}).start;
    /* Habits is a fourth request and it is not optional either: the pillar it
       feeds is 10% of the score, and `scoreWeek` would quietly drop it and
       renormalise the other six — giving this page a different total from the
       Scoreboard for the same week. That is the exact failure the pace
       baseline above was added to stop, so it is fetched the same way. */
    /* The nights: the 28 ending today for the big numbers and the baseline
       (the same cache entry the Recovery page fills), and the week on screen
       for its own row — one fetch for either week, so a past week reads its
       own nights rather than none. */
    const today = todayISO();
    const weekEndISO = (state.data.week || {}).end;
    const [lk, soc, prior, hab, base, wk] = await Promise.all([
      api('/api/plan/locked'),
      api('/api/soccer'),
      api(`/api/sessions${qs({
        from: addDays(weekStartISO, -28), to: addDays(weekStartISO, -1),
        kind: 'run', limit: 200,
      })}`),
      api(`/api/habits${qs({ from: weekStartISO, to: weekEndISO })}`),
      cached(`metrics:base:${today}`, `/api/metrics${qs({ from: addDays(today, -(BASELINE_NIGHTS - 1)), to: today })}`),
      cached(`metrics:${weekStartISO}:${weekEndISO}`, `/api/metrics${qs({ from: weekStartISO, to: weekEndISO })}`),
    ]);
    if (!alive) return;
    state.locked = lk.ok ? lk.data : null;
    state.soccer = soc.ok ? soc.data : null;
    state.paceBefore = prior.ok ? weightedPace(prior.data.items || []) : null;
    state.habits = hab.ok ? hab.data : null;
    state.recovery = { base, wk, today };
    paintDistance();
    paintHabits();
    paintRecovery();
    paintScore();
  }


  /**
   * Last night and the week, on the Recovery page's own cards.
   *
   * Nothing is decided here: which night is last, what a reading is called
   * and how a mean is tagged all come from `recovery-cards.js`, and the rows
   * are `/api/metrics` as served. The week row is the week on screen — "This
   * week" when today is in it, otherwise named by its Monday — so the arrows
   * move this panel the way they move every other one.
   */
  function paintRecovery() {
    if (state.recovery === undefined) return;
    clear(pRecov.body);
    const sub = pRecov.head.querySelector('.sub');
    const { base, wk, today } = state.recovery;
    if (!base.ok) { sub.textContent = ' '; panelError(pRecov.body, base, 'Daily metrics'); return; }
    const baseRows = base.data.days || [];
    const last = lastNight(baseRows);
    if (!last) {
      sub.textContent = ' ';
      pRecov.body.append(emptyNote('No nights on record yet — these arrive with the first Garmin sync.'));
      return;
    }
    const week = state.data.week || {};
    const isThisWeek = week.start <= today && today <= week.end;
    const weekRows = wk.ok ? (wk.data.days || []) : [];
    sub.textContent = `${nightOfText(last, today)} — each figure on the scale named on its card`;
    pRecov.body.append(
      measureCards(recoveryContext(baseRows), {
        last, baseRows, keys: SNAPSHOT_KEYS,
        rows: [
          [isThisWeek ? 'This week' : `Week of ${fmt.date(week.start)}`, weekRows],
          ['Last 28 nights', baseRows],
        ],
      }),
      el('div', { class: 'plan-actions' }, [
        el('a', { class: 'btn btn-quiet btn-sm', href: '#/recovery' }, [
          el('span', { text: 'Full recovery page' }), icon('right'),
        ]),
      ]),
    );
  }

  /**
   * Habits for the week on screen: one row each, seven marks, one tap.
   *
   * The whole design brief for this was "super simple to track and not need a
   * bunch of clicking", so the tap is the largest thing in the row and there
   * is nothing between it and the record — no date picker, no confirm, no
   * dialog. The seven marks beside it are the week so far, and on a past week
   * they are the only control, because there is no "today" to mark.
   *
   * Sleep has no tap and is not given one. The nightly sync already knows how
   * long you slept, and a button that pretends otherwise would be a control
   * that does nothing. It shows the number, says where it came from, and
   * `#/habits` is where it can be corrected — a rare action, and not one that
   * belongs on the front page.
   *
   * Every state here is the server's own resolution, drawn by the shared
   * `daysStrip`. This page decides nothing about a day.
   */
  function paintHabits() {
    if (state.habits === undefined) return;
    clear(pHabits.body);

    const payload = state.habits;
    if (!payload || !(payload.habits || []).length) {
      pHabits.head.querySelector('.sub').textContent = ' ';
      pHabits.body.append(emptyNote('No habits are being tracked.'));
      pHabits.body.append(el('div', { class: 'plan-actions' }, [
        el('a', { class: 'btn btn-quiet btn-sm', href: '#/habits' }, [
          el('span', { text: 'Set some up' }), icon('right'),
        ]),
      ]));
      return;
    }

    setTimeframe(pHabits, payload.timeframe);

    const week = state.data.week || {};
    const dates = [];
    for (let i = 0; i < 7; i += 1) dates.push(addDays(week.start, i));
    const isThisWeek = dates.includes(payload.today);

    pHabits.head.querySelector('.sub').textContent = isThisWeek
      ? `${fmt.dowDate(payload.today)} — tap a day to mark it`
      : 'tap any day to correct it';

    const list = el('div', { class: 'hbwidget' });
    for (const h of payload.habits) {
      const d = (h.days || {})[payload.today] || {};
      const met = d.state === 'met';
      const measured = h.mode === 'metric';

      const row = el('div', {
        class: `hbw-row${met && isThisWeek ? ' is-met' : ''}`,
        style: hueStyle(h),
      });

      /* The control leads the row, where a checklist puts it. It sat at the far
         end for one round and read as an eighth day of the week — a box in
         line with Monday through Sunday, one column past Sunday. */
      if (measured) {
        row.append(measureBox(h, d));
      } else if (isThisWeek) {
        row.append(checkBox(h, payload.today, d, {
          onTap: () => writeHabit(h, payload.today, { done: !met }),
        }));
      } else {
        row.append(el('span', { class: 'hbw-count num', text: `${h.totals.met}/${h.totals.scored}` }));
      }

      /* The rate, short. The full division — met against credit — belongs on
         `#/habits`, where there is a line to print it on; here it wrapped onto
         a second line and pushed this row's seven marks out of line with the
         rows above and below it. */
      const pct = ratePct(h);
      row.append(el('div', { class: 'hbw-label' }, [
        el('b', { text: h.name }),
        el('span', {
          class: 'hbw-note',
          text: pct == null
            ? 'nothing finished yet'
            : `${h.totals.met} of ${h.totals.scored} ${measured ? 'nights' : 'days'}`,
        }),
      ]));

      /* The seven days carry the week and the tapping both. A measured habit's
         marks are read-only — there is nothing to tap on a night — and print
         the hours instead, which is the thing actually worth knowing. */
      row.append(daysStrip(h, dates, {
        showDow: true,
        showValue: measured,
        today: payload.today,
        onTap: measured ? null : (habit, date, day) => {
          if (!editable(day)) return;
          writeHabit(habit, date, { done: day.state !== 'met' });
        },
      }));

      list.append(row);
    }
    pHabits.body.append(list);

    pHabits.body.append(el('div', { class: 'plan-actions' }, [
      el('a', { class: 'btn btn-quiet btn-sm', href: '#/habits' }, [
        el('span', { text: 'Every day, and the list' }), icon('right'),
      ]),
    ]));
  }

  /**
   * Write one day and repaint from the reply.
   *
   * The score moves with it, because the habits pillar is 10% of it — so the
   * score card is repainted too rather than sitting on a figure the marks
   * beside it no longer support.
   */
  async function writeHabit(habit, date, body) {
    const week = state.data.week || {};
    busy(true);
    const res = await api(
      `/api/habits/${habit.key}/${date}${qs({ from: week.start, to: week.end })}`,
      { method: 'PUT', body },
    );
    busy(false);
    if (!alive) return;
    if (!res.ok) { toast(res.error || 'Could not save that.'); return; }
    state.habits = res.data;
    paintHabits();
    paintScore();
  }

  /**
   * The week's score, in one number and two chips.
   *
   * Scored through the same `scoreWeek` as the Scoreboard, from the same
   * assembly in `score.js` — this is a second *view* of that figure, never a
   * second calculation of it. The moment it became its own arithmetic it would
   * start disagreeing with the page it links to.
   */
  function paintScore() {
    const d = state.data;
    if (!d || state.locked === undefined) return;
    clear(pScore.body);

    const week = d.week || {};
    const locked = ((state.locked && state.locked.weeks) || [])
      .find((w) => w.week_start === week.start) || null;
    const soc = state.soccer;
    const bw = d.bodyweight || {};

    const result = scoreWeek(inputFromSummary({
      sessions: d.sessions || [],
      weekCount: d.headline.week_count,
      avgPerWeek: d.headline.avg_per_week,
      locked,
      careerPerMatch: soc ? (soc.involvements_per_match || 0) : 0,
      paceBefore: state.paceBefore ?? null,
      bodyweight: bw,
      goalKg: toKg(goalWeightLb()),
      weekLoad: d.load.week_total || 0,
      chronicPerDay: d.load.chronic_au || 0,
      plannedKinds: weekIntent(week.start).kinds,
      habitList: (state.habits || {}).habits || [],
    }));

    const b = band(result.total);
    pScore.head.querySelector('.sub').textContent = b.label;

    const wrap = el('div', { class: 'scoremini tone-' + b.key });
    const head2 = el('div', { class: 'scoremini-top' }, [
      el('div', { class: 'scoremini-fig' }, [
        el('b', { text: result.total == null ? '\u2014' : String(Math.round(result.total)) }),
        el('span', { class: 'scoremini-of', text: '/ 100' }),
      ]),
    ]);
    if (result.weakest) {
      head2.append(el('span', { class: `verdict-chip tone-${band(result.weakest.score).key}` }, [
        el('i', { 'aria-hidden': 'true' }),
        el('span', { class: 'verdict-name', text: PILLAR_NAME[result.weakest.key] }),
        el('b', { class: 'num', text: String(Math.round(result.weakest.score)) }),
      ]));
    }
    wrap.append(head2);

    /* Six thin bars under the figure: the shape of the week at a glance, and
       what gives this card a body rather than a number and two chips floating
       in a half-empty box beside a taller neighbour. Names are abbreviated
       because the bar carries the reading and the tooltip carries the rest. */
    const strip = el('div', { class: 'scoremini-pillars' });
    for (const pl of result.pillars) {
      const tone = pl.absent ? 'none' : band(pl.score).key;
      strip.append(el('div', {
        class: `smp tone-${tone}`,
        title: pl.absent
          ? `${PILLAR_NAME[pl.key]} — nothing to score this week`
          : `${PILLAR_NAME[pl.key]} ${Math.round(pl.score)} / 100 · ${pl.weight}% of the week`,
      }, [
        el('span', { class: 'smp-track' }, [
          el('span', { class: 'smp-fill', style: `height:${pl.absent ? 0 : Math.max(3, pl.score)}%` }),
        ]),
        el('span', { class: 'smp-lbl', text: PILLAR_SHORT[pl.key] }),
      ]));
    }
    wrap.append(strip);
    pScore.body.append(wrap);

    if (result.weakest && result.weakest.nudge) {
      pScore.body.append(el('p', { class: 'sub', text: result.weakest.nudge }));
    }
    pScore.body.append(el('div', { class: 'plan-actions' }, [
      el('a', { class: 'btn btn-quiet btn-sm', href: '#/score' }, [
        el('span', { text: 'All seven pillars' }), icon('right'),
      ]),
    ]));
  }

  /**
   * Distance against the committed plan, for the week on screen.
   *
   * The question this answers is "what is left and how do I spread it", which
   * needs four numbers the page did not have together anywhere: the target,
   * what is done, what remains, and how many days remain to do it in. The
   * chart underneath says where those kilometres came from, because a 30 km
   * week of matches is a different week from 30 km of runs.
   *
   * Every figure is the server's. `actual_km` on the committed week, the
   * week's on-foot total from `/api/distance` and a client-side sum of the
   * week's sessions all agree to the centimetre, so the daily breakdown is
   * derived here while the headline totals are quoted, not recomputed.
   */
  function paintDistance() {
    const d = state.data;
    if (!d || state.locked === undefined) return;
    /* Its own handle rather than the page's `figures` array: this panel is
       repainted by its own fetch, and letting paint() destroy a chart that is
       still on screen leaves a live-looking plot with dead listeners. */
    if (distFig) { if (distFig.destroy) distFig.destroy(); distFig = null; }
    clear(pDist.body);
    setTimeframe(pDist, (d.timeframes || {}).week);

    const week = d.week || {};
    const prog = d.week_progress || {};
    const locked = ((state.locked && state.locked.weeks) || [])
      .find((w) => w.week_start === week.start) || null;

    /* On-foot, not runs-only: the plan's target counts every kilometre on the
       legs, matches included, so counting anything narrower here would put a
       different denominator under the same target. */
    const perDay = new Map();
    for (const s of d.sessions || []) {
      if (!ON_FOOT.includes(s.kind) || !s.distance_km) continue;
      const day = perDay.get(s.date) || {};
      day[s.kind] = (day[s.kind] || 0) + Number(s.distance_km);
      perDay.set(s.date, day);
    }
    const summed = [...perDay.values()]
      .reduce((a, day) => a + Object.values(day).reduce((x, y) => x + y, 0), 0);
    const done = locked && locked.actual_km != null ? Number(locked.actual_km) : summed;

    if (!locked) {
      pDist.head.querySelector('.sub').textContent = 'no plan committed for this week';
      pDist.body.append(statStrip([
        { label: 'On foot this week', value: fmt.one(done), unit: 'km',
          note: 'runs, stairs, matches, quick feet, rucks — and anything else logged with a distance' },
      ]));
      pDist.body.append(emptyNote(
        'Nothing is committed for this week, so there is no target to track against. '
        + 'Commit a plan on the Plan page and this fills in.',
      ));
      distanceChart(week, perDay);
      return;
    }

    const target = Number(locked.target_km);
    const left = target - done;
    const current = !!prog.is_current_week;
    /* `days_remaining` counts whole days after today. A run can still happen
       today, so the figure people plan against is one more than that — and it
       is labelled, because two day-counts that differ by one is exactly the
       kind of quiet disagreement this app keeps having to fix. */
    const daysLeft = current ? Number(prog.days_remaining || 0) + 1 : 0;

    /* The tone the whole panel is judged by: how far through the committed
       distance this week is. Green is "done", and it is the one thing here you
       should be able to read from across the room. */
    const pct = (done / target) * 100;
    const tone = attainTone(pct);
    const met = done >= target;

    pDist.head.querySelector('.sub').textContent = met
      ? `${fmt.one(target)} km committed — done`
      : current
        ? `${fmt.one(target)} km committed${locked.is_deload ? ' · deload week' : ''}`
        : `${fmt.one(target)} km committed · week finished`;
    /* The card itself carries the tone once the week is made, so the answer is
       visible before any number is read. */
    pDist.classList.toggle('has-accent', met);
    pDist.style.setProperty('--eb', met ? 'var(--tone-strong)' : '');

    const tiles = [
      { label: 'Done', value: fmt.one(done), unit: 'km', tone,
        note: `${Math.round(pct)}% of ${fmt.one(target)} km` },
    ];
    if (left > 0.05) {
      tiles.push({ label: 'Left', value: fmt.one(left), unit: 'km', tone,
        note: current ? 'to hit the committed target' : 'short of the committed target' });
      if (current) {
        /* Days left is not good or bad by itself — a Tuesday is not an
           achievement — so coluring it by the calendar would be decoration.
           What *is* judgeable is whether what remains is reachable at the rate
           this week has actually been going: needed-per-day against
           done-per-day-so-far. One is a fact, the other is the same fact
           measured against you, and that is what the colour says. */
        const elapsed = Math.max(1, Number(prog.days_elapsed || 1));
        const needPerDay = left / daysLeft;
        const runPerDay = done / elapsed;
        const reach = runPerDay > 0
          ? attainTone((runPerDay / needPerDay) * 100)
          : null;

        tiles.push({
          label: 'Days left', value: String(daysLeft), tone: reach,
          note: daysLeft === 1 ? 'today is the last one' : 'including today',
        });
        tiles.push({
          label: 'Per day', value: fmt.one(needPerDay), unit: 'km', tone: reach,
          note: runPerDay > 0
            ? `you have averaged ${fmt.one(runPerDay)} km a day so far`
            : `${fmt.one(left)} km ÷ ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`,
        });
      }
    } else {
      tiles.push({ label: 'Left', value: '0', unit: 'km', tone: 'strong',
        note: left < -0.05 ? `${fmt.one(-left)} km past it` : 'target met exactly' });
      if (current) {
        /* Once the week is made the countdown stops being a countdown: those
           days are spare, not owed. */
        tiles.push({
          label: daysLeft === 1 ? 'Day spare' : 'Days spare',
          value: String(daysLeft), tone: 'strong',
          note: daysLeft === 1 ? 'today, with the week already made' : 'with the week already made',
        });
      }
    }
    pDist.body.append(statStrip(tiles));

    distanceChart(week, perDay);

    if (current && left > 0.05) {
      /* What is left, stated against what is actually running rather than the
         on-foot total: the target counts matches, and a week with a game in it
         has less running left in it than the remainder suggests. */
      const runKm = [...perDay.values()].reduce((a, day) => a + (day.run || 0), 0);
      pDist.body.append(el('p', { class: 'sub', text:
        `${fmt.one(runKm)} km of the ${fmt.one(done)} km so far is running; the rest is `
        + 'stairs, matches, quick feet, rucks and anything else logged with a distance, which the target counts too. '
        + `${fmt.one(left)} km left over ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}.` }));
    }
  }

  /**
   * Kilometres per day, split by what put them on the legs.
   *
   * There is no even-pace guide here and there should not be: nobody runs a
   * seventh of a week seven times, the rest days are the point, and a straight
   * line to the target would only ever be a line you are behind. What is
   * genuinely worth seeing is the mix — a 30 km week that is mostly matches is
   * a different week from one that is mostly runs, and only the split says
   * which you had.
   */
  function distanceChart(week, perDay) {
    if (!week.start) return;
    const host = el('div');
    pDist.body.append(host);

    const kinds = ON_FOOT.filter((k) => [...perDay.values()].some((day) => day[k] > 0));
    const points = [];
    for (let i = 0; i < 7; i += 1) {
      const iso = addDays(week.start, i);
      const day = perDay.get(iso) || {};
      const total = kinds.reduce((a, k) => a + (day[k] || 0), 0);
      points.push({
        key: iso,
        label: dateOf(iso).toLocaleDateString(undefined, { weekday: 'short' }),
        values: Object.fromEntries(kinds.map((k) => [k, Number((day[k] || 0).toFixed(2))])),
        total,
        note: total ? `${fmt.one(total)} km on the day` : 'nothing on foot',
      });
    }

    distFig = figure(host, {
      type: 'columns',
      aria: 'Kilometres on foot per day this week, split by modality',
      height: 210, unit: 'km', periodLabel: 'Day',
      /* Seven columns is few enough that every day can carry its figure. */
      labels: 'all',
      series: kinds.map((k) => ({
        key: k, label: kindName(k), color: colorOf(k),
        total: `${fmt.one(points.reduce((a, p) => a + (p.values[k] || 0), 0))} km`,
      })),
      points,
      format: (v) => `${fmt.one(v)} km`,
      formatShort: (v) => fmt.one(v),
      emptyText: 'Nothing on foot logged this week yet.',
    });
  }

  /* Stored in kilograms, shown in whichever unit is set — the notebook is in
     pounds and so is the user's head. This tile used to hardcode kg and
     ignore the preference the rest of the app respects. */
  /**
   * What you weigh, and which way it is going.
   *
   * Both numbers are readings. The headline is the last one the scale gave —
   * typed in or synced, no difference — and the change is that reading against
   * the nearest one four weeks earlier. No curve appears in either.
   *
   * The seven-day EMA used to be the headline, which is a defensible statistic
   * and the wrong answer to "what do I weigh": it said 212.0 on a morning the
   * scale said 210.0. A figure nobody can reproduce by standing on the scale
   * reads as stale even when the sync is perfectly current.
   */
  function bodyweightTile(bw) {
    const u = getWeightUnit();
    const series = bw.series || [];
    const last = latestWeighIn(series);
    const value = inUnit(last ? last.kg : null, u);
    const d4 = weighInDelta(series, 28);

    const bits = [];
    if (last) bits.push(fmt.relDays(last.date));
    if (d4) {
      bits.push(`${fmt.wholeSigned(inUnit(d4.kg, u))} ${u} since ${fmt.dateY(d4.from.date)}`);
    }

    return {
      label: 'Bodyweight',
      /* The whole part of what the scale said. */
      value: value == null ? '—' : fmt.whole(value),
      unit: value == null ? '' : u,
      note: bits.length ? bits.join(' · ') : 'no weigh-in on record',
    };
  }

  function paint() {
    const d = state.data;
    figures.forEach((f) => f.destroy && f.destroy());
    figures = [];

    /* One window for the page: the week, chosen by the arrows in the header —
       the only control here. Every panel prints it.

       Three panels compute over a longer span than the week: acute:chronic is
       7 days against 28 by definition, the unified-load chart carries twelve
       weeks of context, and the activity mix counts a trailing 28 days. Those
       are *methods*, not periods the reader picked, and they used to be printed
       in the timeframe line — so one screen showed "week of 10-16 Aug",
       "trailing 28 days" and "12 weeks" at once for a page with a single
       control. Each now says what it looks back over in its own subtitle,
       where it reads as part of the method instead of competing with the
       page's window. */
    const tf = d.timeframes || {};

    /* A panel states the window it actually draws. Nothing else is safe.
       Stamping the page's week on all seven was tried and is worse than the
       problem it solved: "Unified load" plots twelve weeks of bars and has its
       own 12w/26w/52w control beside the title, so labelling it
       "week of 10-16 Aug 2026" is simply false — and a caption that lies is
       worse than two captions that differ.

       Three windows are genuinely in play here, each with its own reason:
         · the week          — what the header arrows select
         · trailing 28 days  — acute:chronic is 7-against-28 by definition
         · 12/26/52 weeks    — context depth, set by the control on pLoad

       They cannot be collapsed without deleting a metric or a control. What
       can be fixed is where those controls live; see the note in mount(). */
    setTimeframe(pSplit, tf.week);
    setTimeframe(pSessions, tf.week);
    setTimeframe(pBests, tf.week);

    /* Acute:chronic and the read-out carry no timeframe line at all. Neither is
       a windowed dataset: one is a single ratio that prints its own arithmetic
       ("94 AU/day over 7 days ÷ 55 AU/day over 28") and the other is prose
       whose every line names its own basis. A timeframe line on those was
       asserting a period for something that does not have one, and it is what
       put three windows on a page with one week in it. */
    setTimeframe(pAcwr, null);
    setTimeframe(pRead, null);

    const start = d.week.start;
    const end = d.week.end;
    document.getElementById('wk-range').textContent = `${fmt.date(start)} – ${fmt.dateY(end)}`;
    document.getElementById('wk-rel').textContent =
      state.weekOf >= state.latest ? 'current week' : fmt.relDays(end);
    btnNext.disabled = state.weekOf >= state.latest;
    btnToday.disabled = state.weekOf >= state.latest;
    jump.value = end;
    jump.max = state.latest;

    /* hero */
    clear(heroFig);
    const figNum = el('div', { class: 'figure', text: '—' });
    heroFig.append(
      el('div', { class: 'figure-row' }, [
        figNum,
        el('div', { class: 'figure-unit' }, [
          el('span', { text: 'activities' }), el('span', { text: 'per week' }),
        ]),
      ]),
      el('p', { class: 'figure-note', text:
        'Lifetime average, carried forward from the notebook. A missed week dips it and the next week lifts it — nothing resets.' }),
    );
    countUp(figNum, d.headline.avg_per_week, 2);

    clear(heroAside);
    heroAside.append(factsLine(d.facts));
    const spark = el('div', { class: 'spark-wrap' });
    heroAside.append(el('div', { class: 'spark-row' }, [
      spark,
      el('span', { class: 'spark-cap', text:
        tf.avg_history ? tf.avg_history.label : `${(d.avg_history || []).length}-week trend` }),
    ]));
    sparkline(spark, (d.avg_history || []).map((p) => p.avg), {
      color: colorOf('soccer'),
      label: 'All-time average activities per week, recent trend',
    });

    /* stats */
    const bw = d.bodyweight || {};
    const scale = loadScale(d);
    const wp = d.week_progress || {};
    const fresh = wp.is_current_week && !wp.sessions_so_far;

    clear(stripHost);
    if (fresh) {
      /* A week that is one day old is not a week that went badly, but a row of
         zeroes is indistinguishable from one — the user opened the app on a
         Monday and read "load is 0.00" as a failure. So the fact is stated in
         words, the previous week is put where the zeroes were, and the only
         zero left on the strip has "day 1 of 7" written directly under it.
         Nothing here encourages anybody; it just says what is true. */
      stripHost.append(freshWeekLine(wp));
      stripHost.append(statStrip([
        {
          label: 'This week so far', value: fmt.int(wp.sessions_so_far || 0), unit: 'activities',
          note: `day ${wp.days_elapsed} of 7 · nothing logged yet`,
        },
        {
          label: 'Trailing 28 days', value: fmt.int(d.headline.count_28d), unit: 'activities',
          note: 'the window that does not restart on a Monday',
        },
        prevWeekTile(wp),
        bodyweightTile(bw),
      ]));
    } else {
      stripHost.append(statStrip([
        {
          label: 'Activities', value: fmt.int(d.headline.week_count),
          note: `${d.headline.count_28d} in the trailing 28 days`,
        },
        {
          label: 'Load', value: fmt.int(d.load.week_total), unit: 'AU',
          /* The scale is stated once, here, rather than on every tile — and it
             is stated even when there is also something to say about unscored
             sessions, because which scale a total is on is the more important
             of the two facts. */
          note: [
            scaleNote(scale),
            d.load.unscored
              ? `${d.load.unscored} session${d.load.unscored === 1 ? '' : 's'} unscored, excluded`
              : null,
          ].filter(Boolean).join(' · '),
        },
        topShareTile(d),
        bodyweightTile(bw),
      ]));
    }

    /* split */
    const byKind = d.load.by_kind || {};
    clear(pSplit.body);
    splitBar(pSplit.body, {
      parts: orderKinds(Object.keys(byKind)).filter((k) => byKind[k] > 0)
        .map((k) => ({ key: k, label: kindName(k), value: byKind[k], color: colorOf(k) })),
      total: d.load.week_total,
      emptyText: fresh
        ? `Nothing logged yet — day ${wp.days_elapsed} of 7.`
        : 'No scored sessions this week — load needs an RPE and a duration.',
    });
    /* An empty split bar is a large white box, which is exactly the reading
       the user objected to. So the panel shows the last complete week's
       split instead, labelled as such — the same per-week `by_kind` the load
       chart below is drawn from, not a second computation of it. */
    if (fresh && wp.previous_week) {
      const prevRow = (d.load_by_week || []).find((w) => w.week_start === wp.previous_week.start);
      const prevKinds = orderKinds(Object.keys(prevRow?.by_kind || {})).filter((k) => prevRow.by_kind[k] > 0);
      if (prevKinds.length) {
        pSplit.body.append(el('p', { class: 'refhead' }, [
          el('b', { text: 'Last week, for reference' }),
          el('span', { text: ` · ${fmt.date(wp.previous_week.start)} – ${fmt.dateY(wp.previous_week.end)}` }),
        ]));
        const ref = el('div');
        pSplit.body.append(ref);
        splitBar(ref, {
          parts: prevKinds.map((k) => ({
            key: k, label: kindName(k), value: prevRow.by_kind[k], color: colorOf(k),
          })),
          total: prevRow.total,
          emptyText: 'Nothing scored last week either.',
        });
      }
    }

    clear(pAcwr.body);
    const topEntry = Object.entries(d.load.split || {}).sort((a, b) => b[1] - a[1])[0];
    pAcwr.body.append(acwrMeter(d.load, {
      topKind: topEntry ? kindName(topEntry[0]) : null,
      topPct: topEntry ? topEntry[1] * 100 : 0,
      /* Only while the viewed week is still running, where the difference
         between "the last 7 days" and "this week" is worth spelling out. */
      partialWeek: wp.is_current_week && wp.days_elapsed < 7 ? wp : null,
    }));

    /* unified load */
    clear(pLoad.body);
    pLoad.head.querySelector('.sub').textContent = scale.calibrated
      ? 'Every modality comparable, on Garmin’s training-load scale'
      : 'Every modality comparable — rpe × minutes, not yet on the calibrated scale';
    const weeks = d.load_by_week || [];
    const present = orderKinds(KINDS.filter((k) => weeks.some((w) => (w.by_kind || {})[k] > 0)));
    const grand = weeks.reduce((a, w) => a + (w.total || 0), 0) || 1;
    figures.push(figure(pLoad.body, {
      type: 'columns',
      aria: `Weekly training load by modality over the last ${weeks.length} weeks`,
      height: 250, unit: 'AU', periodLabel: 'Week of',
      series: present.map((k) => ({
        key: k, label: kindName(k), color: colorOf(k),
        total: `${Math.round((weeks.reduce((a, w) => a + ((w.by_kind || {})[k] || 0), 0) / grand) * 100)}%`,
      })),
      points: weeks.map((w) => ({
        key: w.week_start, label: fmt.date(w.week_start),
        values: w.by_kind || {}, total: w.total,
      })),
      format: (v) => fmt.int(v),
      emptyText: 'No scored sessions in this window.',
    }));

    /* read-out */
    clear(pRead.body);
    const lines = weekReadout(d);
    if (fresh) {
      lines.unshift(
        `Day ${wp.days_elapsed} of 7 with nothing logged, so every figure below is a partial week `
        + 'measured against whole ones.',
      );
    }
    pRead.body.append(readout(lines));

    /* sessions */
    clear(pSessions.body);
    /* This caption describes the rows immediately below it, so it adds those
       rows up rather than quoting the week aggregate — which is on a different
       scale until the API finishes moving over, and would otherwise print a
       total three times the sum of the list underneath it. */
    pSessions.head.querySelector('.sub').textContent = d.sessions.length
      ? `${d.sessions.length} logged · ${fmt.int(
        d.sessions.reduce((a, s) => a + Number(s.load || 0), 0))} AU`
      : (fresh ? `Nothing logged · day ${wp.days_elapsed} of 7` : 'Nothing logged');
    if (!pSessions.head.querySelector('.tools')) {
      pSessions.head.append(el('div', { class: 'tools' }, [
        el('a', { class: 'btn', href: '#/add' }, [icon('plus'), el('span', { text: 'Add' })]),
      ]));
    }
    if (d.sessions.length) {
      pSessions.body.append(sessionList(d.sessions));
    } else if (fresh) {
      pSessions.body.append(el('div', { class: 'nothingyet' }, [
        el('p', { class: 'empty', text:
          `Nothing logged yet. The week is ${wp.days_elapsed} day${wp.days_elapsed === 1 ? '' : 's'} old, `
          + `with ${wp.days_remaining} to go.` }),
        wp.previous_week ? el('a', {
          class: 'btn btn-quiet btn-sm', href: `#/week/${wp.previous_week.end}`,
        }, [icon('left'), el('span', { text: `Last week — ${wp.previous_week.sessions} activities` })]) : null,
      ]));
    } else {
      pSessions.body.append(emptyNote('No activities this week.'));
    }

    /* activity mix — counts only. There is no plan to be measured against. */
    clear(pMix.body);
    const m28 = d.sessions_28d || {};
    const mWeek = d.sessions_this_week || {};
    const kinds28 = orderKinds(Object.keys(m28)).filter((k) => m28[k] > 0);
    if (!kinds28.length) {
      pMix.body.append(emptyNote('Nothing logged in the last 28 days.'));
    } else {
      pMix.body.append(countBars(kinds28.map((k) => ({
        label: kindName(k), color: colorOf(k), value: m28[k],
        note: mWeek[k] ? `· ${mWeek[k]} this week` : '',
      }))));
      pMix.body.append(el('p', { class: 'sub', text:
        `${d.headline.count_28d} sessions across ${kinds28.length} modalit${kinds28.length === 1 ? 'y' : 'ies'} in a rolling 28-day window.` }));
    }

    /* bests */
    clear(pBests.body);
    renderBests(pBests.body, d);

    /* week note */
    renderNote(d);

    /* footnotes */
    clear(foot);
    const r = d.recovery || {};
    const bits = [];
    const pair = (label, key, unit) => {
      const [week, base] = r[key] || [];
      if (week == null && base == null) return;
      bits.push([label, `${week ?? '—'}${unit} vs ${base ?? '—'}${unit} baseline`]);
    };
    pair('HRV', 'hrv_ms', 'ms');
    pair('Resting HR', 'resting_hr', '');
    pair('Readiness', 'readiness', '');
    pair('Sleep', 'sleep_hours', 'h');
    if (!bits.length) bits.push(['Recovery', 'no metrics yet — these arrive with the first Garmin sync']);
    bits.push(['On record', `${fmt.int(d.headline.total_activities)} activities`]);
    for (const [k, v] of bits) {
      foot.append(el('span', {}, [el('b', { text: k }), el('span', { text: ` ${v}` })]));
    }

    /* Last, and on every repaint: the committed plan spans many weeks, so the
       copy already in hand stays valid when the arrows move to another week. */
    paintDistance();
    paintScore();
  }

  function renderBests(body, d) {
    const prs = d.prs || [];
    const e1 = d.e1rm || [];
    if (!prs.length && !e1.length) {
      /* A week with no personal bests is an ordinary week. Say so, move on. */
      body.append(emptyNote('None this week.'));
      return;
    }
    for (const pr of prs) {
      const c = pr.context || {};
      const value =
        pr.kind === 'e1rm' ? `${fmt.one(pr.value)} kg (${c.weight}×${c.reps})`
          : pr.kind === 'reps_at_weight' ? `${pr.value} reps @ ${c.weight} kg`
            : pr.kind === 'session_volume' ? `${fmt.int(pr.value)} kg`
              : String(pr.value ?? '');
      body.append(el('div', { class: 'pr' }, [
        el('span', {}, [
          el('span', { text: pr.exercise }),
          document.createTextNode(' '),
          el('span', { class: 'pr-kind', text: PR_LABEL[pr.kind] || pr.kind }),
        ]),
        el('span', { class: 'num muted', text: value }),
      ]));
    }
    for (const e of e1) {
      body.append(el('div', { class: 'pr' }, [
        el('span', {}, [
          el('span', { text: e.exercise }), document.createTextNode(' '),
          el('span', { class: 'pr-kind', text: 'e1RM' }),
        ]),
        el('span', { class: 'num muted', text:
          `${fmt.one(e.current)} kg${e.delta_4w != null ? ` · ${fmt.signed(e.delta_4w, ' kg')} over 4 weeks` : ''}` }),
      ]));
    }
  }

  /* ── week notes ───────────────────────────────────────────────────────── */

  /**
   * Notes are individual bullets, which is how they were asked for and how the
   * paper page carried them: one observation per line, added and removed one at
   * a time. They used to be a single textarea round-tripped through the entry
   * shorthand, which meant a quote or a hash in the text had to be stripped
   * before saving and the whole block was one indivisible string.
   *
   * Each line is its own row on the server, so the list has a real order and a
   * line can be edited or dropped without touching the others. The start-of-
   * week weigh-in sits beside it as its own field — it is a measurement, not a
   * note, and it goes to the week header rather than the note list.
   */
  function renderNote(d) {
    const start = d.week.start;
    clear(pNote.body);

    const sub = pNote.head.querySelector('.sub');
    sub.textContent = `Week of ${fmt.dateY(start)}`;

    const list = el('ul', { class: 'notelist' });
    const listState = { notes: null, busy: false };

    /* Optimism is the wrong default for a list you can reorder: every mutation
       returns the authoritative list, so the render always follows the server
       rather than guessing and reconciling. */
    const setNotes = (notes) => {
      listState.notes = notes;
      clear(list);
      sub.textContent = `Week of ${fmt.dateY(start)} · ${
        notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : 'nothing written yet'}`;
      if (!notes.length) {
        list.append(el('li', { class: 'notelist-empty' }, [
          el('p', { class: 'empty', text: 'Nothing written for this week.' }),
        ]));
        return;
      }
      notes.forEach((n, i) => list.append(noteRow(n, i, notes.length)));
    };

    const reload = async () => {
      const res = await api(`/api/weeks/${start}/notes`);
      if (!alive) return;
      if (!res.ok) { panelError(list, res, 'Week notes'); return; }
      setNotes(res.data.notes || []);
    };

    /** Apply whatever the server just told us the list is. */
    const applied = (res, failure) => {
      if (!res.ok) { toast(`${failure} — ${res.error}`); return false; }
      if (res.data && res.data.notes) setNotes(res.data.notes);
      else reload();
      return true;
    };

    function noteRow(n, i, count) {
      const input = el('input', {
        class: 'noteline', type: 'text', value: n.text,
        'aria-label': `Note ${i + 1} of ${count}`,
      });

      const commit = async () => {
        const text = input.value.trim();
        if (text === n.text) return;
        if (!text) { input.value = n.text; return; }   // blanking is not deleting
        busy(true);
        const res = await api(`/api/notes/${n.id}`, { method: 'PATCH', body: { text } });
        busy(false);
        if (!alive) return;
        if (applied(res, 'Note not saved')) { n.text = text; bumpRevision(); }
        else input.value = n.text;
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.stopPropagation(); input.value = n.text; input.blur(); }
      });

      const move = async (delta) => {
        const order = listState.notes.slice();
        const j = i + delta;
        if (j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        busy(true);
        /* Positions are renumbered outright rather than swapped, because two
           rows sharing a position leaves the order down to the tie-break. */
        let last = null;
        for (let k = 0; k < order.length; k++) {
          last = await api(`/api/notes/${order[k].id}`, { method: 'PATCH', body: { position: k } });
          if (!last.ok) break;
        }
        busy(false);
        if (!alive) return;
        if (applied(last, 'Order not saved')) {
          const rows = list.querySelectorAll('.noteline');
          if (rows[j]) rows[j].focus();
        }
      };

      /* Two steps, no dialog — the same pattern as deleting a session. The
         icon is the resting state so the row stays quiet; arming it prints
         the word, because a red icon on its own is not a confirmation. */
      const del = el('button', {
        class: 'iconbtn iconbtn-sm noteact-del', type: 'button',
        title: 'Delete this note', 'aria-label': `Delete note: ${n.text}`,
      }, [icon('trash')]);
      let armed = false;
      let timer = 0;
      const disarm = () => {
        armed = false;
        clear(del);
        del.append(icon('trash'));
        del.classList.remove('is-armed');
        del.title = 'Delete this note';
      };
      del.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          clear(del);
          del.append(el('span', { text: 'Delete?' }));
          del.classList.add('is-armed');
          del.title = 'Click again to delete';
          timer = setTimeout(disarm, 4000);
          return;
        }
        clearTimeout(timer);
        busy(true);
        const res = await api(`/api/notes/${n.id}`, { method: 'DELETE' });
        busy(false);
        if (!alive) return;
        if (applied(res, 'Note not deleted')) bumpRevision();
      });

      return el('li', { class: 'noteitem' }, [
        el('span', { class: 'notebullet', 'aria-hidden': 'true' }),
        input,
        el('span', { class: 'noteacts' }, [
          el('button', {
            class: 'iconbtn iconbtn-sm', type: 'button', disabled: i === 0 || null,
            title: 'Move up', 'aria-label': `Move up: ${n.text}`, on: { click: () => move(-1) },
          }, [icon('up')]),
          el('button', {
            class: 'iconbtn iconbtn-sm', type: 'button', disabled: i === count - 1 || null,
            title: 'Move down', 'aria-label': `Move down: ${n.text}`, on: { click: () => move(1) },
          }, [icon('down')]),
          del,
        ]),
      ]);
    }

    /* ── add ── */
    /* The next line on the page, not a form control: the same bullet, the
       same rule, the same borderless field. The button stays quiet until
       there is something to add. */
    const addInput = el('input', {
      class: 'noteline noteline-new', type: 'text', id: 'notenew',
      placeholder: 'Write a line about this week',
    });
    const addBtn = el('button', {
      class: 'btn btn-quiet btn-sm noteadd-go', type: 'button', disabled: true,
    }, [icon('plus'), el('span', { text: 'Add' })]);
    addInput.addEventListener('input', () => {
      addBtn.disabled = !addInput.value.trim();
    });
    const add = async () => {
      const text = addInput.value.trim();
      if (!text) { addInput.focus(); return; }
      addBtn.disabled = true;
      busy(true);
      const res = await api(`/api/weeks/${start}/notes`, { method: 'POST', body: { text } });
      busy(false);
      addBtn.disabled = false;
      if (!alive) return;
      if (applied(res, 'Note not added')) {
        addInput.value = '';
        addBtn.disabled = true;
        addInput.focus();
        bumpRevision();
      }
    };
    addBtn.addEventListener('click', add);
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
    });

    /* ── the weigh-in, which is not a note ── */
    const server = d.week_note || {};
    const lbsInput = el('input', {
      class: 'input', type: 'number', id: 'weeklbs', step: '0.5', min: '0',
      inputmode: 'decimal', placeholder: 'e.g. 213',
      value: server.bodyweight_lbs == null ? '' : String(server.bodyweight_lbs),
    });
    const lbsBtn = el('button', {
      class: 'btn btn-quiet btn-sm', type: 'button', disabled: true,
    }, [icon('check'), el('span', { text: 'Save' })]);
    const lbsWas = lbsInput.value;
    lbsInput.addEventListener('input', () => {
      lbsBtn.disabled = lbsInput.value === lbsWas;
    });
    lbsBtn.addEventListener('click', async () => {
      const raw = lbsInput.value;
      if (raw === '') { toast('Nothing to save.'); return; }
      lbsBtn.disabled = true;
      busy(true);
      const res = await api(`/api/weeks/${start}`, {
        method: 'PUT', body: { bodyweight_lbs: Number(raw) },
      });
      busy(false);
      lbsBtn.disabled = false;
      if (!res.ok) { toast(`Not saved — ${res.error}`); return; }
      lbsBtn.disabled = true;
      invalidate();
      bumpRevision();
      toast('Weigh-in saved.');
    });

    pNote.body.append(
      list,
      el('div', { class: 'noteitem noteadd' }, [
        el('span', { class: 'notebullet notebullet-new', 'aria-hidden': 'true' }),
        el('label', { class: 'sr', for: 'notenew', text: 'Add a note for this week' }),
        addInput,
        el('span', { class: 'noteacts' }, [addBtn]),
      ]),
    );

    /* Its own card. It used to close the notes panel as one short row, under a
       caption that had to begin "A measurement, not a note" — which is the
       giveaway: a thing that needs a sentence explaining why it is not the
       thing it sits inside belongs somewhere else. Notes are prose you write;
       this is a number you read off a scale, and it writes to a different
       field entirely. */
    clear(pWeigh.body);
    pWeigh.body.append(
      el('div', { class: 'weighrow' }, [
        el('label', { class: 'sr', for: 'weeklbs', text: 'Start-of-week weigh-in' }),
        el('span', { class: 'noteweigh-field' }, [lbsInput, el('span', { class: 'noteweigh-u', text: 'lb' })]),
        lbsBtn,
      ]),
      el('p', { class: 'sub', text:
        'Goes to the week header — the same field the notebook page carried. The Scoreboard scores '
        + 'the four-week trend of this against your goal, never a single reading.' }),
    );

    skeletonLines(2, list);
    reload();
  }

  /* ── controls ── */

  const shift = (days) => {
    const next = addDays(state.weekOf, days);
    if (days > 0 && next > state.latest) return;
    state.weekOf = next;
    history.replaceState(null, '', `#/week/${next}`);
    fetchWeek({ keepFrame: true });
  };

  btnPrev.addEventListener('click', () => shift(-7));
  btnNext.addEventListener('click', () => shift(7));
  btnToday.addEventListener('click', () => {
    state.weekOf = state.latest;
    history.replaceState(null, '', '#/week');
    fetchWeek({ keepFrame: true });
  });
  jump.addEventListener('change', () => {
    if (!jump.value) return;
    state.weekOf = jump.value;
    fetchWeek({ keepFrame: true });
  });

  fetchWeek();

  return {
    destroy() {
      alive = false;
      figures.forEach((f) => f.destroy && f.destroy());
      if (distFig && distFig.destroy) distFig.destroy();
    },
    keys(e) {
      if (e.key === 'ArrowLeft') { shift(-7); return true; }
      if (e.key === 'ArrowRight') { shift(7); return true; }
      if (e.key === 't') { btnToday.click(); return true; }
      return false;
    },
    refresh() { fetchWeek({ keepFrame: true }); },
  };
}

/* There is exactly one activities-per-week figure, and the server computes it:
   activities through the end of the last completed week, divided by the weeks
   completed. It is recalculated when a week ends, which is why it is stable
   from Monday to Sunday and why it matches the paper page without any
   reconciling arithmetic printed underneath it. `headline.notebook_avg` stays
   in the payload as an integrity check and is deliberately never rendered. */

/**
 * Which scale the week's load figures are actually on.
 *
 * There is meant to be one: Garmin's, with a fitted stand-in where the watch
 * recorded nothing. Per-session `load` moved onto it first and the weekly
 * aggregates in `/api/summary` follow — so rather than assume either state,
 * this compares the two. The panels then describe whichever is true, and
 * correct themselves the moment the API publishes the aggregate on the same
 * scale. Nothing here is used as a *value*; it only decides the wording.
 */
function loadScale(d) {
  const rows = d.sessions || [];
  const summed = rows.reduce((a, s) => a + Number(s.load || 0), 0);
  const total = Number(d.load.week_total || 0);
  const both = summed > 0 && total > 0;
  return {
    calibrated: !both || Math.abs(summed - total) / Math.max(summed, total) < 0.05,
    estimated: rows.filter((s) => s.load_source === 'estimated').length,
    unscaled: rows.filter((s) => s.load_source === 'unscaled').length,
    sessions: rows.length,
  };
}

/** One sentence about the scale, wherever a load total is printed. */
function scaleNote(sc) {
  if (!sc.calibrated) {
    return 'rpe × minutes — the sessions below have moved to Garmin’s calibrated scale, this total has not yet';
  }
  const bits = ['Garmin’s training-load scale'];
  if (sc.estimated) bits.push(`${sc.estimated} of ${sc.sessions} estimated`);
  if (sc.unscaled) bits.push(`${sc.unscaled} not yet convertible`);
  return bits.join(' · ');
}

/**
 * The plain statement a fresh week opens with.
 *
 * Not encouragement and not a prompt: the week is N days old, nothing is in it,
 * and here is what the last complete one held. Everything in it is a fact the
 * server published in `week_progress`.
 */
function freshWeekLine(wp) {
  const prev = wp.previous_week;
  const wrap = el('div', { class: 'freshweek' });
  wrap.append(el('p', { class: 'freshweek-lead' }, [
    el('b', { text: `Day ${wp.days_elapsed} of 7.` }),
    el('span', { text:
      ` Nothing logged in this week yet, so the figures below are ${wp.days_remaining === 1 ? 'a day' : `${wp.days_elapsed} day${wp.days_elapsed === 1 ? '' : 's'}`} `
      + 'of a seven-day week — not a week that went badly.' }),
  ]));
  if (prev) {
    /* The figures themselves are on the strip below; this is the way into the
       week they belong to, not a second copy of them. */
    wrap.append(el('p', { class: 'freshweek-prev' }, [
      el('a', { class: 'freshweek-go', href: `#/week/${prev.end}`,
        text: `Open last week — ${fmt.date(prev.start)} to ${fmt.dateY(prev.end)}` }),
    ]));
  }
  return wrap;
}

/** Last week's figures, standing where this week's zeroes would have been. */
function prevWeekTile(wp) {
  const prev = wp.previous_week;
  if (!prev) {
    return { label: 'Last week', value: '—', note: 'no completed week before this one' };
  }
  return {
    label: 'Last week', value: fmt.int(prev.load), unit: 'AU',
    note: `${prev.sessions} activit${prev.sessions === 1 ? 'y' : 'ies'} · ${fmt.date(prev.start)} – ${fmt.date(prev.end)}`,
  };
}

/* The differentiator, as a number: which modality actually carried the week.
   Selected from the server's split, never recomputed here. */
function topShareTile(d) {
  const split = d.load.split || {};
  const entries = Object.entries(split).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { label: 'Largest share', value: '—', note: 'nothing scored this week' };
  const [kind, frac] = entries[0];
  return {
    label: 'Largest share', value: `${Math.round(frac * 100)}%`,
    note: `${kindName(kind)} · ${fmt.int((d.load.by_kind || {})[kind])} AU of ${fmt.int(d.load.week_total)}`,
  };
}

const PR_LABEL = {
  e1rm: 'estimated 1RM', reps_at_weight: 'reps at weight',
  session_volume: 'session volume', first_time: 'first time logged',
};

function countUp(node, value, dp) {
  if (value == null) { node.textContent = '—'; return; }
  if (reducedMotion()) { node.textContent = value.toFixed(dp); return; }
  const t0 = performance.now();
  const dur = 620;
  let done = false;
  // Elapsed is read from the same clock t0 came from rather than trusting the
  // frame timestamp: a backgrounded tab resuming with a stale timestamp must
  // never leave the headline number a few hundredths short of the truth.
  const step = () => {
    if (done) return;
    const p = Math.min(1, (performance.now() - t0) / dur);
    node.textContent = (value * (1 - (1 - p) ** 3)).toFixed(dp);
    if (p < 1) requestAnimationFrame(step);
    else done = true;
  };
  requestAnimationFrame(step);
  setTimeout(() => { done = true; node.textContent = value.toFixed(dp); }, dur + 90);
}
