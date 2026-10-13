// Workouts from "Motion path detail data" files.
//
// Each record is a workout. Two layouts exist:
// - up to 2025: summary fields at the top level (sportType, totalDistance, …)
//   plus one `attribute` string
//     HW_EXT_TRACK_DETAIL@is<lines>&&HW_EXT_TRACK_SIMPLIFY@is<summary JSON>
// - 2026 exports: {type: 30001, subType, startTime, endTime, timeZone, recordId,
//   detailData: <lines>, summaryData: <summary JSON string>} — the summary JSON
//   now carries sportType, totalDistance, totalTime, totalCalories, totalSteps.
// Detail lines look like `tp=lbs;k=1;lat=..;lon=..;alt=..;t=..;` and are
// separated by newlines. See docs/huawei-export-format.md for every tag.

import { parseLenient } from '../json-stream.js';
import { tzOffsetMinutes, localDateKey, localMidnight } from '../format.js';
import { sportFromCodes } from './sport-types.js';
import { emptySeries, analyzeSeries } from '../track.js';

const DETAIL = 'HW_EXT_TRACK_DETAIL@is';
const SIMPLIFY = 'HW_EXT_TRACK_SIMPLIFY@is';

// Sentinels for unset altitude extremes.
const isUnsetAlt = (v) => v == null || !Number.isFinite(v) || Math.abs(v) < 1e-30 || Math.abs(v) > 1e30;

/** Summary JSON (a string, possibly with bare numeric keys, or an object) → object or null. */
function summaryOf(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const v = parseLenient(raw.trim());
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** Split an attribute string into the detail text and the summary text. */
export function splitAttribute(attr) {
  if (typeof attr !== 'string' || !attr) return { detail: '', summary: '' };
  const s = attr.indexOf(SIMPLIFY);
  const d = attr.indexOf(DETAIL);
  let detail = '';
  let summary = '';
  if (d >= 0) detail = attr.slice(d + DETAIL.length, s > d ? s : undefined);
  if (s >= 0) summary = attr.slice(s + SIMPLIFY.length);
  detail = detail.replace(/&&$/, '');
  return { detail, summary };
}

/**
 * Normalise a timestamp from the detail lines to epoch ms.
 * Handles 13-digit ms, 10-digit s, scientific notation ("1.735682083E9") and
 * the seconds-of-local-day used by 2020–21 exports.
 */
export function normTime(raw, startMs, offsetMin) {
  if (raw == null || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v > 1e12) return Math.round(v);
  if (v > 1e9) return Math.round(v * 1000);
  if (v < 172800 && startMs) {
    const mid = localMidnight(startMs, offsetMin);
    let ms = mid + Math.round(v * 1000);
    if (ms < startMs - 3 * 3600000) ms += 86400000;
    return ms;
  }
  return null;
}

function fields(line) {
  const out = {};
  for (const part of line.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Decode a paceMap / p-m key: km×1e7 + point index. */
export function decodePaceKey(key) {
  const k = Number(key);
  if (!Number.isFinite(k)) return null;
  return { km: Math.floor(k / 100000) / 100, point: k % 100000 };
}

/**
 * Parse detail lines into full-resolution series.
 * @returns {{series: object, tags: Record<string, number>, partials: object}}
 */
export function parseDetail(detail, startMs, offsetMin) {
  const series = emptySeries();
  const tags = {};
  const pauses = []; // times (or indexes) of pause markers
  let seg = 0;
  let rawGps = [];
  const lines = detail.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const f = fields(line);
    const tp = f.tp;
    if (!tp) continue;
    tags[tp] = (tags[tp] || 0) + 1;
    switch (tp) {
      case 'lbs': {
        const lat = Number(f.lat), lon = Number(f.lon);
        const t = normTime(f.t, startMs, offsetMin);
        if (lat === 90 && lon === -80) {
          // pause / stop marker
          pauses.push({ index: rawGps.length, t });
          seg++;
          break;
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) break;
        if (lat === 0 && lon === 0) break;
        const alt = Number(f.alt);
        rawGps.push({ k: Number(f.k), t, lat, lon, alt: Number.isFinite(alt) && alt !== 0 ? alt : null, seg });
        break;
      }
      case 'h-r': {
        const t = normTime(f.k, startMs, offsetMin);
        const v = Number(f.v);
        if (t && v >= 1 && v <= 254) series.hr.push({ t, v });
        break;
      }
      case 's-r': {
        const t = normTime(f.k, startMs, offsetMin);
        const v = Number(f.v);
        if (t && v > 0 && v < 400) series.cad.push({ t, v });
        break;
      }
      case 'cad': {
        const t = normTime(f.k, startMs, offsetMin);
        const v = Number(f.v);
        if (t && v > 0 && v < 300) series.cad.push({ t, v });
        break;
      }
      case 'alt':
      case 'alti': {
        const t = normTime(f.k, startMs, offsetMin);
        const v = Number(f.v);
        if (t && Number.isFinite(v) && v > -500 && v < 9000) series.alt.push({ t, v });
        break;
      }
      case 'rs': {
        const k = Number(f.k), v = Number(f.v);
        if (Number.isFinite(k) && v >= 0) series.speed.push({ t: startMs + k * 1000, v: v / 10 });
        break;
      }
      default:
        break;
    }
  }

  // Order GPS points by time when the file mixes them up; assign times to
  // points without one by spreading them between their neighbours.
  const withT = rawGps.filter((p) => p.t);
  if (rawGps.length && withT.length < rawGps.length * 0.5) {
    // Mostly untimed: ignore stray times; fillGpsTimes spreads points over the workout.
    for (const p of rawGps) p.t = null;
  } else {
    let monotonic = true;
    for (let i = 1; i < withT.length; i++) if (withT[i].t < withT[i - 1].t) { monotonic = false; break; }
    if (!monotonic) {
      const breaks = pauses.map((p) => p.t).filter(Boolean).sort((a, b) => a - b);
      rawGps = withT.sort((a, b) => a.t - b.t);
      if (breaks.length) {
        let bi = 0;
        for (const p of rawGps) {
          while (bi < breaks.length && breaks[bi] <= p.t) bi++;
          p.seg = bi;
        }
      }
    }
  }
  series.gps = rawGps;
  return { series, tags };
}

/** Fill missing GPS times by interpolation (or spread over [start, end]). */
function fillGpsTimes(gps, startMs, endMs) {
  if (!gps.length) return gps;
  const timed = gps.filter((p) => p.t).length;
  if (timed === 0) {
    const span = Math.max(1, endMs - startMs);
    gps.forEach((p, i) => { p.t = Math.round(startMs + (span * i) / Math.max(1, gps.length - 1)); });
    return gps;
  }
  // interpolate gaps between timed neighbours
  let lastIdx = -1;
  for (let i = 0; i < gps.length; i++) {
    if (!gps[i].t) continue;
    if (lastIdx >= 0 && i - lastIdx > 1) {
      const a = gps[lastIdx].t, b = gps[i].t;
      for (let j = lastIdx + 1; j < i; j++) gps[j].t = Math.round(a + ((b - a) * (j - lastIdx)) / (i - lastIdx));
    } else if (lastIdx < 0 && i > 0) {
      for (let j = 0; j < i; j++) gps[j].t = gps[i].t - (i - j) * 1000;
    }
    lastIdx = i;
  }
  for (let j = lastIdx + 1; j < gps.length; j++) gps[j].t = gps[lastIdx].t + (j - lastIdx) * 1000;
  return gps;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function positive(v) {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

/** Cumulative device split seconds from a partTimeMap-like object. */
function partTimesFrom(map) {
  if (!map || typeof map !== 'object') return null;
  const entries = Object.entries(map)
    .map(([k, v]) => [Number(k), Number(v)])
    .filter(([k, v]) => Number.isFinite(k) && Number.isFinite(v) && Number.isInteger(k) && k >= 1)
    .sort((a, b) => a[0] - b[0]);
  if (!entries.length) return null;
  // must be 1, 2, 3, … and increasing
  for (let i = 0; i < entries.length; i++) {
    if (entries[i][0] !== i + 1) return null;
    if (i && entries[i][1] <= entries[i - 1][1]) return null;
  }
  return entries.map(([, v]) => v);
}

/**
 * Normalise one motion-path record.
 * @returns {{workout: object, track: object|null, tags: object, gpsCount: number}|null}
 */
export function normalizeMotionRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const start = num(rec.startTime);
  if (!start) return null;
  const end = num(rec.endTime) || start;
  const off = tzOffsetMinutes(rec.timeZone);
  const legacy = splitAttribute(rec.attribute);
  const detail = typeof rec.detailData === 'string' && rec.detailData ? rec.detailData : legacy.detail;
  const summary = summaryOf(rec.summaryData) ?? summaryOf(legacy.summary);
  // `subType` is "for service use only" per Huawei's field dictionary: the
  // sport comes from sportType (top level up to 2025, in the summary in 2026).
  const sport = sportFromCodes(rec.sportType ?? summary?.sportType, summary?.sportType);
  const durationMs = positive(rec.totalTime) ?? positive(summary?.totalTime);
  const workout = {
    id: 'hw-' + (rec.recordId || rec.dataId || start),
    source: 'export',
    sources: ['export'],
    sport: sport.key,
    label: sport.label,
    family: sport.family,
    code: sport.code,
    start,
    end,
    tz: off,
    date: localDateKey(start, off),
    duration: durationMs ? Math.round(durationMs / 1000) : Math.round((end - start) / 1000),
    elapsed: Math.round((end - start) / 1000),
    distance: positive(rec.totalDistance) ?? positive(summary?.totalDistance),
    kcal: (() => {
      const cal = positive(rec.totalCalories) ?? positive(summary?.totalCalories);
      return cal == null ? null : Math.round(cal / 100) / 10;
    })(),
    steps: positive(rec.totalSteps) ?? positive(summary?.totalSteps),
    avgHr: positive(summary?.avgHeartRate),
    maxHr: positive(summary?.maxHeartRate),
    minHr: positive(summary?.minHeartRate),
    avgPace: positive(summary?.avgPace),
    bestPace: positive(summary?.bestPace),
    avgCadence: positive(summary?.avgStepRate),
    ascent: positive(summary?.creepingWave) != null ? Math.round(summary.creepingWave) / 10 : null,
    descent: positive(summary?.mTotalDescent) != null ? Math.round(summary.mTotalDescent) / 10 : null,
    maxAlt: isUnsetAlt(num(summary?.mMaxAlti)) ? null : num(summary.mMaxAlti),
    minAlt: isUnsetAlt(num(summary?.mMinAlti)) ? null : num(summary.mMinAlti),
  };
  if (rec.abnormalTrack && Number(rec.abnormalTrack) !== 0) workout.abnormal = Number(rec.abnormalTrack);
  const wear = summary?.wearSportData;
  if (wear && typeof wear === 'object') {
    workout.device = {};
    for (const k of ['etraining_effect', 'recovery_time', 'load_peak', 'max_met']) {
      if (wear[k] != null && Number.isFinite(Number(wear[k]))) workout.device[k] = Number(wear[k]);
    }
    if (!Object.keys(workout.device).length) delete workout.device;
  }
  if (Array.isArray(summary?.mSwimSegments) && summary.mSwimSegments.length) {
    workout.swim = {
      laps: summary.mSwimSegments.length,
      poolCm: num(wear?.swim_pool_length),
      swolf: Math.round(
        summary.mSwimSegments.reduce((s, x) => s + (Number(x.mSwolf) || 0), 0) / summary.mSwimSegments.length,
      ) || null,
    };
  }
  if (workout.avgPace == null && workout.distance > 0 && workout.duration > 0 && workout.family !== 'swim') {
    workout.avgPace = Math.round(workout.duration / (workout.distance / 1000));
  }
  if (workout.distance > 0 && workout.duration > 0) workout.avgSpeed = Math.round((workout.distance / workout.duration) * 100) / 100;

  const { series, tags } = detail ? parseDetail(detail, start, off) : { series: emptySeries(), tags: {} };
  fillGpsTimes(series.gps, start, end);
  const partTimes = partTimesFrom(summary?.partTimeMap ?? rec.partTimeMap);
  const { summary: derived, track } = analyzeSeries(workout, series, { partTimes });
  for (const [k, v] of Object.entries(derived)) {
    if (v != null && (workout[k] == null || k === 'hasTrack' || k === 'gpsPoints')) workout[k] = v;
  }
  for (const k of Object.keys(workout)) if (workout[k] == null) delete workout[k];
  if (track) track.id = workout.id;
  return { workout, track, tags, gpsCount: series.gps.length, recordId: rec.recordId || null };
}

/** Flatten the pre-2020 `[{recordDay, motionPathData:[…]}]` shape. */
export function motionRecords(value) {
  if (value && Array.isArray(value.motionPathData)) return value.motionPathData;
  return [value];
}
