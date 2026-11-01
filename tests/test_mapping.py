"""Garmin response parsing (BRIEF §12).

It is an unofficial API: fields appear, vanish and change type without notice.
Nothing here may raise on bad input.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from ledger.garmin.mapping import (
    map_kind,
    overlap_fraction,
    parse_activity,
    parse_bodyweight_kg,
    parse_exercise_sets,
    parse_local_datetime,
    parse_resting_hr,
    parse_sleep_hours,
    should_merge,
)


@pytest.mark.parametrize(
    ("type_key", "expected"),
    [
        ("running", "run"),
        ("treadmill_running", "run"),
        ("soccer", "soccer"),
        ("indoor_soccer", "soccer"),
        ("strength_training", "lift"),
        ("open_water_swimming", "other"),
        ("RUNNING", "run"),          # case is not guaranteed
        (None, "other"),             # field vanished
        (12345, "other"),            # field changed type
    ],
)
def test_activity_type_mapping(type_key, expected):
    assert map_kind(type_key) == expected


def test_parse_activity_extracts_the_columns_session_stores():
    parsed = parse_activity(
        {
            "activityId": 987654321,
            "startTimeLocal": "2026-07-27 18:30:00",
            "duration": 5400.0,
            "activityType": {"typeKey": "indoor_soccer"},
            "activityName": "Indoor Soccer",
        }
    )
    assert parsed is not None
    assert parsed.garmin_activity_id == "987654321"
    assert parsed.date == "2026-07-27"
    assert parsed.kind == "soccer"
    assert parsed.duration_min == 90.0
    assert parsed.ended_at == "2026-07-27T20:00:00"


def test_a_late_evening_game_is_attributed_to_the_day_it_was_played():
    """Converting to UTC here would push a 21:30 game to the next day."""
    parsed = parse_activity(
        {
            "activityId": 1,
            "startTimeLocal": "2026-07-27 21:30:00",
            "duration": 3600,
            "activityType": {"typeKey": "soccer"},
        }
    )
    assert parsed.date == "2026-07-27"


@pytest.mark.parametrize(
    "payload",
    [
        None,
        "not a dict",
        {},
        {"activityId": 1},                                # no start time
        {"startTimeLocal": "2026-07-27 10:00:00"},        # no id
        {"activityId": 1, "startTimeLocal": "garbage"},   # unparseable time
    ],
)
def test_unusable_activities_return_none_rather_than_raising(payload):
    assert parse_activity(payload) is None


def test_parse_activity_survives_a_missing_duration():
    parsed = parse_activity(
        {"activityId": 5, "startTimeLocal": "2026-07-27 10:00:00", "activityType": {}}
    )
    assert parsed is not None
    assert parsed.duration_min is None
    assert parsed.ended_at is None
    assert parsed.kind == "other"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2026-07-27 18:30:00.0", datetime(2026, 7, 27, 18, 30)),
        ("2026-07-27T18:30:00", datetime(2026, 7, 27, 18, 30)),
        ("2026-07-27", datetime(2026, 7, 27)),
        ("", None),
        (None, None),
        (12345, None),
    ],
)
def test_local_datetime_accepts_the_shapes_garmin_actually_sends(raw, expected):
    assert parse_local_datetime(raw) == expected


# --- merge rule -----------------------------------------------------------


def test_overlap_fraction_is_measured_against_the_first_activity():
    a = (datetime(2026, 1, 5, 18, 0), datetime(2026, 1, 5, 19, 0))
    b = (datetime(2026, 1, 5, 18, 30), datetime(2026, 1, 5, 20, 0))
    assert overlap_fraction(*a, *b) == pytest.approx(0.5)


def test_merge_when_the_watch_activity_mostly_overlaps_the_manual_session():
    garmin = (datetime(2026, 1, 5, 18, 5), datetime(2026, 1, 5, 19, 5))
    manual = (datetime(2026, 1, 5, 18, 0), datetime(2026, 1, 5, 19, 30))
    assert should_merge(*garmin, *manual) is True


def test_do_not_merge_two_genuinely_separate_sessions_the_same_day():
    morning = (datetime(2026, 1, 5, 7, 0), datetime(2026, 1, 5, 8, 0))
    evening = (datetime(2026, 1, 5, 18, 0), datetime(2026, 1, 5, 19, 0))
    assert should_merge(*morning, *evening) is False


def test_no_overlap_when_durations_are_degenerate():
    t = datetime(2026, 1, 5, 18, 0)
    assert overlap_fraction(t, t, t, t) == 0.0


# --- daily metrics --------------------------------------------------------


def test_bodyweight_converts_grams_and_rejects_nonsense():
    assert parse_bodyweight_kg({"totalAverage": {"weight": 96600.0}}) == 96.6
    assert parse_bodyweight_kg({"totalAverage": {"weight": 5}}) is None       # 5g
    assert parse_bodyweight_kg({"totalAverage": {"weight": None}}) is None
    assert parse_bodyweight_kg({}) is None
    assert parse_bodyweight_kg(None) is None


def test_sleep_hours_bounds():
    assert parse_sleep_hours({"dailySleepDTO": {"sleepTimeSeconds": 27000}}) == 7.5
    assert parse_sleep_hours({"dailySleepDTO": {"sleepTimeSeconds": 0}}) is None
    assert parse_sleep_hours({"dailySleepDTO": {"sleepTimeSeconds": 999999}}) is None


def test_resting_hr_reads_either_shape():
    assert parse_resting_hr({"restingHeartRate": 48}) == 48
    assert parse_resting_hr(
        {"allMetrics": {"metricsMap": {"WELLNESS_RESTING_HEART_RATE": [{"value": 51}]}}}
    ) == 51
    assert parse_resting_hr({"restingHeartRate": 5}) is None  # implausible


def test_exercise_sets_drops_rest_and_converts_grams():
    payload = {
        "exerciseSets": [
            {
                "setType": "ACTIVE",
                "repetitionCount": 5,
                "weight": 100000.0,
                "exercises": [{"category": "BENCH_PRESS"}],
            },
            {"setType": "REST", "repetitionCount": 0},
            {"setType": "ACTIVE", "repetitionCount": 8},          # no exercise name
            "not a dict",
        ]
    }
    sets = parse_exercise_sets(payload)
    assert len(sets) == 1
    assert sets[0].exercise_name == "Bench Press"
    assert sets[0].weight_kg == 100.0
    assert sets[0].reps == 5


def test_exercise_sets_of_junk_is_empty_not_an_exception():
    assert parse_exercise_sets(None) == []
    assert parse_exercise_sets({"exerciseSets": "surprise"}) == []


# --- 015 recovery columns ---------------------------------------------------


def test_parse_sleep_detail_reads_score_stages_and_local_times():
    from ledger.garmin.mapping import parse_sleep_detail

    payload = {
        "dailySleepDTO": {
            "sleepTimeSeconds": 26580,
            # Epoch-ms already shifted to local wall-clock, as Garmin sends it.
            "sleepStartTimestampLocal": 1793318355000,   # 2026-10-29 23:59 local
            "sleepEndTimestampLocal": 1793347215000,     # 2026-10-30 08:00 local
            "deepSleepSeconds": 5160,
            "lightSleepSeconds": 17400,
            "remSleepSeconds": 4020,
            "awakeSleepSeconds": 2280,
            "sleepScores": {"overall": {"value": 78, "qualifierKey": "FAIR"}},
        }
    }
    out = parse_sleep_detail(payload)
    assert out == {
        "sleep_score": 78,
        "deep_min": 86,
        "rem_min": 67,
        "awake_min": 38,
        "sleep_start_local": "2026-10-29T23:59",
        "sleep_end_local": "2026-10-30T08:00",
    }


def test_parse_sleep_detail_is_empty_not_wrong_on_junk():
    from ledger.garmin.mapping import parse_sleep_detail

    assert parse_sleep_detail(None) == {}
    assert parse_sleep_detail([]) == {}
    assert parse_sleep_detail({"dailySleepDTO": {"sleepScores": {"overall": {"value": 140}}}}) == {}
    assert parse_sleep_detail({"dailySleepDTO": {"deepSleepSeconds": "nope"}}) == {}


def test_parse_daily_stats_reads_stress_steps_intensity_and_wake_battery():
    from ledger.garmin.mapping import parse_daily_stats

    out = parse_daily_stats({
        "averageStressLevel": 35, "totalSteps": 10976,
        "moderateIntensityMinutes": 20, "vigorousIntensityMinutes": 48,
        "bodyBatteryAtWakeTime": 85, "bodyBatteryChargedValue": 66,
        "bodyBatteryHighestValue": 86,  # already handled by parse_body_battery
    })
    assert out == {
        "stress_avg": 35, "steps": 10976,
        "intensity_moderate_min": 20, "intensity_vigorous_min": 48,
        "body_battery_wake": 85, "body_battery_charged": 66,
    }


def test_parse_daily_stats_drops_implausible_values():
    from ledger.garmin.mapping import parse_daily_stats

    # Garmin reports -1 or -2 for "no stress data today"; that is not a level.
    assert parse_daily_stats({"averageStressLevel": -1, "totalSteps": None}) == {}
    assert parse_daily_stats("not a dict") == {}


def test_parse_hrv_detail_keeps_status_and_personal_range():
    from ledger.garmin.mapping import parse_hrv_detail

    out = parse_hrv_detail({"hrvSummary": {
        "weeklyAvg": 51, "lastNightAvg": 68,
        "baseline": {"lowUpper": 37, "balancedLow": 42, "balancedUpper": 66, "markerValue": 0.4375},
        "status": "BALANCED",
    }})
    assert out == {
        "hrv_status": "BALANCED",
        "hrv_balanced_low": 42, "hrv_balanced_high": 66, "hrv_low_upper": 37,
    }
    assert parse_hrv_detail(None) == {}
    assert parse_hrv_detail({"hrvSummary": {"status": "", "baseline": "junk"}}) == {}


def test_parse_sleep_detail_reads_the_personal_sleep_need():
    from ledger.garmin.mapping import parse_sleep_detail

    out = parse_sleep_detail({"dailySleepDTO": {"sleepNeed": {"baseline": 470, "actual": 480}}})
    assert out == {"sleep_need_min": 480}
    out = parse_sleep_detail({"dailySleepDTO": {"sleepNeed": {"baseline": 470}}})
    assert out == {"sleep_need_min": 470}
