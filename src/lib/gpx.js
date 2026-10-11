// GPX and TCX reading (Health Sync files) and writing (exports).
//
// A tiny tag scanner instead of DOMParser so the same code runs in a Web
// Worker and in Node tests.

import { emptySeries } from './track.js';
import { decodePolyline } from './geo.js';
import { familyFromText, labelFromText } from './huawei/sport-types.js';

function tagValue(block, name) {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}

function attr(openTag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(openTag);
  return m ? m[1] : null;
}

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoMs(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Parse GPX text → {name, type, series, start, end}. */
export function parseGpx(text) {
  const series = emptySeries();
  const name = tagValue(text.replace(/<trkseg[\s\S]*$/i, ''), 'name');
  const type = tagValue(text.replace(/<trkseg[\s\S]*$/i, ''), 'type');
  let seg = -1;
  const segRe = /<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/gi;
  let sm;
  while ((sm = segRe.exec(text))) {
    seg++;
    const ptRe = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi;
    let pm;
    while ((pm = ptRe.exec(sm[1]))) {
      const lat = num(attr(pm[1], 'lat')), lon = num(attr(pm[1], 'lon'));
      const t = isoMs(tagValue(pm[2], 'time'));
      if (lat == null || lon == null || !t) continue;
      const ele = num(tagValue(pm[2], 'ele'));
      series.gps.push({ t, lat, lon, alt: ele, seg });
      const hr = num(tagValue(pm[2], 'hr'));
      if (hr) series.hr.push({ t, v: hr });
      const cad = num(tagValue(pm[2], 'cad'));
      if (cad) series.cad.push({ t, v: cad });
      if (ele != null) series.alt.push({ t, v: ele });
    }
  }
  const times = series.gps.map((p) => p.t);
  return { name, type, series, start: times.length ? Math.min(...times) : null, end: times.length ? Math.max(...times) : null };
}

/** Parse TCX text → {sport, series, start, end, laps:{time, distance, kcal, avgHr, maxHr}}. */
export function parseTcx(text) {
  const series = emptySeries();
  const actOpen = /<Activity\b([^>]*)>/i.exec(text);
  const sport = actOpen ? attr(actOpen[1], 'Sport') : null;
  const laps = { time: 0, distance: 0, kcal: 0, avgHr: null, maxHr: null };
  const lapRe = /<Lap\b[^>]*>([\s\S]*?)<\/Lap>/gi;
  let lm, hrW = 0, hrSum = 0;
  let seg = -1;
  while ((lm = lapRe.exec(text))) {
    const lap = lm[1];
    const head = lap.replace(/<Track\b[\s\S]*$/i, '');
    const t = num(tagValue(head, 'TotalTimeSeconds')) || 0;
    laps.time += t;
    laps.distance += num(tagValue(head, 'DistanceMeters')) || 0;
    laps.kcal += num(tagValue(head, 'Calories')) || 0;
    const avg = num(tagValue(tagValue(head, 'AverageHeartRateBpm') || '', 'Value'));
    if (avg) { hrSum += avg * t; hrW += t; }
    const mx = num(tagValue(tagValue(head, 'MaximumHeartRateBpm') || '', 'Value'));
    if (mx && (!laps.maxHr || mx > laps.maxHr)) laps.maxHr = mx;
    const trkRe = /<Track\b[^>]*>([\s\S]*?)<\/Track>/gi;
    let tm;
    while ((tm = trkRe.exec(lap))) {
      seg++;
      const ptRe = /<Trackpoint\b[^>]*>([\s\S]*?)<\/Trackpoint>/gi;
      let pm;
      while ((pm = ptRe.exec(tm[1]))) {
        const p = pm[1];
        const t = isoMs(tagValue(p, 'Time'));
        if (!t) continue;
        const lat = num(tagValue(p, 'LatitudeDegrees')), lon = num(tagValue(p, 'LongitudeDegrees'));
        const alt = num(tagValue(p, 'AltitudeMeters'));
        if (lat != null && lon != null) series.gps.push({ t, lat, lon, alt, seg });
        if (alt != null) series.alt.push({ t, v: alt });
        const hr = num(tagValue(tagValue(p, 'HeartRateBpm') || '', 'Value'));
        if (hr) series.hr.push({ t, v: hr });
        const cad = num(tagValue(p, 'Cadence')) ?? num(tagValue(p, 'RunCadence'));
        if (cad) series.cad.push({ t, v: cad });
        const spd = num(tagValue(p, 'Speed'));
        if (spd != null) series.speed.push({ t, v: spd });
      }
    }
  }
  if (hrW) laps.avgHr = Math.round(hrSum / hrW);
  const times = [...series.gps.map((p) => p.t), ...series.hr.map((s) => s.t)];
  const idStart = isoMs(tagValue(text, 'Id'));
  return {
    sport,
    series,
    laps,
    start: idStart ?? (times.length ? Math.min(...times) : null),
    end: times.length ? Math.max(...times) : null,
  };
}

/** Workout skeleton from a parsed GPX/TCX file. */
export function workoutFromFile(parsed, { kind, source, fileId }) {
  const typeText = parsed.type || parsed.sport || parsed.name || '';
  const family = familyFromText(typeText);
  const start = parsed.start;
  const end = parsed.end ?? start;
  const w = {
    id: `${source === 'healthsync' ? 'hs' : 'f'}-${fileId || start}`,
    source,
    sources: [source],
    sport: family,
    label: labelFromText(typeText) || 'Workout',
    family,
    start,
    end,
    elapsed: Math.round((end - start) / 1000),
    duration: Math.round(parsed.laps?.time || (end - start) / 1000),
  };
  if (parsed.laps?.distance) w.distance = Math.round(parsed.laps.distance);
  if (parsed.laps?.kcal) w.kcal = Math.round(parsed.laps.kcal);
  if (parsed.laps?.avgHr) w.avgHr = parsed.laps.avgHr;
  if (parsed.laps?.maxHr) w.maxHr = parsed.laps.maxHr;
  w.fileKind = kind;
  return w;
}

// ------------------------------------------------------------------ writing

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

/** Expand a stored (downsampled) track to points with absolute times. */
export function trackPoints(track) {
  if (!track) return [];
  const pos = track.poly ? decodePolyline(track.poly) : [];
  const posAt = new Map();
  (track.posIdx || []).forEach((idx, i) => posAt.set(idx, pos[i]));
  const out = [];
  for (let i = 0; i < track.n; i++) {
    out.push({
      t: track.t0 + i * track.step * 1000,
      pos: posAt.get(i) || null,
      alt: track.alt?.[i] ?? null,
      hr: track.hr?.[i] ?? null,
      cad: track.cad?.[i] ?? null,
      d: track.d?.[i] ?? null,
      spd: track.spd?.[i] ?? null,
    });
  }
  return out;
}

export function toGpx(workout, track) {
  const pts = trackPoints(track).filter((p) => p.pos);
  const rows = pts.map((p) => {
    const ext = p.hr != null || p.cad != null
      ? `<extensions><gpxtpx:TrackPointExtension>${p.hr != null ? `<gpxtpx:hr>${p.hr}</gpxtpx:hr>` : ''}${p.cad != null ? `<gpxtpx:cad>${p.cad}</gpxtpx:cad>` : ''}</gpxtpx:TrackPointExtension></extensions>`
      : '';
    return `<trkpt lat="${p.pos.lat.toFixed(6)}" lon="${p.pos.lon.toFixed(6)}">${p.alt != null ? `<ele>${p.alt}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time>${ext}</trkpt>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GT 2 Logbook" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<metadata><name>${esc(workout.label)} ${esc(workout.date)}</name><time>${new Date(workout.start).toISOString()}</time></metadata>
<trk><name>${esc(workout.label)}</name><type>${esc(workout.family)}</type><trkseg>
${rows.join('\n')}
</trkseg></trk>
</gpx>
`;
}

const TCX_SPORT = { run: 'Running', ride: 'Biking' };

export function toTcx(workout, track) {
  const pts = trackPoints(track);
  const rows = pts.map((p) => [
    '<Trackpoint>',
    `<Time>${new Date(p.t).toISOString()}</Time>`,
    p.pos ? `<Position><LatitudeDegrees>${p.pos.lat.toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${p.pos.lon.toFixed(6)}</LongitudeDegrees></Position>` : '',
    p.alt != null ? `<AltitudeMeters>${p.alt}</AltitudeMeters>` : '',
    p.d != null ? `<DistanceMeters>${p.d}</DistanceMeters>` : '',
    p.hr != null ? `<HeartRateBpm><Value>${p.hr}</Value></HeartRateBpm>` : '',
    p.cad != null && workout.family === 'ride' ? `<Cadence>${p.cad}</Cadence>` : '',
    '</Trackpoint>',
  ].join(''));
  const start = new Date(workout.start).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
<Activities><Activity Sport="${TCX_SPORT[workout.family] || 'Other'}"><Id>${start}</Id>
<Lap StartTime="${start}"><TotalTimeSeconds>${workout.duration || 0}</TotalTimeSeconds><DistanceMeters>${workout.distance || 0}</DistanceMeters><Calories>${Math.round(workout.kcal || 0)}</Calories>${workout.avgHr ? `<AverageHeartRateBpm><Value>${Math.round(workout.avgHr)}</Value></AverageHeartRateBpm>` : ''}${workout.maxHr ? `<MaximumHeartRateBpm><Value>${Math.round(workout.maxHr)}</Value></MaximumHeartRateBpm>` : ''}<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>
<Track>
${rows.join('\n')}
</Track></Lap>
<Notes>${esc(workout.label)} exported from GT 2 Logbook</Notes>
</Activity></Activities>
</TrainingCenterDatabase>
`;
}
