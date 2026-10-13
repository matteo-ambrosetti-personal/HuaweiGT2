// Training load from heart rate, and the models built on it.
//
//   TRIMP (Banister 1991; Morton, Fitz-Clarke & Banister 1990): minutes ×
//     ΔHR × k1·e^(k2·ΔHR), ΔHR the heart-rate reserve fraction. Men k = 0.64,
//     1.92; women 0.86, 1.67. Computed per 5-bpm bin of the workout's HR
//     histogram, so intervals count for what they were.
//   Edwards TRIMP (Edwards 1993): minutes in each %HRmax zone × 1…5.
//   Fitness–fatigue / impulse–response model (Banister et al. 1975; Calvert
//     et al. 1976), as the Performance Management Chart: fitness (CTL) and
//     fatigue (ATL) are exponentially weighted loads with 42- and 7-day time
//     constants; form (TSB) is yesterday's fitness minus yesterday's fatigue.
//   Acute:chronic workload ratio with EWMAs (Williams et al. 2017; Gabbett 2016).
//   Monotony and strain (Foster 1998): weekly mean/SD of daily load; strain = load × monotony.
//   Intensity distribution in Seiler's three zones (Seiler & Kjerland 2006;
//     Seiler 2010) with Treff et al.'s (2019) polarization index.

import { addDays, weekStart, daysBetween } from '../format.js';
import { median, mean, sd, round, finite } from './util.js';

export const TRIMP_K = { male: [0.64, 1.92], female: [0.86, 1.67] };
export const CTL_DAYS = 42;
export const ATL_DAYS = 7;

/** Heart-rate reserve fraction, clamped to [0, 1]. */
export function hrReserve(hr, rest, max) {
  if (!finite(hr) || !(max > rest)) return null;
  return Math.max(0, Math.min(1, (hr - rest) / (max - rest)));
}

/** Banister TRIMP of `minutes` at heart rate `hr`. */
export function trimpAt(minutes, hr, { rest, max, sex }) {
  const x = hrReserve(hr, rest, max);
  if (x == null) return 0;
  const [k1, k2] = TRIMP_K[sex === 'female' ? 'female' : 'male'];
  return minutes * x * k1 * Math.exp(k2 * x);
}

/**
 * Banister TRIMP of one workout: from its HR histogram when it has one, else
 * from average HR × moving time (which underestimates intervals a little).
 * @returns {{trimp: number, basis: 'hist'|'avg'}|null}
 */
export function workoutTrimp(w, hr) {
  if (w.hrHist?.secs?.length) {
    let t = 0;
    w.hrHist.secs.forEach((s, i) => {
      if (s > 0) t += trimpAt(s / 60, w.hrHist.from + w.hrHist.step * (i + 0.5), hr);
    });
    return { trimp: t, basis: 'hist' };
  }
  if (w.avgHr > 0 && w.duration > 0) return { trimp: trimpAt(w.duration / 60, w.avgHr, hr), basis: 'avg' };
  return null;
}

/** Edwards' summated-zone TRIMP: minutes in 50–60 … 90–100 % HRmax × 1 … 5. */
export function edwardsTrimp(w, max) {
  if (!w.hrHist?.secs?.length || !(max > 0)) return null;
  let t = 0;
  w.hrHist.secs.forEach((s, i) => {
    const pct = (w.hrHist.from + w.hrHist.step * (i + 0.5)) / max;
    const zone = pct >= 0.9 ? 5 : pct >= 0.8 ? 4 : pct >= 0.7 ? 3 : pct >= 0.6 ? 2 : pct >= 0.5 ? 1 : 0;
    t += (s / 60) * zone;
  });
  return t;
}

/** Resting HR to use on a date: median of the 30 days before it, else the overall median, else 60. */
export function restingHrOn(ds, date, cache = new Map()) {
  if (cache.has(date)) return cache.get(date);
  const vals = [];
  for (let d = addDays(date, -30); d <= date; d = addDays(d, 1)) {
    const v = ds.days[d]?.restHr;
    if (v > 25 && v < 120) vals.push(v);
  }
  let r = vals.length >= 3 ? median(vals) : null;
  if (r == null) {
    cache.allRest ??= median(Object.values(ds.days).map((x) => x.restHr).filter((v) => v > 25 && v < 120));
    r = cache.allRest ?? 60;
  }
  cache.set(date, r);
  return r;
}

/**
 * TRIMP for every workout. Workouts without heart rate get the median
 * TRIMP per minute of the same sport family × their duration, marked imputed.
 * @returns {Map<id, {trimp, basis: 'hist'|'avg'|'imputed', edwards}>}
 */
export function workoutLoads(ds, { maxHr, sex = null }) {
  const out = new Map();
  const rateBy = {};
  const cache = new Map();
  const ws = Object.values(ds.workouts).sort((a, b) => a.start - b.start);
  for (const w of ws) {
    const r = workoutTrimp(w, { rest: restingHrOn(ds, w.date, cache), max: maxHr, sex });
    if (!r) continue;
    out.set(w.id, { ...r, edwards: edwardsTrimp(w, maxHr) });
    if (w.duration > 300) (rateBy[w.family] ||= []).push(r.trimp / (w.duration / 60));
  }
  const allRates = Object.values(rateBy).flat();
  const fallback = median(allRates);
  for (const w of ws) {
    if (out.has(w.id) || !(w.duration > 0)) continue;
    const rate = rateBy[w.family]?.length >= 3 ? median(rateBy[w.family]) : fallback;
    if (rate == null) continue;
    out.set(w.id, { trimp: rate * (w.duration / 60), basis: 'imputed', edwards: null });
  }
  return out;
}

/** Daily load (sum of TRIMP) over [from, to], zeros on rest days. */
export function dailyLoad(ds, loads, { from, to }) {
  const byDay = new Map();
  for (const w of Object.values(ds.workouts)) {
    const l = loads.get(w.id);
    if (l && w.date >= from && w.date <= to) byDay.set(w.date, (byDay.get(w.date) || 0) + l.trimp);
  }
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) rows.push({ date: d, load: byDay.get(d) || 0 });
  return rows;
}

/**
 * The Performance Management Chart. Starts at the first workout with zero
 * fitness and fatigue, so the first ~6 weeks under-read (`warmup` is true).
 * rows: [{date, load, ctl, atl, tsb, warmup}]
 */
export function fitnessFatigue(ds, loads, { to, ctlDays = CTL_DAYS, atlDays = ATL_DAYS } = {}) {
  const dates = Object.values(ds.workouts).filter((w) => loads.has(w.id)).map((w) => w.date).sort();
  if (!dates.length) return [];
  const from = dates[0];
  const end = to && to > from ? to : dates.at(-1);
  const kc = Math.exp(-1 / ctlDays), ka = Math.exp(-1 / atlDays);
  let ctl = 0, atl = 0;
  return dailyLoad(ds, loads, { from, to: end }).map((r, i) => {
    const tsb = ctl - atl; // yesterday's values: form going into the day
    ctl = ctl * kc + r.load * (1 - kc);
    atl = atl * ka + r.load * (1 - ka);
    return { date: r.date, load: r.load, ctl, atl, tsb, warmup: i < ctlDays };
  });
}

/** Commonly used reading of form (TSB), on a chronic load of at least ~20. */
export function formZone(tsb) {
  if (!finite(tsb)) return null;
  if (tsb > 25) return { key: 'detraining', label: 'Very fresh — fitness may be fading', tone: 'info' };
  if (tsb > 5) return { key: 'fresh', label: 'Fresh — good for a race or key session', tone: 'good' };
  if (tsb >= -10) return { key: 'neutral', label: 'Neutral — maintaining', tone: 'info' };
  if (tsb >= -30) return { key: 'productive', label: 'Productive training load', tone: 'good' };
  return { key: 'overreaching', label: 'High fatigue — risk of overreaching', tone: 'watch' };
}

/**
 * EWMA acute:chronic workload ratio (Williams et al. 2017): λ = 2/(N+1),
 * acute N = 7, chronic N = 28. Null until 28 days of history and a chronic
 * load above zero.
 */
export function acwr(rows, { acute = 7, chronic = 28 } = {}) {
  const la = 2 / (acute + 1), lc = 2 / (chronic + 1);
  let a = 0, c = 0;
  return rows.map((r, i) => {
    a = r.load * la + (1 - la) * a;
    c = r.load * lc + (1 - lc) * c;
    return { date: r.date, acute: a, chronic: c, ratio: i >= chronic - 1 && c > 1 ? a / c : null };
  });
}

export function acwrZone(ratio) {
  if (!finite(ratio)) return null;
  if (ratio > 1.5) return { key: 'spike', label: 'Load spike', tone: 'watch' };
  if (ratio > 1.3) return { key: 'high', label: 'Building fast', tone: 'watch' };
  if (ratio >= 0.8) return { key: 'sweet', label: 'Steady build', tone: 'good' };
  return { key: 'low', label: 'Below usual load', tone: 'info' };
}

/**
 * Foster's monotony and strain per ISO week (Monday first): monotony = mean
 * daily load ÷ its SD over the 7 days (rest days count as 0), strain = weekly
 * load × monotony. Weeks with no training have neither.
 */
export function monotonyStrain(rows) {
  const weeks = new Map();
  for (const r of rows) {
    const k = weekStart(r.date);
    if (!weeks.has(k)) weeks.set(k, []);
    weeks.get(k).push(r.load);
  }
  const out = [];
  for (const [week, loads] of weeks) {
    if (loads.length < 7) continue; // partial week at either end
    const total = loads.reduce((a, b) => a + b, 0);
    const s = sd(loads);
    const monotony = total > 0 && s > 0 ? mean(loads) / s : null;
    out.push({ week, load: total, monotony, strain: monotony == null ? null : total * monotony });
  }
  return out;
}

/** Seiler's three zones from %HRmax: below ~82 % (zone 1), 82–87 % (zone 2), above 87 % (zone 3). */
export const SEILER = [0.82, 0.87];

/** Seconds in Seiler's zones from a workout's HR histogram. */
export function seilerZones(w, max) {
  const z = [0, 0, 0];
  if (!w.hrHist?.secs?.length || !(max > 0)) return null;
  w.hrHist.secs.forEach((s, i) => {
    const pct = (w.hrHist.from + w.hrHist.step * (i + 0.5)) / max;
    z[pct >= SEILER[1] ? 2 : pct >= SEILER[0] ? 1 : 0] += s;
  });
  return z;
}

/**
 * Treff et al.'s (2019) polarization index: log10((z1 / z2) × z3 × 100) with
 * shares as fractions; above 2.0 the distribution is polarized. Zone-2 share
 * 0 counts as 0.01; zone-3 share 0 gives no index (not polarized).
 */
export function polarizationIndex([z1, z2, z3]) {
  const t = z1 + z2 + z3;
  if (!(t > 0) || !(z3 > 0)) return null;
  const f2 = z2 / t || 0.01;
  return Math.log10(((z1 / t) / f2) * (z3 / t) * 100);
}

/** Weekly time in Seiler's zones (seconds) and the polarization index. */
export function weeklyIntensity(ds, { from, to }, max) {
  const weeks = new Map();
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) weeks.set(w, { week: w, z1: 0, z2: 0, z3: 0 });
  for (const w of Object.values(ds.workouts)) {
    if (w.date < from || w.date > to) continue;
    const z = seilerZones(w, max);
    const row = weeks.get(weekStart(w.date));
    if (!z || !row) continue;
    row.z1 += z[0];
    row.z2 += z[1];
    row.z3 += z[2];
  }
  return [...weeks.values()].map((r) => ({ ...r, pi: polarizationIndex([r.z1, r.z2, r.z3]) }));
}

/** Summary of the latest day of a PMC series for tiles and insights. */
export function loadSnapshot(pmc, acwrRows) {
  const last = pmc.at(-1);
  if (!last) return null;
  const weekAgo = pmc[Math.max(0, pmc.length - 8)];
  const ratio = acwrRows?.at(-1)?.ratio ?? null;
  return {
    date: last.date,
    ctl: round(last.ctl, 1), atl: round(last.atl, 1), tsb: round(last.ctl - last.atl, 1),
    ctlChange: weekAgo ? round(last.ctl - weekAgo.ctl, 1) : null,
    ramp: weekAgo && weekAgo.ctl > 0 ? round(((last.ctl - weekAgo.ctl) / weekAgo.ctl) * 100, 0) : null,
    acwr: round(ratio, 2),
    warmup: daysBetween(pmc[0].date, last.date) < CTL_DAYS,
  };
}
