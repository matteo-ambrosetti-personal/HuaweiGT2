// Synthetic OpenStreetMap data in the Overpass `out geom` JSON shape, for
// tests and the demo fixture: a named street grid, a river, a railway,
// footpaths, a park, a running track, a lake with an island (a multipolygon
// relation) and place names. Everything is made up; only the shape is real.

const STREETS = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Gum', 'Hazel', 'Ivy', 'Juniper', 'Kapok', 'Larch'];
const AVENUES = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth'];

/** Overpass JSON centred on lat/lon, `spanKm` wide, street grid every `stepKm`. */
export function syntheticOverpass({ lat = 45.4642, lon = 9.19, spanKm = 6, stepKm = 0.4 } = {}) {
  const kmLat = 1 / 111.32, kmLon = 1 / (111.32 * Math.cos((lat * Math.PI) / 180));
  /** A point x km east and y km north of the centre. */
  const at = (x, y) => ({ lat: Math.round((lat + y * kmLat) * 1e7) / 1e7, lon: Math.round((lon + x * kmLon) * 1e7) / 1e7 });
  const elements = [];
  let id = 1;
  const way = (tags, geometry) => elements.push({ type: 'way', id: id++, tags, geometry });
  const half = spanKm / 2;
  const steps = Math.round(spanKm / stepKm);
  const along = (fn) => Array.from({ length: steps * 4 + 1 }, (_, i) => fn(-half + (i * spanKm) / (steps * 4)));

  for (let i = 0; i <= steps; i++) {
    const x = -half + i * stepKm;
    way({ highway: i % 4 === 0 ? 'secondary' : 'residential', name: `${STREETS[i % STREETS.length]} Street` }, along((y) => at(x, y)));
  }
  for (let i = 0; i <= steps; i++) {
    const y = -half + i * stepKm;
    way({ highway: i % 4 === 0 ? 'primary' : 'tertiary', name: `${AVENUES[i % AVENUES.length]} Avenue` }, along((x) => at(x, y)));
  }
  // Paths, and features the map leaves out.
  way({ highway: 'footway' }, along((x) => at(x, 0.2 + 0.15 * Math.sin(x * 3))));
  way({ highway: 'cycleway' }, along((y) => at(-0.2 + 0.1 * Math.cos(y * 2), y)));
  way({ highway: 'footway', footway: 'sidewalk' }, along((x) => at(x, 0.21)));
  way({ highway: 'primary', tunnel: 'yes', name: 'Underpass' }, [at(-1, -1.1), at(1, -1.1)]);
  way({ highway: 'proposed' }, [at(-1, 1.3), at(1, 1.3)]);
  // Water and rail.
  way({ waterway: 'river', name: 'Sample River' }, along((x) => at(x, -1.6 + 0.3 * Math.sin(x))));
  way({ waterway: 'stream' }, [at(1.2, -1.5), at(1.3, -0.8), at(1.5, -0.2)]);
  way({ railway: 'rail' }, [at(-half, half * 0.8), at(0, half * 0.7), at(half, half * 0.6)]);
  way({ railway: 'subway', tunnel: 'yes' }, [at(-half, 0), at(half, 0)]);
  // Green areas, closed ways.
  const rect = (x0, y0, x1, y1) => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)];
  way({ leisure: 'park', name: 'Test Park' }, rect(-1.0, 0.5, -0.4, 1.0));
  way({ landuse: 'forest' }, rect(1.6, 1.2, 2.6, 2.2));
  const oval = Array.from({ length: 25 }, (_, i) => at(-0.7 + 0.12 * Math.cos((i / 24) * 2 * Math.PI), 0.75 + 0.06 * Math.sin((i / 24) * 2 * Math.PI)));
  oval[24] = oval[0];
  way({ leisure: 'track' }, oval);
  // A lake split over two outer ways, with an island.
  const ring = (cx, cy, r, n) => {
    const pts = Array.from({ length: n }, (_, i) => at(cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)));
    return [...pts, pts[0]];
  };
  const lake = ring(0.9, -0.7, 0.3, 40);
  elements.push({
    type: 'relation', id: id++, tags: { type: 'multipolygon', natural: 'water', name: 'Sample Lake' },
    members: [
      { type: 'way', ref: 9001, role: 'outer', geometry: lake.slice(0, 21) },
      { type: 'way', ref: 9002, role: 'outer', geometry: lake.slice(20).reverse() },
      { type: 'way', ref: 9003, role: 'inner', geometry: ring(0.9, -0.7, 0.07, 12) },
    ],
  });
  // Places.
  const place = (x, y, kind, name) => elements.push({ type: 'node', id: id++, ...at(x, y), tags: { place: kind, name } });
  place(0, 0, 'suburb', 'Centro Sample');
  place(1.5, 1.5, 'neighbourhood', 'Northeast Sample');
  place(-1.5, -1.5, 'neighbourhood', 'Southwest Sample');
  place(4, 4, 'town', 'Sample Town');
  return { version: 0.6, generator: 'Overpass API (synthetic test data)', osm3s: { copyright: 'Synthetic test data, not OpenStreetMap' }, elements };
}
