"""League schedules and tables — ezleagues, and DaySmart.

Two providers, one shape. The ezleagues venue publishes a public
page holding two ASP.NET GridViews with stable ids (`gvStandings`,
`..._Schedule1_GridView1`). the DaySmart venue publishes nothing there since it
took over Force Sports; its schedule sits behind the DaySmart "Dash" app,
which reads a public JSON:API (see the DaySmart section below). Both are
written to fail loudly on a layout change rather than quietly return an empty
table — an empty standings list and a league that has genuinely not started
look identical otherwise.

Stdlib only: `html.parser` and `json`, no new dependency.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from html.parser import HTMLParser
from typing import Any

#: Which venues to read, and which teams to follow. All of it comes from the
#: environment (see `.env.example`), because every value here is particular
#: to one person's leagues: the ezleagues host is one facility's site, the
#: DaySmart company slug and facility id are one venue's, and the seed list
#: names the teams. The defaults are placeholders that parse but fetch
#: nothing useful, so a fresh checkout runs without a venue configured.
EZLEAGUES_HOST = os.environ.get("LEDGER_EZLEAGUES_HOST", "example.ezleagues.ezfacility.com")
BASE = f"https://{EZLEAGUES_HOST}/leagues/{{path}}.aspx"
#: The slug is part of the path — {id}.aspx alone serves the venue landing
#: page, which parses to nothing and looks exactly like a layout change.
UA = "Mozilla/5.0 (compatible; Ledger/1.0; personal training log)"
TIMEOUT = 30

#: Every league the venue publishes, in one page. The season a fixture is in
#: changes three or four times a year and gets a brand-new league id each time,
#: so this is how a new season is found rather than hard-coded.
LISTING_URL = f"https://{EZLEAGUES_HOST}/leagues.aspx"
LISTING_RE = re.compile(r"leagues/(\d+)/([A-Za-z0-9\-]*)\.aspx")


def _seed_leagues() -> list[dict[str, str]]:
    """`LEDGER_LEAGUES`: a JSON list of `{provider_id, my_team, fixture, path}`.

    Seeds only. Once a league row exists in the database these are not
    consulted again — `configured()` reads the database, which is what lets a
    season roll over without a code change. A `daysmart:` id is read through
    the DaySmart API; anything else is scraped from ezleagues. Malformed JSON
    is reported, not swallowed: a silently empty seed list looks exactly like
    a venue with no leagues.
    """
    raw = os.environ.get("LEDGER_LEAGUES", "").strip()
    if not raw:
        return []
    try:
        seeds = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"LEDGER_LEAGUES is not valid JSON: {exc}") from exc
    if not isinstance(seeds, list):
        raise ValueError("LEDGER_LEAGUES must be a JSON list")
    required = {"provider_id", "my_team", "fixture", "path"}
    for seed in seeds:
        missing = required - set(seed)
        if missing:
            raise ValueError(f"LEDGER_LEAGUES entry is missing {sorted(missing)}: {seed}")
    return [dict(seed) for seed in seeds]


DEFAULT_LEAGUES = _seed_leagues()

#: The order the league cards are shown in, by fixture. Never by season.
FIXTURE_ORDER = {"coed": 0, "mens": 1}

STANDINGS_ID = "gvStandings"
SCHEDULE_ID_HINT = "Schedule1_GridView1"


class LeagueParseError(RuntimeError):
    """The page loaded but did not look like a league page any more."""


class _TableGrabber(HTMLParser):
    """Collect every table on the page as rows of cell text, keyed by id."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[tuple[str, list[list[str]]]] = []
        # ASP.NET nests its GridViews inside layout tables, so every table is
        # tracked on a stack and reported with its own id. Keying only on
        # depth-1 tables loses `gvStandings` entirely.
        self._stack: list[tuple[str, list[list[str]]]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "table":
            self._stack.append((dict(attrs).get("id") or "", []))
        elif tag == "tr" and self._stack:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(re.sub(r"\s+", " ", "".join(self._cell)).strip())
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if any(self._row) and self._stack:
                self._stack[-1][1].append(self._row)
            self._row = None
        elif tag == "table" and self._stack:
            self.tables.append(self._stack.pop())


@dataclass
class Standing:
    position: int
    team: str
    gp: int | None = None
    w: int | None = None
    l: int | None = None  # noqa: E741 — matches the column heading on the page
    t: int | None = None
    gf: int | None = None
    ga: int | None = None
    pts: int | None = None
    gd: int | None = None
    wp: float | None = None


@dataclass
class Fixture:
    date: str | None
    time_text: str
    home: str
    away: str
    home_score: int | None = None
    away_score: int | None = None
    played: bool = False
    venue: str | None = None


@dataclass
class League:
    provider_id: str
    url: str
    name: str = ""
    standings: list[Standing] = field(default_factory=list)
    fixtures: list[Fixture] = field(default_factory=list)


def _int(text: str) -> int | None:
    text = (text or "").strip()
    return int(text) if re.fullmatch(r"-?\d+", text) else None


def _float(text: str) -> float | None:
    try:
        return float((text or "").strip())
    except ValueError:
        return None


def fetch(provider_id: str, url: str | None = None) -> str:
    url = url or BASE.format(path=provider_id)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        return res.read().decode("utf-8", errors="replace")


def parse(page: str, provider_id: str, url: str) -> League:
    grabber = _TableGrabber()
    grabber.feed(page)

    league = League(provider_id=provider_id, url=url)

    title = re.search(r"<title[^>]*>(.*?)</title>", page, re.S | re.I)
    if title:
        league.name = re.sub(r"\s+", " ", title.group(1)).strip()

    for table_id, rows in grabber.tables:
        if table_id == STANDINGS_ID:
            league.standings = _parse_standings(rows)
        elif SCHEDULE_ID_HINT in table_id:
            league.fixtures = _parse_fixtures(rows)

    if not league.standings and not league.fixtures:
        raise LeagueParseError(
            f"neither a standings nor a schedule table found for league {provider_id} — "
            "the page layout has probably changed"
        )
    return league


def _parse_standings(rows: list[list[str]]) -> list[Standing]:
    if not rows:
        return []
    header = [c.upper() for c in rows[0]]
    idx = {name: i for i, name in enumerate(header) if name}

    def cell(row: list[str], key: str) -> str:
        i = idx.get(key)
        return row[i] if i is not None and i < len(row) else ""

    out: list[Standing] = []
    for position, row in enumerate(rows[1:], start=1):
        team = row[0].strip() if row else ""
        # The first column holds the team; a numeric one means a rank prefix.
        if not team or _int(team) is not None:
            team = row[1].strip() if len(row) > 1 else team
        if not team:
            continue
        out.append(
            Standing(
                position=position, team=team,
                gp=_int(cell(row, "GP")), w=_int(cell(row, "W")),
                l=_int(cell(row, "L")), t=_int(cell(row, "T")),
                gf=_int(cell(row, "GF")), ga=_int(cell(row, "GA")),
                pts=_int(cell(row, "PTS")), gd=_int(cell(row, "GD")),
                wp=_float(cell(row, "WP")),
            )
        )
    return out


#: Scores print as "6 - 3". A colon is deliberately NOT a separator: kick-off
#: times like "6:30" would otherwise parse as a 6-30 scoreline.
#: The en dash is deliberate — the page uses both it and a hyphen.
_SCORE = re.compile(r"^\s*(\d{1,3})\s*[-–]\s*(\d{1,3})\s*$")

#: Dates print as "Mon-Jul 20" — weekday, month, day, and no year at all.
_DATE_MD = re.compile(r"([A-Za-z]{3,})[\s-]+(\d{1,2})\b")
_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun",
     "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}


def _parse_fixtures(rows: list[list[str]]) -> list[Fixture]:
    """Columns are Date | Home | score-or-'vs' | Away | Time/Status.

    Indexed off the header rather than by squeezing out blanks: the middle
    column is empty before a match is played and holds the score afterwards,
    so positional filtering silently shifts the away team into the score slot.
    """
    if not rows:
        return []

    header = [c.strip().lower() for c in rows[0]]

    def col(*names: str, default: int | None = None) -> int | None:
        for name in names:
            if name in header:
                return header.index(name)
        return default

    i_date = col("date", default=1)
    i_home = col("home", default=2)
    i_away = col("away", default=4)
    i_time = col("time/status", "time", "status", default=4)
    i_venue = col("venue", default=None)
    # The unnamed column between home and away carries the score.
    i_score = next(
        (i for i in range(len(header)) if not header[i] and i_home is not None
         and i_away is not None and i_home < i < i_away),
        None,
    )

    def at(row: list[str], i: int | None) -> str:
        return row[i].strip() if i is not None and i < len(row) else ""

    out: list[Fixture] = []
    for row in rows[1:]:
        home, away = at(row, i_home), at(row, i_away)
        if not home or not away:
            continue

        time_text = at(row, i_time)
        score = _SCORE.match(at(row, i_score))
        home_score = int(score.group(1)) if score else None
        away_score = int(score.group(2)) if score else None

        out.append(
            Fixture(
                date=_parse_date(at(row, i_date)),
                time_text=time_text, home=home, away=away,
                home_score=home_score, away_score=away_score,
                played=score is not None or time_text.lower() == 'complete',
                venue=at(row, i_venue) or None,
            )
        )
    return out


def _parse_date(text: str, today: date | None = None) -> str | None:
    """'Mon-Jul 20' or '8/4/2026' -> local YYYY-MM-DD.

    The schedule omits the year entirely, so it is inferred: a date more than
    six months away in either direction is assumed to belong to the adjacent
    year. That keeps a December fixture read in January from landing eleven
    months in the future.
    """
    text = (text or "").strip()
    if not text:
        return None

    explicit = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", text)
    if explicit:
        month, day, year = (int(g) for g in explicit.groups())
        year += 2000 if year < 100 else 0
        try:
            return date(year, month, day).isoformat()
        except ValueError:
            return None

    m = _DATE_MD.search(text)
    if not m:
        return None
    month = _MONTHS.get(m.group(1)[:3].lower())
    if not month:
        return None
    day = int(m.group(2))

    today = today or date.today()
    for year in (today.year, today.year - 1, today.year + 1):
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if abs((candidate - today).days) <= 183:
            return candidate.isoformat()
    return None


# --- DaySmart ---------------------------------------------------------------
#
# The DaySmart "Dash" member app is a single-page app over a public JSON:API, and
# the app is the only thing on the site that shows a schedule. There is no
# standings endpoint — Dash builds the table in the browser from the events —
# so this does the same, by the rule Dash prints under its table: three points
# for a win, one for a draw, ranked by points, goal difference, wins, goals
# for. Every figure here is therefore derived from the fixtures on the same
# card, which is the one property the ezleagues tables cannot promise.
#
# A league id is prefixed (`daysmart:<id>`) so it can never collide with an
# ezleagues id in the same column, and so the provider is readable off the
# row rather than guessed from the URL.

DAYSMART_API = "https://api.daysmartrecreation.com/v1/"
#: The venue's Dash slug (`apps.daysmartrecreation.com/dash/x/<company>/...`),
#: its facility id inside that company, and how the venue is named on a league
#: card. Environment, for the same reason as the ezleagues host above.
DAYSMART_COMPANY = os.environ.get("LEDGER_DAYSMART_COMPANY", "example")
DAYSMART_FACILITY = os.environ.get("LEDGER_DAYSMART_FACILITY", "1")
DAYSMART_PROGRAM = os.environ.get("LEDGER_DAYSMART_PROGRAM", "1")     # the adult-leagues program
DAYSMART_PREFIX = "daysmart:"
DAYSMART_PAGE = f"https://apps.daysmartrecreation.com/dash/x/{DAYSMART_COMPANY}/leagues/{{id}}"
DAYSMART_PLACE = os.environ.get("LEDGER_DAYSMART_PLACE", "Indoor venue")
#: Pages of 200. A season is ~50 games; this is a guard, not a budget.
_DAYSMART_MAX_PAGES = 20


def is_daysmart(provider_id: str) -> bool:
    return str(provider_id).startswith(DAYSMART_PREFIX)


def daysmart_id(provider_id: str) -> str:
    return str(provider_id).removeprefix(DAYSMART_PREFIX)


def get_json(path: str, **params: str) -> dict[str, Any]:
    """One GET against the DaySmart API, as the Dash app makes it."""
    query = urllib.parse.urlencode({**params, "company": DAYSMART_COMPANY})
    req = urllib.request.Request(
        f"{DAYSMART_API}{path}?{query}",
        headers={"User-Agent": UA, "Accept": "application/vnd.api+json"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        return json.loads(res.read().decode("utf-8"))


def _paged(get, path: str, params: dict[str, str]) -> tuple[list[dict], list[dict]]:
    """Every `data` and `included` record across all pages of one query.

    Paged by number rather than by following `links.next`: the link the API
    returns points at a different path prefix and drops the company parameter,
    so it is not a URL that can be trusted to work.
    """
    data: list[dict] = []
    included: list[dict] = []
    for number in range(1, _DAYSMART_MAX_PAGES + 1):
        body = get(path, **params, **{"page[number]": str(number), "page[size]": "200"})
        data.extend(body.get("data") or [])
        included.extend(body.get("included") or [])
        page = (body.get("meta") or {}).get("page") or {}
        if number >= int(page.get("last-page") or 1):
            break
    return data, included


def _kickoff(start: str) -> str:
    """'2026-09-17T19:00:00' -> '7:00 PM', the shape ezleagues prints."""
    try:
        return datetime.fromisoformat(start).strftime("%I:%M %p").lstrip("0")
    except ValueError:
        return start


def daysmart_league(league_id: str, get=None) -> League:
    """The league, its active teams, and every published game between them."""
    get = get or get_json
    provider_id = DAYSMART_PREFIX + str(league_id)
    url = DAYSMART_PAGE.format(id=league_id)

    head = get(f"leagues/{league_id}", include="season,facility,sport",
               **{"fields[seasons]": "name", "fields[facilities]": "name",
                  "fields[sports]": "name"})
    attrs = (head.get("data") or {}).get("attributes") or {}
    if not attrs.get("name"):
        raise LeagueParseError(
            f"DaySmart returned no league for id {league_id} — "
            "the API has probably changed"
        )

    def first(kind: str) -> str | None:
        return next(
            (i.get("attributes", {}).get("name") for i in head.get("included") or []
             if i.get("type") == kind),
            None,
        )
    season = first("seasons")
    name = " - ".join(x for x in (attrs["name"], season, DAYSMART_PLACE) if x)
    # The field names carry no indoor/outdoor word of their own ("Yellow
    # Field"); the sport does ("Soccer, Indoor"), and the venue badge keys
    # off that word, so it is carried onto every fixture.
    sport = first("sports") or ""
    sport_l = sport.lower()
    surface = "indoor" if "indoor" in sport_l else "outdoor" if "outdoor" in sport_l else ""
    home_facility = str(attrs.get("facility_id") or "")

    # Inactive teams are ones that withdrew before playing; Dash hides them and
    # so does this — a team with no games on the ladder is a ghost row.
    teams, _ = _paged(get, "teams", {
        "filter[league_id]": str(league_id), "filter[status]": "active",
        "fields[teams]": "name,status",
    })
    names = {str(t["id"]): t["attributes"]["name"] for t in teams}

    # The same query the Dash page makes. `league_id` is null on the events
    # themselves; they belong to a league through the teams playing them.
    events, included = _paged(get, "events", {
        "sort": "start", "include": "resource.facility",
        "filter[or][homeTeam.league_id]": str(league_id),
        "filter[or][visitingTeam.league_id]": str(league_id),
        "filter[or][league_id]": str(league_id),
        "filter[publish]": "true",
    })
    fields = {
        str(i["id"]): (i.get("attributes") or {})
        for i in included if i.get("type") == "resources"
    }
    buildings = {
        str(i["id"]): (i.get("attributes") or {}).get("name")
        for i in included if i.get("type") == "facilities"
    }

    def venue_of(resource_id) -> str | None:
        """'Yellow Field (indoor)', naming the building only when it is not
        the league's own — one of the eight games is across town."""
        field = fields.get(str(resource_id)) or {}
        if not field.get("name"):
            return None
        out = field["name"]
        building = str(field.get("facility_id") or "")
        if building and building != home_facility and buildings.get(building):
            out += f", {buildings[building]}"
        return f"{out} ({surface})" if surface else out

    fixtures: list[Fixture] = []
    for e in events:
        a = e.get("attributes") or {}
        home = names.get(str(a.get("hteam_id")))
        away = names.get(str(a.get("vteam_id")))
        if not home or not away:
            continue
        hs, vs = a.get("home_score"), a.get("visiting_score")
        played = hs is not None and vs is not None
        start = a.get("start") or ""
        time_text = "Complete" if played else _kickoff(start)
        sub = a.get("sub_type") or "regular"
        if sub != "regular":
            time_text = f"{time_text} · {sub}"
        fixtures.append(Fixture(
            date=start[:10] or None, time_text=time_text, home=home, away=away,
            home_score=hs, away_score=vs, played=played,
            venue=venue_of(a.get("resource_id")),
        ))

    if not names and not fixtures:
        raise LeagueParseError(
            f"neither teams nor games found for DaySmart league {league_id} — "
            "the API has probably changed"
        )
    return League(
        provider_id=provider_id, url=url, name=name,
        standings=table_from_fixtures(names.values(), fixtures),
        fixtures=fixtures,
    )


def table_from_fixtures(teams, fixtures: list[Fixture]) -> list[Standing]:
    """Dash's table, by Dash's rule: W 3, D 1; points, GD, wins, GF."""
    rows: dict[str, dict[str, int]] = {
        t: {"gp": 0, "w": 0, "l": 0, "t": 0, "gf": 0, "ga": 0} for t in teams
    }
    for f in fixtures:
        if not f.played or f.home_score is None or f.away_score is None:
            continue
        for team, gf, ga in ((f.home, f.home_score, f.away_score),
                             (f.away, f.away_score, f.home_score)):
            r = rows.setdefault(team, {"gp": 0, "w": 0, "l": 0, "t": 0, "gf": 0, "ga": 0})
            r["gp"] += 1
            r["gf"] += gf
            r["ga"] += ga
            r["w" if gf > ga else "l" if gf < ga else "t"] += 1

    def key(item):
        name, r = item
        return (-(3 * r["w"] + r["t"]), -(r["gf"] - r["ga"]), -r["w"], -r["gf"], name.lower())

    return [
        Standing(
            position=i, team=name, gp=r["gp"], w=r["w"], l=r["l"], t=r["t"],
            gf=r["gf"], ga=r["ga"], pts=3 * r["w"] + r["t"], gd=r["gf"] - r["ga"],
            wp=round(r["w"] / r["gp"], 3) if r["gp"] else None,
        )
        for i, (name, r) in enumerate(sorted(rows.items(), key=key), start=1)
    ]


def daysmart_listing(get=None) -> list[tuple[str, str]]:
    """Every adult league the DaySmart venue publishes: `(provider_id, league_id)`."""
    data, _ = _paged(get or get_json, "leagues", {
        "sort": "start_date", "fields[leagues]": "name,start_date",
        "filter[visible_online]": "true",
        "filter[program_id]": DAYSMART_PROGRAM,
        "filter[facility_id__in]": DAYSMART_FACILITY,
    })
    return [(DAYSMART_PREFIX + str(lg["id"]), str(lg["id"])) for lg in data]


# --- persistence ----------------------------------------------------------


def upsert(conn: sqlite3.Connection, league: League, my_team: str, fixture: str) -> int:
    now = datetime.now(UTC).isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO league (provider_id, name, my_team, fixture, url, fetched_at, path) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(provider_id) DO UPDATE SET "
        "  name = excluded.name, my_team = excluded.my_team, "
        "  fixture = excluded.fixture, url = excluded.url, "
        "  fetched_at = excluded.fetched_at, path = excluded.path",
        (league.provider_id, league.name, my_team, fixture, league.url, now,
         _path_for(league)),
    )
    league_id = int(
        conn.execute(
            "SELECT id FROM league WHERE provider_id = ?", (league.provider_id,)
        ).fetchone()["id"]
    )

    # Standings are a snapshot: replace wholesale so a team leaving the league
    # does not linger as a ghost row.
    conn.execute("DELETE FROM league_standing WHERE league_id = ?", (league_id,))
    conn.executemany(
        "INSERT INTO league_standing "
        "(league_id, position, team, gp, w, l, t, gf, ga, pts, gd, wp) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (league_id, s.position, s.team, s.gp, s.w, s.l, s.t,
             s.gf, s.ga, s.pts, s.gd, s.wp)
            for s in league.standings
        ],
    )

    for f in league.fixtures:
        conn.execute(
            "INSERT INTO league_fixture "
            "(league_id, date, time_text, home, away, home_score, away_score, "
            " played, venue) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(league_id, date, home, away) DO UPDATE SET "
            "  time_text = excluded.time_text, home_score = excluded.home_score, "
            "  away_score = excluded.away_score, played = excluded.played, "
            "  venue = COALESCE(excluded.venue, league_fixture.venue)",
            (league_id, f.date, f.time_text, f.home, f.away,
             f.home_score, f.away_score, int(f.played), f.venue),
        )
    return league_id


def refresh(conn: sqlite3.Connection, provider_id: str, my_team: str,
            fixture: str, path: str | None = None) -> League:
    if is_daysmart(provider_id):
        league = daysmart_league(daysmart_id(provider_id))
    else:
        url = BASE.format(path=path or provider_id)
        league = parse(fetch(provider_id, url), provider_id, url)
    upsert(conn, league, my_team, fixture)
    return league


def read(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Everything the UI needs: table, results, and what is still to come."""
    out: list[dict[str, Any]] = []
    # Current seasons only. An archived league keeps every result it ever had —
    # the Week and Soccer pages still reconcile against those sessions — but
    # the Leagues cards are about the season being played now, and a finished
    # table sitting beside a live one reads as two live ones.
    # Coed first, then men's: the order the cards have always sat in. By row
    # id, a fixture that rolled to a new season would jump below one that had
    # not, and the cards swapped places the day the fall coed league arrived.
    rows = sorted(
        conn.execute("SELECT * FROM league WHERE archived_at IS NULL"),
        key=lambda r: (FIXTURE_ORDER.get(r["fixture"], len(FIXTURE_ORDER)), r["id"]),
    )
    for lg in rows:
        standings = [
            dict(r)
            for r in conn.execute(
                "SELECT position, team, gp, w, l, t, gf, ga, pts, gd, wp "
                "FROM league_standing WHERE league_id = ? ORDER BY position",
                (lg["id"],),
            )
        ]
        fixtures = [
            dict(r)
            for r in conn.execute(
                "SELECT date, time_text, home, away, home_score, away_score, "
                "       played, venue "
                "FROM league_fixture WHERE league_id = ? ORDER BY date, home",
                (lg["id"],),
            )
        ]
        mine = lg["my_team"].lower()
        by_team = {s["team"].lower(): s for s in standings}
        dates = sorted(f["date"] for f in fixtures if f["date"])
        logged = _logged_by_date(conn, lg["fixture"], dates[0] if dates else None,
                                 dates[-1] if dates else None)
        out.append(
            {
                "provider_id": lg["provider_id"],
                "name": lg["name"],
                "my_team": lg["my_team"],
                "fixture": lg["fixture"],
                "url": lg["url"],
                "fetched_at": lg["fetched_at"],
                "standings": standings,
                # Before anyone has played, the "position" is the order the
                # teams were listed in. None, so the card says "12 teams"
                # rather than "3rd of 12".
                "my_position": next(
                    (s["position"] for s in standings if s["team"].lower() == mine), None
                ) if any(s["gp"] for s in standings) else None,
                "fixtures": fixtures,
                "my_fixtures": [
                    _with_opponent(f, lg["my_team"], by_team, fixtures, logged)
                    for f in fixtures
                    if mine in (f["home"] or "").lower()
                    or mine in (f["away"] or "").lower()
                ],
            }
        )
    return out


def _logged_by_date(
    conn: sqlite3.Connection, fixture: str | None, start: str | None, end: str | None,
) -> dict[str, dict[str, int]]:
    """What the log holds for one fixture, by date: games, goals, assists.

    Read through `views.soccer()` — the same resolution of which fixture a
    session belongs to that the Soccer page uses — so a goal shown beside a
    league fixture is the goal shown in the Matches table. Two logged games on
    one date (it happens) add up.
    """
    from ledger.report import views  # here, not at the top: views imports nothing from this module

    out: dict[str, dict[str, int]] = {}
    if not (start and end and fixture):
        return out
    for g in views.soccer(conn, start, end).get("games", []):
        if g.get("pickup") or g.get("fixture") != fixture:
            continue
        row = out.setdefault(g["date"], {"games": 0, "goals": 0, "assists": 0})
        row["games"] += 1
        row["goals"] += int(g.get("goals") or 0)
        row["assists"] += int(g.get("assists") or 0)
    return out


def _with_opponent(
    f: dict[str, Any], my_team: str, by_team: dict[str, Any], fixtures: list[dict[str, Any]],
    logged: dict[str, dict[str, int]] | None = None,
) -> dict[str, Any]:
    """Attach the other side's league row, so a match can be read in context
    rather than as a bare name. Shared by the live cards and the seasons."""
    mine = my_team.lower()
    home = mine in (f["home"] or "").lower()
    opponent = (f["away"] if home else f["home"]) or ""
    row = by_team.get(opponent.lower())
    return {
        **f,
        "home_game": home,
        "opponent": opponent,
        "opponent_standing": dict(row) if row else None,
        "opponent_note": describe_opponent(dict(row) if row else None, opponent, fixtures, my_team),
        # Your own line for the game, from the log, or None when nothing was
        # logged that day — which the card says, rather than showing a zero.
        "logged": (logged or {}).get(f["date"]),
    }


def _path_for(league: League) -> str | None:
    """What `refresh` needs beyond the id: the ezleagues slug, or the bare
    DaySmart league id (which `refresh` derives from the provider id anyway —
    stored so the row reads the same way whichever provider it came from)."""
    if is_daysmart(league.provider_id):
        return daysmart_id(league.provider_id)
    return _path_of(league.url)


def _path_of(url: str) -> str | None:
    """The `{id}/{slug}` tail of a league URL, which is what `BASE` wants."""
    marker = "/leagues/"
    if marker not in url:
        return None
    return url.split(marker, 1)[1].removesuffix(".aspx") or None


def configured(conn: sqlite3.Connection) -> list[dict[str, str]]:
    """The current season of each fixture — the database, or the seeds.

    The seeds are a first-run convenience and nothing more. As soon as a league
    row exists it is the authority, so `discover()` moving a fixture to a new
    season survives a restart and does not have to fight a constant.
    """
    rows = list(
        conn.execute(
            "SELECT provider_id, my_team, fixture, url, path FROM league "
            "WHERE archived_at IS NULL ORDER BY id"
        )
    )
    if not rows:
        return [dict(spec) for spec in DEFAULT_LEAGUES]
    return [
        {
            "provider_id": r["provider_id"],
            "my_team": r["my_team"],
            "fixture": r["fixture"],
            "path": r["path"] or _path_of(r["url"] or "") or r["provider_id"],
        }
        for r in rows
    ]


def listing(url: str = LISTING_URL) -> list[tuple[str, str]]:
    """Every `(provider_id, path)` the venue currently publishes."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        page = resp.read().decode("utf-8", "replace")
    seen: dict[str, str] = {}
    for provider_id, slug in LISTING_RE.findall(page):
        if slug and provider_id not in seen:
            seen[provider_id] = f"{provider_id}/{slug}"
    return sorted(seen.items())


def same_team(printed: str, wanted: str) -> bool:
    """Is the name on a league page our team?

    Exact, ignoring case and punctuation — with one allowance: a single
    typing slip. The venue once entered the coed team with one letter dropped
    for a new season after two seasons spelt right, and discovery sat on
    the finished summer league for three days while the new season played.
    One transposition, one substitution, one extra or missing letter, and
    nothing more: a team whose name shares a word but differs by six letters stays a stranger.
    Short names get no allowance at all — a one-letter slip on "FC A" is
    a different team.
    """
    a = re.sub(r"[^a-z0-9]", "", (printed or "").lower())
    b = re.sub(r"[^a-z0-9]", "", (wanted or "").lower())
    if a == b:
        return True
    if min(len(a), len(b)) < 8:
        return False
    return _edit_distance(a, b) <= 1


def _edit_distance(a: str, b: str) -> int:
    """Damerau-Levenshtein: insert, delete, substitute, or swap neighbours."""
    prev2: list[int] | None = None
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if prev2 is not None and i > 1 and j > 1 \
                    and ca == b[j - 2] and a[i - 2] == cb:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        prev2, prev = prev, cur
    return prev[len(b)]


def _last_date(fixtures: list[Fixture]) -> str | None:
    dates = sorted(f.date for f in fixtures if f.date)
    return dates[-1] if dates else None


def season_over(conn: sqlite3.Connection, provider_id: str,
                *, today: str | None = None) -> bool:
    """Has this league's last scheduled game already happened?

    The trigger for looking for a new season, and the reason discovery is not
    fifteen page fetches every night: while a season is running there is
    nothing to look for.
    """
    today = today or date.today().isoformat()
    row = conn.execute(
        "SELECT MAX(date) AS last FROM league_fixture f "
        "JOIN league l ON l.id = f.league_id WHERE l.provider_id = ?",
        (provider_id,),
    ).fetchone()
    last = row["last"] if row else None
    return bool(last) and last < today


def discover(conn: sqlite3.Connection, *, today: str | None = None,
             fetcher=None, getter=None) -> list[dict[str, str]]:
    """Move a fixture onto its new season, when there is one.

    Runs only for a fixture whose season is over, and switches only to a league
    whose standings actually contain the team. That second rule is the whole
    safety of this: the ezleagues venue runs a Coed 30+ division alongside the
    Coed Open one on the same nights, so matching on the division's *name* —
    "the newest league with Coed in it" — would eventually attach the wrong
    league and start reporting somebody else's results as yours. Being in the
    table is not a guess.

    Returns one record per switch. Nothing is switched silently: `refresh_all`
    reports these and the CLI prints them.

    A fixture stays with its provider: an ezleagues season is succeeded by an
    ezleagues season, a DaySmart one by a DaySmart one. The one move between
    providers — men's league leaving the ezleagues venue for the DaySmart one — was made by
    hand (migration 013), because the team had a different name at each venue
    and no rule could have found it.
    """
    today = today or date.today().isoformat()
    fetch_page = fetcher or (lambda pid, url: fetch(pid, url))

    known = {
        r["provider_id"]
        for r in conn.execute("SELECT provider_id FROM league")
    }
    switches: list[dict[str, str]] = []

    stale = [c for c in configured(conn)
             if season_over(conn, c["provider_id"], today=today)]
    if not stale:
        return switches

    # Parse each unknown league once, not once per fixture — and only read a
    # provider's listing when one of its fixtures actually needs a successor.
    parsed: dict[str, League] = {}
    if any(not is_daysmart(c["provider_id"]) for c in stale):
        for pid, path in listing():
            if pid in known:
                continue
            url = BASE.format(path=path)
            try:
                parsed[pid] = parse(fetch_page(pid, url), pid, url)
            except Exception:
                # A league page that will not parse is not a reason to abandon
                # the search; the next one may be the right one.
                continue
    if any(is_daysmart(c["provider_id"]) for c in stale):
        get = getter or get_json
        for pid, league_id in daysmart_listing(get):
            if pid in known:
                continue
            try:
                parsed[pid] = daysmart_league(league_id, get)
            except Exception:
                continue
    if not parsed:
        return switches

    for spec in stale:
        team = spec["my_team"]
        # The season being replaced. A successor has to run LATER than this —
        # the first live run of this code moved the men's fixture from Summer
        # back to the *Spring* session, because the old men's team is in that
        # table too and the venue still publishes it. Being in the standings
        # says "your league"; only the date says "your next league".
        current_end = conn.execute(
            "SELECT MAX(date) AS last FROM league_fixture f "
            "JOIN league l ON l.id = f.league_id WHERE l.provider_id = ?",
            (spec["provider_id"],),
        ).fetchone()["last"] or ""

        mine = [
            lg for lg in parsed.values()
            if is_daysmart(lg.provider_id) == is_daysmart(spec["provider_id"])
            and any(same_team(st.team, team) for st in lg.standings)
            and (_last_date(lg.fixtures) or "") > current_end
        ]
        if not mine:
            continue
        # The one that runs latest. Two seasons could both qualify if a listing
        # lags; the later one is the new one.
        mine.sort(key=lambda lg: (_last_date(lg.fixtures) or "", lg.provider_id))
        winner = mine[-1]
        # Stored under the name the new page prints, not the name we were
        # looking for: every match against standings and fixtures from here on
        # is exact, and the misspelt name is what that season's sheet says.
        team = next(st.team for st in winner.standings if same_team(st.team, team))

        now = datetime.now(UTC).isoformat(timespec="seconds")
        conn.execute(
            "UPDATE league SET archived_at = ? WHERE provider_id = ? "
            "AND archived_at IS NULL",
            (now, spec["provider_id"]),
        )
        upsert(conn, winner, team, spec["fixture"])
        conn.execute(
            "UPDATE league SET path = ?, archived_at = NULL WHERE provider_id = ?",
            (_path_for(winner), winner.provider_id),
        )
        switches.append({
            "fixture": spec["fixture"],
            "my_team": team,
            "from": spec["provider_id"],
            "to": winner.provider_id,
            "name": winner.name,
        })
    return switches


def refresh_all(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    """Refresh every configured league. Returns (team, outcome) per league.

    One league failing must not stop the other: a season page can 404 the day
    a session ends, and a stale table beats a blank screen.
    """
    out: list[tuple[str, str]] = []

    # A finished season may have been replaced since last night. Look first, so
    # the refresh below lands on the new league rather than scraping a page
    # that stopped changing in September.
    try:
        for switch in discover(conn):
            out.append((
                switch["my_team"],
                f"new season: {switch['from']} -> {switch['to']} · {switch['name']}",
            ))
    except Exception as exc:
        out.append(("season check", f"failed: {type(exc).__name__}: {exc}"))

    for spec in configured(conn):
        try:
            lg = refresh(conn, spec["provider_id"], spec["my_team"],
                         spec["fixture"], spec.get("path"))
            played = sum(1 for f in lg.fixtures if f.played)
            note = "" if not season_over(conn, spec["provider_id"]) else " · season over"
            out.append((
                spec["my_team"],
                f"{len(lg.standings)} teams, {len(lg.fixtures)} fixtures "
                f"({played} played){note}",
            ))
        except Exception as exc:
            out.append((spec["my_team"], f"failed: {type(exc).__name__}: {exc}"))
    return out


def describe_opponent(
    standing: dict[str, Any] | None,
    opponent: str,
    fixtures: list[dict[str, Any]],
    my_team: str,
) -> str | None:
    """A couple of factual sentences about who is next.

    Record, then how they score and concede, then any previous meeting. No
    adjectives about how the game will go — the numbers carry it, and a
    prediction is the one thing this cannot honestly offer.
    """
    if not standing:
        return f"{opponent} are not in the table yet." if opponent else None

    bits: list[str] = []
    played = standing.get("gp") or 0
    w = standing.get("w") or 0
    lost = standing.get("l") or 0
    t = standing.get("t") or 0
    pos, pts = standing.get("position"), standing.get("pts")

    if played:
        record = f"{w}W {lost}L" + (f" {t}D" if t else "")
        if lost == 0 and played >= 2:
            bits.append(f"{_ordinal(pos)}, unbeaten in {played} ({record}, {pts} pts).")
        elif w == 0 and played >= 2:
            bits.append(f"{_ordinal(pos)}, still looking for a win ({record}, {pts} pts).")
        else:
            bits.append(f"{_ordinal(pos)} on {pts} pts, {record} from {played}.")

        gf, ga = standing.get("gf"), standing.get("ga")
        if gf is not None and ga is not None:
            bits.append(
                f"They score {gf / played:.1f} and concede {ga / played:.1f} a game."
            )
    else:
        # No ordinal: before a ball is kicked the "position" is the order the
        # teams were listed in, and calling that 10th would be a claim.
        bits.append("No games played yet.")

    if meeting := _last_meeting(fixtures, my_team, opponent):
        bits.append(meeting)

    return " ".join(bits)


def _last_meeting(
    fixtures: list[dict[str, Any]], my_team: str, opponent: str
) -> str | None:
    """How the previous meeting went, stated flat either way."""
    mine, theirs = my_team.lower(), opponent.lower()
    past = [
        f for f in fixtures
        if f.get("played") and f.get("home_score") is not None
        and {(f["home"] or "").lower(), (f["away"] or "").lower()} == {mine, theirs}
    ]
    if not past:
        return "You have not played them yet this season."

    last = sorted(past, key=lambda f: f.get("date") or "")[-1]
    home = (last["home"] or "").lower() == mine
    ours = last["home_score"] if home else last["away_score"]
    yours = last["away_score"] if home else last["home_score"]

    if ours > yours:
        outcome = f"You won {ours}-{yours}"
    elif ours < yours:
        outcome = f"They won {yours}-{ours}"
    else:
        outcome = f"You drew {ours}-{yours}"
    if len(past) == 1:
        return f"{outcome} last time."
    return f"{outcome} in the most recent of {len(past)} meetings."


def _ordinal(n: int | None) -> str:
    if not n:
        return "Unplaced"
    suffix = "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


# --- moving by hand, and the seasons on record ------------------------------


def move(conn: sqlite3.Connection, fixture: str, target: str, *,
         fetcher=None, getter=None) -> dict[str, str]:
    """Move a fixture onto a league named by hand.

    `discover()` finds a successor through the venue's listing page, and in
    November 2026 that page turned into a facility search with no league on
    it, so a new session has to be pointed at. `target` is the league page's
    URL, its `{id}/{slug}` path, or `daysmart:<id>`.

    The one rule discovery lives by still holds here: the team has to be in
    the new league's standings, or nothing moves. The old season is archived,
    never deleted, exactly as `discover()` does it.
    """
    spec = next((c for c in configured(conn) if c["fixture"] == fixture), None)
    if spec is None:
        raise ValueError(f"no current season for fixture {fixture!r}")
    target = target.strip()
    if is_daysmart(target):
        league = daysmart_league(daysmart_id(target), getter or get_json)
    else:
        path = _path_of(target) if "/leagues/" in target else target.removesuffix(".aspx")
        if not path:
            raise ValueError(f"cannot read a league from {target!r}")
        pid = path.split("/", 1)[0]
        url = BASE.format(path=path)
        league = parse((fetcher or fetch)(pid, url), pid, url)
    if league.provider_id == spec["provider_id"]:
        raise ValueError(f"{league.provider_id} is already the current {fixture} season")
    team = next((st.team for st in league.standings if same_team(st.team, spec["my_team"])), None)
    if team is None:
        raise ValueError(
            f"{spec['my_team']} is not in the standings of {league.name!r} — not moving"
        )

    now = datetime.now(UTC).isoformat(timespec="seconds")
    conn.execute(
        "UPDATE league SET archived_at = ? WHERE provider_id = ? AND archived_at IS NULL",
        (now, spec["provider_id"]),
    )
    upsert(conn, league, team, fixture)
    conn.execute(
        "UPDATE league SET path = ?, archived_at = NULL WHERE provider_id = ?",
        (_path_for(league), league.provider_id),
    )
    return {
        "fixture": fixture, "my_team": team,
        "from": spec["provider_id"], "to": league.provider_id, "name": league.name,
    }


def seasons(conn: sqlite3.Connection, *, today: str | None = None) -> list[dict[str, Any]]:
    """Every season on record, newest first.

    An archived season carries the table as it stood when it was replaced —
    its final table — and the one being played carries the table so far. Each
    comes with the team's own row, every result, and what the log holds for
    that fixture inside the season's dates: matches logged, goals, assists.
    The log is read the way the Soccer page reads it, so a goal counted here
    is a goal counted there.
    """
    today = today or date.today().isoformat()
    out: list[dict[str, Any]] = []
    for lg in conn.execute("SELECT * FROM league"):
        mine = lg["my_team"].lower()
        standings = [
            dict(r) for r in conn.execute(
                "SELECT position, team, gp, w, l, t, gf, ga, pts, gd, wp "
                "FROM league_standing WHERE league_id = ? ORDER BY position", (lg["id"],),
            )
        ]
        fixtures = [
            dict(r) for r in conn.execute(
                "SELECT date, time_text, home, away, home_score, away_score, played, venue "
                "FROM league_fixture WHERE league_id = ? ORDER BY date, home", (lg["id"],),
            )
        ]
        by_team = {st["team"].lower(): st for st in standings}
        me = next((st for st in standings if st["team"].lower() == mine), None)
        my_fx = [
            f for f in fixtures
            if mine in (f["home"] or "").lower() or mine in (f["away"] or "").lower()
        ]
        results = []
        for f in my_fx:
            if not f["played"] or f["home_score"] is None or f["away_score"] is None:
                continue
            home = mine in (f["home"] or "").lower()
            gf, ga = ((f["home_score"], f["away_score"]) if home
                      else (f["away_score"], f["home_score"]))
            results.append({
                "date": f["date"], "opponent": f["away"] if home else f["home"],
                "home_game": home, "gf": gf, "ga": ga,
                "result": "W" if gf > ga else "L" if gf < ga else "D",
            })
        dates = sorted(f["date"] for f in fixtures if f["date"])
        start, end = (dates[0], dates[-1]) if dates else (None, None)
        archived = lg["archived_at"] is not None

        by_date = _logged_by_date(conn, lg["fixture"], start, end)
        logged = {
            k: sum(v[k] for v in by_date.values()) for k in ("games", "goals", "assists")
        }

        out.append({
            "provider_id": lg["provider_id"], "name": lg["name"], "fixture": lg["fixture"],
            "my_team": lg["my_team"], "url": lg["url"],
            "archived": archived, "archived_at": lg["archived_at"],
            "start": start, "end": end,
            # Finished: archived, or every one of our fixtures played and the
            # last date behind us. A season with the schedule not yet posted
            # is in progress, not finished.
            "complete": archived or (bool(end) and end < today and bool(my_fx)
                                     and all(f["played"] for f in my_fx)),
            "played": len(results), "scheduled": len(my_fx),
            "position": me["position"] if me and any(st["gp"] for st in standings) else None,
            "teams": len(standings),
            # The whole table and every one of our fixtures, as the live card
            # has them. This is the record; nothing is trimmed from it.
            "standings": standings,
            "my_fixtures": [
                _with_opponent(f, lg["my_team"], by_team, fixtures, by_date) for f in my_fx
            ],
            "record": (
                {k: me.get(k) for k in ("gp", "w", "t", "l", "gf", "ga", "gd", "pts", "wp")}
                if me else None
            ),
            "results": results,
            "logged": logged,
        })
    # The seasons being played first — one with no schedule posted yet is the
    # newest of all — then the finished ones, newest first.
    out.sort(key=lambda x: (not x["complete"], x["end"] or "9999-99-99", x["provider_id"]),
             reverse=True)
    return out
