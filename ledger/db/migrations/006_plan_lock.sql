-- 006_plan_lock.sql
--
-- A committed distance plan, one row per week.
--
-- The planner projects a ramp every time you open it, from whatever the last
-- complete week happened to be. That is the right default for exploring, and
-- useless for holding yourself to anything: change the slider and last week's
-- plan silently becomes a different plan, so "did I hit it?" has no answer.
--
-- Locking writes the targets down. Once a week is locked its target does not
-- move, which is what makes planned-vs-actual a real comparison rather than a
-- restatement of what happened.
--
-- Scope: on-foot distance only, the same `ON_FOOT` set the ramp uses. This is
-- deliberately not a training plan — no sessions, no prescriptions, no "do 4x800".
-- It is the one number the user already tracks week to week, committed to in
-- advance. BRIEF §6 rules out anything that scores adherence; the app reports
-- the two figures and the difference, and says nothing about whether that is
-- good.

CREATE TABLE plan_week (
    -- The Monday. One plan per week, so re-locking replaces rather than piles up.
    week_start   TEXT PRIMARY KEY,
    target_km    REAL NOT NULL,
    -- A cut-back week. Kept so the chart can mark it and so a low week is not
    -- mistaken for a missed one.
    is_deload    INTEGER NOT NULL DEFAULT 0,
    -- When this row was committed, and the settings that produced it. Enough
    -- to answer "what was I thinking?" three months later without guessing.
    locked_at    TEXT NOT NULL,
    base_km      REAL,
    pct          REAL,
    note         TEXT
);

CREATE INDEX plan_week_locked_at ON plan_week (locked_at);
