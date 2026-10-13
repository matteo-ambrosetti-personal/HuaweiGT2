// The literature models against published values and constructed cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vdot, raceTime, trainingPaces, riegel, riegelFit, criticalSpeed, vo2maxUth, aerobicDecoupling, speedForVo2, vo2Cost } from '../src/lib/models/running.js';
import { trimpAt, workoutTrimp, fitnessFatigue, acwr, monotonyStrain, polarizationIndex, seilerZones, formZone, workoutLoads, edwardsTrimp } from '../src/lib/models/load.js';
import { hrvBaseline, restingHrBaseline, elevated, readiness } from '../src/lib/models/recovery.js';
import { socialJetlag, sleepRegularity, twoProcess, sleepBalance, circadian } from '../src/lib/models/sleep.js';
import { cosinor, restActivity, stepBand, monthlyStepBands } from '../src/lib/models/rhythm.js';
import { spearman, bhAdjust, ranks, correlations } from '../src/lib/models/correlate.js';
import { analyze, insights } from '../src/lib/models/insights.js';
import { addDays } from '../src/lib/format.js';
import { DEFAULT_SETTINGS, estimateMaxHr } from '../src/lib/stats.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const emptyDs = () => ({ days: {}, nights: {}, workouts: {}, tracks: {} });
const at = (date, hh, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);

// ------------------------------------------------------------------ running

test('VDOT matches Daniels\' tables', () => {
  // Daniels' Running Formula: VDOT 50 ↔ 5 km 19:57, 10 km 41:21, marathon 3:10:49.
  near(vdot(5000, 19 * 60 + 57), 50, 0.3, '5 km');
  near(raceTime(50, 10000), 41 * 60 + 21, 25, '10 km');
  near(raceTime(50, 42195), 3 * 3600 + 10 * 60 + 49, 120, 'marathon');
  // Threshold pace for VDOT 50 is about 4:15 /km.
  near(trainingPaces(50).threshold, 255, 8, 'T pace');
  const p = trainingPaces(50);
  assert.ok(p.easy[0] < p.easy[1] && p.threshold < p.easy[0] && p.interval < p.threshold && p.repetition < p.interval);
  near(vo2Cost(speedForVo2(42)), 42, 1e-9, 'inverse of the oxygen cost');
});

test('Riegel: the formula, and the exponent fitted from efforts', () => {
  near(riegel(1200, 5000, 10000), 1200 * 2 ** 1.06, 1e-9);
  const efforts = [1000, 5000, 10000, 21097.5].map((m) => ({ metres: m, time: 0.2 * m ** 1.1 }));
  const fit = riegelFit(efforts);
  near(fit.exponent, 1.1, 1e-9);
  assert.equal(riegelFit(efforts.slice(0, 1)), null);
});

test('critical speed from distance–time pairs', () => {
  const efforts = [180, 600, 1200].map((t) => ({ metres: 4 * t + 200, time: t }));
  const cs = criticalSpeed(efforts);
  near(cs.cs, 4, 1e-9);
  near(cs.dPrime, 200, 1e-6);
  assert.equal(criticalSpeed([{ metres: 42195, time: 3 * 3600 }]), null, 'needs 2+ efforts of 2–30 min');
});

test('VO2max from heart rates (Uth et al. 2004)', () => {
  near(vo2maxUth(190, 50), 15.3 * 3.8, 1e-9);
  assert.equal(vo2maxUth(190, null), null);
});

test('aerobic decoupling: HR drifting up at the same pace', () => {
  const t0 = Date.parse('2026-01-01T08:00:00Z');
  const pts = Array.from({ length: 70 }, (_, i) => ({ t: t0 + i * 60000, spd: 3, hr: i < 40 ? 140 : 147 }));
  const d = aerobicDecoupling(pts);
  near(d.decoupling, 4.76, 0.1);
  assert.equal(aerobicDecoupling(pts.slice(0, 20)), null, 'too short');
});

// ------------------------------------------------------------------ load

test('Banister TRIMP and Edwards TRIMP', () => {
  near(trimpAt(60, 125, { rest: 60, max: 190, sex: 'male' }), 60 * 0.5 * 0.64 * Math.exp(0.96), 1e-9);
  near(trimpAt(60, 125, { rest: 60, max: 190, sex: 'female' }), 60 * 0.5 * 0.86 * Math.exp(0.835), 1e-9);
  assert.equal(trimpAt(60, 50, { rest: 60, max: 190 }), 0, 'below rest counts nothing');
  // 30 min at 142.5 bpm (bin 140–145) with max 190: 75 % → Edwards zone 3.
  const w = { hrHist: { from: 40, step: 5, secs: [...new Array(20).fill(0), 1800] }, duration: 1800 };
  near(edwardsTrimp(w, 190), 90, 1e-9);
  assert.equal(workoutTrimp(w, { rest: 60, max: 190 }).basis, 'hist');
  assert.equal(workoutTrimp({ avgHr: 150, duration: 3600 }, { rest: 60, max: 190 }).basis, 'avg');
  assert.equal(workoutTrimp({ duration: 3600 }, { rest: 60, max: 190 }), null);
});

test('workouts without heart rate get an imputed load', () => {
  const ds = emptyDs();
  for (let i = 0; i < 5; i++) {
    ds.workouts[`a${i}`] = { id: `a${i}`, family: 'run', date: addDays('2026-01-01', i), start: at(addDays('2026-01-01', i), 7), duration: 3600, avgHr: 150 };
  }
  ds.workouts.b = { id: 'b', family: 'run', date: '2026-01-10', start: at('2026-01-10', 7), duration: 1800 };
  const loads = workoutLoads(ds, { maxHr: 190 });
  assert.equal(loads.get('b').basis, 'imputed');
  near(loads.get('b').trimp, loads.get('a0').trimp / 2, 1e-6);
});

test('fitness and fatigue converge to a steady load; form goes to zero', () => {
  const ds = emptyDs();
  const loads = new Map();
  for (let i = 0; i < 400; i++) {
    const d = addDays('2025-01-01', i);
    ds.workouts[d] = { id: d, date: d, start: at(d, 7), duration: 3600 };
    loads.set(d, { trimp: 100 });
  }
  const pmc = fitnessFatigue(ds, loads);
  const last = pmc.at(-1);
  near(last.ctl, 100, 0.5);
  near(last.atl, 100, 1e-6);
  near(last.ctl - last.atl, 0, 0.5);
  assert.ok(pmc[0].warmup && !last.warmup);
  near(acwr(pmc).at(-1).ratio, 1, 1e-6);
  // A taper: two weeks off raises form.
  const ds2 = { ...ds, workouts: Object.fromEntries(Object.entries(ds.workouts).slice(0, -14)) };
  const tapered = fitnessFatigue(ds2, loads, { to: addDays('2025-01-01', 399) });
  assert.ok(tapered.at(-1).ctl - tapered.at(-1).atl > 20);
  assert.equal(formZone(30).key, 'detraining');
  assert.equal(formZone(-35).key, 'overreaching');
});

test('Foster monotony and strain', () => {
  const rows = [100, 0, 100, 0, 100, 0, 100].map((load, i) => ({ date: addDays('2026-03-02', i), load })); // Monday start
  const [w] = monotonyStrain(rows);
  const m = (400 / 7) / Math.sqrt([100, 0, 100, 0, 100, 0, 100].reduce((a, v) => a + (v - 400 / 7) ** 2, 0) / 6);
  near(w.monotony, m, 1e-9);
  near(w.strain, 400 * m, 1e-9);
  const flat = monotonyStrain([1, 2, 3, 4, 5, 6, 7].map((_, i) => ({ date: addDays('2026-03-02', i), load: 50 })));
  assert.equal(flat[0].monotony, null, 'no variation: monotony undefined');
});

test('Seiler zones and the polarization index (Treff et al. 2019)', () => {
  near(polarizationIndex([0.8, 0.05, 0.15]), Math.log10(240), 1e-9);
  near(polarizationIndex([0.85, 0, 0.15]), Math.log10((0.85 / 0.01) * 0.15 * 100), 1e-9);
  assert.equal(polarizationIndex([1, 0, 0]), null);
  const w = { hrHist: { from: 140, step: 5, secs: [600, 0, 0, 300, 0, 0, 120] } }; // 142.5, 157.5, 172.5 bpm = 75, 83, 91 %
  assert.deepEqual(seilerZones(w, 190), [600, 300, 120]);
});

// ------------------------------------------------------------------ recovery

test('HRV below the normal range after a dip', () => {
  const ds = emptyDs();
  for (let i = 0; i < 90; i++) {
    const d = addDays('2026-01-01', i);
    ds.days[d] = { date: d, hrvAvg: i < 83 ? 50 + (i % 5) - 2 : 35 };
  }
  const rows = hrvBaseline(ds, { from: '2026-03-01', to: addDays('2026-01-01', 89) });
  assert.equal(rows.at(-1).status, 'below');
  assert.equal(rows.find((r) => r.date === '2026-03-10').status, 'within');
});

test('resting HR elevated against a robust baseline', () => {
  const ds = emptyDs();
  for (let i = 0; i < 40; i++) {
    const d = addDays('2026-01-01', i);
    ds.days[d] = { date: d, restHr: i === 39 ? 60 : 52 + (i % 3) - 1 };
  }
  const last = restingHrBaseline(ds, { from: '2026-02-01', to: addDays('2026-01-01', 39) }).at(-1);
  assert.equal(last.delta, 8);
  assert.ok(elevated(last));
  const r = readiness({ rest: last });
  assert.ok(r.score < 50);
  assert.equal(readiness({}), null);
});

// ------------------------------------------------------------------ sleep

const night = (date, onH, onM, offH, offM, extra = {}) => {
  const prev = addDays(date, -1);
  const start = onH >= 12 ? at(prev, onH, onM) : at(date, onH, onM);
  const end = at(date, offH, offM);
  return { date, start, end, tz: 0, total: Math.round((end - start) / 60000), ...extra };
};

test('social jetlag and MSFsc (Roenneberg et al.)', () => {
  const nights = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays('2026-03-02', i); // Monday
    const wd = i % 7;
    nights.push(wd >= 5 ? night(d, 1, 0, 10, 0) : night(d, 23, 0, 7, 0)); // free: 01–10, work: 23–07
  }
  const j = socialJetlag(nights);
  near(j.msw, 180, 1e-9, 'workday mid-sleep 03:00');
  near(j.msf, 330, 1e-9, 'free-day mid-sleep 05:30');
  near(j.jetlag, 150, 1e-9);
  const week = (5 * 480 + 2 * 540) / 7;
  near(j.msfsc, 330 - (540 - week) / 2, 1e-9);
});

test('Sleep Regularity Index: identical nights score 100, shifted nights less', () => {
  const same = Array.from({ length: 8 }, (_, i) => night(addDays('2026-03-02', i), 23, 0, 7, 0));
  assert.equal(sleepRegularity(same).sri, 100);
  const shifted = Array.from({ length: 8 }, (_, i) => (i % 2 ? night(addDays('2026-03-02', i), 23, 0, 7, 0) : night(addDays('2026-03-02', i), 2, 0, 10, 0)));
  const s = sleepRegularity(shifted).sri;
  // 3 h of 24 h awake/asleep mismatched twice (onset and wake): 6/24 disagree → 200·0.75 − 100 = 50.
  assert.equal(s, 50);
  assert.equal(sleepRegularity(same.slice(0, 3)), null, 'needs 3 pairs');
});

test('two-process model: pressure falls in sleep and rises awake', () => {
  const nights = Array.from({ length: 5 }, (_, i) => night(addDays('2026-03-02', i), 23, 0, 7, 0));
  const tp = twoProcess(nights);
  for (const n of tp.nights) assert.ok(n.sWake < n.sOnset);
  // After 8 h of sleep from S at onset: S·e^(−8/4.2).
  const n = tp.nights.at(-1);
  near(n.sWake, n.sOnset * Math.exp(-8 / 4.2), 0.02);
  const lows = tp.series.filter((p) => p.asleep);
  assert.ok(lows.length > 0 && lows.every((p) => p.lo < p.hi));
  assert.ok(Math.abs(circadian(6) - circadian(30)) < 1e-9, '24 h period');
});

test('sleep balance over the last 7 nights', () => {
  const nights = Array.from({ length: 7 }, (_, i) => ({ date: addDays('2026-03-02', i), total: 420 }));
  assert.equal(sleepBalance(nights, 480, '2026-03-08').balance, -420);
  assert.equal(sleepBalance(nights.slice(0, 3), 480, '2026-03-08'), null);
});

// ------------------------------------------------------------------ rhythm

test('cosinor recovers mesor, amplitude and peak time', () => {
  const pts = Array.from({ length: 48 }, (_, i) => ({ hour: (i % 24) + 0.5, value: 60 + 10 * Math.cos((2 * Math.PI * ((i % 24) + 0.5 - 15)) / 24) }));
  const c = cosinor(pts);
  near(c.mesor, 60, 1e-6);
  near(c.amplitude, 10, 1e-6);
  near(c.peakHour, 15, 1e-6);
  near(c.r2, 1, 1e-9);
});

test('rest–activity rhythm: the same day every day is perfectly stable', () => {
  const profile = Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 20 ? 500 : 0));
  const days = Array.from({ length: 10 }, (_, i) => ({ date: addDays('2026-03-02', i), steps: 6000, stepsHourly: profile }));
  const r = restActivity(days);
  assert.equal(r.is, 1);
  assert.equal(r.ra, 1);
  assert.equal(r.m10Start, 8);
  // Two 500-step jumps a day over 10 days: IV = n·Σdiff² / ((n − 1)·Σ(x − x̄)²) = 240·5e6 / (239·15e6).
  near(r.iv, 0.33, 0.005, 'IV');
  assert.equal(restActivity(days.slice(0, 5)), null);
});

test('Tudor-Locke step bands', () => {
  assert.equal(stepBand(4999).key, 'sedentary');
  assert.equal(stepBand(7500).key, 'somewhat');
  assert.equal(stepBand(13000).key, 'high');
  const m = monthlyStepBands([{ date: '2026-03-01', steps: 3000 }, { date: '2026-03-02', steps: 11000 }, { date: '2026-04-01', steps: 0 }]);
  assert.deepEqual(m.map((r) => [r.month, r.n, r.sedentary, r.active]), [['2026-03', 2, 1, 1]]);
});

// ------------------------------------------------------------------ correlations

test('Spearman ρ, ties, and Benjamini–Hochberg q-values', () => {
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  const r = spearman(Array.from({ length: 20 }, (_, i) => [i, i * i]));
  near(r.rho, 1, 1e-9);
  assert.ok(r.p < 1e-6);
  const q = bhAdjust([0.01, 0.04, 0.03, 0.2]);
  [0.04, 0.16 / 3, 0.16 / 3, 0.2].forEach((v, i) => near(q[i], v, 1e-9));
  assert.equal(spearman([[1, 2], [2, 3]]), null, 'too few pairs');
});

test('next-day correlations line a day up with the following night', () => {
  const ds = emptyDs();
  for (let i = 0; i < 60; i++) {
    const d = addDays('2026-01-01', i);
    const steps = 4000 + ((i * 7919) % 9000);
    ds.days[d] = { date: d, steps };
    // The night after a busy day is longer: night dated d+1 depends on steps on d.
    ds.nights[addDays(d, 1)] = { date: addDays(d, 1), total: 300 + steps / 50 };
  }
  const c = correlations(ds, { from: '2026-01-01', to: '2026-03-01' });
  const lag = c.lagged.find((x) => x.a === 'steps' && x.b === 'sleep');
  near(lag.rho, 1, 1e-9);
  assert.ok(lag.q < 0.01);
});

// ------------------------------------------------------------------ the whole pipeline

test('analyze and insights run on an empty and a small dataset', () => {
  assert.deepEqual(insights(analyze(emptyDs(), DEFAULT_SETTINGS), DEFAULT_SETTINGS), []);
  const ds = emptyDs();
  for (let i = 0; i < 70; i++) {
    const d = addDays('2026-01-01', i);
    ds.days[d] = { date: d, steps: 8000, restHr: 52, hrvAvg: 55 };
    ds.nights[d] = { ...night(d, 23, 0, 6, 30) };
    if (i % 2 === 0) ds.workouts[d] = { id: d, family: 'run', date: d, start: at(d, 7), duration: 2400, distance: 7000, avgHr: 150, efforts: { '5k': 1500 } };
  }
  const a = analyze(ds, DEFAULT_SETTINGS);
  assert.ok(a.snap.ctl > 0);
  assert.ok(a.vdotNow > 30);
  const list = insights(a, DEFAULT_SETTINGS);
  assert.ok(list.length >= 3);
  for (const i of list) assert.ok(i.title && i.text && i.cite && ['watch', 'good', 'info'].includes(i.tone));
  assert.ok(list.some((i) => /short of your sleep goal/.test(i.title)), '7 h 30 nights against an 8 h goal');
  assert.equal(analyze(ds, DEFAULT_SETTINGS), a, 'memoised');
});

test('max HR from age uses Tanaka (208 − 0.7 × age)', () => {
  const year = new Date().getFullYear();
  assert.equal(estimateMaxHr(emptyDs(), { birthYear: year - 40 }).value, 180);
});
