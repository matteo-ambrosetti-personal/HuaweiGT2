// Geometry helpers for GPS tracks.

const R = 6371008.8; // mean Earth radius, metres
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Bounding box of [{lat, lon}] → {minLat, maxLat, minLon, maxLon} or null. */
export function bbox(points) {
  if (!points.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

// Perpendicular distance in a local equirectangular projection (metres).
function segDistance(p, a, b, cosLat) {
  const ax = a.lon * cosLat, ay = a.lat;
  const bx = b.lon * cosLat, by = b.lat;
  const px = p.lon * cosLat, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  let t = 0;
  const len2 = dx * dx + dy * dy;
  if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy) * 111320;
}

/** Douglas–Peucker indices to keep for tolerance `eps` metres (iterative). */
function dpIndices(points, eps) {
  const n = points.length;
  if (n <= 2) return points.map((_, i) => i);
  const cosLat = Math.cos(toRad(points[0].lat));
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDistance(points[i], points[s], points[e], cosLat);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Simplify to at most `maxPoints` points, returning the kept points. */
export function simplify(points, maxPoints) {
  if (points.length <= maxPoints) return points.slice();
  let lo = 0, hi = 2000, best = null;
  for (let iter = 0; iter < 24; iter++) {
    const mid = (lo + hi) / 2;
    const idx = dpIndices(points, mid);
    if (idx.length > maxPoints) lo = mid;
    else { best = idx; hi = mid; }
  }
  if (!best) {
    // Fall back to even sampling.
    const step = (points.length - 1) / (maxPoints - 1);
    best = Array.from({ length: maxPoints }, (_, i) => Math.round(i * step));
  }
  return best.map((i) => points[i]);
}

/** Google encoded polyline of [{lat, lon}] (precision 1e5). */
export function encodePolyline(points, precision = 5) {
  const f = 10 ** precision;
  let out = '';
  let pLat = 0, pLon = 0;
  const enc = (v) => {
    let s = v < 0 ? ~(v << 1) : v << 1;
    let r = '';
    while (s >= 0x20) {
      r += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
      s >>= 5;
    }
    return r + String.fromCharCode(s + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * f);
    const lon = Math.round(p.lon * f);
    out += enc(lat - pLat) + enc(lon - pLon);
    pLat = lat;
    pLon = lon;
  }
  return out;
}

export function decodePolyline(str, precision = 5) {
  const f = 10 ** precision;
  const out = [];
  let i = 0, lat = 0, lon = 0;
  const dec = () => {
    let result = 0, shift = 0, b;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i <= str.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += dec();
    lon += dec();
    out.push({ lat: lat / f, lon: lon / f });
  }
  return out;
}

/** Web-Mercator y for a latitude (unitless). */
export function mercY(lat) {
  const r = toRad(Math.max(-85, Math.min(85, lat)));
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
}

/**
 * Project lat/lon points into a w×h box with padding, preserving aspect.
 * Returns {project(lat, lon) → [x, y], scale (px per metre)}.
 */
export function fitProjection(bounds, w, h, pad = 8) {
  const x0 = toRad(bounds.minLon), x1 = toRad(bounds.maxLon);
  const y0 = mercY(bounds.minLat), y1 = mercY(bounds.maxLat);
  const spanX = Math.max(x1 - x0, 1e-9), spanY = Math.max(y1 - y0, 1e-9);
  const k = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const offX = (w - spanX * k) / 2, offY = (h - spanY * k) / 2;
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  // At latitude φ one metre spans 1 / (R·cos φ) projected units on both axes.
  const pxPerMetre = k / (R * Math.max(Math.cos(toRad(midLat)), 1e-6));
  return {
    project: (lat, lon) => [offX + (toRad(lon) - x0) * k, h - (offY + (mercY(lat) - y0) * k)],
    pxPerMetre,
  };
}
