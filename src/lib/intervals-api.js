// intervals.icu read straight from the app with the user's own API key
// (Settings → Developer on intervals.icu; Basic auth "API_KEY:<key>").
// Huawei Health syncs to intervals.icu natively, so this brings new workouts
// with GPS and heart rate, plus daily wellness, without any bridge.
// `http(url, {headers})` resolves {status, data} (native HTTP in the app).

import { analyzeActivity, fragmentFromWellness } from './intervals.js';
import { normaliseStreams, downsampleStreams } from '../../bridge/src/intervals.js';

const BASE = 'https://intervals.icu/api/v1';
const STREAM_TYPES = ['time', 'latlng', 'heartrate', 'altitude', 'velocity_smooth', 'cadence', 'distance'];
/** Activities per sync whose streams (GPS, heart rate) are downloaded. */
export const MAX_STREAMS = 40;

export class IntervalsApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.code = status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limited' : 'http';
  }
}

export function authHeader(apiKey) {
  return `Basic ${btoa(`API_KEY:${String(apiKey).trim()}`)}`;
}

async function get(http, apiKey, path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const res = await http(url.toString(), { headers: { Authorization: authHeader(apiKey), Accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300) {
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
    throw new IntervalsApiError(res.status, `intervals.icu answered ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  return typeof res.data === 'string' ? JSON.parse(res.data || 'null') : res.data;
}

/**
 * Activities, wellness and the newest activities' streams for [oldest, newest].
 * `known` lists workout ids already stored with a track: their streams are not fetched again.
 * @returns {{fragment, report: {activities, withStreams, wellnessDays}}}
 */
export async function syncIntervals({ http, apiKey, athleteId = '0', oldest, newest, known = new Set(), onProgress = () => {} }) {
  const athlete = encodeURIComponent(String(athleteId || '0').trim() || '0');
  onProgress({ phase: 'list', done: 0, total: 0 });
  const [activities, wellness] = await Promise.all([
    get(http, apiKey, `/athlete/${athlete}/activities`, { oldest, newest }),
    get(http, apiKey, `/athlete/${athlete}/wellness`, { oldest, newest }),
  ]);
  const list = (Array.isArray(activities) ? activities : []).filter((a) => a && a.id != null && a.start_date);
  list.sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));
  const { days, nights } = fragmentFromWellness(Array.isArray(wellness) ? wellness : []);
  const fragment = { days, nights, workouts: {}, tracks: {} };
  const wantStreams = list.filter((a) => !known.has(`iv-${a.id}`)).slice(0, MAX_STREAMS);
  let done = 0, withStreams = 0;
  for (const a of list) {
    let streams = null;
    if (wantStreams.includes(a)) {
      onProgress({ phase: 'streams', done: done++, total: wantStreams.length });
      try {
        const raw = await get(http, apiKey, `/activity/${encodeURIComponent(String(a.id))}/streams`, { types: STREAM_TYPES.join(',') });
        streams = downsampleStreams(normaliseStreams(raw), 5000);
      } catch (e) {
        if (e.code === 'auth') throw e;
        streams = null; // summary only; the next sync tries again
      }
    }
    const res = analyzeActivity(a, streams);
    if (!res) continue;
    fragment.workouts[res.workout.id] = res.workout;
    if (res.track) {
      fragment.tracks[res.workout.id] = res.track;
      withStreams++;
    }
  }
  return { fragment, report: { activities: list.length, withStreams, wellnessDays: Object.keys(days).length } };
}
