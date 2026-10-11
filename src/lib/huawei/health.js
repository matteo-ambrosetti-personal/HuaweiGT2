// Daily health metrics from "Health detail data" files.
//
// Records: {type, timeZone, startTime, endTime, samplePoints:[{key, value, startTime, endTime}]}
// Legacy keys hold numeric strings ("83.0"); newer 5000xx keys hold JSON
// strings ('{"bpm":83}'). Heart rate and stress are exported twice (legacy and
// new type codes), so each day keeps one aggregate per type and the fuller one
// wins at the end. Sleep stages arrive as spans and are deduplicated.

import { tzOffsetMinutes, localDateKey, localHour } from '../format.js';

const HR_KEYS = new Set(['DATA_POINT_DYNAMIC_HEARTRATE', 'DYNAMIC_HEART_RATE']);
const REST_KEYS = new Set(['DATA_POINT_NEW_REST_HEARTRATE', 'DATA_POINT_REST_HEARTRATE', 'RESTING_HEART_RATE']);
const SPO2_KEYS = new Set(['BLOOD_OXYGEN_SATURATION']);
const STRESS_KEYS = new Set(['STRESS_DATA', 'STRESS']);
const HRV_KEYS = new Set(['HEART_RATE_VARIABILITY']);
const GOAL_KEYS = new Set(['SPORT_GOAL_ACHIEVEMENT_DATA']);
const BED_KEYS = new Set(['SLEEP_ON_OFF_BED_RECORD']);
export const SLEEP_STAGE_KEYS = {
  PROFESSIONAL_SLEEP_SHALLOW: 'light',
  PROFESSIONAL_SLEEP_DEEP: 'deep',
  PROFESSIONAL_SLEEP_DREAM: 'rem',
  PROFESSIONAL_SLEEP_WAKE: 'awake',
  PROFESSIONAL_SLEEP_NOON: 'nap',
  SLEEP_LIGHT: 'light',
  SLEEP_DEEP: 'deep',
  SLEEP_AWAKE: 'awake',
};

const JSON_FIELDS = {
  DYNAMIC_HEART_RATE: ['bpm'],
  RESTING_HEART_RATE: ['restBpm', 'oldRestBpm'],
  BLOOD_OXYGEN_SATURATION: ['avgSaturation', 'spo2', 'saturation', 'value'],
  STRESS_DATA: ['score', 'stressScore'],
  STRESS: ['stressScore', 'score'],
  HEART_RATE_VARIABILITY: ['heartRateVariabilityRMSSD', 'rmssd'],
};

/** Parse a sample point value: number, numeric string or JSON-object string. */
export function pointValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  if (!s) return null;
  if (s[0] === '{') {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Numeric reading for a key from a parsed value. */
export function numericFor(key, value) {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return null;
  for (const f of JSON_FIELDS[key] || []) {
    const n = Number(value[f]);
    if (Number.isFinite(n)) return n;
  }
  // a single numeric field
  const nums = Object.values(value).map(Number).filter(Number.isFinite);
  return nums.length === 1 ? nums[0] : null;
}

function agg() {
  return { min: Infinity, max: -Infinity, sum: 0, n: 0 };
}

function addAgg(a, v) {
  if (v < a.min) a.min = v;
  if (v > a.max) a.max = v;
  a.sum += v;
  a.n++;
}

export function createHealthAccumulator() {
  const days = new Map();
  const spans = new Map(); // "stage|start|end" → span
  const bedRecords = [];
  const diag = { types: {}, keys: {}, unknownKeys: {} };

  function day(key) {
    let d = days.get(key);
    if (!d) {
      d = { hr: {}, rest: {}, spo2: {}, stress: {}, hrv: agg(), goal: null };
      days.set(key, d);
    }
    return d;
  }

  function add(rec) {
    if (!rec || typeof rec !== 'object') return;
    const type = Number(rec.type);
    diag.types[type] = (diag.types[type] || 0) + 1;
    const off = tzOffsetMinutes(rec.timeZone);
    const points = Array.isArray(rec.samplePoints) ? rec.samplePoints : [];
    for (const sp of points) {
      const key = sp.key;
      if (!key) continue;
      diag.keys[key] = (diag.keys[key] || 0) + 1;
      const t = Number(sp.startTime ?? rec.startTime);
      const tEnd = Number(sp.endTime ?? rec.endTime ?? t);
      if (!Number.isFinite(t) || t <= 0) continue;

      if (SLEEP_STAGE_KEYS[key]) {
        const stage = SLEEP_STAGE_KEYS[key];
        if (!(tEnd > t)) continue;
        const id = `${stage}|${t}|${tEnd}`;
        if (!spans.has(id)) spans.set(id, { stage, start: t, end: tEnd, tz: off });
        continue;
      }
      if (BED_KEYS.has(key)) {
        const v = pointValue(sp.value);
        if (v && typeof v === 'object') {
          const bed = Number(v.bedTime), rise = Number(v.risingTime);
          if (bed > 0 && rise > bed) bedRecords.push({ bed, rise, tz: off });
        }
        continue;
      }

      const dk = localDateKey(t, off);
      const value = pointValue(sp.value);

      if (HR_KEYS.has(key)) {
        const v = numericFor(key, value);
        if (v == null || v < 25 || v > 230) continue;
        const d = day(dk);
        const a = (d.hr[type] ||= { ...agg(), hourSum: new Array(24).fill(0), hourN: new Array(24).fill(0) });
        addAgg(a, v);
        const h = localHour(t, off);
        a.hourSum[h] += v;
        a.hourN[h]++;
      } else if (REST_KEYS.has(key)) {
        const v = numericFor(key, value);
        if (v == null || v < 25 || v > 130) continue;
        const d = day(dk);
        const prev = d.rest[type];
        if (!prev || t >= prev.t) d.rest[type] = { t, v };
      } else if (SPO2_KEYS.has(key)) {
        const v = numericFor(key, value);
        if (v == null || v < 70 || v > 100) continue;
        addAgg((day(dk).spo2[type] ||= agg()), v);
      } else if (STRESS_KEYS.has(key)) {
        const v = numericFor(key, value);
        if (v == null || v < 1 || v > 100) continue;
        addAgg((day(dk).stress[type] ||= agg()), v);
      } else if (HRV_KEYS.has(key)) {
        const v = numericFor(key, value);
        if (v == null || v <= 0 || v > 300) continue;
        addAgg(day(dk).hrv, v);
      } else if (GOAL_KEYS.has(key)) {
        if (value && typeof value === 'object') {
          const steps = Number(value.stepUserValue);
          const cal = Number(value.calorieUserValue);
          const d = day(dk);
          d.goal = {
            steps: Number.isFinite(steps) && steps >= 0 ? Math.max(steps, d.goal?.steps ?? 0) : d.goal?.steps ?? null,
            kcal: Number.isFinite(cal) && cal >= 0 ? Math.max(cal / 1000, d.goal?.kcal ?? 0) : d.goal?.kcal ?? null,
          };
        }
      } else {
        diag.unknownKeys[key] = (diag.unknownKeys[key] || 0) + 1;
      }
    }
  }

  // Pick the aggregate with the most samples among duplicate type codes.
  function fullest(map) {
    let best = null;
    for (const a of Object.values(map)) if (!best || a.n > best.n) best = a;
    return best && best.n > 0 ? best : null;
  }

  /** @returns {{days: Record<string, object>, spans: object[], bedRecords: object[], diag: object}} */
  function finish() {
    const out = {};
    for (const [dk, d] of days) {
      const row = {};
      const hr = fullest(d.hr);
      if (hr) {
        row.hrMin = Math.round(hr.min);
        row.hrMax = Math.round(hr.max);
        row.hrAvg = Math.round(hr.sum / hr.n);
        row.hrN = hr.n;
        row.hrHourly = hr.hourSum.map((s, i) => (hr.hourN[i] ? Math.round(s / hr.hourN[i]) : null));
      }
      const rests = Object.values(d.rest);
      if (rests.length) row.restHr = Math.round(rests.sort((a, b) => b.t - a.t)[0].v);
      const spo2 = fullest(d.spo2);
      if (spo2) {
        row.spo2Avg = Math.round((spo2.sum / spo2.n) * 10) / 10;
        row.spo2Min = Math.round(spo2.min);
      }
      const stress = fullest(d.stress);
      if (stress) {
        row.stressAvg = Math.round(stress.sum / stress.n);
        row.stressMax = Math.round(stress.max);
      }
      if (d.hrv.n) row.hrvAvg = Math.round(d.hrv.sum / d.hrv.n);
      if (d.goal) {
        if (d.goal.steps != null) row.goalSteps = Math.round(d.goal.steps);
        if (d.goal.kcal != null) row.goalKcal = Math.round(d.goal.kcal);
      }
      if (Object.keys(row).length) out[dk] = row;
    }
    return { days: out, spans: [...spans.values()], bedRecords, diag };
  }

  return { add, finish };
}
