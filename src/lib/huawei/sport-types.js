// Huawei Health workout type codes.
//
// The outer `sportType` of a motion-path record uses one numbering; the summary
// JSON inside `attribute` uses the HiHealth numbering. Families group sports
// for charts: run, walk, hike, ride, swim, gym, other.

const OUTER = {
  2: { key: 'climb', label: 'Mountain hike', family: 'hike' },
  3: { key: 'ride', label: 'Outdoor cycle', family: 'ride' },
  4: { key: 'run', label: 'Outdoor run', family: 'run' },
  5: { key: 'walk', label: 'Outdoor walk', family: 'walk' },
  101: { key: 'indoor_run', label: 'Indoor run', family: 'run' },
  102: { key: 'pool_swim', label: 'Pool swim', family: 'swim' },
  103: { key: 'indoor_ride', label: 'Indoor cycle', family: 'ride' },
  104: { key: 'open_water', label: 'Open-water swim', family: 'swim' },
  111: { key: 'elliptical', label: 'Cross trainer', family: 'gym' },
  112: { key: 'rower', label: 'Rower', family: 'gym' },
  117: { key: 'free_training', label: 'Free training', family: 'other' },
  118: { key: 'trail_run', label: 'Cross-country run', family: 'run' },
  145: { key: 'crossfit', label: 'CrossFit', family: 'gym' },
  147: { key: 'strength', label: 'Strength training', family: 'gym' },
  281: { key: 'indoor_walk', label: 'Indoor walk', family: 'walk' },
  282: { key: 'hike', label: 'Hike', family: 'hike' },
};

const INNER = {
  257: { key: 'walk', label: 'Outdoor walk', family: 'walk' },
  258: { key: 'run', label: 'Outdoor run', family: 'run' },
  259: { key: 'ride', label: 'Outdoor cycle', family: 'ride' },
  260: { key: 'climb', label: 'Mountain hike', family: 'hike' },
  264: { key: 'indoor_run', label: 'Indoor run', family: 'run' },
  279: { key: 'free_training', label: 'Free training', family: 'other' },
  283: { key: 'rope', label: 'Rope skipping', family: 'gym' },
  290: { key: 'rower', label: 'Rower', family: 'gym' },
};

export const FAMILIES = ['run', 'walk', 'hike', 'ride', 'swim', 'gym', 'other'];

export const FAMILY_LABELS = {
  run: 'Running',
  walk: 'Walking',
  hike: 'Hiking',
  ride: 'Cycling',
  swim: 'Swimming',
  gym: 'Gym',
  other: 'Other',
};

/** Four buckets used by stacked charts. */
export function chartBucket(family) {
  if (family === 'run') return 'run';
  if (family === 'walk' || family === 'hike') return 'walkhike';
  if (family === 'ride') return 'ride';
  return 'other';
}

export const BUCKETS = ['run', 'walkhike', 'ride', 'other'];
export const BUCKET_LABELS = { run: 'Run', walkhike: 'Walk & hike', ride: 'Ride', other: 'Other' };

/** Resolve a Huawei workout to {key, label, family, code}. */
export function sportFromCodes(outer, inner) {
  const o = OUTER[Number(outer)];
  if (o) return { ...o, code: Number(outer) };
  const i = INNER[Number(inner)];
  if (i) return { ...i, code: Number(outer ?? inner) };
  const code = Number(outer ?? inner);
  if (!Number.isFinite(code)) return { key: 'unknown', label: 'Workout', family: 'other', code: null };
  return { key: `type_${code}`, label: `Type ${code}`, family: 'other', code };
}

/** Map free-text activity types (GPX/TCX/CSV/intervals.icu) to a family. */
export function familyFromText(text) {
  const t = String(text || '').toLowerCase();
  if (/swim/.test(t)) return 'swim';
  if (/(run|jog|treadmill)/.test(t)) return 'run';
  if (/(hik|climb|mountain|trek)/.test(t)) return 'hike';
  if (/(walk)/.test(t)) return 'walk';
  if (/(ride|cycl|bik|velo)/.test(t)) return 'ride';
  if (/(strength|weight|gym|row|ellip|crossfit|yoga|pilates|training|hiit|rope)/.test(t)) return 'gym';
  return 'other';
}

/** Display label for a free-text activity type. */
export function labelFromText(text) {
  const s = String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
  if (!s) return 'Workout';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
