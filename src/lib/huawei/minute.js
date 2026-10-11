// Daily steps, distance and calories from "Sport per minute merged data".
//
// [{recordDay: 20250226, timeZone, sportDataUserData: [
//    {startTime, endTime, sportType, deviceCode,
//     sportBasicInfos: [{steps, distance (m), calorie (cal), floor, …}]}]}]
// Minutes are deduplicated by start time (keeping the larger step count) in
// case a phone and the watch both reported the same minute.

import { tzOffsetMinutes, recordDayKey, localDateKey, localHour } from '../format.js';

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
};

export function createMinuteAccumulator() {
  const days = new Map();
  let records = 0;

  function add(rec) {
    if (!rec || typeof rec !== 'object') return;
    records++;
    const off = tzOffsetMinutes(rec.timeZone);
    const entries = Array.isArray(rec.sportDataUserData) ? rec.sportDataUserData : [];
    if (!entries.length) return;
    const minutes = new Map();
    for (const e of entries) {
      const start = Number(e.startTime);
      if (!Number.isFinite(start) || start <= 0) continue;
      let steps = 0, dist = 0, cal = 0, floors = 0;
      for (const b of Array.isArray(e.sportBasicInfos) ? e.sportBasicInfos : []) {
        steps += n(b.steps);
        dist += n(b.distance);
        cal += n(b.calorie);
        floors += n(b.floor);
      }
      const prev = minutes.get(start);
      if (prev && prev.steps >= steps && prev.dist >= dist) continue;
      minutes.set(start, { start, steps, dist, cal, floors });
    }
    if (!minutes.size) return;
    // Calorie unit: per-minute values above ~40 can only be small calories.
    let maxCal = 0;
    for (const m of minutes.values()) if (m.cal > maxCal) maxCal = m.cal;
    const calDiv = maxCal > 40 ? 1000 : 1;
    const first = minutes.values().next().value.start;
    const dk = recordDayKey(rec.recordDay) || localDateKey(first, off);
    let d = days.get(dk);
    if (!d) {
      d = { steps: 0, distance: 0, kcal: 0, floors: 0, activeMin: 0, stepsHourly: new Array(24).fill(0) };
      days.set(dk, d);
    }
    for (const m of minutes.values()) {
      d.steps += m.steps;
      d.distance += m.dist;
      d.kcal += m.cal / calDiv;
      d.floors += m.floors;
      if (m.steps >= 60) d.activeMin++;
      d.stepsHourly[localHour(m.start, off)] += m.steps;
    }
  }

  function finish() {
    const out = {};
    for (const [dk, d] of days) {
      out[dk] = {
        steps: Math.round(d.steps),
        distance: Math.round(d.distance),
        kcal: Math.round(d.kcal),
        floors: Math.round(d.floors),
        activeMin: d.activeMin,
        stepsHourly: d.stepsHourly.map(Math.round),
      };
    }
    return { days: out, records };
  }

  return { add, finish };
}
