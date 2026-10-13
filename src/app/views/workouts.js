import { h, chartCard, section, clear, cssVar, mapHint, emptyState, BUCKET_COLOR } from '../ui.js';
import { scatterTrend, stackedBars, routeThumb, allRoutes } from '../charts.js';
import { tile, bucketColor, paceOrSpeed, workoutTitle, distanceText, durationText, sourceBadges, emptyElsewhere, oldImportNotice } from './common.js';
import { workoutsIn, rollingMedian, weeklyVolume } from '../../lib/stats.js';
import { fmtInt, fmtDate, fmtClock, fmtPace, fmtSpeed, fmtKm, fmtHoursMinutes, fmtOne } from '../../lib/format.js';
import { chartBucket, BUCKETS, BUCKET_LABELS } from '../../lib/huawei/sport-types.js';
import { decodePolyline, routeCluster } from '../../lib/geo.js';
import { trackPoints } from '../../lib/gpx.js';

const SORTS = {
  date: (w) => w.start,
  sport: (w) => w.label,
  distance: (w) => w.distance || 0,
  duration: (w) => w.duration || 0,
  pace: (w) => (w.family === 'ride' ? -(w.avgSpeed || 0) : w.avgPace || 1e9),
  hr: (w) => w.avgHr || 0,
  ascent: (w) => w.ascent || 0,
  kcal: (w) => w.kcal || 0,
};

let sortKey = 'date';
let sortDir = -1;

export function renderWorkouts(root, ctx) {
  const { ds, range, filter } = ctx;
  const fams = filter.families;
  const all = workoutsIn(ds, range);
  const list = fams ? all.filter((w) => fams.includes(chartBucket(w.family))) : all;
  if (!all.length) {
    root.append(emptyElsewhere(ctx, {
      title: 'No workouts in this period',
      dates: Object.values(ds.workouts).map((w) => w.date),
      span: (a, b) => `Your workouts run from ${a} to ${b}.`,
      one: (a) => `Your only workout is on ${a}.`,
    }) || emptyState('No workouts in this period', 'Workouts recorded on the watch appear here after an import. Try a longer period.'));
    return;
  }

  const stale = oldImportNotice(ds);
  if (stale) root.append(stale);

  // per-bucket summaries
  const tiles = h('div', { class: 'tiles' });
  for (const b of BUCKETS) {
    const ws = list.filter((w) => chartBucket(w.family) === b);
    if (!ws.length) continue;
    const dist = ws.reduce((s, w) => s + (w.distance || 0), 0);
    const time = ws.reduce((s, w) => s + (w.duration || 0), 0);
    tiles.append(tile({
      label: BUCKET_LABELS[b], color: BUCKET_COLOR[b],
      value: dist > 0 ? fmtKm(dist, dist >= 100000 ? 0 : 1) : fmtInt(ws.length), unit: dist > 0 ? 'km' : 'sessions',
      note: `${ws.length} ${ws.length === 1 ? 'session' : 'sessions'} · ${fmtHoursMinutes(time)}`,
    }));
  }
  root.append(tiles);

  // table (appended after the trends)
  const tableWrap = h('div', { class: 'table-wrap' });
  const more = h('div', { class: 'btn-row' });
  let limit = 25;
  const drawTable = () => {
    const get = SORTS[sortKey];
    const sorted = list.slice().sort((a, b) => {
      const va = get(a), vb = get(b);
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sortDir;
    });
    clear(tableWrap);
    const cols = [
      { key: 'date', label: 'Date' },
      { key: 'sport', label: 'Workout' },
      { key: 'distance', label: 'Distance', r: true },
      { key: 'duration', label: 'Time', r: true },
      { key: 'pace', label: 'Pace / speed', r: true },
      { key: 'hr', label: 'Avg HR', r: true },
      { key: 'ascent', label: 'Ascent', r: true },
      { key: 'kcal', label: 'kcal', r: true },
    ];
    const thead = h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Route' })), cols.map((c) => h('th', {
      scope: 'col', class: c.r ? 'r' : null, 'aria-sort': sortKey === c.key ? (sortDir > 0 ? 'ascending' : 'descending') : null,
    }, h('button', { type: 'button', onclick: () => { if (sortKey === c.key) sortDir = -sortDir; else { sortKey = c.key; sortDir = c.key === 'sport' ? 1 : -1; } drawTable(); } }, c.label))),
    h('th', { scope: 'col', text: 'Source' })));
    const tbody = h('tbody');
    for (const w of sorted.slice(0, limit)) {
      const ps = paceOrSpeed(w);
      tbody.append(h('tr', { class: 'clickable', tabindex: '0', onclick: () => ctx.actions.openWorkout(w.id), onkeydown: (e) => { if (e.key === 'Enter') ctx.actions.openWorkout(w.id); } },
        h('td', null, routeThumb(w.thumb, bucketColor(w.family))),
        h('td', null, `${fmtDate(w.date, { short: true, weekday: true })} ${w.date.slice(0, 4)}`, h('div', { class: 'muted', style: { fontSize: '12px' }, text: fmtClock(w.start, w.tz) })),
        h('td', null, h('span', { class: 'sport-cell' }, h('span', { class: 'key', style: { background: bucketColor(w.family) } }), workoutTitle(w))),
        h('td', { class: 'r', text: distanceText(w) }),
        h('td', { class: 'r', text: durationText(w) }),
        h('td', { class: 'r', text: ps.value === '—' ? '—' : `${ps.value} ${ps.unit}` }),
        h('td', { class: 'r', text: w.avgHr ? `${Math.round(w.avgHr)}` : '—' }),
        h('td', { class: 'r', text: w.ascent ? `${Math.round(w.ascent)} m` : '—' }),
        h('td', { class: 'r', text: w.kcal ? fmtInt(w.kcal) : '—' }),
        h('td', null, sourceBadges(w))));
    }
    tableWrap.append(h('table', null, thead, tbody));
    clear(more);
    if (sorted.length > limit) {
      more.append(
        h('button', { class: 'btn', type: 'button', onclick: () => { limit += 50; drawTable(); } }, 'Show 50 more'),
        h('span', { class: 'muted', text: `Showing ${limit} of ${sorted.length}` }));
    }
  };
  drawTable();
  const tableSection = section(`All workouts · ${list.length}`, 'Select a row for the route, splits and heart-rate zones. Column headers sort.', tableWrap, more);

  // trends per sport
  const grid = h('div', { class: 'grid' });
  const runs = list.filter((w) => w.family === 'run' && w.distance >= 1000 && w.avgPace > 0);
  if (runs.length) {
    const med = rollingMedian(runs.map((w) => w.avgPace), 5);
    const card = chartCard({
      id: 'run-pace',
      title: 'Running pace',
      sub: 'Each dot is a run (faster is higher); the line is the median of the last 5',
      render: (el, w) => scatterTrend(el, w, {
        points: runs.map((r) => ({ x: new Date(r.start), y: r.avgPace, id: r.id, label: `${workoutTitle(r)} · ${fmtDate(r.date)}`, color: 'var(--run)', w: r })),
        trend: runs.map((r, i) => ({ x: new Date(r.start), y: med[i] })),
        yFormat: (v) => fmtPace(v), yLabel: 'Pace /km', invertY: true,
        tip: (p) => [
          { label: 'Pace', value: `${fmtPace(p.y)} /km`, color: 'var(--run)' },
          { label: 'Distance', value: distanceText(p.w) },
          { label: 'Avg HR', value: p.w.avgHr ? `${Math.round(p.w.avgHr)} bpm` : '—' },
        ],
        onClick: (p) => ctx.actions.openWorkout(p.id),
      }),
      legend: [{ label: 'Run', color: 'var(--run)' }, { label: 'Median of last 5', color: 'var(--ink)', kind: 'line' }],
      table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Distance', get: distanceText, r: true }, { label: 'Pace', get: (r) => `${fmtPace(r.avgPace)} /km`, r: true }, { label: 'Avg HR', get: (r) => r.avgHr ?? '—', r: true }], rows: runs.slice().reverse() }),
    });
    card.classList.add('span-6');
    grid.append(card);
    const cad = runs.filter((r) => r.avgCadence > 0);
    if (cad.length) {
      const c2 = chartCard({
        id: 'run-cadence',
        title: 'Running cadence',
        sub: 'Average steps per minute for each run',
        render: (el, w) => scatterTrend(el, w, {
          points: cad.map((r) => ({ x: new Date(r.start), y: r.avgCadence, id: r.id, label: `${workoutTitle(r)} · ${fmtDate(r.date)}`, color: 'var(--run)' })),
          trend: cad.map((r, i, arr) => ({ x: new Date(r.start), y: rollingMedian(arr.map((q) => q.avgCadence), 5)[i] })),
          yFormat: (v) => `${Math.round(v)}`, yLabel: 'Steps per minute', onClick: (p) => ctx.actions.openWorkout(p.id),
        }),
        table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Cadence', get: (r) => r.avgCadence, r: true }], rows: cad.slice().reverse() }),
      });
      c2.classList.add('span-6');
      grid.append(c2);
    }
  }
  const rides = list.filter((w) => w.family === 'ride' && w.distance > 0 && w.duration > 0);
  if (rides.length) {
    const c = chartCard({
      id: 'ride-speed',
      title: 'Cycling speed',
      sub: 'Average speed per ride',
      render: (el, w) => scatterTrend(el, w, {
        points: rides.map((r) => ({ x: new Date(r.start), y: (r.distance / r.duration) * 3.6, id: r.id, label: `${workoutTitle(r)} · ${fmtDate(r.date)}`, color: 'var(--ride)', w: r })),
        trend: rides.map((r, i, arr) => ({ x: new Date(r.start), y: rollingMedian(arr.map((q) => (q.distance / q.duration) * 3.6), 5)[i] })),
        yFormat: (v) => `${fmtOne(v)}`, yLabel: 'km/h',
        tip: (p) => [{ label: 'Speed', value: `${fmtOne(p.y)} km/h`, color: 'var(--ride)' }, { label: 'Distance', value: distanceText(p.w) }, { label: 'Ascent', value: p.w.ascent ? `${Math.round(p.w.ascent)} m` : '—' }],
        onClick: (p) => ctx.actions.openWorkout(p.id),
      }),
      table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Distance', get: distanceText, r: true }, { label: 'Speed', get: (r) => `${fmtSpeed(r.distance / r.duration)} km/h`, r: true }], rows: rides.slice().reverse() }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  const walks = list.filter((w) => (w.family === 'walk' || w.family === 'hike') && w.distance > 0);
  if (walks.length) {
    const c = chartCard({
      id: 'walk-distance',
      title: 'Walks and hikes',
      sub: 'Distance of each outing; larger climbs show in the tooltip',
      render: (el, w) => scatterTrend(el, w, {
        points: walks.map((r) => ({ x: new Date(r.start), y: r.distance / 1000, id: r.id, label: `${workoutTitle(r)} · ${fmtDate(r.date)}`, color: 'var(--walk)', w: r })),
        trend: [],
        yFormat: (v) => `${fmtOne(v)}`, yLabel: 'km',
        tip: (p) => [{ label: 'Distance', value: `${fmtOne(p.y)} km`, color: 'var(--walk)' }, { label: 'Time', value: durationText(p.w) }, { label: 'Ascent', value: p.w.ascent ? `${Math.round(p.w.ascent)} m` : '—' }],
        onClick: (p) => ctx.actions.openWorkout(p.id),
      }),
      table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Workout', get: (r) => r.label }, { label: 'Distance', get: distanceText, r: true }, { label: 'Ascent', get: (r) => (r.ascent ? `${Math.round(r.ascent)} m` : '—'), r: true }], rows: walks.slice().reverse() }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  const weekly = weeklyDistance(ctx, list);
  if (weekly) grid.prepend(weekly);
  if (grid.children.length) root.append(section('Trends', null, grid));

  const withRoute = list.filter((w) => w.thumb);
  if (withRoute.length >= 2) root.append(routeExplorer(withRoute, ctx));
  root.append(tableSection);
}

/** Distance per week, stacked by sport, from the period's first workout on. */
function weeklyDistance(ctx, list) {
  if (!list.some((w) => w.distance > 0)) return null;
  const fams = ctx.filter.families;
  const first = list.reduce((a, w) => (w.date < a ? w.date : a), ctx.range.to);
  const rows = weeklyVolume(ctx.ds, { from: first, to: ctx.range.to }, 'distance');
  const keys = BUCKETS
    .filter((b) => (!fams || fams.includes(b)) && rows.some((r) => r[b] > 0))
    .map((b) => ({ key: b, label: BUCKET_LABELS[b], color: BUCKET_COLOR[b] }));
  const km = (m) => `${fmtOne(m / 1000)} km`;
  const card = chartCard({
    id: 'weekly-distance',
    title: 'Distance per week',
    sub: 'Kilometres per week, stacked by sport',
    render: (el, w) => stackedBars(el, w, {
      rows: rows.map((r) => ({ ...r, key: r.week, label: fmtDate(r.week, { short: true }) })),
      keys,
      yFormat: (v) => String(+(v / 1000).toFixed(1)),
      tipValue: km,
      tipTitle: (r) => `Week of ${fmtDate(r.week)}`,
      title: 'Distance per week',
    }),
    legend: keys.map((k) => ({ label: k.label, color: k.color })),
    table: () => ({
      columns: [{ label: 'Week of', get: (r) => fmtDate(r.week) }, ...keys.map((k) => ({ label: k.label, get: (r) => (r[k.key] ? km(r[k.key]) : '—'), r: true }))],
      rows: rows.slice().reverse(),
    }),
  });
  card.classList.add('span-12');
  return card;
}

const BUCKET_VAR = { run: '--run', walkhike: '--walk', ride: '--ride', other: '--other' };
const FULL_TRACKS = 60;

/**
 * "Where you went": every route of the period on one canvas you can zoom,
 * hover and click. It starts on the outlines stored with each workout and
 * swaps in the full GPS tracks (newest 60) as they load.
 */
function routeExplorer(ws, ctx) {
  const routes = ws.map((w) => {
    const ps = paceOrSpeed(w);
    return {
      id: w.id,
      points: decodePolyline(w.thumb),
      color: cssVar(BUCKET_VAR[chartBucket(w.family)]),
      title: `${workoutTitle(w)} · ${fmtDate(w.date, { short: true, weekday: true })} ${w.date.slice(0, 4)}`,
      rows: [
        { label: 'Distance', value: distanceText(w) },
        { label: 'Time', value: durationText(w) },
        ...(ps.value !== '—' ? [{ label: ps.label, value: `${ps.value} ${ps.unit}` }] : []),
        ...(w.avgHr ? [{ label: 'Avg HR', value: `${Math.round(w.avgHr)} bpm` }] : []),
      ],
    };
  });
  const usable = routes.filter((r) => r.points.length > 1);
  const far = usable.length - routeCluster(usable).length;
  let fitAll = false, host = null, hostW = 0, map = null;
  const draw = () => {
    clear(host);
    map = allRoutes(host, hostW, { routes, fitAll, onOpen: (id) => ctx.actions.openWorkout(id) });
  };
  const toggle = far > 0
    ? h('button', {
        class: 'btn', type: 'button', 'aria-pressed': 'false', style: { padding: '3px 10px', fontSize: '12px' },
        onclick: () => {
          fitAll = !fitAll;
          toggle.setAttribute('aria-pressed', String(fitAll));
          toggle.textContent = fitAll ? 'Fit the main area' : `Show all ${routes.length}`;
          if (host) draw();
        },
      }, `Show all ${routes.length}`)
    : null;
  const card = chartCard({
    id: 'all-routes',
    title: 'Where you went',
    sub: `${routes.length} routes in this period${far > 0 ? `, fitted to where most of them are (${far} elsewhere)` : ''}. ${mapHint(true)}`,
    actions: toggle,
    render: (el, width) => { host = el; hostW = width; draw(); },
    legend: BUCKETS.filter((b) => ws.some((w) => chartBucket(w.family) === b)).map((b) => ({ label: BUCKET_LABELS[b], color: BUCKET_COLOR[b], kind: 'line' })),
    table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Workout', get: (r) => r.label }, { label: 'Distance', get: distanceText, r: true }], rows: ws.slice().reverse() }),
  });
  loadFullRoutes(ws, ctx, card, (id, points) => {
    routes.find((r) => r.id === id).points = points;
    map?.update(id, points);
  });
  return card;
}

/** Load full tracks a few at a time; stops once the card leaves the page. */
async function loadFullRoutes(ws, ctx, card, onRoute) {
  const queue = ws.filter((w) => w.hasTrack).sort((a, b) => b.start - a.start).slice(0, FULL_TRACKS);
  const worker = async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      const track = await ctx.actions.loadTrack(w.id).catch(() => null);
      if (!card.isConnected) return;
      const points = trackPoints(track).filter((p) => p.pos).map((p) => p.pos);
      if (points.length > 1) onRoute(w.id, points);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}
