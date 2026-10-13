// Running performance models.
//
//   VDOT (Daniels & Gilbert 1979, "Oxygen Power"): the oxygen cost of running
//     at v m/min, VO2 = −4.60 + 0.182258·v + 0.000104·v², over the fraction of
//     VO2max sustainable for t minutes, 0.8 + 0.1894393·e^(−0.012778·t) +
//     0.2989558·e^(−0.1932605·t). Gives equivalent race times and Daniels'
//     training paces (Daniels' Running Formula).
//   Riegel (1981): T2 = T1 × (D2/D1)^1.06, and the personal exponent fitted to
//     your own best efforts.
//   Critical speed (Monod & Scherrer 1965; Hill 1993): distance = CS·t + D′
//     over efforts of about 2–30 minutes.
//   VO2max from a steady run: ACSM's running equation (VO2 = 3.5 + 0.2·v) and
//     %HRR ≈ %VO2R (Swain & Leutholtz 1997): VO2max = 3.5 + (VO2 − 3.5)/%HRR.
//   VO2max from heart rates alone (Uth, Sørensen, Overgaard & Pedersen 2004):
//     15.3 × HRmax / HRrest.
//   Efficiency factor (Friel; Allen & Coggan): metres per minute per beat.
//   Aerobic decoupling (Friel): how much speed per beat fades from the first
//     to the second half of a steady run; under 5 % means the aerobic base held.

import { ols, median, round } from './util.js';
import { restingHrOn } from './load.js';
import { EFFORTS } from '../track.js';

// ------------------------------------------------------------------ VDOT

export const vo2Cost = (v) => -4.6 + 0.182258 * v + 0.000104 * v * v;
export const fractionSustained = (t) => 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);

/** VDOT of covering `metres` in `seconds` (valid for races of ~3.5 to ~230 minutes). */
export function vdot(metres, seconds) {
  if (!(metres > 0) || !(seconds > 0)) return null;
  const t = seconds / 60;
  const v = metres / t;
  return vo2Cost(v) / fractionSustained(t);
}

/** Speed (m/min) whose oxygen cost is `vo2` ml/kg/min. */
export function speedForVo2(vo2) {
  const a = 0.000104, b = 0.182258, c = -4.6 - vo2;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

/** Race time (s) over `metres` that a runner of this VDOT would run (bisection). */
export function raceTime(v, metres) {
  if (!(v > 0) || !(metres > 0)) return null;
  let lo = metres / 600 * 60, hi = metres / 40 * 60; // 36 km/h … 2.4 km/h
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (vdot(metres, mid) > v) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export const RACES = [
  { key: '5k', label: '5 km', metres: 5000 },
  { key: '10k', label: '10 km', metres: 10000 },
  { key: 'hm', label: 'Half marathon', metres: 21097.5 },
  { key: 'm', label: 'Marathon', metres: 42195 },
];

/**
 * Daniels' training paces (s/km) for a VDOT: easy 59–74 % of VDOT, marathon
 * = marathon race pace, threshold 88 %, interval 97.5 %, repetition about
 * 6 s per 400 m faster than interval pace.
 */
export function trainingPaces(v) {
  if (!(v > 0)) return null;
  const pace = (frac) => 60000 / speedForVo2(frac * v); // s per km
  const i = pace(0.975);
  return {
    easy: [pace(0.74), pace(0.59)],
    marathon: raceTime(v, 42195) / 42.195,
    threshold: pace(0.88),
    interval: i,
    repetition: i - 15,
  };
}

/**
 * VDOT of every run: the best of the whole run and its best efforts (the
 * efforts inside a run are often closer to all-out than the run's average).
 * @returns {[{id, date, vdot, from: 'run'|effort key}]}
 */
export function runVdots(ds) {
  const out = [];
  for (const w of Object.values(ds.workouts)) {
    if (w.family !== 'run' || !(w.distance >= 3000) || !(w.duration >= 600)) continue;
    let best = { v: vdot(w.distance, w.duration), from: 'run' };
    for (const e of EFFORTS) {
      const t = w.efforts?.[e.key];
      if (t > 0 && e.metres >= 3000) {
        const v = vdot(e.metres, t);
        if (v > best.v) best = { v, from: e.key };
      }
    }
    if (best.v > 15 && best.v < 90) out.push({ id: w.id, date: w.date, start: w.start, vdot: best.v, from: best.from });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Highest VDOT of runs in the `days` before each run (a "current form" line). */
export function rollingBestVdot(points, days = 90) {
  return points.map((p, i) => {
    let best = 0;
    for (let j = i; j >= 0 && (p.start - points[j].start) / 864e5 <= days; j--) best = Math.max(best, points[j].vdot);
    return { date: p.date, start: p.start, vdot: best };
  });
}

// ------------------------------------------------------------------ Riegel and critical speed

/** Best effort per distance across all runs (in `ds` or the given workouts). */
export function bestEfforts(workouts) {
  const best = {};
  for (const w of workouts) {
    for (const e of EFFORTS) {
      const t = w.efforts?.[e.key];
      if (t > 0 && (!best[e.key] || t < best[e.key].time)) best[e.key] = { ...e, time: t, id: w.id, date: w.date };
    }
  }
  return EFFORTS.map((e) => best[e.key]).filter(Boolean);
}

/**
 * Fit T = a·D^b to best efforts (log–log least squares). Riegel's population
 * exponent is 1.06; a higher personal one means you slow more as races get
 * longer (speed-oriented), a lower one that you hold pace well (endurance-oriented).
 */
export function riegelFit(efforts) {
  const fit = ols(efforts.map((e) => [Math.log(e.metres), Math.log(e.time)]));
  if (!fit || efforts.length < 2) return null;
  return { exponent: fit.b, scale: Math.exp(fit.a), r2: fit.r2, n: fit.n };
}

/** Riegel prediction from one performance. */
export const riegel = (time, from, to, exponent = 1.06) => time * (to / from) ** exponent;

/**
 * Critical speed (m/s) and D′ (m) from best efforts lasting 2–30 minutes:
 * least squares of distance on time. Needs two or more such efforts.
 */
export function criticalSpeed(efforts) {
  const pts = efforts.filter((e) => e.time >= 120 && e.time <= 1800).map((e) => [e.time, e.metres]);
  const fit = ols(pts);
  if (!fit || pts.length < 2 || !(fit.b > 0)) return null;
  return { cs: fit.b, dPrime: fit.a, r2: fit.r2, n: fit.n };
}

// ------------------------------------------------------------------ VO2max estimates

/**
 * Steady runs good enough for the heart-rate model: 15+ minutes, 2+ km,
 * mostly flat (climb under 1.5 % of distance), average HR inside 50–95 % of
 * the reserve (outside that, %HRR stops tracking %VO2R).
 */
export function steadyRuns(ds, { maxHr }) {
  const cache = new Map();
  const out = [];
  for (const w of Object.values(ds.workouts)) {
    if (w.family !== 'run' || !(w.distance >= 2000) || !(w.duration >= 900) || !(w.avgHr > 0)) continue;
    if (/indoor|treadmill/i.test(`${w.sport} ${w.label}`)) continue;
    if ((w.ascent || 0) / w.distance > 0.015) continue;
    const rest = restingHrOn(ds, w.date, cache);
    const hrr = (w.avgHr - rest) / (maxHr - rest);
    if (!(hrr >= 0.5 && hrr <= 0.95)) continue;
    const v = w.distance / (w.duration / 60); // m/min
    out.push({ w, rest, hrr, v });
  }
  return out.sort((a, b) => a.w.start - b.w.start);
}

/** ACSM + Swain estimate of VO2max (ml/kg/min) for each steady run. */
export function vo2maxFromRuns(ds, opts) {
  return steadyRuns(ds, opts).map(({ w, hrr, v }) => {
    const vo2 = 3.5 + 0.2 * v;
    return { id: w.id, date: w.date, start: w.start, vo2max: 3.5 + (vo2 - 3.5) / hrr, hrr };
  }).filter((p) => p.vo2max > 20 && p.vo2max < 90);
}

/** Uth et al. (2004): VO2max ≈ 15.3 × HRmax / HRrest, from a 30-day median resting HR. */
export function vo2maxUth(maxHr, restHr) {
  return maxHr > 0 && restHr > 25 ? 15.3 * (maxHr / restHr) : null;
}

/** Efficiency factor of each steady run: metres per minute per beat (higher = fitter at the same effort). */
export function efficiencyFactors(ds, opts) {
  return steadyRuns(ds, opts).map(({ w, v }) => ({ id: w.id, date: w.date, start: w.start, ef: v / w.avgHr }));
}

/**
 * Aerobic decoupling of a track (points from trackPoints: {t, hr, spd}):
 * speed/HR in the second half vs the first, after a 10-minute warm-up.
 * Positive = heart rate drifted up relative to pace. Needs 20+ minutes.
 */
export function aerobicDecoupling(points) {
  const pts = points.filter((p) => p.hr > 40 && p.spd > 0.5);
  if (pts.length < 20) return null;
  const t0 = pts[0].t + 10 * 60000;
  const steady = pts.filter((p) => p.t >= t0);
  if (steady.length < 20 || steady.at(-1).t - steady[0].t < 20 * 60000) return null;
  const mid = steady[0].t + (steady.at(-1).t - steady[0].t) / 2;
  const ratio = (list) => {
    const s = list.reduce((a, p) => a + p.spd, 0) / list.length;
    const h = list.reduce((a, p) => a + p.hr, 0) / list.length;
    return s / h;
  };
  const a = ratio(steady.filter((p) => p.t < mid)), b = ratio(steady.filter((p) => p.t >= mid));
  return { decoupling: ((a - b) / a) * 100, first: a * 60, second: b * 60 }; // m/min per beat
}

/** Latest VO2max picture from all three estimates. */
export function vo2maxSummary(ds, { maxHr }) {
  const runs = vo2maxFromRuns(ds, { maxHr });
  const recent = runs.slice(-8);
  const restDates = Object.keys(ds.days).filter((d) => ds.days[d].restHr > 0).sort();
  const last = restDates.at(-1);
  const rest = last ? restingHrOn(ds, last) : null;
  const watch = Object.values(ds.days).filter((d) => d.vo2max > 0).sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1);
  return {
    runs: recent.length >= 3 ? round(median(recent.map((p) => p.vo2max)), 1) : null,
    runsN: runs.length,
    uth: round(vo2maxUth(maxHr, rest), 1),
    restHr: round(rest, 0),
    watch: watch ? { value: watch.vo2max, date: watch.date } : null,
  };
}
