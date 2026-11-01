"""Garmin's activity *name* can name a kind, and when it does it wins.

Garmin has no ab-attack or quick-feet activity type. The user works around
that on the watch by naming the activity — but the name only ever reached
`notes`, so a session already labelled "Ab attack" still imported as `lift`
and had to be corrected by hand every time.
"""

from ledger.garmin.mapping import map_kind, parse_activity


def test_a_name_that_is_a_kind_beats_the_type():
    assert map_kind("strength_training", "Ab attack") == "ab"
    assert map_kind("soccer", "Quick Feet") == "quickfeet"


def test_a_name_that_is_not_a_kind_falls_through_to_the_type():
    """A name is a label, not a free-text classifier."""
    assert map_kind("running", "Riverside Running") == "run"
    assert map_kind("soccer", "Soccer/Football") == "soccer"
    assert map_kind("strength_training", "Strength") == "lift"


def test_no_name_still_maps_from_the_type():
    assert map_kind("running", None) == "run"
    assert map_kind("running") == "run"


def test_aliases_and_punctuation_are_tolerated():
    for spelling in ("Ab attack", "ab-attack", "AB ATTACK", "abs"):
        assert map_kind("strength_training", spelling) == "ab"


def test_rides_are_bikes_not_other():
    """Latent until the first ride syncs; wrong the moment one does."""
    assert map_kind("cycling", "Morning Ride") == "bike"
    assert map_kind("indoor_cycling", None) == "bike"


def test_end_to_end_through_parse_activity():
    s = parse_activity({
        "activityId": 1,
        "startTimeLocal": "2026-08-31 06:00:00",
        "duration": 1800,
        "activityType": {"typeKey": "strength_training"},
        "activityName": "Ab attack",
    })
    assert s is not None
    assert s.kind == "ab"
    assert s.notes == "Ab attack"


def test_a_stair_session_is_stairs_not_other():
    """Garmin's floor_climbing type filed under 'other', and 'other' is the one
    kind every distance total ignores — 1.3 km of stairs vanished."""
    assert map_kind("floor_climbing", "Riverside Floor Climb") == "stairs"
    assert map_kind("stair_climbing", None) == "stairs"
    for spelling in ("Stairs", "stair climb", "Floor climb", "stair-climbing"):
        assert map_kind("indoor_cardio", spelling) == "stairs"
