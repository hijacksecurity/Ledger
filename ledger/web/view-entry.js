/* Add / edit an activity.
 *
 * Garmin sync is not connected, so this is the only way anything gets into the
 * record. It is a route, not a dialog — the notebook did not have a modal and
 * neither does this. Two paths converge on one ingest:
 *
 *   Tap   — modality first, then only the fields that modality needs. Every
 *           tap also rewrites the shorthand line shown at the bottom, so the
 *           fast path teaches the faster one.
 *   Text  — the notebook shorthand, parsed live by the server. Nothing is
 *           committed until it has been rendered back.
 *
 * RPE is one tap on a 0–10 scale because the entire unified-load feature
 * depends on it being captured, not on it being captured elegantly.
 */

import {
  el, icon, clear, api, fmt, colorOf, KINDS, todayISO, addDays, debounce,
  toast, busy, recallSession, rememberSessions, forgetSession, bumpRevision,
} from './core.js';
import { panel, emptyNote, kindName, sessionRow, dowBadge } from './ui.js';
import {
  invalidate, TEAMS, resolveTeam, teamLabel,
  quickAddPresets, saveCustomPreset, sessionsIn,
} from './dataset.js';

const LAST_KEY = 'ledger.last';
const DRAFT_KEY = 'ledger.draft';

const FIELDS = {
  soccer: ['team', 'result', 'score', 'ga2', 'distance', 'duration', 'rpe'],
  run: ['distance', 'elapsed', 'compliance', 'rpe'],
  quickfeet: ['distance', 'duration', 'rpe'],
  stairs: ['distance', 'duration', 'rpe'],
  bike: ['distance', 'duration', 'rpe'],
  lift: ['duration', 'rpe'],
  /* `ab` had no entry at all. `buildFields` falls back to ['duration','rpe']
     for an unknown kind but `buildRpe` falls back to [], so an ab session
     rendered its duration and silently no RPE control — the one field the
     watch cannot supply, unreachable on the only kind that needs it typed. */
  ab: ['duration', 'rpe'],
  ruck: ['ruckload', 'distance', 'elapsed', 'rpe'],
  fast: ['hours'],
  other: ['duration', 'distance', 'rpe'],
};

const RPE_ANCHOR = {
  0: 'nothing', 1: 'very easy', 2: 'easy', 3: 'moderate', 4: 'somewhat hard',
  5: 'hard', 6: 'hard', 7: 'very hard', 8: 'very hard', 9: 'very hard',
  10: 'maximal',
};

export function mount(host, route, { navigate }) {
  const editingId = route.name === 'edit' ? route.parts[1] : null;
  const state = {
    mode: 'tap',
    kind: null,
    date: todayISO(),
    result: null,
    gf: null, ga: null, goals: null, assists: null,
    duration: null, distance: null, elapsed: '', compliance: null,
    ruckload: null, hours: null, rpe: null, notes: '',
    team: null, teamSource: 'weekday',
    keptDetail: {}, pace: null,
    text: '',
    saving: false,
    session: null,
  };

  let alive = true;
  document.body.classList.add('entry-open');

  /* ── frame ── */

  const top = el('div', { class: 'entry-top' }, [
    el('button', {
      class: 'btn btn-quiet', type: 'button', text: 'Cancel',
      on: { click: () => leave() },
    }),
    el('h1', { class: 'entry-title', text: editingId ? 'Edit activity' : 'Add activity' }),
    el('div', { class: 'entry-top-right' }),
  ]);

  const modeSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Entry mode' });
  const bTap = el('button', { type: 'button', text: 'Tap', 'aria-pressed': 'true' });
  const bText = el('button', { type: 'button', text: 'Text', 'aria-pressed': 'false' });
  modeSeg.append(bTap, bText);
  if (!editingId) top.querySelector('.entry-top-right').append(modeSeg);

  const form = el('form', { class: 'entry', novalidate: true });
  const tapPane = el('div', { class: 'entry-pane' });
  const textPane = el('div', { class: 'entry-pane', hidden: true });
  const previewHost = el('div', { class: 'preview' });
  const actions = el('div', { class: 'entry-actions' });
  const resultHost = el('div');

  form.append(tapPane, textPane, previewHost, actions);
  host.append(top, form, resultHost);

  /* ── tap pane ── */

  const quickHost = el('div', { class: 'entry-block quickblock' });

  const kindHost = el('fieldset', { class: 'entry-block' }, [
    el('legend', { class: 'lbl', text: 'Modality' }),
  ]);
  const kindGrid = el('div', { class: 'kindgrid', role: 'radiogroup', 'aria-label': 'Modality' });
  kindHost.append(kindGrid);

  const dateHost = el('div', { class: 'entry-block' });
  const fieldHost = el('div', { class: 'entry-block entry-fields' });
  const rpeHost = el('div', { class: 'entry-block' });
  const notesHost = el('div', { class: 'entry-block' });
  const shorthandHost = el('div', { class: 'shorthand' });

  tapPane.append(quickHost, kindHost, dateHost, fieldHost, rpeHost, notesHost, shorthandHost);

  for (const k of KINDS) {
    const id = `kind-${k}`;
    const input = el('input', {
      type: 'radio', name: 'kind', id, value: k, class: 'vh',
      on: { change: () => setKind(k) },
    });
    kindGrid.append(el('div', { class: 'kindopt' }, [
      input,
      el('label', { for: id }, [
        el('i', { style: `background:${colorOf(k)}` }),
        el('span', { text: kindName(k) }),
      ]),
    ]));
  }

  /* date */
  const dateInput = el('input', {
    class: 'input', type: 'date', id: 'entry-date', value: state.date, max: todayISO(),
    on: { change: () => { state.date = dateInput.value || todayISO(); dateChanged(); } },
  });
  const dateChips = el('div', { class: 'chip-row' });
  const chipDefs = [['Today', () => todayISO()], ['Yesterday', () => addDays(todayISO(), -1)]];
  const chipNodes = chipDefs.map(([label, fn]) => el('button', {
    class: 'chip', type: 'button', text: label,
    on: { click: () => { state.date = fn(); dateInput.value = state.date; dateChanged(); } },
  }));
  dateChips.append(...chipNodes);

  /* The fixture picker reads the weekday, and the weekday rule is dated
     (MENS_ON_THURSDAY_FROM) — so a date edit has to rebuild it, or the chip
     and its "from the weekday" hint stay at whatever date was current when
     the modality was picked. Fields render from `state`, so nothing typed is
     lost by rebuilding. */
  function dateChanged() {
    syncDateChips();
    if (((FIELDS[state.kind] || []).includes('team'))) buildFields();
    refresh();
  }
  const dowHost = el('span', { class: 'dow-live' });
  dateHost.append(
    el('label', { class: 'lbl', for: 'entry-date', text: 'Date' }),
    el('div', { class: 'row-wrap' }, [dateChips, dateInput, dowHost]),
  );
  const syncDateChips = () => {
    chipNodes.forEach((n, i) => n.setAttribute('aria-pressed', String(chipDefs[i][1]() === state.date)));
    clear(dowHost);
    if (state.date) dowHost.append(dowBadge(state.date));
  };
  syncDateChips();

  /* notes */
  const notesInput = el('input', {
    class: 'input', type: 'text', id: 'entry-notes', maxlength: '200',
    placeholder: 'e.g. mon game, walk/run, 5K w/ strides',
    on: { input: () => { state.notes = notesInput.value; refreshSoon(); } },
  });
  notesHost.append(el('label', { class: 'lbl', for: 'entry-notes', text: 'Notes' }), notesInput);

  /* ── text pane ── */

  const textArea = el('textarea', {
    class: 'input', id: 'entry-text', spellcheck: 'false', autocapitalize: 'off',
    placeholder: `${todayISO()} soccer W7:4 3g0a 60min rpe=9 "mon game"`,
    'aria-describedby': 'entry-help',
    on: { input: () => { state.text = textArea.value; saveDraft(); refreshSoon(); } },
  });
  const help = el('details', { class: 'help', id: 'entry-help' }, [
    el('summary', { text: 'Shorthand reference' }),
    el('div', { class: 'help-body' }),
  ]);
  const helpBody = help.querySelector('.help-body');
  for (const [tok, meaning] of [
    ['2026-08-09 soccer', 'date then modality — starts a line'],
    ['W7:4', 'result and scoreline'],
    ['3g0a', 'goals and assists'],
    ['5.43km / 3.1mi', 'distance'],
    ['39:10 / 1:08:11', 'elapsed time'],
    ['60min', 'duration'],
    ['rpe=9', 'session RPE, 0–10'],
    ['z1=76 z2=23', 'HR zone split'],
    ['77%', 'coach compliance'],
    ['16.5lb', 'ruck load'],
    ['72hr', 'fast length'],
    ['@18:30', 'start time'],
    ['"notes here"', 'free text'],
  ]) {
    helpBody.append(el('div', { class: 'help-row' }, [
      el('code', { text: tok }), el('span', { text: meaning }),
    ]));
  }
  textPane.append(
    el('label', { class: 'lbl', for: 'entry-text', text: 'Notebook shorthand — one activity per line' }),
    textArea, help,
  );

  /* ── quick add ── */

  async function buildQuick() {
    clear(quickHost);
    if (editingId) return;
    const res = await sessionsIn({});
    if (!alive) return;
    const presets = quickAddPresets(res.ok ? res.items : [], { today: todayISO() });
    if (!presets.length) return;

    const row = el('div', { class: 'chip-row' });
    for (const p of presets) {
      const chip = el('button', {
        class: 'chip quickchip', type: 'button',
        title: p.sub || '', 'aria-label': `Quick add: ${p.label}`,
        on: { click: () => applyPreset(p) },
      }, [
        el('i', { class: 'swatch', style: `background:${colorOf(p.kind)}` }),
        el('span', { text: p.label }),
        p.duration ? el('b', { text: `${p.duration}m` }) : null,
      ]);
      row.append(chip);
    }
    quickHost.append(
      el('div', { class: 'quickhead' }, [
        el('span', { class: 'lbl', text: 'Quick add' }),
        document.createTextNode(' '),
        el('span', { class: 'muted', text: 'one tap fills the form — check it, then save' }),
      ]),
      row,
    );
  }

  function applyPreset(p) {
    state.kind = p.kind;
    state.notes = p.notes || '';
    state.duration = p.duration ?? null;
    state.rpe = p.rpe ?? null;
    state.distance = null;
    state.pace = null;
    state.keptDetail = {};
    state.elapsed = '';
    state.result = null;
    state.gf = null; state.ga = null; state.goals = null; state.assists = null;
    notesInput.value = state.notes;
    const radio = kindGrid.querySelector(`#kind-${p.kind}`);
    if (radio) radio.checked = true;
    buildFields();
    buildRpe();
    refresh();
    toast(`${p.label} — check the card, then save.`);
  }

  /* ── mode switch ── */

  const setMode = (mode) => {
    state.mode = mode;
    bTap.setAttribute('aria-pressed', String(mode === 'tap'));
    bText.setAttribute('aria-pressed', String(mode === 'text'));
    tapPane.hidden = mode !== 'tap';
    textPane.hidden = mode === 'tap';
    if (mode === 'text' && !state.text && state.kind) {
      state.text = composeShorthand(state);
      textArea.value = state.text;
    }
    refresh();
    (mode === 'text' ? textArea : kindGrid.querySelector('input')).focus?.();
  };
  bTap.addEventListener('click', () => setMode('tap'));
  bText.addEventListener('click', () => setMode('text'));

  /* ── dynamic fields ── */

  function setKind(kind) {
    state.kind = kind;
    const last = readLast(kind);
    if (state.duration == null && last.duration != null) state.duration = last.duration;
    if (state.rpe == null && last.rpe != null) state.rpe = last.rpe;
    if (kind === 'fast' && state.hours == null) state.hours = last.hours ?? 24;
    buildFields();
    buildRpe();
    refresh();
  }

  function buildFields() {
    clear(fieldHost);
    if (!state.kind) {
      fieldHost.append(emptyNote('Pick a modality to see its fields.'));
      return;
    }
    const wanted = FIELDS[state.kind] || ['duration', 'rpe'];
    for (const f of wanted) {
      if (f === 'rpe') continue;
      const node = FIELD_BUILDERS[f] && FIELD_BUILDERS[f](state, refreshSoon, refresh);
      if (node) fieldHost.append(node);
    }
  }

  function buildRpe() {
    clear(rpeHost);
    if (!state.kind || !(FIELDS[state.kind] || []).includes('rpe')) return;

    const scale = el('div', { class: 'rpe', role: 'radiogroup', 'aria-label': 'Session RPE, 0 to 10' });
    for (let r = 0; r <= 10; r++) {
      const id = `rpe-${r}`;
      const input = el('input', {
        type: 'radio', name: 'rpe', id, value: r, class: 'vh',
        checked: state.rpe === r,
        on: { change: () => { state.rpe = r; syncRpeCaption(); refresh(); } },
      });
      scale.append(el('div', { class: 'rpeopt' }, [
        input, el('label', { for: id, text: String(r) }),
      ]));
    }
    const caption = el('p', { class: 'rpe-cap' });
    rpeHost.append(
      el('div', { class: 'rpe-head' }, [
        el('span', { class: 'lbl', text: 'Session RPE' }),
        el('span', { class: 'muted', text: 'how hard, 0–10' }),
      ]),
      scale,
      el('div', { class: 'rpe-ends' }, [
        el('span', { text: 'rest' }), el('span', { text: 'maximal' }),
      ]),
      caption,
    );
    rpeHost.caption = caption;
    syncRpeCaption();
  }

  function syncRpeCaption() {
    const cap = rpeHost.caption;
    if (!cap) return;
    cap.textContent = state.rpe == null
      ? 'Without an RPE this session is saved unscored and carries no load.'
      : `RPE ${state.rpe} — ${RPE_ANCHOR[state.rpe]}. Where no watch recorded this, it is what the load is built from.`;
  }

  /* ── preview ── */

  const refreshSoon = debounce(() => refresh(), 260);

  async function refresh() {
    const text = state.mode === 'text' ? state.text : composeShorthand(state);
    clear(shorthandHost);
    if (state.mode === 'tap' && state.kind) {
      shorthandHost.append(
        el('span', { class: 'lbl', text: 'Saves as' }),
        el('code', { text: text }),
      );
    }
    buildActions();

    if (!text.trim()) { renderPreview(null); return; }
    const res = await api('/api/parse', { method: 'POST', body: { text } });
    if (!alive) return;
    if (!res.ok) { renderPreview({ error: `Preview unavailable (${res.error}).`, sessions: [] }); return; }
    renderPreview(res.data);
  }

  let previewData = null;
  function renderPreview(d) {
    previewData = d;
    clear(previewHost);
    if (!d) {
      previewHost.append(el('p', { class: 'empty', text:
        editingId ? 'Change a field to preview the edit.' : 'Nothing to save yet.' }));
      buildActions();
      return;
    }
    if (d.error) {
      previewHost.append(el('div', { class: 'preview-err' }, [
        el('b', { text: 'Not parsed. ' }), el('span', { text: d.error }),
      ]));
      buildActions();
      return;
    }
    const sessions = d.sessions || [];
    if (!sessions.length) {
      previewHost.append(el('p', { class: 'empty', text: 'Nothing recognised yet.' }));
      buildActions();
      return;
    }

    previewHost.append(el('div', { class: 'preview-head' }, [
      el('span', { class: 'lbl', text: editingId ? 'After saving' : 'Will be saved' }),
      el('span', { class: 'muted', text: `${sessions.length} ${sessions.length === 1 ? 'activity' : 'activities'}` }),
    ]));
    for (const s of sessions) previewHost.append(previewCard(s));
    if ((d.weeks || []).length) {
      previewHost.append(el('p', { class: 'sub', text:
        `${d.weeks.length} week header${d.weeks.length === 1 ? '' : 's'} will also be recorded.` }));
    }
    buildActions();
  }

  function previewCard(s) {
    const dt = s.detail || {};
    const rows = [];
    if (dt.result || dt.gf != null) rows.push(['Result', `${dt.result || '—'} ${dt.gf ?? ''}${dt.gf != null ? `–${dt.ga}` : ''}`]);
    if (dt.goals != null) rows.push(['Goals / assists', `${dt.goals}G ${dt.assists ?? 0}A`]);
    if (s.distance_km) rows.push(['Distance', fmt.km(s.distance_km)]);
    if (s.duration_min) {
      rows.push(['Duration', s.distance_km
        ? fmt.clock(s.duration_min) : fmt.mins(s.duration_min)]);
    }
    if (s.pace_s_per_km) rows.push(['Pace', fmt.pace(s.pace_s_per_km)]);
    if (dt.load_lbs != null) rows.push(['Ruck load', `${dt.load_lbs} lb`]);
    if (dt.hours != null) rows.push(['Fast', `${dt.hours} hr`]);
    if (dt.compliance_pct != null) rows.push(['To plan', `${dt.compliance_pct}%`]);
    if (dt.zones) rows.push(['Zones', Object.entries(dt.zones).map(([z, v]) => `${z.toUpperCase()} ${v}%`).join(' ')]);
    if (s.rpe != null) rows.push(['RPE', String(s.rpe)]);
    if (s.started_at) rows.push(['Started', s.started_at]);
    if (s.notes) rows.push(['Notes', s.notes]);

    return el('div', { class: 'pcard' }, [
      el('div', { class: 'pcard-head' }, [
        el('i', { style: `background:${colorOf(s.kind)}` }),
        el('b', { text: kindName(s.kind) }),
        el('span', { class: 'muted', text: fmt.dateY(s.date) }),
        el('span', { class: 'pcard-load num', text: s.load ? `${fmt.int(s.load)} AU` : 'unscored' }),
      ]),
      el('dl', { class: 'pcard-rows' }, rows.flatMap(([k, v]) => [
        el('dt', { text: k }), el('dd', { text: v }),
      ])),
    ]);
  }

  /* ── actions ── */

  function buildActions() {
    clear(actions);
    const ready = !!(previewData && !previewData.error && (previewData.sessions || []).length);
    const save = el('button', {
      class: 'btn btn-primary btn-lg btn-block', type: 'submit',
      disabled: !ready || state.saving,
      text: state.saving ? 'Saving…' : editingId ? 'Save changes' : 'Save activity',
    });
    /* A field that will not be saved has to be said before the button, not
       discovered afterwards on a page that already said "Saved". */
    const gap = state.mode === 'tap' ? scorelineGap(state) : null;
    if (gap) {
      actions.append(el('div', { class: 'preview-err', role: 'status' }, [
        el('b', { text: 'Incomplete scoreline. ' }), el('span', { text: gap }),
      ]));
    }
    actions.append(save);

    if (editingId) {
      actions.append(deleteControl());
    } else {
      actions.append(el('p', { class: 'entry-hint', text:
        ready ? 'Check the card above — that is exactly what lands in the record.'
          : 'Pick a modality, then fill what that modality needs.' }));
      if (ready && state.mode === 'tap' && state.notes.trim()) {
        const pin = el('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: 'Save as a quick add' });
        pin.addEventListener('click', () => {
          const label = state.notes.trim().replace(/^./, (c) => c.toUpperCase());
          const ok = saveCustomPreset({
            key: `custom:${state.kind}:${label.toLowerCase()}`,
            label, kind: state.kind, notes: state.notes.trim(),
            duration: state.duration ?? null, rpe: state.rpe ?? null, sub: 'saved by you',
          });
          toast(ok ? `"${label}" added to quick add.` : 'Could not save — storage unavailable.');
          buildQuick();
        });
        actions.append(el('div', { class: 'danger-row' }, [pin]));
      }
    }
  }

  function deleteControl() {
    const wrap = el('div', { class: 'danger-row' });
    const armed = el('span', { class: 'muted', hidden: true, text: 'This cannot be undone.' });
    const btn = el('button', { class: 'btn btn-danger', type: 'button' }, [
      icon('trash'), el('span', { text: 'Delete' }),
    ]);
    let arm = false;
    btn.addEventListener('click', async () => {
      if (!arm) {
        arm = true;
        btn.querySelector('span').textContent = 'Confirm delete';
        armed.hidden = false;
        return;
      }
      busy(true);
      const res = await api(`/api/sessions/${editingId}`, { method: 'DELETE' });
      busy(false);
      if (!res.ok) { toast(`Not deleted — ${res.error}.`); return; }
      forgetSession(editingId);
      invalidate();
      bumpRevision();
      toast('Deleted.');
      navigate('#/log');
    });
    wrap.append(btn, armed);
    return wrap;
  }

  /* ── submit ── */

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.saving) return;
    state.saving = true;
    buildActions();
    busy(true);

    const res = editingId ? await savePatch() : await savePost();

    busy(false);
    state.saving = false;
    if (!alive) return;

    if (!res.ok) {
      buildActions();
      const why = res.status === 0
        ? 'No connection — nothing was saved. Your entry is kept here.'
        : `Not saved — ${res.error}`;
      previewHost.prepend(el('div', { class: 'preview-err' }, [
        el('b', { text: 'Save failed. ' }), el('span', { text: why }),
      ]));
      toast('Not saved.');
      return;
    }

    clearDraft();
    invalidate();
    bumpRevision();
    /* Remember what this modality usually looks like, so the next entry of the
       same kind opens already mostly filled in. */
    const saved0 = res.data.session;
    if (saved0 && saved0.kind) {
      writeLast(saved0.kind, {
        duration: saved0.duration_min == null ? null : round1(saved0.duration_min),
        rpe: saved0.rpe == null ? null : Math.round(saved0.rpe),
        hours: (saved0.detail || {}).hours ?? null,
      });
    }
    if (editingId) {
      rememberSessions([res.data.session]);
      toast('Saved.');
      navigate('#/log');
      return;
    }
    showSaved(res.data);
  });

  async function savePost() {
    const text = state.mode === 'text' ? state.text : composeShorthand(state);
    const res = await api('/api/sessions', { method: 'POST', body: { text } });
    if (!res.ok) return res;

    /* The shorthand grammar has no fixture token (see NOTES-FOR-BACKEND.md), so
       an explicit override is written onto the saved session afterwards. If
       that second call fails the session still exists — say so rather than
       pretending the whole save failed. */
    const saved = res.data && res.data.session;
    if (state.mode === 'tap' && state.team && saved && saved.kind === 'soccer') {
      const patched = await api(`/api/sessions/${saved.id}`, {
        method: 'PATCH',
        body: { detail: { ...(saved.detail || {}), team: state.team } },
      });
      if (patched.ok && patched.data.session) res.data.session = patched.data.session;
      else toast('Saved, but the fixture could not be attached.');
    }
    return res;
  }

  async function savePatch() {
    const parsed = (previewData && previewData.sessions && previewData.sessions[0]) || null;
    if (!parsed) return { ok: false, status: 0, error: 'nothing to save' };
    return api(`/api/sessions/${editingId}`, {
      method: 'PATCH',
      body: {
        date: parsed.date,
        kind: parsed.kind,
        rpe: parsed.rpe,
        duration_min: parsed.duration_min,
        /* A field the form does not render is a field the form must not
           erase. `PATCH` replaces the row from the parsed shorthand, so a kind
           with no distance control sent `distance_km: null` and wiped whatever
           the watch had measured. Soccer was the live case — a 0.52 km match
           came back empty for touching its score — and lift, ab and fast sit
           on the same trapdoor the day one of them arrives with a distance. */
        distance_km: managesDistance() ? parsed.distance_km : state.distance,
        pace_s_per_km: managesDistance() ? parsed.pace_s_per_km : state.pace,
        started_at: parsed.started_at,
        notes: parsed.notes,
        detail: {
          /* Preserved keys first, so anything the form does own still wins. */
          ...(state.keptDetail || {}),
          ...(parsed.detail || {}),
          ...(state.team ? { team: state.team } : {}),
        },
      },
    });
  }

  function showSaved(data) {
    form.hidden = true;
    top.querySelector('.entry-title').textContent = 'Saved';
    clear(resultHost);

    const saved = data.session;
    const prs = data.prs || [];
    if (saved) rememberSessions([saved]);

    const card = panel({ title: 'Added to the record' });
    if (saved) card.body.append(sessionRow(saved, { showDate: true }));
    const ids = data.session_ids || [];
    if (ids.length > 1) {
      card.body.append(el('p', { class: 'sub', text: `${ids.length} activities saved.` }));
    }

    const prCard = panel({ title: 'Personal bests' });
    if (!prs.length) {
      prCard.body.append(emptyNote('None from this session.'));
    } else {
      for (const pr of prs) {
        prCard.body.append(el('div', { class: 'pr' }, [
          el('span', { text: pr.kind }),
          el('span', { class: 'num muted', text: String(pr.value) }),
        ]));
      }
    }

    resultHost.append(card, prCard, el('div', { class: 'entry-actions' }, [
      el('button', {
        class: 'btn btn-primary btn-lg btn-block', type: 'button', text: 'Log another',
        on: {
          click: () => {
            form.hidden = false;
            clear(resultHost);
            top.querySelector('.entry-title').textContent = 'Add activity';
            state.result = null; state.gf = null; state.ga = null;
            state.goals = null; state.assists = null; state.distance = null;
            state.elapsed = ''; state.compliance = null; state.notes = '';
            state.text = '';
            textArea.value = '';
            notesInput.value = '';
            buildFields();
            refresh();
            window.scrollTo({ top: 0 });
          },
        },
      }),
      el('a', { class: 'btn btn-block', href: '#/week', text: 'Back to the week' }),
    ]));
  }

  /* ── drafts: a failed save must never cost the entry ── */

  const saveDraft = debounce(() => {
    try { localStorage.setItem(DRAFT_KEY, state.text); } catch { /* quota */ }
  }, 400);
  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } };

  function leave() {
    navigate(editingId ? '#/log' : '#/week');
  }

  /* ── boot ── */

  (async () => {
    if (editingId) {
      const s = await resolveSession(editingId);
      if (!alive) return;
      if (!s) {
        clear(host);
        host.append(top, el('p', { class: 'empty', text:
          `No session with id ${editingId} — it may already have been deleted.` }));
        return;
      }
      state.session = s;
      applySession(s);
    } else {
      try {
        const draft = localStorage.getItem(DRAFT_KEY);
        if (draft) { state.text = draft; textArea.value = draft; }
      } catch { /* ignore */ }
      buildFields();
      buildRpe();
      refresh();
      buildQuick();
    }
  })();

  /* Detail keys the form actually shows. Anything else on a session —
     `garmin_load`, `rpe_estimated`, `rpe_source`, whatever the sync adds next —
     is provenance this form never renders and therefore must never delete.
     `savePatch` rebuilds `detail` from the parsed shorthand, so without this
     an edit silently strips it. */
  const FORM_DETAIL_KEYS = [
    'result', 'gf', 'ga', 'goals', 'assists',
    'compliance_pct', 'load_lbs', 'hours', 'team',
  ];
  /* `zones` is deliberately NOT in that list. The shorthand grammar can express
     a split (`z1=76 z2=23`) but no control on this form does, so listing it as
     form-owned meant every edit rebuilt `detail` without it — entering a
     scoreline on today's match silently deleted the HR zones the watch had
     recorded an hour earlier. A key the form cannot show is a key the form
     must not drop. Typed zones still win: `parsed.detail` is spread after the
     preserved keys, so a `z1=` token overwrites. */

  const managesDistance = () => (FIELDS[state.kind] || []).includes('distance');

  function applySession(s) {
    state.kind = s.kind;
    state.date = s.date;
    state.rpe = s.rpe == null ? null : Math.round(s.rpe);
    state.duration = s.duration_min == null ? null : round1(s.duration_min);
    state.distance = s.distance_km == null ? null : s.distance_km;
    state.pace = s.pace_s_per_km ?? null;
    state.notes = s.notes || '';
    const d = s.detail || {};
    state.keptDetail = Object.fromEntries(
      Object.entries(d).filter(([k]) => !FORM_DETAIL_KEYS.includes(k)),
    );
    state.result = d.result || null;
    state.gf = d.gf ?? null;
    state.ga = d.ga ?? null;
    state.goals = d.goals ?? null;
    state.assists = d.assists ?? null;
    state.compliance = d.compliance_pct ?? null;
    state.ruckload = d.load_lbs ?? null;
    state.hours = d.hours ?? null;
    state.team = d.team || null;
    if (s.duration_min && (s.kind === 'run' || s.kind === 'ruck')) {
      state.elapsed = fmt.clock(s.duration_min);
    }

    const radio = kindGrid.querySelector(`#kind-${s.kind}`);
    if (radio) radio.checked = true;
    dateInput.value = state.date;
    notesInput.value = state.notes;
    syncDateChips();
    buildFields();
    buildRpe();
    refresh();
  }

  return {
    destroy() {
      alive = false;
      document.body.classList.remove('entry-open');
    },
    keys(e) {
      if (e.key === 'Escape') { leave(); return true; }
      return false;
    },
  };
}

/* ── session lookup ──────────────────────────────────────────────────────── */

async function resolveSession(id) {
  const hit = recallSession(id);
  /* `detail` only exists on a full session payload — the soccer view caches a
     narrower match shape under the same ids, so check for it explicitly. */
  if (hit && hit.detail !== undefined) return hit;
  /* Deep link or reload: no dedicated GET /api/sessions/{id} exists, so scan
     the log once rather than guess a date to filter by. */
  const res = await api('/api/sessions?limit=500');
  if (!res.ok) return null;
  rememberSessions(res.data.items || []);
  const found = (res.data.items || []).find((s) => String(s.id) === String(id));
  if (found) return found;
  const total = res.data.total || 0;
  for (let offset = 500; offset < total; offset += 500) {
    const more = await api(`/api/sessions?limit=500&offset=${offset}`);
    if (!more.ok) return null;
    rememberSessions(more.data.items || []);
    const f = (more.data.items || []).find((s) => String(s.id) === String(id));
    if (f) return f;
  }
  return null;
}

/* ── field builders ──────────────────────────────────────────────────────── */

const round1 = (n) => Math.round(n * 10) / 10;

function numberField({ label, value, onInput, step = '1', min = '0', suffix, inputmode = 'decimal', placeholder }) {
  const id = `f-${label.toLowerCase().replace(/\W+/g, '-')}`;
  const input = el('input', {
    class: 'input', type: 'number', id, step, min, inputmode,
    value: value == null ? '' : String(value), placeholder: placeholder || null,
    on: { input: () => onInput(input.value === '' ? null : Number(input.value)) },
  });
  return el('div', { class: 'field' }, [
    el('label', { for: id, text: label }),
    suffix ? el('div', { class: 'suffixed' }, [input, el('span', { text: suffix })]) : input,
  ]);
}

function stepperField({ label, value, onChange, max = 99 }) {
  const id = `s-${label.toLowerCase().replace(/\W+/g, '-')}`;
  const input = el('input', {
    class: 'input stepper-input num', type: 'number', id, min: '0', max: String(max),
    inputmode: 'numeric', value: value == null ? '' : String(value),
    on: { input: () => onChange(input.value === '' ? null : Number(input.value)) },
  });
  const bump = (d) => {
    const next = Math.max(0, Math.min(max, (Number(input.value) || 0) + d));
    input.value = String(next);
    onChange(next);
  };
  return el('div', { class: 'field' }, [
    el('label', { for: id, text: label }),
    el('div', { class: 'stepper' }, [
      el('button', { class: 'btn stepper-btn', type: 'button', text: '−',
        'aria-label': `Decrease ${label}`, on: { click: () => bump(-1) } }),
      input,
      el('button', { class: 'btn stepper-btn', type: 'button', text: '+',
        'aria-label': `Increase ${label}`, on: { click: () => bump(1) } }),
    ]),
  ]);
}

function durationField(state, soon) {
  const id = 'f-duration';
  const input = el('input', {
    class: 'input', type: 'number', id, min: '0', step: '1', inputmode: 'numeric',
    value: state.duration == null ? '' : String(state.duration),
    on: { input: () => { state.duration = input.value === '' ? null : Number(input.value); syncChips(); soon(); } },
  });
  const presets = [20, 30, 45, 60, 90];
  const chips = el('div', { class: 'chip-row' });
  const nodes = presets.map((m) => el('button', {
    class: 'chip', type: 'button', text: `${m}m`,
    on: { click: () => { state.duration = m; input.value = String(m); syncChips(); soon(); } },
  }));
  chips.append(...nodes);
  const syncChips = () => nodes.forEach((n, i) => n.setAttribute('aria-pressed', String(presets[i] === state.duration)));
  syncChips();
  return el('div', { class: 'field field-wide' }, [
    el('label', { for: id, text: 'Duration (minutes)' }),
    el('div', { class: 'row-wrap' }, [chips, el('div', { class: 'suffixed' }, [input, el('span', { text: 'min' })])]),
  ]);
}

const FIELD_BUILDERS = {
  /* The weekday already knows which fixture this is. The picker exists for the
     cases it cannot know: a Wednesday game, a Monday that was really pickup. */
  team(state, soon, now) {
    const implied = resolveTeam({ date: state.date, notes: state.notes, detail: {} });
    const active = state.team || implied.team;
    const wrap = el('fieldset', { class: 'field field-wide' }, [
      el('legend', { class: 'lbl', text: 'Fixture' }),
    ]);
    const row = el('div', { class: 'chip-row' });
    for (const t of TEAMS) {
      row.append(el('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(active === t.key),
        on: {
          click: () => {
            state.team = state.team === t.key ? null : t.key;
            now();
          },
        },
      }, [el('span', { text: t.label })]));
    }
    wrap.append(row);
    wrap.append(el('span', {
      class: 'field-hint',
      text: state.team
        ? `Set to ${teamLabel(state.team)} — saved on the match itself.`
        : `${teamLabel(implied.team)}, from the ${implied.source === 'note' ? 'note' : 'weekday'}. Tap to override.`,
    }));
    return wrap;
  },

  result(state, soon, now) {
    const wrap = el('fieldset', { class: 'field field-wide' }, [
      el('legend', { class: 'lbl', text: 'Result' }),
    ]);
    const group = el('div', { class: 'resultgrid', role: 'radiogroup', 'aria-label': 'Match result' });
    for (const [value, word] of [['W', 'Won'], ['D', 'Drew'], ['L', 'Lost']]) {
      const id = `res-${value}`;
      group.append(el('div', { class: 'resopt' }, [
        el('input', {
          type: 'radio', name: 'result', id, value, class: 'vh', checked: state.result === value,
          on: { change: () => { state.result = value; now(); } },
        }),
        el('label', { for: id }, [
          el('b', { text: value }), el('span', { text: word }),
        ]),
      ]));
    }
    wrap.append(group);
    return wrap;
  },

  score(state, soon) {
    return el('div', { class: 'field-pair' }, [
      stepperField({ label: 'Goals for', value: state.gf, max: 40, onChange: (v) => { state.gf = v; soon(); } }),
      stepperField({ label: 'Goals against', value: state.ga, max: 40, onChange: (v) => { state.ga = v; soon(); } }),
    ]);
  },

  ga2(state, soon) {
    return el('div', { class: 'field-pair' }, [
      stepperField({ label: 'Your goals', value: state.goals, max: 40, onChange: (v) => { state.goals = v; soon(); } }),
      stepperField({ label: 'Your assists', value: state.assists, max: 40, onChange: (v) => { state.assists = v; soon(); } }),
    ]);
  },

  duration: (state, soon) => durationField(state, soon),

  distance(state, soon) {
    return numberField({
      label: 'Distance', value: state.distance, step: '0.01', suffix: 'km',
      placeholder: '5.43', onInput: (v) => { state.distance = v; soon(); },
    });
  },

  elapsed(state, soon) {
    const id = 'f-elapsed';
    const input = el('input', {
      class: 'input', type: 'text', id, inputmode: 'numeric', placeholder: '39:10',
      pattern: '\\d{1,2}:\\d{2}(:\\d{2})?', value: state.elapsed || '',
      on: { input: () => { state.elapsed = input.value.trim(); soon(); } },
    });
    return el('div', { class: 'field' }, [
      el('label', { for: id, text: 'Elapsed time' }),
      input,
      el('span', { class: 'field-hint', text: 'mm:ss or h:mm:ss — sets duration and pace' }),
    ]);
  },

  compliance(state, soon) {
    return numberField({
      label: 'To plan', value: state.compliance, step: '1', min: '0', suffix: '%',
      inputmode: 'numeric', placeholder: '77', onInput: (v) => { state.compliance = v; soon(); },
    });
  },

  ruckload(state, soon) {
    return numberField({
      label: 'Ruck load', value: state.ruckload, step: '0.5', suffix: 'lb',
      placeholder: '16.5', onInput: (v) => { state.ruckload = v; soon(); },
    });
  },

  hours(state, soon, now) {
    const id = 'f-hours';
    const input = el('input', {
      class: 'input', type: 'number', id, min: '0', step: '0.5', inputmode: 'decimal',
      value: state.hours == null ? '' : String(state.hours),
      on: { input: () => { state.hours = input.value === '' ? null : Number(input.value); sync(); soon(); } },
    });
    const presets = [16, 20, 24, 48, 72];
    const chips = el('div', { class: 'chip-row' });
    const nodes = presets.map((h) => el('button', {
      class: 'chip', type: 'button', text: `${h}h`,
      on: { click: () => { state.hours = h; input.value = String(h); sync(); now(); } },
    }));
    chips.append(...nodes);
    const sync = () => nodes.forEach((n, i) => n.setAttribute('aria-pressed', String(presets[i] === state.hours)));
    sync();
    return el('div', { class: 'field field-wide' }, [
      el('label', { for: id, text: 'Fast length' }),
      el('div', { class: 'row-wrap' }, [chips, el('div', { class: 'suffixed' }, [input, el('span', { text: 'hr' })])]),
    ]);
  },
};

/* ── shorthand composition ───────────────────────────────────────────────── */

/** Structured form → the same notebook line the text path takes. One grammar,
 *  one ingest, and the tap path quietly teaches the shorthand. */
/** W/D/L from a scoreline. Arithmetic, not a verdict. */
export function soccerResult(gf, ga) {
  if (gf == null || ga == null) return null;
  return gf > ga ? 'W' : gf < ga ? 'L' : 'D';
}

/**
 * The half-filled scoreline the grammar cannot carry, named so the form can
 * say it out loud. Returns null when there is nothing wrong.
 *
 * Only one case survives the derivation above: a result picked with no score
 * behind it. There is no token for it, so it would compose to nothing and
 * save as nothing.
 */
export function scorelineGap(s) {
  if (s.kind !== 'soccer' || !s.result) return null;
  if (s.gf != null && s.ga != null) return null;
  const missing = s.gf == null && s.ga == null ? 'the score'
    : s.gf == null ? 'goals for' : 'goals against';
  return `A result needs a score behind it — ${missing} is empty, so the `
    + `${s.result} will not be saved. Fill both, or clear the result.`;
}

export function composeShorthand(s) {
  if (!s.kind || !s.date) return '';
  const t = [s.date, s.kind];

  if (s.kind === 'soccer') {
    /* A scoreline survives only as one fused token: the parser drops a bare
       `13:5` and a bare `W`, so anything short of all three fields used to
       compose to nothing at all — silently, with the page still saying
       "Saved". A match logged 13–5 with the W/D/L radio untouched lost its
       result and its goals.

       W/D/L is arithmetic on the score rather than a judgement, and the league
       cards already derive it exactly this way, so derive it here too. The
       other direction cannot be rescued — a result with no score has nothing
       to derive from — and `scorelineGap()` says so in the form instead. */
    const result = s.result || soccerResult(s.gf, s.ga);
    if (result && s.gf != null && s.ga != null) t.push(`${result}${s.gf}:${s.ga}`);
    if (s.goals != null || s.assists != null) t.push(`${s.goals || 0}g${s.assists || 0}a`);
    /* Matches carry real distance — the watch measures it and it counts toward
       the week's on-foot total. The soccer branch never emitted it, so editing
       a match rebuilt its line without the kilometres and the PATCH wrote them
       away: a 0.52 km match came back as null for touching the score. */
    if (s.distance) t.push(`${s.distance}km`);
    if (s.duration) t.push(`${s.duration}min`);
  } else if (s.kind === 'fast') {
    if (s.hours) t.push(`${s.hours}hr`);
  } else {
    if (s.kind === 'ruck' && s.ruckload) t.push(`${s.ruckload}lb`);
    if (s.distance) t.push(`${s.distance}km`);
    if (s.elapsed && /^\d{1,2}:\d{2}(:\d{2})?$/.test(s.elapsed)) t.push(s.elapsed);
    else if (s.duration) t.push(`${s.duration}min`);
    if (s.compliance != null) t.push(`${s.compliance}%`);
  }

  if (s.rpe != null && s.kind !== 'fast') t.push(`rpe=${s.rpe}`);
  const notes = String(s.notes || '').replace(/"/g, '').trim();
  if (notes) t.push(`"${notes}"`);
  return t.join(' ');
}

/* ── last-used defaults ──────────────────────────────────────────────────── */

function readLast(kind) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
    return all[kind] || {};
  } catch { return {}; }
}

export function writeLast(kind, values) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
    all[kind] = { ...(all[kind] || {}), ...values };
    localStorage.setItem(LAST_KEY, JSON.stringify(all));
  } catch { /* quota or private mode — defaults are a nicety, not a feature */ }
}
