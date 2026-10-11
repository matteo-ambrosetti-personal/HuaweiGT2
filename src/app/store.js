// Persistence. CloudStore keeps everything in the artifact's db under the
// viewer's private subtree data/users/<uid>/ (invisible to other viewers).
// MemoryStore is the fallback when db is unavailable (local copy, signed out).
//
// Layout: meta · diag · days-YYYY-MM · wk-YYYY-MM · sleep-YYYY-MM, plus
// tracks/items/<workoutId>. Only documents whose content hash changed are written.

import { emptyDataset } from '../lib/model.js';
import { decodePolyline, encodePolyline } from '../lib/geo.js';

export const SCHEMA = 1;
const SAFE = /[^A-Za-z0-9_\-.~:@+]/g;
export const safeId = (s) => String(s).replace(SAFE, '_').slice(0, 180);
const MAX_DOC = 240 * 1024;

export function defaultMeta() {
  return { kind: 'meta', schema: SCHEMA, settings: {}, imports: [], hashes: {}, tracks: {}, sources: {}, updatedAt: null };
}

/** FNV-1a 32-bit hash of a string → hex. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Split a dataset into month documents (tracks excluded). */
export function datasetToDocs(ds) {
  const docs = new Map();
  const put = (id, kind, month) => {
    if (!docs.has(id)) docs.set(id, { kind, month, rows: kind === 'wk' ? undefined : {}, list: kind === 'wk' ? [] : undefined });
    return docs.get(id);
  };
  for (const [date, row] of Object.entries(ds.days)) put(`days-${date.slice(0, 7)}`, 'days', date.slice(0, 7)).rows[date] = row;
  for (const [date, night] of Object.entries(ds.nights)) put(`sleep-${date.slice(0, 7)}`, 'sleep', date.slice(0, 7)).rows[date] = night;
  for (const w of Object.values(ds.workouts)) put(`wk-${w.date.slice(0, 7)}`, 'wk', w.date.slice(0, 7)).list.push(w);
  for (const d of docs.values()) {
    if (d.list) d.list.sort((a, b) => a.start - b.start);
    for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  }
  return docs;
}

export function docsToDataset(docs) {
  const ds = emptyDataset();
  for (const d of docs) {
    if (d.kind === 'days') Object.assign(ds.days, d.rows || {});
    else if (d.kind === 'sleep') Object.assign(ds.nights, d.rows || {});
    else if (d.kind === 'wk') for (const w of d.list || []) ds.workouts[w.id] = w;
  }
  return ds;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Strict JSON copy: drops undefined, turns NaN/Infinity into null. */
const clean = (body) => JSON.parse(JSON.stringify(body));

async function withRetry(fn) {
  let unavailableRetried = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = e?.code;
      if (code === 'unavailable' && !unavailableRetried) {
        unavailableRetried = true;
        await sleep(300 + Math.random() * 700);
        continue;
      }
      if (code === 'resource_exhausted' && attempt < 5) {
        await sleep(1200 * (attempt + 1) + Math.random() * 500);
        continue;
      }
      throw e;
    }
  }
}

/** Run async tasks with limited concurrency. */
async function pool(items, limit, worker) {
  let i = 0;
  const errors = [];
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        await worker(items[idx], idx);
      } catch (e) {
        errors.push(e);
        if (e?.code === 'quota_exceeded' || e?.code === 'revoked' || e?.code === 'invalid_argument') {
          i = items.length; // stop
        }
      }
    }
  });
  await Promise.all(runners);
  return errors;
}

/** Drop every other sample of a stored track, keeping positions aligned. */
function halveTrack(t) {
  const keep = (arr) => (arr ? arr.filter((_, i) => i % 2 === 0) : arr);
  let poly = t.poly, posIdx = t.posIdx;
  if (t.poly && t.posIdx) {
    const pts = decodePolyline(t.poly);
    const kept = [], idx = [];
    t.posIdx.forEach((i, j) => {
      if (i % 2 === 0 && pts[j]) { kept.push(pts[j]); idx.push(i / 2); }
    });
    poly = kept.length ? encodePolyline(kept) : null;
    posIdx = kept.length ? idx : null;
  }
  return {
    ...t, n: Math.ceil(t.n / 2), step: t.step * 2,
    d: keep(t.d), hr: keep(t.hr), alt: keep(t.alt), spd: keep(t.spd), cad: keep(t.cad),
    poly, posIdx, thin: true,
  };
}

/** Shrink a track until it fits a document. */
export function fitTrack(track) {
  let t = track;
  while (JSON.stringify(t).length > MAX_DOC && t.n > 50) t = halveTrack(t);
  return t;
}

export class CloudStore {
  constructor(db, uid) {
    this.db = db;
    this.base = `data/users/${uid}`;
    this.kind = 'cloud';
  }

  async load() {
    const snap = await withRetry(() => this.db.collection(this.base).limit(1000).get());
    let meta = defaultMeta();
    let diag = null;
    const parts = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      if (!data) continue;
      if (doc.id === 'meta') meta = { ...defaultMeta(), ...data };
      else if (doc.id === 'diag') diag = data;
      else parts.push(data);
    }
    return { ds: docsToDataset(parts), meta, diag };
  }

  async loadTrack(id) {
    const snap = await withRetry(() => this.db.doc(`${this.base}/tracks/items/${safeId(id)}`).get());
    return snap.exists ? snap.data() : null;
  }

  async saveMeta(meta) {
    meta.updatedAt = new Date().toISOString();
    await withRetry(() => this.db.doc(`${this.base}/meta`).set(clean(meta)));
  }

  async saveDiag(diag) {
    const body = JSON.stringify(diag).length > MAX_DOC ? { note: 'too large', at: diag.at } : diag;
    await withRetry(() => this.db.doc(`${this.base}/diag`).set(clean(body)));
  }

  /**
   * Write changed month documents, then tracks not yet stored, then meta.
   * @returns {{written: number, tracksWritten: number, tracksSkipped: boolean, error?: object}}
   */
  async save(ds, meta, { tracks = {}, onProgress = () => {} } = {}) {
    const docs = datasetToDocs(ds);
    const changed = [];
    const nextHashes = {};
    for (const [id, body] of docs) {
      const h = hashString(JSON.stringify(body));
      nextHashes[id] = h;
      if (meta.hashes?.[id] !== h) changed.push([id, body]);
    }
    const removed = Object.keys(meta.hashes || {}).filter((id) => !docs.has(id));
    const pendingTracks = Object.entries(tracks).filter(([id, t]) => t && !meta.tracks?.[id]);
    const total = changed.length + removed.length + pendingTracks.length;
    let done = 0;
    const tick = () => onProgress({ done: ++done, total });

    const errs = await pool(changed, 3, async ([id, body]) => {
      await withRetry(() => this.db.doc(`${this.base}/${id}`).set(clean(body)));
      meta.hashes[id] = nextHashes[id];
      tick();
    });
    for (const id of removed) {
      try {
        await withRetry(() => this.db.doc(`${this.base}/${id}`).delete());
        delete meta.hashes[id];
      } catch {
        /* keep going */
      }
      tick();
    }
    const fatal = errs.find((e) => e?.code);
    let tracksWritten = 0, tracksSkipped = false, trackError = null;
    if (!fatal) {
      const terrs = await pool(pendingTracks, 3, async ([id, t]) => {
        const body = clean(fitTrack(t));
        await withRetry(() => this.db.doc(`${this.base}/tracks/items/${safeId(id)}`).set(body));
        meta.tracks[id] = 1;
        tracksWritten++;
        tick();
      });
      if (terrs.length) {
        trackError = terrs[0];
        tracksSkipped = true;
      }
    }
    await this.saveMeta(meta).catch(() => {});
    return { written: changed.length, tracksWritten, tracksSkipped, error: fatal || trackError || null };
  }

  /** Delete every stored document of this viewer. */
  async clear(meta, onProgress = () => {}) {
    const ids = [...Object.keys(meta.hashes || {}), 'diag', 'meta'];
    const trackIds = Object.keys(meta.tracks || {});
    const total = ids.length + trackIds.length;
    let done = 0;
    await pool(trackIds, 3, async (id) => {
      await withRetry(() => this.db.doc(`${this.base}/tracks/items/${safeId(id)}`).delete());
      onProgress({ done: ++done, total });
    });
    // also sweep anything not listed in meta
    try {
      const snap = await this.db.collection(this.base).limit(1000).get();
      for (const d of snap.docs) if (!ids.includes(d.id)) ids.push(d.id);
    } catch {
      /* ignore */
    }
    for (const id of ids) {
      try {
        await withRetry(() => this.db.doc(`${this.base}/${id}`).delete());
      } catch {
        /* ignore */
      }
      onProgress({ done: ++done, total });
    }
  }
}

export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.state = null;
    this.trackStore = {};
  }

  async load() {
    if (!this.state) return { ds: emptyDataset(), meta: defaultMeta(), diag: null };
    return structuredClone(this.state);
  }

  async loadTrack(id) {
    return this.trackStore[id] || null;
  }

  async saveMeta(meta) {
    this.state = { ...(this.state || { ds: emptyDataset(), diag: null }), meta: structuredClone(meta) };
  }

  async saveDiag(diag) {
    this.state = { ...(this.state || { ds: emptyDataset(), meta: defaultMeta() }), diag: structuredClone(diag) };
  }

  async save(ds, meta, { tracks = {}, onProgress = () => {} } = {}) {
    let n = 0;
    for (const [id, t] of Object.entries(tracks)) {
      if (t) {
        this.trackStore[id] = t;
        meta.tracks[id] = 1;
        n++;
      }
    }
    for (const [id, body] of datasetToDocs(ds)) meta.hashes[id] = hashString(JSON.stringify(body));
    this.state = { ds: structuredClone(ds), meta: structuredClone(meta), diag: this.state?.diag ?? null };
    onProgress({ done: 1, total: 1 });
    return { written: 0, tracksWritten: n, tracksSkipped: false, error: null };
  }

  async clear() {
    this.state = null;
    this.trackStore = {};
  }
}
