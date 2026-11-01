/* Sync — Garmin state, made visible.
 *
 * The sync engine already exists in Python: `ledger sync` fetches a trailing
 * window, maps activities onto sessions, merges rather than duplicating where
 * one already covers the same slot, and writes a row to `sync_log` either way.
 * A cron sidecar runs it nightly.
 *
 * POST /api/sync, GET /api/sync-status and GET /api/sync-log all exist now, so
 * this page drives the sync directly and reports the server's own verdict. The
 * command-line fallbacks below are for when the API cannot be reached at all,
 * not for a missing feature.
 *
 * One thing genuinely cannot be done here: nothing syncs until Garmin has been
 * authenticated once, interactively, by a human who can answer an MFA prompt.
 * This app will never handle a password.
 *
 * A nightly job that fails silently is worse than no nightly job. Whatever the
 * state is, it gets said out loud here.
 */

import { el, icon, clear, api, busy, fmt, toast } from './core.js';
import {
  panel, statStrip, skeletonBlock, segmented, emptyNote as note, setTimeframe,
} from './ui.js';

const DAY_OPTIONS = [[1, 'Today'], [3, '3 days'], [7, '7 days'], [30, '30 days']];

export function mount(host) {
  const state = { days: 3, log: null, status: null, statusRes: null, running: false, polling: false };
  let alive = true;

  const pStatus = panel({ title: 'Garmin', sub: ' ', wide: true });
  const pRun = panel({ title: 'Pull latest activities', sub: 'fetches a trailing window and merges it into the record' });
  const pLog = panel({ title: 'Sync log', sub: ' ' });
  const pCal = panel({ title: 'Load calibration', sub: ' ', wide: true });
  const pHow = panel({ title: 'What a sync does', sub: 'so nothing here is a surprise', wide: true });
  const pBuild = panel({ title: 'This build', sub: 'what your browser is actually running', wide: true });

  host.append(pStatus, el('div', { class: 'grid-2' }, [pRun, pLog]), pCal, pHow, pBuild);
  skeletonBlock(150, pStatus.body);
  skeletonBlock(180, pRun.body);
  skeletonBlock(180, pLog.body);
  skeletonBlock(110, pCal.body);
  skeletonBlock(120, pHow.body);

  async function refreshState() {
    const st = await api('/api/sync-status');
    const lg = await api('/api/sync-log?limit=20');
    /* One session is enough to read the calibration block off the top of the
       response; the items are not used here. */
    const cal = await api('/api/sessions?limit=1');
    if (!alive) return;
    state.status = st.ok ? st.data : null;
    state.statusRes = st;
    state.log = lg.ok ? (lg.data.entries || lg.data.items || []) : null;
    state.cal = cal.ok ? (cal.data.calibration || null) : null;
    paint();
  }

  (async () => {
    busy(true);
    await refreshState();
    busy(false);
  })();

  function paint() {
    paintStatus();
    paintRun();
    paintLog();
    paintCalibration();
    paintHow();
    paintBuild();
  }

  /* ── load calibration ── */

  /**
   * How the app converts a session the watch never saw onto Garmin's load
   * scale, and how much evidence that conversion currently rests on.
   *
   * This belongs on the sync page rather than anywhere a number is read,
   * because it is a property of the data feeding the app rather than a finding
   * about training. It matters for one reason: the factor is refitted as the
   * sync brings in more paired sessions, so historical figures move. Seeing
   * the sample count go up is the difference between "the estimates are
   * getting better" and "why did last year's numbers change".
   */
  function paintCalibration() {
    clear(pCal.body);
    const c = state.cal;
    if (!c) {
      pCal.head.querySelector('.sub').textContent = 'Unavailable';
      pCal.body.append(note('Could not read the calibration just now.'));
      return;
    }
    const kinds = Object.entries(c.samples || {}).sort((a, b) => b[1] - a[1]);
    pCal.head.querySelector('.sub').textContent = c.fitted
      ? 'converting sessions the watch never saw onto Garmin’s scale'
      : 'not fitted yet — sessions the watch never saw keep their raw rpe × minutes figure';

    pCal.body.append(statStrip([
      {
        label: 'Paired sessions', value: fmt.int(c.total_samples || 0),
        note: 'carry both a Garmin load and an RPE — the whole basis of the fit',
      },
      {
        label: 'Overall factor', value: c.overall == null ? '—' : String(c.overall),
        note: 'rpe × minutes multiplied by this where no Garmin figure exists',
      },
      {
        label: 'Per modality', value: kinds.length ? String(Object.keys(c.by_kind || {}).length) : '0',
        note: kinds.length
          ? `${kinds.map(([k, n]) => `${k} ${n}`).join(', ')} — ${c.min_samples_for_kind} needed before a modality gets its own`
          : 'nothing paired yet',
      },
    ]));

    pCal.body.append(el('p', { class: 'sub', text:
      'Soccer and running convert very differently, so the factor is fitted per modality and pulled toward the '
      + 'overall one until a modality has enough paired sessions to stand on its own. It refits every night as the '
      + 'sync adds data, which means older figures shift as the estimate improves. That is the estimate getting '
      + 'better, not the record changing.' }));

    if ((c.total_samples || 0) < (c.min_samples_for_kind || 8)) {
      pCal.body.append(el('p', { class: 'sub', text:
        `Thin, at ${fmt.int(c.total_samples || 0)} paired session${c.total_samples === 1 ? '' : 's'}. `
        + 'Every synced activity that also carries an RPE adds one.' }));
    }
  }

  /* ── status ── */

  function paintStatus() {
    clear(pStatus.body);
    const st = state.status;

    if (st) {
      /* The server already decides healthy / stale / not_authenticated and
         supplies the next action, so this reports its verdict rather than
         inventing a second one. */
      const tone = st.running ? 'unknown'
        : st.authenticated ? (st.healthy ? 'good' : 'warning')
          : 'critical';
      const word = st.running ? 'Syncing'
        : st.state ? String(st.state).replace(/_/g, ' ') : (st.healthy ? 'Connected' : 'Attention');

      const lines = [];
      if (st.last_success) {
        lines.push(`Last successful sync ${fmt.relDays(String(st.last_success).slice(0, 10))}, at ${String(st.last_success).replace('T', ' ').slice(0, 16)}.`);
      } else {
        lines.push('No sync has ever succeeded.');
      }
      if (st.last_error && st.last_error.detail) {
        lines.push(`Last failure — ${st.last_error.endpoint || 'sync'}: ${st.last_error.detail}`);
      }
      if (st.next_scheduled) lines.push(`Next scheduled run ${String(st.next_scheduled).replace('T', ' ')}.`);
      if (st.next_action) lines.push(st.next_action);

      pStatus.head.querySelector('.sub').textContent = st.authenticated
        ? (st.healthy ? 'Connected and current' : `No success in over ${st.stale_after_hours ?? 48} hours`)
        : 'Garmin has never been authenticated';

      pStatus.body.append(statusBlock({
        tone, word,
        headline: st.authenticated
          ? (st.healthy ? 'Garmin is connected and syncing.' : 'Garmin is connected but the record is going stale.')
          : 'Garmin has never authenticated, so nothing has ever synced.',
        lines,
        command: st.authenticated ? null : 'docker compose run --rm cli ledger garmin-login',
        after: st.authenticated ? null
          : 'That step is interactive and may ask for an MFA code, so it has to be you at a terminal — this app will never handle a password.',
      }));
      return;
    }

    const entries = state.log;
    if (!entries) {
      pStatus.head.querySelector('.sub').textContent = 'State unknown — could not reach the API';
      pStatus.body.append(statusBlock({
        tone: 'unknown',
        word: 'Unknown',
        headline: 'This app cannot see the sync state.',
        lines: [
          'There is no GET /api/sync-log endpoint, so the page cannot tell you when Garmin last ran or whether it worked.',
          'Until that lands, check it from a terminal:',
        ],
        command: 'docker compose run --rm cli ledger sync-log -n 20',
      }));
      return;
    }

    const ok = entries.filter((e) => e.status === 'ok' || e.status === 'success');
    const lastOk = ok[0] || null;
    const lastErr = entries.find((e) => e.status === 'error') || null;
    const authFailed = lastErr && /login|token|auth|password/i.test(
      `${lastErr.endpoint || lastErr.operation || ''} ${lastErr.detail || lastErr.message || ''}`,
    );

    if (authFailed && !lastOk) {
      pStatus.head.querySelector('.sub').textContent = 'Never connected';
      pStatus.body.append(statusBlock({
        tone: 'critical',
        word: 'Not connected',
        headline: 'Garmin has never authenticated, so nothing has ever synced.',
        lines: [
          lastErr.detail || lastErr.message || 'The last attempt failed at login.',
          'Authentication is a one-time interactive step: it reads your credentials from .env and may ask for an MFA code. '
          + 'That has to be you at a terminal — this app will never handle a password.',
          'Set GARMIN_EMAIL and GARMIN_PASSWORD in .env, then run:',
        ],
        command: 'docker compose run --rm cli ledger garmin-login',
        after: 'Once tokens are stored, the nightly job resumes from them and this page will start reporting successes.',
      }));
      return;
    }

    if (lastOk) {
      const when = lastOk.at || lastOk.created_at || lastOk.timestamp;
      const stale = when ? (Date.now() - new Date(when).getTime()) / 86400000 : null;
      pStatus.head.querySelector('.sub').textContent = when ? `Last success ${fmt.dateY(String(when).slice(0, 10))}` : 'Connected';
      pStatus.body.append(statusBlock({
        tone: stale != null && stale > 2 ? 'warning' : 'good',
        word: stale != null && stale > 2 ? 'Stale' : 'Connected',
        headline: when
          ? `Last successful sync ${fmt.relDays(String(when).slice(0, 10))}.`
          : 'Garmin is connected.',
        lines: lastErr
          ? [`The most recent failure was: ${lastErr.detail || lastErr.message || 'unknown'}.`]
          : ['No failures in the entries returned.'],
      }));
      return;
    }

    pStatus.head.querySelector('.sub').textContent = 'No successful sync on record';
    pStatus.body.append(statusBlock({
      tone: 'warning',
      word: 'Never synced',
      headline: 'The log has entries but none of them succeeded.',
      lines: [lastErr ? (lastErr.detail || lastErr.message || 'The last attempt failed.') : 'No detail recorded.'],
      command: 'docker compose run --rm cli ledger sync --days 3',
    }));
  }

  function statusBlock({ tone, word, headline, lines, command, after }) {
    const wrap = el('div', { class: `syncstate syncstate-${tone}` });
    wrap.append(el('div', { class: 'syncstate-top' }, [
      el('span', { class: `statusdot dot-${tone}`, 'aria-hidden': 'true' }),
      el('span', { class: 'syncstate-word', text: word }),
    ]));
    wrap.append(el('p', { class: 'syncstate-head', text: headline }));
    for (const l of lines || []) wrap.append(el('p', { class: 'sub', text: l }));
    if (command) wrap.append(commandLine(command));
    if (after) wrap.append(el('p', { class: 'sub', text: after }));
    return wrap;
  }

  function commandLine(cmd) {
    const row = el('div', { class: 'cmdline' });
    const code = el('code', { text: cmd });
    const copy = el('button', { class: 'btn btn-sm', type: 'button' }, [el('span', { text: 'Copy' })]);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        toast('Command copied.');
      } catch {
        /* No clipboard permission — the text is on screen either way. */
        toast('Copy blocked by the browser — select the command instead.');
      }
    });
    row.append(code, copy);
    return row;
  }

  /* ── run ── */

  function paintRun() {
    clear(pRun.body);
    pRun.body.append(
      el('div', { class: 'field' }, [
        el('span', { class: 'lbl', text: 'Window' }),
        segmented(DAY_OPTIONS, state.days, (v) => { state.days = v; paintRun(); }, 'Trailing days'),
      ]),
    );

    const btn = el('button', {
      class: 'btn btn-primary btn-lg btn-block', type: 'button',
      disabled: state.running || state.polling || !!(state.status && state.status.running),
      text: (state.polling || (state.status && state.status.running))
        ? 'Syncing…'
        : `Sync the last ${state.days === 1 ? 'day' : `${state.days} days`}`,
    });
    btn.addEventListener('click', run);
    pRun.body.append(btn);
    pRun.body.append(el('p', { class: 'sub', text:
      'Safe to run repeatedly. An activity that already has a session covering the same slot is merged into it rather than added again, '
      + 'and anything that cannot be mapped is logged and skipped rather than guessed at.' }));
    pRun.body.append(commandLine(`docker compose run --rm cli ledger sync --days ${state.days}`));
  }

  async function run() {
    state.running = true;
    paintRun();
    busy(true);
    const res = await api(`/api/sync?days=${state.days}`, { method: 'POST' });
    busy(false);
    state.running = false;
    if (!alive) return;

    if (!res.ok) {
      paintRun();
      const why = res.status === 404
        ? 'There is no POST /api/sync endpoint on this server yet, so the app cannot start a sync itself. Run the command below instead.'
        : res.status === 0
          ? 'Could not reach the server.'
          : (res.error || 'The server refused the request.');
      pRun.body.prepend(el('div', { class: 'preview-err' }, [
        el('b', { text: 'Not started. ' }), el('span', { text: why }),
      ]));
      return;
    }

    /* The endpoint returns as soon as the job is queued — paced Garmin calls
       take tens of seconds — so follow it rather than claiming it finished. */
    toast(`Sync started for the last ${res.data && res.data.days ? res.data.days : state.days} days.`);
    await poll();
  }

  async function poll() {
    state.polling = true;
    paintRun();
    for (let i = 0; i < 60 && alive; i++) {
      await new Promise((r) => setTimeout(r, i < 5 ? 1500 : 4000));
      const st = await api('/api/sync-status');
      if (!alive) return;
      if (!st.ok) break;
      state.status = st.data;
      paintStatus();
      if (!st.data.running) break;
    }
    state.polling = false;
    const lg = await api('/api/sync-log?limit=20');
    if (!alive) return;
    if (lg.ok) state.log = lg.data.entries || lg.data.items || [];
    paintLog();
    paintRun();
    if (state.status && state.status.last_success) toast('Sync finished.');
    else if (state.status && state.status.last_error) toast('Sync finished with errors — see the log.');
  }

  /* ── log ── */

  function paintLog() {
    clear(pLog.body);
    if (!state.log) {
      pLog.head.querySelector('.sub').textContent = 'Unavailable';
      pLog.body.append(note(
        'Could not read the sync log just now. GET /api/sync-log exists — this is a '
        + 'failed request, not a missing feature. Retry, or check the container is up.',
      ));
      return;
    }
    if (!state.log.length) {
      pLog.head.querySelector('.sub').textContent = 'Empty';
      pLog.body.append(note('Nothing has been attempted yet.'));
      return;
    }
    pLog.head.querySelector('.sub').textContent = `${state.log.length} most recent`;
    /* The log does have a period — the one its own rows span — and saying so
       is the difference between "the last few runs" and "nothing since
       Tuesday". `/api/sync-log` publishes no timeframe of its own, so this is
       read off the stamps on the rows being displayed and nothing else. */
    const stamps = state.log
      .map((e) => String(e.at || e.created_at || e.timestamp || '').slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    setTimeframe(pLog, stamps.length
      ? `${state.log.length} most recent runs · ${
        stamps[0] === stamps[stamps.length - 1]
          ? fmt.dateY(stamps[0])
          : `${fmt.date(stamps[0])} to ${fmt.dateY(stamps[stamps.length - 1])}`}`
      : null);
    const wrap = el('div', { class: 'table-wrap scroll' });
    const table = el('table', { class: 'data-table' });
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'When' }),
      el('th', { scope: 'col', text: 'Operation' }),
      el('th', { scope: 'col', text: 'Status' }),
      el('th', { scope: 'col', class: 'wrap', text: 'Detail' }),
    ])]));
    const body = el('tbody');
    for (const e of state.log) {
      const status = e.status || 'unknown';
      const good = status === 'ok' || status === 'success';
      body.append(el('tr', {}, [
        el('th', { scope: 'row', class: 'nowrap', text: String(e.at || e.created_at || e.timestamp || '').replace('T', ' ').slice(0, 16) }),
        el('td', { text: e.endpoint || e.operation || e.op || '—' }),
        el('td', {}, [
          el('span', { class: `statusdot dot-${good ? 'good' : 'critical'}`, 'aria-hidden': 'true' }),
          el('span', { text: status }),
        ]),
        el('td', { class: 'wrap', text: e.detail || e.message || '' }),
      ]));
    }
    table.append(body);
    wrap.append(table);
    pLog.body.append(wrap);
  }

  /* ── how ── */

  async function paintBuild() {
    clear(pBuild.body);
    const build = window.__ledgerBuild || 'unknown';
    let swState = 'not registered';
    let cached = [];
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        swState = reg.active ? 'active' : reg.installing ? 'installing' : reg.waiting ? 'waiting' : 'registered';
      }
      if (window.caches) cached = await caches.keys();
    } catch { /* nothing to report */ }

    pBuild.body.append(statStrip([
      { label: 'Build', value: build, note: 'bumped whenever the shell changes' },
      { label: 'Service worker', value: swState, note: 'network-first; cache is only a fallback' },
      {
        label: 'Caches held', value: String(cached.length),
        note: cached.length ? cached.join(', ') : 'none',
      },
    ]));

    const stale = cached.filter((c) => c !== build);
    if (stale.length) {
      pBuild.body.append(el('p', { class: 'sub', text:
        `${stale.length} cache from an older build is still on disk (${stale.join(', ')}). It is deleted automatically when the new worker activates.` }));
    }

    const hard = el('button', { class: 'btn', type: 'button' }, [
      icon('sync'), el('span', { text: 'Force update and reload' }),
    ]);
    hard.addEventListener('click', async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.unregister();
        if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
      } catch { /* best effort */ }
      window.location.reload();
    });
    pBuild.body.append(el('div', { class: 'danger-row' }, [hard]));
    pBuild.body.append(el('p', { class: 'sub', text:
      'The app updates itself: a new worker takes over and reloads the page on its own. This button is the escape hatch if a browser ever gets stuck on an old build.' }));
  }

  function paintHow() {
    clear(pHow.body);
    const ul = el('ul', { class: 'readout' });
    for (const line of [
      'Fetches every Garmin activity in the trailing window you pick, newest included.',
      'Maps each one onto a modality. A Garmin activity that overlaps a session you already logged is merged into it — distance, duration and pace fill in, your notes and RPE are left alone.',
      'Never overwrites an RPE. Load stays yours: Garmin does not know how hard a soccer game felt, which is the entire reason this app exists.',
      'Anything it cannot map is written to the sync log and skipped. It is never guessed at.',
      'Bodyweight, resting HR, HRV and sleep come across for the same days where Garmin has them.',
      'Rate-limited and idempotent, so running it twice in a row costs you nothing.',
    ]) ul.append(el('li', {}, [el('span', { text: line })]));
    pHow.body.append(ul);
    pHow.body.append(el('p', { class: 'sub', text:
      `A cron sidecar already runs this nightly at ${'{LEDGER_CRON_HOUR}'}:00 local. This page exists so that when it fails, you find out here rather than by noticing a missing run three weeks later.`
        .replace('{LEDGER_CRON_HOUR}', '3') }));
  }

  return { destroy() { alive = false; } };
}

