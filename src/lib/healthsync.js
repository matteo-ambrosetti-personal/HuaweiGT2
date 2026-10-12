// Health Sync → Google Drive files.
//
// Health Sync writes one Drive folder per data type ("Health Sync Passi",
// "Health Sync Freq. cardiaca", … in the phone's language). Health data comes
// as per-minute CSVs (layout verified on real files, Oct 2026; values here are made up):
//   Data,Orario,Passi                       2026.03.07 08:00:00,08:00:00,40
//   Data,Orario,Frequenza cardiaca,Origine  2026.03.07 08:10:00,08:10:00,64,
//   Data,Orario,Saturazione di ossigeno     2026.03.07 03:00:00,03:00:00,97.0
// one row per non-empty minute, local wall-clock time, in daily files
// ("<type> YYYY.MM.DD Huawei Health.csv") and weekly history files
// ("<type> WW-YYYY Huawei Health.csv") that can cover the same day. The name
// ends with the data source: "… Health Connect.csv" files hold the same kind of
// data from Health Connect (interval records, other devices) and are never
// added to the watch's own.
// Activity files are standard GPX/TCX. Daily-summary CSVs are matched by
// column synonyms (parseDailyCsv).

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

// ------------------------------------------------------------ per-minute samples

const SAMPLE_DATE = ['data', 'date', 'datetime', 'date time', 'timestamp'];
const SAMPLE_TIME = ['orario', 'ora', 'time'];
/** Value column names (Italian as observed, English) → metric. */
export const SAMPLE_METRICS = {
  steps: ['passi', 'steps', 'step count'],
  hr: ['frequenza cardiaca', 'heart rate', 'bpm'],
  spo2: ['saturazione di ossigeno', 'oxygen saturation', 'blood oxygen', 'spo2'],
  kcal: ['calorie attive', 'active calories'],
};
export const SAMPLE_LABELS = { steps: 'steps', hr: 'heart rate', spo2: 'SpO2', kcal: 'calories' };
/** A day-row field each metric always sets, to tell which metrics a fragment holds. */
export const SAMPLE_FIELDS = { steps: 'steps', hr: 'hrAvg', spo2: 'spo2Avg', kcal: 'kcal' };

/** The data source a Health Sync file name ends with: "Passi 2026.10.11 Health Connect.csv" → "Health Connect". */
export function sourceFromTitle(title) {
  const m = /(?:\d{4}\.\d{1,2}\.\d{1,2}|\d{1,2}-\d{4})\s+(.+?)\.[a-z0-9]+$/i.exec(String(title || ''));
  return m ? m[1].trim() : '';
}

const normHeader = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[_\s]+/g, ' ').trim();

function sampleColumns(header) {
  const names = header.map(normHeader);
  const date = names.findIndex((n) => SAMPLE_DATE.includes(n));
  if (date < 0) return null;
  const time = names.findIndex((n) => SAMPLE_TIME.includes(n));
  for (let i = 0; i < names.length; i++) {
    if (i === date || i === time) continue;
    const metric = Object.keys(SAMPLE_METRICS).find((m) => SAMPLE_METRICS[m].includes(names[i]));
    if (metric) return { metric, date: header[date], time: time >= 0 ? header[time] : null, value: header[i] };
  }
  return null;
}

const YMD = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const DMY = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const HMS = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/;

/**
 * Local wall-clock cell(s) → {day: "YYYY-MM-DD", sec: seconds since midnight | null}.
 * Year-first or day-first dates with . - / separators; the time comes from the
 * date cell or, failing that, from a separate time cell. Null when invalid.
 */
export function parseWallClock(dateText, timeText) {
  const s = String(dateText ?? '').trim();
  let y, mo, d, hh, mi, ss, m;
  if ((m = YMD.exec(s))) [, y, mo, d, hh, mi, ss] = m;
  else if ((m = DMY.exec(s))) [, d, mo, y, hh, mi, ss] = m;
  else return null;
  const Y = Number(y), M = Number(mo), D = Number(d);
  const check = new Date(Date.UTC(Y, M - 1, D));
  if (check.getUTCFullYear() !== Y || check.getUTCMonth() !== M - 1 || check.getUTCDate() !== D) return null;
  const day = `${y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
  if (hh == null && timeText) {
    const t = HMS.exec(String(timeText).trim());
    if (t) [, hh, mi, ss] = t;
  }
  if (hh == null) return { day, sec: null };
  const H = Number(hh), Mi = Number(mi), S = Number(ss || 0);
  if (H > 23 || Mi > 59 || S > 59) return null;
  return { day, sec: H * 3600 + Mi * 60 + S };
}

/**
 * Parse a per-minute sample CSV → {metric, header, rows: [{day, sec, v}]}.
 * metric is null when the columns are not recognised, or when no row has a
 * time of day (then it is a daily summary: use parseDailyCsv).
 */
export function parseSampleCsv(text) {
  const { header, records } = csvObjects(text);
  const cols = sampleColumns(header);
  if (!cols) return { metric: null, header, rows: [] };
  const rows = [];
  let untimed = 0;
  for (const r of records) {
    const at = parseWallClock(r[cols.date], cols.time ? r[cols.time] : null);
    const v = toNumber(r[cols.value]);
    if (!at || v == null) continue;
    if (at.sec == null) { untimed++; continue; }
    rows.push({ day: at.day, sec: at.sec, v });
  }
  if (!rows.length && untimed) return { metric: null, header, rows: [] };
  return { metric: cols.metric, header, rows };
}

/** First and last day of parsed rows, or nulls. */
export function rowsRange(rows) {
  let a = null, b = null;
  for (const r of rows) {
    if (a == null || r.day < a) a = r.day;
    if (b == null || r.day > b) b = r.day;
  }
  return [a, b];
}

/**
 * Union the rows of several files of one metric → Map(day → Map(sec → value)).
 * Files are applied oldest first (`m` = modified time), so for the same
 * minute the newest file wins; overlapping files never double count.
 * `days` (a Set) limits the result to those days.
 */
export function unionSamples(files, days = null) {
  const perDay = new Map();
  for (const f of [...files].sort((x, y) => (x.m || 0) - (y.m || 0))) {
    for (const r of f.rows) {
      if (days && !days.has(r.day)) continue;
      let samples = perDay.get(r.day);
      if (!samples) perDay.set(r.day, (samples = new Map()));
      samples.set(r.sec, r.v);
    }
  }
  return perDay;
}

function sampleDay(metric, samples) {
  if (metric === 'steps') {
    let steps = 0, activeMin = 0, n = 0;
    const hourly = new Array(24).fill(0);
    for (const [sec, v] of samples) {
      if (!(v >= 0)) continue;
      steps += v;
      hourly[Math.floor(sec / 3600)] += v;
      if (v >= 60) activeMin++;
      n++;
    }
    return n ? { steps: Math.round(steps), stepsHourly: hourly.map(Math.round), activeMin } : null;
  }
  if (metric === 'hr') {
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    const hourSum = new Array(24).fill(0), hourN = new Array(24).fill(0);
    for (const [sec, v] of samples) {
      if (!(v >= 25 && v <= 230)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      n++;
      const h = Math.floor(sec / 3600);
      hourSum[h] += v;
      hourN[h]++;
    }
    if (!n) return null;
    return {
      hrMin: Math.round(min), hrMax: Math.round(max), hrAvg: Math.round(sum / n), hrN: n,
      hrHourly: hourSum.map((s, i) => (hourN[i] ? Math.round(s / hourN[i]) : null)),
    };
  }
  if (metric === 'spo2') {
    let min = Infinity, sum = 0, n = 0;
    for (const v of samples.values()) {
      if (!(v >= 70 && v <= 100)) continue;
      if (v < min) min = v;
      sum += v;
      n++;
    }
    return n ? { spo2Avg: Math.round((sum / n) * 10) / 10, spo2Min: Math.round(min) } : null;
  }
  if (metric === 'kcal') {
    // Health Connect writes all-zero rows for days without data.
    let sum = 0;
    for (const v of samples.values()) if (v > 0) sum += v;
    return sum > 0 ? { kcal: Math.round(sum) } : null;
  }
  return null;
}

/** Map(day → Map(sec → value)) of one metric → {date → day-row fields}. */
export function samplesToDays(metric, perDay) {
  const out = {};
  for (const [day, samples] of perDay) {
    const row = sampleDay(metric, samples);
    if (row) out[day] = row;
  }
  return out;
}

const WATCH_SOURCE = /huawei/i;

/**
 * Parsed sample files [{metric, rows, m, source}] of any metrics → {date → row}.
 * Files of one source are unioned minute by minute. Different sources (e.g.
 * "Huawei Health" and "Health Connect") are never added together: per metric
 * and day the watch's own source wins, otherwise the one with most samples.
 * `onlyDays` (Map metric → Set of days) limits what is computed.
 */
export function samplesFragment(files, onlyDays = null) {
  const groups = new Map(); // metric → Map(source → files)
  for (const f of files) {
    if (!SAMPLE_METRICS[f.metric]) continue;
    if (!groups.has(f.metric)) groups.set(f.metric, new Map());
    const bySource = groups.get(f.metric);
    const source = f.source || '';
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(f);
  }
  const days = {};
  for (const [metric, bySource] of groups) {
    const want = onlyDays ? onlyDays.get(metric) : null;
    if (onlyDays && !want?.size) continue;
    const best = new Map(); // day → {watch, n, row}
    for (const [source, list] of bySource) {
      const watch = WATCH_SOURCE.test(source);
      for (const [day, samples] of unionSamples(list, want)) {
        const row = sampleDay(metric, samples);
        if (!row) continue;
        const cur = best.get(day);
        if (!cur || (watch && !cur.watch) || (watch === cur.watch && samples.size > cur.n)) best.set(day, { watch, n: samples.size, row });
      }
    }
    for (const [day, { row }] of best) Object.assign((days[day] ||= {}), row);
  }
  return days;
}
