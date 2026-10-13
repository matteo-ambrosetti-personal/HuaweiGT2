// GT 2 Logbook — boot, routing, filters and actions.

import { state, update, settings, saveFilter } from './state.js';
import { getRuntime } from './runtime.js';
import { platform } from './platform.js';
import { CloudStore, MemoryStore, defaultMeta } from './store.js';
import { Importer } from './importer.js';
import { h, clear, toast } from './ui.js';
import { emptyDataset, mergeDataset, isEmpty, datasetRange, SOURCE_LABELS, workoutList } from '../lib/model.js';
import { resolveRange, previousRange, PRESETS, workoutsIn } from '../lib/stats.js';
import { todayKey, fmtDate, daysBetween, addDays } from '../lib/format.js';
import { BUCKETS, BUCKET_LABELS, chartBucket } from '../lib/huawei/sport-types.js';
import { BUCKET_COLOR } from './ui.js';
import * as exporter from './exporter.js';
import { parseBackup } from '../lib/backup.js';
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
import { renderData, renderDriveCard, renderHealthCard, renderIntervalsCard } from './views/data.js';
import { rangeText } from './views/common.js';
import { syncDrive as runDriveSync, DRIVE, driveErrorCopy, protectPruned } from './sync-drive.js';
import { mapAreas, overpassQuery, overpassUrl, decodeBasemap, areaKm2, MAP_ATTRIBUTION } from '../lib/basemap.js';
import { healthStatus, connectHealth, syncHealthConnect, healthSince } from '../lib/healthconnect.js';
import { syncIntervals } from '../lib/intervals-api.js';

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

  async importActivityFiles(fileList) {
    if (!fileList.length) throw new Error('No files chosen.');
    const files = await Promise.all(fileList.map(async (f) => ({ name: f.name, text: await f.text(), id: `${f.name}-${f.size}` })));
    const res = await state.importer.activityFiles(files, 'healthsync');
    const fragment = res.dataset;
    const tracks = fragment.tracks || {};
    const base = state.isSample ? emptyDataset() : state.ds;
    mergeDataset(base, fragment, 'healthsync');
    base.tracks = {};
    const meta = state.isSample ? { ...defaultMeta(), settings: state.meta.settings || {} } : state.meta;
    meta.imports = [...(meta.imports || []), {
      at: new Date().toISOString(), source: 'healthsync',
      counts: { workouts: Object.keys(fragment.workouts).length, days: Object.keys(fragment.days).length, nights: Object.keys(fragment.nights).length },
      range: datasetRange(fragment),
    }].slice(-20);
    const cache = state.isSample ? {} : state.tracks;
    Object.assign(cache, tracks);
    const skipped = res.diag.skipped || [];
    const summary = `Added ${res.diag.parsed} of ${files.length} files.${skipped.length ? ` Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}.` : ''}`;
    update({ ds: base, meta, isSample: false, tracks: cache, flash: { title: 'Files added', text: summary, target: 'files' } });
    render();
    persist(tracks, null);
    return summary;
  },

  /** Pull new Health Sync files from Google Drive (button, or automatic when allowed). */
  syncDrive({ auto = false } = {}) {
    if (driveRun) return driveRun;
    const mcp = state.runtime?.mcp;
    if (!mcp) {
      setDrive({ status: 'unavailable' });
      return Promise.resolve(null);
    }
    if (auto) lastAutoSync = Date.now();
    driveRun = (async () => {
      const before = state.drive.status;
      setDrive({ busy: true, progress: null, error: null });
      try {
        const call = async (tool, input) => (await mcp.callTool(DRIVE, tool, input, { cache: false })).payload;
        const res = await runDriveSync({ call, index: state.syncIndex, onProgress: (p) => setDrive({ progress: p }) });
        const frag = res.fragment;
        const changed = Object.keys(frag.days).length + Object.keys(frag.nights).length + Object.keys(frag.workouts).length > 0;
        const now = new Date().toISOString();
        let saved = { error: null };
        if (changed) {
          const base = state.isSample ? emptyDataset() : state.ds;
          protectPruned(frag, base, res.index.prunedBefore);
          const tracks = frag.tracks || {};
          mergeDataset(base, frag, 'healthsync');
          base.tracks = {};
          const meta = state.isSample ? { ...defaultMeta(), settings: state.meta.settings || {} } : state.meta;
          meta.sources = { ...(meta.sources || {}), healthsync: driveSource(meta.sources?.healthsync, res, now) };
          const cache = state.isSample ? {} : state.tracks;
          Object.assign(cache, tracks);
          update({ ds: base, meta, isSample: false, tracks: cache });
          if (state.route === 'data') renderChips();
          else render();
          saved = await persist(tracks, null, { quiet: true });
        } else if (!state.isSample) {
          state.meta.sources = { ...(state.meta.sources || {}), healthsync: driveSource(state.meta.sources?.healthsync, res, now) };
          await state.store.saveMeta(state.meta).catch(() => {});
        }
        // The index (with its cursor) is stored only once the days are: a failed
        // save re-reads the same files next time. Routes that did not fit are not blocking.
        if (!saved.error || saved.tracksSkipped) {
          update({ syncIndex: res.index });
          await state.store.saveSyncIndex(res.index).catch(() => {});
        }
        const status = res.report.folders ? 'ready' : 'nofolders';
        setDrive({ busy: false, progress: null, status, perm: 'granted', report: res.report, error: null });
        const r = res.report;
        if (changed) toast(`Health Sync: ${r.days ? `${r.days} day${r.days === 1 ? '' : 's'}` : ''}${r.days && r.workouts ? ' and ' : ''}${r.workouts ? `${r.workouts} workout${r.workouts === 1 ? '' : 's'}` : ''} updated.`);
        else if (!auto) toast(status === 'nofolders' ? 'No Health Sync folders in your Google Drive yet.' : 'Health Sync is up to date.');
        return res.report;
      } catch (e) {
        if (e?.code === 'user_changed') return null; // the runtime replaces the page
        const copy = driveErrorCopy(e);
        setDrive({ busy: false, progress: null, error: copy, status: copy?.status && copy.status !== 'error' ? copy.status : before });
        if (copy && !auto && state.route !== 'data') toast(`${copy.title}. See Data → Automatic updates.`, 5000);
        return null;
      } finally {
        driveRun = null;
      }
    })();
    return driveRun;
  },

  async openPermissions() {
    try {
      if (!state.runtime?.permissions) throw new Error('no permissions panel');
      await state.runtime.permissions.manage();
    } catch {
      toast("Open this artifact's Permissions menu to allow Google Drive.", 5000);
    }
    await checkDrive();
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

  /** Replace everything stored here with a backup file. */
  async restoreBackup(file) {
    const b = parseBackup(await file.text());
    setBusy('Restoring', { done: 0, total: 1 });
    try {
      if (!state.isSample) await state.store.clear(state.meta, (p) => setBusy('Restoring', p)).catch(() => {});
    } finally {
      setBusy(null);
    }
    const meta = { ...defaultMeta(), settings: { ...(b.settings || {}) }, sources: b.sources || {} };
    meta.imports = [{ at: new Date().toISOString(), source: 'backup', counts: { workouts: Object.keys(b.ds.workouts).length, days: Object.keys(b.ds.days).length, nights: Object.keys(b.ds.nights).length }, range: datasetRange(b.ds) }];
    const c = meta.imports[0].counts;
    update({
      ds: b.ds, meta, isSample: false, tracks: { ...b.tracks }, diag: null, syncIndex: null, basemapIndex: null, basemap: null,
      flash: { title: 'Backup restored', text: `Restored ${c.workouts} workouts, ${c.days} days and ${c.nights} nights${b.exportedAt ? ` saved on ${fmtDate(b.exportedAt.slice(0, 10))}` : ''}. ${state.store.persistent ? `Saving to ${state.store.where}.` : ''}` },
    });
    render();
    await persist(b.tracks, null);
    return c;
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
    update({ ds: emptyDataset(), meta: defaultMeta(), tracks: {}, diag: null, syncIndex: null, basemapIndex: null, basemap: null, drive: { ...state.drive, report: null, error: null } });
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

// ------------------------------------------------------------------ Google Drive sync

let driveRun = null;
let lastAutoSync = 0;
const AUTO_SYNC_MS = 60 * 60000;

function setDrive(patch) {
  update({ drive: { ...state.drive, ...patch } });
  renderChips();
  const card = document.getElementById('drive-card');
  if (card) renderDriveCard(card, viewCtx());
}

/** meta.sources.healthsync after a sync: when, what it covered, what the last run did. */
function driveSource(prev, res, at) {
  const range = datasetRange(res.fragment);
  const from = [prev?.range?.from, range?.from].filter(Boolean).sort()[0];
  const to = [prev?.range?.to, range?.to].filter(Boolean).sort().at(-1);
  return { at, ...(from ? { range: { from, to } } : {}), last: { files: res.report.read, days: res.report.days, workouts: res.report.workouts } };
}

/**
 * Work out what the Drive card can offer and, when Google Drive is already
 * allowed for this page, sync automatically (at most hourly). Never asks for
 * consent by itself: a first sync needs the button.
 */
async function checkDrive({ auto = false } = {}) {
  const { mcp, permissions } = state.runtime || {};
  if (!mcp) return setDrive({ status: 'unavailable', error: null });
  let perm = 'prompt';
  try {
    if (permissions) perm = await permissions.state(`mcp:${DRIVE}`);
  } catch {
    perm = 'prompt';
  }
  let status = perm === 'granted' ? 'ready' : perm === 'denied' ? 'denied' : 'prompt';
  try {
    const listed = await mcp.listTools(DRIVE);
    const server = (listed?.servers || []).find((s) => s.server === DRIVE);
    if (!server || (Array.isArray(server.tools) && !server.tools.length)) status = 'missing';
    else if (server.authStatus === 'needs_reauth') status = 'reauth';
  } catch (e) {
    const copy = driveErrorCopy(e);
    if (copy) return setDrive({ status: copy.status, error: copy });
  }
  if (!state.drive.busy) {
    // An access problem from an earlier attempt is stale once the connector checks out again.
    const accessError = ['reauth', 'missing', 'denied', 'choose', 'approval', 'unavailable'].includes(state.drive.error?.status);
    let error = state.drive.error;
    if (status === 'denied') error = driveErrorCopy({ code: 'not_in_manifest' });
    else if ((status === 'ready' || status === 'prompt') && accessError) error = null;
    setDrive({ status, perm, error });
  }
  const last = Date.parse(state.meta.sources?.healthsync?.at || '');
  const due = !Number.isFinite(last) || Date.now() - last > AUTO_SYNC_MS;
  if (auto && status === 'ready' && due && Date.now() - lastAutoSync > AUTO_SYNC_MS) actions.syncDrive({ auto: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || state.loading || !state.runtime) return;
  if (platform.app) autoSyncApp();
  else checkDrive({ auto: true });
});
window.addEventListener('gt2-resume', () => {
  if (!state.loading && state.runtime) autoSyncApp();
});

// ------------------------------------------------------------------ app sources (Health Connect, intervals.icu)

const APP_SYNC_MS = 60 * 60000;
const appRuns = {};

function setSource(name, patch) {
  update({ [name]: { ...state[name], ...patch } });
  renderChips();
  const card = document.getElementById(`${name}-card`);
  if (card) (name === 'health' ? renderHealthCard : renderIntervalsCard)(card, viewCtx());
}

/** Coverage of a source after a sync: when, the dates it has delivered so far, what this run did. */
function sourceInfo(prev, frag, at, last) {
  const range = datasetRange(frag);
  const from = [prev?.range?.from, range?.from].filter(Boolean).sort()[0];
  const to = [prev?.range?.to, range?.to].filter(Boolean).sort().at(-1);
  return { ...prev, at, ...(from ? { range: { from, to } } : {}), last };
}

/** Merge a synced fragment, record the source, save. Resolves {changed, saved}. */
async function applyFragment(frag, source, info) {
  const changed = Object.keys(frag.days).length + Object.keys(frag.nights).length + Object.keys(frag.workouts).length > 0;
  if (!changed) {
    if (!state.isSample) {
      state.meta.sources = { ...(state.meta.sources || {}), [source]: info };
      await state.store.saveMeta(state.meta).catch(() => {});
    }
    return { changed: false, saved: { error: null } };
  }
  const base = state.isSample ? emptyDataset() : state.ds;
  const tracks = frag.tracks || {};
  mergeDataset(base, frag, source);
  base.tracks = {};
  const meta = state.isSample ? { ...defaultMeta(), settings: state.meta.settings || {} } : state.meta;
  meta.sources = { ...(meta.sources || {}), [source]: info };
  const cache = state.isSample ? {} : state.tracks;
  Object.assign(cache, tracks);
  update({ ds: base, meta, isSample: false, tracks: cache });
  render();
  return { changed: true, saved: await persist(tracks, null, { quiet: true }) };
}

/** One run per source at a time. */
function once(name, fn) {
  appRuns[name] ||= fn().finally(() => { appRuns[name] = null; });
  return appRuns[name];
}

const due = (src) => {
  const last = Date.parse(state.meta.sources?.[src]?.at || '');
  return !Number.isFinite(last) || Date.now() - last > APP_SYNC_MS;
};

async function checkHealth() {
  const st = await healthStatus(state.runtime?.health);
  if (!st.available) return setSource('health', { status: 'unavailable', reason: st.reason });
  const granted = st.granted.length > 0;
  setSource('health', { status: granted ? 'ready' : 'prompt', history: st.history, granted: st.granted });
  return st;
}

/** Sync what is due, quietly: Health Connect when allowed, intervals.icu when a key is saved. */
async function autoSyncApp() {
  const st = state.health.status === 'checking' || state.health.status === 'ready' ? await checkHealth() : null;
  if (st?.available && st.granted.length && due('healthconnect')) actions.syncHealth({ auto: true });
  if (state.runtime?.secrets?.get('intervals') && due('intervals')) actions.syncIntervals({ auto: true });
}

Object.assign(actions, {
  /** Ask Health Connect for read access, then sync. */
  async connectHealth() {
    const health = state.runtime?.health;
    if (!health) return;
    try {
      const res = await connectHealth(health);
      setSource('health', { status: res.granted.length ? 'ready' : 'prompt', history: res.history, granted: res.granted, error: res.granted.length ? null : { title: 'Nothing was allowed', text: 'Allow at least steps, heart rate or sleep in Health Connect, then try again.' } });
      if (res.granted.length) await actions.syncHealth();
    } catch (e) {
      setSource('health', { error: { title: 'Health Connect did not open', text: String(e?.message || e) } });
    }
  },

  openHealthSettings() {
    state.runtime?.health?.openHealthConnectSettings().catch(() => toast('Open the Health Connect app to change what GT 2 Logbook may read.', 5000));
  },

  syncHealth({ auto = false } = {}) {
    const health = state.runtime?.health;
    if (!health) return Promise.resolve(null);
    return once('health', async () => {
      setSource('health', { busy: true, progress: null, error: null });
      try {
        const prev = state.meta.sources?.healthconnect;
        const since = healthSince(state.isSample ? null : prev?.range?.to, { history: state.health.history, today: todayKey() });
        const res = await syncHealthConnect({ health, since, onProgress: (p) => setSource('health', { progress: p }) });
        const r = res.report;
        const info = sourceInfo(state.isSample ? null : prev, res.fragment, new Date().toISOString(), { days: r.days, nights: r.nights, workouts: r.workouts });
        const { changed } = await applyFragment(res.fragment, 'healthconnect', info);
        setSource('health', { busy: false, progress: null, report: r, status: 'ready' });
        if (!auto || changed) toast(changed ? `Health Connect: ${plural(r.days, 'day')}, ${plural(r.nights, 'night')} and ${plural(r.workouts, 'workout')} read.` : 'Health Connect has nothing new.');
        return r;
      } catch (e) {
        setSource('health', { busy: false, progress: null, error: { title: 'Health Connect sync failed', text: String(e?.message || e) } });
        if (!auto) toast('Health Connect sync failed. See Data.', 5000);
        return null;
      }
    });
  },

  /** Save the intervals.icu key (on this device only) and athlete id, then sync. */
  async saveIntervals({ apiKey, athleteId }) {
    state.runtime?.secrets?.set('intervals', apiKey || null);
    await actions.saveSettings({ intervalsAthlete: athleteId || null });
    if (apiKey) return actions.syncIntervals();
    return null;
  },

  syncIntervals({ auto = false } = {}) {
    const rt = state.runtime;
    const apiKey = rt?.secrets?.get('intervals');
    if (!apiKey || !rt.http) return Promise.resolve(null);
    return once('intervals', async () => {
      setSource('intervals', { busy: true, progress: null, error: null });
      try {
        const prev = state.isSample ? null : state.meta.sources?.intervals;
        const oldest = prev?.range?.to ? addDays(prev.range.to < todayKey() ? prev.range.to : todayKey(), -3) : addDays(todayKey(), -365);
        const known = new Set(Object.values(state.ds.workouts).filter((w) => w.hasTrack && w.source === 'intervals').map((w) => w.id));
        const res = await syncIntervals({
          http: rt.http, apiKey, athleteId: settings().intervalsAthlete || '0', oldest, newest: todayKey(), known,
          onProgress: (p) => setSource('intervals', { progress: p }),
        });
        const r = res.report;
        const info = sourceInfo(prev, res.fragment, new Date().toISOString(), { activities: r.activities, withStreams: r.withStreams, wellnessDays: r.wellnessDays });
        const { changed } = await applyFragment(res.fragment, 'intervals', info);
        setSource('intervals', { busy: false, progress: null, report: r });
        if (!auto || changed) toast(changed ? `intervals.icu: ${plural(r.activities, 'activity', 'activities')} and ${plural(r.wellnessDays, 'day')} of wellness read.` : 'intervals.icu has nothing new.');
        return r;
      } catch (e) {
        const text = e?.code === 'auth' ? 'intervals.icu did not accept the API key. Copy it again from intervals.icu → Settings → Developer.' : String(e?.message || e);
        setSource('intervals', { busy: false, progress: null, error: { title: 'intervals.icu sync failed', text } });
        if (!auto) toast('intervals.icu sync failed. See Data.', 5000);
        return null;
      }
    });
  },

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

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
  if (state.drive?.busy) {
    const p = state.drive.progress;
    el.append(h('span', { class: 'chip', id: 'drive-chip' }, h('span', { class: 'dot' }), p?.total ? `Drive sync ${p.done}/${p.total}` : 'Drive sync…'));
  }
  for (const [name, label] of [['health', 'Health Connect'], ['intervals', 'intervals.icu']]) {
    if (!state[name]?.busy) continue;
    const p = state[name].progress;
    el.append(h('span', { class: 'chip' }, h('span', { class: 'dot' }), p?.total ? `${label} ${Math.min(p.done + 1, p.total)}/${p.total}` : `${label}…`));
  }
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
    drive: state.drive,
    health: state.health,
    intervals: state.intervals,
    platform,
    syncIndex: state.syncIndex,
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
  update({ meta: loaded.meta, diag: loaded.diag, syncIndex: loaded.syncIndex || null, basemapIndex: loaded.basemapIndex || null });
  if (isEmpty(loaded.ds)) await loadSample();
  else update({ ds: loaded.ds, isSample: false });
  update({ loading: false });
  render();
  if (platform.app) await autoSyncApp();
  else await checkDrive({ auto: true });
}

boot().catch((err) => {
  console.error(err);
  const view = $('view');
  clear(view);
  view.append(h('div', { class: 'msg err' }, h('strong', { text: 'The logbook could not start' }), String(err?.message || err)));
});
