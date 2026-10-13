// OpenStreetMap map data, drawn by the page under the routes.
//
// The page can't load map tiles: claude.ai's CSP blocks images and fetches
// from other hosts. So the map is drawn from OpenStreetMap data the user
// downloads once from the Overpass API (a link the page builds for the area
// around their routes) and keeps in private storage.
//
//   mapAreas(workouts) → overpassUrl(overpassQuery(areas))   the download link
//   osmToBasemap(json) → {chunks, cells, counts}            a downloaded file
//   decodeBasemap(chunks) → {lines, fills, labels}           ready to draw
//
// Map data © OpenStreetMap contributors, available under the ODbL.

import { encodePolyline, decodePolyline, simplifyBy, haversine } from './geo.js';

export const MAP_ATTRIBUTION = '© OpenStreetMap contributors';
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const BASEMAP_VERSION = 1;

export const LINE_CLASSES = ['stream', 'river', 'path', 'rail', 'minor', 'major', 'motorway'];
export const FILL_CLASSES = ['wood', 'park', 'pitch', 'water'];

const KM_PER_DEG = 111.32;
const CELL = 0.01; // coverage grid in degrees, about 1.1 × 0.8 km in Europe
const CELL_MIN_POINTS = 3; // vertices that make a cell count as covered
const RING_MAX_CHARS = 60000; // a bigger ring (a large lake) is simplified harder
const CHUNK_CHARS = 200 * 1024; // stored documents stay under the store's 240 KB
const SIMPLIFY_M = 2;

export class MapFileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------ areas

const cellIndex = (v) => Math.floor(v / CELL + 1e-9);

/** Coverage cell keys of a box [s, w, n, e]. */
export function boxCells([s, w, n, e]) {
  const out = [];
  for (let i = cellIndex(s); i <= cellIndex(n); i++) {
    for (let j = cellIndex(w); j <= cellIndex(e); j++) out.push(`${i}_${j}`);
  }
  return out;
}

/** The box [s, w, n, e] that a set of cell keys spans. */
export function cellsBox(cells) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const key of cells) {
    const [i, j] = key.split('_').map(Number);
    s = Math.min(s, i * CELL); n = Math.max(n, (i + 1) * CELL);
    w = Math.min(w, j * CELL); e = Math.max(e, (j + 1) * CELL);
  }
  return Number.isFinite(s) ? [s, w, n, e].map((v) => Math.round(v * 1000) / 1000) : null;
}

/** Approximate area of a box [s, w, n, e] in km². */
export function areaKm2([s, w, n, e]) {
  return (n - s) * KM_PER_DEG * (e - w) * KM_PER_DEG * Math.cos((((s + n) / 2) * Math.PI) / 180);
}

/** A workout's stored bbox ([minLat, minLon, maxLat, maxLon]) as [s, w, n, e], or null. */
const boxOf = (wk) => (Array.isArray(wk?.bbox) && wk.bbox.length === 4 && wk.bbox.every(Number.isFinite) ? wk.bbox.slice() : null);

/** Share (0–1) of a workout's box that the map's cells cover; null without GPS. */
export function workoutCoverage(wk, cells) {
  const box = boxOf(wk);
  if (!box) return null;
  const keys = boxCells(box);
  const have = cells instanceof Set ? cells : new Set(cells || []);
  return keys.filter((k) => have.has(k)).length / keys.length;
}

const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const join = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/**
 * Boxes [s, w, n, e] to download: each GPS workout's box grown by `bufferKm`,
 * overlapping boxes merged, and workouts the stored map already covers
 * (`cells`) left out. A trip far from the rest gets its own small box.
 */
export function mapAreas(workouts, { bufferKm = 1, cells = null } = {}) {
  const have = cells ? new Set(cells) : null;
  const boxes = [];
  for (const wk of workouts) {
    const box = boxOf(wk);
    if (!box || (have && workoutCoverage(wk, have) >= 0.9)) continue;
    const [s, w, n, e] = box;
    const dLat = bufferKm / KM_PER_DEG;
    const dLon = bufferKm / (KM_PER_DEG * Math.cos((((s + n) / 2) * Math.PI) / 180));
    boxes.push([s - dLat, w - dLon, n + dLat, e + dLon]);
  }
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (overlaps(boxes[i], boxes[j])) {
          boxes[i] = join(boxes[i], boxes[j]);
          boxes.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  const down = (v) => Math.floor(v * 1000) / 1000, up = (v) => Math.ceil(v * 1000) / 1000;
  return boxes.map(([s, w, n, e]) => [down(s), down(w), up(n), up(e)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// ------------------------------------------------------------------ the download

const HIGHWAY = 'way["highway"]["highway"!~"^(proposed|construction|abandoned|platform|raceway|bus_stop|elevator|corridor|services|rest_area)$"]["area"!="yes"]["footway"!~"^(sidewalk|crossing)$"]["service"!~"^(parking_aisle|driveway|drive-through)$"]';
// Few statements per box keep the link short (the server refuses URLs over about 8 KB).
const FILTERS = [
  HIGHWAY,
  'way["railway"~"^(rail|light_rail|narrow_gauge|tram|subway)$"]',
  'way["waterway"~"^(river|canal|stream|riverbank)$"]',
  'way[~"^(natural|landuse|leisure)$"~"^(water|wood|scrub|beach|forest|grass|meadow|recreation_ground|village_green|cemetery|reservoir|basin|park|garden|nature_reserve|pitch|track|golf_course)$"]',
  'relation["type"="multipolygon"][~"^(natural|landuse|leisure|waterway)$"~"^(water|wood|forest|reservoir|park|nature_reserve|garden|riverbank)$"]',
  'node["place"~"^(city|town|village|suburb|quarter|neighbourhood|hamlet)$"]["name"]',
];

/** Overpass QL for streets, paths, rail, water, green areas and place names in the boxes. */
export function overpassQuery(areas) {
  if (!areas?.length) throw new MapFileError('no_area', 'There is no area to download.');
  const body = areas.flatMap((a) => FILTERS.map((f) => `${f}(${a.map((v) => v.toFixed(3)).join(',')});`)).join('');
  return `[out:json][timeout:180];(${body});out geom qt;`;
}

export const overpassUrl = (query) => `${OVERPASS_URL}?data=${encodeURIComponent(query)}`;

// ------------------------------------------------------------------ reading a file

const ROAD = {
  motorway: 'motorway', motorway_link: 'motorway', trunk: 'motorway', trunk_link: 'motorway',
  primary: 'major', primary_link: 'major', secondary: 'major', secondary_link: 'major',
  tertiary: 'minor', tertiary_link: 'minor', unclassified: 'minor', residential: 'minor', living_street: 'minor',
  service: 'minor', road: 'minor', pedestrian: 'minor', busway: 'minor',
  footway: 'path', path: 'path', cycleway: 'path', bridleway: 'path', track: 'path', steps: 'path',
};
const NAMED_ROADS = { motorway: 2, major: 3, minor: 4 };
const PLACE_RANK = { city: 1, town: 2, village: 3, suburb: 3, quarter: 4, neighbourhood: 4, hamlet: 5 };
const isYes = (v) => Boolean(v) && v !== 'no';

/** {line: class} or {fill: class} for an OSM feature's tags, or null when it isn't drawn. */
export function classify(tags = {}) {
  if (ROAD[tags.highway]) {
    if (isYes(tags.tunnel) || tags.area === 'yes') return null;
    if (tags.footway === 'sidewalk' || tags.footway === 'crossing') return null;
    if (tags.service === 'parking_aisle' || tags.service === 'driveway') return null;
    return { line: ROAD[tags.highway] };
  }
  if (/^(rail|light_rail|narrow_gauge|tram|subway)$/.test(tags.railway || '')) return isYes(tags.tunnel) ? null : { line: 'rail' };
  if (tags.waterway === 'river' || tags.waterway === 'canal') return isYes(tags.tunnel) ? null : { line: 'river' };
  if (tags.waterway === 'stream') return isYes(tags.tunnel) ? null : { line: 'stream' };
  if (tags.waterway === 'riverbank' || tags.natural === 'water' || /^(reservoir|basin)$/.test(tags.landuse || '')) return { fill: 'water' };
  if (tags.landuse === 'forest' || /^(wood|scrub)$/.test(tags.natural || '')) return { fill: 'wood' };
  if (/^(park|garden|nature_reserve|golf_course)$/.test(tags.leisure || '') || /^(grass|meadow|recreation_ground|village_green|cemetery)$/.test(tags.landuse || '')) return { fill: 'park' };
  if (/^(pitch|track)$/.test(tags.leisure || '') || tags.natural === 'beach') return { fill: 'pitch' };
  return null;
}

const same = (a, b) => a.lat === b.lat && a.lon === b.lon;
const toPoint = (g) => (g && Number.isFinite(g.lat) && Number.isFinite(g.lon) ? { lat: g.lat, lon: g.lon } : null);

/** Join the member ways of a multipolygon into closed rings (open leftovers are dropped). */
export function assembleRings(ways) {
  const pool = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.shift();
    for (let grown = true; grown && !same(ring[0], ring.at(-1));) {
      grown = false;
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i];
        if (same(ring.at(-1), w[0])) ring = ring.concat(w.slice(1));
        else if (same(ring.at(-1), w.at(-1))) ring = ring.concat(w.slice(0, -1).reverse());
        else if (same(ring[0], w.at(-1))) ring = w.slice(0, -1).concat(ring);
        else if (same(ring[0], w[0])) ring = w.slice(1).reverse().concat(ring);
        else continue;
        pool.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring.at(-1))) rings.push(ring);
  }
  return rings;
}

/** Ray-casting point-in-polygon test on lat/lon. */
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}

/** Overpass JSON elements (`out geom`) → [{kind: 'line'|'area'|'point', tags, geom}]. */
function overpassFeatures(elements) {
  const out = [];
  for (const el of elements) {
    const tags = el?.tags || {};
    if (el?.type === 'node') {
      const p = toPoint(el);
      if (p && tags.place) out.push({ kind: 'point', tags, geom: p });
    } else if (el?.type === 'way') {
      const pts = (el.geometry || []).map(toPoint).filter(Boolean);
      if (pts.length < 2) continue;
      const closed = pts.length >= 4 && same(pts[0], pts.at(-1));
      out.push(closed && classify(tags)?.fill ? { kind: 'area', tags, geom: [pts] } : { kind: 'line', tags, geom: pts });
    } else if (el?.type === 'relation' && tags.type === 'multipolygon') {
      const outer = [], inner = [];
      for (const m of el.members || []) {
        if (m.type !== 'way') continue;
        const pts = (m.geometry || []).map(toPoint).filter(Boolean);
        if (pts.length >= 2) (m.role === 'inner' ? inner : outer).push(pts);
      }
      const holes = assembleRings(inner);
      for (const ring of assembleRings(outer)) out.push({ kind: 'area', tags, geom: [ring, ...holes.filter((h) => inRing(h[0], ring))] });
    }
  }
  return out;
}

/** GeoJSON features (for example overpass-turbo's export) → the same shape. */
function geojsonFeatures(features) {
  const out = [];
  const ll = (c) => (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? { lat: c[1], lon: c[0] } : null);
  const line = (cs) => (cs || []).map(ll).filter(Boolean);
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    const props = f.properties || {};
    const tags = props.tags && typeof props.tags === 'object' ? props.tags : props;
    if (g.type === 'Point') {
      const p = ll(g.coordinates);
      if (p && tags.place) out.push({ kind: 'point', tags, geom: p });
    } else if (g.type === 'LineString') out.push({ kind: 'line', tags, geom: line(g.coordinates) });
    else if (g.type === 'MultiLineString') for (const cs of g.coordinates || []) out.push({ kind: 'line', tags, geom: line(cs) });
    else if (g.type === 'Polygon') out.push({ kind: 'area', tags, geom: (g.coordinates || []).map(line) });
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates || []) out.push({ kind: 'area', tags, geom: poly.map(line) });
  }
  return out;
}

/** Parse a downloaded file's text, with copy that says what went wrong. */
export function parseMapText(text) {
  const head = String(text || '').trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith('<')) {
    throw new MapFileError('server_page', "OpenStreetMap's server sent an error page instead of map data. It may be busy: try the download again in a minute.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MapFileError('not_json', "That file isn't map data from OpenStreetMap. Use Download map data, save what opens, then add that file.");
  }
}

// ------------------------------------------------------------------ converting

const r5 = (v) => Math.round(v * 1e5) / 1e5;

/** Screen angle (radians, y down) of a segment, kept upright for text. */
function textAngle(a, b) {
  const dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), dy = b.lat - a.lat;
  let ang = Math.atan2(-dy, dx);
  if (ang > Math.PI / 2) ang -= Math.PI;
  if (ang <= -Math.PI / 2) ang += Math.PI;
  return Math.round(ang * 100) / 100;
}

/** Where to write a road's name: on the segment at its halfway point, or its longest when that one is short. */
function roadLabel(name, pts, cls) {
  const segs = [];
  let total = 0, longest = null;
  for (let i = 1; i < pts.length; i++) {
    const seg = { i, from: total, d: haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon) };
    segs.push(seg);
    total += seg.d;
    if (!longest || seg.d > longest.d) longest = seg;
  }
  const mid = segs.find((seg) => seg.from + seg.d >= total / 2) || longest;
  const pick = mid.d >= longest.d * 0.3 ? mid : longest;
  const a = pts[pick.i - 1], b = pts[pick.i];
  return { name, total, label: [name, r5((a.lat + b.lat) / 2), r5((a.lon + b.lon) / 2), 'road', NAMED_ROADS[cls], textAngle(a, b)] };
}

/** One label per road name within 400 m, from the longest piece. */
function dedupeRoadLabels(candidates) {
  const byName = new Map();
  const out = [];
  for (const c of candidates.sort((a, b) => b.total - a.total)) {
    const kept = byName.get(c.name) || [];
    if (kept.some((k) => haversine(c.label[1], c.label[2], k[1], k[2]) < 400)) continue;
    kept.push(c.label);
    byName.set(c.name, kept);
    out.push(c.label);
  }
  return out;
}

/** Encode a ring, simplifying harder while it is too large for one document. */
function encodeRing(ring, eps) {
  let enc = '';
  for (const tol of [eps, eps * 4, eps * 15, eps * 50]) {
    const kept = simplifyBy(ring, tol);
    if (kept.length < 4) return null;
    enc = encodePolyline(kept);
    if (enc.length <= RING_MAX_CHARS) return enc;
  }
  return enc.length <= RING_MAX_CHARS * 2 ? enc : null;
}

/** Split encoded features into documents of at most CHUNK_CHARS. */
function toChunks(lines, fills, labels) {
  const chunks = [];
  let cur = null, size = 0;
  const start = () => {
    cur = { kind: 'basemap', v: BASEMAP_VERSION, lines: {}, fills: {}, labels: [] };
    size = 0;
    chunks.push(cur);
  };
  const add = (bucket, cls, item, len) => {
    if (!cur || (size + len > CHUNK_CHARS && size > 0)) start();
    if (cls) (cur[bucket][cls] ||= []).push(item);
    else cur[bucket].push(item);
    size += len;
  };
  for (const cls of FILL_CLASSES) for (const poly of fills[cls]) add('fills', cls, poly, poly.reduce((n, ring) => n + ring.length * 1.1 + 3, 2));
  for (const cls of LINE_CLASSES) for (const p of lines[cls]) add('lines', cls, p, p.length * 1.1 + 3);
  for (const l of labels) add('labels', null, l, JSON.stringify(l).length + 1);
  return chunks;
}

/**
 * A downloaded file (Overpass JSON or GeoJSON) → map documents to store.
 * Returns {chunks, cells, bbox, counts}. `cells` lists the ~1 km grid cells
 * the data covers: those holding map points, plus every cell of a requested
 * box (`areas`) the file has data in, so sparse countryside still counts.
 */
export function osmToBasemap(input, { simplifyM = SIMPLIFY_M, areas = [] } = {}) {
  let features;
  if (Array.isArray(input?.elements)) {
    const remark = String(input.remark || '');
    if (/error|timed out|out of memory/i.test(remark)) {
      throw new MapFileError('server_error', `OpenStreetMap's server stopped before finishing (it said: ${remark.slice(0, 160)}). Try again later, or download a smaller area.`);
    }
    features = overpassFeatures(input.elements);
  } else if (input?.type === 'FeatureCollection' && Array.isArray(input.features)) {
    features = geojsonFeatures(input.features);
  } else {
    throw new MapFileError('not_osm', "That file isn't map data from OpenStreetMap. Use Download map data, save what opens, then add that file.");
  }

  const lines = Object.fromEntries(LINE_CLASSES.map((c) => [c, []]));
  const fills = Object.fromEntries(FILL_CLASSES.map((c) => [c, []]));
  const labels = [], roads = [];
  const cellPoints = new Map();
  let points = 0;
  const count = (pts) => {
    for (const p of pts) {
      const key = `${cellIndex(p.lat)}_${cellIndex(p.lon)}`;
      cellPoints.set(key, (cellPoints.get(key) || 0) + 1);
    }
  };
  const addLine = (cls, pts) => {
    const kept = simplifyBy(pts, simplifyM);
    if (kept.length < 2) return;
    lines[cls].push(encodePolyline(kept));
    points += kept.length;
    count(pts);
  };

  for (const f of features) {
    if (f.kind === 'point') {
      const rank = PLACE_RANK[f.tags.place];
      if (rank && f.tags.name) labels.push([f.tags.name, r5(f.geom.lat), r5(f.geom.lon), 'place', rank]);
      continue;
    }
    const cls = classify(f.tags);
    if (!cls) continue;
    if (cls.line) {
      const pts = f.kind === 'area' ? f.geom[0] : f.geom;
      if (!pts || pts.length < 2) continue;
      addLine(cls.line, pts);
      if (f.tags.name && NAMED_ROADS[cls.line]) roads.push(roadLabel(f.tags.name, pts, cls.line));
    } else if (f.kind === 'area') {
      const outerRing = f.geom[0];
      if (!outerRing || outerRing.length < 4 || !same(outerRing[0], outerRing.at(-1))) continue;
      const rings = f.geom.filter((ring) => ring.length >= 4 && same(ring[0], ring.at(-1))).map((ring) => encodeRing(ring, simplifyM));
      if (!rings[0]) continue;
      fills[cls.fill].push(rings.filter(Boolean));
      points += f.geom.reduce((n, ring) => n + ring.length, 0);
      count(outerRing);
      const outer = f.geom[0];
      if (f.tags.name && (cls.fill === 'water' || cls.fill === 'park' || cls.fill === 'wood')) {
        const lat = outer.reduce((s, p) => s + p.lat, 0) / outer.length, lon = outer.reduce((s, p) => s + p.lon, 0) / outer.length;
        const lats = outer.map((p) => p.lat), lons = outer.map((p) => p.lon);
        const size = haversine(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons));
        if (size >= 200) labels.push([f.tags.name, r5(lat), r5(lon), cls.fill === 'water' ? 'water' : 'park', 4]);
      }
    } else if (f.tags.leisure === 'track') {
      addLine('path', f.geom); // a running track drawn as a line
    }
  }
  labels.push(...dedupeRoadLabels(roads));

  const lineCount = LINE_CLASSES.reduce((n, c) => n + lines[c].length, 0);
  const fillCount = FILL_CLASSES.reduce((n, c) => n + fills[c].length, 0);
  if (!lineCount && !fillCount) {
    throw new MapFileError('empty', 'This file has no streets, paths or water in it. Download the map data again from the Map card.');
  }
  const covered = new Set([...cellPoints].filter(([, n]) => n >= CELL_MIN_POINTS).map(([key]) => key));
  for (const a of areas || []) {
    const keys = boxCells(a);
    if (keys.some((k) => cellPoints.has(k))) for (const k of keys) covered.add(k);
  }
  const cells = [...covered].sort();
  return {
    chunks: toChunks(lines, fills, labels),
    cells,
    bbox: cellsBox(cells),
    counts: { lines: lineCount, fills: fillCount, labels: labels.length, points },
  };
}

// ------------------------------------------------------------------ using it

/** Stored map documents → {lines: {class: [[{lat, lon}]]}, fills: {class: [[ring…]]}, labels}. */
export function decodeBasemap(chunks) {
  const out = {
    lines: Object.fromEntries(LINE_CLASSES.map((c) => [c, []])),
    fills: Object.fromEntries(FILL_CLASSES.map((c) => [c, []])),
    labels: [],
  };
  for (const ch of chunks || []) {
    if (ch?.kind !== 'basemap') continue;
    for (const [cls, list] of Object.entries(ch.lines || {})) if (out.lines[cls]) for (const p of list) out.lines[cls].push(decodePolyline(p));
    for (const [cls, list] of Object.entries(ch.fills || {})) if (out.fills[cls]) for (const poly of list) out.fills[cls].push(poly.map((ring) => decodePolyline(ring)));
    for (const l of ch.labels || []) if (Array.isArray(l) && typeof l[0] === 'string') out.labels.push(l);
  }
  return out;
}

/**
 * The place a point is in: the nearest suburb, neighbourhood or village within
 * `fineKm` (suburbs are large), else the nearest town or city within `coarseKm`.
 */
export function nearestPlace(lat, lon, labels, { fineKm = 2.5, coarseKm = 8 } = {}) {
  let fine = null, fineD = fineKm * 1000, coarse = null, coarseD = coarseKm * 1000;
  for (const l of labels || []) {
    if (l[3] !== 'place') continue;
    const d = haversine(lat, lon, l[1], l[2]);
    if (l[4] >= 3) {
      if (d < fineD) { fine = l[0]; fineD = d; }
    } else if (d < coarseD) {
      coarse = l[0];
      coarseD = d;
    }
  }
  return fine || coarse;
}
