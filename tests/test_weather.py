"""The forecast: shaping Open-Meteo's payload, the cache, and the endpoints.

No network. Every forecast here is fabricated by `fake_forecast()` in
Open-Meteo's own shape, for an invented place.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from ledger import weather
from ledger.weather import ForecastCache, Place, WeatherUnavailable

PLACE = Place(0.0, 0.0, "Riverside", "imperial")


def fake_forecast(first_day: date, days: int = 16, tz: str = "UTC") -> dict:
    """A forecast starting at midnight on `first_day`, hour i carrying i."""
    hours = days * 24
    t0 = datetime(first_day.year, first_day.month, first_day.day)
    times = [(t0 + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(hours)]
    dates = [(first_day + timedelta(days=i)).isoformat() for i in range(days)]
    return {
        "timezone": tz,
        "utc_offset_seconds": 0,
        "hourly": {
            "time": times,
            "temperature_2m": [50 + (i % 24) / 2 for i in range(hours)],
            "apparent_temperature": [45 + (i % 24) / 2 for i in range(hours)],
            "precipitation_probability": [(i * 7) % 101 for i in range(hours)],
            "precipitation": [0.0] * hours,
            "weather_code": [61 if i % 24 == 15 else 0 for i in range(hours)],
            "wind_speed_10m": [8.4] * hours,
            "wind_gusts_10m": [15.6] * hours,
            "is_day": [1 if 7 <= i % 24 < 17 else 0 for i in range(hours)],
        },
        "daily": {
            "time": dates,
            "weather_code": [3] * days,
            "temperature_2m_max": [61.6] * days,
            "temperature_2m_min": [40.4] * days,
            "apparent_temperature_max": [58.0] * days,
            "apparent_temperature_min": [35.0] * days,
            "precipitation_probability_max": [40] * days,
            "precipitation_sum": [0.087] * days,
            "wind_speed_10m_max": [12.5] * days,
            "wind_gusts_10m_max": [25.9] * days,
            "sunrise": [f"{d}T06:58" for d in dates],
            "sunset": [f"{d}T17:22" for d in dates],
        },
    }


# --- codes ----------------------------------------------------------------


def test_a_clear_night_does_not_show_a_sun():
    assert weather.describe(0, True) == ("Clear", "clear")
    assert weather.describe(0, False) == ("Clear", "clear-night")
    assert weather.describe(2, False)[1] == "partly-night"
    # Only clear and partly have a night face; rain is rain after dark.
    assert weather.describe(63, False) == ("Rain", "rain")


def test_an_unknown_code_is_named_as_unknown_not_dropped():
    assert weather.describe(42) == ("Unknown", "cloud")
    assert weather.describe(None) == ("No forecast", "none")


def test_every_code_maps_to_an_icon_the_sprite_has():
    icons = {icon for _, icon in weather._CODES.values()}
    assert icons <= {"clear", "partly", "cloud", "fog", "drizzle", "rain", "sleet", "snow", "storm"}


# --- configuration --------------------------------------------------------


def test_no_location_turns_the_feature_off():
    assert weather.place_from_env(None, "1", None, None) is None
    assert weather.place_from_env("1", "", None, None) is None
    assert weather.place_from_env("north", "1", None, None) is None
    assert weather.place_from_env("91", "0", None, None) is None


def test_a_place_defaults_to_metric_and_a_neutral_name():
    p = weather.place_from_env("10.5", "-20.25", None, None)
    assert p == Place(10.5, -20.25, "Home", "metric")
    assert weather.place_from_env("1", "1", "Riverside", "IMPERIAL").units == "imperial"
    assert weather.place_from_env("1", "1", "", "kelvin").units == "metric"


# --- hourly ---------------------------------------------------------------


def test_hours_start_with_the_one_in_progress():
    raw = fake_forecast(date(2026, 3, 2))
    now = datetime(2026, 3, 2, 14, 37)
    body = weather.hourly(raw, now, 24)
    hours = body["hours"]
    assert len(hours) == 24
    assert hours[0]["time"] == "2026-03-02T14:00"
    assert hours[0]["is_now"] is True
    assert not any(h["is_now"] for h in hours[1:])
    assert hours[-1]["time"] == "2026-03-03T13:00"
    assert hours[0]["label"] == "2 pm"
    assert hours[10]["label"] == "12 am"
    assert hours[22]["label"] == "12 pm"


def test_an_hour_carries_rounded_figures_and_its_words():
    raw = fake_forecast(date(2026, 3, 2))
    h = weather.hourly(raw, datetime(2026, 3, 2, 15, 0), 1)["hours"][0]
    assert h["temp"] == 58           # 50 + 15/2 = 57.5 → 58 (round half to even: 58)
    assert h["feels"] == 52          # 52.5 → 52, Python's rounding
    assert h["wind"] == 8 and h["gust"] == 16
    assert (h["summary"], h["icon"]) == ("Light rain", "rain")
    assert h["is_day"] is True


def test_hours_after_dark_say_so():
    raw = fake_forecast(date(2026, 3, 2))
    h = weather.hourly(raw, datetime(2026, 3, 2, 20, 0), 1)["hours"][0]
    assert h["is_day"] is False and h["icon"] == "clear-night"


def test_hourly_carries_today_and_tomorrow_day_rows():
    raw = fake_forecast(date(2026, 3, 2))
    body = weather.hourly(raw, datetime(2026, 3, 2, 9, 0), 24)
    assert body["today"]["date"] == "2026-03-02"
    assert body["tomorrow"]["date"] == "2026-03-03"
    assert body["today"]["sunset_text"] == "5:22 pm"
    assert body["today"]["sunrise_text"] == "6:58 am"


def test_the_last_hours_of_the_forecast_run_out_rather_than_wrap():
    raw = fake_forecast(date(2026, 3, 2), days=1)
    body = weather.hourly(raw, datetime(2026, 3, 2, 20, 0), 24)
    assert len(body["hours"]) == 4
    assert body["tomorrow"] is None


def _has_zone(name: str) -> bool:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    try:
        ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return False
    return True


@pytest.mark.skipif(not _has_zone("America/New_York"),
                    reason="no zone database here (Windows without tzdata); the image has one")
def test_local_now_uses_the_zone_name_across_a_clock_change():
    raw = {"timezone": "America/New_York", "utc_offset_seconds": -14400}
    # 2026-11-01 is the US fall-back day: 15:00 UTC is 10:00 EST, not 11:00.
    now = weather.local_now(raw, datetime(2026, 11, 1, 15, 0, tzinfo=UTC))
    assert now == datetime(2026, 11, 1, 10, 0)


def test_local_now_falls_back_to_the_fixed_offset():
    raw = {"timezone": "Nowhere/Invented", "utc_offset_seconds": 3600}
    now = weather.local_now(raw, datetime(2026, 3, 2, 12, 0, tzinfo=UTC))
    assert now == datetime(2026, 3, 2, 13, 0)


def test_hourly_timeframe_names_its_span():
    raw = fake_forecast(date(2026, 3, 2))
    rows = weather.hourly(raw, datetime(2026, 3, 2, 14, 5), 24)["hours"]
    tf = weather.hourly_timeframe(rows)
    assert tf["label"] == "forecast · next 24 hours · 2 pm Mon 2 Mar to 1 pm Tue 3 Mar"
    assert tf["as_of"] is None


# --- daily ----------------------------------------------------------------


def test_a_week_straddling_today_marks_the_days_gone_by():
    raw = fake_forecast(date(2026, 3, 4))           # forecast starts Wednesday
    now = datetime(2026, 3, 4, 8, 0)
    body = weather.daily(raw, date(2026, 3, 2), date(2026, 3, 8), now)
    status = [d["status"] for d in body["days"]]
    assert status == ["past", "past", "forecast", "forecast", "forecast", "forecast", "forecast"]
    assert "temp_max" not in body["days"][0]      # no figures, never zeroes
    today = body["days"][2]
    assert today["lead_days"] == 0 and today["outlook"] is False
    assert (today["temp_max"], today["temp_min"]) == (62, 40)
    assert today["precip"] == 0.09


def test_days_past_the_horizon_are_beyond_not_blank():
    raw = fake_forecast(date(2026, 3, 2))           # reaches 17 Mar
    now = datetime(2026, 3, 2, 8, 0)
    body = weather.daily(raw, date(2026, 3, 16), date(2026, 3, 22), now)
    assert body["reaches"] == "2026-03-17"
    status = [d["status"] for d in body["days"]]
    assert status == ["forecast", "forecast"] + ["beyond"] * 5


def test_a_week_out_is_an_outlook():
    raw = fake_forecast(date(2026, 3, 2))
    now = datetime(2026, 3, 2, 8, 0)
    body = weather.daily(raw, date(2026, 3, 2), date(2026, 3, 10), now)
    outlook = [d["outlook"] for d in body["days"]]
    assert outlook == [False] * 7 + [True] * 2


def test_daily_timeframe():
    assert weather.daily_timeframe(date(2026, 3, 2), date(2026, 3, 8))["label"] \
        == "forecast · 7 days · Mon 2 to Sun 8 Mar 2026"
    assert weather.daily_timeframe(date(2026, 3, 30), date(2026, 4, 5))["label"] \
        == "forecast · 7 days · Mon 30 Mar to Sun 5 Apr 2026"


# --- the cache ------------------------------------------------------------


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


def test_a_fresh_forecast_is_not_fetched_again():
    calls = []
    clock = Clock()
    cache = ForecastCache(lambda p: calls.append(p) or {"n": len(calls)}, clock)
    assert cache.get(PLACE)[0] == {"n": 1}
    clock.t += weather.MAX_AGE_S - 1
    assert cache.get(PLACE) == ({"n": 1}, 1_000_000.0, False)
    clock.t += 2
    assert cache.get(PLACE)[0] == {"n": 2}
    assert len(calls) == 2


def test_a_failed_refetch_serves_the_old_forecast_marked_stale():
    clock = Clock()
    answers = [{"n": 1}, OSError("down")]

    def fetcher(_):
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a

    cache = ForecastCache(fetcher, clock)
    cache.get(PLACE)
    clock.t += weather.MAX_AGE_S + 1
    data, fetched_at, stale = cache.get(PLACE)
    assert data == {"n": 1} and stale is True and fetched_at == 1_000_000.0


def test_a_source_that_is_down_is_not_asked_on_every_request():
    calls = []
    clock = Clock()

    def fetcher(_):
        calls.append(1)
        raise OSError("down")

    cache = ForecastCache(fetcher, clock)
    with pytest.raises(WeatherUnavailable, match="down"):
        cache.get(PLACE)
    clock.t += 60
    with pytest.raises(WeatherUnavailable):
        cache.get(PLACE)
    assert len(calls) == 1
    clock.t += weather.MIN_INTERVAL_S
    with pytest.raises(WeatherUnavailable):
        cache.get(PLACE)
    assert len(calls) == 2


def test_a_new_place_is_not_served_the_old_places_forecast():
    clock = Clock()
    cache = ForecastCache(lambda p: {"lat": p.lat}, clock)
    cache.get(PLACE)
    other = Place(1.0, 1.0, "Elsewhere", "metric")
    assert cache.get(other)[0] == {"lat": 1.0}


# --- the endpoints --------------------------------------------------------


pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DB_PATH", str(tmp_path / "api.db"))
    for k in ("LEDGER_WEATHER_LAT", "LEDGER_WEATHER_LON", "LEDGER_WEATHER_PLACE",
              "LEDGER_WEATHER_UNITS"):
        monkeypatch.delenv(k, raising=False)
    # Not from the environment: importing the app loads the developer's .env,
    # which may name a real place. Every test starts with none.
    import dataclasses

    import ledger.api.main as main
    from ledger.config import load_config

    monkeypatch.setattr(main, "cfg", dataclasses.replace(load_config(), weather=None))
    weather.CACHE.reset()
    with TestClient(main.app) as c:
        yield c, main, monkeypatch
    weather.CACHE.reset()


def _utc_today() -> date:
    """The fake forecast is in UTC, so "today" is UTC's today."""
    return datetime.now(UTC).date()


def _configure(main, monkeypatch, forecast=None, fail=False):
    import dataclasses

    monkeypatch.setattr(main, "cfg", dataclasses.replace(main.cfg, weather=PLACE))

    def fetcher(_):
        if fail:
            raise OSError("no route to host")
        return forecast or fake_forecast(_utc_today() - timedelta(days=1))

    monkeypatch.setattr(weather.CACHE, "_fetch", fetcher)


def test_unconfigured_endpoints_say_so_and_fetch_nothing(client):
    c, _, mp = client
    mp.setattr(weather.CACHE, "_fetch", lambda _: pytest.fail("fetched"))
    for path in ("/api/weather/hourly", "/api/weather/daily"):
        body = c.get(path).json()
        assert body["configured"] is False
        assert "LEDGER_WEATHER_LAT" in body["note"]


def test_hourly_endpoint(client):
    c, main, mp = client
    _configure(main, mp)
    body = c.get("/api/weather/hourly?hours=6").json()
    assert body["configured"] is True
    assert body["place"] == "Riverside"
    assert body["units"] == {"system": "imperial", "temp": "°F", "wind": "mph", "precip": "in"}
    assert body["source"]["name"] == "Open-Meteo"
    assert body["stale"] is False
    assert len(body["hours"]) == 6 and body["hours"][0]["is_now"]
    assert body["timeframe"]["label"].startswith("forecast · next 6 hours")
    assert body["today"]["date"] == _utc_today().isoformat()


def test_hourly_hours_are_clamped(client):
    c, main, mp = client
    _configure(main, mp)
    assert len(c.get("/api/weather/hourly?hours=500").json()["hours"]) == 48
    assert len(c.get("/api/weather/hourly?hours=0").json()["hours"]) == 1


def test_daily_endpoint_defaults_to_today_and_six_more(client):
    c, main, mp = client
    _configure(main, mp)
    body = c.get("/api/weather/daily").json()
    assert body["days"][0]["date"] == _utc_today().isoformat()
    assert len(body["days"]) == 7
    assert all(d["status"] == "forecast" for d in body["days"])


def test_daily_endpoint_refuses_bad_windows(client):
    c, main, mp = client
    _configure(main, mp)
    today = date.today()
    assert c.get("/api/weather/daily?from=nope").status_code == 422
    r = c.get(f"/api/weather/daily?from={today}&to={today - timedelta(days=1)}")
    assert r.status_code == 422
    r = c.get(f"/api/weather/daily?from={today}&to={today + timedelta(days=31)}")
    assert r.status_code == 422


def test_a_source_that_is_down_with_nothing_cached_is_a_503(client):
    c, main, mp = client
    _configure(main, mp, fail=True)
    r = c.get("/api/weather/hourly")
    assert r.status_code == 503
    assert "Open-Meteo" in r.json()["detail"]


# --- the headline ---------------------------------------------------------


def _hours(pops, icon="rain"):
    return [{"time": f"2026-03-02T{14 + i:02d}:00", "label": f"{(14 + i) % 12 or 12} pm",
             "is_now": i == 0, "precip_prob": p, "icon": icon} for i, p in enumerate(pops)]


def test_headline_says_dry_below_the_nws_floor():
    h = weather.headline(_hours([0, 5, 14, 3]))
    assert h == {"level": "dry", "text": "Dry for the next 4 hours", "from": None}


def test_headline_uses_the_nws_words_and_rounds_to_tens():
    assert weather.headline(_hours([0, 18, 0]))["text"] == "Slight chance of rain from 3 pm"
    assert weather.headline(_hours([0, 0, 34]))["text"] == "Chance of rain from 4 pm"
    assert weather.headline(_hours([0, 0, 64]))["level"] == "likely"
    assert weather.headline(_hours([90, 90]))["text"] == "Rain now"


def test_headline_names_when_the_peak_level_starts():
    h = weather.headline(_hours([30, 40, 70, 80, 60]))
    # Peak 80% is "certain" from 5 pm; the 30-70% hours before it do not move it.
    assert h["level"] == "certain" and h["text"] == "Rain from 5 pm"


def test_headline_names_snow_and_storms():
    assert weather.headline(_hours([0, 65], icon="snow"))["text"] == "Snow likely from 3 pm"
    assert weather.headline(_hours([40], icon="storm"))["text"] == "Chance of storms now"


# --- temperature bands ----------------------------------------------------


def test_bands_cover_every_temperature_once():
    for units in ("imperial", "metric"):
        keys = [b["key"] for b in weather.bands_of(units)]
        assert keys == ["freezing", "cold", "cool", "mild", "warm", "hot", "very-hot"]
    assert weather.temp_band(32, "imperial") == "freezing"
    assert weather.temp_band(33, "imperial") == "cold"
    assert weather.temp_band(69, "imperial") == "mild"
    assert weather.temp_band(70, "imperial") == "warm"
    assert weather.temp_band(104, "imperial") == "very-hot"
    assert weather.temp_band(0, "metric") == "freezing"
    assert weather.temp_band(21, "metric") == "warm"
    assert weather.temp_band(None, "metric") is None


def test_the_key_prints_whole_ranges_in_the_unit():
    labels = [b["range"] for b in weather.bands_of("imperial")]
    assert labels == ["≤32°F", "33–45°F", "46–57°F", "58–69°F", "70–79°F", "80–89°F", "90°F+"]
    assert weather.bands_of("metric")[0]["range"] == "≤0°C"


def test_rows_carry_their_band_and_rain_level():
    raw = fake_forecast(date(2026, 3, 2))
    h = weather.hourly(raw, datetime(2026, 3, 2, 15, 0), 1, "imperial")["hours"][0]
    assert (h["temp"], h["temp_band"]) == (58, "mild")
    assert h["precip_level"] == weather._pop_level(h["precip_prob"])
    d = weather.daily(raw, date(2026, 3, 2), date(2026, 3, 2), datetime(2026, 3, 2, 8), "imperial")
    assert d["days"][0]["temp_band"] == "mild" and d["days"][0]["precip_level"] == "chance"


# --- staying inside the free tier -----------------------------------------


def test_the_schedule_stays_far_inside_the_free_tier():
    # One fetch per MAX_AGE_S is the most a steady stream of page views costs.
    per_day = 86400 / weather.MAX_AGE_S
    assert per_day <= 100            # Open-Meteo allows 10,000 a day
    assert weather.DAILY_CAP <= 300  # and the cap holds a bug to 3% of it


def test_a_page_open_all_day_fetches_once_per_max_age():
    calls = []
    clock = Clock()
    cache = ForecastCache(lambda p: calls.append(1) or {"n": len(calls)}, clock)
    for _ in range(24 * 60):          # a request every minute for a day
        cache.get(PLACE)
        clock.t += 60
    assert len(calls) == 86400 // weather.MAX_AGE_S


def test_the_daily_cap_stops_fetching_and_serves_the_last_forecast(monkeypatch):
    monkeypatch.setattr(weather, "DAILY_CAP", 3)
    monkeypatch.setattr(weather, "MAX_AGE_S", 1)
    monkeypatch.setattr(weather, "MIN_INTERVAL_S", 1)
    calls = []
    clock = Clock()
    cache = ForecastCache(lambda p: calls.append(1) or {"n": len(calls)}, clock)
    for _ in range(10):
        data, _, stale = cache.get(PLACE)
        clock.t += 2
    assert len(calls) == 3
    assert data == {"n": 3} and stale is True
    assert cache.attempts_today() == 3
    clock.t += 86400                  # a day later the window has emptied
    assert cache.get(PLACE)[2] is False and len(calls) == 4


def test_the_cap_with_nothing_cached_says_why(monkeypatch):
    monkeypatch.setattr(weather, "DAILY_CAP", 1)
    clock = Clock()

    def fetcher(_):
        raise OSError("down")

    cache = ForecastCache(fetcher, clock)
    with pytest.raises(WeatherUnavailable, match="down"):
        cache.get(PLACE)
    clock.t += weather.MIN_INTERVAL_S
    with pytest.raises(WeatherUnavailable, match="daily cap"):
        cache.get(PLACE)
