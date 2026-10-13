import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDataset, mergeDataset, mergeDay } from '../src/lib/model.js';
import {
  summarize, streaks, weekdayProfile, weeklyVolume, rollingMean, rollingMedian, linearTrend,
  zonesFromHist, estimateMaxHr, personalRecords, yearSummary, resolveRange, previousRange,
  sleepSummary, bedMinute, stepBests, runningFitness, predictionConsistent,
} from '../src/lib/stats.js';

const day = (date, extra) => ({ date, ...extra });

test('day merge respects source precedence per metric group', () => {
  const d = { date: '2025-01-01' };
  mergeDay(d, { steps: 10000, hrAvg: 70 }, 'export');
  mergeDay(d, { steps: 10000, distance: 6000, restHr: 55 }, 'healthsync');
  mergeDay(d, { steps: 10000, restHr: 54, spo2Avg: 97 }, 'intervals');
  assert.equal(d.steps, 10000, 'export owns steps');
  assert.equal(d.distance, 6000, 'missing field filled from lower rank');
  assert.equal(d.restHr, 54, 'intervals outranks healthsync');
  assert.equal(d.spo2Avg, 97);
  assert.deepEqual(d.src, { steps: 'export', rest: 'intervals', hr: 'export', spo2: 'intervals' });
});

test('for steps and heart rate the more complete day wins', () => {
  // An export's last day is often partial; a fresher Health Sync day stays.
  const partial = { date: '2026-03-12' };
  mergeDay(partial, { steps: 8800, stepsHourly: new Array(24).fill(1), hrAvg: 80, hrN: 300 }, 'healthsync');
  mergeDay(partial, { steps: 140, distance: 70, kcal: 4, hrAvg: 75, hrN: 12, restHr: 55 }, 'export');
  assert.equal(partial.steps, 8800);
  assert.equal(partial.distance, undefined, 'the partial day adds nothing to the fuller one');
  assert.equal(partial.kcal, undefined);
  assert.equal(partial.hrAvg, 80);
  assert.equal(partial.restHr, 55, 'other groups keep the rank rule');
  assert.deepEqual(partial.src, { steps: 'healthsync', hr: 'healthsync', rest: 'export' });

  // The other order: the fuller day takes the whole group, so the partial
  // day's distance and calories don't sit next to the fuller day's steps.
  const later = { date: '2026-03-12' };
  mergeDay(later, { steps: 140, distance: 70, kcal: 4, hrAvg: 75, hrN: 12, restHr: 55 }, 'export');
  mergeDay(later, { steps: 8800, stepsHourly: new Array(24).fill(1), hrAvg: 80, hrN: 300 }, 'healthsync');
  assert.equal(later.steps, 8800);
  assert.equal(later.distance, undefined);
  assert.equal(later.kcal, undefined);
  assert.equal(later.hrAvg, 80);
  assert.equal(later.restHr, 55);
  assert.deepEqual(later.src, { steps: 'healthsync', hr: 'healthsync', rest: 'export' });

  // Gaps are still filled when rank decides (no step count to compare).
  const gap = { date: '2026-03-10' };
  mergeDay(gap, { steps: 5000 }, 'export');
  mergeDay(gap, { kcal: 300 }, 'healthsync');
  assert.equal(gap.kcal, 300);
  assert.equal(gap.src.steps, 'export');

  // A complete export day replaces a smaller one; a tie goes to the higher rank.
  const full = { date: '2026-03-11' };
  mergeDay(full, { steps: 6800, hrN: 240, hrAvg: 90 }, 'healthsync');
  mergeDay(full, { steps: 7150, hrN: 240, hrAvg: 88 }, 'export');
  assert.equal(full.steps, 7150);
  assert.equal(full.hrAvg, 88);
  assert.deepEqual(full.src, { steps: 'export', hr: 'export' });

  // A later, fuller sync of the same day takes over again; the same source always overwrites.
  mergeDay(full, { steps: 8000 }, 'healthsync');
  assert.equal(full.steps, 8000);
  mergeDay(full, { steps: 7900 }, 'healthsync');
  assert.equal(full.steps, 7900);
});

test('workouts from different sources merge within ±2 minutes', () => {
  const ds = emptyDataset();
  const t = Date.UTC(2025, 5, 1, 6, 0, 0);
  mergeDataset(ds, {
    workouts: { 'iv-1': { id: 'iv-1', family: 'run', start: t + 60000, duration: 1800, distance: 5100, name: 'Morning run', date: '2025-06-01' } },
    tracks: { 'iv-1': { id: 'iv-1', n: 10 } },
  }, 'intervals');
  mergeDataset(ds, {
    workouts: { 'hw-9': { id: 'hw-9', family: 'run', start: t, duration: 1790, distance: 5000, date: '2025-06-01' } },
  }, 'export');
  assert.deepEqual(Object.keys(ds.workouts), ['hw-9']);
  const w = ds.workouts['hw-9'];
  assert.equal(w.distance, 5000, 'export wins');
  assert.equal(w.name, 'Morning run', 'keeps fields only the other source had');
  assert.deepEqual(w.sources, ['export', 'intervals']);
  assert.equal(ds.tracks['hw-9'].n, 10, 'track carried over');
  // a different sport at the same time is a separate workout
  mergeDataset(ds, { workouts: { 'hs-2': { id: 'hs-2', family: 'ride', start: t, duration: 1800, date: '2025-06-01' } } }, 'healthsync');
  assert.equal(Object.keys(ds.workouts).length, 2);
  // re-importing the same id replaces it
  mergeDataset(ds, { workouts: { 'hw-9': { id: 'hw-9', family: 'run', start: t, duration: 1790, distance: 5005, date: '2025-06-01' } } }, 'export');
  assert.equal(ds.workouts['hw-9'].distance, 5005);
});

function sampleDs() {
  const ds = emptyDataset();
  const days = {};
  for (let i = 1; i <= 14; i++) {
    const date = `2025-03-${String(i).padStart(2, '0')}`;
    days[date] = day(date, { steps: i <= 3 || i >= 10 ? 12000 : 4000, restHr: 60 - i / 7, stepsHourly: new Array(24).fill(100) });
  }
  mergeDataset(ds, {
    days,
    nights: {
      '2025-03-02': { date: '2025-03-02', total: 420, deep: 80, rem: 90, light: 250, start: Date.UTC(2025, 2, 1, 22, 30), end: Date.UTC(2025, 2, 2, 5, 30), tz: 60 },
      '2025-03-03': { date: '2025-03-03', total: 480, deep: 100, rem: 100, light: 280, start: Date.UTC(2025, 2, 2, 23, 30), end: Date.UTC(2025, 2, 3, 7, 30), tz: 60 },
    },
    workouts: {
      a: { id: 'a', family: 'run', start: Date.UTC(2025, 2, 3, 6), date: '2025-03-03', duration: 1800, distance: 6000, avgPace: 300, efforts: { '1k': 280, '5k': 1490 }, maxHr: 182, ascent: 40 },
      b: { id: 'b', family: 'run', start: Date.UTC(2025, 2, 10, 6), date: '2025-03-10', duration: 3000, distance: 10000, avgPace: 300, efforts: { '1k': 275, '5k': 1500, '10k': 3000 }, maxHr: 185 },
      c: { id: 'c', family: 'ride', start: Date.UTC(2025, 2, 8, 9), date: '2025-03-08', duration: 5400, distance: 40000, ascent: 300, maxHr: 170 },
      d: { id: 'd', family: 'hike', start: Date.UTC(2024, 7, 8, 9), date: '2024-08-08', duration: 9000, distance: 12000, ascent: 800 },
    },
  }, 'export');
  return ds;
}

test('summary, change ranges and streaks', () => {
  const ds = sampleDs();
  const s = summarize(ds, { from: '2025-03-01', to: '2025-03-14' }, { stepGoal: 10000 });
  assert.equal(s.stepDays, 14);
  assert.equal(s.goalDays, 8);
  assert.equal(s.workouts, 3);
  assert.equal(s.byBucket.run.distance, 16000);
  assert.equal(s.byBucket.ride.n, 1);
  assert.equal(s.nights, 2);
  assert.equal(s.sleepAvg, 450);
  assert.deepEqual(previousRange({ from: '2025-03-08', to: '2025-03-14' }), { from: '2025-03-01', to: '2025-03-07' });
  const st = streaks(ds, 10000, '2025-03-14');
  assert.equal(st.current, 5);
  assert.equal(st.longest, 5);
  const r = resolveRange(ds, '7d');
  assert.equal(r.to >= '2025-03-14', true);
});

test('profiles, volumes and rolling helpers', () => {
  const ds = sampleDs();
  const rows = Object.values(ds.days);
  const wd = weekdayProfile(rows, 'steps');
  assert.equal(wd.length, 7);
  const vol = weeklyVolume(ds, { from: '2025-03-01', to: '2025-03-14' }, 'distance');
  assert.ok(vol.some((w) => w.run === 10000));
  assert.deepEqual(rollingMean([1, 2, 3, null, 5], 2), [1, 1.5, 2.5, 3, 5]);
  assert.deepEqual(rollingMedian([5, 1, 3], 3), [5, 3, 3]);
  const lt = linearTrend([[0, 1], [1, 3], [2, 5]]);
  assert.equal(lt.slope, 2);
  assert.equal(lt.intercept, 1);
});

test('HR zones from histogram and max HR estimate', () => {
  const ds = sampleDs();
  assert.equal(estimateMaxHr(ds, { maxHr: 190 }).value, 190);
  assert.equal(estimateMaxHr(ds, {}).basis, 'workouts');
  const z = zonesFromHist({ from: 40, step: 5, secs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 120] }, 200);
  // bins 28 (180–185 → z5 since 182.5 ≥ 180) and 29 (185–190)
  assert.deepEqual(z, [0, 0, 0, 0, 180]);
});

test('records, years and step bests', () => {
  const ds = sampleDs();
  const pr = personalRecords(ds);
  assert.equal(pr.efforts.find((e) => e.key === '1k').best.time, 275);
  assert.equal(pr.efforts.find((e) => e.key === '10k').best.id, 'b');
  assert.equal(pr.longest.ride.id, 'c');
  assert.equal(pr.biggestClimb.id, 'd');
  const years = yearSummary(ds);
  assert.deepEqual(years.map((y) => y.year), ['2025', '2024']);
  assert.equal(years[1].walkhike, 12000);
  assert.equal(stepBests(ds).day.steps, 12000);
});

test('sleep summary uses bedtime relative to midnight', () => {
  assert.equal(bedMinute(Date.UTC(2025, 2, 1, 22, 30), 60), -30);
  const s = sleepSummary(Object.values(sampleDs().nights));
  assert.equal(s.avgTotal, 450);
  assert.equal(s.avgStart, 0); // -30 and +30
});

test('running fitness keeps consistent race predictions and the latest threshold', () => {
  const ok = { k1: 300, k3: 960, k5: 1650, k10: 3450, hm: 7600, m: 16000 };
  assert.equal(predictionConsistent(ok), true);
  assert.equal(predictionConsistent({ ...ok, k5: 900 }), false, 'a 5 km faster than its 3 km');
  assert.equal(predictionConsistent({ k5: 1650 }), true, 'one distance is fine');
  assert.equal(predictionConsistent({}), false);
  assert.equal(predictionConsistent({ k1: 600, k3: 1100, k5: 1900 }), true, 'the unexplained km1 value is not compared');
  const ds = emptyDataset();
  ds.days['2026-01-02'] = day('2026-01-02', { pred: ok, lthr: { hr: 165, pace: 330 } });
  ds.days['2026-01-01'] = day('2026-01-01', { pred: { ...ok, k5: 1700 } });
  ds.days['2026-01-03'] = day('2026-01-03', { pred: { ...ok, k5: 900, k10: 1900 } });
  ds.days['2026-01-04'] = day('2026-01-04', { steps: 5000 });
  const fit = runningFitness(ds);
  assert.deepEqual(fit.predictions.map((p) => p.date), ['2026-01-01', '2026-01-02'], 'oldest first, inconsistent day left out');
  assert.equal(fit.dropped, 1);
  assert.equal(fit.latest.date, '2026-01-02');
  assert.equal(fit.latest.k5, 1650);
  assert.deepEqual(fit.latestThreshold, { date: '2026-01-02', hr: 165, pace: 330 });
});
