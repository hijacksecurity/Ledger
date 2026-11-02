"""Runtime configuration, read from environment (.env in dev).

There is no config file and no settings table. One user, one deployment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from ledger.weather import Place, place_from_env

REPO_ROOT = Path(__file__).resolve().parent.parent

load_dotenv(REPO_ROOT / ".env")


def _path(env: str, default: str) -> Path:
    return Path(os.getenv(env, default)).expanduser().resolve()


def _float(env: str, default: float) -> float:
    raw = os.getenv(env)
    return float(raw) if raw else default


def _int(env: str, default: int) -> int:
    raw = os.getenv(env)
    return int(raw) if raw else default


@dataclass(frozen=True)
class Config:
    db_path: Path
    backup_dir: Path
    garmin_email: str | None
    garmin_password: str | None
    garmin_token_dir: Path
    display_unit: str
    # Sessions per week the user intends to do, by kind. Feeds the consistency
    # metric (BRIEF §6). Planned counts are an input the user controls, which is
    # the whole point of scoring inputs rather than outputs.
    planned_per_week: dict[str, int] = field(default_factory=dict)
    sync_call_delay_s: float = 2.5
    sync_chunk_pause_s: float = 30.0
    # Where the forecast is for. None turns weather off: a location is
    # personal, so it is only ever configuration, never a default.
    weather: Place | None = None


def load_config() -> Config:
    return Config(
        db_path=_path("LEDGER_DB_PATH", str(REPO_ROOT / "data" / "ledger.db")),
        backup_dir=_path("LEDGER_BACKUP_DIR", str(REPO_ROOT / "backups")),
        garmin_email=os.getenv("GARMIN_EMAIL") or None,
        garmin_password=os.getenv("GARMIN_PASSWORD") or None,
        garmin_token_dir=_path("GARMINTOKENS", str(REPO_ROOT / ".garth")),
        display_unit=os.getenv("LEDGER_DISPLAY_UNIT", "kg").lower(),
        planned_per_week={
            "lift": _int("LEDGER_PLANNED_LIFT_PER_WEEK", 6),
            "run": _int("LEDGER_PLANNED_RUN_PER_WEEK", 3),
            "soccer": _int("LEDGER_PLANNED_SOCCER_PER_WEEK", 2),
        },
        sync_call_delay_s=_float("LEDGER_SYNC_CALL_DELAY_S", 2.5),
        sync_chunk_pause_s=_float("LEDGER_SYNC_CHUNK_PAUSE_S", 30.0),
        weather=place_from_env(
            os.getenv("LEDGER_WEATHER_LAT"), os.getenv("LEDGER_WEATHER_LON"),
            os.getenv("LEDGER_WEATHER_PLACE"), os.getenv("LEDGER_WEATHER_UNITS"),
        ),
    )
