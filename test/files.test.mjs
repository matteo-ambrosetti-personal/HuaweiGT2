import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGpx, toTcx, trackPoints } from '../src/lib/gpx.js';
import { toCsv } from '../src/lib/csv.js';
import { analyzeSeries, emptySeries, bestEfforts, timelines, computeSplits } from '../src/lib/track.js';

function syntheticTrack(n = 600, stepS = 2, mps = 3) {
  const t0 = Date.UTC(2025, 4, 1, 6, 0, 0);
  const s = emptySeries();
  for (let i = 0; i < n; i++) {
    const t = t0 + i * stepS * 1000;
    s.gps.push({ t, lat: 45 + (i * stepS * mps) / 111320, lon: 9, alt: 100 + i * 0.1, seg: 0 });
    s.hr.push({ t, v: 130 + (i % 20) });
  }
  return { t0, s };
}

test('best efforts and splits on a steady 3 m/s track', () => {
  const { s } = syntheticTrack(2000, 2, 3); // 12 km at 3 m/s (333 s/km)
  const tl = timelines(s.gps);
  const e = bestEfforts(tl);
  assert.ok(Math.abs(e['1k'] - 333) <= 2, String(e['1k']));
  assert.ok(Math.abs(e['10k'] - 3333) <= 10, String(e['10k']));
  const splits = computeSplits(s.gps, tl, { hr: s.hr });
  assert.equal(splits.length, 12); // 11 full km + partial ≈ 0.99 km
  assert.ok(Math.abs(splits[0].pace - 333) <= 2);
  assert.ok(splits[0].hr > 130);
});

test('GPX and TCX exports of a stored track', () => {
  const { t0, s: series } = syntheticTrack(300);
  const w = { id: 'x', label: 'Outdoor run', family: 'run', date: '2025-05-01', start: t0, end: t0 + 600000, duration: 600, distance: 1800, kcal: 120, avgHr: 140, maxHr: 149 };
  const { track } = analyzeSeries(w, series);
  const withPos = trackPoints(track).filter((p) => p.pos).length;
  const gpx = toGpx(w, track);
  assert.match(gpx, /^<\?xml/);
  assert.equal((gpx.match(/<trkpt /g) || []).length, withPos);
  assert.ok((gpx.match(/<gpxtpx:hr>/g) || []).length > 100);
  assert.match(gpx, /<type>run<\/type>/);
  const tcx = toTcx(w, track);
  assert.match(tcx, /Sport="Running"/);
  assert.match(tcx, /<TotalTimeSeconds>600<\/TotalTimeSeconds><DistanceMeters>1800<\/DistanceMeters>/);
  assert.ok((tcx.match(/<Trackpoint>/g) || []).length > 100);
});

test('CSV export quotes what needs quoting', () => {
  const csv = toCsv([{ a: 'plain', b: 'with, comma' }, { a: 'say "hi"', b: 'line\nbreak' }], [{ key: 'a' }, { key: 'b', label: 'B' }]);
  assert.equal(csv, 'a,B\r\nplain,"with, comma"\r\n"say ""hi""","line\nbreak"\r\n');
});
