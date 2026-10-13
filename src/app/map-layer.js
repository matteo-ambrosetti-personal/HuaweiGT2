// Draws the stored OpenStreetMap data on a canvas under the routes: fills,
// then rivers, paths, rail and roads in the map's base coordinates (the
// caller has set the zoom transform), then labels and the attribution in
// screen space. Line widths follow the ground (metres), within pixel limits.

import { MAP_ATTRIBUTION, FILL_CLASSES, LINE_CLASSES } from '../lib/basemap.js';

const FILL_TOKEN = { wood: '--map-wood', park: '--map-park', pitch: '--map-pitch', water: '--map-water' };

// m: width on the ground; lo/hi: pixel limits; minPpm: hidden below this many screen px per metre.
const LINE = {
  stream: { token: '--map-water', m: 3, lo: 0.6, hi: 3, minPpm: 0.05 },
  river: { token: '--map-water', m: 14, lo: 1.2, hi: 10, minPpm: 0 },
  path: { token: '--map-path', m: 2.5, lo: 0.7, hi: 2.4, minPpm: 0.12, dash: [3, 2.5] },
  rail: { token: '--map-rail', m: 3, lo: 0.8, hi: 2.2, minPpm: 0, dash: [6, 4] },
  minor: { token: '--map-road', m: 8, lo: 0.6, hi: 10, minPpm: 0.02 },
  major: { token: '--map-road-major', m: 12, lo: 1.1, hi: 13, minPpm: 0 },
  motorway: { token: '--map-road-major', m: 18, lo: 1.6, hi: 16, minPpm: 0 },
};
const ROADS = ['minor', 'major', 'motorway'];

/** Label priority: lower draws first and wins collisions. */
function priority(l) {
  if (l.kind === 'place') return [0, 1, 3, 3, 5, 7][l.rank] ?? 7;
  if (l.kind === 'road') return { 2: 2, 3: 4, 4: 8 }[l.rank] ?? 8;
  return 6;
}

/** Path2D per class in base coordinates, built once per projection. */
export function prepareBasemap(map, project) {
  const trace = (path, pts, close) => {
    pts.forEach((p, i) => {
      const [x, y] = project(p.lat, p.lon);
      if (i) path.lineTo(x, y);
      else path.moveTo(x, y);
    });
    if (close) path.closePath();
  };
  const fills = {}, lines = {};
  for (const cls of FILL_CLASSES) {
    const path = new Path2D();
    for (const poly of map.fills[cls] || []) for (const ring of poly) trace(path, ring, true);
    fills[cls] = path;
  }
  for (const cls of LINE_CLASSES) {
    const path = new Path2D();
    for (const pts of map.lines[cls] || []) trace(path, pts, false);
    lines[cls] = path;
  }
  const labels = (map.labels || [])
    .map(([text, lat, lon, kind, rank, angle]) => ({ text, kind, rank, angle: kind === 'road' ? angle || 0 : 0, at: project(lat, lon) }))
    .sort((a, b) => priority(a) - priority(b));
  return { fills, lines, labels, widths: new Map() };
}

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim() || '#888';
  const out = { casing: v('--map-casing'), label: v('--map-label'), waterLabel: v('--map-water-label'), halo: v('--map-halo'), font: v('--font-ui') || 'system-ui, sans-serif' };
  for (const [cls, token] of Object.entries(FILL_TOKEN)) out[cls] = v(token);
  for (const [cls, s] of Object.entries(LINE)) out[`line-${cls}`] = v(s.token);
  return out;
}

const widthAt = (s, ppm) => Math.min(s.hi, Math.max(s.lo, s.m * ppm));

/**
 * Fills and lines. The context's transform must map base coordinates to
 * device pixels at zoom k; ppm is screen pixels per metre at that zoom.
 */
export function drawBasemap(ctx, prep, { k, ppm }) {
  const pal = palette();
  ctx.save();
  for (const cls of FILL_CLASSES) {
    ctx.fillStyle = pal[cls];
    ctx.fill(prep.fills[cls], 'evenodd');
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = pal.casing;
  for (const cls of ROADS) {
    const s = LINE[cls], w = widthAt(s, ppm);
    if (ppm < s.minPpm || w < 2) continue;
    ctx.lineWidth = (w + 1.6) / k;
    ctx.stroke(prep.lines[cls]);
  }
  for (const cls of LINE_CLASSES) {
    const s = LINE[cls], w = widthAt(s, ppm);
    if (ppm < s.minPpm) continue;
    ctx.strokeStyle = pal[`line-${cls}`];
    ctx.lineWidth = w / k;
    ctx.setLineDash(s.dash && w >= 0.9 ? s.dash.map((d) => (d * Math.max(1, w / 1.5)) / k) : []);
    ctx.stroke(prep.lines[cls]);
  }
  ctx.restore();
}

/** Which labels show at a zoom level, and how. */
function labelStyle(l, ppm, font) {
  if (l.kind === 'place') {
    if (l.rank <= 2) return { font: `600 13px ${font}`, size: 13 };
    if (l.rank === 3) return ppm >= 0.015 ? { font: `600 12px ${font}`, size: 12 } : null;
    return ppm >= 0.06 ? { font: `500 10.5px ${font}`, size: 10.5, upper: true } : null;
  }
  if (l.kind === 'road') {
    if (l.rank <= 3) return ppm >= 0.12 ? { font: `500 11px ${font}`, size: 11 } : null;
    return ppm >= 0.45 ? { font: `11px ${font}`, size: 11 } : null;
  }
  return ppm >= 0.25 ? { font: `italic 11px ${font}`, size: 11, water: l.kind === 'water' } : null;
}

/**
 * Labels (greedy, no overlaps) and the attribution, in screen space.
 * t is the zoom transform, width/hgt the canvas size in CSS pixels.
 */
export function drawLabels(ctx, prep, { t, ppm, width, hgt, dpr }) {
  const pal = palette();
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'round';
  // Attribution first, so labels keep clear of it.
  ctx.font = `10px ${pal.font}`;
  const aw = ctx.measureText(MAP_ATTRIBUTION).width;
  const placed = [{ x: width - aw - 10, y: hgt - 18, w: aw + 10, h: 18 }];
  const free = (r) => r.x >= 2 && r.y >= 2 && r.x + r.w <= width - 2 && r.y + r.h <= hgt - 2
    && !placed.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of prep.labels) {
    const style = labelStyle(l, ppm, pal.font);
    if (!style) continue;
    const x = l.at[0] * t.k + t.x, y = l.at[1] * t.k + t.y;
    if (x < -150 || x > width + 150 || y < -40 || y > hgt + 40) continue;
    const text = style.upper ? l.text.toUpperCase() : l.text;
    ctx.font = style.font;
    const key = `${style.font}|${text}`;
    let w = prep.widths.get(key);
    if (w == null) {
      w = ctx.measureText(text).width;
      prep.widths.set(key, w);
    }
    const hh = style.size + 4, a = l.angle;
    const bw = Math.abs(w * Math.cos(a)) + Math.abs(hh * Math.sin(a)), bh = Math.abs(w * Math.sin(a)) + Math.abs(hh * Math.cos(a));
    const box = { x: x - bw / 2 - 3, y: y - bh / 2 - 3, w: bw + 6, h: bh + 6 };
    if (!free(box)) continue;
    placed.push(box);
    ctx.save();
    ctx.translate(x, y);
    if (a) ctx.rotate(a);
    ctx.strokeStyle = pal.halo;
    ctx.lineWidth = 3;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = style.water ? pal.waterLabel : pal.label;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  ctx.font = `10px ${pal.font}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.strokeStyle = pal.halo;
  ctx.lineWidth = 3;
  ctx.strokeText(MAP_ATTRIBUTION, width - 6, hgt - 4);
  ctx.fillStyle = pal.label;
  ctx.fillText(MAP_ATTRIBUTION, width - 6, hgt - 4);
  ctx.restore();
}
