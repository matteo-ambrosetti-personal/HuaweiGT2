// What moves together in your own data: Spearman rank correlations between
// daily metrics, same day and one day apart (does a hard day change the next
// night's sleep or the next morning's resting HR?). p-values from Fisher's z
// approximation; q-values control the false discovery rate across all pairs
// tested (Benjamini & Hochberg 1995), since testing many pairs finds some
// "significant" by chance.

import { addDays } from '../format.js';
import { finite, normCdf, round } from './util.js';

/** Average ranks (ties share the mean rank). */
export function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(x, y) {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Spearman's ρ over pairs with both values: {rho, n, p}. */
export function spearman(pairs) {
  const p = pairs.filter(([a, b]) => finite(a) && finite(b));
  if (p.length < 8) return null;
  const rho = pearson(ranks(p.map((x) => x[0])), ranks(p.map((x) => x[1])));
  if (rho == null) return null;
  const n = p.length;
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, rho))) * Math.sqrt(n - 3);
  return { rho, n, p: 2 * (1 - normCdf(Math.abs(z))) };
}

/** Benjamini–Hochberg q-values, in the input order. */
export function bhAdjust(ps) {
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const q = new Array(ps.length);
  let min = 1;
  for (let k = order.length - 1; k >= 0; k--) {
    const [p, i] = order[k];
    min = Math.min(min, (p * order.length) / (k + 1));
    q[i] = min;
  }
  return q;
}

/**
 * Daily metrics for correlation. `load` is a Map(date → TRIMP). Sleep is the
 * night that ended on the date (so "sleep" on day d+1 is the night after day d).
 */
export const METRICS = [
  { key: 'steps', label: 'Steps', get: (ds, d) => (ds.days[d]?.steps > 0 ? ds.days[d].steps : null) },
  { key: 'load', label: 'Training load', get: (ds, d, ctx) => ctx.load?.get(d) ?? (ctx.loadDays?.has(d) ? 0 : null) },
  { key: 'sleep', label: 'Sleep', get: (ds, d) => ds.nights[d]?.total ?? null },
  { key: 'deep', label: 'Deep sleep share', get: (ds, d) => (ds.nights[d]?.deep != null && ds.nights[d].total > 0 ? ds.nights[d].deep / ds.nights[d].total : null) },
  { key: 'restHr', label: 'Resting HR', get: (ds, d) => ds.days[d]?.restHr ?? null },
  { key: 'hrv', label: 'HRV', get: (ds, d) => ds.days[d]?.hrvAvg ?? null },
  { key: 'stress', label: 'Stress', get: (ds, d) => ds.days[d]?.stressAvg ?? null },
  { key: 'spo2', label: 'SpO2', get: (ds, d) => ds.days[d]?.spo2Avg ?? null },
];

/** Same-day pairs that are related by construction (workouts add steps). */
const TRIVIAL = new Set(['steps|load']);

/** Plausible "today affects tomorrow" questions; [cause, effect]. */
export const LAGGED = [
  ['load', 'sleep'], ['load', 'deep'], ['load', 'restHr'], ['load', 'hrv'],
  ['steps', 'sleep'], ['steps', 'deep'], ['stress', 'sleep'], ['stress', 'hrv'],
  ['sleep', 'restHr'], ['sleep', 'hrv'], ['sleep', 'stress'], ['sleep', 'steps'],
];

/**
 * Same-day correlation matrix and next-day effects over [from, to].
 * Only metrics with 14+ days of data take part.
 */
export function correlations(ds, { from, to }, ctx = {}) {
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const series = {};
  for (const m of METRICS) {
    const vals = dates.map((d) => m.get(ds, d, ctx));
    if (vals.filter(finite).length >= 14) series[m.key] = vals;
  }
  const keys = METRICS.map((m) => m.key).filter((k) => series[k]);
  const cells = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (TRIVIAL.has(`${keys[i]}|${keys[j]}`)) continue;
      const r = spearman(dates.map((_, t) => [series[keys[i]][t], series[keys[j]][t]]));
      if (r) cells.push({ a: keys[i], b: keys[j], lag: 0, ...r });
    }
  }
  const lagged = [];
  for (const [a, b] of LAGGED) {
    if (!series[a] || !series[b]) continue;
    // The night "on" d+1 ends the morning after day d; HR/HRV on d+1 is the next morning.
    const r = spearman(dates.slice(0, -1).map((_, t) => [series[a][t], series[b][t + 1]]));
    if (r) lagged.push({ a, b, lag: 1, ...r });
  }
  const all = [...cells, ...lagged];
  const q = bhAdjust(all.map((c) => c.p));
  all.forEach((c, i) => { c.q = q[i]; c.rho = round(c.rho, 2); });
  return { keys, cells, lagged, labels: Object.fromEntries(METRICS.map((m) => [m.key, m.label])) };
}

/** Strength in words (|ρ|): Cohen's rough conventions. */
export function strength(rho) {
  const a = Math.abs(rho);
  return a >= 0.5 ? 'strong' : a >= 0.3 ? 'moderate' : a >= 0.1 ? 'weak' : 'negligible';
}
