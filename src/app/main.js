// GT 2 Logbook — boot, routing, filters and actions.

import { state, update, settings, saveFilter } from './state.js';
import { getRuntime } from './runtime.js';
import { platform } from './platform.js';
import { CloudStore, MemoryStore, defaultMeta } from './store.js';
import { Importer } from './importer.js';
import { h, clear, toast } from './ui.js';
import { emptyDataset, mergeDataset, isEmpty, SOURCE_LABELS, workoutList } from '../lib/model.js';
import { resolveRange, previousRange, PRESETS, workoutsIn } from '../lib/stats.js';
import { todayKey, fmtDate, daysBetween } from '../lib/format.js';
import { BUCKETS, BUCKET_LABELS, chartBucket } from '../lib/huawei/sport-types.js';
import { BUCKET_COLOR } from './ui.js';
import * as exporter from './exporter.js';
import { renderOverview } from './views/overview.js';
import { renderActivity } from './views/activity.js';
import { renderWorkouts } from './views/workouts.js';
import { renderWorkout } from './views/workout.js';
import { renderSleep } from './views/sleep.js';
import { renderHeart } from './views/heart.js';
import { renderRecords } from './views/records.js';
import { renderAsk } from './views/ask.js';
import { renderInsights } from './views/insights.js';
import { renderTraining } from './views/training.js';
import { renderData } from './views/data.js';
import { rangeText } from './views/common.js';
import { mapAreas, overpassQuery, overpassUrl, decodeBasemap, areaKm2, MAP_ATTRIBUTION } from '../lib/basemap.js';

const VIEWS = {
  overview: renderOverview,
  insights: renderInsights,
  training: renderTraining,
  activity: renderActivity,
  workouts: renderWorkouts,
  workout: renderWorkout,
  sleep: renderSleep,
  heart: renderHeart,
  records: renderRecords,
  ask: renderAsk,
  data: renderData,
};
const FILTERED = new Set(['overview', 'training', 'activity', 'workouts', 'sleep', 'heart']);
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ routing

function parseHash() {
  const raw = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  if (raw.startsWith('workout-')) return { route: 'workout', param: raw.slice('workout-'.length) };
  return { route: VIEWS[raw] ? raw : 'overview', param: null };
}

window.addEventListener('hashchange', () => {
  const r = parseHash();
  const changed = r.route !== state.route || r.param !== state.param;
  update(r);
  if (changed) {
    render();
    window.scrollTo({ top: 0 });
  }
});

// ------------------------------------------------------------------ actions

const actions = {
  openWorkout(id) {
    location.hash = `workout-${encodeURIComponent(id)}`;
  },
  /** Switch the period to a custom span (used by "Show that period"). */
  showRange(from, to) {
    state.filter.preset = 'custom';
    state.filter.custom = { from, to };
    saveFilter();
    render();
    window.scrollTo({ top: 0 });
  },
  focusDay(date) {
    const ws = Object.values(state.ds.workouts).filter((w) => w.date === date);
    if (ws.length === 1) return actions.openWorkout(ws[0].id);
    const d = state.ds.days[date];
    toast(`${fmtDate(date, { weekday: true })}: ${d?.steps != null ? `${d.steps.toLocaleString('en-GB')} steps` : 'no step data'}${ws.length ? ` · ${ws.length} workouts` : ''}`);
  },
  async loadTrack(id) {
    if (state.tracks[id]) return state.tracks[id];
    if (state.isSample || !state.store) return null;
    const t = await state.store.loadTrack(id).catch(() => null);
    if (t) state.tracks[id] = t;
    return t;
  },

  async importExport(files, password, onProgress) {
    const res = await state.importer.importExport(files, { password: password || undefined, onProgress });
    const fragment = res.dataset;
    const tracks = fragment.tracks || {};
    const base = state.isSample ? emptyDataset() : state.ds;
    const counts = mergeDataset(base, fragment, 'export');
    void counts;
    const meta = state.isSample ? { ...defaultMeta(), settings: state.meta.settings || {} } : state.meta;
    const range = res.diag.range;
    meta.imports = [...(meta.imports || []), { at: new Date().toISOString(), source: 'export', counts: res.diag.counts, range }].slice(-20);
    meta.sources = { ...(meta.sources || {}), export: { at: new Date().toISOString(), range } };
    base.tracks = {};
    const trackCache = state.isSample ? {} : state.tracks;
    Object.assign(trackCache, tracks);
    const c = res.diag.counts;
    const summary = `Read ${c.workouts} workouts, ${c.days} days and ${c.nights} nights${range?.from ? ` from ${fmtDate(range.from)} to ${fmtDate(range.to)}` : ''}.${res.diag.parseErrors ? ` ${res.diag.parseErrors} unreadable records were skipped.` : ''} ${state.store.persistent ? `Saving to ${state.store.where} in the background.` : 'This view cannot save, so the data lasts until you close the page.'}`;
    update({ ds: base, meta, isSample: false, tracks: trackCache, diag: { ...res.diag, at: new Date().toISOString() }, flash: { title: 'Import complete', text: summary } });
    render();
    persist(tracks, res.diag);
    return summary;
  },

  async saveSettings(patch) {
    const meta = state.meta;
    meta.settings = { ...(meta.settings || {}), ...patch };
    update({ meta });
    if (!state.isSample) await state.store.saveMeta(meta).catch(() => toast('Settings could not be saved right now.'));
    render();
  },

  exportCsv(kind) {
    const dl = state.runtime?.downloads;
    if (kind === 'workouts') return exporter.exportWorkoutsCsv(dl, workoutList(state.ds));
    return exporter.exportDailyCsv(dl, state.ds);
  },
  /** Every day, night, workout and route (routes not yet loaded this session are read first), plus settings. */
  async exportBackup() {
    const tracks = {};
    if (!state.isSample) {
      const ids = Object.values(state.ds.workouts).filter((w) => w.hasTrack).map((w) => w.id);
      let done = 0;
      for (const id of ids) {
        const t = await actions.loadTrack(id).catch(() => null);
        if (t) tracks[id] = t;
        if (++done % 10 === 0) setBusy('Preparing backup', { done, total: ids.length });
      }
      setBusy(null);
    }
    return exporter.exportBackup(state.runtime?.downloads, state.ds, tracks, state.meta);
  },

  exportRoutes(workouts, format) {
    return exporter.exportRoutes(state.runtime?.downloads, workouts, format, (id) => actions.loadTrack(id), (p) => setBusy(`Preparing ${p.done}/${p.total}`, p));
  },
  exportRoutesInRange(format) {
    const range = currentRange();
    const ws = workoutsIn(state.ds, range).filter((w) => !state.filter.families || state.filter.families.includes(chartBucket(w.family)));
    return actions.exportRoutes(ws, format).finally(() => setBusy(null));
  },

  /** The stored map, decoded, or null without one. Loads its chunks once per session. */
  getBasemap() {
    if (state.basemap) return Promise.resolve(state.basemap);
    const areas = state.basemapIndex?.areas || [];
    if (!areas.length || !state.store) return Promise.resolve(null);
    basemapLoad ||= Promise.all(areas.flatMap((a) => a.items || []).map((id) => state.store.loadBasemapItem(id).catch(() => null)))
      .then((chunks) => {
        const map = decodeBasemap(chunks.filter(Boolean));
        if (state.basemapIndex?.areas === areas) state.basemap = map;
        return map;
      })
      .finally(() => { basemapLoad = null; });
    return basemapLoad;
  },

  /**
   * The map download for routes the stored map doesn't cover (`all`: every
   * route): {url, areas, km2}, or null when there is nothing to download.
   */
  mapDownload({ all = false } = {}) {
    const cells = all ? null : (state.basemapIndex?.areas || []).flatMap((a) => a.cells || []);
    // Routes spanning a huge area (long rides) would make the download too big to finish.
    const gps = Object.values(state.ds.workouts).filter((w) => Array.isArray(w.bbox));
    const big = gps.filter((w) => areaKm2(w.bbox) > MAX_ROUTE_KM2);
    const found = mapAreas(gps.filter((w) => !big.includes(w)), { cells });
    if (!found.length) return null;
    // At most three boxes per download, the ones with most routes; the card offers the rest afterwards.
    const inside = (a) => gps.filter((w) => {
      const lat = (w.bbox[0] + w.bbox[2]) / 2, lon = (w.bbox[1] + w.bbox[3]) / 2;
      return lat >= a[0] && lat <= a[2] && lon >= a[1] && lon <= a[3];
    }).length;
    const areas = found.map((a) => [a, inside(a)]).sort((x, y) => y[1] - x[1]).slice(0, MAX_MAP_AREAS).map(([a]) => a);
    return {
      url: overpassUrl(overpassQuery(areas)), areas, km2: areas.reduce((s, a) => s + areaKm2(a), 0),
      leftOut: big.length, more: found.length - areas.length,
    };
  },

  /** Remember which boxes the user is downloading, so the file's coverage includes them. */
  noteMapRequest(areas) {
    state.mapRequest = areas;
    try {
      localStorage.setItem('gt2.mapRequest', JSON.stringify(areas));
    } catch {
      /* storage unavailable */
    }
  },

  /** Add a downloaded OpenStreetMap file as the map for its area; older areas it covers are replaced. */
  async addMapFile(file) {
    const text = await file.text();
    const res = await state.importer.mapFile(text, requestedMapAreas());
    const id = `m${Date.now().toString(36)}`;
    const ids = res.chunks.map((_, i) => `${id}-${i}`);
    const fresh = new Set(res.cells);
    const old = state.basemapIndex?.areas || [];
    const replaced = old.filter((a) => (a.cells || []).filter((c) => fresh.has(c)).length >= 0.8 * (a.cells || []).length);
    const area = {
      id, at: new Date().toISOString(), cells: res.cells, bbox: res.bbox, items: ids, counts: res.counts,
      bytes: res.chunks.reduce((n, c) => n + JSON.stringify(c).length, 0),
    };
    const index = { kind: 'basemap-index', v: 1, attribution: MAP_ATTRIBUTION, areas: [...old.filter((a) => !replaced.includes(a)), area] };
    await state.store.saveBasemap(index, Object.fromEntries(ids.map((k, i) => [k, res.chunks[i]])), replaced.flatMap((a) => a.items || []));
    basemapLoad = null;
    const c = res.counts;
    const note = `Read ${c.lines.toLocaleString('en-GB')} streets, paths, rail lines and rivers, ${c.fills.toLocaleString('en-GB')} parks, woods and lakes, and ${c.labels.toLocaleString('en-GB')} names.${replaced.length ? ' It replaces the older map of the same area.' : ''} ${state.store.persistent ? `Saved to ${state.store.where}.` : 'This view cannot save, so the map lasts until you close the page.'}`;
    update({ basemapIndex: index, basemap: null, mapRequest: null, flash: { title: 'Map added', text: note, target: 'map' } });
    try {
      localStorage.removeItem('gt2.mapRequest');
    } catch {
      /* ignore */
    }
    render();
    return { counts: c, km2: res.bbox ? areaKm2(res.bbox) : 0, replaced: replaced.length };
  },

  async removeMap() {
    const index = state.basemapIndex;
    if (index) await state.store.removeBasemap(index);
    basemapLoad = null;
    update({ basemapIndex: null, basemap: null });
    render();
  },

  async deleteAll() {
    setBusy('Deleting…', { done: 0, total: 1 });
    try {
      await state.store.clear(state.meta, (p) => setBusy('Deleting…', p));
      toast('All your data was deleted.');
    } catch {
      toast('Some data could not be deleted. Try again.');
    }
    setBusy(null);
    update({ ds: emptyDataset(), meta: defaultMeta(), tracks: {}, diag: null, basemapIndex: null, basemap: null });
    await loadSample();
    location.hash = 'overview';
    render();
  },
};

let basemapLoad = null;
const MAX_ROUTE_KM2 = 150;
const MAX_MAP_AREAS = 3;

// Canvas maps resolve their colours when they draw: tell them when the theme changes.
const themeChanged = () => window.dispatchEvent(new Event('gt2-theme'));
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', themeChanged);
new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/** Boxes of the map download in progress (this session, else the last one remembered). */
function requestedMapAreas() {
  if (state.mapRequest) return state.mapRequest;
  try {
    const saved = JSON.parse(localStorage.getItem('gt2.mapRequest') || 'null');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function setBusy(label, p) {
  update({ busy: label ? { label, ...(p || {}) } : null });
  renderChips();
}

// ------------------------------------------------------------------ app-only actions

Object.assign(actions, {
  /** App only: download the OpenStreetMap data for the routes and add it, in one step. */
  async downloadMapNow(dl, onStatus = () => {}) {
    actions.noteMapRequest(dl.areas);
    onStatus('Downloading map data from OpenStreetMap…');
    const res = await fetch(dl.url);
    if (!res.ok) throw Object.assign(new Error(res.status === 429 || res.status === 504 ? 'The OpenStreetMap server is busy. Try again in a few minutes.' : `The OpenStreetMap server answered ${res.status}.`), { code: 'server_error' });
    const text = await res.text();
    onStatus(`Reading ${(text.length / 1e6).toFixed(1)} MB of map data…`);
    return actions.addMapFile(new Blob([text], { type: 'application/json' }));
  },

  async setSecret(name, value) {
    state.runtime?.secrets?.set(name, value || null);
    render();
  },
});

// ------------------------------------------------------------------ saving

let saving = Promise.resolve();

/** Save the dataset (one save at a time). Resolves with the store's result. */
function persist(tracks, diag, opts) {
  const run = saving.then(() => persistNow(tracks, diag, opts));
  saving = run.catch(() => {});
  return run;
}

async function persistNow(tracks, diag, { quiet = false } = {}) {
  if (!state.store.persistent) return { error: null };
  setBusy('Saving', { done: 0, total: 1 });
  try {
    const res = await state.store.save(state.ds, state.meta, { tracks, onProgress: (p) => setBusy('Saving', p) });
    if (diag) await state.store.saveDiag(diag).catch(() => {});
    if (res.error?.code === 'quota_exceeded') toast('Storage is full: some routes stay only in this session. Summaries are saved.', 6000);
    else if (res.error) toast(`Some data was not saved (${res.error.code || 'error'}). It is still shown; try importing again later.`, 6000);
    else if (!quiet) toast(`Saved to ${state.store.where}.`);
    return res;
  } catch (e) {
    toast(`Saving failed (${e?.code || 'error'}). Your data is shown but not stored yet.`, 6000);
    return { error: e || { code: 'error' } };
  } finally {
    setBusy(null);
  }
}

// ------------------------------------------------------------------ rendering

function currentRange() {
  return resolveRange(state.ds, state.filter.preset, state.filter.custom);
}

function renderChips() {
  const el = $('status-chips');
  clear(el);
  if (state.loading) {
    el.append(h('span', { class: 'chip' }, h('span', { class: 'dot' }), 'Loading…'));
    return;
  }
  if (state.isSample) el.append(h('span', { class: 'chip sample', text: 'Sample data' }));
  for (const [src, info] of Object.entries(state.meta.sources || {})) {
    const to = info.range?.to;
    const age = to ? daysBetween(to, todayKey()) : null;
    el.append(h('span', { class: `chip ${age == null ? '' : age <= 14 ? 'ok' : age <= 60 ? 'warn' : 'bad'}`, title: `Latest data from ${SOURCE_LABELS[src]}` },
      h('span', { class: 'dot' }), `${SOURCE_LABELS[src] || src}${to ? ` · to ${fmtDate(to, { short: true })}` : ''}`));
  }
  if (state.store?.kind === 'memory' && !state.isSample) el.append(h('span', { class: 'chip warn' }, h('span', { class: 'dot' }), 'Not saved in this view'));
  if (state.busy) {
    const pct = state.busy.total ? Math.round((state.busy.done / state.busy.total) * 100) : null;
    el.append(h('span', { class: 'chip' }, h('span', { class: 'dot' }), `${state.busy.label}${pct != null ? ` ${pct}%` : '…'}`));
  }
}

function renderFilters() {
  const el = $('filters');
  clear(el);
  el.hidden = !FILTERED.has(state.route);
  if (el.hidden) return;
  const f = state.filter;
  const setPreset = (key) => {
    f.preset = key;
    saveFilter();
    render();
  };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' },
    [...PRESETS.map((p) => [p.key, p.label]), ['custom', 'Custom']].map(([k, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(f.preset === k), onclick: () => setPreset(k) }, l)));
  el.append(seg);
  const range = currentRange();
  if (f.preset === 'custom') {
    const from = h('input', { type: 'date', id: 'range-from', value: f.custom?.from || range.from, 'aria-label': 'From' });
    const to = h('input', { type: 'date', id: 'range-to', value: f.custom?.to || range.to, 'aria-label': 'To' });
    const apply = () => {
      if (from.value && to.value && from.value <= to.value) {
        f.custom = { from: from.value, to: to.value };
        saveFilter();
        render();
      }
    };
    from.addEventListener('change', apply);
    to.addEventListener('change', apply);
    el.append(h('span', { class: 'custom-range' }, from, '–', to));
  } else {
    el.append(h('span', { class: 'range-label', text: rangeText(range) }));
  }
  if (state.route === 'workouts') {
    const fams = f.families;
    const toggle = (b) => {
      let next = fams ? [...fams] : [...BUCKETS];
      next = next.includes(b) ? next.filter((x) => x !== b) : [...next, b];
      f.families = next.length === BUCKETS.length || !next.length ? null : next;
      saveFilter();
      render();
    };
    el.append(h('div', { class: 'fam-chips', role: 'group', 'aria-label': 'Sports' },
      BUCKETS.map((b) => h('button', { type: 'button', class: 'fam-chip', 'aria-pressed': String(!fams || fams.includes(b)), onclick: () => toggle(b) },
        h('span', { class: 'key', style: { background: BUCKET_COLOR[b] } }), BUCKET_LABELS[b]))));
  }
}

function renderBanner() {
  const el = $('banner-slot');
  clear(el);
  if (state.isSample && state.route !== 'data') {
    el.append(h('div', { class: 'banner' },
      h('p', null, h('b', { text: 'You are looking at sample data. ' }), 'Explore freely, then import your Huawei export to see your own watch data.'),
      h('a', { class: 'btn primary', href: '#data' }, 'Import my data')));
  }
}

function renderTabs() {
  for (const a of document.querySelectorAll('#tabs .tab')) {
    const r = a.dataset.route;
    if (r === state.route || (state.route === 'workout' && r === 'workouts')) {
      a.setAttribute('aria-current', 'page');
      // On a phone the tab row scrolls: keep the current tab in view.
      const bar = a.parentElement;
      if (bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: a.offsetLeft - bar.clientWidth / 2 + a.offsetWidth / 2, behavior: 'smooth' });
    } else a.removeAttribute('aria-current');
  }
}

function viewCtx() {
  const range = currentRange();
  return {
    ds: state.ds,
    meta: state.meta,
    diag: state.diag,
    settings: settings(),
    range,
    prev: previousRange(range),
    filter: state.filter,
    isSample: state.isSample,
    runtime: state.runtime,
    store: state.store,
    param: state.param,
    platform,
    basemap: state.basemap,
    basemapIndex: state.basemapIndex,
    actions,
    getAskCtx: () => ({ ds: state.ds, settings: settings(), isSample: state.isSample }),
    takeFlash: () => { const f = state.flash; state.flash = null; return f; },
  };
}

export function render() {
  renderTabs();
  renderChips();
  renderBanner();
  renderFilters();
  const view = $('view');
  clear(view);
  if (state.loading) {
    view.append(h('p', { class: 'loading', text: 'Loading your logbook…' }));
    return;
  }
  try {
    VIEWS[state.route](view, viewCtx());
  } catch (err) {
    console.error(err);
    view.append(h('div', { class: 'msg err' }, h('strong', { text: 'This view could not be drawn' }), String(err?.message || err)));
  }
}

// ------------------------------------------------------------------ boot

async function loadSample() {
  const res = await state.importer.sample(todayKey());
  const tracks = res.dataset.tracks || {};
  res.dataset.tracks = {};
  update({ ds: res.dataset, isSample: true, tracks });
}

async function boot() {
  update(parseHash());
  render();
  const runtime = await getRuntime();
  let store = runtime.db && runtime.uid ? new CloudStore(runtime.db, runtime.uid, { kind: runtime.storeKind }) : new MemoryStore();
  const importer = new Importer();
  update({ runtime, store, importer });
  let loaded = null;
  try {
    loaded = await store.load();
  } catch (e) {
    console.warn('Storage unavailable', e);
    store = new MemoryStore();
    update({ store });
    loaded = await store.load();
    toast(`${store.kind === 'device' ? 'Storage on this device' : 'Your private storage'} could not be reached; changes will not be saved in this view.`, 6000);
  }
  update({ meta: loaded.meta, diag: loaded.diag, basemapIndex: loaded.basemapIndex || null });
  if (isEmpty(loaded.ds)) await loadSample();
  else update({ ds: loaded.ds, isSample: false });
  update({ loading: false });
  render();
}

boot().catch((err) => {
  console.error(err);
  const view = $('view');
  clear(view);
  view.append(h('div', { class: 'msg err' }, h('strong', { text: 'The logbook could not start' }), String(err?.message || err)));
});
