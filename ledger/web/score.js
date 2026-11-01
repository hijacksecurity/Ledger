/* Scoreboard — the one place in this app that grades anything.
 *
 * Everywhere else reports. This scores, deliberately and by request, because
 * "am I doing well" is a question the record could answer and never did. The
 * rules it plays by:
 *
 *   · Pure functions. Nothing here touches the DOM or the network, so every
 *     number can be checked by reading one file.
 *   · Self-relative wherever possible. Involvement is scored against *your*
 *     per-match average, activities against *your* lifetime rate. A system
 *     built on absolute thresholds tells a beginner they are failing and a
 *     veteran they are finished.
 *   · A pillar with no data is absent, not zero. A week with no match is not
 *     a week you played badly, so the soccer weight is redistributed instead
 *     of dragging the total down.
 *   · Nothing resets. The week score moves freely; the level is built from
 *     lifetime totals that only ever increase, so a bad week adds less and
 *     takes nothing away. That is the no-streaks rule kept intact.
 *
 * Weights and curves are constants at the top on purpose — this is a system
 * that will want tuning once it has been lived with.
 */

/* ── tuning ──────────────────────────────────────────────────────────────── */

export const WEIGHTS = {
  soccer: 27,
  consistency: 18,
  running: 18,
  adherence: 14,
  habits: 10,
  body: 9,
  load: 4,
};

/* Habits arrived at 10 and the other six gave up the room proportionally
   rather than one of them being cut — 30/20/20/15/10/5 scaled by 0.9 and
   rounded to 27/18/18/14/9/4, which still sums to 100. The point of scaling
   rather than choosing is that the *relative* weighting the user has lived
   with is untouched: soccer is still worth a third more than running, running
   still worth more than the plan. Nothing was re-ranked to make room. */

/* Soccer: the result is the larger share, but not the whole pillar. A 21-32-4
   record means a result-only score reads near zero most weeks regardless of
   how the match was played, which is a scoreboard that only ever says "no". */
const RESULT_SHARE = 0.6;
const RESULT_POINTS = { W: 100, D: 60, L: 25 };

/* A four-week move of this much, toward the goal, is a full-marks trend. */
const BODY_FULL_MARKS_KG = 1.0;

/* Three or more logged activities in a day. Capped so it cannot become the
   strategy — the pillars are the system, this is a garnish. */
const TRIPLE_POINTS = 2;
const TRIPLE_MAX = 6;

/* Level curve: points = 10 x level^2, so each level costs more than the last
   and the early ones arrive quickly. */
const LEVEL_DIVISOR = 10;

/* What a lifetime point is worth. Every term is monotonic — none of these can
   fall — which is what makes the level unable to go down. */
export const LIFETIME_POINTS = {
  perActivity: 1,
  perFootKm: 1,
  perBikeKm: 0.3,
  perSoccerWin: 10,
  perSoccerDraw: 4,
  perInvolvement: 3,
};

/* Soccer used to be three of the four lines here and 63% of every point, which
   made the level a soccer level with a participation bonus — a hard running
   block moved it about as much as sitting still. Soccer is the only modality
   the record holds an *outcome* for, so it was the only one with anything to
   count; distance is what the others have, and it counts now. That puts soccer
   at about a third, which is roughly its share of the training itself.

   A bike kilometre is worth less than one on foot because it costs less: 707
   logged bike kilometres against 742 on foot is not two equal achievements,
   and pricing them the same would make cycling the cheapest way to level. */

/* Weeks-on-record used to be worth two points each, and it was the single
   biggest thing wrong with the level: 170 of the first 1,215 points came from
   the calendar advancing. A level you climb by waiting is not a level. Every
   term above is now something *done* — an activity logged, a match won, a goal
   or an assist. Time alone earns nothing. */

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const KG_PER_LB = 0.45359237;

/* ── pillars ─────────────────────────────────────────────────────────────── */

/**
 * Soccer: how the matches went, and how much of it was you.
 *
 * `careerPerMatch` is your own goals+assists rate, so involvement is measured
 * against yourself. Matching your average scores 75 rather than 100 — the top
 * of the range has to be reachable but not automatic.
 */
function soccerPillar({ matches, careerPerMatch }) {
  const played = matches.filter((m) => m.result);
  if (!played.length) return null;

  const resultScore = played.reduce((a, m) => a + (RESULT_POINTS[m.result] || 0), 0) / played.length;

  const involvements = matches.reduce((a, m) => a + (m.goals || 0) + (m.assists || 0), 0);
  const expected = (careerPerMatch || 0) * matches.length;
  const involvementScore = expected > 0
    ? clamp((involvements / expected) * 75)
    : (involvements > 0 ? 100 : 50);

  const score = resultScore * RESULT_SHARE + involvementScore * (1 - RESULT_SHARE);
  const w = played.filter((m) => m.result === 'W').length;
  const d = played.filter((m) => m.result === 'D').length;
  const l = played.filter((m) => m.result === 'L').length;

  return {
    score,
    detail: `${w}W ${d}D ${l}L · ${involvements} goals + assists`,
    lines: [
      `Results ${Math.round(resultScore)} — ${w} won, ${d} drawn, ${l} lost.`,
      expected > 0
        ? `Involvement ${Math.round(involvementScore)} — ${involvements} against the `
          + `${(expected).toFixed(1)} your ${careerPerMatch.toFixed(2)} per match predicts.`
        : `Involvement ${Math.round(involvementScore)} — no career rate to compare against yet.`,
    ],
    /* What one more of each would be worth, for the "what moves this" line. */
    nudge: played.length && resultScore < 100
      ? 'A win is the biggest single move available here.'
      : null,
  };
}

/**
 * Consistency: activities this week against your own lifetime rate.
 *
 * Hitting the average scores 80, not 100 — the average only rises if you beat
 * it, and the headline metric the user cares about is that it keeps rising.
 * One clear of it is full marks.
 */
function consistencyPillar({ count, avgPerWeek }) {
  if (!avgPerWeek) return null;
  const score = count <= avgPerWeek
    ? clamp((count / avgPerWeek) * 80)
    : clamp(80 + ((count - avgPerWeek) / 1) * 20);
  const need = Math.max(0, Math.ceil(avgPerWeek + 1 - count));
  return {
    score,
    detail: `${count} this week · ${avgPerWeek.toFixed(2)} lifetime average`,
    lines: [
      count >= avgPerWeek
        ? `${count} logged against an average of ${avgPerWeek.toFixed(2)} — this week pulls the average up.`
        : `${count} logged against an average of ${avgPerWeek.toFixed(2)} — this week pulls it down.`,
    ],
    nudge: need > 0
      ? `${need} more ${need === 1 ? 'activity' : 'activities'} would take this to full marks.`
      : null,
  };
}

/**
 * Running: distance against the committed target, and whether pace is coming
 * down. Pace is 40% because it is the slower thing to move and a week is a
 * short window to judge it over.
 */
function runningPillar({ doneKm, targetKm, paceNow, paceBefore }) {
  const parts = [];
  const lines = [];

  if (targetKm > 0) {
    const pct = clamp((doneKm / targetKm) * 100);
    parts.push([pct, 0.6]);
    lines.push(`Distance ${Math.round(pct)} — ${doneKm.toFixed(1)} of ${targetKm.toFixed(1)} km on foot.`);
  }

  if (paceNow && paceBefore) {
    /* Seconds per km, so smaller is better. Ten seconds off the four-week mean
       is a full-marks week; ten seconds on is a zero. */
    const delta = paceBefore - paceNow;
    const pace = clamp(50 + (delta / 10) * 50);
    parts.push([pace, 0.4]);
    lines.push(
      `Pace ${Math.round(pace)} — ${fmtPace(paceNow)} against a four-week ${fmtPace(paceBefore)}, `
      + `${delta >= 0 ? `${Math.round(delta)}s/km quicker` : `${Math.round(-delta)}s/km slower`}.`,
    );
  }

  if (!parts.length) return null;
  const weight = parts.reduce((a, [, w]) => a + w, 0);
  const score = parts.reduce((a, [v, w]) => a + v * w, 0) / weight;
  const left = targetKm > 0 ? Math.max(0, targetKm - doneKm) : 0;
  return {
    score,
    detail: targetKm > 0
      ? `${doneKm.toFixed(1)} / ${targetKm.toFixed(1)} km`
      : `${doneKm.toFixed(1)} km, no target committed`,
    lines,
    nudge: left > 0.05 ? `${left.toFixed(1)} km still to run this week.` : null,
  };
}

/**
 * Plan adherence: what you said you would do, against what you did.
 *
 * Capped per modality — two of two planned is perfect and three of two is
 * still perfect, because the plan was two. Overshooting one modality must not
 * paper over missing another.
 */
function adherencePillar({ planned, done }) {
  const kinds = Object.keys(planned || {}).filter((k) => planned[k] > 0);
  if (!kinds.length) return null;

  const rows = kinds.map((k) => {
    const got = done[k] || 0;
    return { kind: k, planned: planned[k], done: got, pct: clamp((got / planned[k]) * 100) };
  });
  const score = rows.reduce((a, r) => a + r.pct, 0) / rows.length;
  const short = rows.filter((r) => r.done < r.planned);

  return {
    score,
    detail: rows.map((r) => `${r.kind} ${r.done}/${r.planned}`).join(' · '),
    lines: rows.map((r) => `${r.kind}: ${r.done} of ${r.planned} planned.`),
    nudge: short.length
      ? `${short.map((r) => `${r.planned - r.done} more ${r.kind}`).join(', ')} to finish the week's intent.`
      : null,
    rows,
  };
}

/**
 * Body: which way the four-week average is moving, relative to the goal.
 *
 * Movement, never level. Scoring the number itself would make every heavy week
 * a failure and every light one a success, regardless of anything done about
 * it — and it would keep scoring you after you arrived.
 */
function bodyPillar({ emaKg, delta4wKg, goalKg }) {
  if (emaKg == null || delta4wKg == null || !goalKg) return null;

  /* `emaKg` and `delta4wKg` are now fed from actual readings, not the seven-day
     curve — see `inputFromSummary`. The parameter names are kept because they
     are what the caller has always passed; what changed is where the caller
     gets them. Scoring still runs on *movement*, which was never about
     smoothing: a heavy week must not read as a failure, and once you arrive it
     stops scoring you at all. */
  const gapKg = emaKg - goalKg;
  if (Math.abs(gapKg) < 0.25) {
    return {
      score: 100,
      detail: `at goal — ${Math.trunc(toLb(emaKg))} lb`,
      lines: [`Last reading ${Math.trunc(toLb(emaKg))} lb against a ${Math.trunc(toLb(goalKg))} lb goal.`],
      nudge: null,
    };
  }

  /* Positive when the average moved toward the goal, whichever side it is on. */
  const toward = gapKg > 0 ? -delta4wKg : delta4wKg;
  const score = clamp(50 + (toward / BODY_FULL_MARKS_KG) * 50);
  return {
    score,
    detail: `${Math.trunc(toLb(emaKg))} lb · ${toLb(gapKg) > 0 ? '+' : ''}${Math.trunc(toLb(gapKg))} lb from goal`,
    lines: [
      `Last reading ${Math.trunc(toLb(emaKg))} lb, ${Math.trunc(Math.abs(toLb(gapKg)))} lb `
      + `${gapKg > 0 ? 'above' : 'below'} the ${toLb(goalKg).toFixed(0)} lb goal.`,
      `It moved ${Math.trunc(Math.abs(toLb(delta4wKg)))} lb ${toward >= 0 ? 'toward' : 'away from'} `
      + 'the goal over four weeks, reading to reading.',
    ],
    nudge: toward < 0 ? 'The four-week trend is going the wrong way.' : null,
  };
}

/**
 * Habits: the small daily things, as a share of the days that have finished.
 *
 * Every figure here comes off `GET /api/habits` already resolved — met,
 * partial, missed, open, unrecorded — because whether a night counts is a
 * question with one answer and `report/habits.py` is where it is answered.
 * This function does arithmetic on those answers and nothing else.
 *
 * Three rules the shape of this enforces:
 *
 *   · **Days that have not finished are not scored.** Today is `open`, not
 *     missed. A Monday morning therefore has nothing to score, the pillar is
 *     absent, and its weight is redistributed — the same treatment a week with
 *     no match gets.
 *   · **A night the watch did not record is not a failed night.** Those days
 *     are `unrecorded` and carry no credit *and no denominator*, so the score
 *     is about how you slept rather than whether you wore a device.
 *   · **Habits are equal to each other, whatever their denominators.** The
 *     score is the mean of each habit's own rate, not total ticks over total
 *     days — otherwise a habit the watch recorded every day would quietly
 *     outweigh one it missed twice.
 *
 * There is no streak term, and there is nowhere to put one: the payload counts
 * days, never runs of them.
 */
export function habitsPillar({ habits }) {
  const list = (habits || []).filter((h) => h && h.totals && h.totals.scored > 0);
  if (!list.length) return null;

  const score = clamp(
    (list.reduce((a, h) => a + h.totals.rate, 0) / list.length) * 100,
  );

  /* Still open today — the one thing on this pillar you can act on before
     midnight. Absent for a past week, where nothing is open any more. */
  const openNow = (habits || [])
    .filter((h) => Object.values(h.days || {}).some((d) => d.state === 'open'))
    .map((h) => h.name);

  const weakest = list.slice().sort((a, b) => a.totals.rate - b.totals.rate)[0];

  return {
    score,
    detail: list.map((h) => `${h.name} ${h.totals.met}/${h.totals.scored}`).join(' · '),
    lines: list.map((h) => {
      const t = h.totals;
      const noun = h.mode === 'metric' ? 'nights' : 'days';
      const partial = Math.abs(t.credit - t.met) >= 0.005
        ? ` — ${t.credit.toFixed(2)} of ${t.scored} counting partial credit`
        : '';
      return `${h.name}: ${t.met} of ${t.scored} ${noun}${partial}.`;
    }),
    nudge: openNow.length
      ? `${listWords(openNow)} still open today.`
      : (weakest && weakest.totals.rate < 1
        ? `${weakest.name} is the weakest of them this week.`
        : null),
    rows: list,
  };
}

/** "a, b and c" — for a nudge that names more than one thing. */
function listWords(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Load: the week against your own trailing four-week rate. */
function loadPillar({ weekTotal, chronicPerDay }) {
  if (!weekTotal || !chronicPerDay) return null;
  const baseline = chronicPerDay * 7;
  const score = clamp((weekTotal / baseline) * 80);
  return {
    score,
    detail: `${Math.round(weekTotal)} AU · baseline ${Math.round(baseline)}`,
    lines: [
      `${Math.round(weekTotal)} AU against a four-week rate of ${Math.round(baseline)} AU a week.`,
    ],
    nudge: null,
  };
}

/* ── the week ────────────────────────────────────────────────────────────── */

/**
 * Score one week. Returns the total, every pillar, and the one thing most
 * worth doing about it.
 *
 * Absent pillars are dropped and the remaining weights renormalised, so the
 * total always means "out of what could be scored this week" rather than
 * quietly penalising a week with no match in it.
 */
export function scoreWeek(input) {
  const built = {
    soccer: soccerPillar(input.soccer || {}),
    consistency: consistencyPillar(input.consistency || {}),
    running: runningPillar(input.running || {}),
    adherence: adherencePillar(input.adherence || {}),
    habits: habitsPillar(input.habits || {}),
    body: bodyPillar(input.body || {}),
    load: loadPillar(input.load || {}),
  };

  const pillars = Object.entries(built)
    .map(([key, p]) => (p ? { key, weight: WEIGHTS[key], ...p } : { key, weight: WEIGHTS[key], score: null, absent: true }));

  const scored = pillars.filter((p) => !p.absent);
  const totalWeight = scored.reduce((a, p) => a + p.weight, 0);
  const weighted = totalWeight
    ? scored.reduce((a, p) => a + p.score * p.weight, 0) / totalWeight
    : null;

  const bonus = Math.min(TRIPLE_MAX, (input.tripleDays || 0) * TRIPLE_POINTS);
  const total = weighted == null ? null : clamp(weighted + bonus);

  /* The weakest pillar carrying real weight — what the page leads its
     "not doing great" line with. A pillar already at full marks is skipped. */
  const weakest = scored
    .filter((p) => p.score < 95)
    .sort((a, b) => (a.score * a.weight) - (b.score * b.weight))[0] || null;

  return { total, weighted, bonus, pillars, scored, weakest, tripleDays: input.tripleDays || 0 };
}

/* ── the level ───────────────────────────────────────────────────────────── */

/**
 * Lifetime points, and the level they buy.
 *
 * Built only from totals that cannot fall — activities logged, matches won,
 * goals and assists, weeks on record. A bad week earns fewer points; it never
 * removes any, and there is no streak to break. That is the whole reason the
 * level is computed from the record rather than from banked week scores.
 */
export function lifetimeLevel({
  activities, wins, draws, involvements, footKm, bikeKm,
}) {
  const P = LIFETIME_POINTS;
  const parts = [
    { label: 'Activities logged', n: activities || 0, each: P.perActivity },
    { label: 'Kilometres on foot', n: Math.round(footKm || 0), each: P.perFootKm },
    { label: 'Kilometres on the bike', n: Math.round(bikeKm || 0), each: P.perBikeKm },
    { label: 'Soccer wins', n: wins || 0, each: P.perSoccerWin },
    { label: 'Soccer draws', n: draws || 0, each: P.perSoccerDraw },
    { label: 'Goals and assists', n: involvements || 0, each: P.perInvolvement },
  ].map((p) => ({ ...p, points: Math.round(p.n * p.each) }));

  const points = parts.reduce((a, p) => a + p.points, 0);
  const level = Math.max(1, Math.floor(Math.sqrt(points / LEVEL_DIVISOR)));
  const at = LEVEL_DIVISOR * level * level;
  const next = LEVEL_DIVISOR * (level + 1) * (level + 1);
  const toNext = next - points;
  return {
    points, level, parts,
    into: points - at,
    span: next - at,
    toNext,
    pct: ((points - at) / (next - at)) * 100,
    /* A number of points is not a goal anybody can act on. These are the same
       distance expressed in things you would actually go and do — the part
       that makes a level mean something rather than tick over. */
    routes: [
      { label: 'soccer wins', n: Math.ceil(toNext / P.perSoccerWin) },
      { label: 'goals or assists', n: Math.ceil(toNext / P.perInvolvement) },
      { label: 'km on foot', n: Math.ceil(toNext / P.perFootKm) },
    ],
  };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

export const toLb = (kg) => kg / KG_PER_LB;
export const toKg = (lb) => lb * KG_PER_LB;

export function fmtPace(s) {
  if (!s) return '—';
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}/km`;
}

/** Plain words for a score. Descriptive, not congratulatory. */
export function band(score) {
  if (score == null) return { key: 'none', label: 'Not enough logged' };
  if (score >= 85) return { key: 'strong', label: 'Strong week' };
  if (score >= 70) return { key: 'solid', label: 'Solid week' };
  if (score >= 50) return { key: 'mixed', label: 'Mixed week' };
  if (score >= 30) return { key: 'thin', label: 'Thin week' };
  return { key: 'poor', label: 'Poor week' };
}


/**
 * The last actual reading — what the scale said, not what a curve inferred.
 *
 * The app used to lead with a seven-day EMA everywhere, which is a defensible
 * statistic and the wrong answer to "what do I weigh": on 24 Aug the scale read
 * 210.0 and every screen said 212.0. A number nobody can reproduce by standing
 * on the scale reads as stale even when it is perfectly current.
 *
 * Readings only, from `bodyweight.series[].kg`. The EMA is still there for
 * anyone plotting a trend line; it is no longer *the* weight.
 */
export function latestWeighIn(series) {
  const list = (series || []).filter((p) => p && p.kg != null);
  return list.length ? list[list.length - 1] : null;
}

/**
 * Change between the last reading and the nearest one `days` ago.
 *
 * Reading to reading, not curve to curve. Both ends are numbers that were
 * actually measured, so the difference is one you could have worked out from
 * two mornings on the scale — which is what anybody means by "am I down over
 * the last month".
 *
 * Returns null when there is nothing that far back to compare against; a delta
 * measured over eight days is not a four-week delta and must not be labelled
 * as one.
 */
export function weighInDelta(series, days = 28) {
  const list = (series || []).filter((p) => p && p.kg != null);
  if (list.length < 2) return null;
  const last = list[list.length - 1];
  const target = addDaysISO(last.date, -days);
  /* The nearest reading at or before the cutoff. Anything later would shorten
     the window and overstate a trend. */
  const prior = list.filter((p) => p.date <= target).pop();
  if (!prior) return null;
  return { kg: last.kg - prior.kg, from: prior, to: last };
}

/** Local date arithmetic, so this module stays free of `core.js`. */
function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * What the bodyweight pillar is scored on: the last reading at or before
 * `asOf`, and how far it moved against the nearest reading four weeks earlier.
 *
 * Readings, never the curve — the number you get by standing on the scale.
 * `asOf` lets a past week be scored on what was known then, so the trend and
 * the current week use one definition rather than two.
 */
function weightBasis(bodyweight, asOf, goalKg) {
  const series = ((bodyweight || {}).series || [])
    .filter((p) => p && p.kg != null && (!asOf || p.date <= asOf));
  if (!series.length) return { emaKg: null, delta4wKg: null, goalKg };
  const last = series[series.length - 1];
  const target = addDaysISO(last.date, -28);
  const prior = series.filter((p) => p.date <= target).pop();
  return {
    emaKg: last.kg,
    delta4wKg: prior ? last.kg - prior.kg : null,
    goalKg,
  };
}

/* ── building inputs from what the API publishes ──────────────────────────── */

const ON_FOOT_KINDS = ['soccer', 'run', 'stairs', 'quickfeet', 'ruck', 'other'];

/** Distance-weighted mean pace over a set of runs, seconds per km. */
export function weightedPace(runs) {
  const withPace = (runs || []).filter((s) => s.pace_s_per_km && s.distance_km);
  if (!withPace.length) return null;
  const km = withPace.reduce((a, s) => a + Number(s.distance_km), 0);
  const secs = withPace.reduce((a, s) => a + Number(s.pace_s_per_km) * Number(s.distance_km), 0);
  return km ? secs / km : null;
}

/**
 * Assemble `scoreWeek` input from a week's sessions and the figures the server
 * already states for it.
 *
 * Shared by the Scoreboard, its week-over-week trend and the Week view's
 * summary widget. Three callers scoring the same week through three private
 * copies of this assembly is precisely how two screens end up disagreeing
 * about one number, which this app has already fixed twice.
 */
export function inputFromSummary({
  sessions, weekCount, avgPerWeek, locked, careerPerMatch,
  paceBefore, bodyweight, asOf, goalKg, weekLoad, chronicPerDay, plannedKinds,
  habitList,
}) {
  const list = sessions || [];

  const matches = list.filter((s) => s.kind === 'soccer').map((s) => ({
    result: (s.detail || {}).result || null,
    goals: Number((s.detail || {}).goals || 0),
    assists: Number((s.detail || {}).assists || 0),
  }));

  const onFootKm = locked && locked.actual_km != null
    ? Number(locked.actual_km)
    : list.filter((s) => ON_FOOT_KINDS.includes(s.kind))
      .reduce((a, s) => a + Number(s.distance_km || 0), 0);

  const done = {};
  for (const s of list) done[s.kind] = (done[s.kind] || 0) + 1;

  const byDay = new Map();
  for (const s of list) byDay.set(s.date, (byDay.get(s.date) || 0) + 1);

  return {
    soccer: { matches, careerPerMatch: careerPerMatch || 0 },
    consistency: {
      count: weekCount != null ? weekCount : list.length,
      avgPerWeek: avgPerWeek || 0,
    },
    running: {
      doneKm: onFootKm,
      targetKm: locked ? Number(locked.target_km) : 0,
      paceNow: weightedPace(list.filter((s) => s.kind === 'run')),
      paceBefore: paceBefore || null,
    },
    adherence: { planned: plannedKinds || {}, done },
    /* Straight through from `GET /api/habits` for this same week. Not derived
       and not re-resolved: the server already decided what every day was
       worth, and a second opinion formed here is how two screens start
       disagreeing about one Tuesday. */
    habits: { habits: habitList || [] },
    /* Derived here, never passed in.
       This used to take `emaKg` and `delta4wKg` as arguments, and three callers
       supplied three different bases: the Week page sent the server's seven-day
       EMA, the Scoreboard sent the last reading, and its trend sent a
       week-anchored reading. Same week, same function, three scores — 69, 74
       and 68 — under a caption promising they were "scored by the same
       function". Sharing the formula was never enough; the inputs had to stop
       being a parameter. */
    body: weightBasis(bodyweight, asOf, goalKg),
    load: { weekTotal: weekLoad || 0, chronicPerDay: chronicPerDay || 0 },
    tripleDays: [...byDay.values()].filter((n) => n >= 3).length,
  };
}


/**
 * How close something got to what was planned, as a tone.
 *
 * Reuses the score ramp rather than inventing a second set of greens, so "hit
 * it" looks the same wherever it appears — a finished week that made its
 * distance, a modality that made its count. Hitting the number is the whole
 * point, so 100% and above is the top band and nothing above it earns a
 * different colour: the plan was the plan.
 */
export function attainTone(pct) {
  if (pct == null) return 'none';
  if (pct >= 100) return 'strong';
  if (pct >= 90) return 'solid';
  if (pct >= 75) return 'mixed';
  if (pct >= 50) return 'thin';
  return 'poor';
}


/* ── milestones ──────────────────────────────────────────────────────────── */

/**
 * The ladders a level is named from.
 *
 * "Level 14" is a number wearing a hat: it says you have done a lot without
 * saying what. So a level takes its name from the last real threshold the
 * record crossed — a name that is literally true of the totals, never invented
 * and never awarded. The next level is named for the nearest threshold still
 * ahead, which turns "251 points away" into something you could go and do.
 *
 * Every ladder counts something that cannot fall, for the same reason the
 * points do: a name you could lose is a streak wearing a different hat.
 *
 * Names are spoken-word plain. Nothing here congratulates anybody — the
 * milestone is the achievement, and it does not need an adjective.
 */
export const MILESTONES = [
  {
    key: 'footKm', unit: 'km', noun: 'on foot',
    steps: [
      [100, 'First hundred on foot'],
      [250, 'Two hundred and fifty on foot'],
      [500, 'Five hundred on foot'],
      [750, 'Seven hundred and fifty on foot'],
      [1000, 'A thousand on foot'],
      [1500, 'Fifteen hundred on foot'],
      [2000, 'Two thousand on foot'],
      [3000, 'Three thousand on foot'],
      [5000, 'Five thousand on foot'],
    ],
  },
  {
    key: 'activities', unit: '', noun: 'activities logged',
    steps: [
      [50, 'Fifty logged'],
      [100, 'A hundred logged'],
      [200, 'Two hundred logged'],
      [300, 'Three hundred logged'],
      [400, 'Four hundred logged'],
      [500, 'Five hundred logged'],
      [750, 'Seven hundred and fifty logged'],
      [1000, 'A thousand logged'],
    ],
  },
  {
    key: 'wins', unit: '', noun: 'soccer wins',
    steps: [
      [5, 'Five wins'],
      [10, 'Ten wins'],
      [25, 'Twenty-five wins'],
      [50, 'Fifty wins'],
      [75, 'Seventy-five wins'],
      [100, 'A hundred wins'],
    ],
  },
  {
    key: 'involvements', unit: '', noun: 'goals and assists',
    steps: [
      [25, 'Twenty-five involvements'],
      [50, 'Fifty involvements'],
      [100, 'A hundred involvements'],
      [150, 'A hundred and fifty involvements'],
      [250, 'Two hundred and fifty involvements'],
      [500, 'Five hundred involvements'],
    ],
  },
  {
    key: 'bikeKm', unit: 'km', noun: 'on the bike',
    steps: [
      [250, 'Two hundred and fifty on the bike'],
      [500, 'Five hundred on the bike'],
      [1000, 'A thousand on the bike'],
      [2000, 'Two thousand on the bike'],
      [5000, 'Five thousand on the bike'],
    ],
  },
];

/**
 * The last threshold crossed, and the nearest one ahead.
 *
 * "Last crossed" is the one you are proportionally closest *above* — the best
 * available stand-in for most-recent without storing a date per milestone.
 * "Next" is the one you are proportionally closest *below*, which is what
 * makes it worth naming: it is the reachable one, not the impressive one.
 */
export function milestoneNames(totals) {
  let current = null;
  let next = null;

  for (const ladder of MILESTONES) {
    const value = Number(totals[ladder.key] || 0);
    for (const [threshold, name] of ladder.steps) {
      if (value >= threshold) {
        /* Closest above, as a fraction of the step itself. */
        const slack = (value - threshold) / threshold;
        if (!current || slack < current.slack) {
          current = { name, slack, threshold, value, unit: ladder.unit, noun: ladder.noun };
        }
      } else {
        const gap = (threshold - value) / threshold;
        if (!next || gap < next.gap) {
          next = {
            name, gap, threshold, value, unit: ladder.unit, noun: ladder.noun,
            remaining: threshold - value,
          };
        }
        break;   // ladders are ascending; the first miss is the nearest one
      }
    }
  }
  return { current, next };
}

/** "8 km on foot" / "16 activities logged" — the gap, in its own units. */
export function milestoneGap(m) {
  if (!m) return null;
  const n = m.unit === 'km' ? Math.max(1, Math.round(m.remaining)) : Math.ceil(m.remaining);
  return `${n}${m.unit ? ` ${m.unit}` : ''} ${m.noun}`;
}
