// Deterministic synthetic Huawei Health export.
//
// Produces raw export files (2025+ layout) including the format's known quirks:
// bare numeric keys in partTimeMap, pause markers (lat=90;lon=-80), mixed GPS
// time formats, heart rate and stress exported under two type codes, sleep
// spans duplicated, and workouts repeated across motion files. Used by the
// unit tests, the encrypted test ZIP and the dashboard's sample-data mode.

import { addDays } from '../format.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOME = { lat: 45.4642, lon: 9.19 };

function tzFor(dateKey) {
  const m = Number(dateKey.slice(5, 7));
  return m >= 4 && m <= 10 ? '+0200' : '+0100';
}

function tzMinutes(tz) {
  return (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
}

/** Epoch ms for a local date + minutes after midnight in a "+HHMM" zone. */
function at(dateKey, minutes, tz) {
  return Date.parse(dateKey + 'T00:00:00Z') + minutes * 60000 - tzMinutes(tz) * 60000;
}

const OUTER = { run: 4, walk: 5, ride: 3, hike: 282, strength: 147, indoor_run: 101 };
const INNER = { run: 258, walk: 257, ride: 259, hike: 260, strength: 279, indoor_run: 264 };

/**
 * @param {{endDate?: string, days?: number, seed?: number, gpsEvery?: number}} opts
 * @returns {{files: {name: string, text: string}[], plan: object}}
 */
export function generateExport(opts = {}) {
  const days = opts.days ?? 120;
  const endDate = opts.endDate ?? '2026-10-10';
  const gpsEvery = opts.gpsEvery ?? 3; // seconds between GPS fixes
  const rand = mulberry32(opts.seed ?? 42);
  const r = (a, b) => a + (b - a) * rand();
  const ri = (a, b) => Math.floor(r(a, b + 1));
  const startDate = addDays(endDate, -(days - 1));
  const folder = 'HUAWEI_HEALTH_20261010120000';

  const plan = { days: {}, workouts: [], nights: {} };
  const motion = []; // record JSON texts
  const healthByType = {}; // type → record objects
  const minuteFiles = {}; // month → records
  const sequences = [];
  let recordSeq = 1000;

  const addHealth = (type, rec) => (healthByType[type] ||= []).push(rec);

  for (let i = 0; i < days; i++) {
    const date = addDays(startDate, i);
    const tz = tzFor(date);
    const wd = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7; // 0 = Mon
    const fitness = i / days; // slow improvement over the period

    // ---------------------------------------------------------- workouts
    const todays = [];
    if ([0, 2, 4].includes(wd) && rand() < 0.85) todays.push({ kind: 'run', min: ri(7 * 60, 7 * 60 + 30) });
    if (wd === 5 && rand() < 0.8) todays.push({ kind: 'ride', min: ri(9 * 60, 10 * 60) });
    if (wd === 6 && rand() < 0.7) todays.push({ kind: 'hike', min: ri(9 * 60 + 30, 10 * 60 + 30) });
    if ([1, 3].includes(wd) && rand() < 0.5) todays.push({ kind: 'walk', min: ri(18 * 60, 19 * 60) });
    if (wd === 3 && rand() < 0.4) todays.push({ kind: 'strength', min: ri(19 * 60 + 15, 20 * 60) });
    if (wd === 1 && rand() < 0.15) todays.push({ kind: 'indoor_run', min: ri(19 * 60, 20 * 60) });

    const busyMinutes = []; // [startMin, endMin, steps/min, hr]
    for (const w of todays) {
      const res = makeWorkout(w.kind, date, w.min, tz, fitness);
      busyMinutes.push([w.min, w.min + Math.round(res.elapsed / 60), res.cadence, res.avgHr]);
      plan.workouts.push(res.plan);
      motion.push(res.text);
      // Repeat some workouts in a second file with fewer GPS points.
      if (res.plan.gps > 0 && rand() < 0.3) motion.push(res.textReduced);
    }

    // ---------------------------------------------------------- per-minute steps
    const minuteMap = new Map();
    const addMinute = (m, steps, dist, cal) => {
      const prev = minuteMap.get(m);
      if (prev) {
        prev.steps += steps;
        prev.dist += dist;
        prev.cal += cal;
      } else minuteMap.set(m, { m, steps, dist, cal });
    };
    const blocks = [
      [7 * 60 + 40, ri(15, 30), 95],
      [12 * 60 + 30, ri(10, 25), 80],
      [17 * 60 + 45, ri(15, 35), 90],
      [r(9, 16) * 60, ri(10, 40), 60],
      [20 * 60 + 30, ri(5, 20), 70],
    ];
    if (wd >= 5) blocks.push([r(10, 17) * 60, ri(40, 90), 85]);
    for (const [s, len, cadence] of blocks) {
      for (let k = 0; k < len; k++) {
        const m = Math.round(s) + k;
        if (busyMinutes.some(([a, b]) => m >= a && m < b)) continue;
        const steps = Math.max(0, Math.round(cadence * r(0.5, 1.15)));
        addMinute(m, steps, Math.round(steps * 0.72), Math.round(steps * 38 + r(0, 400)));
      }
    }
    for (const [a, b, cadence] of busyMinutes) {
      for (let m = a; m < b; m++) {
        const steps = cadence ? Math.round(cadence * r(0.9, 1.05)) : 0;
        addMinute(m, steps, Math.round(steps * (cadence > 140 ? 1.05 : 0.75)), Math.round(9000 + r(0, 4000)));
      }
    }
    const minutes = [...minuteMap.values()].filter((x) => x.m >= 0 && x.m < 1440).sort((a, b) => a.m - b.m);
    const dayDigits = Number(date.replaceAll('-', ''));
    const minuteRec = {
      recordDay: dayDigits,
      timeZone: tz,
      version: 1,
      sportDataUserData: minutes.map((x) => ({
        startTime: at(date, x.m, tz),
        endTime: at(date, x.m + 1, tz),
        sportType: x.steps > 130 ? 4 : 5,
        deviceCode: 277420141,
        mergedFields: ['distance', 'calorie', 'steps'],
        sportBasicInfos: [{ steps: x.steps, distance: x.dist, calorie: x.cal, altitude: 0.0, floor: 0, duration: 1, count: 0 }],
      })),
    };
    // Duplicate a few minutes from a second device with fewer steps.
    for (const x of minuteRec.sportDataUserData.slice(0, 3)) {
      minuteRec.sportDataUserData.push({ ...x, deviceCode: 1, sportBasicInfos: [{ ...x.sportBasicInfos[0], steps: 1, distance: 1 }] });
    }
    (minuteFiles[date.slice(0, 7)] ||= []).push(minuteRec);
    plan.days[date] = {
      steps: minutes.reduce((s, x) => s + x.steps, 0),
      distance: minutes.reduce((s, x) => s + x.dist, 0),
    };

    // ---------------------------------------------------------- sleep (night ending this morning)
    const bedMin = -45 + r(-40, 40); // minutes relative to midnight (negative = previous evening)
    const asleepMin = bedMin + r(5, 25);
    const wakeMin = 7 * 60 + r(-40, 50) + (wd >= 5 ? 45 : 0);
    const spans = [];
    let cur = asleepMin;
    const stageSeq = ['light', 'deep', 'light', 'rem'];
    let si = 0;
    while (cur < wakeMin - 10) {
      const stage = stageSeq[si % 4];
      const len = stage === 'deep' ? r(25, 50) - fitness * 5 : stage === 'rem' ? r(15, 30) : r(20, 45);
      const end = Math.min(wakeMin, cur + len);
      spans.push([stage, cur, end]);
      if (rand() < 0.12) {
        spans.push(['awake', end, end + r(2, 8)]);
        cur = spans.at(-1)[2];
      } else cur = end;
      si++;
    }
    const keyFor = { light: 'PROFESSIONAL_SLEEP_SHALLOW', deep: 'PROFESSIONAL_SLEEP_DEEP', rem: 'PROFESSIONAL_SLEEP_DREAM', awake: 'PROFESSIONAL_SLEEP_WAKE' };
    const nightMins = { deep: 0, light: 0, rem: 0, awake: 0 };
    for (const [stage, s, e] of spans) {
      const rec = sleepSpanRecord(keyFor[stage], at(date, s, tz), at(date, e, tz), tz, recordSeq++);
      addHealth(9, rec);
      if (rand() < 0.9) addHealth(9, { ...rec, recordId: rec.recordId + 'b' }); // duplicated span
      nightMins[stage] += e - s;
    }
    const score = Math.round(r(68, 90));
    sequences.push({
      type: 700013,
      startTime: at(date, bedMin, tz),
      endTime: at(date, wakeMin + 10, tz),
      timeZone: tz,
      deviceCode: 277420141,
      summaryData: JSON.stringify({
        bedTime: Math.round(at(date, bedMin, tz) / 1000),
        fallAsleepTime: Math.round(at(date, asleepMin, tz) / 1000),
        wakeupTime: Math.round(at(date, wakeMin, tz) / 1000),
        risingTime: Math.round(at(date, wakeMin + 10, tz) / 1000),
        sleepScore: score,
        deepPart: Math.round(r(60, 95)),
        sleepEfficiency: Math.round(r(82, 96)),
        sleepLatency: Math.round(asleepMin - bedMin),
        wakeCount: spans.filter((s) => s[0] === 'awake').length,
        minHeartrate: 48,
        maxHeartrate: 255,
        avgHrv: 65535,
      }),
      detailData: '0000',
    });
    plan.nights[date] = {
      total: Math.round(nightMins.deep + nightMins.light + nightMins.rem),
      deep: Math.round(nightMins.deep),
      score,
    };

    // ---------------------------------------------------------- heart rate, stress, SpO2
    const restBase = 58 - fitness * 4 + r(-2, 2);
    for (let m = 0; m < 1440; m += 10) {
      const asleep = m < wakeMin && m > 0;
      const busy = busyMinutes.find(([a, b]) => m >= a && m < b);
      let hr = asleep ? restBase - 4 + r(-3, 3) : 72 + r(-8, 15);
      if (busy) hr = busy[3] + r(-10, 10);
      hr = Math.round(hr);
      const t = at(date, m, tz);
      addHealth(7, healthRecord(7, 'DATA_POINT_DYNAMIC_HEARTRATE', `${hr}.0`, t, tz, recordSeq++));
      addHealth(500023, healthRecord(500023, 'DYNAMIC_HEART_RATE', JSON.stringify({ bpm: hr }), t, tz, recordSeq++));
    }
    const rest = Math.round(restBase);
    addHealth(7, healthRecord(7, 'DATA_POINT_NEW_REST_HEARTRATE', `${rest}`, at(date, 9 * 60, tz), tz, recordSeq++));
    addHealth(500024, healthRecord(500024, 'RESTING_HEART_RATE', JSON.stringify({ restBpm: rest }), at(date, 9 * 60, tz), tz, recordSeq++));
    plan.days[date].restHr = rest;
    for (let m = 8 * 60; m < 22 * 60; m += 30) {
      const s = Math.round(r(18, 55) + (wd < 5 ? 8 : 0));
      const t = at(date, m, tz);
      addHealth(11, healthRecord(11, 'STRESS_DATA', JSON.stringify({ score: s, grade: s > 60 ? 3 : 2 }), t, tz, recordSeq++));
      addHealth(500026, healthRecord(500026, 'STRESS', JSON.stringify({ stressScore: s }), t, tz, recordSeq++));
    }
    for (const m of [60, 180, 300]) {
      addHealth(16, healthRecord(16, 'BLOOD_OXYGEN_SATURATION', JSON.stringify({ avgSaturation: Math.round(r(94, 99)) }), at(date, m, tz), tz, recordSeq++));
    }
    addHealth(500044, healthRecord(500044, 'HEART_RATE_VARIABILITY', JSON.stringify({ heartRateVariabilityRMSSD: Math.round(r(30, 60) + fitness * 8) }), at(date, 6 * 60, tz), tz, recordSeq++));
  }

  // ------------------------------------------------------------ files
  const files = [];
  const half = Math.ceil(motion.length / 2);
  files.push({ name: `${folder}/Motion path detail data & description/motion path detail data1767225600000.json`, text: '[' + motion.slice(0, half).join(',') + ']' });
  files.push({ name: `${folder}/Motion path detail data & description/motion path detail data1767225600001.json`, text: '[' + motion.slice(half).join(',') + ']' });
  files.push({ name: `${folder}/Motion path detail data & description/Motion path detail data-Data Field Description.xlsx`, text: 'not a json file' });
  let ts = 1767225700000;
  for (const recs of Object.values(healthByType)) {
    files.push({ name: `${folder}/Health detail data & description/health detail data${ts++}.json`, text: JSON.stringify(recs) });
  }
  Object.values(minuteFiles).forEach((recs, i) => {
    files.push({ name: `${folder}/Sport per minute merged data & description/sport per minute merged data${i + 1}.json`, text: JSON.stringify(recs) });
  });
  files.push({ name: `${folder}/Sample sequence data & description/sample sequence data${ts++}.json`, text: JSON.stringify(sequences) });
  files.push({ name: `${folder}/HUAWEI_HEALTH-Agreement Signing-Data.xlsx`, text: 'binary' });
  return { files, plan };

  // ------------------------------------------------------------ helpers
  function healthRecord(type, key, value, t, tz, id) {
    return {
      appType: 1, dataId: id, deviceCode: 277420141, startTime: t, endTime: t + 60000,
      healthDataSource: 0, mergedFlag: 0, recordId: 'r' + id, timeZone: tz, type, version: 1,
      samplePoints: [{ key, startTime: t, endTime: t + 60000, unit: '0', value }],
    };
  }

  function sleepSpanRecord(key, start, end, tz, id) {
    return {
      appType: 1, dataId: id, deviceCode: 277420141, startTime: start, endTime: end, recordId: 'r' + id,
      timeZone: tz, type: 9, version: 1, samplePoints: [{ key, startTime: start, endTime: end, unit: '0', value: '1' }],
    };
  }

  function makeWorkout(kind, date, startMin, tz, fitness) {
    const start = at(date, startMin, tz);
    const speedBase = { run: 2.9 + fitness * 0.35, walk: 1.4, hike: 1.15, ride: 7.2, strength: 0, indoor_run: 2.8 }[kind];
    const minutes = { run: r(28, 62), walk: r(25, 55), hike: r(110, 200), ride: r(60, 120), strength: r(35, 55), indoor_run: r(25, 40) }[kind];
    const elapsed = Math.round(minutes * 60);
    const hasGps = kind !== 'strength' && kind !== 'indoor_run';
    const pauseAt = kind === 'run' && rand() < 0.4 ? Math.round(elapsed * r(0.4, 0.6)) : null;
    const pauseLen = pauseAt ? ri(60, 150) : 0;
    const lines = [];
    const gps = [];
    let lat = HOME.lat + r(-0.01, 0.01), lon = HOME.lon + r(-0.01, 0.01);
    const lat0 = lat, lon0 = lon;
    let heading = r(0, Math.PI * 2);
    let dist = 0, moving = 0;
    let altBase = kind === 'hike' ? 420 : 122;
    const partTimes = [];
    let nextKm = 1000;
    const hrBase = { run: 148, walk: 102, hike: 118, ride: 132, strength: 110, indoor_run: 150 }[kind];
    const cadence = { run: 168, walk: 112, hike: 98, ride: 0, strength: 0, indoor_run: 166 }[kind];
    let maxHr = 0, hrSum = 0, hrN = 0;
    let k = 1;
    for (let s = 0; s <= elapsed + pauseLen; s += 1) {
      const inPause = pauseAt != null && s >= pauseAt && s < pauseAt + pauseLen;
      const t = start + s * 1000;
      if (inPause) {
        if (s === pauseAt) lines.push(`tp=lbs;k=${k++};lat=90.0;lon=-80.0;alt=0;t=0;`);
        continue;
      }
      const v = speedBase * (1 + 0.08 * Math.sin(s / 90)) * r(0.95, 1.05);
      if (hasGps) {
        // steer back home in the second half so routes loop
        const back = Math.atan2(lat0 - lat, (lon0 - lon) * Math.cos((lat * Math.PI) / 180));
        const homeward = s > elapsed * 0.5 ? 0.04 : 0;
        heading += r(-0.05, 0.05) + homeward * Math.sin(back - heading);
        const d = v;
        lat += (d * Math.sin(heading)) / 111320;
        lon += (d * Math.cos(heading)) / (111320 * Math.cos((lat * Math.PI) / 180));
      }
      dist += v;
      moving += 1;
      while (dist >= nextKm) { partTimes.push(moving); nextKm += 1000; }
      const climbProfile = kind === 'hike' ? Math.sin((Math.PI * s) / (elapsed + pauseLen)) * 380 : Math.sin(s / 300) * 12;
      const alt = altBase + climbProfile;
      if (hasGps && s % gpsEvery === 0) {
        let tf;
        const mod = k % 10;
        if (mod === 3) tf = (t / 1000).toFixed(0); // 10-digit seconds
        else if (mod === 7) tf = (t / 1000).toExponential(9).replace('e+', 'E'); // scientific
        else tf = String(t); // ms
        lines.push(`tp=lbs;k=${k++};lat=${lat.toFixed(6)};lon=${lon.toFixed(6)};alt=${alt.toFixed(2)};t=${tf};`);
        gps.push([lat, lon]);
      }
      if (s % 5 === 0) {
        const hr = Math.round(hrBase + 12 * Math.sin(s / 400) + r(-4, 4) + Math.min(10, s / 60) - fitness * 3);
        maxHr = Math.max(maxHr, hr);
        hrSum += hr;
        hrN++;
        lines.push(`tp=h-r;k=${t};v=${hr};`);
        if (cadence) lines.push(`tp=s-r;k=${t};v=${Math.round(cadence * r(0.97, 1.03))};`);
        lines.push(`tp=alti;k=${t};v=${alt.toFixed(1)};`);
        lines.push(`tp=rs;k=${s};v=${Math.round(v * 10)};`);
      }
    }
    partTimes.forEach((cum, i) => lines.push(`tp=p-m;k=${(i + 1) * 10000000 + i * 100};v=${Math.round(i ? cum - partTimes[i - 1] : cum)};`));
    const totalDistance = kind === 'strength' ? 0 : Math.round(dist);
    const totalTime = moving * 1000;
    const avgHr = Math.round(hrSum / Math.max(1, hrN));
    const ascentDm = kind === 'hike' ? Math.round(3800 + r(0, 400)) : Math.round(r(80, 300));
    const cal = Math.round((minutes * (kind === 'run' ? 11 : kind === 'ride' ? 9 : 5)) * 1000);
    const summary = {
      totalDistance, totalCalories: cal, totalTime, totalSteps: cadence ? Math.round((cadence * moving) / 60) : 0,
      avgPace: totalDistance ? Math.round((moving / (totalDistance / 1000)) * 1000) / 1000 : 0,
      avgHeartRate: avgHr, maxHeartRate: maxHr, avgStepRate: cadence, bestPace: 0,
      creepingWave: ascentDm, mTotalDescent: ascentDm - 20, mMaxAlti: 1.4e-45, mMinAlti: 3.4028235e38,
      sportType: INNER[kind], trackType: 5, coordinate: 'GCJ02',
      partTimeMap: Object.fromEntries(partTimes.map((c, i) => [String(i + 1), c])),
      wearSportData: { max_met: 0, load_peak: 120, etraining_effect: 32, recovery_time: 840 },
    };
    const id = `wk${recordSeq++}`;
    const base = {
      abnormalTrack: 0, appType: 0, dataId: recordSeq, deviceCode: 277420141, duplicateTrack: 0,
      endTime: start + (elapsed + pauseLen) * 1000, localDate: date.replaceAll('-', ''), mergedFlag: 0,
      realSteps: summary.totalSteps, recordId: id, sportDataSource: 2, sportType: OUTER[kind],
      startTime: start, timeZone: tz, totalCalories: cal, totalDistance, totalSteps: summary.totalSteps, totalTime,
    };
    const bare = '{' + partTimes.map((c, i) => `${i + 1}.0:${c}.0`).join(',') + '}';
    const serialize = (detailLines) => {
      const attribute = 'HW_EXT_TRACK_DETAIL@is' + detailLines.join('\n') + '\n&&HW_EXT_TRACK_SIMPLIFY@is' + JSON.stringify(summary);
      const json = JSON.stringify({ ...base, attribute });
      // Huawei writes partTimeMap with bare numeric keys (invalid JSON).
      return json.slice(0, -1) + `,"partTimeMap":${partTimes.length ? bare : '{}'}}`;
    };
    const reduced = lines.filter((l, i) => !l.startsWith('tp=lbs') || i % 2 === 0);
    return {
      elapsed: elapsed + pauseLen,
      cadence,
      avgHr,
      text: serialize(lines),
      textReduced: serialize(reduced),
      plan: {
        id: 'hw-' + id, kind, date, start, distance: totalDistance, duration: moving, avgHr, gps: gps.length,
        pause: Boolean(pauseAt), kcal: cal / 1000, ascent: ascentDm / 10, partTimes,
      },
    };
  }
}
