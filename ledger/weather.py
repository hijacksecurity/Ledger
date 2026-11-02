"""The forecast, from Open-Meteo, for one place set in `.env`.

Not part of the record. Nothing here is stored: a forecast is superseded every
hour, and keeping old ones would turn a planning aid into a second, worse
history beside the one Garmin already keeps per activity. It lives in memory,
is refetched when it goes stale, and is gone on restart.

Why Open-Meteo: free, no key, no account, and sixteen days ahead — the only
free source that covers a whole plan week from any day it is opened. In the
US its default (`best_match`) blends the high-resolution models (HRRR, NBM)
the national forecast is built on, so the near days are as good as any. Past
about seven days every forecast is a rough guide whoever serves it, and the
payload says so per day (`outlook`) rather than leaving it to be guessed.

The location is configuration, never a constant: `LEDGER_WEATHER_LAT` and
`LEDGER_WEATHER_LON`. With either unset, the endpoints answer
`configured: false` and fetch nothing.

Data by Open-Meteo.com, CC BY 4.0. The credit travels in every payload
(`source`) and in the docs. The pages do not print it: this is a private,
single-user app, and keeping vendor names off the screen was the user's
decision, made knowing the licence asks for a credit beside displayed data.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
import urllib.request
from collections import deque
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

URL = "https://api.open-meteo.com/v1/forecast"
UA = "Mozilla/5.0 (compatible; Ledger/1.0; personal training log)"
TIMEOUT = 10

#: How far ahead Open-Meteo forecasts on the free API.
HORIZON_DAYS = 16
#: From this many days ahead, a day is an outlook: worth a glance, not a plan.
OUTLOOK_FROM = 7

#: A forecast younger than this is served as it is. The models behind a US
#: forecast (NCEP HRRR and NBM) publish a run every hour — their metadata says
#: `update_interval_seconds: 3600` — so a quarter of an hour puts a new run on
#: the page within fifteen minutes of it landing, and asking more often would
#: mostly fetch the same run again. At most 96 calls a day.
MAX_AGE_S = 15 * 60
#: Floor between two fetch attempts, successful or not. Without it a source
#: that is down would be asked again on every page open.
MIN_INTERVAL_S = 5 * 60
#: Hard ceiling on attempts in any rolling 24 hours, whatever else goes wrong.
#: Open-Meteo's free tier allows 10,000 a day (5,000 an hour, 600 a minute,
#: per IP); the schedule above uses under 1% of that, and this cap keeps a
#: bug from ever using more than 3%. Past it the last forecast is served,
#: marked stale.
DAILY_CAP = 300

SOURCE = {
    "name": "Open-Meteo",
    "url": "https://open-meteo.com/",
    "licence": "CC BY 4.0",
    "model": "best_match",
}

HOURLY = (
    "temperature_2m", "apparent_temperature", "precipitation_probability",
    "precipitation", "weather_code", "wind_speed_10m", "wind_gusts_10m", "is_day",
)
DAILY = (
    "weather_code", "temperature_2m_max", "temperature_2m_min",
    "apparent_temperature_max", "apparent_temperature_min",
    "precipitation_probability_max", "precipitation_sum",
    "wind_speed_10m_max", "wind_gusts_10m_max", "sunrise", "sunset",
)

UNITS = {
    "imperial": {"temp": "°F", "wind": "mph", "precip": "in",
                 "query": {"temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
                           "precipitation_unit": "inch"}},
    "metric": {"temp": "°C", "wind": "km/h", "precip": "mm",
               "query": {"temperature_unit": "celsius", "wind_speed_unit": "kmh",
                         "precipitation_unit": "mm"}},
}

# --- WMO weather codes ----------------------------------------------------
#
# The code Open-Meteo returns, as a word and an icon key. One table, here, so
# the hour strip, the day grid and the MCP tool all call a code the same thing.
# Icon keys name symbols in the page's sprite (`i-wx-<key>`).

_CODES: dict[int, tuple[str, str]] = {
    0: ("Clear", "clear"),
    1: ("Mostly clear", "partly"),
    2: ("Partly cloudy", "partly"),
    3: ("Overcast", "cloud"),
    45: ("Fog", "fog"),
    48: ("Freezing fog", "fog"),
    51: ("Light drizzle", "drizzle"),
    53: ("Drizzle", "drizzle"),
    55: ("Heavy drizzle", "drizzle"),
    56: ("Freezing drizzle", "sleet"),
    57: ("Freezing drizzle", "sleet"),
    61: ("Light rain", "rain"),
    63: ("Rain", "rain"),
    65: ("Heavy rain", "rain"),
    66: ("Freezing rain", "sleet"),
    67: ("Freezing rain", "sleet"),
    71: ("Light snow", "snow"),
    73: ("Snow", "snow"),
    75: ("Heavy snow", "snow"),
    77: ("Snow grains", "snow"),
    80: ("Showers", "rain"),
    81: ("Showers", "rain"),
    82: ("Heavy showers", "rain"),
    85: ("Snow showers", "snow"),
    86: ("Heavy snow showers", "snow"),
    95: ("Thunderstorm", "storm"),
    96: ("Thunderstorm, hail", "storm"),
    99: ("Thunderstorm, hail", "storm"),
}


def describe(code: int | None, is_day: bool = True) -> tuple[str, str]:
    """(summary, icon) for a WMO code. Clear and partly cloudy have a night
    face, so an hour after dark does not show a sun."""
    if code is None:
        return ("No forecast", "none")
    summary, icon = _CODES.get(int(code), ("Unknown", "cloud"))
    if not is_day and icon in ("clear", "partly"):
        icon = f"{icon}-night"
    return summary, icon


# --- temperature bands ----------------------------------------------------
#
# A temperature is coloured by band so the hours read at a glance — the way a
# weather map is read: blue cold, green mild, orange and red hot. A band is a
# reading of the figure, never a verdict on it; each payload carries the bands
# with their ranges so the page prints the key beside the colours. Bounds are
# set per unit system on round numbers in that unit, so the key never says
# "13.9°C".

#: (key, word, highest value in the band — None for the open top band)
_BANDS = {
    "imperial": [
        ("freezing", "freezing", 32), ("cold", "cold", 45), ("cool", "cool", 57),
        ("mild", "mild", 69), ("warm", "warm", 79), ("hot", "hot", 89),
        ("very-hot", "very hot", None),
    ],
    "metric": [
        ("freezing", "freezing", 0), ("cold", "cold", 7), ("cool", "cool", 14),
        ("mild", "mild", 20), ("warm", "warm", 26), ("hot", "hot", 32),
        ("very-hot", "very hot", None),
    ],
}


def temp_band(value: float | int | None, units: str) -> str | None:
    if value is None:
        return None
    for key, _, top in _BANDS[units]:
        if top is None or value <= top:
            return key
    return None


def bands_of(units: str) -> list[dict[str, Any]]:
    """The key: every band, its word and its range in the unit."""
    sym = UNITS[units]["temp"]
    out = []
    prev = None
    for key, word, top in _BANDS[units]:
        if prev is None:
            rng = f"≤{top}{sym}"
        elif top is None:
            rng = f"{prev + 1}{sym}+"
        else:
            rng = f"{prev + 1}–{top}{sym}"
        out.append({"key": key, "label": word, "range": rng})
        prev = top
    return out


# --- configuration --------------------------------------------------------


@dataclass(frozen=True)
class Place:
    lat: float
    lon: float
    name: str
    units: str  # "imperial" | "metric"


def place_from_env(lat: str | None, lon: str | None, name: str | None,
                   units: str | None) -> Place | None:
    """None when no location is set, which turns the feature off."""
    if not lat or not lon:
        return None
    try:
        la, lo = float(lat), float(lon)
    except ValueError:
        return None
    if not (-90 <= la <= 90 and -180 <= lo <= 180):
        return None
    u = (units or "metric").strip().lower()
    return Place(la, lo, (name or "").strip() or "Home", u if u in UNITS else "metric")


# --- fetching and the cache -----------------------------------------------


class WeatherUnavailable(RuntimeError):
    """No forecast to serve: the fetch failed and nothing was cached."""


def fetch(place: Place) -> dict[str, Any]:
    query = {
        "latitude": f"{place.lat:.4f}",
        "longitude": f"{place.lon:.4f}",
        "timezone": "auto",
        "forecast_days": HORIZON_DAYS,
        "hourly": ",".join(HOURLY),
        "daily": ",".join(DAILY),
        **UNITS[place.units]["query"],
    }
    url = f"{URL}?{urllib.parse.urlencode(query)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        body = json.loads(res.read().decode("utf-8"))
    if not isinstance(body, dict) or "hourly" not in body or "daily" not in body:
        raise ValueError("Open-Meteo answered without a forecast")
    return body


class ForecastCache:
    """One forecast in memory, refetched when stale.

    A failed refetch serves the previous forecast marked `stale` rather than
    nothing: an hour-old forecast is still a forecast. Only a failure with
    nothing cached is an error.
    """

    def __init__(self, fetcher=fetch, clock=time.time):
        self._fetch = fetcher
        self._clock = clock
        self._lock = threading.Lock()
        self._key: Place | None = None
        self._data: dict[str, Any] | None = None
        self._fetched_at: float | None = None
        self._last_attempt: float | None = None
        self._last_error: str | None = None
        self._attempts: deque[float] = deque()

    def reset(self) -> None:
        with self._lock:
            self._key = self._data = self._fetched_at = None
            self._last_attempt = None
            self._last_error = None
            self._attempts.clear()

    def attempts_today(self) -> int:
        """Fetch attempts in the last 24 hours."""
        with self._lock:
            self._expire(self._clock())
            return len(self._attempts)

    def _expire(self, now: float) -> None:
        while self._attempts and now - self._attempts[0] >= 86400:
            self._attempts.popleft()

    def get(self, place: Place) -> tuple[dict[str, Any], float, bool]:
        """(raw forecast, fetched_at epoch seconds, stale)."""
        with self._lock:
            now = self._clock()
            if self._key != place:
                self._key, self._data, self._fetched_at = place, None, None
                self._last_attempt = None
            fresh = self._fetched_at is not None and now - self._fetched_at < MAX_AGE_S
            if fresh:
                return self._data, self._fetched_at, False  # type: ignore[return-value]
            self._expire(now)
            may_try = (
                (self._last_attempt is None or now - self._last_attempt >= MIN_INTERVAL_S)
                and len(self._attempts) < DAILY_CAP
            )
            if may_try:
                self._last_attempt = now
                self._attempts.append(now)
                try:
                    self._data = self._fetch(place)
                    self._fetched_at = now
                    self._last_error = None
                    return self._data, now, False
                except Exception as exc:  # network, HTTP, JSON — all the same here
                    self._last_error = f"{type(exc).__name__}: {exc}"
            if self._data is not None:
                return self._data, self._fetched_at, True  # type: ignore[return-value]
            if not may_try and len(self._attempts) >= DAILY_CAP:
                raise WeatherUnavailable(
                    f"The daily cap of {DAILY_CAP} forecast fetches is reached; "
                    "it frees up as the oldest attempts pass 24 hours")
            raise WeatherUnavailable(
                "The forecast could not be fetched from Open-Meteo"
                + (f" ({self._last_error})" if self._last_error else "")
            )


CACHE = ForecastCache()


# --- shaping --------------------------------------------------------------


def local_now(raw: dict[str, Any], now_utc: datetime | None = None) -> datetime:
    """Wall-clock time at the forecast's place, naive, to compare with the
    naive local timestamps Open-Meteo returns. The zone name first, so a
    daylight-saving change mid-forecast is right; the fixed offset only if the
    zone is unknown to this machine."""
    now_utc = now_utc or datetime.now(UTC)
    try:
        return now_utc.astimezone(ZoneInfo(raw.get("timezone") or "UTC")).replace(tzinfo=None)
    except (ZoneInfoNotFoundError, ValueError):
        offset = timedelta(seconds=int(raw.get("utc_offset_seconds") or 0))
        return (now_utc + offset).replace(tzinfo=None)


def _r(v: Any, dp: int = 0) -> float | int | None:
    if v is None:
        return None
    return round(float(v)) if dp == 0 else round(float(v), dp)


def _hour_label(t: datetime) -> str:
    h = t.hour % 12 or 12
    return f"{h} {'am' if t.hour < 12 else 'pm'}"


def _clock(iso: str | None) -> str | None:
    """'2026-11-01T17:22' -> '5:22 pm'."""
    if not iso:
        return None
    t = datetime.fromisoformat(iso)
    return f"{t.hour % 12 or 12}:{t.minute:02d} {'am' if t.hour < 12 else 'pm'}"


def _short(d: date) -> str:
    return f"{d:%a} {d.day} {d:%b}"


def units_of(place: Place) -> dict[str, str]:
    u = UNITS[place.units]
    return {"system": place.units, "temp": u["temp"], "wind": u["wind"], "precip": u["precip"]}


def _day_row(raw: dict[str, Any], i: int, today: date,
             units: str = "metric") -> dict[str, Any]:
    d = raw["daily"]
    day = date.fromisoformat(d["time"][i])
    lead = (day - today).days
    summary, icon = describe(d["weather_code"][i])
    return {
        "date": day.isoformat(),
        "status": "forecast",
        "lead_days": lead,
        "outlook": lead >= OUTLOOK_FROM,
        "code": d["weather_code"][i],
        "summary": summary,
        "icon": icon,
        "temp_max": _r(d["temperature_2m_max"][i]),
        "temp_band": temp_band(_r(d["temperature_2m_max"][i]), units),
        "temp_min": _r(d["temperature_2m_min"][i]),
        "feels_max": _r(d["apparent_temperature_max"][i]),
        "feels_min": _r(d["apparent_temperature_min"][i]),
        "precip_prob": _r(d["precipitation_probability_max"][i]),
        "precip_level": _pop_level(d["precipitation_probability_max"][i]),
        "precip": _r(d["precipitation_sum"][i], 2),
        "wind_max": _r(d["wind_speed_10m_max"][i]),
        "gust_max": _r(d["wind_gusts_10m_max"][i]),
        "sunrise": d["sunrise"][i],
        "sunset": d["sunset"][i],
        "sunrise_text": _clock(d["sunrise"][i]),
        "sunset_text": _clock(d["sunset"][i]),
    }


def daily(raw: dict[str, Any], start: date, end: date, now: datetime,
          units: str = "metric") -> dict[str, Any]:
    """One row per date in [start, end]. A date the forecast does not cover is
    still a row, with a status saying why — `past` (it has gone by) or
    `beyond` (further out than the forecast reaches) — and no figures, never
    zeroes."""
    today = now.date()
    index = {t: i for i, t in enumerate(raw["daily"]["time"])}
    last = date.fromisoformat(raw["daily"]["time"][-1])
    rows = []
    d = start
    while d <= end:
        i = index.get(d.isoformat())
        if d < today:
            rows.append({"date": d.isoformat(), "status": "past", "lead_days": (d - today).days})
        elif i is None:
            rows.append({"date": d.isoformat(), "status": "beyond", "lead_days": (d - today).days})
        else:
            rows.append(_day_row(raw, i, today, units))
        d += timedelta(days=1)
    return {"today": today.isoformat(), "reaches": last.isoformat(), "days": rows}


# --- the headline --------------------------------------------------------
#
# The one sentence the hours are read for: is it dry, and if not, from when.
# Worded on the National Weather Service's published scale for probability of
# precipitation, not on a threshold this app chose: below 20% is not mentioned,
# 20% is a slight chance, 30-50% a chance, 60-70% likely, 80% and up is stated
# outright. The NWS works in tens, so the probability is rounded to ten first.

_PRECIP_NOUN = {"snow": "snow", "sleet": "freezing rain", "storm": "storms"}


def _pop_level(p: int | float | None) -> str:
    tens = round((p or 0) / 10) * 10
    if tens < 20:
        return "dry"
    if tens == 20:
        return "slight"
    if tens <= 50:
        return "chance"
    if tens <= 70:
        return "likely"
    return "certain"


_LEVEL_RANK = {"dry": 0, "slight": 1, "chance": 2, "likely": 3, "certain": 4}


def headline(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """{level, text, from} for a run of hourly rows."""
    if not rows:
        return {"level": "dry", "text": "No forecast", "from": None}
    peak = max(rows, key=lambda h: h["precip_prob"] or 0)
    level = _pop_level(peak["precip_prob"])
    n = len(rows)
    if level == "dry":
        return {"level": "dry", "text": f"Dry for the next {n} hour{'s' if n != 1 else ''}",
                "from": None}
    # From the first hour that reaches the peak's level, so "likely from 2 pm"
    # names when it becomes likely, not when it first became possible.
    first = next(h for h in rows if _LEVEL_RANK[_pop_level(h["precip_prob"])] >= _LEVEL_RANK[level])
    noun = _PRECIP_NOUN.get(peak["icon"], "rain")
    when = "now" if first.get("is_now") else f"from {first['label']}"
    text = {
        "slight": f"Slight chance of {noun} {when}",
        "chance": f"Chance of {noun} {when}",
        "likely": f"{noun.capitalize()} likely {when}",
        "certain": f"{noun.capitalize()} {when}",
    }[level]
    return {"level": level, "text": text, "from": first["time"]}


def hourly(raw: dict[str, Any], now: datetime, hours: int,
           units: str = "metric") -> dict[str, Any]:
    """The next `hours` hours, starting with the one in progress."""
    h = raw["hourly"]
    current = now.replace(minute=0, second=0, microsecond=0)
    rows = []
    for i, t in enumerate(h["time"]):
        ts = datetime.fromisoformat(t)
        if ts < current:
            continue
        if len(rows) >= hours:
            break
        is_day = bool(h["is_day"][i])
        summary, icon = describe(h["weather_code"][i], is_day)
        rows.append({
            "time": t,
            "date": ts.date().isoformat(),
            "label": _hour_label(ts),
            "is_now": ts == current,
            "is_day": is_day,
            "code": h["weather_code"][i],
            "summary": summary,
            "icon": icon,
            "temp": _r(h["temperature_2m"][i]),
            "temp_band": temp_band(_r(h["temperature_2m"][i]), units),
            "feels": _r(h["apparent_temperature"][i]),
            "precip_prob": _r(h["precipitation_probability"][i]),
            "precip_level": _pop_level(h["precipitation_probability"][i]),
            "precip": _r(h["precipitation"][i], 2),
            "wind": _r(h["wind_speed_10m"][i]),
            "gust": _r(h["wind_gusts_10m"][i]),
        })
    # Today's day row rides along: the high, the low and the light are what
    # the hours are read against.
    today = now.date()
    days = raw["daily"]["time"]

    def row_for(d: date) -> dict[str, Any] | None:
        key = d.isoformat()
        return _day_row(raw, days.index(key), today, units) if key in days else None

    return {"today": row_for(today), "tomorrow": row_for(today + timedelta(days=1)),
            "headline": headline(rows), "hours": rows}


def hourly_timeframe(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"from": None, "to": None, "label": "no forecast", "grain": "hour",
                "periods": 0, "all_time": False, "as_of": None}
    a = datetime.fromisoformat(rows[0]["time"])
    b = datetime.fromisoformat(rows[-1]["time"])
    return {
        "from": rows[0]["time"], "to": rows[-1]["time"],
        "label": f"forecast · next {len(rows)} hours · {_hour_label(a)} {_short(a.date())} "
                 f"to {_hour_label(b)} {_short(b.date())}",
        "grain": "hour", "periods": len(rows), "all_time": False, "as_of": None,
    }


def daily_timeframe(start: date, end: date) -> dict[str, Any]:
    if start.month == end.month and start.year == end.year:
        span = f"{start:%a} {start.day} to {end:%a} {end.day} {end:%b} {end.year}"
    else:
        span = f"{_short(start)} to {_short(end)} {end.year}"
    n = (end - start).days + 1
    return {
        "from": start.isoformat(), "to": end.isoformat(),
        "label": f"forecast · {n} day{'s' if n != 1 else ''} · {span}",
        "grain": "day", "periods": n, "all_time": False, "as_of": None,
    }


def envelope(place: Place, fetched_at: float, stale: bool) -> dict[str, Any]:
    """What every weather payload carries besides its rows."""
    return {
        "configured": True,
        "place": place.name,
        "units": units_of(place),
        "bands": bands_of(place.units),
        "fetched_at": datetime.fromtimestamp(fetched_at, UTC).isoformat(timespec="seconds"),
        "stale": stale,
        "source": SOURCE,
    }


NOT_CONFIGURED = {
    "configured": False,
    "note": "No location is set. Put LEDGER_WEATHER_LAT and LEDGER_WEATHER_LON in .env "
            "and restart the app.",
    "source": SOURCE,
}
