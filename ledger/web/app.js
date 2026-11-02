/* Ledger — shell: routing, theme, keyboard, service worker.
 *
 * Views are deep-linked through the URL hash so back, forward and reload all
 * do the obvious thing, including with filters applied.
 */

import {
  el, clear, $, hideTip, reducedMotion, getWeightUnit, toggleWeightUnit, toast,
} from './core.js';
import * as viewWeek from './view-week.js';
import * as viewPlan from './view-plan.js';
import * as viewTrends from './view-trends.js';
import * as viewInsights from './view-insights.js';
import * as viewRunning from './view-running.js';
import * as viewLifting from './view-lifting.js';
import * as viewSoccer from './view-soccer.js';
import * as viewLog from './view-log.js';
import * as viewAll from './view-all.js';
import * as viewEntry from './view-entry.js';
import * as viewSync from './view-sync.js';
import * as viewScore from './view-score.js';
import * as viewCalendar from './view-calendar.js';
import * as viewHabits from './view-habits.js';
import * as viewRecovery from './view-recovery.js';
import * as viewCalories from './view-calories.js';

const VIEWS = {
  week: { module: viewWeek, title: 'Week' },
  score: { module: viewScore, title: 'Scoreboard' },
  calendar: { module: viewCalendar, title: 'Calendar' },
  habits: { module: viewHabits, title: 'Habits' },
  calories: { module: viewCalories, title: 'Calories' },
  recovery: { module: viewRecovery, title: 'Recovery' },
  plan: { module: viewPlan, title: 'Plan' },
  /* The hand-written week intent, on its own route. It lived at the foot of
     #/plan behind a fold, with its own week picker — which meant one page
     carrying two tools, two controls and two windows. Same module, different
     half of it. */
  intent: { module: viewPlan, title: 'Week intent' },
  insights: { module: viewInsights, title: 'Insights' },
  trends: { module: viewTrends, title: 'Explore', group: 'history' },
  soccer: { module: viewSoccer, title: 'Soccer', group: 'sports' },
  running: { module: viewRunning, title: 'Running', group: 'sports' },
  lifting: { module: viewLifting, title: 'Lifting', group: 'sports' },
  log: { module: viewLog, title: 'Log' },
  all: { module: viewAll, title: 'All time', group: 'history' },
  sync: { module: viewSync, title: 'Sync' },
  add: { module: viewEntry, title: 'Add activity', chromeless: true },
  edit: { module: viewEntry, title: 'Edit activity', chromeless: true },
};

const ALIASES = { sleep: 'recovery', wellness: 'recovery', hrv: 'recovery', health: 'recovery', habit: 'habits', food: 'calories', kcal: 'calories', meals: 'calories', eat: 'calories', cal: 'calendar', points: 'score', level: 'score', intent: 'plan', explore: 'trends', history: 'all', sports: 'soccer', garmin: 'sync', weight: 'all', run: 'running', lift: 'lifting', '': 'week' };

const host = $('#view-host');
const main = $('#main');

let current = null;
let currentName = null;

/* ── routing ─────────────────────────────────────────────────────────────── */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathStr, queryStr] = raw.split('?');
  const parts = pathStr.split('/').filter(Boolean);
  const name = ALIASES[parts[0] || ''] || parts[0] || 'week';
  return {
    name: VIEWS[name] ? name : 'week',
    parts: [name, ...parts.slice(1)],
    query: new URLSearchParams(queryStr || ''),
  };
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function setQuery(patch) {
  const route = parseHash();
  const q = route.query;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  const path = route.parts.join('/');
  history.replaceState(null, '', `#/${path}${s ? `?${s}` : ''}`);
}

function render() {
  const route = parseHash();
  const view = VIEWS[route.name];
  const sameView = currentName === route.name && route.name !== 'edit' && route.name !== 'add';

  hideTip();

  if (current && current.destroy) current.destroy();
  clear(host);

  const section = el('section', {
    class: `view view-${route.name}${reducedMotion() || sameView ? '' : ' view-enter'}`,
    'aria-label': view.title,
  });
  host.append(section);

  document.title = route.name === 'week' ? 'Ledger' : `${view.title} · Ledger`;
  document.body.classList.toggle('chromeless', !!view.chromeless);

  currentName = route.name;
  current = view.module.mount(section, route, { navigate, setQuery }) || {};

  syncNav(route.name);
  if (!sameView) {
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
}

function syncNav(name) {
  const view = VIEWS[name] || {};
  const active = name === 'edit' ? 'log' : (view.group || name);
  for (const a of document.querySelectorAll('[data-view]')) {
    if (a.dataset.view === active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

addEventListener('hashchange', render);

/* ── theme ───────────────────────────────────────────────────────────────── */

const themeBtn = $('#theme-btn');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('ledger.theme', theme); } catch { /* private mode */ }

  const label = $('#theme-label');
  if (label) label.textContent = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  themeBtn.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';

  /* Keep the browser chrome in step; the two media-scoped tags in the markup
     only cover the un-overridden case. */
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = theme === 'light' ? '#f9f9f7' : '#111110';
  document.head.append(meta);
}

themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  /* Series colours are read from CSS custom properties at draw time, so the
     charts have to be drawn again — the palette is re-picked per theme, not
     inverted. */
  render();
});

applyTheme(document.documentElement.dataset.theme || 'dark');

/* ── weight units ────────────────────────────────────────────────────────── */

/* The record was written in pounds; the database and Garmin speak kilograms.
   One switch, applied everywhere, remembered. */
const unitsBtn = $('#units-btn');

function syncUnits() {
  const u = getWeightUnit();
  $('#units-label').textContent = u;
  $('#units-sr').textContent = u === 'lb'
    ? 'Weight shown in pounds. Switch to kilograms.'
    : 'Weight shown in kilograms. Switch to pounds.';
  unitsBtn.title = u === 'lb' ? 'Weight in pounds — switch to kg' : 'Weight in kilograms — switch to lb';
}

unitsBtn.addEventListener('click', () => {
  toggleWeightUnit();
  syncUnits();
  render();
});
syncUnits();

/* ── keyboard shortcuts panel ────────────────────────────────────────────── */

const keysPanel = $('#keys');
const keysBtn = $('#keys-btn');

function toggleKeys(force) {
  const open = force ?? keysPanel.hidden;
  keysPanel.hidden = !open;
  keysBtn.setAttribute('aria-expanded', String(open));
  if (open) $('#keys-close').focus();
  else keysBtn.focus();
}
keysBtn.addEventListener('click', () => toggleKeys());
$('#keys-close').addEventListener('click', () => toggleKeys(false));

/* ── global keys ─────────────────────────────────────────────────────────── */

const NUMBER_ROUTES = ['#/week', '#/plan', '#/insights', '#/soccer', '#/all', '#/log'];

addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t instanceof HTMLElement
    && (t.matches('input, textarea, select') || t.isContentEditable);

  if (e.key === 'Escape') {
    if (!keysPanel.hidden) { toggleKeys(false); return; }
    if (current && current.keys && current.keys(e)) return;
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === '?') { e.preventDefault(); toggleKeys(); return; }

  const n = Number(e.key);
  if (n >= 1 && n <= NUMBER_ROUTES.length) { e.preventDefault(); navigate(NUMBER_ROUTES[n - 1]); return; }

  if (e.key === 'a') { e.preventDefault(); navigate('#/add'); return; }
  if (e.key === 'd') { e.preventDefault(); themeBtn.click(); return; }
  if (e.key === 'u') { e.preventDefault(); unitsBtn.click(); return; }
  if (e.key === '/') {
    e.preventDefault();
    if (currentName !== 'log') { navigate('#/log'); setTimeout(() => current.focusSearch?.(), 60); }
    else current.focusSearch?.();
    return;
  }
  if (current && current.keys && current.keys(e)) e.preventDefault();
});

/* ── the tab bar's height is data ────────────────────────────────────────── */

/* The bar wraps onto a second row when there are more destinations than
   columns, which happened the moment Habits made nine. Everything that has to
   sit clear of it — the floating Add button, the page's bottom padding — used
   to assume one row of 3.6rem, so the button ended up sitting on top of two
   tabs and the last panel on a page ended up underneath the bar.
   Measure it instead, and publish the answer as `--tabbar-h`. */
const tabbar = $('#tabbar');

function measureTabbar() {
  /* `offsetParent` is null for ANY position:fixed element, so it cannot be
     used as the "is it on screen" test here — it reported the bar as hidden on
     a phone, where it is the whole point. The rect's own height is zero when
     the bar is display:none above the breakpoint, which is the answer wanted
     in both cases. */
  const h = tabbar ? Math.round(tabbar.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--tabbar-h', `${h}px`);
}

measureTabbar();
addEventListener('resize', measureTabbar);
/* The bar is `display:none` above the breakpoint and the fonts it is sized in
   may land after first paint, so it is measured again once both have settled.
   `ResizeObserver` keeps it right if a label ever wraps. */
if (typeof ResizeObserver !== 'undefined' && tabbar) {
  new ResizeObserver(measureTabbar).observe(tabbar);
}

/* ── connectivity ────────────────────────────────────────────────────────── */

const banner = $('#banner');

function showOffline(on) {
  banner.hidden = !on;
  if (on) {
    clear(banner);
    banner.append(
      el('b', { text: 'Offline. ' }),
      el('span', { text: 'Showing the last data this device saw. New entries cannot be saved until the connection is back.' }),
    );
  }
}
addEventListener('online', () => { showOffline(false); render(); });
addEventListener('offline', () => showOffline(true));
if (!navigator.onLine) showOffline(true);

/* ── boot ────────────────────────────────────────────────────────────────── */

if (!location.hash) history.replaceState(null, '', '#/week');
render();
main.removeAttribute('aria-busy');

/* ── build identity & self-updating service worker ───────────────────────── */

/* Bump with the service worker VERSION. Shown on the Sync page so "am I even
   looking at the new build?" is answerable without opening devtools. */
export const BUILD = 'ledger-v144';
window.__ledgerBuild = BUILD;

if ('serviceWorker' in navigator) {
  addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');

      /* A stale worker is the single most common reason a change appears not
         to have shipped. The worker calls skipWaiting() on install, so as soon
         as a NEW one takes control, reload once and land on the new build.
         The very first install also fires controllerchange — that one is not
         an update and must not reload, or every first visit flashes. */
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        window.location.reload();
      });

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('New build installed — reloading.');
          }
        });
      });

      /* Check on every route change and once an hour, so a long-lived tab in a
         gym does not sit on yesterday's code. */
      const check = () => reg.update().catch(() => {});
      addEventListener('hashchange', check);
      setInterval(check, 60 * 60 * 1000);
    } catch { /* fine without it */ }
  });
}
