/* Soccer — the modality the notebook records in most detail and the app showed
 * least of. Scorelines and goals/assists have been logged for every match since
 * 2025; this is where they surface.
 *
 * Three standing fixtures sit behind the numbers — Monday coed, Tuesday pickup,
 * Thursday men's league (Wednesdays until the Fall 2026 venue move; see
 * MENS_ON_THURSDAY_FROM in dataset.js) — so almost everything here
 * can be split by fixture. The weekday is the rule; a note or an explicit
 * override handles the one-off game and the Monday that was really pickup.
 * Where a fixture was inferred rather than stated, the page says so.
 *
 * Reported flat. A losing run is shown, not softened.
 */

import {
  el, icon, clear, api, qs, busy, fmt, colorOf, token, stepTowardInk, dateOf,
  rememberSessions, toast,
} from './core.js';
import {
  panel, panelError, statStrip, segmented, emptyNote, skeletonBlock, readout,
  resultChip, RANGE_PRESETS, resolveRange, sportTabs, dowBadge,
  sectionRule, collapsible, setTimeframe,
} from './ui.js';
import { figure } from './charts.js';
import {
  soccerReadout, sessionsIn, soccerByTeam, resolveTeam, teamLabel, TEAMS,
  runningInvolvement,
} from './dataset.js';

export function mount(host, route, { setQuery }) {
  const state = {
    range: route.query.get('range') || 'all',
    team: TEAMS.some((t) => t.key === route.query.get('team')) ? route.query.get('team') : null,
  };
  let figs = [];
  let alive = true;
  let seq = 0;
  let store = null;

  const filters = el('div', { class: 'filterbar' });
  const statsHost = el('div', { class: 'strip-host' });
  const pTeams = panel({
    title: 'By fixture', wide: true,
    sub: 'Monday coed, Tuesday pickup, Thursday men’s league (Wednesdays before the Fall 2026 venue move) — anything else is read from the note', accent: 'soccer' });
  const pInvolve = panel({ title: 'Goal involvement', sub: 'goals and assists per month', wide: true, accent: 'soccer' });
  /* This panel was a rolling five-match mean, whose last point read 3.60 while
     the tile above read 2.78. Both were right and that was exactly the problem:
     a five-match window divides by five, the tile divides by every match in the
     range, and no two such numbers can ever agree.

     It is a running average now. The final point *is* the tile's figure — the
     same sum over the same matches — so the chart ends where the tile says, and
     the earlier points show how it got there. */
  const pRate = panel({
    title: 'Involvement per match',
    sub: 'running average — every match so far', accent: 'soccer' });
  const pScoring = panel({ title: 'Scored and conceded', sub: 'goals for and against, per month', accent: 'soccer' });
  const pResults = panel({ title: 'Results by month', sub: 'wins, draws and losses', accent: 'soccer' });
  const pForm = panel({ title: 'Form', sub: 'every match with a result, oldest on the left', accent: 'soccer' });
  const pRead = panel({ title: 'Read-out', sub: 'flat, including the parts that are not flattering', accent: 'soccer' });
  const pMatches = panel({ title: 'Matches', sub: ' ', wide: true, accent: 'soccer' });
  /* No title on this panel: the section rule immediately above it already says
     "Leagues" and said much the same thing underneath, so the page opened with
     the same heading printed twice. The rule keeps the heading, the panel is
     reduced to a container, and the cards sit one box shallower. */
  const pLeague = panel({ wide: true, className: 'panel-bare' });

  /* The refresh control for the league cards. Everything else on this page is
     computed from sessions you typed; these two cards are scraped, so they are
     the only thing here with an age — and the only thing worth a button. The
     stamp beside it is what makes the button decidable: without knowing the
     tables are four hours old there is no way to tell whether pressing it
     would change anything. */
  const leagueStamp = el('span', { class: 'stamp' });
  const leagueBtn = el('button', {
    type: 'button', class: 'btn btn-quiet btn-sm',
    'aria-label': 'Refresh the league tables and fixtures now',
  }, [icon('sync'), el('span', { text: 'Refresh' })]);
  leagueBtn.addEventListener('click', refreshLeagues);
  let leagueBusy = false;

  host.append(
    sportTabs('soccer'), filters, statsHost,
    sectionRule(
      'Leagues', 'where you sit, who is next, and who they are — pulled from the league site',
      [leagueStamp, leagueBtn],
    ),
    pLeague,
    sectionRule('Your record', 'across every fixture'),
    pTeams, pInvolve,
    el('div', { class: 'grid-2' }, [pRate, pScoring]),
    el('div', { class: 'grid-2' }, [pResults, pForm]),
    sectionRule('Detail'),
    pRead, pMatches,
  );
  skeletonBlock(96, statsHost);
  skeletonBlock(220, pTeams.body);
  skeletonBlock(240, pInvolve.body);
  skeletonBlock(200, pRate.body);
  skeletonBlock(200, pScoring.body);
  skeletonBlock(200, pResults.body);
  skeletonBlock(90, pForm.body);
  skeletonBlock(140, pRead.body);
  skeletonBlock(240, pMatches.body);
  skeletonBlock(220, pLeague.body);

  /* Leagues are external and slow-moving, so they load once and are not
     refetched when a filter changes.

     The exception is a scrape running behind the response. The server
     refreshes stale leagues in the background and says so with `refreshing`,
     and the wait is a few seconds of somebody else's web server — so the page
     asks once more rather than showing last night's table and making you come
     back. The second answer only repaints if fetched_at actually moved: a
     scrape can fail, and redrawing the cards would collapse an open standings
     table to show the same numbers. */
  let painted = null;
  let lastLeagues = [];
  (async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await api('/api/leagues');
      if (!alive) return;
      if (!res.ok) {
        if (!painted) panelError(pLeague.body, res, 'League');
        paintLeagueBar(lastLeagues, false);
        return;
      }

      const list = res.data.leagues || [];
      lastLeagues = list;
      const stamp = list.map((lg) => lg.fetched_at || '').join('|');
      if (stamp !== painted) { paintLeagues(list, res.data.refreshing); painted = stamp; }
      /* The bar is repainted whether or not the cards were: a scrape that
         finished without changing `fetched_at` still has to stop the stamp
         saying "Pulling…". */
      else paintLeagueBar(list, res.data.refreshing);

      if (!res.data.refreshing) return;
      await new Promise((r) => setTimeout(r, 6000));
      if (!alive) return;
    }
    paintLeagueBar(lastLeagues, false);
  })();

  function paintLeagues(list, refreshing) {
    clear(pLeague.body);
    paintLeagueBar(list, refreshing);
    if (!list.length) {
      /* Nothing stored is now usually a fetch in flight rather than a step
         you forgot: the server pulls them itself when they are missing or
         stale, and Refresh above pulls them on demand. */
      pLeague.body.append(emptyNote(
        refreshing
          ? 'Pulling the league pages…'
          : 'No leagues stored yet. Refresh above pulls them, or run `ledger leagues`.',
      ));
      return;
    }
    const grid = el('div', { class: 'grid-2 lg-grid' });
    for (const lg of list) grid.append(leagueCard(lg));
    pLeague.body.append(grid);
  }

  /** The stamp and the button, which only ever describe the same one thing. */
  function paintLeagueBar(list, refreshing) {
    /* Disabled only while *this* page is waiting on its own POST. A scrape
       running behind someone else's response is worth saying in the stamp,
       but it must not leave the button dead — the background poll gives up
       after two looks, and a button that never comes back is worse than a
       second scrape of two pages. */
    leagueStamp.textContent = leagueBusy || refreshing ? 'Pulling…' : ageText(list || []);
    leagueBtn.disabled = leagueBusy;
    leagueBtn.querySelector('span').textContent = leagueBusy ? 'Refreshing…' : 'Refresh';
  }

  /**
   * How old the tables are, to the granularity that matters. The server only
   * scrapes on its own after six hours, so minutes are worth showing below an
   * hour and hours above it — "yesterday" would hide the whole decision.
   */
  function ageText(list) {
    const stamps = list
      .map((lg) => lg.fetched_at)
      .filter(Boolean)
      .map((s) => Date.parse(/[Zz]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`))
      .filter((n) => !Number.isNaN(n));
    if (!stamps.length) return '';
    const mins = Math.max(0, Math.round((Date.now() - Math.min(...stamps)) / 60000));
    if (mins < 1) return 'Pulled just now';
    if (mins < 60) return `Pulled ${mins} min ago`;
    const h = Math.round(mins / 60);
    if (h < 24) return `Pulled ${h}h ago`;
    const d = Math.round(h / 24);
    return `Pulled ${d} day${d === 1 ? '' : 's'} ago`;
  }

  /**
   * Refresh on demand. `POST /api/leagues/refresh` blocks until both pages
   * have been fetched and ignores the six-hour staleness window, so this is
   * the one path that answers "is tonight's scoreline up yet" with a yes or a
   * no rather than a maybe.
   *
   * A league failing is reported per league and never as a blanket failure:
   * one season page 404ing the day a session ends must not hide the other
   * table, and the stale cards stay on screen either way.
   */
  async function refreshLeagues() {
    if (leagueBusy) return;
    leagueBusy = true;
    paintLeagueBar(null, true);
    busy(true);
    const res = await api('/api/leagues/refresh', { method: 'POST' });
    busy(false);
    leagueBusy = false;
    if (!alive) return;

    if (!res.ok) {
      paintLeagueBar(lastLeagues, false);
      const why = res.status === 404
        ? 'This server has no POST /api/leagues/refresh endpoint. Run `ledger leagues` instead.'
        : res.status === 0
          ? 'Could not reach the server.'
          : (res.error || 'The server refused the request.');
      pLeague.body.prepend(el('div', { class: 'preview-err' }, [
        el('b', { text: 'Not refreshed. ' }), el('span', { text: why }),
      ]));
      return;
    }

    const results = res.data.results || [];
    const failed = results.filter((r) => /^failed/i.test(r.outcome || ''));
    /* A refresh must never cost you what was already stored. The endpoint
       returns the stored rows and a failed scrape leaves them untouched, so an
       empty list here means something went wrong upstream of the data — and
       blanking two populated cards to say "no leagues stored yet" would be the
       page lying about a scrape it just failed to make. */
    const list = (res.data.leagues || []).length ? res.data.leagues : lastLeagues;

    paintLeagues(list, false);
    /* Keep the background poll's bookkeeping honest: it repaints only when
       fetched_at moves, and it would otherwise redraw over this and collapse
       an open standings table to show the same numbers. */
    painted = list.map((lg) => lg.fetched_at || '').join('|');
    lastLeagues = list;

    if (failed.length) {
      pLeague.body.prepend(el('div', { class: 'preview-err' }, [
        el('b', { text: `${failed.length} of ${results.length} did not refresh. ` }),
        el('span', { text: failed.map((r) => `${r.team} — ${r.outcome}`).join('; ') }),
        el('span', { text: '. The cards below are the last good pull.' }),
      ]));
      toast(`${failed.length} of ${results.length} leagues failed to refresh.`);
    } else {
      toast(results.length === 1 ? 'League refreshed.' : 'Leagues refreshed.');
    }
  }

  /**
   * One card per league. The order is the order the questions get asked:
   * where am I, how is it going, who is next and where — and only then, if
   * you actually want it, the full fifteen-row table.
   */
  function leagueCard(lg) {
    const me = lg.standings.find((r) => r.team === lg.my_team) || {};
    const total = lg.standings.length;
    const next = lg.my_fixtures.find((f) => !f.played);
    const played = lg.my_fixtures.filter((f) => f.played);
    const remaining = lg.my_fixtures.filter((f) => !f.played).length;

    const card = el('section', { class: 'lg-card' });

    /* ── who and where ── */
    card.append(el('div', { class: 'lg-top' }, [
      el('div', { class: 'lg-meta' }, [
        el('span', { class: `lg-tag lg-tag-${lg.fixture}`, text: FIXTURE_LABEL[lg.fixture] || lg.fixture }),
        el('span', { class: 'lg-day', text: FIXTURE_DAY[lg.fixture] || '' }),
      ]),
      el('a', {
        class: 'lg-link', href: lg.url, target: '_blank', rel: 'noopener noreferrer',
        'aria-label': `Open the league site for ${lg.my_team} in a new tab`,
      }, [el('span', { text: 'League site' }), icon('right')]),
    ]));

    /* ── the standing, as a figure rather than a table row ── */
    const pos = lg.my_position;
    card.append(el('div', { class: 'lg-standing' }, [
      el('div', { class: 'lg-posbox' }, [
        el('span', { class: 'lg-pos', text: pos ? String(pos) : '—' }),
        el('span', { class: 'lg-posord', text: pos ? ordSuffix(pos) : '' }),
      ]),
      el('div', { class: 'lg-who' }, [
        el('div', { class: 'lg-team', text: lg.my_team }),
        el('div', { class: 'lg-of', text: pos ? `of ${total} teams` : `${total} teams` }),
      ]),
      el('dl', { class: 'lg-rec' }, [
        recCell('W', me.w), recCell('D', me.t), recCell('L', me.l),
        recCell('PTS', me.pts, true),
      ]),
    ]));

    /* Position on the ladder: one hue, dark = top. Never colour alone —
       the number and "of N" say it too. */
    if (pos) {
      const frac = total > 1 ? (total - pos) / (total - 1) : 1;
      card.append(el('div', { class: 'lg-ladder', role: 'img',
        'aria-label': `Position ${pos} of ${total}` }, [
        el('div', { class: 'lg-ladder-fill', style: `width:${Math.max(4, frac * 100)}%` }),
      ]));
    }

    const gf = me.gf ?? 0;
    const ga = me.ga ?? 0;
    card.append(el('p', { class: 'lg-line', text:
      `${me.gp ?? 0} played · ${gf} scored, ${ga} conceded · ${fmt.signed(me.gd ?? 0, '', 0)} difference`
      + (remaining ? ` · ${remaining} left` : '') }));

    /* ── form in this league only ── */
    if (played.length) {
      const strip = el('div', { class: 'formstrip lg-form' });
      for (const f of played) {
        const home = f.home === lg.my_team;
        const mine = home ? f.home_score : f.away_score;
        const theirs = home ? f.away_score : f.home_score;
        const r = mine == null || theirs == null ? null
          : mine > theirs ? 'W' : mine < theirs ? 'L' : 'D';
        strip.append(el('span', {
          class: `form-cell form-${r || 'none'}`,
          title: `${fmt.dateY(f.date)} · ${home ? 'vs' : 'at'} ${home ? f.away : f.home} · ${mine}–${theirs}`,
        }, [el('span', { text: r || '·' })]));
      }
      card.append(el('div', { class: 'lg-block' }, [
        el('span', { class: 'lbl', text: 'Form in this league' }), strip,
      ]));
    }

    /* ── the next match, which is the thing you actually came for ── */
    if (next) {
      const home = next.home_game != null ? next.home_game : next.home === lg.my_team;
      const opp = next.opponent || (home ? next.away : next.home);
      card.append(el('div', { class: 'lg-next' }, [
        el('div', { class: 'lg-next-when' }, [
          el('b', { text: fmt.dowDate(next.date) }),
          el('span', { class: 'lg-next-time', text: next.time_text || '' }),
          el('span', { class: 'lg-next-rel', text: fmt.relDays(next.date) }),
        ]),
        el('div', { class: 'lg-next-who' }, [
          el('span', { class: 'lg-ha', text: home ? 'vs' : 'at' }),
          el('span', { class: 'lg-opp', text: opp }),
        ]),
        opponentRow(next.opponent_standing, total),
        venueBadge(next.venue),
      ]));
    } else {
      card.append(el('p', { class: 'empty', text: 'No fixture scheduled.' }));
    }

    /* ── everything else, folded away ── */
    const det = el('details', { class: 'lg-more' });
    det.append(el('summary', {}, [
      el('span', { text: `Full table and schedule` }),
      el('span', { class: 'muted', text: ` · ${total} teams, ${lg.my_fixtures.length} fixtures` }),
    ]));
    const body = el('div', { class: 'lg-more-body' });
    body.append(standingsTable(lg));
    body.append(fixtureList(lg));
    det.append(body);
    card.append(det);
    return card;
  }

  const recCell = (k, v, strong) => el('div', { class: `lg-rc${strong ? ' is-pts' : ''}` }, [
    el('dt', { text: k }), el('dd', { class: 'num', text: v == null ? '—' : String(v) }),
  ]);

  /**
   * Who you are about to play, in one line under their name.
   *
   * Position and record are the useful part, so that is all this is: a rank
   * chip and a single run of figures in the same W/D/L order as your own
   * cluster higher up the card. It deliberately stops short of a table —
   * folding the standings away is the whole reason this card exists — and it
   * passes no judgement on the fixture, because "1st, 9 pts" already says
   * everything a verdict would.
   */
  function opponentRow(row, teams) {
    if (!row) {
      /* Their row can genuinely be missing — a forfeited team, or a fixture
         published before the table caught up. State it and stop. */
      return el('p', { class: 'lg-opp-none', text: 'No standings row for them yet.' });
    }
    if (!row.gp) {
      /* A row with no games has a position only because the table had to
         list the teams in some order. Saying "10th" would be a claim. */
      return el('p', { class: 'lg-opp-none', text: 'No games played yet.' });
    }
    /* "32–15" next to a fixture would read as a scoreline for the match you
       are about to play, so the goals are worded the same way as the line
       higher up the card rather than punctuated like a result. */
    const gd = row.gd == null ? null : fmt.signed(row.gd, '', 0);
    const bits = [
      `${row.w ?? 0}W ${row.t ?? 0}D ${row.l ?? 0}L`,
      `${row.pts ?? 0} pts`,
      row.gf == null ? null : `${row.gf} scored, ${row.ga} conceded${gd ? ` (${gd})` : ''}`,
    ].filter(Boolean);

    return el('p', {
      class: 'lg-opp-rec',
      title: `${row.gf ?? 0} scored, ${row.ga ?? 0} conceded over ${row.gp ?? 0} played`,
      'aria-label': `${row.team} sit ${ordinal(row.position)} of ${teams}: `
        + `${row.w ?? 0} won, ${row.t ?? 0} drawn, ${row.l ?? 0} lost, ${row.pts ?? 0} points, `
        + `${row.gf ?? 0} scored and ${row.ga ?? 0} conceded`,
    }, [
      el('span', { class: 'lg-opp-pos', 'aria-hidden': 'true' }, [
        el('b', { text: String(row.position) }),
        el('span', { text: ordSuffix(row.position) }),
      ]),
      el('span', { class: 'lg-opp-fig num', 'aria-hidden': 'true', text: bits.join(' · ') }),
    ]);
  }

  /** Indoor and outdoor are different games; the word carries it, not a hue. */
  function venueBadge(venue) {
    if (!venue) return el('span');
    const indoor = /indoor/i.test(venue);
    return el('span', {
      class: `venue ${indoor ? 'venue-in' : 'venue-out'}`,
      title: venue,
    }, [
      el('span', { class: 'venue-dot', 'aria-hidden': 'true' }),
      el('span', { text: venue.replace(/^Indoor Field\s*/i, 'Indoor ').replace(/^Outdoor Field$/i, 'Outdoor') }),
    ]);
  }

  function standingsTable(lg) {
    const wrap = el('div', { class: 'tbl-wrap' });
    const tbl = el('table', { class: 'tbl lg-tbl' });
    tbl.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', class: 'num', text: '#' }),
      el('th', { scope: 'col', text: 'Team' }),
      el('th', { scope: 'col', class: 'num', text: 'GP' }),
      el('th', { scope: 'col', class: 'num', text: 'W' }),
      el('th', { scope: 'col', class: 'num', text: 'D' }),
      el('th', { scope: 'col', class: 'num', text: 'L' }),
      el('th', { scope: 'col', class: 'num', text: 'GF', title: 'Goals for' }),
      el('th', { scope: 'col', class: 'num', text: 'GA', title: 'Goals against' }),
      el('th', { scope: 'col', class: 'num', text: 'GD' }),
      el('th', { scope: 'col', class: 'num', text: 'PTS' }),
    ])]));
    const tb = el('tbody');
    for (const r of lg.standings) {
      const mine = r.team === lg.my_team;
      tb.append(el('tr', { class: mine ? 'is-me' : null }, [
        el('td', { class: 'num lg-rank', text: r.position }),
        el('th', { scope: 'row', class: 'lg-name' }, [
          el('span', { text: r.team }),
          mine ? document.createTextNode(' ') : null,
          mine ? el('span', { class: 'lg-you', text: 'you' }) : null,
        ]),
        el('td', { class: 'num', text: r.gp ?? '—' }),
        el('td', { class: 'num', text: r.w ?? '—' }),
        el('td', { class: 'num', text: r.t ?? '—' }),
        el('td', { class: 'num', text: r.l ?? '—' }),
        el('td', { class: 'num', text: r.gf ?? '—' }),
        el('td', { class: 'num', text: r.ga ?? '—' }),
        el('td', { class: 'num', text: r.gd == null ? '—' : fmt.signed(r.gd, '', 0) }),
        el('td', { class: 'num lg-pts', text: r.pts ?? '—' }),
      ]));
    }
    tbl.append(tb);
    wrap.append(tbl);
    return wrap;
  }

  function fixtureList(lg) {
    const wrap = el('div', { class: 'lg-fixtures' });
    wrap.append(el('div', { class: 'lbl', text: 'Your fixtures' }));
    for (const f of lg.my_fixtures) {
      const home = f.home_game != null ? f.home_game : f.home === lg.my_team;
      const mine = home ? f.home_score : f.away_score;
      const theirs = home ? f.away_score : f.home_score;
      const r = !f.played || mine == null ? null
        : mine > theirs ? 'W' : mine < theirs ? 'L' : 'D';
      wrap.append(el('div', { class: `lg-fx${f.played ? ' is-done' : ''}` }, [
        el('span', { class: 'lg-fx-date num', text: fmt.dowDate(f.date) }),
        el('span', { class: 'lg-fx-ha', text: home ? 'vs' : 'at' }),
        el('span', { class: 'lg-fx-opp', text: f.opponent || (home ? f.away : f.home) }),
        f.played
          ? el('span', { class: 'lg-fx-res' }, [
            el('span', { class: `res res-${r}`, text: r || '·' }),
            el('span', { class: 'num', text: mine == null ? '' : ` ${mine}–${theirs}` }),
          ])
          : el('span', { class: 'lg-fx-time num', text: f.time_text || '' }),
        venueBadge(f.venue),
      ]));
    }
    return wrap;
  }

  const FIXTURE_LABEL = { coed: 'Coed', mens: "Men's league", pickup: 'Pickup' };
  const FIXTURE_DAY = { coed: 'Mondays', mens: 'Thursdays', pickup: 'Tuesdays' };
  const ordSuffix = (n) => {
    const t = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return t[(v - 20) % 10] || t[v] || t[0];
  };

  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  function buildFilters() {
    clear(filters);
    const teamRow = el('div', { class: 'chip-row', role: 'group', 'aria-label': 'Filter by fixture' });
    const chip = (key, label) => el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(state.team === key),
      on: {
        click: () => {
          state.team = state.team === key ? null : key;
          setQuery({ team: state.team || '' });
          buildFilters();
          if (store) paint();
        },
      },
    }, [el('span', { text: label })]);
    teamRow.append(chip(null, 'All fixtures'));
    for (const t of TEAMS) teamRow.append(chip(t.key, t.label));

    filters.append(
      el('div', { class: 'filter' }, [
        el('span', { class: 'lbl', text: 'Range' }),
        segmented(RANGE_PRESETS, state.range, (v) => {
          state.range = v; setQuery({ range: v }); buildFilters(); load();
        }, 'Date range'),
      ]),
      el('div', { class: 'filter' }, [el('span', { class: 'lbl', text: 'Fixture' }), teamRow]),
    );
  }

  async function load() {
    const mine = ++seq;
    const { from, to } = resolveRange(state.range);
    busy(true);
    const res = await api(`/api/soccer${qs({ from, to })}`);
    const sess = await sessionsIn({ from, to, kind: 'soccer' });
    busy(false);
    if (!alive || mine !== seq) return;

    if (!sess.ok && !res.ok) {
      clear(statsHost);
      panelError(pInvolve.body, res, 'Soccer');
      clear(pTeams.body); clear(pRate.body); clear(pScoring.body);
      clear(pResults.body); clear(pForm.body); clear(pRead.body); clear(pMatches.body);
      return;
    }
    rememberSessions(sess.items || []);
    store = {
      api: res.ok ? res.data : null,
      sessions: sess.ok ? sess.items : [],
      /* The match window as `/api/soccer` states it. One window for the whole
         page: the range control decides it, every panel covers it, and every
         panel prints this same label. Nothing here shows a period of its own —
         a chart may smooth its series (the rolling mean does) but the span it
         covers is always this one. */
      timeframe: res.ok ? res.data.timeframe : sess.timeframe,
    };
    paint();
  }

  function paint() {
    figs.forEach((f) => f.destroy && f.destroy());
    figs = [];

    /* One window, every panel. The range control at the top of the page is the
       only thing that decides what any of these cover, and they all print the
       same label so two panels can always be read against each other.

       The rolling involvement chart is in this list on purpose. Its five-match
       mean is a *smoothing* applied to the series — the chart still spans every
       match in the range, the same way a 20-day moving average on a two-year
       stock chart is still a two-year chart. Labelling that panel "5-match
       rolling mean" described the smoothing and hid the period, which is the
       opposite of what this line is for. The smoothing belongs in the subtitle,
       and it is there. */
    for (const p of [pTeams, pInvolve, pRate, pScoring, pResults, pForm, pRead, pMatches]) {
      setTimeframe(p, store.timeframe);
    }

    /* One fixture resolution for the whole page: the server's, keyed by session
       id. Everything that groups by fixture — the table, the scope filter, the
       per-fixture read-out lines — reads from this map, so they cannot disagree
       with each other or with `/api/soccer`'s own totals. */
    const fixtureById = new Map(
      ((store.api && store.api.games) || []).map((g) => [String(g.id), {
        fixture: g.fixture, source: g.fixture_source,
      }]),
    );
    const fixtureOf = (s) => {
      const hit = fixtureById.get(String(s.id));
      return hit ? hit.fixture : resolveTeam(s).team;
    };

    /* What counts as a match is the server's call, not this page's.
       `/api/soccer` already drops solo ball work — anything the watch filed as
       soccer that carries no result and no goal involvement — with the comment
       "Solo ball work is not a match" sitting over the rule. This table asked
       for `kind=soccer` sessions directly instead, so quick feet and warmups
       appeared in Matches and in the By-fixture counts while the headline
       tiles above them, which do come from the server, excluded the same rows.
       One quantity, two answers, on one screen. `fixtureById` is built from
       the server's own games list, so membership in it *is* the definition. */
    const all = store.api
      ? store.sessions.filter((x) => fixtureById.has(String(x.id)))
      : store.sessions;
    const scoped = state.team ? all.filter((s) => fixtureOf(s) === state.team) : all;
    const teamRows = soccerByTeam(all, fixtureById);

    /* ── headline ── */
    clear(statsHost);
    if (!state.team && store.api) {
      const d = store.api;
      const rec = d.record || { w: 0, l: 0, d: 0 };
      const played = d.games_played || 0;
      statsHost.append(statStrip([
        {
          label: 'Record', value: `${rec.w}–${rec.l}–${rec.d}`,
          note: `${played} match${played === 1 ? '' : 'es'} with a result${
            d.games_logged > played ? `, ${d.games_logged - played} logged without one` : ''}`,
        },
        { label: 'Win rate', value: played ? `${Math.round((d.win_rate || 0) * 100)}%` : '—', note: 'W ÷ matches with a result' },
        /* Your numbers and the team's sat side by side unlabelled, so "per
           match 2.82 G+A" read as if it belonged with "319 for / 374
           against". They are different subjects; each now says whose it is. */
        {
          label: 'Your goals + assists', value: fmt.int(d.goal_involvements),
          note: `${fmt.int(d.goals)} goals, ${fmt.int(d.assists)} assists — you only`,
        },
        {
          label: 'Your G+A per match',
          value: d.involvements_per_match == null ? '—' : fmt.two(d.involvements_per_match),
          unit: 'G+A',
          note: `${fmt.int(d.goal_involvements)} ÷ ${fmt.int(d.matches_with_involvement)} `
            + `${d.involvements_basis || 'matches'}`,
        },
        {
          label: 'Team goals', value: `${fmt.int(d.goals_for)}–${fmt.int(d.goals_against)}`,
          note: `scored–conceded by your teams, ${fmt.signed((d.goals_for || 0) - (d.goals_against || 0), '', 0)} difference`,
        },
        shareTile(involvementShare((d.games || []))),
      ].filter(Boolean)));
    } else {
      const row = teamRows.find((r) => r.key === state.team)
        || { w: 0, l: 0, d: 0, played: 0, goals: 0, assists: 0, scored: 0, gf: 0, ga: 0, logged: 0 };
      statsHost.append(statStrip([
        {
          label: `${teamLabel(state.team)} record`, value: `${row.w}–${row.l}–${row.d}`,
          note: `${row.played} of ${row.logged} logged matches carry a result`,
        },
        { label: 'Win rate', value: row.played ? `${Math.round((row.w / row.played) * 100)}%` : '—', note: 'within this fixture only' },
        {
          label: 'Your goals + assists', value: fmt.int(row.goals + row.assists),
          note: `${fmt.int(row.goals)} goals, ${fmt.int(row.assists)} assists over ${row.scored} matches`,
        },
        {
          label: 'Your G+A per match',
          value: row.scored ? ((row.goals + row.assists) / row.scored).toFixed(2) : '—', unit: 'G+A',
          note: 'your involvements ÷ matches you played',
        },
        {
          label: 'Team goals', value: `${fmt.int(row.gf)}–${fmt.int(row.ga)}`,
          note: 'scored–conceded in this fixture',
        },
        shareTile(involvementShare(
          ((store.api && store.api.games) || []).filter((g) => g.fixture === state.team),
        )),
      ].filter(Boolean)));
    }

    /* ── fixtures table ── */
    clear(pTeams.body);
    if (!teamRows.length) {
      pTeams.body.append(emptyNote('No matches in this range.'));
    } else {
      pTeams.body.append(teamTable(teamRows));
      const inferred = teamRows.reduce((a, r) => a + r.inferred, 0);
      const total = teamRows.reduce((a, r) => a + r.logged, 0);
      pTeams.body.append(el('p', { class: 'sub', text:
        `${inferred} of ${total} logged matches had their fixture inferred from the weekday or the note rather than set explicitly. `
        + 'Open any match and set the fixture to override it — a one-off game or a Monday that was really pickup. '
        + 'P counts matches with a result; G+A / match divides by the matches carrying a goal line, shown after the slash.' }));
    }

    const months = groupByMonth(scoped);
    const scopeNote = state.team ? ` · ${teamLabel(state.team)} only` : '';

    /* ── goal involvement by month ── */
    clear(pInvolve.body);
    pInvolve.head.querySelector('.sub').textContent = `Goals and assists per month${scopeNote}`;
    if (!months.length) {
      pInvolve.body.append(emptyNote('No matches in this range.'));
    } else {
      const base = colorOf('soccer');
      figs.push(figure(pInvolve.body, {
        type: 'columns',
        aria: 'Goals and assists per month',
        height: 240, periodLabel: 'Month',
        series: [
          { key: 'goals', label: 'Goals', color: base },
          { key: 'assists', label: 'Assists', color: stepTowardInk(base, 0.45) },
        ],
        points: months.map((m) => ({
          key: m.key, label: fmt.monthYear(m.key),
          values: { goals: m.goals, assists: m.assists },
          total: m.goals + m.assists,
          note: `${m.games} match${m.games === 1 ? '' : 'es'}`,
        })),
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
        emptyText: 'No goals or assists recorded in this range.',
      }));
    }

    /* ── involvement per match, running ──
       The last point of this line is the "Your G+A per match" tile, exactly.
       Same sum, same matches, same divisor — so the two figures on this page
       agree by construction rather than by coincidence. */
    clear(pRate.body);
    const run = runningInvolvement(scoped);
    pRate.head.querySelector('.sub').textContent =
      `Running average — every match so far${scopeNote}`;
    if (run.length < 3) {
      pRate.body.append(emptyNote('Not enough matches with goal data in this range to average.'));
    } else {
      figs.push(figure(pRate.body, {
        type: 'line',
        aria: 'Goals plus assists per match, averaged over every match so far',
        height: 210, unit: 'G+A', periodLabel: 'Match', zeroBase: true,
        annotate: 'extremes',
        series: [{ key: 'rate', label: 'Average to date', color: colorOf('soccer') }],
        points: run,
        format: (v) => v.toFixed(2),
        formatShort: (v) => v.toFixed(1),
      }));
      const end = run[run.length - 1].values.rate;
      pRate.body.append(el('p', { class: 'sub', text:
        `Ends at ${fmt.two(end)} — the same figure as "Your G+A per match" above, because it is `
        + 'the same division. Early matches swing it and later ones barely move it, which is '
        + 'what an average over a growing record does.' }));
    }

    /* ── goals for and against ── */
    clear(pScoring.body);
    if (!months.length) {
      pScoring.body.append(emptyNote('No matches in this range.'));
    } else {
      figs.push(figure(pScoring.body, {
        type: 'columns',
        /* Grouped, not stacked. Scored and conceded are not two parts of one
           quantity — their sum is a number nobody wants — and side by side the
           month-by-month comparison is the mark itself rather than something
           you have to do in your head. */
        layout: 'grouped',
        aria: 'Goals scored and conceded per month',
        height: 230, unit: 'goals', periodLabel: 'Month',
        series: [
          { key: 'gf', label: 'Scored', color: token('good') },
          { key: 'ga', label: 'Conceded', color: token('critical') },
        ],
        points: months.map((m) => ({
          key: m.key, label: fmt.monthYear(m.key),
          values: { gf: m.gf, ga: m.ga }, total: m.gf + m.ga,
          note: `${m.games} match${m.games === 1 ? '' : 'es'} · ${fmt.signed(m.gf - m.ga, '', 0)} difference`,
        })),
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
        emptyText: 'No scorelines recorded in this range.',
      }));
    }

    /* ── results by month ── */
    clear(pResults.body);
    if (!months.length) {
      pResults.body.append(emptyNote('No matches in this range.'));
    } else {
      figs.push(figure(pResults.body, {
        type: 'columns',
        aria: 'Wins, draws and losses per month',
        height: 210, unit: 'matches', periodLabel: 'Month',
        series: [
          { key: 'W', label: 'Won', color: token('good') },
          { key: 'D', label: 'Drawn', color: token('ink-3') },
          { key: 'L', label: 'Lost', color: token('critical') },
        ],
        points: months.map((m) => ({
          key: m.key, label: fmt.monthYear(m.key),
          values: { W: m.W, D: m.D, L: m.L }, total: m.W + m.D + m.L,
        })),
        format: (v) => fmt.int(v),
        formatShort: (v) => fmt.int(v),
        emptyText: 'No results recorded in this range.',
      }));
    }

    /* ── form ── */
    clear(pForm.body);
    const withResult = scoped.filter((s) => (s.detail || {}).result)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!withResult.length) {
      pForm.body.append(emptyNote('No matches with a recorded result in this range.'));
    } else {
      /* Every match with a result in the range, not the last 24. The cap was
         the only thing on this page still showing a different period from its
         neighbours, and "most recent 24 of 54" beside seven panels reading
         "1 Jan 2025 to 11 Aug 2026" is exactly the mismatch the range control
         is supposed to prevent. The strip wraps, so length is not a problem —
         narrow the range if you want a shorter run. */
      const recent = withResult;
      const strip = el('div', { class: 'formstrip' });
      for (const g of recent) {
        const d = g.detail || {};
        strip.append(el('a', {
          class: `form-cell form-${d.result}`, href: `#/edit/${g.id}`,
          title: `${fmt.dateY(g.date)} · ${teamLabel(resolveTeam(g).team)} · ${d.result} ${d.gf ?? '?'}–${d.ga ?? '?'}`,
          'aria-label': `${d.result === 'W' ? 'Win' : d.result === 'L' ? 'Loss' : 'Draw'} ${
            d.gf ?? ''}–${d.ga ?? ''} for ${teamLabel(resolveTeam(g).team)} on ${fmt.dateY(g.date)}`,
        }, [el('span', { text: d.result })]));
      }
      pForm.body.append(strip);
      pForm.body.append(el('p', { class: 'sub', text:
        `All ${withResult.length} matches with a result in this range${scopeNote}, oldest on the left.` }));
    }

    /* ── read-out ── */
    clear(pRead.body);
    const lines = store.api && !state.team
      ? soccerReadout(store.api)
      : [];
    pRead.body.append(readout(lines.concat(teamLines(teamRows, state.team))));

    /* ── matches ── */
    clear(pMatches.body);
    pMatches.head.querySelector('.sub').textContent =
      `${scoped.length} logged${scopeNote}`;
    if (!scoped.length) {
      pMatches.body.append(emptyNote('No matches in this range.'));
    } else {
      pMatches.body.append(collapsible(
        `Show all ${scoped.length} matches`,
        matchTable(scoped.slice().sort((a, b) => (a.date < b.date ? 1 : -1))),
      ));
    }
  }

  /* `perMatch()` used to live here and divided by the matches it could see in
     the browser. The server publishes `involvements_per_match` over the same
     range with its denominator named, so the figure has one definition again.
     It read 2.78 beside a panel headed "Involvement per match" showing 3.60 —
     two different statistics with near-identical labels, which is exactly the
     confusion a second implementation produces. */

  /**
   * Share of your team's goals you had a hand in.
   *
   * Only over matches carrying **both** a scoreline and a goal line, because
   * the two are recorded independently: 158 involvements sit on 49 matches
   * while 375 team goals sit on 58, and dividing one by the other mixes two
   * denominators to produce a number that is about neither. This app has
   * already been bitten twice by exactly that — see the note on the rolling
   * involvement chart — so the basis is computed, and printed, rather than
   * assumed.
   *
   * A goal has one scorer and at most one assister, and you cannot be both on
   * the same goal, so on a clean record this cannot exceed 100%.
   */
  /**
   * Share of your team's goals you had a hand in: every goal and assist over
   * every goal the team scored.
   *
   * Nothing is excluded. An earlier version dropped matches that recorded a
   * scoreline without recording whose goals they were, on the grounds that the
   * denominators had to match — which was defensible arithmetic and useless on
   * screen: it divided by 339 while the tile beside it said 375, and carried a
   * sentence of caveat to explain the gap. A match that logged nothing
   * contributes nothing to either side, which is the same thing the exclusion
   * was trying to achieve, without the second number or the apology.
   *
   * A goal has one scorer and at most one assister, and you cannot be both on
   * the same goal, so this cannot exceed 100% on a clean record.
   */
  function involvementShare(games) {
    const list = games || [];
    const gf = list.reduce((a, g) => a + Number(g.gf || 0), 0);
    const inv = list.reduce((a, g) => a + Number(g.goals || 0) + Number(g.assists || 0), 0);
    if (!gf) return null;
    return { pct: (inv / gf) * 100, inv, gf };
  }

  const shareTile = (sh) => (sh ? {
    label: 'Share of team goals',
    value: `${Math.round(sh.pct)}%`,
    note: `${fmt.int(sh.inv)} ÷ ${fmt.int(sh.gf)} scored by your teams`,
  } : null);

  function teamLines(rows, active) {
    const out = [];
    const list = active ? rows.filter((r) => r.key === active) : rows;
    for (const r of list) {
      if (r.played < 3) continue;
      out.push(`${r.label}: ${r.w}W ${r.l}L ${r.d}D over ${r.played} matches, `
        + `${Math.round(r.winRate * 100)}% won, ${r.gfPerGame.toFixed(1)} scored and ${r.gaPerGame.toFixed(1)} conceded a game.`);
      if (r.scored >= 3) {
        out.push(`${r.label} involvement: ${r.goalsPerGame.toFixed(2)} goals and ${r.assistsPerGame.toFixed(2)} assists a match over ${r.scored} matches with goal data.`);
      }
    }
    return out;
  }

  function teamTable(rows) {
    const wrap = el('div', { class: 'table-wrap scroll' });
    const table = el('table', { class: 'data-table' });
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Fixture' }),
      el('th', { scope: 'col', class: 'num', text: 'P' }),
      el('th', { scope: 'col', class: 'num', text: 'W' }),
      el('th', { scope: 'col', class: 'num', text: 'D' }),
      el('th', { scope: 'col', class: 'num', text: 'L' }),
      el('th', { scope: 'col', class: 'num', text: 'Win %' }),
      el('th', { scope: 'col', class: 'num', text: 'GF' }),
      el('th', { scope: 'col', class: 'num', text: 'GA' }),
      el('th', { scope: 'col', class: 'num', text: 'G' }),
      el('th', { scope: 'col', class: 'num', text: 'A' }),
      el('th', { scope: 'col', class: 'num', text: 'G+A / match' }),
      /* P counts matches with a result; the rate's denominator is matches with
         a goal line. Both are printed so the row cannot be misread. */
    ])]));
    const body = el('tbody');
    for (const r of rows) {
      const meta = TEAMS.find((t) => t.key === r.key) || {};
      body.append(el('tr', {
        class: state.team === r.key ? 'row-active' : null,
      }, [
        el('th', { scope: 'row' }, [
          el('span', { text: r.label }),
          el('span', { class: 'muted', text: meta.note ? ` · ${meta.note}` : '' }),
        ]),
        el('td', { class: 'num', text: String(r.played) }),
        el('td', { class: 'num', text: String(r.w) }),
        el('td', { class: 'num', text: String(r.d) }),
        el('td', { class: 'num', text: String(r.l) }),
        el('td', { class: 'num', text: r.winRate == null ? '—' : `${Math.round(r.winRate * 100)}%` }),
        el('td', { class: 'num', text: String(r.gf) }),
        el('td', { class: 'num', text: String(r.ga) }),
        el('td', { class: 'num', text: String(r.goals) }),
        el('td', { class: 'num', text: String(r.assists) }),
        /* The rate divides by matches carrying a goal line, which is not the P
           column beside it — the one-off row reads P 1 with a rate over 2,
           because a match can have goals recorded and no result. The
           denominator is printed rather than left to be inferred. */
        el('td', { class: 'num' }, r.involvementsPerGame == null
          ? [el('span', { text: '—' })]
          : [
            el('span', { text: r.involvementsPerGame.toFixed(2) }),
            el('span', { class: 'muted', text: ` /${r.scored}` }),
          ]),
      ]));
    }
    table.append(body);
    wrap.append(table);
    return wrap;
  }

  function matchTable(games) {
    const wrap = el('div', { class: 'table-wrap scroll' });
    const table = el('table', { class: 'data-table' });
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Day' }),
      el('th', { scope: 'col', text: 'Date' }),
      el('th', { scope: 'col', text: 'Fixture' }),
      el('th', { scope: 'col', text: 'Result' }),
      el('th', { scope: 'col', class: 'num', text: 'Score' }),
      el('th', { scope: 'col', class: 'num', text: 'G' }),
      el('th', { scope: 'col', class: 'num', text: 'A' }),
      el('th', { scope: 'col', class: 'wrap', text: 'Notes' }),
      el('th', { scope: 'col' }, [el('span', { class: 'sr', text: 'Edit' })]),
    ])]));

    const body = el('tbody');
    for (const g of games) {
      const d = g.detail || {};
      const { team, source } = resolveTeam(g);
      body.append(el('tr', {}, [
        el('td', {}, [dowBadge(g.date)]),
        el('th', { scope: 'row', class: 'num nowrap', text: fmt.dateY(g.date) }),
        el('td', {}, [
          el('span', { text: teamLabel(team) }),
          source !== 'set' ? el('span', { class: 'inferred', title: `inferred from the ${source}`, text: '*' }) : null,
        ]),
        el('td', {}, [resultChip(d.result)]),
        el('td', { class: 'num', text: d.gf == null ? '—' : `${d.gf}–${d.ga}` }),
        el('td', { class: 'num', text: d.goals == null ? '—' : String(d.goals) }),
        el('td', { class: 'num', text: d.assists == null ? '—' : String(d.assists) }),
        el('td', { class: 'wrap', text: g.notes || '' }),
        el('td', { class: 'num' }, [
          el('a', { class: 'btn btn-quiet btn-sm', href: `#/edit/${g.id}`, text: 'Edit',
            'aria-label': `Edit match on ${fmt.dateY(g.date)}` }),
        ]),
      ]));
    }
    table.append(body);
    wrap.append(table);
    wrap.append(el('p', { class: 'sub', text: '* fixture inferred from the weekday or the note, not set on the match.' }));
    return wrap;
  }

  buildFilters();
  load();

  return { destroy() { alive = false; figs.forEach((f) => f.destroy && f.destroy()); }, refresh: load };
}

/** Zero-filled month buckets between the first and last match. */
function groupByMonth(games) {
  if (!games.length) return [];
  const bucket = new Map();
  for (const g of games) {
    const d = g.detail || {};
    const key = g.date.slice(0, 7);
    if (!bucket.has(key)) bucket.set(key, { key, goals: 0, assists: 0, gf: 0, ga: 0, W: 0, D: 0, L: 0, games: 0 });
    const b = bucket.get(key);
    b.goals += Number(d.goals || 0);
    b.assists += Number(d.assists || 0);
    b.gf += Number(d.gf || 0);
    b.ga += Number(d.ga || 0);
    b.games += 1;
    if (d.result === 'W') b.W += 1;
    else if (d.result === 'L') b.L += 1;
    else if (d.result === 'D') b.D += 1;
  }
  const keys = [...bucket.keys()].sort();
  const out = [];
  const cur = dateOf(`${keys[0]}-01`);
  const end = dateOf(`${keys[keys.length - 1]}-01`);
  while (cur <= end) {
    const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
    out.push(bucket.get(key) || { key, goals: 0, assists: 0, gf: 0, ga: 0, W: 0, D: 0, L: 0, games: 0 });
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}
