// Sleep nights from stage spans (health detail type 9 / 3), on/off-bed records
// (500010) and nightly summaries (sample sequence type 700013).
//
// A night is keyed by its wake-up date. Main-sleep spans belong to the night
// whose key is the local date of (start + 12 h); naps (NOON) belong to the day
// they happen on.

import { tzOffsetMinutes, localDateKey } from '../format.js';

const STAGE_CODES = { deep: 1, light: 2, rem: 3, awake: 4 };
const NA = new Set([255, 65535, -1]);

function valid(v) {
  const n = Number(v);
  return Number.isFinite(n) && !NA.has(n) ? n : null;
}

/** Fields of a 700013 sample-sequence record's summaryData (times in epoch seconds). */
export function parseSleepSummary(rec) {
  if (!rec || Number(rec.type) !== 700013) return null;
  let s = rec.summaryData;
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!s || typeof s !== 'object') return null;
  const toMs = (v) => {
    const n = valid(v);
    if (!n || n <= 0) return null;
    return n > 1e12 ? n : n * 1000;
  };
  const off = tzOffsetMinutes(rec.timeZone);
  const out = {
    bed: toMs(s.bedTime),
    asleep: toMs(s.fallAsleepTime),
    wake: toMs(s.wakeupTime),
    rise: toMs(s.risingTime),
    score: valid(s.sleepScore),
    efficiency: valid(s.sleepEfficiency),
    latency: valid(s.sleepLatency),
    wakeCount: valid(s.wakeCount),
    deepPart: valid(s.deepPart),
    minHr: valid(s.minHeartrate),
    maxHr: valid(s.maxHeartrate),
    minSpo2: valid(s.minOxygenSaturation),
    maxSpo2: valid(s.maxOxygenSaturation),
    avgHrv: valid(s.avgHrv),
    tz: off,
    keys: Object.keys(s),
  };
  const end = out.wake ?? out.rise ?? Number(rec.endTime) ?? null;
  if (!end) return null;
  out.date = localDateKey(end, off);
  return out;
}

/**
 * Build nights from spans, bed records and summaries.
 * @returns {{nights: Record<string, object>, naps: Record<string, number>}}
 */
export function buildNights({ spans = [], bedRecords = [], summaries = [] }) {
  const groups = new Map();
  const naps = {};
  for (const sp of spans) {
    if (sp.stage === 'nap') {
      const dk = localDateKey(sp.start, sp.tz);
      naps[dk] = (naps[dk] || 0) + Math.round((sp.end - sp.start) / 60000);
      continue;
    }
    const key = localDateKey(sp.start + 12 * 3600000, sp.tz);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sp);
  }

  const nights = {};
  for (const [key, list] of groups) {
    list.sort((a, b) => a.start - b.start);
    const start = list[0].start;
    const end = Math.max(...list.map((s) => s.end));
    const mins = { deep: 0, light: 0, rem: 0, awake: 0 };
    const stages = [];
    for (const s of list) {
      const dur = (s.end - s.start) / 60000;
      mins[s.stage] += dur;
      stages.push([Math.round((s.start - start) / 60000), Math.max(1, Math.round(dur)), STAGE_CODES[s.stage]]);
    }
    const total = mins.deep + mins.light + mins.rem;
    if (total < 30) continue; // fragments, not a night
    nights[key] = {
      date: key,
      start,
      end,
      tz: list[0].tz,
      total: Math.round(total),
      deep: Math.round(mins.deep),
      light: Math.round(mins.light),
      rem: Math.round(mins.rem),
      awake: Math.round(mins.awake),
      stages,
    };
  }

  for (const b of bedRecords) {
    const key = localDateKey(b.rise, b.tz);
    const n = nights[key];
    if (n) {
      n.bed = b.bed;
      n.rise = b.rise;
    }
  }

  for (const s of summaries) {
    if (!s?.date) continue;
    const n = nights[s.date] || (nights[s.date] = { date: s.date, tz: s.tz });
    n.bed ??= s.bed ?? undefined;
    n.rise ??= s.rise ?? undefined;
    if (!n.start && (s.asleep || s.bed)) n.start = s.asleep ?? s.bed;
    if (!n.end && (s.wake || s.rise)) n.end = s.wake ?? s.rise;
    if (n.total == null && s.asleep && s.wake && s.wake > s.asleep) {
      n.total = Math.round((s.wake - s.asleep) / 60000);
    }
    for (const k of ['score', 'efficiency', 'latency', 'wakeCount', 'deepPart', 'minHr', 'maxHr', 'minSpo2', 'maxSpo2', 'avgHrv']) {
      if (s[k] != null && n[k] == null) n[k] = s[k];
    }
  }

  for (const n of Object.values(nights)) {
    for (const k of Object.keys(n)) if (n[k] == null) delete n[k];
    if (n.total == null || n.total < 30 || n.total > 16 * 60) delete nights[n.date];
  }
  return { nights, naps };
}

export { STAGE_CODES };
