// Assemble a dataset fragment from the parsed elements of a Huawei export.
//
// Usage: const imp = createHuaweiImporter();
//        imp.add(kind, value) for each top-level array element of each file;
//        const { dataset, diag } = imp.finish();

import { createHealthAccumulator } from './health.js';
import { createMinuteAccumulator } from './minute.js';
import { parseSleepSummary, buildNights } from './sleep.js';
import { normalizeMotionRecord, motionRecords } from './motion.js';
import { emptyDataset, mergeDataset } from '../model.js';

export function createHuaweiImporter() {
  const health = createHealthAccumulator();
  const minute = createMinuteAccumulator();
  const summaries = [];
  const workouts = new Map(); // dedupe key → {workout, track, gpsCount}
  const diag = {
    files: {},
    elements: { motion: 0, health: 0, minute: 0, sequence: 0 },
    parseErrors: 0,
    motionTags: {},
    sequenceTypes: {},
    sleepSummaryKeys: {},
    workoutsDuplicated: 0,
    workoutsRejected: 0,
  };

  function addMotion(value) {
    for (const rec of motionRecords(value)) {
      let res;
      try {
        res = normalizeMotionRecord(rec);
      } catch {
        res = null;
      }
      if (!res) {
        diag.workoutsRejected++;
        continue;
      }
      for (const [tag, c] of Object.entries(res.tags)) diag.motionTags[tag] = (diag.motionTags[tag] || 0) + c;
      // Same workout appears in several files: dedupe by recordId (else start
      // time + sport), keeping the copy with the most GPS points.
      const key = res.recordId || `${res.workout.start}|${res.workout.sport}`;
      const prev = workouts.get(key);
      if (prev) {
        diag.workoutsDuplicated++;
        if (prev.gpsCount >= res.gpsCount) continue;
      }
      workouts.set(key, res);
    }
  }

  function add(kind, value) {
    if (kind in diag.elements) diag.elements[kind]++;
    switch (kind) {
      case 'motion':
        addMotion(value);
        break;
      case 'health':
        health.add(value);
        break;
      case 'minute':
        minute.add(value);
        break;
      case 'sequence': {
        const t = Number(value?.type);
        diag.sequenceTypes[t] = (diag.sequenceTypes[t] || 0) + 1;
        const s = parseSleepSummary(value);
        if (s) {
          for (const k of s.keys) diag.sleepSummaryKeys[k] = (diag.sleepSummaryKeys[k] || 0) + 1;
          summaries.push(s);
        }
        break;
      }
      default:
        break;
    }
  }

  function noteFile(name, kind, stats) {
    diag.files[name] = { kind, ...stats };
    if (stats?.errors) diag.parseErrors += stats.errors;
  }

  function finish() {
    const ds = emptyDataset();
    const h = health.finish();
    const m = minute.finish();
    const { nights, naps } = buildNights({ spans: h.spans, bedRecords: h.bedRecords, summaries });
    const days = {};
    const dayRow = (dk) => (days[dk] ||= { date: dk });
    for (const [dk, row] of Object.entries(m.days)) Object.assign(dayRow(dk), row);
    for (const [dk, row] of Object.entries(h.days)) {
      const d = dayRow(dk);
      const { goalSteps, goalKcal, ...rest } = row;
      Object.assign(d, rest);
      // Daily goal totals fill in when per-minute data is missing.
      if (d.steps == null && goalSteps != null) d.steps = goalSteps;
      if (d.kcal == null && goalKcal != null) d.kcal = goalKcal;
    }
    for (const [dk, min] of Object.entries(naps)) dayRow(dk).napMin = min;

    const fragment = {
      days,
      nights,
      workouts: {},
      tracks: {},
    };
    for (const { workout, track } of workouts.values()) {
      fragment.workouts[workout.id] = workout;
      if (track) fragment.tracks[workout.id] = track;
    }
    mergeDataset(ds, fragment, 'export');
    diag.health = h.diag;
    diag.minuteRecords = m.records;
    diag.counts = {
      days: Object.keys(ds.days).length,
      workouts: Object.keys(ds.workouts).length,
      tracks: Object.keys(ds.tracks).length,
      nights: Object.keys(ds.nights).length,
    };
    const dates = Object.keys(ds.days).sort();
    const wdates = Object.values(ds.workouts).map((w) => w.date).sort();
    diag.range = {
      from: [dates[0], wdates[0]].filter(Boolean).sort()[0] || null,
      to: [dates.at(-1), wdates.at(-1)].filter(Boolean).sort().at(-1) || null,
    };
    return { dataset: ds, diag };
  }

  return { add, noteFile, finish };
}
