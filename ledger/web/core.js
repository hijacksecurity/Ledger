/* Ledger — shared primitives: DOM, formatting, palette, network, tooltip.
 *
 * No framework and no build step, so the only abstraction here is the one that
 * pays for itself: a tiny element factory, a formatter table, and a fetch
 * wrapper that never throws. Views stay readable because of it.
 */

/* ── DOM ─────────────────────────────────────────────────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'g', 'rect', 'path', 'line', 'circle', 'text', 'polyline', 'polygon',
  'tspan', 'defs', 'clipPath', 'use', 'title',
]);

/**
 * el('div', {class:'x', text:'hi'}, [child, …])
 * `text` sets textContent — untrusted strings (notes, exercise names) never
 * take the innerHTML path.
 */
export function el(tag, attrs = {}, kids = []) {
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);

  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'data') for (const [d, dv] of Object.entries(v)) node.dataset[d] = dv;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of [].concat(kids)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid);
  }
  return node;
}

/** <svg><use href="#i-name"></svg> from the inline sprite. */
export function icon(name, cls) {
  const svg = el('svg', { 'aria-hidden': 'true', class: cls || null });
  svg.append(el('use', { href: `#i-${name}` }));
  return svg;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) { node.replaceChildren(); return node; }

/* ── modalities & palette ────────────────────────────────────────────────── */

/* Fixed slot order. A hue belongs to a modality, not to a rank, so filtering
   a series out never repaints the survivors. */
export const KINDS = ['soccer', 'run', 'stairs', 'lift', 'ab', 'quickfeet', 'bike', 'ruck', 'fast', 'other'];

/** Everything that puts running miles through the legs. Bike is not one.
    'other' is here for its distance only: every consumer sums `distance_km`,
    so an 'other' without one adds nothing, and one with a distance was on
    the legs by the user's own rule. Mirrors `ramp.ON_FOOT` on the server. */
export const ON_FOOT = ['soccer', 'run', 'stairs', 'quickfeet', 'ruck', 'other'];

/* `fast` is a fasting day carried over from the notebook, not a fast run. Shown
   as "Fast" it sat in the activity mix between Run and Quick feet reading like
   a tempo session. It stays a counted activity — the notebook's own boxed
   average includes these — but it gets a name that cannot be misread. */
export const KIND_LABEL = {
  soccer: 'Soccer', run: 'Run', lift: 'Lift', ab: 'Ab attack',
  quickfeet: 'Quick feet', stairs: 'Stairs', bike: 'Bike', ruck: 'Ruck',
  fast: 'Fasting', other: 'Other',
};

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const colorOf = (kind) => cssVar(`--k-${kind}`) || cssVar('--k-other');
export const token = (name) => cssVar(`--${name}`);

/* Colour maths, so a second step of one hue can be computed instead of
   hard-coding two values per theme. Used only for tone ramps within a single
   hue — never to invent a new categorical slot. */

const hexToRgb = (hex) => {
  const h = String(hex).trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgbToHex = (rgb) =>
  `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

export function mixColors(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}

/** A second step of the same hue: lighter in dark mode, deeper in light mode,
 *  so it stays legible against whichever surface is behind it. */
export const stepTowardInk = (hex, t = 0.5) => mixColors(hex, cssVar('--ink') || '#ffffff', t);

/** Order an arbitrary set of kinds into palette-slot order. */
export const orderKinds = (list) =>
  KINDS.filter((k) => list.includes(k)).concat(list.filter((k) => !KINDS.includes(k)));

/* ── dates ───────────────────────────────────────────────────────────────── */

/** Local-calendar ISO date. Never toISOString() — that shifts across the UTC
 *  boundary and quietly moves a day in half the world's timezones. */
export function isoOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const dateOf = (iso) => new Date(`${iso}T00:00:00`);

export function addDays(iso, n) {
  const d = dateOf(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

export const todayISO = () => isoOf(new Date());

/* `demojibake()` used to live here: four exact rewrites repairing server prose
   whose em-dashes and middle dots arrived as UTF-8 read as latin-1. The source
   is clean — every string field on ten endpoints was swept and the only
   non-ASCII left is the intended U+2013, U+2014 and U+00B7, served as valid
   UTF-8 — so the plaster is gone and its fourteen call sites print the server's
   text verbatim. It is not worth reviving: it rewrote byte patterns in prose
   the user can type, and the scraper (the one path ingesting outside text)
   decodes UTF-8 explicitly, so the pattern cannot re-enter that way either. */

/** Monday-based week start. */
export function weekStart(iso) {
  const d = dateOf(iso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoOf(d);
}

/* ── formatting ──────────────────────────────────────────────────────────── */

const nf = (opts) => new Intl.NumberFormat(undefined, opts);
const f0 = nf({ maximumFractionDigits: 0 });
const f1 = nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 });
const f2 = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ── weight units ────────────────────────────────────────────────────────── */

/* The notebook is in pounds and so is the user's head; Garmin and the database
   are in kilograms. Rather than pick a winner, everything is stored and sent in
   kg and displayed in whichever unit is set, with the other one alongside it
   wherever there is room. Pounds is the default because that is the unit the
   record was written in. */

const KG_PER_LB = 0.45359237;
export const kgToLb = (kg) => (kg == null ? null : kg / KG_PER_LB);
export const lbToKg = (lb) => (lb == null ? null : lb * KG_PER_LB);

const UNIT_KEY = 'ledger.weightUnit';
let weightUnit = 'lb';
try {
  const saved = localStorage.getItem(UNIT_KEY);
  if (saved === 'kg' || saved === 'lb') weightUnit = saved;
} catch { /* private mode */ }

export const getWeightUnit = () => weightUnit;
export function setWeightUnit(unit) {
  weightUnit = unit === 'kg' ? 'kg' : 'lb';
  try { localStorage.setItem(UNIT_KEY, weightUnit); } catch { /* ignore */ }
  return weightUnit;
}
export const toggleWeightUnit = () => setWeightUnit(weightUnit === 'kg' ? 'lb' : 'kg');

/** kg in → a number in the display unit. */
export const inUnit = (kg, unit = weightUnit) => (kg == null ? null : (unit === 'kg' ? kg : kgToLb(kg)));

export const fmt = {
  int: (n) => (n == null ? '—' : f0.format(Math.round(n))),

  /* The whole part, nothing else. A scale reading 210.9 is 210 — rounding it
     to 211 shows a number the scale never displayed, which for the one figure
     the user checks against a physical device is the wrong kind of clever.
     Truncation toward zero, so a negative change loses its fraction the same
     way a positive one does. */
  whole: (n) => (n == null ? '—' : f0.format(Math.trunc(n))),
  wholeSigned: (n) => (n == null ? '—'
    : `${n > 0 ? '+' : n < 0 ? '−' : ''}${f0.format(Math.abs(Math.trunc(n)))}`),
  one: (n) => (n == null ? '—' : f1.format(n)),
  two: (n) => (n == null ? '—' : f2.format(n)),

  /** 1,284 · 12.9k · 1.4M — for axis ticks and direct labels. */
  compact(n) {
    if (n == null) return '—';
    const a = Math.abs(n);
    if (a >= 1e6) return `${f1.format(n / 1e6).replace(/\.0$/, '')}M`;
    if (a >= 1e4) return `${f1.format(n / 1e3).replace(/\.0$/, '')}k`;
    return f0.format(Math.round(n));
  },

  km: (n) => (n == null ? '—' : `${f2.format(n)} km`),
  pct: (n) => (n == null ? '—' : `${Math.round(n)}%`),

  mins(n) {
    if (n == null) return '—';
    const m = Math.round(n);
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
  },

  clock(min) {
    if (min == null) return '—';
    const s = Math.round(min * 60);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  },

  pace: (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}/km` : '—'),

  signed: (n, u = '', dp = 1) =>
    (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${(Math.abs(n)).toFixed(dp)}${u}`),

  date: (iso) => dateOf(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  dateY: (iso) => dateOf(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
  weekday: (iso) => dateOf(iso).toLocaleDateString(undefined, { weekday: 'long' }),
  /* The weekday is not decoration here: Monday is coed, Tuesday is pickup,
     Thursday is men's league (Wednesday, before the Fall 2026 venue move).
     It gets shown next to every date in the app. */
  dow: (iso) => dateOf(iso).toLocaleDateString(undefined, { weekday: 'short' }),
  dowDate: (iso) => dateOf(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
  /** "Sun 9 Aug, 19:42" — for stamping when something was computed. */
  stamp: (d = new Date()) => `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
  weekdayShort: (iso) => dateOf(iso).toLocaleDateString(undefined, { weekday: 'short' }),
  month: (iso) => dateOf(iso).toLocaleDateString(undefined, { month: 'short' }),
  /* Full year, not two digits. "Aug 26" is ambiguous on a page that also
     prints day-of-month everywhere — it reads as the 26th of August at least
     as readily as August 2026. The extra two characters cost an axis nothing
     and remove the question. */
  monthYear: (ym) => dateOf(`${ym}-01`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),

  /** "3 days ago" / "in 2 weeks" — relative but never vague. */
  relDays(iso, from = todayISO()) {
    const days = Math.round((dateOf(iso) - dateOf(from)) / 86400000);
    if (days === 0) return 'today';
    if (days === -1) return 'yesterday';
    if (days === 1) return 'tomorrow';
    if (Math.abs(days) < 14) return days < 0 ? `${-days} days ago` : `in ${days} days`;
    const w = Math.round(days / 7);
    return w < 0 ? `${-w} weeks ago` : `in ${w} weeks`;
  },
};

/** Period label for a trends point: "2026-08-03" (week) or "2026-08" (month). */
export const periodLabel = (period, grain) =>
  (grain === 'month' ? fmt.monthYear(period) : fmt.date(period));

/* ── network ─────────────────────────────────────────────────────────────── */

/**
 * Never throws. Returns {ok, status, data, error}. Every panel decides for
 * itself what a failure looks like — one dead endpoint must not blank the page.
 *
 * A read that fails with a 5xx or a dropped connection is retried once after a
 * short pause. Reads are idempotent, the server is one small container on the
 * other side of a tailnet, and a single transient failure should not turn a
 * populated panel into an error message. Writes are never retried.
 */
export async function api(path, opts = {}) {
  const res = await request(path, opts);
  const method = (opts.method || 'GET').toUpperCase();
  if (res.ok || res.aborted || method !== 'GET') return res;
  if (res.status !== 0 && res.status < 500) return res;
  await new Promise((r) => setTimeout(r, 260));
  return request(path, opts);
}

/* Requests used to be serialised application-wide, to work around the API
 * 500ing when two landed at once. The cause was a per-request SQLite
 * connection being opened on one threadpool worker and closed on another;
 * fixed server-side, with tests/test_api_concurrency.py guarding it. Panels
 * fetch in parallel again — the retry above stays, because one transient
 * failure should still not turn a populated panel into an error message. */

async function request(path, { method = 'GET', body, signal } = {}) {
  try {
    const res = await fetch(path, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      const detail = data && typeof data.detail === 'string' ? data.detail : null;
      return { ok: false, status: res.status, data, error: detail || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, status: 0, data: null, error: 'aborted', aborted: true };
    return { ok: false, status: 0, data: null, error: 'offline' };
  }
}

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

/* ── progress bar ────────────────────────────────────────────────────────── */

let pending = 0;
export function busy(on) {
  pending = Math.max(0, pending + (on ? 1 : -1));
  const bar = document.getElementById('progress');
  if (bar) bar.toggleAttribute('data-on', pending > 0);
}

/* ── toast ───────────────────────────────────────────────────────────────── */

let toastTimer = null;
export function toast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.setAttribute('data-on', '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.removeAttribute('data-on'), 3200);
}

/* ── tooltip ─────────────────────────────────────────────────────────────── */

const tipNode = () => document.getElementById('tip');

/**
 * showTip(x, y, {title, swatch, rows:[[label, value, color]], note})
 * Content is built with textContent — chart labels can carry user text.
 */
export function showTip(x, y, spec) {
  const tip = tipNode();
  if (!tip) return;
  clear(tip);

  if (spec.title) {
    const head = el('div', { class: 'tip-t' });
    if (spec.swatch) head.append(el('i', { style: `background:${spec.swatch}` }));
    head.append(el('span', { text: spec.title }));
    tip.append(head);
  }
  for (const [label, value, color] of spec.rows || []) {
    const left = el('span', {}, [
      color ? el('i', { style: `background:${color}` }) : null,
      el('span', { text: label }),
    ]);
    tip.append(el('div', { class: 'tip-r' }, [left, el('span', { text: String(value) })]));
  }
  if (spec.note) tip.append(el('div', { class: 'tip-n', text: spec.note }));

  tip.hidden = false;
  tip.setAttribute('data-on', '');

  // Clamp inside the viewport; flip below the pointer when there is no room above.
  const r = tip.getBoundingClientRect();
  const halfW = r.width / 2 + 8;
  const left = Math.max(halfW, Math.min(window.innerWidth - halfW, x));
  const above = y - 12;
  const flip = above - r.height < 4;
  tip.style.left = `${left}px`;
  tip.style.top = `${flip ? y + 18 + r.height : above}px`;
}

export function hideTip() {
  const tip = tipNode();
  if (!tip) return;
  tip.removeAttribute('data-on');
  tip.hidden = true;
}

/** Wire hover + keyboard focus to the same readout. */
export function attachTip(node, specFn) {
  const move = (e) => showTip(e.clientX, e.clientY, specFn());
  node.addEventListener('pointerenter', move);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('focus', () => {
    const r = node.getBoundingClientRect();
    showTip(r.left + r.width / 2, r.top, specFn());
  });
  node.addEventListener('blur', hideTip);
}

/* ── misc ────────────────────────────────────────────────────────────────── */

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Sessions seen anywhere in the app, so an edit deep-link resolves without a
 *  dedicated GET /api/sessions/{id}. */
const sessionCache = new Map();
export const rememberSessions = (list) => {
  for (const s of list || []) if (s && s.id != null) sessionCache.set(String(s.id), s);
};
export const recallSession = (id) => sessionCache.get(String(id)) || null;
export const forgetSession = (id) => sessionCache.delete(String(id));

/** Bumped whenever a write lands, so views know their cached payload is stale. */
export const revision = { n: 0 };
export const bumpRevision = () => { revision.n += 1; };
