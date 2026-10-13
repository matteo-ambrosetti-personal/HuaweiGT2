// GT 2 Logbook — boot, routing, filters and actions.

import { state, update, settings, saveFilter } from './state.js';
import { getRuntime } from './runtime.js';
import { CloudStore, MemoryStore, defaultMeta } from './store.js';
import { Importer } from './importer.js';
import { h, clear, toast } from './ui.js';
import { emptyDataset, mergeDataset, isEmpty, datasetRange, SOURCE_LABELS, workoutList } from '../lib/model.js';
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
import { renderData, renderDriveCard } from './views/data.js';
import { rangeText } from './views/common.js';
import { syncDrive as runDriveSync, DRIVE, driveErrorCopy, protectPruned } from './sync-drive.js';

const VIEWS = {
  overview: renderOverview,
  activity: renderActivity,
  workouts: renderWorkouts,
  workout: renderWorkout,
  sleep: renderSleep,
  heart: renderHeart,
  records: renderRecords,
  ask: renderAsk,
  data: renderData,
};
const FILTERED = new Set(['overview', 'activity', 'workouts', 'sleep', 'heart']);
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
    const summary = `Read ${c.workouts} workouts, ${c.days} days and ${c.nights} nights${range?.from ? ` from ${fmtDate(range.from)} to ${fmtDate(range.to)}` : ''}.${res.diag.parseErrors ? ` ${res.diag.parseErrors} unreadable records were skipped.` : ''} ${state.store.kind === 'cloud' ? 'Saving to your private storage in the background.' : 'This view cannot save, so the data lasts until you close the page.'}`;
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
  exportBackup() {
    return exporter.exportBackup(state.runtime?.downloads, state.ds, state.isSample ? {} : state.tracks);
  },
  exportRoutes(workouts, format) {
    return exporter.exportRoutes(state.runtime?.downloads, workouts, format, (id) => actions.loadTrack(id), (p) => setBusy(`Preparing ${p.done}/${p.total}`, p));
  },
  exportRoutesInRange(format) {
    const range = currentRange();
    const ws = workoutsIn(state.ds, range).filter((w) => !state.filter.families || state.filter.families.includes(chartBucket(w.family)));
    return actions.exportRoutes(ws, format).finally(() => setBusy(null));
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
    update({ ds: emptyDataset(), meta: defaultMeta(), tracks: {}, diag: null, syncIndex: null, drive: { ...state.drive, report: null, error: null } });
    await loadSample();
    location.hash = 'overview';
    render();
  },
};

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
  if (document.visibilityState === 'visible' && !state.loading && state.runtime) checkDrive({ auto: true });
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
  if (state.store.kind !== 'cloud') return { error: null };
  setBusy('Saving', { done: 0, total: 1 });
  try {
    const res = await state.store.save(state.ds, state.meta, { tracks, onProgress: (p) => setBusy('Saving', p) });
    if (diag) await state.store.saveDiag(diag).catch(() => {});
    if (res.error?.code === 'quota_exceeded') toast('Storage is full: some routes stay only in this session. Summaries are saved.', 6000);
    else if (res.error) toast(`Some data was not saved (${res.error.code || 'error'}). It is still shown; try importing again later.`, 6000);
    else if (!quiet) toast('Saved to your private storage.');
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
    if (r === state.route || (state.route === 'workout' && r === 'workouts')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
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
    syncIndex: state.syncIndex,
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
  let store = runtime.db && runtime.uid ? new CloudStore(runtime.db, runtime.uid) : new MemoryStore();
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
    toast('Your private storage could not be reached; changes will not be saved in this view.', 6000);
  }
  update({ meta: loaded.meta, diag: loaded.diag, syncIndex: loaded.syncIndex || null });
  if (isEmpty(loaded.ds)) await loadSample();
  else update({ ds: loaded.ds, isSample: false });
  update({ loading: false });
  render();
  await checkDrive({ auto: true });
}

boot().catch((err) => {
  console.error(err);
  const view = $('view');
  clear(view);
  view.append(h('div', { class: 'msg err' }, h('strong', { text: 'The logbook could not start' }), String(err?.message || err)));
});
