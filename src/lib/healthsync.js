// Health Sync → Google Drive files.
//
// Health Sync writes activity files (GPX/TCX/FIT, plus a CSV summary) and
// daily health CSVs to a Drive folder. Activity files are standard formats;
// the CSV column names are matched by synonyms because the exact layout is
// confirmed against the user's real files (Phase B, see docs/setup-health-sync.md).

import { parseGpx, parseTcx, workoutFromFile } from './gpx.js';
import { analyzeSeries } from './track.js';
import { csvObjects } from './csv.js';
import { localDateKey, fallbackOffset } from './format.js';

/** Parse one activity file → {workout, track} or null. */
export function parseActivityFile(name, text, fileId) {
  const lower = name.toLowerCase();
  let parsed, kind;
  if (lower.endsWith('.gpx')) { parsed = parseGpx(text); kind = 'gpx'; }
  else if (lower.endsWith('.tcx')) { parsed = parseTcx(text); kind = 'tcx'; }
  else return null;
  if (!parsed.start) return null;
  const w = workoutFromFile(parsed, { kind, source: 'healthsync', fileId: fileId || name });
  w.tz = fallbackOffset(w.start);
  w.date = localDateKey(w.start, w.tz);
  const { summary, track } = analyzeSeries(w, parsed.series);
  for (const [k, v] of Object.entries(summary)) if (v != null && (w[k] == null || k === 'hasTrack')) w[k] = v;
  if (w.distance > 0 && w.duration > 0) {
    w.avgSpeed = Math.round((w.distance / w.duration) * 100) / 100;
    if (w.family !== 'ride' && w.family !== 'swim') w.avgPace = Math.round(w.duration / (w.distance / 1000));
  }
  if (track) track.id = w.id;
  return { workout: w, track };
}

const SYNONYMS = {
  date: ['date', 'day', 'datum', 'start date', 'start', 'time', 'timestamp'],
  steps: ['steps', 'step count', 'total steps', 'stappen'],
  distance: ['distance', 'distance (m)', 'distance m', 'distance (km)', 'distance km'],
  kcal: ['calories', 'active calories', 'kcal', 'calories (kcal)', 'energy'],
  restHr: ['resting heart rate', 'resting hr', 'rest hr', 'restinghr'],
  hrAvg: ['average heart rate', 'avg heart rate', 'heart rate', 'hr avg', 'bpm'],
  hrMin: ['min heart rate', 'minimum heart rate', 'hr min'],
  hrMax: ['max heart rate', 'maximum heart rate', 'hr max'],
  spo2Avg: ['spo2', 'oxygen saturation', 'blood oxygen'],
  stressAvg: ['stress', 'stress level'],
  sleepTotal: ['sleep', 'sleep duration', 'total sleep', 'asleep', 'sleep (min)', 'sleep minutes'],
  sleepDeep: ['deep sleep', 'deep'],
  sleepLight: ['light sleep', 'light'],
  sleepRem: ['rem sleep', 'rem'],
  sleepAwake: ['awake', 'awake time'],
  weight: ['weight', 'weight (kg)'],
};

function columnMap(header) {
  const norm = (s) => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  const map = {};
  for (const [field, names] of Object.entries(SYNONYMS)) {
    const hit = header.find((h) => names.includes(norm(h)));
    if (hit) map[field] = hit;
  }
  return map;
}

function toNumber(s) {
  if (s == null || s === '') return null;
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function toDateKey(s) {
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const eu = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(s);
  if (eu) return `${eu[3]}-${eu[2].padStart(2, '0')}-${eu[1].padStart(2, '0')}`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? localDateKey(t, null) : null;
}

/** Duration-ish cell → minutes ("7:32", "452", "27120 s"). */
function toMinutes(s, header) {
  if (s == null || s === '') return null;
  const hm = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]) + (hm[3] ? Number(hm[3]) / 60 : 0);
  const n = toNumber(s);
  if (n == null) return null;
  if (/\(s\)|seconds|secs/i.test(header)) return n / 60;
  if (/\(h\)|hours/i.test(header)) return n * 60;
  return n > 1440 ? n / 60 : n; // seconds if implausibly large for minutes
}

/**
 * Parse a daily-metrics CSV → {days: {date → row}, nights: {date → night}, columns}.
 * Rows sharing a date are combined (sum for steps, mean for rates).
 */
export function parseDailyCsv(text) {
  const { header, records } = csvObjects(text);
  const cols = columnMap(header);
  const days = {}, nights = {};
  if (!cols.date) return { days, nights, columns: cols, header };
  const acc = {};
  for (const r of records) {
    const date = toDateKey(r[cols.date]);
    if (!date) continue;
    const a = (acc[date] ||= { steps: 0, stepsSeen: false, rates: {} });
    if (cols.steps) {
      const v = toNumber(r[cols.steps]);
      if (v != null) { a.steps += v; a.stepsSeen = true; }
    }
    for (const f of ['distance', 'kcal']) {
      if (!cols[f]) continue;
      let v = toNumber(r[cols[f]]);
      if (v == null) continue;
      if (f === 'distance' && /km/i.test(cols[f])) v *= 1000;
      a[f] = (a[f] || 0) + v;
    }
    for (const f of ['restHr', 'hrAvg', 'hrMin', 'hrMax', 'spo2Avg', 'stressAvg', 'weight']) {
      if (!cols[f]) continue;
      const v = toNumber(r[cols[f]]);
      if (v == null) continue;
      (a.rates[f] ||= []).push(v);
    }
    for (const f of ['sleepTotal', 'sleepDeep', 'sleepLight', 'sleepRem', 'sleepAwake']) {
      if (!cols[f]) continue;
      const v = toMinutes(r[cols[f]], cols[f]);
      if (v != null) a[f] = (a[f] || 0) + v;
    }
  }
  for (const [date, a] of Object.entries(acc)) {
    const row = {};
    if (a.stepsSeen) row.steps = Math.round(a.steps);
    if (a.distance != null) row.distance = Math.round(a.distance);
    if (a.kcal != null) row.kcal = Math.round(a.kcal);
    for (const [f, list] of Object.entries(a.rates)) {
      const m = list.reduce((s, x) => s + x, 0) / list.length;
      row[f] = f === 'hrMin' ? Math.min(...list) : f === 'hrMax' ? Math.max(...list) : Math.round(m * 10) / 10;
    }
    if (Object.keys(row).length) days[date] = row;
    if (a.sleepTotal != null || a.sleepDeep != null) {
      const total = a.sleepTotal ?? (a.sleepDeep || 0) + (a.sleepLight || 0) + (a.sleepRem || 0);
      nights[date] = {
        date,
        total: Math.round(total),
        ...(a.sleepDeep != null ? { deep: Math.round(a.sleepDeep) } : {}),
        ...(a.sleepLight != null ? { light: Math.round(a.sleepLight) } : {}),
        ...(a.sleepRem != null ? { rem: Math.round(a.sleepRem) } : {}),
        ...(a.sleepAwake != null ? { awake: Math.round(a.sleepAwake) } : {}),
      };
    }
  }
  return { days, nights, columns: cols, header };
}
