// Sleep models.
//
//   Two-process model (Borbély 1982; Daan, Beersma & Borbély 1984): sleep
//     pressure S rises during wake towards 1 with a time constant of 18.2 h
//     and falls during sleep with 4.2 h; it meets circadian thresholds
//     H(t) = 0.67 + 0.12·C(t) (falling asleep) and L(t) = 0.17 + 0.12·C(t)
//     (waking), C a five-harmonic 24 h rhythm (parameters as in Skeldon,
//     Derks & Dijk 2016). Simulated here from your actual sleep and wake times.
//   Sleep balance: the last 7 nights against your sleep goal (deficits add
//     up; Van Dongen et al. 2003).
//   Social jetlag and chronotype (Wittmann et al. 2006; Roenneberg et al.
//     2012, MCTQ): mid-sleep on free days (nights before Saturday and Sunday)
//     vs workdays, and mid-sleep on free days corrected for catch-up sleep (MSFsc).
//   Sleep Regularity Index (Phillips et al. 2017): how likely you are in the
//     same state (asleep or awake) at any moment and 24 h later, −100 … 100.

import { localMinuteOfDay, weekdayIndex, addDays, fallbackOffset } from '../format.js';
import { mean, finite, round } from './util.js';
import { bedMinute } from '../stats.js';

export const TWO_PROCESS = {
  rise: 18.2, decay: 4.2, upper: 0.67, lower: 0.17, amp: 0.12,
  harmonics: [0.97, 0.22, 0.07, 0.03, 0.001],
};

const H = 3600000;

/** C(t) at local clock hour `hour` with phase `alpha` (hours). */
export function circadian(hour, alpha = 0, p = TWO_PROCESS) {
  let c = 0;
  p.harmonics.forEach((a, k) => { c += a * Math.sin((2 * Math.PI * (k + 1) * (hour - alpha)) / 24); });
  return c;
}

/** Clock hour where C(t) is lowest for alpha = 0 (found numerically, once). */
const C_MIN_HOUR = (() => {
  let best = 0, bestV = Infinity;
  for (let h = 0; h < 24; h += 0.05) {
    const v = circadian(h);
    if (v < bestV) { bestV = v; best = h; }
  }
  return best;
})();

/** Sleep intervals [onset, wake] (ms) of nights, oldest first. */
export function sleepIntervals(nights) {
  return nights.filter((n) => n.start && n.end && n.end > n.start).map((n) => [n.start, n.end, n]).sort((a, b) => a[0] - b[0]);
}

/**
 * Simulate S from 2 days before the first night to the last wake-up + 12 h,
 * every `stepMin` minutes. The circadian low sits two hours before your
 * average wake-up time (where the core-temperature minimum usually falls).
 * @returns {{series: [{t, s, hi, lo, asleep}], nights: [{date, onset, wake, sOnset, sWake, hiOnset}], alpha}}
 */
export function twoProcess(nights, { stepMin = 10, p = TWO_PROCESS } = {}) {
  const iv = sleepIntervals(nights);
  if (iv.length < 2) return null;
  const tz = (t) => fallbackOffset(t);
  const wakeHours = iv.map(([, b, n]) => localMinuteOfDay(b, n.tz ?? tz(b)) / 60);
  const avgWake = mean(wakeHours);
  const alpha = avgWake - 2 - C_MIN_HOUR;
  const start = iv[0][0] - 48 * H, end = iv.at(-1)[1] + 12 * H;
  const step = stepMin * 60000;
  const kr = Math.exp(-step / (p.rise * H)), kd = Math.exp(-step / (p.decay * H));
  let s = 0.3, k = 0;
  const series = [];
  const marks = iv.map(([a, b, n]) => ({ date: n.date, onset: a, wake: b, sOnset: null, sWake: null, hiOnset: null }));
  for (let t = start; t <= end; t += step) {
    while (k < iv.length && iv[k][1] < t) k++;
    const asleep = k < iv.length && t >= iv[k][0] && t < iv[k][1];
    s = asleep ? s * kd : 1 - (1 - s) * kr;
    const hour = localMinuteOfDay(t, tz(t)) / 60;
    const c = circadian(hour, alpha, p);
    series.push({ t, s, hi: p.upper + p.amp * c, lo: p.lower + p.amp * c, asleep });
    for (const m of marks) {
      if (m.sOnset == null && t >= m.onset) { m.sOnset = s; m.hiOnset = p.upper + p.amp * c; }
      if (m.sWake == null && t >= m.wake) m.sWake = s;
    }
  }
  return { series, nights: marks, alpha };
}

/** The last 7 nights against the goal: minutes over (+) or under (−), and nights counted. */
export function sleepBalance(nights, goalMin, lastDate) {
  const from = addDays(lastDate, -6);
  const recent = nights.filter((n) => n.date >= from && n.date <= lastDate && n.total > 0);
  if (recent.length < 4) return null;
  // Missing nights count at the average of the recorded ones.
  const avg = mean(recent.map((n) => n.total));
  return { balance: round((avg - goalMin) * 7, 0), nights: recent.length, avg: round(avg, 0) };
}

/** Free night = the night before Saturday or Sunday (its wake date is a weekend day). */
export const isFreeNight = (n) => weekdayIndex(n.date) >= 5;

/**
 * Social jetlag and chronotype from bed/wake times. Minutes are relative to
 * midnight of the wake date (before midnight is negative).
 */
export function socialJetlag(nights) {
  const rows = nights.filter((n) => n.start && n.end && n.total > 0).map((n) => {
    const on = bedMinute(n.start, n.tz), off = localMinuteOfDay(n.end, n.tz);
    return { free: isFreeNight(n), mid: (on + off) / 2, dur: off - on };
  }).filter((r) => r.dur > 120 && r.dur < 16 * 60);
  const work = rows.filter((r) => !r.free), free = rows.filter((r) => r.free);
  if (work.length < 3 || free.length < 2) return null;
  const msw = mean(work.map((r) => r.mid)), msf = mean(free.map((r) => r.mid));
  const sdw = mean(work.map((r) => r.dur)), sdf = mean(free.map((r) => r.dur));
  const week = (5 * sdw + 2 * sdf) / 7;
  const msfsc = sdf > sdw ? msf - (sdf - week) / 2 : msf;
  return {
    msw, msf, msfsc, sdw, sdf,
    jetlag: Math.abs(msf - msw), // minutes
    signed: msf - msw,
    nWork: work.length, nFree: free.length,
  };
}

/**
 * Sleep Regularity Index over pairs of consecutive recorded nights, at
 * 5-minute resolution. Each night is observed from noon before its wake date
 * to noon on it; awake stages inside the night count as awake.
 */
export function sleepRegularity(nights, { stepMin = 5 } = {}) {
  const byDate = new Map(nights.filter((n) => n.start && n.end).map((n) => [n.date, n]));
  const step = stepMin * 60000;
  const window = (n) => {
    const off = n.tz ?? fallbackOffset(n.end);
    const noon = Date.parse(`${n.date}T12:00:00Z`) - off * 60000;
    return [noon - 24 * H, noon];
  };
  const asleepAt = (n, t) => {
    if (t < n.start || t >= n.end) return false;
    if (!n.stages?.length) return true;
    const min = (t - n.start) / 60000;
    const st = n.stages.find(([o, len]) => min >= o && min < o + len);
    return st ? st[2] !== 4 : true;
  };
  let agree = 0, total = 0, pairs = 0;
  for (const [date, n] of byDate) {
    const next = byDate.get(addDays(date, 1));
    if (!next) continue;
    pairs++;
    const [a, b] = window(n);
    for (let t = a; t < b; t += step) {
      if (asleepAt(n, t) === asleepAt(next, t + 24 * H)) agree++;
      total++;
    }
  }
  if (pairs < 3) return null;
  return { sri: round(200 * (agree / total) - 100, 0), pairs };
}

/** Weekly SRI points over a list of nights (weeks with 3+ pairs). */
export function weeklyRegularity(nights) {
  const weeks = new Map();
  for (const n of nights) {
    const k = addDays(n.date, -weekdayIndex(n.date));
    if (!weeks.has(k)) weeks.set(k, []);
    weeks.get(k).push(n);
  }
  return [...weeks.entries()].sort().map(([week, list]) => ({ week, ...(sleepRegularity(list) || { sri: null, pairs: 0 }) }))
    .filter((r) => finite(r.sri));
}
