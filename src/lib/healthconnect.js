// Health Connect (Android) → dataset fragments, through the
// @capgo/capacitor-health plugin. Health Sync can copy Huawei Health data into
// Health Connect; the app then reads it on the phone, no cloud in between.
//
// Hourly aggregates give steps, distance, calories and heart rate per local
// hour (Health Connect de-duplicates overlapping sources itself); samples give
// resting HR, HRV (RMSSD), SpO2, weight and VO2max per day; sleep sessions
// carry their stages; exercise sessions become workouts, with heart rate read
// for the newest ones. `health` is the plugin (or a stand-in in tests).

import { localDateKey, localHour, fallbackOffset, addDays } from './format.js';
import { hrHistogram } from './track.js';
import { familyFromText, labelFromText } from './huawei/sport-types.js';

export const HC_READ = [
  'steps', 'distance', 'calories', 'heartRate', 'restingHeartRate', 'heartRateVariability',
  'oxygenSaturation', 'sleep', 'workouts', 'weight', 'vo2Max',
];

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
/** Workouts per sync whose heart rate is read sample by sample. */
const MAX_WORKOUT_HR = 60;

const ms = (iso) => Date.parse(iso);
const dayOf = (t) => localDateKey(t, fallbackOffset(t));

/** {available, reason, granted, history} — never throws. */
export async function healthStatus(health) {
  if (!health) return { available: false, reason: 'not_android' };
  try {
    const a = await health.isAvailable();
    if (!a?.available) return { available: false, reason: a?.reason || 'unavailable' };
    const st = await health.checkAuthorization({ read: HC_READ, requestHistoryAccess: true });
    return { available: true, granted: st.readAuthorized || [], history: Boolean(st.historyAccessAuthorized) };
  } catch (e) {
    return { available: false, reason: String(e?.message || e) };
  }
}

/** Ask for read access (and for history older than 30 days). */
export async function connectHealth(health) {
  const st = await health.requestAuthorization({ read: HC_READ, write: [], requestHistoryAccess: true });
  return { granted: st.readAuthorized || [], history: Boolean(st.historyAccessAuthorized) };
}

/** Hourly sums or averages → {date: {hour → value}}. */
function byLocalHour(samples, pick = (s) => s.value) {
  const out = {};
  for (const s of samples || []) {
    const t = ms(s.startDate);
    const v = pick(s);
    if (!Number.isFinite(t) || v == null || !Number.isFinite(v)) continue;
    const d = dayOf(t);
    const hr = localHour(t, fallbackOffset(t));
    (out[d] ||= {})[hr] = (out[d][hr] || 0) + v;
  }
  return out;
}

/** Point samples → {date: [values]}. */
function byDay(samples) {
  const out = {};
  for (const s of samples || []) {
    const t = ms(s.startDate);
    if (!Number.isFinite(t) || !Number.isFinite(s.value)) continue;
    (out[dayOf(t)] ||= []).push(s.value);
  }
  return out;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (v) => Math.round(v * 10) / 10;

/** Health Connect sleep stage → the dashboard's stage codes (1 deep, 2 light, 3 REM, 4 awake). */
const STAGE = { deep: 1, light: 2, asleep: 2, rem: 3, awake: 4 };

export function nightFromSession(s) {
  const start = ms(s.startDate), end = ms(s.endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const tz = fallbackOffset(end);
  const night = { date: localDateKey(end, tz), start, end, tz };
  const stages = (s.stages || [])
    .map((st) => ({ a: ms(st.startDate), b: ms(st.endDate), code: STAGE[st.stage] }))
    .filter((st) => st.code && st.b > st.a)
    .sort((x, y) => x.a - y.a);
  if (stages.length) {
    const mins = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const st of stages) mins[st.code] += (st.b - st.a) / 60000;
    night.start = stages[0].a;
    night.end = stages.at(-1).b;
    night.deep = Math.round(mins[1]);
    night.light = Math.round(mins[2]);
    night.rem = Math.round(mins[3]);
    night.awake = Math.round(mins[4]);
    night.total = night.deep + night.light + night.rem;
    night.stages = stages.map((st) => [Math.round((st.a - night.start) / 60000), Math.max(1, Math.round((st.b - st.a) / 60000)), st.code]);
    // Writers that only mark "asleep" give no real stage split.
    if (!stages.some((st) => st.code === 1 || st.code === 3)) {
      delete night.deep;
      delete night.light;
      delete night.rem;
    }
  } else {
    night.total = Math.round((end - start) / 60000);
  }
  return night.total >= 30 && night.total <= 16 * 60 ? night : null;
}

export function workoutFromSession(s) {
  const start = ms(s.startDate), end = ms(s.endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const tz = fallbackOffset(start);
  const type = s.workoutType || 'other';
  const family = familyFromText(type === 'bikingStationary' ? 'cycling' : type);
  const w = {
    id: `hc-${s.platformId || start}`,
    source: 'healthconnect',
    sources: ['healthconnect'],
    sport: type,
    label: labelFromText(type),
    family,
    start,
    end,
    tz,
    date: localDateKey(start, tz),
    duration: Math.round(s.duration || (end - start) / 1000),
    elapsed: Math.round((end - start) / 1000),
  };
  if (s.totalDistance > 0) w.distance = Math.round(s.totalDistance);
  if (s.totalEnergyBurned > 0) w.kcal = Math.round(s.totalEnergyBurned);
  if (s.sourceName) w.upstream = s.sourceName;
  if (w.distance > 0 && w.duration > 0) {
    w.avgSpeed = Math.round((w.distance / w.duration) * 100) / 100;
    if (family !== 'ride' && family !== 'swim') w.avgPace = Math.round(w.duration / (w.distance / 1000));
  }
  return w;
}

/** Read every page of a sample type over [from, to). */
async function samples(health, dataType, from, to) {
  const res = await health.readSamples({ dataType, startDate: new Date(from).toISOString(), endDate: new Date(to).toISOString(), limit: 0, ascending: true });
  return res?.samples || [];
}

async function hourly(health, dataType, from, to, aggregation) {
  const res = await health.queryAggregated({ dataType, startDate: new Date(from).toISOString(), endDate: new Date(to).toISOString(), bucket: 'hour', aggregation });
  return res?.samples || [];
}

/**
 * Read [since, until] from Health Connect into a fragment.
 * Each data type is read on its own: one that is not allowed or fails is
 * reported and skipped, the others still arrive.
 * @returns {{fragment, report: {days, nights, workouts, skipped: string[]}}}
 */
export async function syncHealthConnect({ health, since, until = Date.now(), onProgress = () => {} }) {
  const from = typeof since === 'string' ? Date.parse(`${since}T00:00:00`) : since;
  const to = until;
  const fragment = { days: {}, nights: {}, workouts: {}, tracks: {} };
  const skipped = [];
  const day = (d) => (fragment.days[d] ||= {});
  const steps = ['steps', 'distance', 'calories', 'heartRate', 'restingHeartRate', 'heartRateVariability', 'oxygenSaturation', 'weight', 'vo2Max', 'sleep', 'workouts'];
  let done = 0;
  const step = async (name, fn) => {
    onProgress({ phase: name, done: done++, total: steps.length });
    try {
      await fn();
    } catch (e) {
      skipped.push(`${name}: ${String(e?.message || e).slice(0, 120)}`);
    }
  };

  // Aggregates in 60-day slices keep each answer small.
  const slices = [];
  for (let a = from; a < to; a += 60 * DAY_MS) slices.push([a, Math.min(to, a + 60 * DAY_MS)]);
  const allHours = async (type, agg) => (await Promise.all(slices.map(([a, b]) => hourly(health, type, a, b, agg)))).flat();

  await step('steps', async () => {
    for (const [d, hours] of Object.entries(byLocalHour(await allHours('steps', 'sum')))) {
      const arr = new Array(24).fill(0);
      for (const [h, v] of Object.entries(hours)) arr[h] = Math.round(v);
      const total = arr.reduce((s, v) => s + v, 0);
      if (total > 0) Object.assign(day(d), { steps: total, stepsHourly: arr });
    }
  });
  await step('distance', async () => {
    for (const [d, hours] of Object.entries(byLocalHour(await allHours('distance', 'sum')))) {
      const m = Object.values(hours).reduce((s, v) => s + v, 0);
      if (m > 0 && fragment.days[d]?.steps) day(d).distance = Math.round(m);
    }
  });
  await step('calories', async () => {
    for (const [d, hours] of Object.entries(byLocalHour(await allHours('calories', 'sum')))) {
      const k = Object.values(hours).reduce((s, v) => s + v, 0);
      if (k > 0 && fragment.days[d]?.steps) day(d).kcal = Math.round(k);
    }
  });
  await step('heartRate', async () => {
    const list = await allHours('heartRate', ['average', 'min', 'max']);
    const per = {};
    for (const s of list) {
      const t = ms(s.startDate);
      const avg = s.values?.average ?? s.value;
      if (!Number.isFinite(t) || !Number.isFinite(avg)) continue;
      const d = dayOf(t);
      const p = (per[d] ||= { hours: new Array(24).fill(null), min: Infinity, max: -Infinity, sum: 0, n: 0 });
      p.hours[localHour(t, fallbackOffset(t))] = Math.round(avg);
      p.min = Math.min(p.min, s.values?.min ?? avg);
      p.max = Math.max(p.max, s.values?.max ?? avg);
      p.sum += avg;
      p.n++;
    }
    for (const [d, p] of Object.entries(per)) {
      Object.assign(day(d), { hrHourly: p.hours, hrMin: Math.round(p.min), hrMax: Math.round(p.max), hrAvg: Math.round(p.sum / p.n) });
    }
  });
  const daily = async (type, apply) => {
    for (const [d, list] of Object.entries(byDay(await samples(health, type, from, to)))) apply(day(d), list);
  };
  await step('restingHeartRate', () => daily('restingHeartRate', (r, xs) => { r.restHr = Math.round(Math.min(...xs)); }));
  await step('heartRateVariability', () => daily('heartRateVariability', (r, xs) => { r.hrvAvg = Math.round(mean(xs)); }));
  await step('oxygenSaturation', () => daily('oxygenSaturation', (r, xs) => {
    const v = xs.map((x) => (x <= 1 ? x * 100 : x));
    r.spo2Avg = round1(mean(v));
    r.spo2Min = Math.round(Math.min(...v));
  }));
  await step('weight', () => daily('weight', (r, xs) => { r.weight = round1(xs.at(-1)); }));
  await step('vo2Max', () => daily('vo2Max', (r, xs) => { r.vo2max = round1(xs.at(-1)); }));

  await step('sleep', async () => {
    // Sessions that end inside the window: read from the evening before it.
    for (const s of await samples(health, 'sleep', from - 18 * HOUR_MS, to)) {
      const n = nightFromSession(s);
      if (!n || n.end < from) continue;
      const prev = fragment.nights[n.date];
      if (!prev || n.total > prev.total) fragment.nights[n.date] = n; // naps lose to the night
    }
  });

  await step('workouts', async () => {
    let anchor;
    const sessions = [];
    do {
      const res = await health.queryWorkouts({ startDate: new Date(from).toISOString(), endDate: new Date(to).toISOString(), limit: 0, ascending: true, anchor });
      sessions.push(...(res?.workouts || []));
      anchor = res?.anchor || null;
    } while (anchor && sessions.length < 5000);
    const ws = sessions.map(workoutFromSession).filter(Boolean);
    for (const w of ws) fragment.workouts[w.id] = w;
    for (const w of ws.slice().sort((a, b) => b.start - a.start).slice(0, MAX_WORKOUT_HR)) {
      try {
        const hr = (await samples(health, 'heartRate', w.start, w.end))
          .map((s) => ({ t: ms(s.startDate), v: s.value }))
          .filter((s) => Number.isFinite(s.t) && s.v >= 25 && s.v <= 240)
          .sort((a, b) => a.t - b.t);
        if (hr.length >= 2) {
          w.avgHr = Math.round(mean(hr.map((s) => s.v)));
          w.maxHr = Math.max(...hr.map((s) => s.v));
          w.minHr = Math.min(...hr.map((s) => s.v));
          w.hrHist = hrHistogram(hr);
        }
      } catch {
        /* heart rate not allowed: summary only */
      }
    }
  });
  onProgress({ phase: 'done', done: steps.length, total: steps.length });

  for (const [d, r] of Object.entries(fragment.days)) if (!Object.keys(r).length) delete fragment.days[d];
  return {
    fragment,
    report: {
      days: Object.keys(fragment.days).length,
      nights: Object.keys(fragment.nights).length,
      workouts: Object.keys(fragment.workouts).length,
      skipped,
    },
  };
}

/** Where the next sync starts: two days before the last one (late writes), else 30 days or a year back. */
export function healthSince(lastTo, { history = false, today }) {
  if (lastTo) return addDays(lastTo < today ? lastTo : today, -2);
  return addDays(today, history ? -365 : -29);
}
