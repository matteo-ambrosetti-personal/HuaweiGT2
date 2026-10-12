// Google Drive → Health Sync sync. DOM-free: `call(tool, input)` makes one
// "Google Drive" connector call and resolves the tool's payload (main.js wires
// it to claude.use("mcp").callTool), so tests can pass a fake Drive.
//
// Tool shapes observed on the real connector (Oct 2026):
//   search_files {query, pageSize, pageToken, excludeContentSnippets}
//     → {files: [{id, title, mimeType, modifiedTime, parentId, fileSize, fileExtension, …}], nextPageToken?}
//       or {} when there is nothing (more)
//   download_file_content {fileId} → {content: <base64>, id, mimeType, title}
// Queries scoped by parentId filter modifiedTime exactly and honour pageSize;
// title queries match by day and page irregularly, so they only find folders.
// Result order is not reliable, so listings always run to the last page.
//
// Change detection: an index {fileId → [modifiedMs, kind, firstDay, lastDay, extra]}
// is kept in the private doc data/users/<uid>/hsync (extra: the data source of
// a sample file, the folder of a skipped one). Health Sync's daily and weekly
// files can cover the same minutes, so a touched day is rebuilt from every
// indexed file of that metric covering it, unioned minute by minute within
// each source; sources are never added together (samplesFragment).

import { parseSampleCsv, samplesFragment, rowsRange, parseActivityFile, parseDailyCsv, sourceFromTitle, SAMPLE_METRICS, SAMPLE_LABELS, SAMPLE_FIELDS } from '../lib/healthsync.js';
import { emptyDataset, METRIC_GROUPS } from '../lib/model.js';
import { addDays } from '../lib/format.js';

export const DRIVE = 'Google Drive';
export const DRIVE_TOOLS = ['search_files', 'download_file_content'];

const FOLDER = 'application/vnd.google-apps.folder';
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const MAX_FOLDER_PAGES = 10;
const MAX_FILE_PAGES = 50;
const PARENTS_PER_QUERY = 10;
const MARGIN_MS = 5 * 60000;
const MAX_FILE_BYTES = 5e6;
const MAX_SPAN_DAYS = 62;
export const MAX_INDEX_BYTES = 200 * 1024;
// Bumped when the way days are built changes: an older index is dropped, so the
// next sync re-reads every file once (v2: sources kept apart, calories).
export const INDEX_VERSION = 2;

export function emptyIndex() {
  return { kind: 'hsync', v: INDEX_VERSION, cursor: null, folders: {}, files: {}, skipInfo: {}, prunedBefore: null, lastReport: null };
}

const isSample = (kind) => Object.prototype.hasOwnProperty.call(SAMPLE_METRICS, kind);
const modMs = (f) => Date.parse(f?.modifiedTime);
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function syncError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Base64 → UTF-8 text. */
export function decodeBase64Text(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Days from a to b inclusive ("YYYY-MM-DD"), capped. */
function spanDays(a, b) {
  if (!a) return [];
  const out = [];
  for (let d = a; d <= (b || a) && out.length < MAX_SPAN_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Run tasks with limited concurrency; stops scheduling and rethrows on the first failure. */
async function pool(items, limit, worker) {
  let next = 0, failure = null;
  const run = async () => {
    while (next < items.length && !failure) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (e) {
        failure ||= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  if (failure) throw failure;
}

/** One retry per sync, only for errors the runtime marks retryable (all calls here are reads). */
function retrying(call, sleep) {
  let budget = 1;
  return async (tool, input) => {
    try {
      return await call(tool, input);
    } catch (e) {
      if (!e?.retryable || budget <= 0) throw e;
      budget--;
      await sleep(Math.min(60000, Number(e.retryAfterMs) || 0) + 400 + Math.random() * 1200);
      return call(tool, input);
    }
  };
}

async function findFolders(invoke) {
  const found = new Map();
  let pageToken = null;
  for (let page = 0; page < MAX_FOLDER_PAGES; page++) {
    const res = await invoke('search_files', {
      query: `title contains 'Health Sync' and mimeType = '${FOLDER}'`,
      pageSize: 100,
      excludeContentSnippets: true,
      ...(pageToken ? { pageToken } : {}),
    });
    const files = Array.isArray(res?.files) ? res.files : [];
    for (const f of files) {
      const title = String(f?.title || '').trim();
      if (SAFE_ID.test(f?.id || '') && f.mimeType === FOLDER && /^health sync\b/i.test(title)) found.set(f.id, title);
    }
    pageToken = res?.nextPageToken;
    if (!pageToken || !files.length) break;
  }
  return [...found].map(([id, title]) => ({ id, title }));
}

function parentClauses(folderIds) {
  const out = [];
  for (let i = 0; i < folderIds.length; i += PARENTS_PER_QUERY) {
    out.push(`(${folderIds.slice(i, i + PARENTS_PER_QUERY).map((id) => `parentId = '${id}'`).join(' or ')})`);
  }
  return out;
}

async function listFiles(invoke, folderIds, since) {
  const out = new Map();
  let truncated = false;
  for (const parents of parentClauses(folderIds)) {
    const query = `${parents} and mimeType != '${FOLDER}'${since ? ` and modifiedTime > '${since}'` : ''}`;
    let pageToken = null;
    for (let page = 0; ; page++) {
      if (page === MAX_FILE_PAGES) { truncated = true; break; }
      const res = await invoke('search_files', { query, pageSize: 100, excludeContentSnippets: true, ...(pageToken ? { pageToken } : {}) });
      const files = Array.isArray(res?.files) ? res.files : [];
      for (const f of files) if (SAFE_ID.test(f?.id || '') && f.mimeType !== FOLDER && Number.isFinite(modMs(f))) out.set(f.id, f);
      pageToken = res?.nextPageToken;
      if (!pageToken || !files.length) break;
    }
  }
  return { files: [...out.values()], truncated };
}

/** Is the file still in a Health Sync folder with the same modified time? */
async function stillThere(invoke, folderIds, id, m) {
  const iso = new Date(m).toISOString();
  for (const parents of parentClauses(folderIds)) {
    const res = await invoke('search_files', { query: `${parents} and modifiedTime = '${iso}'`, pageSize: 100, excludeContentSnippets: true });
    if ((res?.files || []).some((f) => f?.id === id)) return true;
  }
  return false;
}

async function download(invoke, id) {
  const res = await invoke('download_file_content', { fileId: id });
  if (typeof res?.content !== 'string') throw syncError('bad_response', 'Google Drive returned no file content.');
  return decodeBase64Text(res.content);
}

function extOf(f) {
  const e = String(f.fileExtension || '').toLowerCase();
  if (e) return e;
  const m = /\.([a-z0-9]+)$/i.exec(String(f.title || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Downloaded file → {kind, a, b, …}; kind is a sample metric, 'daily', 'act' or 'skip'. */
function parseFile(f, text) {
  const ext = extOf(f);
  if (ext === 'csv') {
    const s = parseSampleCsv(text);
    if (s.metric) {
      const [a, b] = rowsRange(s.rows);
      return { kind: s.metric, rows: s.rows, a, b, source: sourceFromTitle(f.title) };
    }
    const d = parseDailyCsv(text);
    const keys = [...Object.keys(d.days), ...Object.keys(d.nights)].sort();
    if (keys.length) return { kind: 'daily', days: d.days, nights: d.nights, a: keys[0], b: keys.at(-1) };
    return { kind: 'skip', reason: 'columns not recognised', header: s.header.join(',').slice(0, 160) };
  }
  if (ext === 'gpx' || ext === 'tcx') {
    const title = String(f.title || f.id);
    const name = title.toLowerCase().endsWith(`.${ext}`) ? title : `${title}.${ext}`;
    const res = parseActivityFile(name, text, f.id);
    if (res) return { kind: 'act', activity: res, a: res.workout.date, b: res.workout.date };
    return { kind: 'skip', reason: `unreadable ${ext.toUpperCase()} file` };
  }
  return { kind: 'skip', reason: ext ? `.${ext} files are not read` : 'unknown file type' };
}

/**
 * Pull new and changed Health Sync files from Google Drive.
 * @param {{call: (tool: string, input: object) => Promise<any>, index?: object,
 *          onProgress?: (p: object) => void, sleep?: (ms: number) => Promise<void>}} opts
 * @returns {Promise<{fragment: object, index: object, report: object}>} Rejects with the
 *   connector's error ({code, message, retryable?}) when listing or access fails; nothing
 *   is then changed. Unreadable single files are skipped and retried next time.
 */
export async function syncDrive({ call, index: prevIndex, onProgress = () => {}, sleep = defaultSleep }) {
  const prev = prevIndex?.kind === 'hsync' && prevIndex.v === INDEX_VERSION ? prevIndex : emptyIndex();
  const invoke = retrying(call, sleep);
  const fragment = emptyDataset();
  const report = { at: new Date().toISOString(), folders: 0, listed: 0, changed: 0, read: 0, days: 0, workouts: 0, metrics: [], failed: 0, truncated: false };

  onProgress({ phase: 'folders' });
  const folders = await findFolders(invoke);
  report.folders = folders.length;
  const index = {
    ...emptyIndex(),
    cursor: prev.cursor,
    prunedBefore: prev.prunedBefore,
    folders: Object.fromEntries(folders.map((f) => [f.id, f.title])),
    files: { ...prev.files },
    skipInfo: { ...(prev.skipInfo || {}) },
  };
  if (!folders.length) return { fragment, index: finish(index, report), report };
  const folderIds = folders.map((f) => f.id);

  onProgress({ phase: 'list' });
  const { files: listed, truncated } = await listFiles(invoke, folderIds, prev.cursor ? isoSeconds(prev.cursor - MARGIN_MS) : null);
  report.listed = listed.length;
  report.truncated = truncated;
  const changed = listed.filter((f) => prev.files[f.id]?.[0] !== modMs(f)).sort((x, y) => modMs(x) - modMs(y));
  report.changed = changed.length;

  // 1. Read the new and changed files.
  const got = new Map(); // id → parsed file
  const failed = new Set();
  let done = 0;
  let total = changed.length;
  await pool(changed, 3, async (f) => {
    if (Number(f.fileSize) > MAX_FILE_BYTES) got.set(f.id, { kind: 'skip', reason: 'file too large' });
    else {
      try {
        got.set(f.id, parseFile(f, await download(invoke, f.id)));
        report.read++;
      } catch (e) {
        if (e?.code !== 'tool_error' && e?.code !== 'bad_response') throw e; // access problem: abort the run
        failed.add(f.id);
      }
    }
    onProgress({ phase: 'read', done: ++done, total });
  });
  for (const f of changed) {
    const p = got.get(f.id);
    if (p) Object.assign(p, { m: modMs(f), title: String(f.title || ''), parent: f.parentId });
  }

  // 2. Which (metric, day) pairs need rebuilding, and which must wait for a retry.
  const touched = new Map();
  const deferred = new Map();
  const add = (map, metric, days) => {
    if (!map.has(metric)) map.set(metric, new Set());
    for (const d of days) map.get(metric).add(d);
  };
  const oldDays = (id) => {
    const e = prev.files[id];
    return e && isSample(e[1]) ? spanDays(e[2], e[3]) : [];
  };
  for (const f of changed) {
    const e = prev.files[f.id];
    if (failed.has(f.id)) {
      if (e && isSample(e[1])) add(deferred, e[1], oldDays(f.id));
      continue;
    }
    const p = got.get(f.id);
    if (e && isSample(e[1])) add(touched, e[1], oldDays(f.id));
    if (isSample(p.kind)) add(touched, p.kind, p.rows.map((r) => r.day));
  }

  // 3. Other indexed files covering those days (e.g. the weekly file next to a daily one).
  const needed = [];
  for (const [id, e] of Object.entries(prev.files)) {
    if (got.has(id) || failed.has(id) || !isSample(e[1]) || !e[2]) continue;
    const days = touched.get(e[1]);
    if (days && spanDays(e[2], e[3]).some((d) => days.has(d))) needed.push([id, e]);
  }
  const union = [];
  const gone = new Set();
  total += needed.length;
  await pool(needed, 3, async ([id, e]) => {
    try {
      const s = parseSampleCsv(await download(invoke, id));
      if (s.metric === e[1]) union.push({ metric: s.metric, rows: s.rows, m: e[0], source: e[4] || '' });
      report.read++;
    } catch (err) {
      if (err?.code !== 'tool_error' && err?.code !== 'bad_response') throw err;
      if (await stillThere(invoke, folderIds, id, e[0])) {
        add(deferred, e[1], spanDays(e[2], e[3]));
        report.failed++;
      } else gone.add(id); // deleted from Drive: rebuild without it
    }
    onProgress({ phase: 'read', done: ++done, total });
  });

  // 4. Rebuild the touched days that are not waiting on an unreadable file.
  const want = new Map();
  for (const [metric, days] of touched) {
    const skip = deferred.get(metric);
    const keep = new Set([...days].filter((d) => !skip?.has(d)));
    if (keep.size) want.set(metric, keep);
  }
  const sampleFiles = [...union];
  for (const p of got.values()) if (isSample(p.kind)) sampleFiles.push({ metric: p.kind, rows: p.rows, m: p.m, source: p.source });
  fragment.days = samplesFragment(sampleFiles, want);

  for (const p of got.values()) {
    if (p.kind === 'daily') {
      for (const [d, row] of Object.entries(p.days)) Object.assign((fragment.days[d] ||= {}), row);
      Object.assign(fragment.nights, p.nights);
    } else if (p.kind === 'act') {
      const { workout, track } = p.activity;
      fragment.workouts[workout.id] = workout;
      if (track) fragment.tracks[workout.id] = track;
    } else if (p.kind === 'skip' && p.parent) {
      index.skipInfo[p.parent] = { title: p.title, reason: p.reason, ...(p.header ? { header: p.header } : {}) };
    }
  }

  // 5. Update the index; files waiting on a retry keep the cursor behind them.
  const blocked = (id, p) => {
    if (!p) return true;
    const days = [...(isSample(p.kind) ? p.rows.map((r) => r.day) : []), ...oldDays(id)];
    const metric = isSample(p.kind) ? p.kind : prev.files[id]?.[1];
    const skip = deferred.get(metric);
    return Boolean(skip && days.some((d) => skip.has(d)));
  };
  let pendingFrom = Infinity;
  for (const f of changed) {
    const p = got.get(f.id);
    if (blocked(f.id, p)) {
      pendingFrom = Math.min(pendingFrom, modMs(f));
      continue;
    }
    if (p.kind === 'skip') index.files[f.id] = [p.m, 'skip', null, null, p.parent || null];
    else if (isSample(p.kind)) index.files[f.id] = [p.m, p.kind, p.a ?? null, p.b ?? null, p.source || ''];
    else index.files[f.id] = [p.m, p.kind, p.a ?? null, p.b ?? null];
  }
  for (const id of gone) delete index.files[id];
  report.failed += failed.size;

  const newest = listed.reduce((mx, f) => Math.max(mx, modMs(f)), prev.cursor || 0) || null;
  if (truncated) index.cursor = prev.cursor;
  else index.cursor = Number.isFinite(pendingFrom) ? Math.min(newest, pendingFrom - 1) : newest;

  report.days = Object.keys(fragment.days).length;
  report.workouts = Object.keys(fragment.workouts).length;
  const dayRows = Object.values(fragment.days);
  report.metrics = [
    ...[...want.keys()].filter((m) => dayRows.some((r) => r[SAMPLE_FIELDS[m]] != null)).map((m) => SAMPLE_LABELS[m]),
    ...(report.workouts ? ['workouts'] : []),
    ...([...got.values()].some((p) => p.kind === 'daily') ? ['daily summaries'] : []),
  ];
  return { fragment, index: finish(index, report), report };
}

function finish(index, report) {
  index.lastReport = report;
  // Drop notes about folders whose skipped files are gone or now readable.
  const stillSkipped = new Set(Object.values(index.files).filter((e) => e[1] === 'skip').map((e) => e[4]));
  for (const id of Object.keys(index.skipInfo)) if (!stillSkipped.has(id)) delete index.skipInfo[id];
  return fitIndex(index);
}

/**
 * Keep the index doc small: drop the entries with the oldest days first and
 * remember the horizon (days before it are only filled from then on).
 */
export function fitIndex(index, maxBytes = MAX_INDEX_BYTES) {
  if (JSON.stringify(index).length <= maxBytes) return index;
  const entries = Object.entries(index.files).sort((x, y) => String(x[1][3] || '').localeCompare(String(y[1][3] || '')));
  const files = { ...index.files };
  let prunedBefore = index.prunedBefore;
  for (let cut = 0; cut < entries.length && JSON.stringify({ ...index, files }).length > maxBytes; cut += 100) {
    for (const [id, e] of entries.slice(cut, cut + 100)) {
      delete files[id];
      if (e[3] && (!prunedBefore || addDays(e[3], 1) > prunedBefore)) prunedBefore = addDays(e[3], 1);
    }
  }
  return { ...index, files, prunedBefore };
}

/**
 * Days before the pruned horizon may be rebuilt from a partial set of files:
 * there, only fill metric groups Health Sync has not filled already.
 */
export function protectPruned(fragment, ds, before) {
  if (!before) return fragment;
  for (const [date, row] of Object.entries(fragment.days)) {
    if (date >= before) continue;
    const src = ds.days[date]?.src;
    if (!src) continue;
    for (const [group, fields] of Object.entries(METRIC_GROUPS)) {
      if (src[group] === 'healthsync') for (const f of fields) delete row[f];
    }
    if (!Object.keys(row).length) delete fragment.days[date];
  }
  return fragment;
}

/** Folders whose files are not read yet: [{folder, n, title, reason, header}]. */
export function skippedFolders(index) {
  const counts = {};
  for (const e of Object.values(index?.files || {})) if (e[1] === 'skip' && e[4]) counts[e[4]] = (counts[e[4]] || 0) + 1;
  return Object.entries(counts).map(([id, n]) => ({ folder: index.folders?.[id] || 'Health Sync', n, ...(index.skipInfo?.[id] || {}) }));
}

/**
 * Copy for a failed sync, by McpError code. null = say nothing.
 * status drives the Drive card's chip; action 'permissions' adds an "Open permissions" button.
 */
export function driveErrorCopy(err) {
  const code = err?.code || 'upstream_error';
  switch (code) {
    case 'needs_reauth':
      return { status: 'reauth', title: 'Reconnect Google Drive', text: 'Google Drive access has lapsed. Reconnect it in claude.ai Settings → Connectors, then sync again.' };
    case 'server_not_connected':
    case 'server_not_found':
      return { status: 'missing', title: 'Google Drive is not connected', text: 'Add the Google Drive connector in claude.ai Settings → Connectors, then sync again.' };
    case 'selection_required':
      return { status: 'choose', title: 'Choose a Google Drive connector', text: 'You have more than one Google Drive connector. Pick one when claude.ai asks (reload the page if the prompt is gone), then sync again.' };
    case 'not_in_manifest':
    case 'consent_required':
      return { status: 'denied', title: 'Google Drive is off for this page', text: 'Allow Google Drive for this logbook in its permissions, then sync again.', action: 'permissions' };
    case 'approval_required':
      return { status: 'approval', title: 'Needs your approval', text: 'Click Sync now and choose Allow when claude.ai asks.' };
    case 'blocked_by_policy':
      return { status: 'blocked', title: 'Blocked by your organisation', text: "Your organisation's policy does not allow Google Drive here." };
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return { status: 'unavailable', title: 'Not available in this view', text: 'Connectors cannot be used in this view. Open the logbook on claude.ai to sync.' };
    case 'bad_request':
    case 'transform_error':
      return { status: 'error', title: 'Sync request rejected', text: `This is a bug in the page, please tell Claude: ${err.message || code}` };
    case 'server_unavailable':
    case 'rate_limited':
      return { status: 'error', title: "Google Drive didn't answer", text: 'Try again in a few minutes.' };
    case 'tool_error':
      return { status: 'error', title: 'Google Drive reported an error', text: err.message || 'The file search failed.' };
    case 'cancelled':
    case 'user_changed':
      return null;
    default:
      return { status: 'error', title: 'Sync failed', text: err?.message || 'Google Drive returned an error.' };
  }
}
