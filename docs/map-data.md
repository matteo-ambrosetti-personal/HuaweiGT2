# Map background (OpenStreetMap)

The route maps on the Workouts tab and on each workout can show streets, paths, rail, rivers, parks, woods, water and place names under your routes.

## Why the page draws its own map

claude.ai artifacts run under a content security policy that blocks images and network requests to every outside host. Map tiles (OpenStreetMap, CARTO and others) and map iframes therefore can't load. Instead, the page draws a vector map from OpenStreetMap data that lives in your private storage.

## Getting the data

1. **Data → Map → Download map data.** The page builds a link to OpenStreetMap's Overpass API for boxes around your GPS routes:
   - each route's box is grown by 1 km, and overlapping boxes are merged;
   - routes the stored map already covers are left out;
   - routes spanning more than 150 km² (long rides) are left out, because they would make the download too big;
   - one download takes at most the three boxes with the most routes, and the card offers the rest afterwards.

   The link opens in a new tab and returns the data as JSON (a typical town area is a few MB).
2. **Save what opens as a file:** Ctrl+S or ⌘S on a computer, or your browser's Download option on a phone.
3. **Add the saved file.** The page converts it in its background worker and stores the result. Files from overpass-turbo's GeoJSON export work too.

When new routes fall outside the map, the card says how many and offers a download for just those areas. A new file replaces older areas it covers. **Remove map** deletes it.

## What is kept

Conversion (`src/lib/basemap.js`):
- **Lines and fills:** roads are classed as motorway, major, minor or path, plus rail, rivers and streams. Fills cover water, parks, woods, and pitches and running tracks.
- **Left out:** tunnels, sidewalks, crossings, parking aisles and proposed roads.
- **Multipolygons:** relations are joined into rings, and islands become holes.
- **Geometry:** Douglas–Peucker simplification at about 2 m, stored as encoded polylines.
- **Labels:** place names (city to hamlet), road names (one per name within 400 m), and named parks and lakes.
- **Coverage:** recorded as a grid of roughly 1 km cells, used to tell which routes the map covers.

Storage, private, under `data/users/<you>/`:
- `basemap`: the index, `{kind: 'basemap-index', v: 1, areas: [{id, at, cells, bbox, items, counts, bytes}]}`;
- `basemap/items/<id>`: chunks of at most about 200 KB, `{kind: 'basemap', v: 1, lines: {class: [polyline…]}, fills: {class: [[outer, hole…]…]}, labels: [[text, lat, lon, kind, rank, angle?]…]}`.

The map loads once per visit, the first time a map is shown.

## Drawing

`src/app/map-layer.js` draws one Path2D per class on a canvas under the routes:
- **Widths:** line widths follow the ground in metres, within pixel limits; footpaths appear only when zoomed in.
- **Labels:** drawn in screen space with halos, and never overlap.
- **Colours:** come from theme tokens (`--map-*` in `src/styles.css`) and follow light and dark mode.
- **Attribution:** "© OpenStreetMap contributors" sits in the corner of every map.
- **Zoom:** with a map you can zoom out to half the routes' frame for context.

The nearest place name also labels each workout:
- the workout header shows "near X";
- the route tooltip shows "Where";
- the Workouts table has a "Where" column.

## Privacy and licence

- **The download:** the request goes from your browser to overpass-api.de. It contains the boxes' coordinates (roughly where you run), never your tracks or health data.
- **Storage:** the converted map sits in your private storage like the rest of your data.
- **Licence:** OpenStreetMap data is © OpenStreetMap contributors, available under the Open Database License (ODbL).
