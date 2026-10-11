// intervals.icu data (through the GT2 Bridge connector) → dataset fragments.
//
// Field names follow the intervals.icu API as passed through by the bridge:
// activities {id, start_date (UTC ISO), start_date_local, type, name, distance,
// moving_time, elapsed_time, total_elevation_gain, average_heartrate,
// max_heartrate, average_speed, average_cadence, calories, source},
// wellness {id (date), steps, sleepSecs, sleepScore, restingHR, hrv, spO2, weight},
// streams {time:[s], latlng:[[lat,lon]], heartrate, altitude, velocity_smooth, cadence}.

import { familyFromText, labelFromText } from './huawei/sport-types.js';
import { emptySeries, analyzeSeries } from './track.js';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Offset minutes from start_date (UTC) vs start_date_local (wall clock). */
function offsetFrom(a) {
  const utc = Date.parse(a.start_date);
  const local = Date.parse(String(a.start_date_local || '').replace(/Z$/, '') + 'Z');
  if (!Number.isFinite(utc) || !Number.isFinite(local)) return null;
  return Math.round((local - utc) / 60000);
}

export function workoutFromActivity(a) {
  const start = Date.parse(a.start_date ?? a.start_date_local);
  if (!Number.isFinite(start)) return null;
  const tz = offsetFrom(a);
  const elapsed = num(a.elapsed_time) ?? num(a.moving_time) ?? 0;
  const family = familyFromText(a.type);
  const w = {
    id: `iv-${a.id}`,
    source: 'intervals',
    sources: ['intervals'],
    sport: family,
    label: labelFromText(a.type),
    name: a.name || undefined,
    family,
    start,
    end: start + elapsed * 1000,
    tz,
    date: String(a.start_date_local || '').slice(0, 10) || new Date(start).toISOString().slice(0, 10),
    duration: num(a.moving_time) ?? elapsed,
    elapsed,
    distance: num(a.distance) || undefined,
    ascent: num(a.total_elevation_gain) || undefined,
    avgHr: num(a.average_heartrate) || undefined,
    maxHr: num(a.max_heartrate) || undefined,
    avgSpeed: num(a.average_speed) || undefined,
    avgCadence: num(a.average_cadence) || undefined,
    kcal: num(a.calories) || undefined,
    upstream: a.source || undefined,
  };
  if (w.distance > 0 && w.duration > 0 && family !== 'ride' && family !== 'swim') {
    w.avgPace = Math.round(w.duration / (w.distance / 1000));
  }
  for (const k of Object.keys(w)) if (w[k] == null) delete w[k];
  return w;
}

/** Streams → series aligned on activity start. */
export function seriesFromStreams(w, streams) {
  const s = emptySeries();
  const time = streams?.time || [];
  const at = (i) => w.start + (num(time[i]) ?? i) * 1000;
  (streams?.latlng || []).forEach((p, i) => {
    if (Array.isArray(p) && p.length >= 2 && num(p[0]) != null) {
      s.gps.push({ t: at(i), lat: num(p[0]), lon: num(p[1]), alt: num(streams?.altitude?.[i]), seg: 0 });
    }
  });
  (streams?.heartrate || []).forEach((v, i) => { if (num(v) > 0) s.hr.push({ t: at(i), v: num(v) }); });
  (streams?.cadence || []).forEach((v, i) => { if (num(v) > 0) s.cad.push({ t: at(i), v: num(v) }); });
  (streams?.altitude || []).forEach((v, i) => { if (num(v) != null) s.alt.push({ t: at(i), v: num(v) }); });
  (streams?.velocity_smooth || []).forEach((v, i) => { if (num(v) != null) s.speed.push({ t: at(i), v: num(v) }); });
  return s;
}

/** Workout + streams → {workout, track}. */
export function analyzeActivity(activity, streams) {
  const w = workoutFromActivity(activity);
  if (!w) return null;
  if (!streams) return { workout: w, track: null };
  const { summary, track } = analyzeSeries(w, seriesFromStreams(w, streams));
  for (const [k, v] of Object.entries(summary)) if (v != null && (w[k] == null || k === 'hasTrack')) w[k] = v;
  if (track) track.id = w.id;
  return { workout: w, track };
}

/** Wellness records → {days, nights} fragment. */
export function fragmentFromWellness(list) {
  const days = {}, nights = {};
  for (const r of list || []) {
    const date = String(r.id || r.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const row = {};
    if (num(r.steps) != null) row.steps = num(r.steps);
    if (num(r.restingHR) > 0) row.restHr = num(r.restingHR);
    if (num(r.hrv) > 0) row.hrvAvg = num(r.hrv);
    if (num(r.spO2) > 0) row.spo2Avg = num(r.spO2);
    if (num(r.weight) > 0) row.weight = num(r.weight);
    if (num(r.stress) > 0) row.stressAvg = num(r.stress);
    if (Object.keys(row).length) days[date] = row;
    if (num(r.sleepSecs) > 0) {
      nights[date] = {
        date,
        total: Math.round(num(r.sleepSecs) / 60),
        ...(num(r.sleepScore) > 0 ? { score: num(r.sleepScore) } : {}),
      };
    }
  }
  return { days, nights };
}
