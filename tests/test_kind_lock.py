"""A hand-set modality survives every later sync, and renames with itself.

Garmin has no ab-attack or quick-feet activity type: both arrive as `strength_
training` or `soccer` with a name like "Strength" or "Quick Feet". Correcting
the kind by hand used to hold only until the next nightly sync mapped it back —
three times in two days for one session, and every revert also moved it between
the soccer record, the load split and the activity mix.
"""

import json

import pytest

from ledger.db import queries as q
from ledger.db.schema import open_db


@pytest.fixture()
def conn(tmp_path):
    c = open_db(tmp_path / "t.db")
    c.execute(
        "INSERT INTO session (date, kind, source, notes, detail, garmin_activity_id) "
        "VALUES ('2026-08-28', 'lift', 'garmin', 'Strength', ?, 'A1')",
        (json.dumps({"garmin_name": "Strength"}),),
    )
    return c


def sid(c):
    return c.execute("SELECT id FROM session").fetchone()["id"]


def row(c):
    return c.execute("SELECT * FROM session WHERE id = ?", (sid(c),)).fetchone()


def test_correcting_the_kind_locks_it(conn):
    q.update_session(conn, sid(conn), {"kind": "ab"})
    assert row(conn)["kind_locked"] == 1


def test_a_later_sync_cannot_undo_the_correction(conn):
    q.update_session(conn, sid(conn), {"kind": "ab"})
    # Exactly what a sync does: same activity id, watch says `lift` again.
    q.upsert_garmin_session(
        conn, garmin_activity_id="A1", date="2026-08-28", kind="lift",
        started_at=None, ended_at=None, duration_min=30.0, notes="Strength",
    )
    assert row(conn)["kind"] == "ab"


def test_correcting_the_kind_renames_an_untouched_watch_label(conn):
    q.update_session(conn, sid(conn), {"kind": "ab"})
    assert row(conn)["notes"] == "Ab attack"


def test_a_note_the_user_wrote_is_never_overwritten(conn):
    conn.execute("UPDATE session SET notes = 'felt easy, legs ok'")
    q.update_session(conn, sid(conn), {"kind": "ab"})
    assert row(conn)["notes"] == "felt easy, legs ok"


def test_resaving_without_changing_the_kind_locks_nothing(conn):
    q.update_session(conn, sid(conn), {"kind": "lift", "rpe": 5})
    r = row(conn)
    assert r["kind_locked"] == 0
    assert r["notes"] == "Strength"


def test_a_watch_name_never_outranks_an_app_lock(conn):
    """The correction wins, and it keeps winning.

    The watch's name used to override `kind_locked`, on the theory that naming
    an activity on the watch is the user classifying it from the other device.
    But the name is fixed when the activity is recorded and every later sync
    replays it, so the override did not read the user's latest intent — it
    replayed their oldest one indefinitely. Correcting the session in the app
    set `kind_locked = 1` and the next sync put it straight back.

    This is the "I fix it and it comes back" report, and it is why every guard
    added around the lock made no difference: the guard was what got overridden.
    """
    # The watch calls this one "Ab attack", so its *name* resolves to `ab` —
    # the case that used to defeat the lock. The user says it was a lift.
    conn.execute(
        "UPDATE session SET kind = 'ab', notes = 'Ab attack', detail = ?",
        (json.dumps({"garmin_name": "Ab attack"}),),
    )
    q.update_session(conn, sid(conn), {"kind": "lift"})
    assert row(conn)["kind_locked"] == 1

    for _ in range(3):  # it must not drift back on the third night either
        q.upsert_garmin_session(
            conn, garmin_activity_id="A1", date="2026-08-28", kind="ab",
            started_at=None, ended_at=None, duration_min=30.0, notes="Ab attack",
        )
        assert row(conn)["kind"] == "lift"


def test_the_lock_still_holds_against_the_type_mapping(conn):
    """The thing the lock exists for must keep working."""
    q.update_session(conn, sid(conn), {"kind": "ab"})
    q.upsert_garmin_session(
        conn, garmin_activity_id="A1", date="2026-08-28", kind="lift",
        started_at=None, ended_at=None, duration_min=30.0, notes="Strength",
    )
    assert row(conn)["kind"] == "ab"


def test_correcting_the_kind_renames_a_watch_label_even_when_notes_are_sent(conn):
    """The edit form always sends `notes`, so the rename must cope with that.

    It was guarded by `"notes" not in updates`, which meant it never fired from
    the app at all: the form rebuilds the session from its shorthand and sends
    the watch's label straight back in. The session then read "Ab attack" in its
    title and "Strength" underneath — one session, two answers.
    """
    q.update_session(conn, sid(conn), {"kind": "ab", "notes": "Strength"})
    r = row(conn)
    assert r["kind"] == "ab"
    assert r["notes"] == "Ab attack"


def test_a_typed_note_survives_a_kind_correction(conn):
    """The other half of that rule: a note is not a label."""
    q.update_session(conn, sid(conn), {"kind": "ab", "notes": "felt easy, legs ok"})
    assert row(conn)["notes"] == "felt easy, legs ok"
