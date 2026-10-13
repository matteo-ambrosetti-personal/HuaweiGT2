/* global d3 */
import { h, chartCard, section, clear, cssVar, mapHint, emptyState } from '../ui.js';
import { routeMap, lineChart, hBars } from '../charts.js';
import { bucketColor, paceOrSpeed, workoutTitle, workoutWhen, sourceBadges, placeOf } from './common.js';
import { trackPoints } from '../../lib/gpx.js';
import { estimateMaxHr, zonesFromHist, zoneBounds, ZONES } from '../../lib/stats.js';
import { fmtPace, fmtDuration, fmtInt, fmtOne, fmtKm } from '../../lib/format.js';
import { chartBucket } from '../../lib/huawei/sport-types.js';

const ZONE_MIX = [30, 48, 66, 84, 100];

/** The usual 0–5 training-effect scale. */
const TE_LEVELS = [[5, 'Overreaching'], [4, 'Highly improving'], [3, 'Improving'], [2, 'Maintaining'], [1, 'Minor'], [0, 'No effect']];
const teLevel = (v) => TE_LEVELS.find(([min]) => v >= min)[1];

/**
 * Stats from the watch's own rating: training effect (stored ×10), load,
 * recovery time (minutes) and ground contact time. Walks rate 0 and show none.
 */
function trainingStats(w, stat) {
  const dev = w.device || {};
  const out = [];
  if (dev.etraining_effect > 0 || dev.load_peak > 0) {
    const te = (raw) => Math.min(5, raw / 10);
    if (dev.etraining_effect != null) out.push(stat('Aerobic training effect', fmtOne(te(dev.etraining_effect)), teLevel(te(dev.etraining_effect))));
    if (dev.anaerobic_exercise_etraining_effect != null) {
      const an = te(dev.anaerobic_exercise_etraining_effect);
      out.push(stat('Anaerobic training effect', fmtOne(an), teLevel(an)));
    }
    if (dev.load_peak > 0) out.push(stat('Training load', fmtInt(dev.load_peak)));
    if (dev.recovery_time > 0) out.push(stat('Recovery time', dev.recovery_time >= 90 ? Math.round(dev.recovery_time / 60) : dev.recovery_time, dev.recovery_time >= 90 ? 'h' : 'min'));
  }
  if (w.gct > 0) out.push(stat('Ground contact', w.gct, 'ms'));
  return out;
}

/** Centred moving average for display (nulls stay null). */
function smooth(values, k = 2) {
  return values.map((v, i) => {
    if (v == null) return null;
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(values.length - 1, i + k); j++) {
      if (values[j] != null) { sum += values[j]; n++; }
    }
    return sum / n;
  });
}

export function renderWorkout(root, ctx) {
  const w = ctx.ds.workouts[ctx.param];
  if (!w) {
    root.append(emptyState('Workout not found', 'It may have been removed by a newer import.', h('a', { class: 'btn', href: '#workouts' }, 'Back to workouts')));
    return;
  }
  const ps = paceOrSpeed(w);
  const stat = (k, v, unit) => h('div', { class: 'stat' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, v ?? '—', unit ? h('small', { text: unit }) : null));
  const center = w.bbox ? [(w.bbox[0] + w.bbox[2]) / 2, (w.bbox[1] + w.bbox[3]) / 2] : null;
  // The stored map, if any: drawn under the route, and it names the place.
  let basemap = ctx.basemap || null;
  let mapHandle = null;
  const placeEl = h('span', { id: 'workout-place' });
  const showPlace = (map) => {
    const place = placeOf(w, map?.labels);
    placeEl.textContent = place ? ` · near ${place}` : '';
  };
  showPlace(basemap);
  if (ctx.basemapIndex?.areas?.length && !basemap) {
    ctx.actions.getBasemap().then((map) => {
      if (!map || !placeEl.isConnected) return;
      basemap = map;
      showPlace(map);
      mapHandle?.setBasemap(map);
    });
  }
  root.append(h('div', { class: 'detail-head' },
    h('div', null,
      h('a', { href: '#workouts', class: 'muted', style: { fontSize: '13px' } }, '← All workouts'),
      h('h2', { style: { marginTop: '6px' } }, h('span', { style: { display: 'inline-block', width: '12px', height: '12px', borderRadius: '3px', background: bucketColor(w.family), marginRight: '10px' } }), workoutTitle(w)),
      h('div', { class: 'muted', style: { marginTop: '2px' } }, workoutWhen(w), placeEl, ' · ', ...sourceBadges(w))),
    h('div', { class: 'btn-row' },
      w.hasTrack ? h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportRoutes([w], 'gpx') }, 'Download GPX') : null,
      w.hasTrack ? h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportRoutes([w], 'tcx') }, 'Download TCX') : null,
      center ? h('a', { class: 'btn', href: `https://www.openstreetmap.org/?mlat=${center[0].toFixed(5)}&mlon=${center[1].toFixed(5)}#map=14/${center[0].toFixed(5)}/${center[1].toFixed(5)}`, target: '_blank', rel: 'noopener' }, 'Open map ↗') : null)));

  root.append(h('div', { class: 'panel' }, h('div', { class: 'stat-row' },
    stat('Distance', w.distance > 0 ? fmtKm(w.distance) : '—', w.distance > 0 ? 'km' : ''),
    stat('Moving time', fmtDuration(w.duration)),
    w.elapsed && w.elapsed - w.duration > 60 ? stat('Elapsed', fmtDuration(w.elapsed)) : null,
    stat(ps.label, ps.value, ps.unit),
    stat('Avg heart rate', w.avgHr ? Math.round(w.avgHr) : '—', w.avgHr ? 'bpm' : ''),
    stat('Max heart rate', w.maxHr ? Math.round(w.maxHr) : '—', w.maxHr ? 'bpm' : ''),
    stat('Ascent', w.ascent ? Math.round(w.ascent) : '—', w.ascent ? 'm' : ''),
    stat('Calories', w.kcal ? fmtInt(w.kcal) : '—', w.kcal ? 'kcal' : ''),
    w.steps ? stat('Steps', fmtInt(w.steps)) : null,
    w.avgCadence ? stat(w.family === 'ride' ? 'Cadence' : 'Cadence', Math.round(w.avgCadence), w.family === 'ride' ? 'rpm' : 'spm') : null,
    w.swim?.laps ? stat('Laps', w.swim.laps) : null,
  )));
  const training = trainingStats(w, stat);
  if (training.length) {
    root.append(h('div', { class: 'panel' },
      h('h3', { class: 'chart-title', text: 'Training' }),
      h('p', { class: 'chart-sub', text: 'How the watch rated this workout. Training effect runs from 0 to 5; recovery time is what the watch advised when you finished.' }),
      h('div', { class: 'stat-row', id: 'training-stats' }, ...training)));
  }
  if (w.abnormal) root.append(h('div', { class: 'msg' }, h('strong', { text: 'Huawei flagged this workout' }), 'The watch marked some of its data as unreliable (for example pace or distance), so treat the numbers with care.'));

  const body = h('div', { class: 'view' }, h('p', { class: 'loading', text: w.hasTrack ? 'Loading the route and samples…' : '' }));
  root.append(body);
  const zonesAndSplits = () => {
    const out = [];
    const maxHr = estimateMaxHr(ctx.ds, ctx.settings);
    if (w.hrHist) {
      const secs = zonesFromHist(w.hrHist, maxHr.value);
      const bounds = zoneBounds(maxHr.value);
      const heart = cssVar('--heart'), surf = cssVar('--surface');
      const rows = ZONES.map((z, i) => ({ label: `${z.label.split(' · ')[0]} · ${bounds[i][0]}+`, value: secs[i], color: d3.interpolateRgb(surf, heart)(ZONE_MIX[i] / 100) })).reverse();
      out.push(chartCard({
        id: 'zones',
        title: 'Time in heart-rate zones',
        sub: `Zones from max HR ${maxHr.value} bpm (${maxHr.basis === 'setting' ? 'your setting' : maxHr.basis === 'age' ? 'from your birth year' : maxHr.basis === 'workouts' ? 'estimated from your workouts' : 'default'}). Change it under Data → Settings.`,
        render: (el, width) => hBars(el, width, { rows, format: (v) => fmtDuration(v) }),
        table: () => ({ columns: [{ label: 'Zone', get: (r) => r.label }, { label: 'Time', get: (r) => fmtDuration(r.value), r: true }], rows }),
      }));
    }
    if (w.splits?.length) {
      const fastest = Math.min(...w.splits.filter((sp) => sp.distance >= 900).map((sp) => sp.pace));
      const tbl = h('div', { class: 'table-wrap' });
      const tbody = h('tbody');
      for (const sp of w.splits) {
        const ratio = fastest / sp.pace;
        tbody.append(h('tr', null,
          h('td', { text: sp.distance >= 999 ? `km ${sp.km}` : `${fmtOne(sp.distance / 1000)} km` }),
          h('td', { class: 'r', text: w.family === 'ride' ? `${fmtOne(3.6 * 1000 / sp.pace)} km/h` : fmtPace(sp.pace) }),
          h('td', null, h('div', { class: 'split-track' }, h('div', { style: { height: '8px', width: `${Math.round(Math.max(6, ratio * 100))}%`, background: bucketColor(w.family), borderRadius: '0 4px 4px 0', opacity: sp.pace === fastest ? 1 : 0.6 } }))),
          h('td', { class: 'r', text: fmtDuration(sp.time) }),
          h('td', { class: 'r', text: sp.hr ? `${sp.hr}` : '—' }),
          h('td', { class: 'r', text: sp.elev != null ? `+${sp.elev} m` : '—' })));
      }
      tbl.append(h('table', null, h('thead', null, h('tr', null,
        h('th', { text: 'Split' }), h('th', { class: 'r', text: w.family === 'ride' ? 'Speed' : 'Pace /km' }), h('th', null, h('span', { class: 'sr-only', text: 'Relative pace' })),
        h('th', { class: 'r', text: 'Time' }), h('th', { class: 'r', text: 'Avg HR' }), h('th', { class: 'r', text: 'Climb' }))), tbody));
      out.push(h('div', { class: 'panel' }, h('h3', { class: 'chart-title', text: 'Splits' }), h('p', { class: 'chart-sub', text: 'The bar length shows each split relative to your fastest.' }), tbl));
    }
    return out;
  };

  const draw = (track) => {
    clear(body);
    const pts = track ? trackPoints(track) : [];
    const foot = w.family !== 'ride';
    if (pts.some((p) => p.pos)) {
      let metric = foot ? 'pace' : 'speed';
      const mapHost = h('div');
      const renderMap = () => {
        clear(mapHost);
        const gpsPts = pts.filter((p) => p.pos).map((p) => ({
          lat: p.pos.lat, lon: p.pos.lon,
          v: metric === 'hr' ? p.hr : p.spd > 0.3 ? (metric === 'pace' ? 1000 / p.spd : p.spd * 3.6) : null,
        }));
        const vals = gpsPts.map((p) => p.v).filter((v) => v != null).sort((a, b) => a - b);
        const lo = vals[Math.floor(vals.length * 0.05)], hi = vals[Math.floor(vals.length * 0.95)];
        const base = metric === 'hr' ? cssVar('--heart') : cssVar(`--${{ run: 'run', walkhike: 'walk', ride: 'ride', other: 'other' }[chartBucket(w.family)]}`);
        const light = d3.interpolateRgb(cssVar('--surface'), base)(0.3), dark = d3.interpolateRgb(base, cssVar('--ink'))(0.35);
        // faster pace = smaller number → darker
        const dom = metric === 'pace' ? [hi, lo] : [lo, hi];
        const scale = vals.length ? d3.scaleSequential(d3.interpolateLab(light, dark)).domain(dom).clamp(true) : null;
        const fmt = (v) => (metric === 'pace' ? `${fmtPace(v)} /km` : metric === 'hr' ? `${Math.round(v)} bpm` : `${fmtOne(v)} km/h`);
        const label = metric === 'pace' ? 'Pace' : metric === 'hr' ? 'Heart rate' : 'Speed';
        mapHost.append(chartCard({
          id: 'route',
          title: 'Route',
          sub: `Coloured by ${label.toLowerCase()} — darker is ${metric === 'hr' ? 'higher' : 'faster'}. Green dot = start, dark dot = finish. ${mapHint(false)}`,
          actions: h('div', { class: 'seg' },
            ...[foot ? ['pace', 'Pace'] : ['speed', 'Speed'], ['hr', 'Heart rate']].filter(([k]) => k !== 'hr' || pts.some((p) => p.hr)).map(([k, l]) =>
              h('button', { type: 'button', 'aria-pressed': String(metric === k), onclick: () => { metric = k; renderMap(); } }, l))),
          render: (el, width) => { mapHandle = routeMap(el, width, { points: gpsPts, colorScale: scale, title: 'Route', basemap }); },
          legend: vals.length ? [
            { label: `${fmt(dom[0])}`, color: light },
            { label: `${fmt(dom[1])}`, color: dark },
          ] : null,
          table: () => ({
            columns: [{ label: 'Point', get: (r) => r.i }, { label: 'Lat', get: (r) => r.lat.toFixed(5) }, { label: 'Lon', get: (r) => r.lon.toFixed(5) }, { label, get: (r) => (r.v == null ? '—' : fmt(r.v)), r: true }],
            rows: gpsPts.filter((_, i) => i % Math.max(1, Math.round(gpsPts.length / 200)) === 0).map((p, i) => ({ ...p, i: i + 1 })),
          }),
        }));
      };
      renderMap();
      body.append(mapHost);
    }

    if (pts.length) {
      const grid = h('div', { class: 'grid' });
      const x = (p) => new Date(p.t);
      const charts = [];
      if (pts.some((p) => p.hr)) charts.push({ id: 'hr', title: 'Heart rate', color: 'var(--heart)', get: (p) => p.hr, fmt: (v) => `${Math.round(v)} bpm`, axis: (v) => `${Math.round(v)}` });
      if (pts.some((p) => p.spd > 0)) {
        charts.push(foot
          ? { id: 'pace', title: 'Pace', color: bucketColor(w.family), get: (p) => (p.spd > 0.5 ? Math.min(1200, 1000 / p.spd) : null), fmt: (v) => `${fmtPace(v)} /km`, axis: (v) => fmtPace(v), invert: true }
          : { id: 'speed', title: 'Speed', color: bucketColor(w.family), get: (p) => (p.spd != null ? p.spd * 3.6 : null), fmt: (v) => `${fmtOne(v)} km/h`, axis: (v) => `${Math.round(v)}` });
      }
      if (pts.some((p) => p.alt != null)) charts.push({ id: 'alt', title: 'Elevation', color: 'var(--ink-2)', get: (p) => p.alt, fmt: (v) => `${Math.round(v)} m`, axis: (v) => `${Math.round(v)}`, area: true });
      if (pts.some((p) => p.cad)) charts.push({ id: 'cad', title: 'Cadence', color: bucketColor(w.family), get: (p) => p.cad, fmt: (v) => `${Math.round(v)} ${foot ? 'spm' : 'rpm'}`, axis: (v) => `${Math.round(v)}` });
      for (const c of charts) {
        const raw = pts.map((p) => c.get(p) ?? null);
        const ys = c.id === 'hr' || c.id === 'alt' ? raw : smooth(raw, 2);
        const card = chartCard({
          id: `wk-${c.id}`,
          title: c.title,
          sub: c.id === 'hr' || c.id === 'alt' ? null : 'Lightly smoothed',
          render: (el, width) => lineChart(el, width, {
            series: [{ key: c.id, label: c.title, color: c.color, points: pts.map((p, i) => ({ x: x(p), y: ys[i] })), area: c.area, width: 1.5 }],
            yFormat: c.axis, tipFormat: c.fmt, invertY: c.invert, height: 170, title: c.title,
            xFormat: (d) => `${Math.round((d - pts[0].t) / 60000)} min`,
          }),
          table: () => ({
            columns: [{ label: 'Time', get: (p) => fmtDuration((p.t - pts[0].t) / 1000) }, { label: c.title, get: (p) => (c.get(p) == null ? '—' : c.fmt(c.get(p))), r: true }],
            rows: pts.filter((_, i) => i % Math.max(1, Math.round(pts.length / 200)) === 0),
          }),
        });
        card.classList.add(charts.length === 1 ? 'span-12' : 'span-6');
        grid.append(card);
      }
      if (charts.length) body.append(section('Samples', `${pts.length} samples, every ${track.step} s${track.thin ? ' (thinned to fit storage)' : ''}`, grid));
    }
    const extra = zonesAndSplits();
    if (extra.length) {
      const g = h('div', { class: 'grid' });
      extra.forEach((el, i) => { el.classList.add(extra.length === 1 ? 'span-12' : i === 0 ? 'span-5' : 'span-7'); g.append(el); });
      body.append(g);
    }
    if (!pts.length && !extra.length) body.append(h('p', { class: 'muted', text: 'This workout has summary numbers only (no route or samples in the export).' }));
  };

  if (w.hasTrack) ctx.actions.loadTrack(w.id).then(draw).catch(() => draw(null));
  else draw(null);
}
