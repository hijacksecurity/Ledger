/* Ledger — the forecast. Shared by `#/week` (the next hours, top right) and
 * `#/plan` (the sky over each day of the week).
 *
 * Read at a glance, so colour does the first reading and words the second:
 *
 *   sky        the icon in the sky's own colours — sun gold, rain blue, snow
 *              ice, lightning amber; cloud is ink.
 *   temp       the figure in its band colour on the weather-map ramp, cold
 *              blue → mild green → hot red. The key under every surface names
 *              the bands on screen with their ranges.
 *   rain       blue, and stronger as the chance rises: the drop and the bar
 *              are faint for a slight chance and solid when rain is likely.
 *
 * Decides nothing. Every word, icon, band, rain level and rounded figure is
 * the server's (`ledger/weather.py`); this lays them out. The bands are a
 * reading of a temperature, never a verdict on it.
 */

import { el, icon, clear } from './core.js';

/** The sky for an hour or a day: `i-wx-<key>` from the sprite. */
export const wxIcon = (key, cls) =>
  icon(`wx-${key || 'none'}`, cls ? `wx-i ${cls}` : 'wx-i');

/* A real space between every pair of children: a flex row ignores it, and
   anything reading text — copy, a screen reader, the audit — gets words that
   do not run together ("Now54°F"). */
const spaced = (nodes) => nodes.filter(Boolean)
  .flatMap((n, i) => (i ? [document.createTextNode(' '), n] : [n]));

const deg = (v, u) => (v == null ? '—' : `${v}${u.temp}`);
const pct = (v) => (v == null ? '—' : `${v}%`);
const tb = (band) => (band ? ` tb-${band}` : '');
const rl = (level) => ` rl-${level || 'dry'}`;

function stamp(iso) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? '' : at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The chance of rain: a drop and a figure, both in rain blue by level. */
const rainChip = (p, level, cls = '') => el('span', {
  class: `wx-rain num${rl(level)}${cls ? ` ${cls}` : ''}`, title: 'chance of rain',
}, spaced([icon('drop', 'wx-drop'), el('span', { text: pct(p) })]));

/**
 * The key: one swatch per temperature band actually on screen, with its word
 * and range, then the drop. Only the bands present — seven swatches for two
 * colours in use is a legend to decode rather than read.
 */
function key(bands, used, extra = []) {
  const items = (bands || []).filter((b) => used.has(b.key)).map((b) =>
    el('li', {}, spaced([
      el('i', { class: `wx-sw${tb(b.key)}` }),
      el('span', { text: `${b.label} ${b.range}` }),
    ])));
  items.push(el('li', {}, spaced([
    icon('drop', 'wx-drop rl-likely'),
    el('span', { text: 'chance of rain' }),
  ])));
  for (const x of extra) items.push(el('li', {}, [el('span', { text: x })]));
  return el('ul', { class: 'wx-key' }, spaced(items));
}

/* ── the next hours, for #/week ─────────────────────────────────────────── */

/**
 * `GET /api/weather/hourly?hours=8` into `host`: now, large — the sky, the
 * temperature and the word — then the seven hours after it, the line that says
 * when the rain comes, and the key.
 *
 * The headline is the server's, in the National Weather Service's own words
 * for a probability (slight chance, chance, likely), because "is the next
 * stretch dry" is the question these hours are read for.
 */
export function paintNow(host, res) {
  clear(host);
  if (!res.ok) {
    host.hidden = false;
    host.append(el('p', { class: 'wxnow-msg', text: res.status === 503
      ? 'The weather could not be fetched just now.'
      : 'The weather is unavailable right now.' }));
    return;
  }
  const d = res.data;
  if (!d.configured) {
    /* Off is a choice made in .env, not a fault: nothing on the page. */
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const u = d.units;
  const hours = d.hours || [];
  const now = hours[0];
  const later = hours.slice(1);
  if (!now) {
    host.append(el('p', { class: 'wxnow-msg', text: 'The forecast has no hours left in it.' }));
    return;
  }
  host.classList.toggle('is-night', !now.is_day);
  host.classList.toggle('is-day', !!now.is_day);

  host.append(el('div', { class: 'wxnow-h' }, spaced([
    el('b', { text: 'Weather' }),
    el('span', { class: 'wxnow-place', text: d.place }),
    el('span', { class: 'wxnow-asof', text: `as of ${stamp(d.fetched_at)}${d.stale ? ' (last good)' : ''}` }),
  ])));

  const lead = el('div', { class: 'wxnow-lead', title: `feels like ${deg(now.feels, u)}, wind ${now.wind ?? '—'} ${u.wind}` }, spaced([
    wxIcon(now.icon, 'wxnow-big'),
    el('div', { class: 'wxnow-fig' }, spaced([
      el('b', { class: `wxnow-temp num${tb(now.temp_band)}`, text: deg(now.temp, u) }),
      el('span', { class: 'wxnow-word', text: now.summary }),
      el('span', { class: 'wxnow-feels', text: `feels ${deg(now.feels, u)}` }),
    ])),
  ]));

  const row = el('ol', { class: 'wxnow-row', 'aria-label': `The hours after now at ${d.place}` });
  for (const h of later) {
    row.append(el('li', {
      class: `wxnow-c${h.is_day ? '' : ' is-night'}`,
      title: `${h.summary}, feels like ${deg(h.feels, u)}, wind ${h.wind ?? '—'} ${u.wind}`,
    }, spaced([
      el('span', { class: 'wxnow-t', text: h.label }),
      el('span', { class: 'wxnow-ic' }, [wxIcon(h.icon), el('span', { class: 'sr', text: h.summary })]),
      /* The degree sign without the letter: the large figure beside these
         names the unit once, and five "°F"s ran into each other. */
      el('b', { class: `wxnow-ht num${tb(h.temp_band)}`, text: h.temp == null ? '—' : `${h.temp}°` }),
      el('span', { class: `wxnow-bar${rl(h.precip_level)}`, 'aria-hidden': 'true' }, [
        el('i', { style: `height:${Math.max(0, Math.min(100, h.precip_prob || 0))}%` }),
      ]),
      rainChip(h.precip_prob, h.precip_level),
    ])));
  }

  host.append(el('div', { class: 'wxnow-b' }, [lead, row]));

  const hl = d.headline || {};
  host.append(el('p', { class: `wxnow-line${rl(hl.level)}` }, spaced([
    hl.level === 'dry'
      ? wxIcon(now.is_day ? 'clear' : 'clear-night', 'wx-dry')
      : icon('drop', `wx-drop${rl(hl.level)}`),
    el('b', { text: hl.text || '' }),
  ])));

  host.append(key(d.bands, new Set(hours.map((h) => h.temp_band).filter(Boolean))));
}

/* ── the sky over each day, for #/plan ──────────────────────────────────── */

/**
 * The weather for one day, sized to sit at the top of a day cell: the sky,
 * the high in its band colour with the low beside it, and the chance of rain.
 * A day the forecast cannot speak to is left blank; a day a week or more out
 * is drawn faint, because that far ahead it is a rough guide.
 */
export function dayMark(x, u) {
  if (!x || x.status !== 'forecast') {
    return el('span', { class: 'wxday-m is-none', 'aria-hidden': 'true' });
  }
  return el('span', {
    class: `wxday-m${x.outlook ? ' is-outlook' : ''}`,
    title: `${x.summary}${x.outlook ? ' (a week or more out: a rough guide)' : ''} · `
      + `high ${deg(x.temp_max, u)}, low ${deg(x.temp_min, u)} · `
      + `${pct(x.precip_prob)} chance of rain · wind up to ${x.wind_max ?? '—'} ${u.wind}`,
  }, spaced([
    el('span', { class: 'wxday-top' }, spaced([
      wxIcon(x.icon),
      el('b', { class: `wxday-hi num${tb(x.temp_band)}`, text: deg(x.temp_max, u) }),
      el('span', { class: 'wxday-lo num', text: `/ ${deg(x.temp_min, u)}` }),
    ])),
    el('span', { class: 'wxday-word', text: x.summary }),
    rainChip(x.precip_prob, x.precip_level, 'wxday-rain'),
  ]));
}

/** The key under the day grid: the bands on screen, the drop, the outlook. */
export function dayKey(d) {
  const shown = (d.days || []).filter((x) => x.status === 'forecast');
  const extra = [];
  if (shown.some((x) => x.outlook)) extra.push('faint: 7+ days out, a rough guide');
  extra.push(`high / low · as of ${stamp(d.fetched_at)}${d.stale ? ' (last good)' : ''}`);
  return el('div', { class: 'wxday-key' }, [
    key(d.bands, new Set(shown.map((x) => x.temp_band).filter(Boolean)), extra),
  ]);
}
