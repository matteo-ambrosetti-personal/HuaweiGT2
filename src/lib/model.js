// The normalised dataset and how fragments from different sources merge.
//
// Dataset = { days: {date → Day}, workouts: {id → Workout}, tracks: {id → Track},
//             nights: {date → SleepNight} }
// Every day metric group and every workout/night remembers its source.
// Precedence: export > intervals > healthsync > sample. A source never
// overwrites data owned by a higher-ranked one, only fills its gaps, except
// for steps and heart rate: there the more complete day wins the whole group
// (more steps, more heart-rate samples), because an export's last days are
// often partial while a fresher source already has the whole day.

import { chartBucket } from './huawei/sport-types.js';

export const SOURCE_RANK = { export: 3, intervals: 2, healthsync: 1, sample: 0 };
export const SOURCE_LABELS = {
  export: 'Huawei export',
  intervals: 'intervals.icu',
  healthsync: 'Health Sync',
  sample: 'Sample data',
};

export const METRIC_GROUPS = {
  steps: ['steps', 'distance', 'kcal', 'floors', 'activeMin', 'stepsHourly'],
  hr: ['hrMin', 'hrMax', 'hrAvg', 'hrN', 'hrHourly'],
  rest: ['restHr'],
  spo2: ['spo2Avg', 'spo2Min'],
  stress: ['stressAvg', 'stressMax'],
  hrv: ['hrvAvg'],
  nap: ['napMin'],
  weight: ['weight'],
  fitness: ['pred', 'lthr'],
};

const MATCH_WINDOW_MS = 120000;

export function emptyDataset() {
  return { days: {}, workouts: {}, tracks: {}, nights: {} };
}

const rank = (s) => SOURCE_RANK[s] ?? -1;

/** How complete a day's group is, for groups where the fuller source should win. */
const COVERAGE = { steps: (r) => r.steps, hr: (r) => r.hrN };

/**
 * How `source`'s values for a group meet the current owner's: 'take' (write
 * what it has), 'replace' (the fuller day takes the whole group), 'fill'
 * (only the owner's gaps) or 'skip' (a partial day adds nothing to a fuller one).
 */
function groupAction(group, target, incoming, owner, source) {
  if (!owner || owner === source) return 'take';
  const cover = COVERAGE[group];
  if (cover) {
    const a = cover(incoming), b = cover(target);
    if (a != null && b != null && a !== b) return a > b ? 'replace' : 'skip';
    if (a != null && b == null) return 'take';
  }
  return rank(source) >= rank(owner) ? 'take' : 'fill';
}

/** Merge one day's values from `source` into `target` (mutates target). */
export function mergeDay(target, incoming, source) {
  target.src ||= {};
  for (const [group, fields] of Object.entries(METRIC_GROUPS)) {
    if (!fields.some((f) => incoming[f] != null)) continue;
    const action = groupAction(group, target, incoming, target.src[group], source);
    if (action === 'skip') continue;
    if (action === 'fill') {
      for (const f of fields) if (target[f] == null && incoming[f] != null) target[f] = incoming[f];
      continue;
    }
    if (action === 'replace') for (const f of fields) delete target[f];
    for (const f of fields) if (incoming[f] != null) target[f] = incoming[f];
    target.src[group] = source;
  }
  return target;
}

function mergeNight(target, incoming, source) {
  const owner = target.src;
  if (owner && rank(owner) > rank(source)) {
    for (const [k, v] of Object.entries(incoming)) if (target[k] == null && v != null) target[k] = v;
    return target;
  }
  for (const [k, v] of Object.entries(incoming)) if (v != null) target[k] = v;
  target.src = source;
  return target;
}

function unionSources(a = [], b = []) {
  return [...new Set([...a, ...b])].sort((x, y) => rank(y) - rank(x));
}

/** Minute-bucket index of workouts for cross-source matching. */
function buildIndex(workouts) {
  const idx = new Map();
  for (const w of Object.values(workouts)) addToIndex(idx, w);
  return idx;
}

function addToIndex(idx, w) {
  const k = Math.floor(w.start / 60000);
  if (!idx.has(k)) idx.set(k, new Set());
  idx.get(k).add(w.id);
}

function removeFromIndex(idx, w) {
  idx.get(Math.floor(w.start / 60000))?.delete(w.id);
}

function findMatch(ds, idx, w) {
  const k = Math.floor(w.start / 60000);
  let best = null, bestGap = Infinity;
  for (let m = k - 2; m <= k + 2; m++) {
    for (const id of idx.get(m) || []) {
      const other = ds.workouts[id];
      if (!other || other.id === w.id) continue;
      if (chartBucket(other.family) !== chartBucket(w.family)) continue;
      const gap = Math.abs(other.start - w.start);
      if (gap > MATCH_WINDOW_MS) continue;
      if (other.duration > 0 && w.duration > 0) {
        const r = other.duration / w.duration;
        if (r < 0.6 || r > 1.67) continue;
      }
      if (gap < bestGap) { best = other; bestGap = gap; }
    }
  }
  return best;
}

/**
 * Merge a fragment {days, nights, workouts, tracks} from `source` into ds.
 * Returns counts of what changed.
 */
export function mergeDataset(ds, fragment, source) {
  const stats = { days: 0, nights: 0, workoutsAdded: 0, workoutsMerged: 0, tracks: 0 };
  for (const [dk, row] of Object.entries(fragment.days || {})) {
    const target = (ds.days[dk] ||= { date: dk });
    mergeDay(target, row, source);
    stats.days++;
  }
  for (const [dk, night] of Object.entries(fragment.nights || {})) {
    const target = (ds.nights[dk] ||= { date: dk });
    mergeNight(target, night, source);
    stats.nights++;
  }
  const idx = buildIndex(ds.workouts);
  for (const w0 of Object.values(fragment.workouts || {})) {
    const w = { ...w0, source: w0.source || source, sources: w0.sources || [source] };
    const track = fragment.tracks?.[w0.id] || null;
    const same = ds.workouts[w.id];
    if (same) {
      ds.workouts[w.id] = { ...same, ...w, sources: unionSources(same.sources, w.sources) };
      if (track) ds.tracks[w.id] = { ...track, id: w.id };
      stats.workoutsMerged++;
      continue;
    }
    const match = findMatch(ds, idx, w);
    if (!match) {
      ds.workouts[w.id] = w;
      addToIndex(idx, w);
      if (track) { ds.tracks[w.id] = { ...track, id: w.id }; stats.tracks++; }
      stats.workoutsAdded++;
      continue;
    }
    stats.workoutsMerged++;
    if (rank(w.source) > rank(match.source)) {
      // Incoming wins; keep the old copy's fields where the new one is silent.
      const merged = { ...match };
      for (const [k, v] of Object.entries(w)) if (v != null) merged[k] = v;
      merged.sources = unionSources(match.sources, w.sources);
      merged.id = w.id;
      delete ds.workouts[match.id];
      removeFromIndex(idx, match);
      ds.workouts[w.id] = merged;
      addToIndex(idx, merged);
      const oldTrack = ds.tracks[match.id];
      delete ds.tracks[match.id];
      if (track) ds.tracks[w.id] = { ...track, id: w.id };
      else if (oldTrack) ds.tracks[w.id] = { ...oldTrack, id: w.id };
      merged.hasTrack = Boolean(ds.tracks[w.id]);
    } else {
      for (const [k, v] of Object.entries(w)) if (match[k] == null && v != null) match[k] = v;
      match.sources = unionSources(match.sources, w.sources);
      if (!ds.tracks[match.id] && track) {
        ds.tracks[match.id] = { ...track, id: match.id };
        match.hasTrack = true;
        stats.tracks++;
      }
    }
  }
  return stats;
}

/** Sorted workouts array (newest first by default). */
export function workoutList(ds, { asc = false } = {}) {
  const list = Object.values(ds.workouts);
  list.sort((a, b) => (asc ? a.start - b.start : b.start - a.start));
  return list;
}

/** Date range covered by the dataset. */
export function datasetRange(ds) {
  const keys = [
    ...Object.keys(ds.days),
    ...Object.keys(ds.nights),
    ...Object.values(ds.workouts).map((w) => w.date),
  ].filter(Boolean).sort();
  return keys.length ? { from: keys[0], to: keys.at(-1) } : null;
}

export function isEmpty(ds) {
  return !ds || (!Object.keys(ds.days).length && !Object.keys(ds.workouts).length && !Object.keys(ds.nights).length);
}
