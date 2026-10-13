import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateExport } from '../src/lib/sample/generate.js';
import { classifyEntry } from '../src/lib/huawei/entries.js';
import { createHuaweiImporter } from '../src/lib/huawei/index.js';
import { parseArrayText } from '../src/lib/json-stream.js';
import { normTime, splitAttribute, parseDetail, normalizeMotionRecord, decodePaceKey } from '../src/lib/huawei/motion.js';
import { pointValue, numericFor } from '../src/lib/huawei/health.js';
import { sportFromCodes } from '../src/lib/huawei/sport-types.js';

function importGenerated(opts) {
  const { files, plan } = generateExport(opts);
  const imp = createHuaweiImporter();
  for (const f of files) {
    const kind = classifyEntry(f.name);
    if (!kind) continue;
    const res = parseArrayText(f.text, (v) => imp.add(kind, v));
    imp.noteFile(f.name, kind, res);
  }
  return { ...imp.finish(), plan, files };
}

test('classifies export entries across layouts', () => {
  assert.equal(classifyEntry('HUAWEI_HEALTH_1/Motion path detail data & description/motion path detail data1767225600000.json'), 'motion');
  assert.equal(classifyEntry('data/Motion path detail data & description/motion path detail data.json'), 'motion');
  assert.equal(classifyEntry('X/Health detail data & description/health detail data123.json'), 'health');
  assert.equal(classifyEntry('X/Sport per minute merged data & description/sport per minute merged data3.json'), 'minute');
  assert.equal(classifyEntry('X/Sample sequence data & description/sample sequence data9.json'), 'sequence');
  assert.equal(classifyEntry('X/Health detail data & description/Health detail data-Data Field Description.xlsx'), null);
  assert.equal(classifyEntry('nested/export.zip'), 'zip');
});

test('normalises every GPS time format', () => {
  const start = Date.UTC(2025, 6, 9, 5, 0, 0);
  assert.equal(normTime('1752037200123', start, 120), 1752037200123);
  assert.equal(normTime('1752037200', start, 120), 1752037200000);
  assert.equal(normTime('1.752037200E9', start, 120), 1752037200000);
  // seconds of local day: 07:00:30 local (+02:00) = 05:00:30 UTC
  assert.equal(normTime('25230', start, 120), start + 30000);
  assert.equal(normTime('0', start, 120), null);
  assert.equal(normTime('', start, 120), null);
});

test('decodes paceMap keys', () => {
  assert.deepEqual(decodePaceKey('87001729'), { km: 8.7, point: 1729 });
});

test('splits attributes and parses detail lines with pauses', () => {
  const start = Date.UTC(2025, 0, 1, 7, 0, 0);
  const attr = [
    'HW_EXT_TRACK_DETAIL@is',
    `tp=lbs;k=1;lat=45.1;lon=9.1;alt=120.5;t=${start + 2000};`,
    `tp=lbs;k=2;lat=45.1001;lon=9.1001;alt=121;t=${(start + 5000) / 1000};`,
    'tp=lbs;k=3;lat=90.0;lon=-80.0;alt=0;t=0;',
    `tp=lbs;k=4;lat=45.1002;lon=9.1002;alt=0;t=${start + 200000};`,
    'tp=lbs;k=5;lat=0;lon=0;alt=0;t=0;',
    `tp=h-r;k=${start + 5000};v=120;`,
    `tp=h-r;k=${start + 10000};v=255;`,
    `tp=alt;k=${start + 5000};v=130.2;`,
    `tp=alti;k=${start + 10000};v=131.0;`,
    'tp=rs;k=10;v=31;',
    'tp=rp;k=10;gct=230;',
    '&&HW_EXT_TRACK_SIMPLIFY@is{"avgHeartRate":150}',
  ].join('\n');
  const { detail, summary } = splitAttribute(attr);
  assert.equal(summary, '{"avgHeartRate":150}');
  const { series, tags } = parseDetail(detail, start, 60);
  assert.equal(series.gps.length, 3);
  assert.deepEqual(series.gps.map((p) => p.seg), [0, 0, 1]);
  assert.equal(series.gps[1].t, start + 5000);
  assert.equal(series.hr.length, 1, 'drops 255');
  assert.equal(series.alt.length, 2, 'both alt spellings');
  assert.deepEqual(series.speed[0], { t: start + 10000, v: 3.1 });
  assert.equal(tags.rp, 1);
});

test('normalises a motion record: units, sport, splits from partTimeMap', () => {
  const start = Date.UTC(2025, 6, 9, 5, 0, 0);
  const lines = [];
  let lat = 45.0;
  for (let s = 0; s <= 600; s += 2) {
    lat += 3 / 111320 * 2; // 3 m/s
    lines.push(`tp=lbs;k=${s};lat=${lat.toFixed(6)};lon=9.000000;alt=0;t=${start + s * 1000};`);
    lines.push(`tp=h-r;k=${start + s * 1000};v=${140 + (s % 10)};`);
  }
  const rec = {
    recordId: 'abc', sportType: 4, startTime: start, endTime: start + 600000, timeZone: '+0200',
    totalTime: 600000, totalDistance: 1800, totalCalories: 120500, totalSteps: 1700,
    attribute: 'HW_EXT_TRACK_DETAIL@is' + lines.join('\n') +
      '&&HW_EXT_TRACK_SIMPLIFY@is' + JSON.stringify({ avgPace: 333.3, avgHeartRate: 144, creepingWave: 125, mTotalDescent: 90, sportType: 258, partTimeMap: { 1: 333 } }),
  };
  const { workout, track } = normalizeMotionRecord(rec);
  assert.equal(workout.id, 'hw-abc');
  assert.equal(workout.family, 'run');
  assert.equal(workout.kcal, 120.5);
  assert.equal(workout.ascent, 12.5);
  assert.equal(workout.descent, 9);
  assert.equal(workout.duration, 600);
  assert.equal(workout.date, '2025-07-09');
  assert.equal(workout.splits.length, 1);
  assert.equal(workout.splits[0].time, 333);
  assert.ok(workout.thumb && workout.bbox);
  assert.ok(workout.hrHist.secs.length > 0);
  assert.ok(track.n > 100 && track.n <= 1000);
  assert.equal(track.hr.length, track.n);

  // The 2026 layout of the same workout: detail lines and summary JSON in
  // their own fields, the totals only inside the summary.
  const modern = {
    appType: 1, dataSource: 0, recordId: 'abc', startTime: start, endTime: start + 600000, timeZone: '+0200',
    type: 30001, subType: 4, detailData: lines.join('\n') + '\n',
    summaryData: JSON.stringify({
      avgPace: 333.3, avgHeartRate: 144, creepingWave: 125, mTotalDescent: 90, sportType: 258, partTimeMap: { 1: 333 },
      totalTime: 600000, totalDistance: 1800, totalCalories: 120500, totalSteps: 1700,
    }),
  };
  const twin = normalizeMotionRecord(modern);
  for (const k of ['id', 'family', 'label', 'distance', 'duration', 'kcal', 'steps', 'ascent', 'descent', 'date', 'avgHr', 'gpsPoints', 'hasTrack']) {
    assert.deepEqual(twin.workout[k], workout[k], k);
  }
  assert.equal(twin.workout.splits.length, 1);
  assert.equal(twin.track.n, track.n);
  // Unknown codes still read their totals and track.
  const odd = normalizeMotionRecord({ ...modern, summaryData: modern.summaryData.replace('"sportType":258', '"sportType":227') });
  assert.equal(odd.workout.label, 'Type 227');
  assert.equal(odd.workout.distance, 1800);
  assert.ok(odd.track);
});

test('health values: numeric strings and JSON strings', () => {
  assert.equal(pointValue('83.0'), 83);
  assert.deepEqual(pointValue('{"bpm":83}'), { bpm: 83 });
  assert.equal(numericFor('DYNAMIC_HEART_RATE', { bpm: 83 }), 83);
  assert.equal(numericFor('BLOOD_OXYGEN_SATURATION', { spo2: 97 }), 97);
  assert.equal(numericFor('STRESS', { stressScore: 38 }), 38);
});

test('sport codes map to families, unknown codes become Type N', () => {
  assert.equal(sportFromCodes(282).family, 'hike');
  assert.equal(sportFromCodes(null, 259).family, 'ride');
  assert.deepEqual(sportFromCodes(999).label, 'Type 999');
});

test('imports a generated export end to end', () => {
  const { dataset, diag, plan } = importGenerated({ days: 21, seed: 7, gpsEvery: 5 });
  assert.equal(diag.parseErrors, 0, 'bare keys must not break parsing');

  // Workouts: duplicates across files collapse; counts match the plan.
  const ids = Object.keys(dataset.workouts).sort();
  assert.deepEqual(ids, plan.workouts.map((w) => w.id).sort());
  for (const p of plan.workouts) {
    const w = dataset.workouts[p.id];
    assert.equal(w.distance ?? 0, p.distance, `${p.id} distance`);
    assert.equal(w.duration, p.duration, `${p.id} duration`);
    if (p.gps) {
      assert.ok(w.hasGps, `${p.id} gps`);
      // the full copy (not the reduced duplicate) is kept
      assert.ok(Math.abs(w.gpsPoints - p.gps) <= 2, `${p.id} kept ${w.gpsPoints} of ${p.gps}`);
    }
    if (p.partTimes.length) assert.equal(w.splits.length, p.partTimes.length, `${p.id} splits`);
  }
  assert.ok(diag.workoutsDuplicated > 0);

  // Daily steps: duplicate low-step minutes from a second device are ignored.
  for (const [date, d] of Object.entries(plan.days)) {
    assert.equal(dataset.days[date].steps, d.steps, `${date} steps`);
    assert.equal(dataset.days[date].restHr, d.restHr, `${date} resting HR`);
    assert.equal(dataset.days[date].hrN, 144, `${date} HR deduped`);
    assert.ok(dataset.days[date].stressAvg > 0);
    assert.ok(dataset.days[date].spo2Avg >= 94);
    assert.equal(dataset.days[date].src.steps, 'export');
  }

  // Nights: duplicated spans collapse; summary fields attach.
  for (const [date, n] of Object.entries(plan.nights)) {
    const night = dataset.nights[date];
    assert.ok(night, `night ${date}`);
    assert.ok(Math.abs(night.total - n.total) <= 2, `${date} total ${night.total} vs ${n.total}`);
    assert.equal(night.score, n.score);
    assert.equal(night.maxHr, undefined, '255 is not available');
    assert.ok(night.stages.length > 3);
  }
});
