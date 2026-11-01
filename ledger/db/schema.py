"""SQLite connection and migration runner.

Migrations are plain .sql files in ./migrations, applied in filename order and
recorded in `_migration`. Alembic is overkill for one file on one machine.

A migration is append-only once it has run against the real database. To change
something, add 002_..., 003_.... Never edit an applied file.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
_SAFE_FILENAME = re.compile(r"[0-9A-Za-z_.\-]+")

_MIGRATION_TABLE = """
CREATE TABLE IF NOT EXISTS _migration (
    filename    TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
)
"""


def connect(db_path: Path | str, *, same_thread: bool = True) -> sqlite3.Connection:
    """Open the database with the pragmas this project assumes everywhere.

    `same_thread=False` relaxes sqlite3's thread-affinity check. Required by the
    API: FastAPI runs a sync dependency's setup and its teardown as separate
    threadpool jobs, so the thread that closes the connection is often not the
    thread that opened it. That is safe here only because a connection is never
    shared between requests — one request owns it start to finish. Do not reuse
    this flag to hand a single connection to several workers.
    """
    db_path = Path(db_path)
    if db_path.parent != Path(""):
        db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(
        db_path,
        isolation_level=None,  # autocommit; we manage txns
        check_same_thread=same_thread,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Explicit transaction. Rolls back on any exception."""
    conn.execute("BEGIN")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def pending_migrations(conn: sqlite3.Connection) -> list[Path]:
    conn.execute(_MIGRATION_TABLE)
    applied = {row["filename"] for row in conn.execute("SELECT filename FROM _migration")}
    return [p for p in sorted(MIGRATIONS_DIR.glob("*.sql")) if p.name not in applied]


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Apply every pending migration in order. Returns the names applied.

    The bookkeeping INSERT is inside the same script as the DDL so a crash
    mid-migration can never leave a half-applied file marked as applied. That
    forces literal SQL rather than bound parameters (executescript takes no
    params), hence the filename validation.
    """
    applied: list[str] = []
    for path in pending_migrations(conn):
        if not _SAFE_FILENAME.fullmatch(path.name):
            raise ValueError(f"unsafe migration filename: {path.name!r}")
        ts = datetime.now(UTC).isoformat(timespec="seconds")
        # SQLite's own procedure for rebuilding a table (004, 014): foreign
        # keys OFF for the duration, then a foreign_key_check before COMMIT.
        # With them ON, `DROP TABLE session` is an implicit DELETE of every
        # row — which cascades into lift_set and fails on sync_log — so 014
        # took the app down on 19 Sep 2026 and, had sync_log been empty, would
        # have silently emptied the lifting record instead. The pragma is a
        # no-op inside a transaction, so it is set here, outside one.
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            # executescript implicitly COMMITs any pending transaction before
            # it runs, so the BEGIN must live inside the script text itself.
            # The COMMIT does not: the transaction is left open so the check
            # below can still roll the whole file back.
            conn.executescript(
                "BEGIN;\n"
                f"{path.read_text(encoding='utf-8')}\n"
                "INSERT INTO _migration (filename, applied_at) "
                f"VALUES ('{path.name}', '{ts}');"
            )
            broken = conn.execute("PRAGMA foreign_key_check").fetchall()
            if broken:
                raise sqlite3.IntegrityError(
                    f"{path.name} left {len(broken)} row(s) pointing at nothing "
                    f"(first: {tuple(broken[0])}); rolled back"
                )
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.execute("PRAGMA foreign_keys = ON")
        applied.append(path.name)
    return applied


def open_db(db_path: Path | str) -> sqlite3.Connection:
    """connect() + migrate(). The normal entry point."""
    conn = connect(db_path)
    migrate(conn)
    return conn
