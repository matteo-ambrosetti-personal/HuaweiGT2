// Recovery markers against your own baseline.
//
//   HRV: the natural log of RMSSD, its 7-day rolling mean against a 60-day
//     baseline ± the smallest worthwhile change of 0.5 SD (Plews et al. 2012,
//     2013; Buchheit 2014), and its 7-day coefficient of variation (higher =
//     more day-to-day disturbance).
//   Resting HR: z-score against a robust 30-day baseline (median ± 1.4826·MAD).
//     Rises of this kind have been used to flag illness early at population
//     level (Radin et al. 2020; Mishra et al. 2020); here it is only a
//     prompt to look at sleep, stress and load.

import { addDays } from '../format.js';
import { mean, sd, median, finite, round } from './util.js';

const valuesBetween = (ds, field, from, to, ok = (v) => v > 0) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = ds.days[d]?.[field];
    if (finite(v) && ok(v)) out.push(v);
  }
  return out;
};

/**
 * Daily lnRMSSD with its 7-day mean, 60-day baseline band and 7-day CV.
 * rows: [{date, ln, week, base, lo, hi, cv, status}] where status is
 * 'below' | 'within' | 'above' | null (week mean against the band).
 */
export function hrvBaseline(ds, { from, to }) {
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = ds.days[d]?.hrvAvg;
    const ln = v > 0 ? Math.log(v) : null;
    const week = valuesBetween(ds, 'hrvAvg', addDays(d, -6), d).map(Math.log);
    const base = valuesBetween(ds, 'hrvAvg', addDays(d, -60), addDays(d, -1)).map(Math.log);
    const wm = week.length >= 3 ? mean(week) : null;
    const bm = base.length >= 14 ? mean(base) : null;
    const swc = base.length >= 14 ? 0.5 * sd(base) : null;
    const lo = bm == null ? null : bm - swc, hi = bm == null ? null : bm + swc;
    rows.push({
      date: d, ln, week: wm, base: bm, lo, hi,
      cv: week.length >= 3 ? (sd(week) / mean(week)) * 100 : null,
      status: wm == null || bm == null ? null : wm < lo ? 'below' : wm > hi ? 'above' : 'within',
    });
  }
  return rows;
}

/** Resting HR z-scores against the previous 30 days: rows [{date, rest, base, z, delta}]. */
export function restingHrBaseline(ds, { from, to }) {
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const rest = ds.days[d]?.restHr > 25 ? ds.days[d].restHr : null;
    const prev = valuesBetween(ds, 'restHr', addDays(d, -30), addDays(d, -1), (v) => v > 25 && v < 120);
    let base = null, spread = null;
    if (prev.length >= 10) {
      base = median(prev);
      spread = Math.max(1, 1.4826 * median(prev.map((v) => Math.abs(v - base))));
    }
    rows.push({ date: d, rest, base, z: rest != null && base != null ? (rest - base) / spread : null, delta: rest != null && base != null ? rest - base : null });
  }
  return rows;
}

/** Elevated resting HR: at least +1 robust SD and +3 bpm over baseline. */
export const elevated = (r) => r.z != null && r.z >= 1 && r.delta >= 3;

/**
 * A recovery picture for the latest day with data, from the sub-models:
 * each component in −1 (strained) … +1 (recovered); the score is their mean
 * mapped to 0–100. Components without data are left out. This is a simple
 * summary of the markers above, not a validated score.
 */
export function readiness({ hrv, rest, sleep, form }) {
  const parts = [];
  if (hrv?.week != null && hrv.base != null && hrv.hi > hrv.lo) {
    const half = (hrv.hi - hrv.lo) / 2;
    parts.push({ key: 'hrv', label: 'HRV vs baseline', value: Math.max(-1, Math.min(1, (hrv.week - hrv.base) / (3 * half))) });
  }
  if (rest?.z != null) parts.push({ key: 'rest', label: 'Resting HR vs baseline', value: Math.max(-1, Math.min(1, -rest.z / 2)) });
  if (sleep?.balance != null) parts.push({ key: 'sleep', label: '7-night sleep balance', value: Math.max(-1, Math.min(1, sleep.balance / 300)) });
  if (form != null) parts.push({ key: 'form', label: 'Training form (TSB)', value: Math.max(-1, Math.min(1, (form + 10) / 30)) });
  if (!parts.length) return null;
  const m = parts.reduce((a, p) => a + p.value, 0) / parts.length;
  return { score: round(50 + 50 * m, 0), parts };
}
