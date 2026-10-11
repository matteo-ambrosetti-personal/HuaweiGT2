import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGpx, parseTcx, toGpx, toTcx, trackPoints } from '../src/lib/gpx.js';
import { parseCsv, toCsv } from '../src/lib/csv.js';
import { parseActivityFile, parseDailyCsv } from '../src/lib/healthsync.js';
import { workoutFromActivity, analyzeActivity, fragmentFromWellness } from '../src/lib/intervals.js';
import { analyzeSeries, emptySeries, bestEfforts, timelines, computeSplits } from '../src/lib/track.js';

function syntheticTrack(n = 600, stepS = 2, mps = 3) {
  const t0 = Date.UTC(2025, 4, 1, 6, 0, 0);
  const s = emptySeries();
  for (let i = 0; i < n; i++) {
    const t = t0 + i * stepS * 1000;
    s.gps.push({ t, lat: 45 + (i * stepS * mps) / 111320, lon: 9, alt: 100 + i * 0.1, seg: 0 });
    s.hr.push({ t, v: 130 + (i % 20) });
  }
  return { t0, s };
}

test('best efforts and splits on a steady 3 m/s track', () => {
  const { s } = syntheticTrack(2000, 2, 3); // 12 km at 3 m/s (333 s/km)
  const tl = timelines(s.gps);
  const e = bestEfforts(tl);
  assert.ok(Math.abs(e['1k'] - 333) <= 2, String(e['1k']));
  assert.ok(Math.abs(e['10k'] - 3333) <= 10, String(e['10k']));
  const splits = computeSplits(s.gps, tl, { hr: s.hr });
  assert.equal(splits.length, 12); // 11 full km + partial ≈ 0.99 km
  assert.ok(Math.abs(splits[0].pace - 333) <= 2);
  assert.ok(splits[0].hr > 130);
});

test('GPX and TCX round trip through stored tracks', () => {
  const { t0, s } = syntheticTrack(300);
  const w = { id: 'x', label: 'Outdoor run', family: 'run', date: '2025-05-01', start: t0, end: t0 + 600000, duration: 600, distance: 1800, kcal: 120, avgHr: 140, maxHr: 149 };
  const { track } = analyzeSeries(w, s);
  const gpx = toGpx(w, track);
  const back = parseGpx(gpx);
  assert.equal(back.series.gps.length, trackPoints(track).filter((p) => p.pos).length);
  assert.ok(back.series.hr.length > 100);
  assert.equal(back.type, 'run');
  const tcx = toTcx(w, track);
  const t = parseTcx(tcx);
  assert.equal(t.sport, 'Running');
  assert.equal(t.laps.distance, 1800);
  assert.equal(t.laps.avgHr, 140);
  assert.ok(t.series.gps.length > 100);
});

test('Health Sync activity files become workouts', () => {
  const { t0, s } = syntheticTrack(300);
  const w = { id: 'x', label: 'Ride', family: 'ride', date: '2025-05-01', start: t0, end: t0 + 600000, duration: 600, distance: 1800 };
  const { track } = analyzeSeries(w, s);
  const res = parseActivityFile('2025-05-01 Cycling.tcx', toTcx(w, track), 'file123');
  assert.equal(res.workout.id, 'hs-file123');
  assert.equal(res.workout.family, 'ride');
  assert.equal(res.workout.distance, 1800);
  assert.ok(res.track && res.workout.thumb);
});

test('CSV parsing handles quotes, delimiters and BOM', () => {
  assert.deepEqual(parseCsv('﻿a;b\n"x;1";"he said ""hi"""\r\n'), [['a', 'b'], ['x;1', 'he said "hi"']]);
  const csv = toCsv([{ a: 1, b: 'x,y' }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]);
  assert.equal(csv, 'A,B\r\n1,"x,y"\r\n');
});

test('daily CSV columns are matched by synonyms', () => {
  const text = 'Date,Steps,Distance (km),Resting heart rate,Sleep duration,Deep sleep\n2025-05-01,8000,5.5,56,7:30,80\n2025-05-01,500,0.3,,,\n02/05/2025,9000,6,55,450,90\n';
  const { days, nights, columns } = parseDailyCsv(text);
  assert.equal(columns.steps, 'Steps');
  assert.equal(days['2025-05-01'].steps, 8500);
  assert.equal(days['2025-05-01'].distance, 5800);
  assert.equal(days['2025-05-02'].restHr, 55);
  assert.equal(nights['2025-05-01'].total, 450);
  assert.equal(nights['2025-05-02'].deep, 90);
});

test('intervals.icu activities, streams and wellness map to the model', () => {
  const a = {
    id: 'i123', start_date: '2025-05-01T05:00:00Z', start_date_local: '2025-05-01T07:00:00', type: 'Run', name: 'Lunch run',
    distance: 5000, moving_time: 1500, elapsed_time: 1600, total_elevation_gain: 30, average_heartrate: 150, calories: 400,
  };
  const w = workoutFromActivity(a);
  assert.equal(w.tz, 120);
  assert.equal(w.date, '2025-05-01');
  assert.equal(w.family, 'run');
  assert.equal(w.avgPace, 300);
  const streams = {
    time: Array.from({ length: 100 }, (_, i) => i * 15),
    latlng: Array.from({ length: 100 }, (_, i) => [45 + i * 0.0004, 9]),
    heartrate: Array.from({ length: 100 }, () => 150),
  };
  const res = analyzeActivity(a, streams);
  assert.ok(res.track && res.workout.hasGps);
  const frag = fragmentFromWellness([{ id: '2025-05-01', steps: 9000, restingHR: 52, sleepSecs: 27000, sleepScore: 81 }]);
  assert.deepEqual(frag.days['2025-05-01'], { steps: 9000, restHr: 52 });
  assert.deepEqual(frag.nights['2025-05-01'], { date: '2025-05-01', total: 450, score: 81 });
});
