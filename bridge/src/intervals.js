// intervals.icu API client (personal API key, Basic auth "API_KEY:<key>").
// Docs: https://intervals.icu/api-docs.html — athlete id "0" means the key's owner.

const BASE = 'https://intervals.icu/api/v1';

export class IntervalsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function auth(env) {
  if (!env.INTERVALS_API_KEY) throw new IntervalsError(500, 'INTERVALS_API_KEY is not set on the worker');
  return 'Basic ' + btoa(`API_KEY:${env.INTERVALS_API_KEY}`);
}

async function get(env, path, params = {}, fetchImpl = fetch) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetchImpl(url.toString(), { headers: { Authorization: auth(env), Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new IntervalsError(res.status, `intervals.icu ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  }
  return res.json();
}

const ACTIVITY_FIELDS = [
  'id', 'start_date', 'start_date_local', 'type', 'name', 'distance', 'moving_time', 'elapsed_time',
  'total_elevation_gain', 'average_heartrate', 'max_heartrate', 'average_speed', 'max_speed',
  'average_cadence', 'calories', 'source', 'device_name', 'icu_training_load', 'trainer',
];

const WELLNESS_FIELDS = [
  'id', 'steps', 'sleepSecs', 'sleepScore', 'sleepQuality', 'restingHR', 'hrv', 'hrvSDNN', 'spO2',
  'weight', 'avgSleepingHR', 'stress', 'kcalConsumed', 'readiness',
];

const pick = (obj, fields) => {
  const out = {};
  for (const f of fields) if (obj[f] != null) out[f] = obj[f];
  return out;
};

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function checkRange(oldest, newest) {
  if (!isDate(oldest) || !isDate(newest)) throw new IntervalsError(400, 'oldest and newest must be YYYY-MM-DD dates');
  if (oldest > newest) throw new IntervalsError(400, 'oldest must not be after newest');
}

export async function listActivities(env, { oldest, newest, limit = 200 }, fetchImpl) {
  checkRange(oldest, newest);
  const athlete = env.INTERVALS_ATHLETE_ID || '0';
  const list = await get(env, `/athlete/${encodeURIComponent(athlete)}/activities`, { oldest, newest }, fetchImpl);
  const items = (Array.isArray(list) ? list : []).map((a) => pick(a, ACTIVITY_FIELDS));
  items.sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));
  const n = Math.max(1, Math.min(500, Number(limit) || 200));
  return { oldest, newest, total: items.length, activities: items.slice(0, n) };
}

export async function getWellness(env, { oldest, newest }, fetchImpl) {
  checkRange(oldest, newest);
  const athlete = env.INTERVALS_ATHLETE_ID || '0';
  const list = await get(env, `/athlete/${encodeURIComponent(athlete)}/wellness`, { oldest, newest }, fetchImpl);
  return { oldest, newest, days: (Array.isArray(list) ? list : []).map((w) => pick(w, WELLNESS_FIELDS)) };
}

const STREAM_TYPES = ['time', 'latlng', 'heartrate', 'altitude', 'velocity_smooth', 'cadence', 'distance'];

/** Normalise the streams response (array of {type, data, data2?} or an object of arrays). */
export function normaliseStreams(raw) {
  const out = {};
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (!s || !STREAM_TYPES.includes(s.type)) continue;
      if (s.type === 'latlng') {
        if (Array.isArray(s.data2)) out.latlng = s.data.map((lat, i) => [lat, s.data2[i]]);
        else out.latlng = s.data;
      } else out[s.type] = s.data;
    }
  } else if (raw && typeof raw === 'object') {
    for (const t of STREAM_TYPES) if (Array.isArray(raw[t])) out[t] = raw[t];
  }
  return out;
}

/** Keep every k-th sample so the longest stream has at most maxPoints. */
export function downsampleStreams(streams, maxPoints) {
  const len = Math.max(0, ...Object.values(streams).map((a) => (Array.isArray(a) ? a.length : 0)));
  if (len <= maxPoints) return { ...streams, step: 1 };
  const step = Math.ceil(len / maxPoints);
  const out = { step };
  for (const [k, arr] of Object.entries(streams)) {
    if (!Array.isArray(arr)) continue;
    out[k] = arr.filter((_, i) => i % step === 0);
  }
  return out;
}

export async function getActivityStreams(env, { id, max_points = 2000 }, fetchImpl) {
  if (!id || !/^[A-Za-z0-9_-]+$/.test(String(id))) throw new IntervalsError(400, 'id must be an intervals.icu activity id');
  const raw = await get(env, `/activity/${encodeURIComponent(String(id))}/streams`, { types: STREAM_TYPES.join(',') }, fetchImpl);
  const streams = downsampleStreams(normaliseStreams(raw), Math.max(100, Math.min(5000, Number(max_points) || 2000)));
  return { id: String(id), ...streams };
}
