/* Ledger — composite UI pieces shared by more than one view.
 *
 * Copy rules live here as much as CSS does: an empty state states the fact and
 * stops ("None this week."), a failed panel names what is missing instead of
 * blanking the page, and nothing congratulates anybody.
 */

import {
  el, icon, clear, fmt, colorOf, KIND_LABEL, KINDS, todayISO, addDays, dateOf, isoOf,
  weekStart,
} from './core.js';

/* ── panels ──────────────────────────────────────────────────────────────── */

/**
 * A panel, optionally badged so it can be told apart without being read.
 *
 * Every card on a page used to be the same white box under the same small
 * grey uppercase title, so finding one meant reading all of them. Two things
 * fix that here, and both carry information rather than decoration:
 *
 *   `accent` — a modality key (`run`, `soccer`, `lift`…) or a token name.
 *     Hue in this app already means modality: `--k-run` is running in every
 *     chart, session dot and sport tab. So a panel only takes a colour when
 *     that colour is *true* of its subject. Panels about no single modality
 *     stay neutral rather than being given a hue that would then mean two
 *     things.
 *
 *   `kicker` — what kind of claim the panel makes: `Committed plan`,
 *     `Measured`, `Heuristic`, `Log`. This app already draws that line
 *     everywhere else — an estimated load is marked `est`, ACWR is "a
 *     heuristic and never a verdict" — so saying it in the header is the
 *     existing rule made visible, and it is the part that actually
 *     distinguishes two neutral panels from each other.
 *
 * A kicker that would only restate the title is worse than none; leave it off.
 */
export function panel({
  title, sub, tools, id, wide, className = '', accent, kicker,
} = {}) {
  const body = el('div', { class: 'panel-body' });
  const head = el('div', { class: 'panel-head' });

  /* An accent used to tint a 15px tick and stop there, which is a lot of
     machinery for a mark most people never notice. It now sets `--eb` on the
     card itself, so the border and a faint wash at the head can pick it up —
     the panel reads as belonging to its subject before a word of it is read.
     Still only where the hue is *true* of the subject; a decorative accent
     would make the colour mean two things. */
  const accentHue = accent
    ? `var(--${KINDS.includes(accent) ? `k-${accent}` : accent})`
    : null;

  if (title || sub) {
    const stack = el('div', {});
    if (accent || kicker) {
      /* Known modality keys resolve to the palette; anything else is taken as
         a token name, so `accent: 'good'` works without a second parameter. */
      stack.append(el('div', {
        class: 'panel-kicker',
        style: `--eb:${accentHue || 'var(--ink-4, var(--ink-3))'}`,
      }, [
        el('i', { 'aria-hidden': 'true' }),
        kicker ? el('span', { text: kicker }) : null,
      ].filter(Boolean)));
    }
    /* Filtered, not passed straight through: DOM `append()` stringifies null
       into a literal "null" text node, which is exactly what appeared under
       every panel that has a title and no subtitle. */
    stack.append(...[
      title ? el('h2', { text: title }) : null,
      sub ? el('p', { class: 'sub', text: sub }) : null,
    ].filter(Boolean));
    head.append(stack);
  }
  if (tools) head.append(el('div', { class: 'tools' }, [].concat(tools)));

  const node = el('section', {
    class: `panel ${wide ? 'panel-wide' : ''} ${accentHue ? 'has-accent' : ''} ${className}`
      .replace(/\s+/g, ' ').trim(),
    style: accentHue ? `--eb:${accentHue}` : null,
    id: id || null,
  }, [(title || sub || tools) ? head : null, body]);

  node.body = body;
  node.head = head;
  return node;
}

/**
 * Replace a panel's header controls.
 *
 * These used to be appended once, behind `if (!head.querySelector('.tools'))`,
 * which meant a segmented control was built with the state it had on first
 * paint and never rebuilt. Clicking a different window changed the data and
 * left the selection sitting on the old button — the control looked broken
 * while working perfectly. Rebuilding is cheap; a stale selected state is not.
 */
export function setTools(p, nodes) {
  const existing = p.head.querySelector('.tools');
  if (existing) existing.remove();
  p.head.append(el('div', { class: 'tools' }, [].concat(nodes).filter(Boolean)));
}

/* ── where a week sits in time ───────────────────────────────────────────── */

/**
 * `done` | `current` | `ahead` for a week, by its Monday.
 *
 * One rule, used everywhere a week is shown, so "which one is now" never
 * depends on which page you are on — and never requires counting dates against
 * a calendar. The three states are always rendered the same way:
 *
 *   done     muted, filled dot        it happened
 *   current  accent rule, NOW tag     you are in it
 *   ahead    normal ink, hollow dot   it has not started
 *
 * Colour is never alone: `current` carries the word NOW, and `done` and
 * `ahead` differ by a filled versus hollow dot as well as by weight.
 */
export function weekPosition(weekISO, ref = weekStart(todayISO())) {
  if (!weekISO) return 'ahead';
  if (weekISO < ref) return 'done';
  return weekISO === ref ? 'current' : 'ahead';
}

/** The `NOW` tag, for the one week that gets it. */
export const nowTag = () => el('span', { class: 'nowtag', text: 'now' });

/* ── timeframe ───────────────────────────────────────────────────────────── */

/**
 * The window a panel's figures actually cover.
 *
 * Ten of twenty-nine charted panels stated no period at all and the rest said
 * it three different ways, so "is this twelve weeks or a year?" was a question
 * the interface could not answer. The API now publishes one authoritative
 * label per dataset and this is the only thing that renders it: **verbatim**,
 * never paraphrased, never recomputed from `from`/`to`. If a panel's window
 * moves with a control, the same call runs again with the new payload's label
 * and the line changes with it.
 *
 * It sits in one fixed slot on every panel — directly under the title, above
 * the descriptive subtitle — so the eye learns where to look once. A panel
 * with genuinely no time window (This build, Load calibration) simply never
 * calls this and gains no fake one.
 */
export function timeframeLine(tf) {
  const label = typeof tf === 'string' ? tf : (tf && tf.label);
  if (!label) return null;
  const line = el('p', { class: 'tf' }, [
    icon('week', 'tf-i'),
    el('span', { class: 'tf-t', text: label }),
  ]);
  if (tf && tf.from && tf.to) line.title = `${tf.from} to ${tf.to}`;
  return line;
}

/** Put (or update, or remove) that line on a panel built by `panel()`. */
export function setTimeframe(p, tf) {
  const head = p && p.head;
  if (!head) return null;
  const box = head.querySelector(':scope > div:not(.tools)');
  if (!box) return null;

  const label = typeof tf === 'string' ? tf : (tf && tf.label);
  let line = box.querySelector(':scope > .tf');
  if (!label) { if (line) line.remove(); return null; }

  if (!line) {
    line = timeframeLine(tf);
    const title = box.querySelector('h2');
    if (title) title.after(line);
    else box.prepend(line);
    return line;
  }
  line.querySelector('.tf-t').textContent = label;
  if (tf && tf.from && tf.to) line.title = `${tf.from} to ${tf.to}`;
  return line;
}

/** Honest degraded state — names the endpoint rather than showing nothing. */
export function panelError(host, res, what) {
  clear(host);
  const offline = res && res.status === 0;
  const missing = res && res.status === 404;
  const text = offline
    ? `Can't reach the server. ${what} is unavailable — showing nothing rather than something wrong.`
    : missing
      ? `${what} is not available from this server yet.`
      : `${what} failed to load (${(res && res.error) || 'unknown error'}).`;
  host.append(el('p', { class: 'empty', text }));
}

export const emptyNote = (text) => el('p', { class: 'empty', text });

/* ── skeletons ───────────────────────────────────────────────────────────── */

export function skeletonLines(n = 3, host) {
  const wrap = el('div', { class: 'sk-wrap' });
  for (let i = 0; i < n; i++) {
    wrap.append(el('div', { class: 'sk sk-line', style: `width:${[92, 76, 84, 64][i % 4]}%` }));
  }
  if (host) { clear(host); host.append(wrap); }
  return wrap;
}

export function skeletonBlock(height, host) {
  const node = el('div', { class: 'sk', style: `height:${height}px` });
  if (host) { clear(host); host.append(node); }
  return node;
}

/* ── stat tiles ──────────────────────────────────────────────────────────── */

/** items: [{label, value, unit, note, id}] — value carries proportional
 *  figures on purpose; tabular-nums belongs in columns, not display numbers. */
export function statStrip(items) {
  /* The column count is data, not a constant. Five tiles in a four-column grid
     left the fifth stranded across an otherwise empty row on desktop; the grid
     now takes its track count from how many tiles there actually are. */
  const strip = el('div', { class: 'strip', 'data-n': String(items.length) });
  for (const m of items) {
    /* `tone` is opt-in and means one thing: how this figure stands against the
       target it was chasing. Only the panels that *have* a target pass it — a
       tile with nothing to hit gets no colour, because a green number with
       nothing behind it is decoration. */
    strip.append(el('div', { class: `stat${m.tone ? ` is-toned tone-${m.tone}` : ''}${m.className ? ` ${m.className}` : ''}` }, [
      /* An optional icon before the label — the medal on a best — with a
         real space after it so the text does not concatenate for a reader. */
      el('div', { class: 'stat-label' }, [
        m.icon ? icon(m.icon, 'stat-icon') : null,
        m.icon ? document.createTextNode(' ') : null,
        el('span', { text: m.label }),
      ].filter(Boolean)),
      /* A real space before the unit. `<span>40.2</span><u>km</u>` renders
         with a CSS margin but concatenates to "40.2km" for anything reading
         text — copy and paste, and a screen reader announcing the tile. */
      el('div', { class: 'stat-value' }, [
        el('span', { text: m.value }),
        m.unit ? document.createTextNode(' ') : null,
        m.unit ? el('u', { text: m.unit }) : null,
      ].filter(Boolean)),
      m.note ? el('div', { class: 'stat-note', text: m.note }) : null,
    ]));
  }
  return strip;
}

/* ── modality bits ───────────────────────────────────────────────────────── */

export const kindDot = (kind) =>
  el('span', { class: 'kdot', style: `background:${colorOf(kind)}` });

/**
 * An RPE Garmin inferred rather than one you tapped. Marked, never silently
 * mixed in: it is the single input the unified-load number depends on.
 */
export function rpeEstimated(rpe, source) {
  const how = source === 'training_effect' ? 'estimated from Garmin training effect'
    : source === 'hr_zones' ? 'estimated from heart-rate time in zone'
      : 'estimated by Garmin, not tapped';
  return el('span', { class: 'est', title: how }, [
    el('span', { text: `RPE ${rpe}` }),
    /* A real space, not a margin: `<span>4.4</span><span>est</span>`
       concatenates to "4.4est" for anything reading text rather than pixels. */
    document.createTextNode(' '),
    el('span', { class: 'est-mark', text: 'est' }),
  ]);
}

/**
 * One session's load, with where the number came from.
 *
 * There is a single load scale — Garmin's. Where the watch recorded the
 * activity its figure is used unchanged; where it did not, a stand-in is
 * derived from rpe × minutes and converted onto that scale by a factor fitted
 * from the sessions carrying both. That conversion is a fit, not a
 * measurement, so it is marked — the same rule an estimated RPE follows. A
 * number that was inferred never looks like one that was recorded.
 */
export function loadValue(session) {
  const load = session.load;
  if (load == null) return el('span', { class: 'sess-load num', text: '—' });

  const src = session.load_source;
  const text = `${fmt.int(load)} AU`;
  if (src !== 'estimated' && src !== 'unscaled') {
    return el('span', { class: 'sess-load num', text });
  }
  return el('span', {
    class: 'sess-load num est',
    title: src === 'estimated'
      ? 'Converted onto Garmin’s training-load scale from rpe × minutes, because the watch did not record this session.'
      : 'Not yet convertible: too few sessions carry both numbers to fit a factor for this modality, so the raw rpe × minutes figure is shown.',
  }, [
    el('span', { text }),
    document.createTextNode(' '),
    el('span', { class: 'est-mark', text: src === 'estimated' ? 'est' : 'raw' }),
  ]);
}

/** Mon/Tue/Wed carry the fixture, so the weekday is a first-class label. */
export const dowBadge = (iso) => el('span', {
  class: `dow dow-${dateOf(iso).getDay()}`, text: fmt.dow(iso),
  title: fmt.weekday(iso),
});

export const kindName = (kind) => KIND_LABEL[kind] || kind;

/** Toggle chips for filtering by modality. onChange(kindOrNull) */
export function kindFilter(kinds, active, onChange, { allLabel = 'All' } = {}) {
  const row = el('div', { class: 'chip-row', role: 'group', 'aria-label': 'Filter by modality' });
  const mk = (key, label) => {
    const btn = el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(active === key),
      on: { click: () => onChange(key) },
    }, [key ? el('i', { class: 'swatch', style: `background:${colorOf(key)}` }) : null,
        el('span', { text: label })]);
    return btn;
  };
  row.append(mk(null, allLabel));
  for (const k of kinds) row.append(mk(k, kindName(k)));
  return row;
}

/** Segmented control. options: [[value,label], …] */
export function segmented(options, active, onChange, ariaLabel) {
  const wrap = el('div', { class: 'seg', role: 'group', 'aria-label': ariaLabel || null });
  for (const [value, label] of options) {
    wrap.append(el('button', {
      type: 'button', text: label, 'aria-pressed': String(value === active),
      on: { click: () => onChange(value) },
    }));
  }
  return wrap;
}

/* ── date ranges ─────────────────────────────────────────────────────────── */

export const RANGE_PRESETS = [
  ['12w', '12 weeks'], ['26w', '26 weeks'], ['52w', '52 weeks'],
  ['ytd', 'This year'], ['all', 'All time'],
];

/* The range picked on a Sports page is one choice shared by the three of
   them and kept across visits: 12 weeks on Soccer is 12 weeks on Running and
   on Lifting until it is changed, rather than each page snapping back to its
   own default on every arrival. The URL still wins when it names a range, so
   a shared link lands where it points. */
const SPORTS_RANGE_KEY = 'ledger.sportsRange';
const isPreset = (v) => RANGE_PRESETS.some(([k]) => k === v);
export function sportsRange(route, fallback) {
  const q = route.query.get('range');
  if (isPreset(q)) return q;
  try {
    const v = localStorage.getItem(SPORTS_RANGE_KEY);
    if (isPreset(v)) return v;
  } catch { /* private mode */ }
  return fallback;
}
export function rememberSportsRange(v) {
  try { localStorage.setItem(SPORTS_RANGE_KEY, v); } catch { /* private mode */ }
}

/**
 * The same rule for any page's window or range control: the URL wins when it
 * names a valid choice, otherwise the last choice made on this device, else
 * the page's default. A control that snaps back to its default on every
 * arrival is a control the reader has to re-set every time — the Sports
 * pages learnt this first, and a page shipped later without it.
 *
 *   rememberedChoice('ledger.calories.range', route, 'range', isValid, '28d')
 *   rememberChoice('ledger.calories.range', v)   // in the control's onChange
 *
 * Only a *choice* is remembered. A position in time — the week, the day — is
 * not, because the right default for those is now.
 */
export function rememberedChoice(key, route, param, isValid, fallback) {
  const q = route && route.query ? route.query.get(param) : null;
  if (q != null && isValid(q)) return q;
  try {
    const v = localStorage.getItem(key);
    if (v != null && isValid(v)) return v;
  } catch { /* private mode */ }
  return fallback;
}
export function rememberChoice(key, v) {
  try { localStorage.setItem(key, String(v)); } catch { /* private mode */ }
}

/**
 * Resolve a preset key to {from, to}. `all` means unbounded, so both null.
 *
 * A bounded preset sends an explicit `to` of today. This began as a workaround
 * — an open-ended `from` used to come back labelled "no data yet" — and stays
 * now the server handles the open range, because the two disagree about where
 * a bounded window *ends*: left open, the label stops at the last logged
 * session, so "52 weeks" reads as ending last Tuesday. Naming today says what
 * the control actually asked for. It selects the same sessions either way,
 * nothing being logged in the future.
 */
export function resolveRange(key, today = todayISO()) {
  if (key === 'all') return { from: null, to: null };
  if (key === 'ytd') return { from: `${dateOf(today).getFullYear()}-01-01`, to: today };
  const m = /^(\d+)w$/.exec(key || '');
  if (m) return { from: addDays(today, -7 * Number(m[1])), to: today };
  if (/^\d{4}$/.test(key || '')) return { from: `${key}-01-01`, to: `${key}-12-31` };
  return { from: null, to: null };
}

/* ── results ─────────────────────────────────────────────────────────────── */

/** W / L / D. The letter carries the meaning; colour only reinforces it. */
export function resultChip(result) {
  if (!result) return el('span', { class: 'res res-none', text: '–' });
  return el('span', { class: `res res-${result}`, text: result });
}

/* ── sessions ────────────────────────────────────────────────────────────── */

/** One row of the log. The whole row is the edit affordance — on a phone that
 *  is the only tap target big enough to be worth having. */
export function sessionRow(s, { showDate = false } = {}) {
  const d = s.detail || {};
  const meta = el('span', { class: 'sess-meta' });
  const bit = (text, strong) => meta.append(el('span', { class: strong ? 'strong' : null, text }));

  if (d.result || d.gf != null) {
    const score = el('span', { class: 'strong' }, [
      resultChip(d.result),
      el('span', { text: d.gf != null ? ` ${d.gf}–${d.ga}` : '' }),
    ]);
    meta.append(score);
  }
  if (d.goals != null || d.assists != null) bit(`${d.goals ?? 0}G ${d.assists ?? 0}A`, true);
  if (s.distance_km) bit(fmt.km(s.distance_km), true);
  /* Exact time wherever time is half of a result.
     A session that covered ground has a pace, and a pace is distance over
     *time* — so 24:38 is the figure and "25 min" is a label that has thrown
     away the seconds. The database stores 24.63; only the render rounded it.
     Sessions with no distance (lifting, abs, a fast) keep whole minutes,
     because nothing there divides by them. */
  if (s.duration_min) {
    bit(s.distance_km ? fmt.clock(s.duration_min) : fmt.mins(s.duration_min));
  }
  if (s.pace_s_per_km) bit(fmt.pace(s.pace_s_per_km), true);
  if (d.compliance_pct != null) bit(`${d.compliance_pct}% to plan`);
  if (d.zones) bit(Object.entries(d.zones).map(([z, v]) => `${z.toUpperCase()} ${v}%`).join(' '));
  if (d.load_lbs != null) bit(`${d.load_lbs} lb`);
  if (d.hours != null) bit(`${d.hours} hr`);
  if (s.rpe != null) {
    if (d.rpe_estimated) meta.append(rpeEstimated(s.rpe, d.rpe_source));
    else bit(`RPE ${s.rpe}`, true);
  }
  if (s.notes) bit(s.notes);
  if (s.source && s.source !== 'manual') bit(s.source);

  const label = `Edit ${kindName(s.kind)} on ${fmt.dateY(s.date)}`;

  return el('a', {
    class: 'sess', href: `#/edit/${s.id}`, 'aria-label': label,
  }, [
    kindDot(s.kind),
    el('span', { class: 'sess-kind' }, [
      el('span', { text: kindName(s.kind) }),
      showDate ? el('span', { class: 'sess-date' }, [
        dowBadge(s.date), el('span', { text: fmt.date(s.date) }),
      ]) : null,
    ]),
    loadValue(s),
    meta,
    el('span', { class: 'sess-go', 'aria-hidden': 'true' }, [icon('right')]),
  ]);
}

/** Sessions grouped under weekday headings. */
export function sessionList(sessions, { showDate = false, groupBy = 'day' } = {}) {
  const host = el('div', { class: 'sessions' });
  if (!sessions.length) {
    host.append(emptyNote('No activities logged.'));
    return host;
  }
  if (groupBy === 'none') {
    for (const s of sessions) host.append(sessionRow(s, { showDate }));
    return host;
  }
  const groups = new Map();
  for (const s of sessions) {
    const key = groupBy === 'month' ? s.date.slice(0, 7)
      : groupBy === 'week' ? weekStart(s.date)
        : s.date;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const [key, list] of groups) {
    if (groupBy === 'week') {
      /* A real divider, not a heading: the log is read a week at a time and
         the boundary between weeks is the thing the eye needs to find. */
      const end = addDays(key, 6);
      const load = list.reduce((a, x) => a + Number(x.load || 0), 0);
      const km = list.reduce((a, x) => a + Number(x.distance_km || 0), 0);
      const bits = [`${list.length} session${list.length === 1 ? '' : 's'}`];
      if (load) bits.push(`${fmt.int(load)} AU`);
      if (km) bits.push(`${fmt.one(km)} km`);
      host.append(el('div', { class: 'week-div' }, [
        el('div', { class: 'week-div-line' }, [
          el('span', { class: 'week-div-range' }, [
            el('b', { text: `${fmt.date(key)} – ${fmt.date(end)}` }),
            el('span', { class: 'week-div-year', text: dateOf(end).getFullYear() }),
          ]),
          el('span', { class: 'week-div-sum num', text: bits.join(' · ') }),
        ]),
      ]));
    } else if (groupBy === 'month') {
      host.append(el('div', {
        class: 'day-label',
        text: dateOf(`${key}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      }));
    } else {
      host.append(el('div', { class: 'day-label day-label-dow' }, [
        el('b', { text: fmt.weekday(key) }),
        el('span', { text: fmt.date(key) }),
      ]));
    }
    for (const s of list) host.append(sessionRow(s, { showDate: groupBy !== 'day' || showDate }));
  }
  return host;
}

/* ── facts ───────────────────────────────────────────────────────────────── */

/** Emphasise the leading figure of each server-written fact, nothing more. */
export function factsLine(facts) {
  const p = el('p', { class: 'facts' });
  if (!facts || !facts.length) {
    p.append(el('b', { text: 'Nothing logged yet.' }), el('span', { text: ' The first entry starts the record.' }));
    return p;
  }
  for (const f of facts) {
    const m = /^([\d.,]+%?|[A-Z][a-z]+)(.*)$/s.exec(f);
    if (m) {
      p.append(el('b', { text: m[1] }), el('span', { text: `${m[2]} ` }));
    } else {
      p.append(el('span', { text: `${f} ` }));
    }
  }
  return p;
}

/* ── sport sub-navigation ────────────────────────────────────────────────── */

/* Two sections have peer pages inside them. They share one tab row so the
   grouping is visible rather than implied by the URL. */
export const TAB_GROUPS = {
  sports: {
    label: 'Sport',
    tabs: [
      ['soccer', 'Soccer', 'soccer'],
      ['running', 'Running', 'run'],
      ['lifting', 'Lifting', 'lift'],
    ],
  },
  history: {
    label: 'History',
    tabs: [
      ['all', 'All time', null],
      ['trends', 'Explore', null],
    ],
  },
};

export function subTabs(group, active) {
  const spec = TAB_GROUPS[group];
  if (!spec) return el('div');
  const nav = el('nav', { class: 'sporttabs', 'aria-label': spec.label });
  for (const [route, label, kind] of spec.tabs) {
    nav.append(el('a', {
      href: `#/${route}`, class: 'sporttab',
      'aria-current': route === active ? 'page' : null,
    }, [
      kind ? el('i', { style: `background:${colorOf(kind)}` }) : null,
      el('span', { text: label }),
    ]));
  }
  return nav;
}

/** Back-compat alias used by the three modality views. */
export const sportTabs = (active) => subTabs('sports', active);

/**
 * A labelled rule between groups of panels. Undifferentiated density is what
 * makes a long page read as a wall; this gives the eye somewhere to rest and
 * tells it what the next few panels are about.
 */
export function sectionRule(label, note, action) {
  /* `action` sits after the rule line rather than before it — the heading and
     its note read as one phrase, and a control wedged between them would break
     that. The line is a `::after` pseudo-element, so the slot orders past it
     rather than following it in the DOM. One node or several. */
  const actions = [].concat(action || []).filter(Boolean);
  return el('div', { class: 'srule' }, [
    el('h3', { class: 'srule-label', text: label }),
    note ? el('span', { class: 'srule-note', text: note }) : null,
    actions.length ? el('div', { class: 'srule-action' }, actions) : null,
  ]);
}

/**
 * A titled group of panels that visibly belong together.
 *
 * `sectionRule` draws a hairline and a small label, which is enough to separate
 * two panels and not nearly enough to bind six. On a page carrying the week's
 * counts, a distance ramp, its committed targets and a goal weight, a rule
 * between them left eight cards that read as eight unrelated widgets — the
 * heading said "Running distance" and nothing said where running distance
 * stopped.
 *
 * So a section is a container: its own sunken ground, its own header, and the
 * panels nested inside it. Three layers of depth — page, group, card — which
 * is what makes membership obvious without a caption explaining it.
 *
 * `accent` takes a modality key where the section genuinely is one, on the same
 * rule as `panel()`: a hue here means the same thing it means everywhere else,
 * or it is left neutral.
 */
export function sectionGroup({ title, note, accent }, children) {
  /* A modality key resolves to the data palette; anything else is taken as a
     token name, which is how the chrome accents (`sa-teal`, `sa-indigo`,
     `sa-plum`) reach a section that is not a modality. */
  const hue = accent
    ? `var(--${KINDS.includes(accent) ? `k-${accent}` : accent})`
    : null;
  return el('section', {
    class: `pgroup${hue ? ' has-accent' : ''}`,
    style: hue ? `--eb:${hue}` : null,
  }, [
    el('header', { class: 'pgroup-head' }, [
      el('div', { class: 'pgroup-title' }, [
        el('i', { 'aria-hidden': 'true' }),
        el('h2', { text: title }),
      ]),
      note ? el('p', { class: 'pgroup-note', text: note }) : null,
    ]),
    el('div', { class: 'pgroup-body' }, [].concat(children).filter(Boolean)),
  ]);
}

/** A long table folded away behind its own count. */
export function collapsible(summaryText, node, { open = false } = {}) {
  const det = el('details', { class: 'fold', open: open || null });
  det.append(el('summary', {}, [el('span', { text: summaryText })]));
  det.append(el('div', { class: 'fold-body' }, [node]));
  return det;
}

/* ── read-out ────────────────────────────────────────────────────────────── */

/**
 * A list of factual sentences. Each names a figure and the window it came
 * from. The leading number is emphasised; nothing is congratulated.
 */
export function readout(lines) {
  const ul = el('ul', { class: 'readout' });
  if (!lines || !lines.length) {
    return el('p', { class: 'empty', text: 'Not enough history to say anything specific yet.' });
  }
  for (const line of lines) {
    const li = el('li');
    const m = /^([A-Z][a-z]+|[\d.,]+[%a-zA-Z]*)(\s)([\s\S]*)$/.exec(line);
    if (m) li.append(el('span', {}, [el('b', { text: m[1] }), el('span', { text: m[2] + m[3] })]));
    else li.append(el('span', { text: line }));
    ul.append(li);
  }
  return ul;
}

/** Counts per modality, scaled to the largest. No target, no denominator —
 *  there is no plan to be behind on. */
export function countBars(entries) {
  const host = el('div', { class: 'countbars' });
  const max = Math.max(1, ...entries.map((e) => e.value));
  for (const e of entries) {
    host.append(el('div', { class: 'meter' }, [
      el('div', { class: 'meter-top' }, [
        el('span', { class: 'meter-k' }, [
          el('i', { style: `background:${e.color}` }), el('span', { text: e.label }),
        ]),
        el('span', { class: 'meter-n num', text: e.note ? `${e.value}  ${e.note}` : String(e.value) }),
      ]),
      el('div', { class: 'track' }, [
        el('div', { class: 'track-fill', style: `width:${(e.value / max) * 100}%;background:${e.color}` }),
      ]),
    ]));
  }
  return host;
}

/* ── ACWR ────────────────────────────────────────────────────────────────── */

/**
 * Acute:chronic as a position on a scale, not a verdict. No status colour, no
 * alert — the typical band is shaded and the number sits where it sits.
 *
 * The panel also states its inputs outright, because the obvious question when
 * a watch is showing a different figure is "which one is wrong?", and the
 * answer is neither: they are built from different data.
 */
export function acwrMeter(load, { topKind, topPct, partialWeek } = {}) {
  const wrap = el('div', { class: 'acwr' });
  const value = load.acwr;

  /* Both halves are rolling windows ending on the last day that has actually
     happened — NOT on the Sunday this week will end on. That distinction used
     to be wrong in the other direction: the acute window was the calendar week,
     so a Monday showed one day of load against four weeks of it and the ratio
     read 0.00 after a seven-session week. It is stated plainly rather than left
     to be inferred, because the number sits right underneath. */
  const partial = partialWeek
    ? el('p', { class: 'acwr-partial', text:
      'Both windows end today and count backwards, so this carries the week '
      + 'that just finished. It is not the calendar week — that one is '
      + `${partialWeek.days_elapsed} day${partialWeek.days_elapsed === 1 ? '' : 's'} old.` })
    : null;
  if (partial) wrap.append(partial);

  if (value == null) {
    wrap.append(el('div', { class: 'acwr-value' }, [el('span', { text: '—' })]));
    wrap.append(el('p', { class: 'sub', text:
      `Building the baseline — ${load.days_of_history} of ${load.min_days} days of history. `
      + 'A ratio built on a partial 28-day window is not a small error, it is a wrong number.' }));
    return wrap;
  }

  const LO = 0.5;
  const HI = 1.8;
  const pos = Math.max(0, Math.min(1, (value - LO) / (HI - LO)));
  const bandA = ((0.8 - LO) / (HI - LO)) * 100;
  const bandB = ((1.3 - LO) / (HI - LO)) * 100;

  wrap.append(el('div', { class: 'acwr-value' }, [
    el('span', { class: 'acwr-num', text: fmt.two(value) }),
    el('span', { class: 'acwr-band', text: load.band || '' }),
  ]));

  const scale = el('div', { class: 'acwr-scale', role: 'img',
    'aria-label': `Acute to chronic ratio ${fmt.two(value)}, ${load.band || 'unbanded'}. Typical range 0.8 to 1.3.` }, [
    el('i', { class: 'acwr-typical', style: `left:${bandA}%;width:${bandB - bandA}%` }),
    el('i', { class: 'acwr-mark', style: `left:${pos * 100}%` }),
  ]);
  wrap.append(scale);
  wrap.append(el('div', { class: 'acwr-ends' }, [
    el('span', { text: '0.5' }),
    el('span', { text: 'typical 0.8–1.3' }),
    el('span', { text: '1.8' }),
  ]));

  /* The band as load, not only as a ratio.
     "Is this range static?" is a fair question of a scale whose labels never
     move, and the answer is that the thresholds are fixed while the thing they
     multiply is not. A watch shows the same band the other way round — Garmin
     publishes `minTrainingLoadChronic` and `maxTrainingLoadChronic`, which are
     exactly 0.8x and 1.5x its own chronic load — so its range appears to move
     while its ratios sit still.
     Printing both makes the moving part visible: the ratio band is fixed, the
     kilometres-per-day it works out to today are not. */
  if (load.chronic_au) {
    wrap.append(el('p', { class: 'sub acwr-abs', text:
      `At today's ${Math.round(load.chronic_au)} AU/day baseline, that band is `
      + `${Math.round(0.8 * load.chronic_au)}–${Math.round(1.3 * load.chronic_au)} AU/day. `
      + 'The thresholds do not move; the baseline they multiply does, so the same '
      + 'ratio means more work as fitness climbs.' }));
  }
  /* The arithmetic, where the server publishes its own inputs. "Why is this
     different from my watch" is a fair question and it is much better answered
     by showing the division than by asserting a sentence about it. */
  if (load.acute_au != null && load.chronic_au != null) {
    wrap.append(el('p', { class: 'acwr-sum num' }, [
      el('b', { text: fmt.int(load.acute_au) }),
      el('span', { text: ' AU/day over 7 days ÷ ' }),
      el('b', { text: fmt.int(load.chronic_au) }),
      el('span', { text: ' AU/day over 28' }),
    ]));
  }

  wrap.append(el('p', { class: 'sub', text:
    'Mean daily load over the last 7 days, divided by mean daily load over the last 28. '
    + 'A heuristic for how fast the ramp is, not a verdict on it.' }));

  /* Expected to disagree with a watch, so say so where the number is. */
  const why = el('details', { class: 'help acwr-why' }, [
    el('summary', { text: 'Why this will not match Garmin' }),
  ]);
  const body = el('div', { class: 'help-body' });
  body.append(el('p', { text:
    'Different inputs, so a different number — neither is a correction of the other.' }));
  body.append(el('p', { text:
    'Garmin builds its ratio only from the sessions the watch actually recorded. Ledger builds it from every '
    + 'logged session — the watch’s own figure where there is one, and a stand-in converted onto the same scale '
    + 'where there is not. Same scale, wider coverage, so a different ratio.' }));
  body.append(el('p', { text:
    topKind && topPct >= 25
      ? `That gap is the point of this app: ${topKind.toLowerCase()} is ${Math.round(topPct)}% of the load here, and it is the modality a watch counts worst.`
      : 'That gap is the point of this app: soccer is the modality a watch counts worst, and it is a large share of this record.' }));
  body.append(el('p', { text:
    'So expect the values to differ even when both are pointing the same way. Compare each against its own '
    + 'history rather than against the other.' }));

  why.append(body);
  wrap.append(why);
  return wrap;
}

/* ── misc ────────────────────────────────────────────────────────────────── */

export function meterRow({ label, color, done, planned }) {
  const pct = planned ? Math.min(100, (done / planned) * 100) : 0;
  return el('div', { class: 'meter' }, [
    el('div', { class: 'meter-top' }, [
      el('span', { class: 'meter-k' }, [
        el('i', { style: `background:${color}` }), el('span', { text: label }),
      ]),
      el('span', { class: 'meter-n num', text: planned ? `${done} / ${Math.round(planned)}` : `${done}` }),
    ]),
    el('div', { class: 'track' }, [
      el('div', { class: 'track-fill', style: `width:${pct}%;background:${color}` }),
    ]),
  ]);
}

export function yearsOfData(startISO, endISO) {
  const out = [];
  const a = dateOf(startISO).getFullYear();
  const b = dateOf(endISO).getFullYear();
  for (let y = b; y >= a; y--) out.push(String(y));
  return out;
}

export { isoOf };
