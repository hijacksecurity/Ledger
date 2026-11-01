"""Bulk-entry grammar (BRIEF §10). Provisional — see docs/NOTEBOOK.md."""

from __future__ import annotations

import pytest

from ledger.entry import EntryError, parse_entry, parse_set_token


def test_simple_session():
    (s,) = parse_entry("2026-01-05 lift\nsquat 100x5 100x5 100x5\n")
    assert s.date == "2026-01-05"
    assert s.kind == "lift"
    assert len(s.exercises) == 1
    assert s.exercises[0].name == "squat"
    assert len(s.exercises[0].sets) == 3


def test_header_options():
    (s,) = parse_entry('2026-01-05 soccer rpe=9 90min @18:30 "indoor league"\n')
    assert s.kind == "soccer"
    assert s.rpe == 9
    assert s.duration_min == 90
    assert s.started_at == "2026-01-05T18:30:00"
    assert s.notes == "indoor league"


def test_multiplied_sets_expand():
    sets = parse_set_token("3x100x5")
    assert len(sets) == 3
    assert all(x.weight_kg == 100 and x.reps == 5 for x in sets)


def test_warmup_and_per_set_rpe():
    (s,) = parse_entry("2026-01-05 lift\nbench 60x10w 80x5@8\n")
    warmup, working = s.exercises[0].sets
    assert warmup.is_warmup is True
    assert working.is_warmup is False
    assert working.rpe == 8


def test_bodyweight_and_pounds():
    (s,) = parse_entry("2026-01-05 lift\npullup bwx10\ndeadlift 225lbx5\n")
    assert s.exercises[0].sets[0].weight_kg == 0.0
    assert s.exercises[1].sets[0].weight_kg == pytest.approx(102.06, abs=0.01)


def test_multi_word_exercise_names():
    (s,) = parse_entry("2026-01-05 lift\nbarbell back squat 100x5\n")
    assert s.exercises[0].name == "barbell back squat"


def test_comments_and_blank_lines_ignored():
    text = "# week of jan 5\n\n2026-01-05 lift\n\nsquat 100x5   # felt easy\n"
    (s,) = parse_entry(text)
    assert len(s.exercises) == 1


def test_multiple_sessions_in_one_batch():
    sessions = parse_entry("2026-01-05 lift\nsquat 100x5\n2026-01-07 run 30min rpe=5\n")
    assert len(sessions) == 2
    assert sessions[1].kind == "run"
    assert sessions[1].exercises == []


def test_errors_carry_a_line_number():
    with pytest.raises(EntryError, match="line 1"):
        parse_entry("squat 100x5\n")                      # no session header
    with pytest.raises(EntryError, match="line 2"):
        parse_entry("2026-01-05 lift\njust some words\n")  # no sets on the line
    with pytest.raises(EntryError, match="line 1"):
        parse_entry("2026-01-05 lift rpe=99\n")            # out of range


def test_non_set_tokens_are_not_mistaken_for_sets():
    assert parse_set_token("squat") is None
    assert parse_set_token("100") is None
    assert parse_set_token("100x0") is None
