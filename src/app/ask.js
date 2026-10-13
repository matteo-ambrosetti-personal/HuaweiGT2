// "Ask Claude": questions about the user's own data, answered through the
// `sample` capability. Claude gets standing instructions plus page tools that
// read the dataset, so answers come from real numbers rather than a dump.

import { summarize, streaks, sleepSummary, nightsIn, personalRecords, yearSummary, estimateMaxHr, zonesFromHist, ZONES, eachDate } from '../lib/stats.js';
import { datasetRange } from '../lib/model.js';
import { todayKey, addDays } from '../lib/format.js';
import { chartBucket } from '../lib/huawei/sport-types.js';

const datesOf = ({ from, to }) => eachDate(from, to);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r0 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v));

function clampRange(ds, from, to) {
  const cov = datasetRange(ds) || { from: addDays(todayKey(), -30), to: todayKey() };
  const ok = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  return { from: ok(from) ? from : cov.from, to: ok(to) ? to : cov.to };
}

function workoutBrief(w) {
  return {
    id: w.id,
    date: w.date,
    sport: w.label,
    family: w.family,
    distance_km: w.distance ? r1(w.distance / 1000) : null,
    duration_min: r0(w.duration / 60),
    pace_min_per_km: w.family !== 'ride' && w.distance > 0 ? r1(w.duration / 60 / (w.distance / 1000)) : null,
    speed_kmh: w.family === 'ride' && w.distance > 0 ? r1((w.distance / w.duration) * 3.6) : null,
    avg_hr: r0(w.avgHr),
    max_hr: r0(w.maxHr),
    ascent_m: r0(w.ascent),
    kcal: r0(w.kcal),
    cadence: r0(w.avgCadence),
    source: w.source,
  };
}

const METRICS = {
  steps: { get: (d) => d.steps, agg: 'mean_per_day' },
  distance_km: { get: (d) => (d.distance != null ? d.distance / 1000 : null), agg: 'mean_per_day' },
  active_kcal: { get: (d) => d.kcal, agg: 'mean_per_day' },
  resting_hr: { get: (d) => d.restHr, agg: 'mean' },
  avg_hr: { get: (d) => d.hrAvg, agg: 'mean' },
  spo2: { get: (d) => d.spo2Avg, agg: 'mean' },
  stress: { get: (d) => d.stressAvg, agg: 'mean' },
  hrv: { get: (d) => d.hrvAvg, agg: 'mean' },
};
const NIGHT_METRICS = {
  sleep_minutes: (n) => n.total,
  deep_minutes: (n) => n.deep,
  rem_minutes: (n) => n.rem,
  sleep_score: (n) => n.score,
};

export function buildTools(getCtx) {
  return [
    {
      name: 'get_overview',
      description: 'Headline numbers for a date range: average steps, goal days, workouts, distance by sport, resting HR, sleep, SpO2, stress, HRV, plus current and longest step-goal streaks. Dates are YYYY-MM-DD; omit to use all data.',
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
      execute: ({ from, to }) => {
        const { ds, settings } = getCtx();
        const range = clampRange(ds, from, to);
        const s = summarize(ds, range, settings);
        const st = streaks(ds, settings.stepGoal);
        const sl = sleepSummary(nightsIn(ds, range));
        return {
          range,
          days_with_steps: s.stepDays,
          avg_steps: r0(s.avgSteps),
          goal_days: s.goalDays,
          step_goal: settings.stepGoal,
          workouts: s.workouts,
          workout_hours: r1(s.workoutTime / 3600),
          distance_km_by_sport: Object.fromEntries(Object.entries(s.byBucket).map(([k, v]) => [k, r1(v.distance / 1000)])),
          sessions_by_sport: Object.fromEntries(Object.entries(s.byBucket).map(([k, v]) => [k, v.n])),
          resting_hr: r1(s.restHr),
          spo2: r1(s.spo2),
          stress: r1(s.stress),
          hrv: r1(s.hrv),
          sleep: { nights: sl.nights, avg_minutes: r0(sl.avgTotal), deep_minutes: r0(sl.avgDeep), rem_minutes: r0(sl.avgRem), score: r0(sl.avgScore) },
          streaks: st,
        };
      },
    },
    {
      name: 'query_workouts',
      description: 'List workouts (newest first) with distance, duration, pace or speed, heart rate, ascent and calories. Filter by date range and family (run, walk, hike, ride, swim, gym, other). Sort by date, distance, duration or pace. Returns at most 60.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' }, to: { type: 'string' },
          family: { type: 'string', enum: ['run', 'walk', 'hike', 'ride', 'swim', 'gym', 'other'] },
          sort: { type: 'string', enum: ['date', 'distance', 'duration', 'pace'] },
          limit: { type: 'number' },
        },
      },
      execute: ({ from, to, family, sort = 'date', limit = 30 }) => {
        const { ds } = getCtx();
        const range = clampRange(ds, from, to);
        let list = Object.values(ds.workouts).filter((w) => w.date >= range.from && w.date <= range.to && (!family || w.family === String(family)));
        const key = { date: (w) => -w.start, distance: (w) => -(w.distance || 0), duration: (w) => -(w.duration || 0), pace: (w) => w.avgPace || 1e9 }[sort] || ((w) => -w.start);
        list = list.sort((a, b) => key(a) - key(b));
        const n = Math.max(1, Math.min(60, Number(limit) || 30));
        return { range, total: list.length, workouts: list.slice(0, n).map(workoutBrief) };
      },
    },
    {
      name: 'daily_series',
      description: 'A metric over time, by day, week or month. Metrics: steps, distance_km, active_kcal, resting_hr, avg_hr, spo2, stress, hrv, sleep_minutes, deep_minutes, rem_minutes, sleep_score. Weekly/monthly values are daily averages. At most 400 points.',
      inputSchema: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: [...Object.keys(METRICS), ...Object.keys(NIGHT_METRICS)] },
          from: { type: 'string' }, to: { type: 'string' },
          group: { type: 'string', enum: ['day', 'week', 'month'] },
        },
        required: ['metric'],
      },
      execute: ({ metric, from, to, group = 'day' }) => {
        const { ds } = getCtx();
        const range = clampRange(ds, from, to);
        const m = String(metric);
        const getter = METRICS[m]?.get;
        const nightGet = NIGHT_METRICS[m];
        if (!getter && !nightGet) throw new Error(`Unknown metric ${m}`);
        const rows = datesOf(range).map((date) => {
          const v = getter ? (ds.days[date] ? getter(ds.days[date]) : null) : (ds.nights[date] ? nightGet(ds.nights[date]) : null);
          return { date, v: m === 'steps' && !(v > 0) ? null : v };
        });
        const keyOf = (d) => (group === 'month' ? d.slice(0, 7) : group === 'week' ? weekKey(d) : d);
        const buckets = new Map();
        for (const r of rows) {
          if (r.v == null || !Number.isFinite(r.v)) continue;
          const k = keyOf(r.date);
          const b = buckets.get(k) || { sum: 0, n: 0 };
          b.sum += r.v;
          b.n++;
          buckets.set(k, b);
        }
        const points = [...buckets.entries()].map(([period, b]) => ({ period, value: r1(b.sum / b.n), days: b.n }));
        return { metric: m, group, range, points: points.slice(-400) };
      },
    },
    {
      name: 'get_workout',
      description: 'Full detail of one workout by id: summary, km splits (pace s/km, HR, climb), best efforts in seconds, and time in heart-rate zones.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      execute: ({ id }) => {
        const { ds, settings } = getCtx();
        const w = ds.workouts[String(id)];
        if (!w) throw new Error('No workout with that id. Use query_workouts to find ids.');
        const maxHr = estimateMaxHr(ds, settings);
        const zones = w.hrHist ? zonesFromHist(w.hrHist, maxHr.value) : null;
        return {
          ...workoutBrief(w),
          start_local: new Date(w.start + (w.tz ?? 0) * 60000).toISOString().slice(0, 16).replace('T', ' '),
          elapsed_min: r0(w.elapsed / 60),
          steps: w.steps ?? null,
          splits: (w.splits || []).slice(0, 60),
          best_efforts_s: w.efforts || null,
          hr_zones_minutes: zones ? Object.fromEntries(ZONES.map((z, i) => [z.label, r1(zones[i] / 60)])) : null,
          max_hr_used: maxHr,
        };
      },
    },
    {
      name: 'get_records',
      description: 'Personal records (fastest 1k/5k/10k/half/marathon efforts, longest run/walk/ride, biggest climb, most steps in a day) and totals per calendar year.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const { ds } = getCtx();
        const pr = personalRecords(ds);
        return {
          efforts: pr.efforts.map((e) => ({ distance: e.label, best_s: e.best?.time ?? null, date: e.best?.date ?? null, workout_id: e.best?.id ?? null })),
          longest: Object.fromEntries(Object.entries(pr.longest).map(([k, w]) => [k, workoutBrief(w)])),
          biggest_climb: pr.biggestClimb ? workoutBrief(pr.biggestClimb) : null,
          most_steps_day: pr.mostSteps ? { date: pr.mostSteps.date, steps: pr.mostSteps.steps } : null,
          years: yearSummary(ds).map((y) => ({
            year: y.year, workouts: y.workouts, hours: r1(y.time / 3600),
            run_km: r1(y.run / 1000), walk_hike_km: r1(y.walkhike / 1000), ride_km: r1(y.ride / 1000),
            avg_steps: r0(y.avgSteps), avg_sleep_min: r0(y.avgSleep),
          })),
        };
      },
    },
  ];
}

function weekKey(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Standing instructions: the first user turn of every conversation. */
export function instructions(ctx) {
  const { ds, settings, isSample } = ctx;
  const cov = datasetRange(ds);
  const maxHr = estimateMaxHr(ds, settings);
  const counts = { days: Object.keys(ds.days).length, workouts: Object.keys(ds.workouts).length, nights: Object.keys(ds.nights).length };
  const sports = {};
  for (const w of Object.values(ds.workouts)) sports[chartBucket(w.family)] = (sports[chartBucket(w.family)] || 0) + 1;
  return [
    'You help the owner of a Huawei Watch GT 2 understand their own activity, workout, sleep and heart data, shown in their "GT 2 Logbook" dashboard.',
    `Today is ${todayKey()}. The data covers ${cov ? `${cov.from} to ${cov.to}` : 'nothing yet'}: ${counts.days} days of daily metrics, ${counts.workouts} workouts (${Object.entries(sports).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}), ${counts.nights} nights of sleep.`,
    `Settings: step goal ${settings.stepGoal}, sleep goal ${Math.round(settings.sleepGoalMin / 60 * 10) / 10} h, max heart rate ${maxHr.value} bpm (${maxHr.basis}). Units are metric.`,
    isSample ? 'IMPORTANT: the dashboard is currently showing generated SAMPLE data, not the user\'s real data. Say so if it matters.' : '',
    'Use the tools to look up numbers instead of guessing, and quote concrete figures and dates. Compare periods when it helps.',
    'Answer in plain language, in at most about 200 words; use short bullet points for lists. Wrist sensors are estimates; mention that when precision matters.',
    'You are not a doctor: do not diagnose. For worrying health signs, suggest talking to a medical professional.',
  ].filter(Boolean).join('\n');
}

export const SUGGESTIONS = [
  'How has my running pace changed this year?',
  'Am I sleeping enough? Which weekdays are worst?',
  'Is my resting heart rate improving?',
  'What was my best training week, and what did I do?',
  'Summarise my last 30 days in five bullets.',
];

export const ERROR_COPY = {
  not_granted: 'Claude is not allowed on this page. Allow it from the artifact\'s permissions to ask questions.',
  sampling_disabled: 'Claude is not available for this account.',
  not_declared: 'This version of the page cannot ask Claude.',
  capability_disabled: 'Asking Claude is not available in this view.',
  capability_removed: 'Asking Claude is not available in this view.',
  rate_limited: 'Too many questions in a short time. Wait a minute and ask again.',
  session_expired: 'Your claude.ai session expired. Sign in again, then ask.',
  refused: 'Claude declined to answer that. Try asking it differently.',
  empty_completion: 'No answer came back. Try a simpler question.',
  prompt_too_large: 'That needed too much data at once. Ask about a shorter period.',
  upstream_error: 'The answer was interrupted. Ask again.',
  tools_unavailable: 'Claude cannot read your data in this view; it answered from a summary.',
  bad_key: 'The Anthropic API key was not accepted. Check it in the Claude Console, or paste a new one.',
  offline: 'Could not reach api.anthropic.com. Check your connection and ask again.',
  bad_request: 'The request was rejected. Try a different question, or a different model.',
};
