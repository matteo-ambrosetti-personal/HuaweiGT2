// Statistics over the normalised dataset. Pure functions; dates are "YYYY-MM-DD".

import { addDays, daysBetween, weekStart, weekdayIndex, localMinuteOfDay, todayKey } from './format.js';
import { chartBucket, BUCKETS } from './huawei/sport-types.js';
import { EFFORTS } from './track.js';

export const DEFAULT_SETTINGS = { stepGoal: 10000, sleepGoalMin: 480, maxHr: null, birthYear: null };

export const PRESETS = [
  { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '30D', days: 30 },
  { key: '90d', label: '90D', days: 90 },
  { key: '1y', label: '1Y', days: 365 },
  { key: 'all', label: 'All', days: null },
];

/** Latest date with any data, else today. */
export function latestDate(ds) {
  let max = null;
  for (const k of Object.keys(ds.days)) if (!max || k > max) max = k;
  for (const k of Object.keys(ds.nights)) if (!max || k > max) max = k;
  for (const w of Object.values(ds.workouts)) if (!max || w.date > max) max = w.date;
  return max;
}

export function earliestDate(ds) {
  let min = null;
  for (const k of Object.keys(ds.days)) if (!min || k < min) min = k;
  for (const k of Object.keys(ds.nights)) if (!min || k < min) min = k;
  for (const w of Object.values(ds.workouts)) if (!min || w.date < min) min = w.date;
  return min;
}

/**
 * Resolve a preset to a date range ending at the latest data (or today when
 * the data is current). Custom ranges pass {from, to} straight through.
 */
export function resolveRange(ds, preset, custom) {
  if (preset === 'custom' && custom?.from && custom?.to) return { from: custom.from, to: custom.to };
  const last = latestDate(ds) || todayKey();
  const today = todayKey();
  const to = last > today ? last : (daysBetween(last, today) <= 3 ? today : last);
  const p = PRESETS.find((x) => x.key === preset) || PRESETS[1];
  if (!p.days) return { from: earliestDate(ds) || addDays(to, -29), to };
  return { from: addDays(to, -(p.days - 1)), to };
}

export function previousRange({ from, to }) {
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

export function eachDate(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** One row per date in range (empty rows for missing days). */
export function daySeries(ds, { from, to }) {
  return eachDate(from, to).map((date) => ds.days[date] || { date });
}

export function workoutsIn(ds, { from, to }, families = null) {
  return Object.values(ds.workouts)
    .filter((w) => w.date >= from && w.date <= to && (!families || families.includes(w.family)))
    .sort((a, b) => a.start - b.start);
}

export function nightsIn(ds, { from, to }) {
  return Object.values(ds.nights)
    .filter((n) => n.date >= from && n.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const vals = (rows, f) => rows.map((r) => r[f]).filter((v) => v != null && Number.isFinite(v));

/** Headline numbers for a range. */
export function summarize(ds, range, settings = DEFAULT_SETTINGS) {
  const rows = daySeries(ds, range);
  const stepRows = rows.filter((r) => r.steps != null && r.steps > 0);
  const workouts = workoutsIn(ds, range);
  const nights = nightsIn(ds, range);
  const byBucket = Object.fromEntries(BUCKETS.map((b) => [b, { n: 0, distance: 0, duration: 0 }]));
  for (const w of workouts) {
    const b = byBucket[chartBucket(w.family)];
    b.n++;
    b.distance += w.distance || 0;
    b.duration += w.duration || 0;
  }
  const totals = (f) => vals(rows, f).reduce((s, x) => s + x, 0);
  const active = new Set(stepRows.map((r) => r.date));
  for (const w of workouts) active.add(w.date);
  for (const n of nights) active.add(n.date);
  return {
    range,
    dayCount: rows.length,
    dataDays: active.size,
    stepDays: stepRows.length,
    avgSteps: mean(stepRows.map((r) => r.steps)),
    totalSteps: totals('steps'),
    goalDays: stepRows.filter((r) => r.steps >= settings.stepGoal).length,
    walkDistance: totals('distance'),
    kcal: totals('kcal'),
    activeMin: totals('activeMin'),
    workouts: workouts.length,
    workoutTime: workouts.reduce((s, w) => s + (w.duration || 0), 0),
    workoutDistance: workouts.reduce((s, w) => s + (w.distance || 0), 0),
    byBucket,
    restHr: mean(vals(rows, 'restHr')),
    hrAvg: mean(vals(rows, 'hrAvg')),
    spo2: mean(vals(rows, 'spo2Avg')),
    stress: mean(vals(rows, 'stressAvg')),
    hrv: mean(vals(rows, 'hrvAvg')),
    nights: nights.length,
    sleepAvg: mean(vals(nights, 'total')),
    sleepScore: mean(vals(nights, 'score')),
    deepShare: shareOf(nights, 'deep'),
    remShare: shareOf(nights, 'rem'),
  };
}

function shareOf(nights, stage) {
  const withStages = nights.filter((n) => n.total > 0 && n[stage] != null);
  if (!withStages.length) return null;
  const s = withStages.reduce((a, n) => a + n[stage], 0);
  const t = withStages.reduce((a, n) => a + n.total, 0);
  return t ? s / t : null;
}

/** True when the previous period has enough data to compare against. */
export function comparable(cur, prev) {
  return prev.dataDays > 0 && prev.dataDays >= 0.8 * cur.dataDays;
}

/** Relative change; null when either side is missing or zero. */
export function change(cur, prev) {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

/** Goal streaks: consecutive days with steps ≥ goal. */
export function streaks(ds, goal, today = latestDate(ds)) {
  const dates = Object.keys(ds.days).filter((d) => ds.days[d].steps != null).sort();
  let longest = 0, longestEnd = null, run = 0, prev = null;
  for (const d of dates) {
    const ok = ds.days[d].steps >= goal;
    if (ok && prev && daysBetween(prev, d) === 1 && run > 0) run++;
    else run = ok ? 1 : 0;
    if (!ok) run = 0;
    if (run > longest) { longest = run; longestEnd = d; }
    prev = d;
  }
  // current streak counts back from the latest day (today may be partial)
  let current = 0;
  let d = today;
  if (d && ds.days[d] && !(ds.days[d].steps >= goal)) d = addDays(d, -1);
  while (d && ds.days[d] && ds.days[d].steps >= goal) {
    current++;
    d = addDays(d, -1);
  }
  return { current, longest, longestEnd };
}

/** Average of a field by weekday (Mon…Sun). */
export function weekdayProfile(rows, field) {
  const sum = new Array(7).fill(0), n = new Array(7).fill(0);
  for (const r of rows) {
    const v = r[field];
    if (v == null || !Number.isFinite(v)) continue;
    if (field === 'steps' && v <= 0) continue;
    const i = weekdayIndex(r.date);
    sum[i] += v;
    n[i]++;
  }
  return sum.map((s, i) => (n[i] ? s / n[i] : null));
}

/** Average hourly profile from 24-value arrays (e.g. stepsHourly, hrHourly). */
export function hourProfile(rows, field) {
  const sum = new Array(24).fill(0), n = new Array(24).fill(0);
  for (const r of rows) {
    const arr = r[field];
    if (!Array.isArray(arr)) continue;
    arr.forEach((v, h) => {
      if (v == null || !Number.isFinite(v)) return;
      sum[h] += v;
      n[h]++;
    });
  }
  return sum.map((s, h) => (n[h] ? s / n[h] : null));
}

/** Weekly totals per chart bucket (duration in s or distance in m). */
export function weeklyVolume(ds, range, metric = 'duration') {
  const weeks = new Map();
  for (let w = weekStart(range.from); w <= range.to; w = addDays(w, 7)) {
    weeks.set(w, { week: w, run: 0, walkhike: 0, ride: 0, other: 0 });
  }
  for (const wk of workoutsIn(ds, range)) {
    const row = weeks.get(weekStart(wk.date));
    if (!row) continue;
    row[chartBucket(wk.family)] += metric === 'distance' ? wk.distance || 0 : wk.duration || 0;
  }
  return [...weeks.values()];
}

/** Rolling mean over a window, ignoring nulls (needs ≥ half the window). */
export function rollingMean(values, window) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = values[j];
      if (v != null && Number.isFinite(v)) { s += v; n++; }
    }
    if (n >= Math.ceil(window / 2) || (i < window && n > 0 && n >= Math.ceil((i + 1) / 2))) out[i] = s / n;
  }
  return out;
}

export function rollingMedian(values, window) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const w = [];
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = values[j];
      if (v != null && Number.isFinite(v)) w.push(v);
    }
    if (w.length) {
      w.sort((a, b) => a - b);
      out[i] = w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2;
    }
  }
  return out;
}

/** Least-squares line through (x, y) pairs. */
export function linearTrend(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const d = n * sxx - sx * sx;
  if (!d) return null;
  const slope = (n * sxy - sx * sy) / d;
  return { slope, intercept: (sy - slope * sx) / n };
}

// ------------------------------------------------------------- heart rate zones

export const ZONES = [
  { key: 'z1', label: 'Zone 1 · Warm-up', lo: 0.5, hi: 0.6 },
  { key: 'z2', label: 'Zone 2 · Easy', lo: 0.6, hi: 0.7 },
  { key: 'z3', label: 'Zone 3 · Aerobic', lo: 0.7, hi: 0.8 },
  { key: 'z4', label: 'Zone 4 · Threshold', lo: 0.8, hi: 0.9 },
  { key: 'z5', label: 'Zone 5 · Maximum', lo: 0.9, hi: 1.01 },
];

/** Max HR: setting, else 220 − age, else the 98th percentile of workout maxima. */
export function estimateMaxHr(ds, settings = DEFAULT_SETTINGS) {
  if (settings.maxHr > 100) return { value: settings.maxHr, basis: 'setting' };
  if (settings.birthYear > 1900) {
    return { value: 220 - (new Date().getFullYear() - settings.birthYear), basis: 'age' };
  }
  const maxima = Object.values(ds.workouts).map((w) => w.maxHr).filter((v) => v > 100 && v < 230).sort((a, b) => a - b);
  if (maxima.length >= 3) {
    return { value: Math.round(maxima[Math.floor((maxima.length - 1) * 0.98)] + 3), basis: 'workouts' };
  }
  return { value: 190, basis: 'default' };
}

export function zoneBounds(maxHr) {
  return ZONES.map((z) => [Math.round(z.lo * maxHr), Math.round(z.hi * maxHr)]);
}

/** Seconds per zone from a workout HR histogram. */
export function zonesFromHist(hist, maxHr) {
  const out = [0, 0, 0, 0, 0];
  if (!hist) return out;
  const bounds = zoneBounds(maxHr);
  hist.secs.forEach((s, i) => {
    const bpm = hist.from + hist.step * (i + 0.5);
    for (let z = 4; z >= 0; z--) {
      if (bpm >= bounds[z][0]) { out[z] += s; break; }
    }
  });
  return out;
}

// ------------------------------------------------------------- records

/** Personal records over the whole dataset. */
export function personalRecords(ds) {
  const efforts = {};
  const longest = {};
  let biggestClimb = null, fastestRun = null, mostSteps = null;
  for (const w of Object.values(ds.workouts)) {
    for (const [k, t] of Object.entries(w.efforts || {})) {
      if (!efforts[k] || t < efforts[k].time) efforts[k] = { time: t, id: w.id, date: w.date };
    }
    const b = chartBucket(w.family);
    if (w.distance > 0 && (!longest[b] || w.distance > longest[b].distance)) longest[b] = w;
    if (w.ascent > 0 && (!biggestClimb || w.ascent > biggestClimb.ascent)) biggestClimb = w;
    if (w.family === 'run' && w.distance >= 3000 && w.avgPace > 0 && (!fastestRun || w.avgPace < fastestRun.avgPace)) fastestRun = w;
  }
  for (const d of Object.values(ds.days)) {
    if (d.steps > 0 && (!mostSteps || d.steps > mostSteps.steps)) mostSteps = d;
  }
  return {
    efforts: EFFORTS.map((e) => ({ ...e, best: efforts[e.key] || null })),
    longest,
    biggestClimb,
    fastestRun,
    mostSteps,
  };
}

/** Totals per calendar year. */
export function yearSummary(ds) {
  const years = new Map();
  const row = (y) => {
    if (!years.has(y)) years.set(y, { year: y, steps: 0, stepDays: 0, workouts: 0, time: 0, run: 0, walkhike: 0, ride: 0, other: 0, sleepSum: 0, nights: 0 });
    return years.get(y);
  };
  for (const d of Object.values(ds.days)) {
    if (!(d.steps > 0)) continue;
    const r = row(d.date.slice(0, 4));
    r.steps += d.steps;
    r.stepDays++;
  }
  for (const w of Object.values(ds.workouts)) {
    const r = row(w.date.slice(0, 4));
    r.workouts++;
    r.time += w.duration || 0;
    r[chartBucket(w.family)] += w.distance || 0;
  }
  for (const n of Object.values(ds.nights)) {
    if (!(n.total > 0)) continue;
    const r = row(n.date.slice(0, 4));
    r.sleepSum += n.total;
    r.nights++;
  }
  return [...years.values()]
    .map((r) => ({ ...r, avgSteps: r.stepDays ? r.steps / r.stepDays : null, avgSleep: r.nights ? r.sleepSum / r.nights : null }))
    .sort((a, b) => (a.year < b.year ? 1 : -1));
}

/** Cumulative workout distance by day of year, per year. */
export function cumulativeByYear(ds, buckets = null) {
  const out = {};
  const list = Object.values(ds.workouts)
    .filter((w) => w.distance > 0 && (!buckets || buckets.includes(chartBucket(w.family))))
    .sort((a, b) => a.start - b.start);
  for (const w of list) {
    const y = w.date.slice(0, 4);
    const doy = daysBetween(`${y}-01-01`, w.date);
    const arr = (out[y] ||= []);
    const prev = arr.length ? arr[arr.length - 1].km : 0;
    arr.push({ doy, km: prev + w.distance / 1000 });
  }
  return out;
}

/** Best single day / ISO week / calendar month of steps. */
export function stepBests(ds) {
  let day = null;
  const weeks = new Map(), months = new Map();
  for (const d of Object.values(ds.days)) {
    if (!(d.steps > 0)) continue;
    if (!day || d.steps > day.steps) day = d;
    const w = weekStart(d.date);
    weeks.set(w, (weeks.get(w) || 0) + d.steps);
    const m = d.date.slice(0, 7);
    months.set(m, (months.get(m) || 0) + d.steps);
  }
  const top = (map) => {
    let best = null;
    for (const [k, v] of map) if (!best || v > best.steps) best = { key: k, steps: v };
    return best;
  };
  return { day, week: top(weeks), month: top(months) };
}

// ------------------------------------------------------------- sleep

/** Minutes relative to midnight of the wake date (evening → negative). */
export function bedMinute(ms, tz) {
  if (ms == null) return null;
  const m = localMinuteOfDay(ms, tz);
  return m > 720 ? m - 1440 : m;
}

export function sleepSummary(nights) {
  const withTotal = nights.filter((n) => n.total > 0);
  const starts = withTotal.map((n) => bedMinute(n.start, n.tz)).filter((v) => v != null);
  const ends = withTotal.map((n) => (n.end == null ? null : localMinuteOfDay(n.end, n.tz))).filter((v) => v != null);
  const sd = (xs) => {
    const m = mean(xs);
    return xs.length > 1 ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) : null;
  };
  return {
    nights: withTotal.length,
    avgTotal: mean(withTotal.map((n) => n.total)),
    avgDeep: mean(vals(withTotal, 'deep')),
    avgLight: mean(vals(withTotal, 'light')),
    avgRem: mean(vals(withTotal, 'rem')),
    avgAwake: mean(vals(withTotal, 'awake')),
    avgScore: mean(vals(withTotal, 'score')),
    avgStart: mean(starts),
    avgEnd: mean(ends),
    startSpread: sd(starts),
  };
}
