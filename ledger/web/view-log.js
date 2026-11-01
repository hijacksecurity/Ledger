/* Log — every session, searchable. The paper notebook's index, basically:
 * find the entry, open it, fix it.
 */

import {
  el, icon, clear, api, qs, busy, fmt, KINDS, debounce, rememberSessions,
} from './core.js';
import {
  panel, panelError, kindFilter, sessionList, emptyNote, skeletonLines,
  setTimeframe,
} from './ui.js';

const PAGE = 100;

export function mount(host, route, { setQuery }) {
  const q = route.query;
  const state = {
    q: q.get('q') || '',
    kind: KINDS.includes(q.get('kind')) ? q.get('kind') : null,
    from: q.get('from') || '',
    to: q.get('to') || '',
    offset: 0,
    total: 0,
    items: [],
    timeframe: null,
  };
  let alive = true;
  let seq = 0;

  const search = el('input', {
    class: 'input', type: 'search', id: 'log-search',
    placeholder: 'Search notes, exercises, modality…',
    'aria-label': 'Search sessions', value: state.q,
  });
  const searchWrap = el('div', { class: 'searchbox' }, [icon('search'), search]);

  const fromInput = el('input', { class: 'input', type: 'date', 'aria-label': 'From date', value: state.from });
  const toInput = el('input', { class: 'input', type: 'date', 'aria-label': 'To date', value: state.to });
  const clearBtn = el('button', { class: 'btn btn-quiet', type: 'button', text: 'Clear filters' });

  const kindHost = el('div', { class: 'filter' });
  const filters = el('div', { class: 'filterbar filterbar-log' }, [
    el('div', { class: 'filter filter-grow' }, [el('span', { class: 'lbl', text: 'Search' }), searchWrap]),
    kindHost,
    el('div', { class: 'filter' }, [
      el('span', { class: 'lbl', text: 'From' }), fromInput,
    ]),
    el('div', { class: 'filter' }, [
      el('span', { class: 'lbl', text: 'To' }), toInput,
    ]),
    el('div', { class: 'filter filter-end' }, [clearBtn]),
  ]);

  const pList = panel({ title: 'Sessions', sub: ' ' });
  const moreWrap = el('div', { class: 'more' });

  host.append(filters, pList);
  skeletonLines(8, pList.body);

  function buildKinds() {
    clear(kindHost);
    kindHost.append(
      el('span', { class: 'lbl', text: 'Modality' }),
      kindFilter(KINDS, state.kind, (v) => {
        state.kind = v === state.kind ? null : v;
        reset();
      }),
    );
  }

  function sync() {
    setQuery({ q: state.q, kind: state.kind || '', from: state.from, to: state.to });
  }

  function reset() {
    state.offset = 0;
    state.items = [];
    buildKinds();
    sync();
    load();
  }

  async function load({ append = false } = {}) {
    const mine = ++seq;
    busy(true);
    const res = await api(`/api/sessions${qs({
      q: state.q || null, kind: state.kind, from: state.from || null, to: state.to || null,
      limit: PAGE, offset: state.offset,
    })}`);
    busy(false);
    if (!alive || mine !== seq) return;

    if (!res.ok) {
      panelError(pList.body, res, 'The session log');
      return;
    }
    state.total = res.data.total || 0;
    state.timeframe = res.data.timeframe || null;
    const items = res.data.items || [];
    rememberSessions(items);
    state.items = append ? state.items.concat(items) : items;
    paint();
  }

  function paint() {
    clear(pList.body);
    const filtered = state.q || state.kind || state.from || state.to;
    setTimeframe(pList, state.timeframe);
    pList.head.querySelector('.sub').textContent = state.total
      ? `${fmt.int(state.total)} ${state.total === 1 ? 'session' : 'sessions'}${
        filtered ? ' matching' : ' on record'} · showing ${state.items.length}`
      : (filtered ? 'No matches' : 'Nothing on record');

    if (!state.items.length) {
      pList.body.append(emptyNote(
        filtered
          ? 'Nothing matches those filters.'
          : 'Nothing logged yet. The first entry starts the record.',
      ));
      return;
    }

    pList.body.append(sessionList(state.items, { groupBy: 'week' }));

    clear(moreWrap);
    if (state.items.length < state.total) {
      const btn = el('button', {
        class: 'btn', type: 'button',
        text: `Load ${Math.min(PAGE, state.total - state.items.length)} more`,
        on: {
          click: () => {
            state.offset = state.items.length;
            btn.disabled = true;
            load({ append: true });
          },
        },
      });
      moreWrap.append(btn, el('span', { class: 'muted', text: `${state.items.length} of ${fmt.int(state.total)}` }));
      pList.body.append(moreWrap);
    }
  }

  const onSearch = debounce(() => { state.q = search.value.trim(); reset(); }, 260);
  search.addEventListener('input', onSearch);
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; state.q = ''; reset(); } });
  fromInput.addEventListener('change', () => { state.from = fromInput.value; reset(); });
  toInput.addEventListener('change', () => { state.to = toInput.value; reset(); });
  clearBtn.addEventListener('click', () => {
    state.q = ''; state.kind = null; state.from = ''; state.to = '';
    search.value = ''; fromInput.value = ''; toInput.value = '';
    reset();
  });

  buildKinds();
  load();

  return {
    destroy() { alive = false; },
    refresh: () => { state.offset = 0; load(); },
    focusSearch() { search.focus(); search.select(); },
  };
}
