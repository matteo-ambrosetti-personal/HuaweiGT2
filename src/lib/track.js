// Workout analysis.
//
// The Huawei export parser produces full-resolution series for a workout.
// analyzeSeries() turns them into what the dashboard stores: km splits, best efforts, a heart-rate
// histogram, a route thumbnail and a downsampled track (≤ MAX_TRACK points).

import { haversine, simplify, encodePolyline, bbox } from './geo.js';

export const MAX_TRACK = 1000;
export const THUMB_POINTS = 64;
export const EFFORTS = [
  { key: '1k', metres: 1000, label: '1 km' },
  { key: '5k', metres: 5000, label: '5 km' },
  { key: '10k', metres: 10000, label: '10 km' },
  { key: 'hm', metres: 21097.5, label: 'Half marathon' },
  { key: 'm', metres: 42195, label: 'Marathon' },
];
export const HR_HIST_FROM = 40;
export const HR_HIST_STEP = 5;
const HR_HIST_BINS = 40; // 40–240 bpm

const MAX_SPEED = { run: 12, walk: 8, hike: 8, ride: 35, swim: 5, gym: 15, other: 60 };

/**
 * @typedef {{t:number, lat:number, lon:number, alt?:number|null, seg:number}} GpsPoint
 * @typedef {{t:number, v:number}} Sample
 * @typedef {{gps:GpsPoint[], hr:Sample[], cad:Sample[], alt:Sample[], speed:Sample[]}} Series
 */

export function emptySeries() {
  return { gps: [], hr: [], cad: [], alt: [], speed: [] };
}

/** Remove points implying impossible speed, and exact repeats. */
export function filterGps(points, family) {
  const maxV = MAX_SPEED[family] ?? 60;
  const out = [];
  let prev = null;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) continue;
    if (p.lat === 0 && p.lon === 0) continue;
    if (prev && prev.seg === p.seg) {
      const dt = (p.t - prev.t) / 1000;
      const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
      if (dt <= 0 && d < 0.5) continue;
      if (dt > 0 && d / dt > maxV) continue;
      if (dt <= 0 && d > maxV) continue;
    }
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * Distance and moving-time timelines along the GPS track. Distance does not
 * accumulate across pause boundaries (segment changes); neither does moving time.
 */
export function timelines(gps) {
  const n = gps.length;
  const dist = new Float64Array(n);
  const moving = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = gps[i - 1], b = gps[i];
    if (a.seg === b.seg) {
      dist[i] = dist[i - 1] + haversine(a.lat, a.lon, b.lat, b.lon);
      moving[i] = moving[i - 1] + Math.max(0, (b.t - a.t) / 1000);
    } else {
      dist[i] = dist[i - 1];
      moving[i] = moving[i - 1];
    }
  }
  return { dist, moving };
}

function interpIndex(arr, value) {
  // first index i with arr[i] >= value (arr non-decreasing)
  let lo = 0, hi = arr.length - 1;
  if (hi < 0 || arr[hi] < value) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Linear interpolation of y at x over sorted xs. */
function interpolate(xs, ys, x) {
  const i = interpIndex(xs, x);
  if (i < 0) return ys[ys.length - 1];
  if (i === 0) return ys[0];
  const x0 = xs[i - 1], x1 = xs[i];
  if (x1 === x0) return ys[i];
  return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - x0)) / (x1 - x0);
}

function meanInWindow(samples, t0, t1) {
  let sum = 0, n = 0;
  for (const s of samples) {
    if (s.t < t0) continue;
    if (s.t > t1) break;
    sum += s.v;
    n++;
  }
  return n ? sum / n : null;
}

function gainInWindow(samples, t0, t1) {
  let gain = 0, base = null;
  for (const s of samples) {
    if (s.t < t0) continue;
    if (s.t > t1) break;
    if (base == null) { base = s.v; continue; }
    if (s.v > base + 2) { gain += s.v - base; base = s.v; }
    else if (s.v < base - 2) base = s.v;
  }
  return gain;
}

/** Total ascent/descent with a 2 m hysteresis. */
export function climb(samples) {
  let up = 0, down = 0, base = null;
  for (const s of samples) {
    if (base == null) { base = s.v; continue; }
    if (s.v > base + 2) { up += s.v - base; base = s.v; }
    else if (s.v < base - 2) { down += base - s.v; base = s.v; }
  }
  return { up, down };
}

/**
 * Per-km splits. `scale` corrects GPS distance to the device's total.
 * Returns [{km, distance, time, pace, hr, elev}] with a final partial split.
 */
export function computeSplits(gps, tl, { hr = [], alt = [], scale = 1, partTimes = null, start = null } = {}) {
  const splits = [];
  if (partTimes && partTimes.length) {
    // Device split times: cumulative moving seconds at each whole km. Map
    // moving time to clock time through the GPS timeline (or assume no pauses).
    const movingArr = Array.from(tl.moving);
    const times = gps.map((p) => p.t);
    const t0 = start ?? gps[0]?.t ?? hr[0]?.t ?? 0;
    const clock = (mv) => (gps.length >= 2 ? interpolate(movingArr, times, mv) : t0 + mv * 1000);
    let prevT = 0;
    partTimes.forEach((cum, i) => {
      const time = cum - prevT;
      if (time > 0) {
        const a = clock(prevT), b = clock(cum);
        splits.push({
          km: i + 1, distance: 1000, time, pace: time,
          hr: hr.length ? meanInWindow(hr, a, b) : null,
          elev: alt.length ? gainInWindow(alt, a, b) : null,
        });
      }
      prevT = cum;
    });
    return splits;
  }
  if (gps.length < 2) return splits;
  const dist = Array.from(tl.dist, (d) => d * scale);
  const moving = Array.from(tl.moving);
  const total = dist[dist.length - 1];
  const times = gps.map((p) => p.t);
  let prevMoving = 0, prevElapsed = gps[0].t, prevDist = 0;
  for (let km = 1; km * 1000 <= total + 1e-6; km++) {
    const target = km * 1000;
    const mv = interpolate(dist, moving, target);
    const el = interpolate(dist, times, target);
    const time = mv - prevMoving;
    splits.push({
      km,
      distance: 1000,
      time,
      pace: time,
      hr: meanInWindow(hr, prevElapsed, el),
      elev: alt.length ? gainInWindow(alt, prevElapsed, el) : null,
    });
    prevMoving = mv;
    prevElapsed = el;
    prevDist = target;
  }
  const rest = total - prevDist;
  if (rest >= 50) {
    const time = moving[moving.length - 1] - prevMoving;
    splits.push({
      km: Math.round((prevDist + rest) / 10) / 100,
      distance: rest,
      time,
      pace: time / (rest / 1000),
      hr: meanInWindow(hr, prevElapsed, times[times.length - 1]),
      elev: alt.length ? gainInWindow(alt, prevElapsed, times[times.length - 1]) : null,
    });
  }
  return splits;
}

/** Fastest moving time covering each effort distance (two pointers). */
export function bestEfforts(tl, scale = 1) {
  const out = {};
  const n = tl.dist.length;
  if (n < 2) return out;
  const total = tl.dist[n - 1] * scale;
  for (const e of EFFORTS) {
    if (total < e.metres) continue;
    let best = Infinity;
    let i = 0;
    for (let j = 1; j < n; j++) {
      while (i + 1 < j && (tl.dist[j] - tl.dist[i + 1]) * scale >= e.metres) i++;
      const covered = (tl.dist[j] - tl.dist[i]) * scale;
      if (covered >= e.metres) {
        // scale the window time down to exactly the effort distance
        const t = ((tl.moving[j] - tl.moving[i]) * e.metres) / covered;
        if (t < best) best = t;
      }
    }
    if (Number.isFinite(best) && best > 0) out[e.key] = Math.round(best);
  }
  return out;
}

/** Seconds spent in 5-bpm bins from 40 bpm. Gaps over 30 s count as 30 s. */
export function hrHistogram(hr) {
  if (hr.length < 2) return null;
  const secs = new Array(HR_HIST_BINS).fill(0);
  for (let i = 0; i < hr.length; i++) {
    const dt = i + 1 < hr.length ? Math.min(30, Math.max(0, (hr[i + 1].t - hr[i].t) / 1000)) : 5;
    const bin = Math.floor((hr[i].v - HR_HIST_FROM) / HR_HIST_STEP);
    if (bin >= 0 && bin < HR_HIST_BINS) secs[bin] += dt;
  }
  let last = secs.length;
  while (last > 0 && secs[last - 1] === 0) last--;
  return { from: HR_HIST_FROM, step: HR_HIST_STEP, secs: secs.slice(0, last).map(Math.round) };
}

function nearestValue(samples, t, maxGapMs, cursor) {
  // cursor: {i} advancing pointer for monotonic queries
  const n = samples.length;
  if (!n) return null;
  let i = cursor.i;
  while (i + 1 < n && samples[i + 1].t <= t) i++;
  cursor.i = i;
  let best = null, bestGap = Infinity;
  for (const k of [i, i + 1]) {
    if (k < 0 || k >= n) continue;
    const gap = Math.abs(samples[k].t - t);
    if (gap < bestGap) { bestGap = gap; best = samples[k].v; }
  }
  return bestGap <= maxGapMs ? best : null;
}

/**
 * Downsample all series onto a uniform time grid of at most MAX_TRACK points.
 * Output arrays are aligned; missing values are null.
 */
export function downsample(series, startMs, endMs, tl, scale = 1) {
  const { gps, hr, cad, alt, speed } = series;
  const firstT = Math.min(startMs, gps[0]?.t ?? startMs, hr[0]?.t ?? startMs);
  const lastT = Math.max(endMs, gps.at(-1)?.t ?? endMs, hr.at(-1)?.t ?? endMs);
  const span = Math.max(1, (lastT - firstT) / 1000);
  const step = Math.max(1, Math.ceil(span / (MAX_TRACK - 1)));
  const n = Math.min(MAX_TRACK, Math.floor(span / step) + 1);
  const t = [], ll = [], d = [], hrs = [], alts = [], spd = [], cads = [];
  const gpsTimes = gps.map((p) => p.t);
  const curHr = { i: 0 }, curCad = { i: 0 }, curAlt = { i: 0 }, curSpd = { i: 0 };
  let gi = 0;
  for (let k = 0; k < n; k++) {
    const tm = firstT + k * step * 1000;
    t.push(k * step);
    // position: interpolate within a segment, gaps > 60 s → null
    let pos = null, dist = null;
    if (gps.length) {
      while (gi + 1 < gps.length && gpsTimes[gi + 1] <= tm) gi++;
      const a = gps[gi], b = gps[gi + 1];
      if (a && a.t <= tm && b && b.seg === a.seg && b.t - a.t <= 60000) {
        const f = b.t === a.t ? 0 : (tm - a.t) / (b.t - a.t);
        pos = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
        dist = (tl.dist[gi] + (tl.dist[gi + 1] - tl.dist[gi]) * f) * scale;
      } else if (a && Math.abs(a.t - tm) <= 5000) {
        pos = { lat: a.lat, lon: a.lon };
        dist = tl.dist[gi] * scale;
      } else if (a && a.t <= tm) {
        dist = tl.dist[gi] * scale;
      }
    }
    ll.push(pos);
    d.push(dist == null ? null : Math.round(dist));
    hrs.push(nearestValue(hr, tm, 15000, curHr));
    cads.push(nearestValue(cad, tm, 30000, curCad));
    const a1 = nearestValue(alt, tm, 30000, curAlt);
    alts.push(a1 == null ? (pos && gps[gi]?.alt != null ? gps[gi].alt : null) : Math.round(a1 * 10) / 10);
    spd.push(nearestValue(speed, tm, 15000, curSpd));
  }
  // Derive speed from distance when the device gave none (10 s window).
  if (!speed.length && gps.length) {
    const w = Math.max(1, Math.round(10 / step));
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - w), b = Math.min(n - 1, k + w);
      if (d[a] != null && d[b] != null && b > a) spd[k] = (d[b] - d[a]) / ((b - a) * step);
    }
  }
  const hasPos = ll.some(Boolean);
  return {
    step,
    t0: firstT,
    n,
    // positions as one polyline over non-null points, with an index map
    poly: hasPos ? encodePolyline(ll.filter(Boolean)) : null,
    posIdx: hasPos ? ll.map((p, i) => (p ? i : -1)).filter((i) => i >= 0) : null,
    d: d.some((v) => v != null) ? d : null,
    hr: hrs.some((v) => v != null) ? hrs.map((v) => (v == null ? null : Math.round(v))) : null,
    alt: alts.some((v) => v != null) ? alts : null,
    spd: spd.some((v) => v != null) ? spd.map((v) => (v == null ? null : Math.round(v * 100) / 100)) : null,
    cad: cads.some((v) => v != null) ? cads.map((v) => (v == null ? null : Math.round(v))) : null,
  };
}

/**
 * Analyse a workout's full-resolution series.
 * @param {object} w  workout summary (start, end, family, distance, duration…)
 * @param {Series} series
 * @param {{partTimes?: number[]}} extra
 * @returns {{summary: object, track: object|null}}
 */
export function analyzeSeries(w, series, extra = {}) {
  const gps = filterGps(series.gps, w.family);
  const hr = series.hr.filter((s) => s.v >= 25 && s.v <= 240).sort((a, b) => a.t - b.t);
  const cad = series.cad.filter((s) => s.v > 0).sort((a, b) => a.t - b.t);
  const alt = series.alt.filter((s) => Number.isFinite(s.v)).sort((a, b) => a.t - b.t);
  const speed = series.speed.filter((s) => s.v >= 0).sort((a, b) => a.t - b.t);
  const clean = { gps, hr, cad, alt, speed };
  const summary = {};

  const tl = timelines(gps);
  const gpsDist = gps.length ? tl.dist[gps.length - 1] : 0;
  // Correct GPS distance to the device total when they roughly agree.
  let scale = 1;
  if (w.distance > 0 && gpsDist > 0) {
    const r = w.distance / gpsDist;
    if (r > 0.8 && r < 1.25) scale = r;
  }
  if (!(w.distance > 0) && gpsDist > 0) summary.distance = Math.round(gpsDist);

  if (gps.length >= 2) {
    summary.thumb = encodePolyline(simplify(gps, THUMB_POINTS));
    const b = bbox(gps);
    summary.bbox = [b.minLat, b.minLon, b.maxLat, b.maxLon].map((v) => Math.round(v * 1e5) / 1e5);
    summary.hasGps = true;
  }

  const splits = computeSplits(gps, tl, { hr, alt, scale, partTimes: extra.partTimes, start: w.start });
  if (splits.length) summary.splits = splits.map((s) => ({
    km: s.km,
    distance: Math.round(s.distance),
    time: Math.round(s.time),
    pace: Math.round(s.pace),
    hr: s.hr == null ? null : Math.round(s.hr),
    elev: s.elev == null ? null : Math.round(s.elev),
  }));

  if ((w.family === 'run') && gps.length >= 2) {
    const efforts = bestEfforts(tl, scale);
    if (Object.keys(efforts).length) summary.efforts = efforts;
  }

  const hist = hrHistogram(hr);
  if (hist) summary.hrHist = hist;
  if (hr.length) {
    if (!(w.avgHr > 0)) summary.avgHr = Math.round(hr.reduce((s, x) => s + x.v, 0) / hr.length);
    if (!(w.maxHr > 0)) summary.maxHr = Math.max(...hr.map((x) => x.v));
    if (!(w.minHr > 0)) summary.minHr = Math.min(...hr.map((x) => x.v));
  }
  if (cad.length && !(w.avgCadence > 0)) {
    summary.avgCadence = Math.round(cad.reduce((s, x) => s + x.v, 0) / cad.length);
  }
  if (!(w.ascent > 0)) {
    const src = alt.length ? alt : gps.filter((p) => p.alt != null && p.alt !== 0).map((p) => ({ t: p.t, v: p.alt }));
    if (src.length > 1) {
      const c = climb(src);
      summary.ascent = Math.round(c.up);
      if (!(w.descent > 0)) summary.descent = Math.round(c.down);
    }
  }

  const hasAny = gps.length || hr.length || alt.length || speed.length || cad.length;
  const track = hasAny ? downsample(clean, w.start, w.end ?? w.start, tl, scale) : null;
  summary.hasTrack = Boolean(track);
  summary.gpsPoints = gps.length;
  return { summary, track };
}
