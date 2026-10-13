import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tzOffsetMinutes, localDateKey, localHour, localMidnight, recordDayKey, addDays, daysBetween,
  weekdayIndex, weekStart, fmtDuration, fmtPace, fmtSleep, fmtMinuteOfDay,
} from '../src/lib/format.js';
import { haversine, simplify, encodePolyline, decodePolyline, fitProjection, routeCluster } from '../src/lib/geo.js';

test('parses Huawei time zone strings', () => {
  assert.equal(tzOffsetMinutes('+0800'), 480);
  assert.equal(tzOffsetMinutes('+08:00'), 480);
  assert.equal(tzOffsetMinutes('-0330'), -210);
  assert.equal(tzOffsetMinutes('GMT+01:00'), 60);
  assert.equal(tzOffsetMinutes(undefined), null);
});

test('buckets instants into local dates using the record offset', () => {
  const ms = Date.UTC(2025, 6, 8, 23, 30); // 23:30 UTC
  assert.equal(localDateKey(ms, 0), '2025-07-08');
  assert.equal(localDateKey(ms, 120), '2025-07-09');
  assert.equal(localHour(ms, 120), 1);
  assert.equal(localMidnight(ms, 120), Date.UTC(2025, 6, 8, 22, 0));
});

test('date key helpers', () => {
  assert.equal(recordDayKey(20250226), '2025-02-26');
  assert.equal(recordDayKey('2025'), null);
  assert.equal(addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(daysBetween('2024-01-01', '2024-12-31'), 365);
  assert.equal(weekdayIndex('2026-10-12'), 0); // Monday
  assert.equal(weekStart('2026-10-11'), '2026-10-05');
});

test('display formatting', () => {
  assert.equal(fmtDuration(3723), '1:02:03');
  assert.equal(fmtDuration(125), '2:05');
  assert.equal(fmtPace(312), '5:12');
  assert.equal(fmtPace(0), '—');
  assert.equal(fmtSleep(452), '7 h 32');
  assert.equal(fmtMinuteOfDay(-30), '23:30');
});

test('haversine distance', () => {
  // 1 degree of latitude ≈ 111.2 km
  const d = haversine(45, 9, 46, 9);
  assert.ok(Math.abs(d - 111195) < 200, String(d));
});

test('polyline round trip and simplification', () => {
  const pts = Array.from({ length: 500 }, (_, i) => ({ lat: 45.46 + i * 1e-4, lon: 9.19 + Math.sin(i / 20) * 1e-3 }));
  const enc = encodePolyline(pts);
  const dec = decodePolyline(enc);
  assert.equal(dec.length, pts.length);
  assert.ok(Math.abs(dec[123].lat - pts[123].lat) < 1e-5);
  const simple = simplify(pts, 64);
  assert.ok(simple.length <= 64 && simple.length >= 10);
  assert.deepEqual(simple[0], pts[0]);
  assert.deepEqual(simple.at(-1), pts.at(-1));
});

test('projection keeps points inside the box', () => {
  const proj = fitProjection({ minLat: 45.4, maxLat: 45.5, minLon: 9.1, maxLon: 9.3 }, 300, 200, 10);
  for (const [lat, lon] of [[45.4, 9.1], [45.5, 9.3], [45.45, 9.2]]) {
    const [x, y] = proj.project(lat, lon);
    assert.ok(x >= 9.99 && x <= 290.01 && y >= 9.99 && y <= 190.01, `${x},${y}`);
  }
  assert.ok(proj.pxPerMetre > 0);
});

test('route cluster leaves out a trip far from the rest', () => {
  // Synthetic places: a loop near (10, 20), offset by dLat/dLon degrees.
  const loop = (id, dLat, dLon) => ({ id, points: [0, 1, 2, 3].map((i) => ({ lat: 10 + dLat + 0.004 * Math.sin(i), lon: 20 + dLon + 0.004 * Math.cos(i) })) });
  const home = [loop('a', 0, 0), loop('b', 0.005, 0), loop('c', -0.004, 0.006), loop('d', 0.002, -0.005), loop('e', 0.008, 0.003)];
  const away = loop('far', 0.09, 0.01); // about 10 km north
  assert.deepEqual(routeCluster([...home, away]).map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(routeCluster(home).length, 5, 'nothing to leave out');
  // Scattered routes have no main area: all stay.
  const spread = [loop('p', 0, 0), loop('q', 0.5, 0), loop('r', 0, 0.5), loop('s', -0.5, 0)];
  assert.equal(routeCluster(spread).length, 4);
  assert.equal(routeCluster([home[0], away]).length, 2, 'two routes are always both shown');
});
