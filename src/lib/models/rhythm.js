// Daily rhythms and step-count bands.
//
//   Cosinor (Halberg; Cornelissen 2014): y(h) = MESOR + A·cos(2π(h − φ)/24)
//     fitted by least squares to hourly values; φ is the time of the peak.
//   Non-parametric rest–activity rhythm (Witting et al. 1990; Van Someren et
//     al. 1999) from hourly steps: interdaily stability IS (0–1, higher = the
//     same pattern every day), intradaily variability IV (0–2, higher = more
//     fragmented), and relative amplitude RA from the most active 10 h (M10)
//     and least active 5 h (L5).
//   Step bands (Tudor-Locke & Bassett 2004): under 5,000 sedentary,
//     5,000–7,499 low active, 7,500–9,999 somewhat active, 10,000–12,499
//     active, 12,500+ highly active. A meta-analysis (Paluch et al. 2022) found
//     mortality risk falling with steps up to about 6,000–8,000 a day for
//     adults 60+ and 8,000–10,000 for younger adults.

import { finite, round } from './util.js';

/** Fit a 24 h cosinor to [{hour, value}]: {mesor, amplitude, peakHour, r2, n}. */
export function cosinor(points) {
  const p = points.filter((x) => finite(x.value) && finite(x.hour));
  if (p.length < 6) return null;
  const w = (2 * Math.PI) / 24;
  // Normal equations for y = M + b·cos(wh) + g·sin(wh).
  let n = 0, sc = 0, ss = 0, scc = 0, sss = 0, scs = 0, sy = 0, syc = 0, sys = 0;
  for (const { hour, value: y } of p) {
    const c = Math.cos(w * hour), s = Math.sin(w * hour);
    n++; sc += c; ss += s; scc += c * c; sss += s * s; scs += c * s; sy += y; syc += y * c; sys += y * s;
  }
  const A = [[n, sc, ss], [sc, scc, scs], [ss, scs, sss]];
  const B = [sy, syc, sys];
  const sol = solve3(A, B);
  if (!sol) return null;
  const [mesor, b, g] = sol;
  const amplitude = Math.hypot(b, g);
  const peakHour = ((Math.atan2(g, b) / w) % 24 + 24) % 24;
  const mean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (const { hour, value: y } of p) {
    const f = mesor + b * Math.cos(w * hour) + g * Math.sin(w * hour);
    ssTot += (y - mean) ** 2;
    ssRes += (y - f) ** 2;
  }
  return { mesor, amplitude, peakHour, r2: ssTot ? 1 - ssRes / ssTot : 0, n, at: (h) => mesor + b * Math.cos(w * h) + g * Math.sin(w * h) };
}

function solve3(A, B) {
  const m = A.map((row, i) => [...row, B[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[3] / row[i]);
}

/** Hourly points [{hour, value}] from days' 24-value arrays (e.g. hrHourly). */
export function hourlyPoints(days, field) {
  const out = [];
  for (const d of days) {
    const arr = d[field];
    if (!Array.isArray(arr)) continue;
    arr.forEach((v, h) => { if (finite(v) && v > 0) out.push({ hour: h + 0.5, value: v }); });
  }
  return out;
}

/**
 * IS, IV, M10, L5 and RA from days with hourly steps (each a full 24 h;
 * days without the array are skipped, consecutive order kept for IV).
 */
export function restActivity(days) {
  const full = days.filter((d) => Array.isArray(d.stepsHourly) && d.stepsHourly.length === 24 && d.steps > 0);
  if (full.length < 7) return null;
  const x = full.flatMap((d) => d.stepsHourly.map((v) => (finite(v) ? v : 0)));
  const n = x.length, p = 24;
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const profile = Array.from({ length: p }, (_, h) => {
    let s = 0;
    for (let i = h; i < n; i += p) s += x[i];
    return s / (n / p);
  });
  const varTot = x.reduce((a, v) => a + (v - mean) ** 2, 0);
  if (!varTot) return null;
  const is = (n * profile.reduce((a, v) => a + (v - mean) ** 2, 0)) / (p * varTot);
  let diff = 0;
  for (let i = 1; i < n; i++) diff += (x[i] - x[i - 1]) ** 2;
  const iv = (n * diff) / ((n - 1) * varTot);
  const windowMean = (len) => Array.from({ length: p }, (_, s) => {
    let t = 0;
    for (let k = 0; k < len; k++) t += profile[(s + k) % p];
    return { start: s, mean: t / len };
  });
  const m10 = windowMean(10).reduce((a, b) => (b.mean > a.mean ? b : a));
  const l5 = windowMean(5).reduce((a, b) => (b.mean < a.mean ? b : a));
  return {
    days: full.length, is: round(is, 2), iv: round(iv, 2),
    m10: round(m10.mean, 0), m10Start: m10.start, l5: round(l5.mean, 0), l5Start: l5.start,
    ra: m10.mean + l5.mean > 0 ? round((m10.mean - l5.mean) / (m10.mean + l5.mean), 2) : null,
    profile,
  };
}

export const STEP_BANDS = [
  { key: 'sedentary', label: 'Sedentary', lo: 0, hi: 5000 },
  { key: 'low', label: 'Low active', lo: 5000, hi: 7500 },
  { key: 'somewhat', label: 'Somewhat active', lo: 7500, hi: 10000 },
  { key: 'active', label: 'Active', lo: 10000, hi: 12500 },
  { key: 'high', label: 'Highly active', lo: 12500, hi: Infinity },
];

export const stepBand = (steps) => STEP_BANDS.find((b) => steps >= b.lo && steps < b.hi) || null;

/** Days per Tudor-Locke band, per calendar month: [{month, sedentary, low, …, n}]. */
export function monthlyStepBands(days) {
  const months = new Map();
  for (const d of days) {
    if (!(d.steps > 0)) continue;
    const m = d.date.slice(0, 7);
    if (!months.has(m)) months.set(m, Object.fromEntries([['month', m], ['n', 0], ...STEP_BANDS.map((b) => [b.key, 0])]));
    const row = months.get(m);
    row[stepBand(d.steps).key]++;
    row.n++;
  }
  return [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}
