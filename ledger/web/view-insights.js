/* Insights — everything the record will say about itself.
 *
 * The findings are generated on this device by insights.js. That is a design
 * decision, not a limitation: no network call, no model, nothing to expire, and
 * every number is arithmetic you could redo by hand from the session log.
 *
 * The page is honest about three things, in the header and in every card: the
 * sample size behind each finding, the fact that nothing here is causal, and
 * the fact that a rule that found nothing simply says nothing.
 */

import {
  el, icon, clear, api, busy, fmt, todayISO, getWeightUnit, setWeightUnit,
  reducedMotion,
} from './core.js';
import {
  panel, emptyNote, skeletonLines, skeletonBlock, panelError, segmented,
} from './ui.js';
import { sessionsIn, invalidate } from './dataset.js';
import { buildInsights } from './insights.js';

/* Section to modality. Only where the hue is true of the subject: Consistency
   and Training load span every modality, so they stay neutral rather than
   borrowing a colour that already means one particular thing. */
const SECTION_ACCENT = {
  Soccer: 'soccer',
  Running: 'run',
  Lifting: 'lift',
  'Bodyweight & fasting': 'fast',
  /* Not modalities — they span all of them — so they take a chrome accent
     rather than borrowing a hue that already means one particular sport. */
  'Training load': 'sa-teal',
  Consistency: 'sa-indigo',
};

export function mount(host) {
  let alive = true;
  const state = { unit: getWeightUnit(), ctx: null, computedAt: null, newest: null };

  const head = el('section', { class: 'insights-head' }, [
    el('h1', { class: 'insights-title', text: 'What the record says' }),
    el('p', { class: 'insights-lede', text:
      'Findings computed on this device from your own log. There is no model and no network call — every number here '
      + 'is arithmetic over the sessions you entered, so it will still work in five years and you can check any of it by hand.' }),
  ]);

  const meta = el('div', { class: 'insights-meta' });
  const body = el('div', { class: 'insights-body' });

  host.append(head, meta, body);
  skeletonBlock(60, meta);
  const sk = el('div');
  skeletonLines(10, sk);
  body.append(sk);

  async function loadAll() {
    busy(true);
    const hist = await api('/api/history');
    const sess = await sessionsIn({});
    const summary = await api('/api/summary?weeks=52');
    busy(false);
    if (!alive) return;

    if (!sess.ok) {
      clear(body);
      const p = panel({ title: 'Insights' });
      panelError(p.body, sess.res, 'The session log');
      body.append(p);
      return;
    }

    state.computedAt = new Date();
    state.newest = (sess.items || []).reduce(
      (a, x) => (!a || x.date > a ? x.date : a), null,
    );
    state.ctx = {
      all: sess.items,
      soccer: sess.items.filter((s) => s.kind === 'soccer'),
      bodyweight: hist.ok ? (hist.data.bodyweight || []) : [],
      history: hist.ok ? hist.data : null,
      loadWeeks: summary.ok ? (summary.data.load_by_week || []) : [],
      today: hist.ok ? hist.data.today : todayISO(),
      unit: state.unit,
    };
    paint();
  }

  loadAll();

  function paint() {
    const ctx = { ...state.ctx, unit: state.unit };
    const { grouped, count, attempted } = buildInsights(ctx);

    clear(meta);
    meta.append(
      el('div', { class: 'insights-stats' }, [
        el('span', {}, [el('b', { text: String(count) }), el('span', { text: ' findings' })]),
        el('span', {}, [el('b', { text: fmt.int(ctx.all.length) }), el('span', { text: ' sessions read' })]),
        el('span', {}, [
          el('b', { text: String(attempted - count) }),
          el('span', { text: `${attempted - count === 1 ? ' check' : ' checks'} found nothing worth reporting` }),
        ]),
      ]),
      el('div', { class: 'tools' }, [
        el('span', { class: 'lbl', text: 'Weight in' }),
        segmented([['lb', 'lb'], ['kg', 'kg']], state.unit, (v) => {
          state.unit = setWeightUnit(v);
          paint();
        }, 'Weight units'),
        el('button', {
          class: 'btn btn-sm', type: 'button',
          on: {
            click: () => {
              invalidate();
              clear(body);
              const s2 = el('div');
              skeletonLines(8, s2);
              body.append(s2);
              loadAll();
            },
          },
        }, [icon('sync'), el('span', { text: 'Recalculate' })]),
      ]),
    );

    /* When these numbers were worked out, and how current the data under them
       is — two different questions, so both are answered. */
    meta.append(el('p', { class: 'insights-stamp' }, [
      el('span', { text: `Last updated ${fmt.stamp(state.computedAt || new Date())}` }),
      state.newest
        ? el('span', { text: ` · newest activity ${fmt.dateY(state.newest)} (${fmt.relDays(state.newest)})` })
        : null,
    ]));

    clear(body);
    if (!grouped.length) {
      body.append(emptyNote('Not enough on record yet for any of the checks to say something specific.'));
      return;
    }

    /* Twenty-five findings in six identical stacks is a wall: every card the
       same weight, so nothing is the answer and the page has to be read in
       full or not at all. Two things fix that without inventing a ranking the
       data does not support. First, an index — six sections, their counts, and
       a jump. Second, a lead finding per section: the rules already sort by
       effect size within a section, so the top one is promoted rather than
       chosen. Across sections the weights are not comparable — a layoff in
       days against a share of load — so there is deliberately no "top 3"
       overall, which would be a made-up ordering. */
    /* Buttons rather than anchors: the whole app routes on the hash, so a
       second # in the URL would be read as a route and never as an anchor. */
    const index = el('nav', { class: 'insights-index', 'aria-label': 'Jump to a section' });
    for (const group of grouped) {
      index.append(el('button', {
        class: 'insights-jump', type: 'button',
        'aria-label': `Jump to ${group.section}, ${group.items.length} findings`,
        on: {
          click: () => {
            const target = document.getElementById(slug(group.section));
            if (!target) return;
            target.scrollIntoView({
              behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start',
            });
            target.focus({ preventScroll: true });
          },
        },
      }, [
        el('span', { text: group.section }),
        el('b', { class: 'num', text: String(group.items.length) }),
      ]));
    }
    body.append(index);

    for (const group of grouped) {
      const p = panel({
        title: group.section,
        sub: `${group.items.length} finding${group.items.length === 1 ? '' : 's'}, strongest first`,
        wide: true, id: slug(group.section),
        /* Every section on this page is about one modality, so each card takes
           that modality's hue — the same blue that means soccer in every chart
           and session dot. A page of six identical white boxes was the whole
           complaint: with the accent, "where is the running section" is
           answered by scrolling rather than by reading six headings.

           Consistency and training load span every modality, so they stay
           neutral. A hue there would have to mean something it does not. */
        accent: SECTION_ACCENT[group.section] || null,
      });
      p.tabIndex = -1;    // so a jump lands the keyboard where the eye went
      const [lead, ...rest] = group.items;
      p.body.append(card(lead, true));
      if (rest.length) {
        const grid = el('div', { class: 'insight-grid' });
        for (const f of rest) grid.append(card(f));
        p.body.append(grid);
      }
      body.append(p);
    }

    const method = el('details', { class: 'help method' }, [
      el('summary', { text: 'How these are worked out' }),
    ]);
    const mb = el('div', { class: 'help-body' });
    for (const line of [
      'Every finding is produced by a fixed rule run over your session log. The same data always gives the same result.',
      'Nothing is reported below its minimum sample size — a pattern across four matches is not a pattern, so those checks stay silent.',
      'Every card prints the number of sessions or matches behind it. If the denominator looks too small to you, it is.',
      'Nothing here is causal. Where two things move together the card says so and stops; your calendar is not a controlled trial and fixtures are not randomly assigned.',
      'Weight is stored in kilograms and displayed in whichever unit you pick. Nothing about bodyweight is scored or given a direction.',
    ]) mb.append(el('p', { text: line }));
    method.append(mb);
    body.append(method);
  }

  function card(f, lead = false) {
    return el('article', { class: `insight${lead ? ' insight-lead' : ''}` }, [
      el('p', { class: 'insight-head', text: f.headline }),
      el('p', { class: 'insight-detail', text: f.detail }),
      el('p', { class: 'insight-n' }, [
        el('span', { class: 'tag', text: `n = ${fmt.int(f.n)}` }),
      ]),
    ]);
  }

  const slug = (s) => `ins-${s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

  return { destroy() { alive = false; } };
}
