// GPX and TCX writing, for route exports.

import { decodePolyline } from './geo.js';

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
