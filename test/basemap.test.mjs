import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapAreas, overpassQuery, overpassUrl, OVERPASS_URL, classify, assembleRings, osmToBasemap, decodeBasemap,
  parseMapText, nearestPlace, boxCells, workoutCoverage, areaKm2, MapFileError,
} from '../src/lib/basemap.js';
import { syntheticOverpass } from '../src/lib/sample/osm.js';
import { haversine } from '../src/lib/geo.js';

// Synthetic places only: a grid around (10, 20), far from anyone's home.
const C = { lat: 10, lon: 20 };
const wk = (dLat, dLon, size = 0.01) => ({ bbox: [C.lat + dLat, C.lon + dLon, C.lat + dLat + size, C.lon + dLon + size] });

test('download areas: buffered route boxes, merged when they overlap', () => {
  const areas = mapAreas([wk(0, 0), wk(0.012, 0.005), wk(0.3, 0.3), { bbox: null }, {}]);
  assert.equal(areas.length, 2, 'two nearby routes share a box, the far one gets its own');
  const [home, far] = areas;
  assert.ok(home[0] < C.lat - 0.008 && home[2] > C.lat + 0.022 + 0.008, 'grown by about 1 km');
  for (const v of home) assert.equal(Math.round(v * 1000) / 1000, v, 'rounded to 3 decimals');
  assert.ok(far[0] > C.lat + 0.28);
  assert.ok(areaKm2(home) > 6 && areaKm2(home) < 30, `area ${areaKm2(home)}`);
  // A route the stored map covers is not downloaded again.
  const cells = boxCells(home);
  assert.deepEqual(mapAreas([wk(0, 0), wk(0.3, 0.3)], { cells }).length, 1);
  assert.equal(workoutCoverage(wk(0, 0), cells), 1);
  assert.equal(workoutCoverage(wk(0.3, 0.3), cells), 0);
  assert.equal(workoutCoverage({}, cells), null);
});

test('the Overpass query asks for each box and returns geometry', () => {
  const q = overpassQuery([[10.001, 20.002, 10.031, 20.034], [10.5, 20.5, 10.6, 20.6]]);
  assert.ok(q.startsWith('[out:json]'));
  assert.ok(q.includes('(10.001,20.002,10.031,20.034);') && q.includes('(10.500,20.500,10.600,20.600);'));
  assert.ok(q.endsWith('out geom qt;'));
  assert.ok(q.includes('way["highway"]') && q.includes('node["place"'));
  const url = overpassUrl(q);
  assert.ok(url.startsWith(`${OVERPASS_URL}?data=`));
  assert.equal(decodeURIComponent(url.split('?data=')[1]), q);
  assert.throws(() => overpassQuery([]), MapFileError);
});

test('tags decide what is drawn', () => {
  assert.deepEqual(classify({ highway: 'residential' }), { line: 'minor' });
  assert.deepEqual(classify({ highway: 'trunk' }), { line: 'motorway' });
  assert.deepEqual(classify({ highway: 'track' }), { line: 'path' });
  assert.equal(classify({ highway: 'footway', footway: 'sidewalk' }), null);
  assert.equal(classify({ highway: 'primary', tunnel: 'yes' }), null);
  assert.equal(classify({ highway: 'pedestrian', area: 'yes' }), null);
  assert.deepEqual(classify({ railway: 'tram' }), { line: 'rail' });
  assert.equal(classify({ railway: 'subway', tunnel: 'yes' }), null);
  assert.deepEqual(classify({ waterway: 'stream' }), { line: 'stream' });
  assert.deepEqual(classify({ natural: 'water' }), { fill: 'water' });
  assert.deepEqual(classify({ landuse: 'forest' }), { fill: 'wood' });
  assert.deepEqual(classify({ leisure: 'park' }), { fill: 'park' });
  assert.deepEqual(classify({ leisure: 'track' }), { fill: 'pitch' });
  assert.equal(classify({ building: 'yes' }), null);
});

test('multipolygon members join into closed rings', () => {
  const p = (lat, lon) => ({ lat, lon });
  const a = [p(0, 0), p(0, 1), p(1, 1)];
  const b = [p(0, 0), p(1, 0), p(1, 1)]; // runs the other way round
  const rings = assembleRings([a, b, [p(5, 5), p(6, 6)]]);
  assert.equal(rings.length, 1, 'the open leftover is dropped');
  assert.equal(rings[0].length, 5);
  assert.deepEqual(rings[0][0], rings[0].at(-1));
});

test('a synthetic Overpass download becomes stored map documents', () => {
  const osm = syntheticOverpass({ lat: C.lat, lon: C.lon });
  const res = osmToBasemap(osm, { areas: [[C.lat - 0.03, C.lon - 0.03, C.lat + 0.03, C.lon + 0.03]] });
  assert.ok(res.chunks.length >= 1);
  for (const ch of res.chunks) assert.ok(JSON.stringify(ch).length < 240 * 1024, 'each document fits the store');
  const map = decodeBasemap(res.chunks);
  // 16 + 16 grid streets: 4 secondary + 4 primary are major, the rest minor; the tunnel and sidewalk are left out.
  assert.equal(map.lines.major.length, 8);
  assert.equal(map.lines.minor.length, 24);
  assert.equal(map.lines.path.length, 2, 'footway and cycleway; the sidewalk is skipped');
  assert.equal(map.lines.river.length, 1);
  assert.equal(map.lines.stream.length, 1);
  assert.equal(map.lines.rail.length, 1, 'the subway tunnel is skipped');
  assert.equal(map.fills.water.length, 1);
  assert.equal(map.fills.water[0].length, 2, 'the lake keeps its island as a hole');
  assert.equal(map.fills.park.length, 1);
  assert.equal(map.fills.wood.length, 1);
  assert.equal(map.fills.pitch.length, 1);
  assert.equal(res.counts.lines, 37);
  // Labels: places, one per street name, the lake and the park.
  const names = map.labels.map((l) => l[0]);
  assert.ok(names.includes('Centro Sample') && names.includes('Sample Town'));
  assert.ok(names.includes('Sample Lake') && names.includes('Test Park'));
  assert.equal(names.filter((n) => n === 'Alder Street').length, 2, 'repeated names far apart keep a label each');
  assert.ok(!names.includes('Underpass'));
  const road = map.labels.find((l) => l[0] === 'Fir Street');
  assert.equal(road[3], 'road');
  assert.ok(Math.abs(Math.abs(road[5]) - Math.PI / 2) < 0.02, 'a north–south street is labelled vertically');
  // Decoded points stay within a couple of metres of the source.
  const src = osm.elements.find((e) => e.tags?.name === 'Fir Street').geometry;
  const back = map.lines.minor.find((pts) => haversine(pts[0].lat, pts[0].lon, src[0].lat, src[0].lon) < 3);
  assert.ok(back, 'the street comes back');
  assert.ok(haversine(back.at(-1).lat, back.at(-1).lon, src.at(-1).lat, src.at(-1).lon) < 3);
  // Coverage: the requested box counts, the far town alone does not widen it much.
  assert.ok(res.cells.includes(boxCells([C.lat, C.lon, C.lat, C.lon])[0]));
  assert.ok(res.bbox[0] <= C.lat && res.bbox[2] >= C.lat);
});

test('GeoJSON from overpass-turbo works too', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { highway: 'residential', name: 'Plain Street' }, geometry: { type: 'LineString', coordinates: [[20, 10], [20.001, 10.002], [20.002, 10.004]] } },
      {
        type: 'Feature', properties: { tags: { natural: 'water' } },
        geometry: { type: 'Polygon', coordinates: [[[20, 10], [20.01, 10], [20.01, 10.01], [20, 10.01], [20, 10]], [[20.004, 10.004], [20.006, 10.004], [20.006, 10.006], [20.004, 10.004]]] },
      },
      { type: 'Feature', properties: { place: 'village', name: 'Plainville' }, geometry: { type: 'Point', coordinates: [20.003, 10.003] } },
    ],
  };
  const map = decodeBasemap(osmToBasemap(fc).chunks);
  assert.equal(map.lines.minor.length, 1);
  assert.equal(map.fills.water[0].length, 2);
  assert.ok(map.labels.some((l) => l[0] === 'Plainville' && l[3] === 'place'));
});

test('bad files explain themselves', () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(code(() => parseMapText('<html><body>Too many requests</body></html>')), 'server_page');
  assert.equal(code(() => parseMapText('not json')), 'not_json');
  assert.equal(code(() => osmToBasemap({ hello: 1 })), 'not_osm');
  assert.equal(code(() => osmToBasemap({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1' })), 'server_error');
  assert.equal(code(() => osmToBasemap({ elements: [{ type: 'node', lat: 1, lon: 1, tags: {} }] })), 'empty');
  assert.deepEqual(parseMapText(' {"elements":[]}'), { elements: [] });
});

test('nearest place: a neighbourhood nearby, else the town', () => {
  const labels = [
    ['Old Quarter', 10.001, 20.001, 'place', 4],
    ['Big Town', 10.0, 20.0, 'place', 2],
    ['Far Village', 10.2, 20.2, 'place', 3],
    ['Main Road', 10.0, 20.0, 'road', 3, 0],
  ];
  assert.equal(nearestPlace(10.0005, 20.0005, labels), 'Old Quarter');
  assert.equal(nearestPlace(10.04, 20.04, labels), 'Big Town', 'no neighbourhood within 1.5 km');
  assert.equal(nearestPlace(11, 21, labels), null);
});

test('a large download splits into several documents', () => {
  // 3000 winding lanes that simplification can't flatten.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const elements = Array.from({ length: 3000 }, (_, k) => {
    let lat = C.lat + rnd() * 0.2, lon = C.lon + rnd() * 0.2;
    const geometry = Array.from({ length: 60 }, () => ({ lat: (lat += (rnd() - 0.5) * 0.002), lon: (lon += (rnd() - 0.5) * 0.002) }));
    return { type: 'way', id: k + 1, tags: { highway: 'residential' }, geometry };
  });
  const res = osmToBasemap({ elements });
  assert.ok(res.chunks.length > 1, `${res.chunks.length} chunks`);
  for (const ch of res.chunks) assert.ok(JSON.stringify(ch).length < 240 * 1024);
  assert.equal(decodeBasemap(res.chunks).lines.minor.length, 3000);
});
