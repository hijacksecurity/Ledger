/* Service worker — offline shell, network first.
 *
 * The promise is: the app opens and renders the last data this device saw when
 * the tailnet is unreachable, which is the common case in a gym basement.
 *
 * The strategy is deliberately network-FIRST for the shell as well as the API.
 * A cache-first shell pins a returning visitor to whatever build they happened
 * to install, which looks exactly like "my changes didn't deploy" and never
 * heals on its own. So: always try the network, fall back to the cache, and
 * race the network against a short timeout so a flaky signal degrades to the
 * cached copy instead of hanging.
 *
 * Bump VERSION on every shell change.
 */

const VERSION = 'ledger-v138';
const NET_TIMEOUT_MS = 3500;

const SHELL = [
  '/', '/index.html',
  '/styles.css', '/views.css',
  '/app.js', '/core.js', '/ui.js', '/charts.js', '/dataset.js', '/insights.js',
  '/view-week.js', '/view-plan.js', '/view-trends.js', '/view-soccer.js',
  '/view-log.js', '/view-all.js', '/view-entry.js',
  '/view-insights.js', '/view-running.js', '/view-lifting.js', '/view-sync.js',
  '/view-score.js', '/score.js', '/view-calendar.js',
  '/view-habits.js', '/habits.js',
  '/view-recovery.js', '/recovery.js',
  '/manifest.json', '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // One bad path must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Network, but never hang: after NET_TIMEOUT_MS the cache wins. */
function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NET_TIMEOUT_MS);
    fetch(request).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fromNetwork(request);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
      }
      return res;
    } catch {
      const hit = await caches.match(request, { ignoreSearch: false });
      if (hit) return hit;

      // A navigation to any route still has to open: fall back to the shell.
      if (request.mode === 'navigate') {
        const shell = await caches.match('/index.html') || await caches.match('/');
        if (shell) return shell;
      }
      // Same query, older data, is better than nothing for the API.
      const loose = await caches.match(request, { ignoreSearch: true });
      if (loose) return loose;

      return new Response(
        JSON.stringify({ detail: 'offline' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }
  })());
});
