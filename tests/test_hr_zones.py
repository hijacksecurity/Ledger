"""HR zones off the watch.

The Running page's zone panel covered 1 run in 13, because zones only ever
arrived through the notebook grammar while Garmin published them on every
activity it recorded. These pin the conversion, which is the part that can go
quietly wrong: the notebook writes percentages and Garmin writes seconds, and
`zoneSplit` sums the column across sessions.
"""

from ledger.garmin.mapping import hr_zones


def test_seconds_become_whole_percentages():
    z = hr_zones({
        "hrTimeInZone_1": 377.969,
        "hrTimeInZone_2": 457.944,
        "hrTimeInZone_3": 83.999,
        "hrTimeInZone_4": 0.0,
        "hrTimeInZone_5": 0.0,
    })
    assert z == {"z1": 41, "z2": 50, "z3": 9}


def test_split_always_sums_to_100():
    """Rounding five values can drift; the split must still be a split."""
    awkward = {f"hrTimeInZone_{i}": 100.0 / 3 for i in range(1, 6)}
    z = hr_zones(awkward)
    assert sum(z.values()) == 100


def test_empty_zones_are_absent_not_zero():
    """A manual session has no zone data; five zeroes would be a lie."""
    assert hr_zones({"hrTimeInZone_1": 0.0, "hrTimeInZone_2": 0.0}) is None
    assert hr_zones({}) is None
    assert hr_zones(None) is None


def test_only_populated_zones_are_kept():
    z = hr_zones({"hrTimeInZone_2": 600.0, "hrTimeInZone_5": 0.0})
    assert z == {"z2": 100}
    assert "z5" not in z


def test_a_zone_that_rounds_to_nothing_is_dropped():
    """Seconds in zone 5 that round to 0% are not a band in the split."""
    z = hr_zones({
        "hrTimeInZone_1": 600.0,
        "hrTimeInZone_2": 600.0,
        "hrTimeInZone_5": 1.0,
    })
    assert "z5" not in z
    assert sum(z.values()) == 100


def test_garmin_zones_refresh_but_hand_written_ones_do_not(tmp_path):
    """A parsing fix has to be able to reach the rows it was written for."""
    import json
    from ledger.db.schema import open_db
    from ledger.db import queries as q

    conn = open_db(tmp_path / "t.db")
    conn.execute(
        "INSERT INTO session (date, kind, source, detail) VALUES (?, ?, ?, ?)",
        ("2026-08-01", "run", "garmin", json.dumps({})),
    )
    sid = conn.execute("SELECT id FROM session").fetchone()["id"]

    q.enrich_from_garmin(conn, sid, zones={"z1": 60, "z2": 40})
    d = json.loads(conn.execute(
        "SELECT detail FROM session WHERE id = ?", (sid,)).fetchone()["detail"])
    assert d["zones"] == {"z1": 60, "z2": 40}
    assert d["zones_source"] == "garmin"

    # A later sync corrects it.
    q.enrich_from_garmin(conn, sid, zones={"z1": 50, "z2": 50})
    d = json.loads(conn.execute(
        "SELECT detail FROM session WHERE id = ?", (sid,)).fetchone()["detail"])
    assert d["zones"] == {"z1": 50, "z2": 50}

    # A hand-written split is never touched.
    conn.execute(
        "UPDATE session SET detail = ? WHERE id = ?",
        (json.dumps({"zones": {"z1": 31, "z2": 42}}), sid),
    )
    q.enrich_from_garmin(conn, sid, zones={"z1": 99, "z2": 1})
    d = json.loads(conn.execute(
        "SELECT detail FROM session WHERE id = ?", (sid,)).fetchone()["detail"])
    assert d["zones"] == {"z1": 31, "z2": 42}
