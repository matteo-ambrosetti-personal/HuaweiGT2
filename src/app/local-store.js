// Persistence for the standalone build: IndexedDB on this device.
//
// Same interface and document layout as CloudStore (store.js), so main.js and
// the views do not care which one they have:
//   docs  store: meta · diag · hsync · basemap · days-YYYY-MM · wk-YYYY-MM · sleep-YYYY-MM
//   items store: t:<workoutId> (tracks) · m:<chunkId> (map chunks)
// Only month documents whose content hash changed are rewritten. Nothing here
// leaves the device: there is no account and no server.
//
// The key-value layer is separate (idbKv / memoryKv) so the store's logic runs
// under `node --test` without a browser.

import { datasetToDocs, docsToDataset, defaultMeta, hashString } from './store.js';

const DB_NAME = 'gt2-logbook';
const BATCH = 40; // writes per transaction: progress stays visible on a first import of years of routes

const reqP = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
});

/** Give storage errors the codes main.js already understands. */
function coded(e) {
  if (e?.code && typeof e.code === 'string') return e;
  const name = e?.name || '';
  const code = name === 'QuotaExceededError' ? 'quota_exceeded' : name === 'DataCloneError' ? 'invalid_argument' : 'unavailable';
  return Object.assign(new Error(e?.message || name || 'Storage error'), { code, cause: e });
}

/** IndexedDB key-value store with two object stores, `docs` and `items`. */
export async function idbKv(name = DB_NAME) {
  if (typeof indexedDB === 'undefined') throw Object.assign(new Error('IndexedDB is not available'), { code: 'unavailable' });
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      for (const s of ['docs', 'items']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Object.assign(new Error('Storage is busy in another tab'), { code: 'unavailable' }));
  }).catch((e) => { throw coded(e); });
  // Another tab upgrading the database (a newer build) closes this connection cleanly.
  db.onversionchange = () => db.close();
  return {
    async all(store) {
      try {
        const tx = db.transaction(store, 'readonly');
        const os = tx.objectStore(store);
        const [keys, values] = await Promise.all([reqP(os.getAllKeys()), reqP(os.getAll())]);
        return keys.map((k, i) => [k, values[i]]);
      } catch (e) {
        throw coded(e);
      }
    },
    async get(store, key) {
      try {
        const v = await reqP(db.transaction(store, 'readonly').objectStore(store).get(key));
        return v === undefined ? null : v;
      } catch (e) {
        throw coded(e);
      }
    },
    /** ops: [{store, key, value}] puts and [{store, key, del: true}] deletes, in one transaction. */
    async write(ops) {
      if (!ops.length) return;
      try {
        const stores = [...new Set(ops.map((o) => o.store))];
        const tx = db.transaction(stores, 'readwrite');
        for (const o of ops) {
          const os = tx.objectStore(o.store);
          if (o.del) os.delete(o.key);
          else os.put(o.value, o.key);
        }
        await txDone(tx);
      } catch (e) {
        throw coded(e);
      }
    },
    async clear() {
      try {
        const tx = db.transaction(['docs', 'items'], 'readwrite');
        tx.objectStore('docs').clear();
        tx.objectStore('items').clear();
        await txDone(tx);
      } catch (e) {
        throw coded(e);
      }
    },
  };
}

/** The same interface in memory (tests). `failOn(op)` returning an error simulates a full disk. */
export function memoryKv({ failOn } = {}) {
  const stores = { docs: new Map(), items: new Map() };
  return {
    stores,
    async all(store) {
      return [...stores[store].entries()].map(([k, v]) => [k, structuredClone(v)]);
    },
    async get(store, key) {
      return stores[store].has(key) ? structuredClone(stores[store].get(key)) : null;
    },
    async write(ops) {
      for (const o of ops) {
        const err = failOn?.(o);
        if (err) throw err;
      }
      for (const o of ops) {
        if (o.del) stores[o.store].delete(o.key);
        else stores[o.store].set(o.key, structuredClone(o.value));
      }
    },
    async clear() {
      stores.docs.clear();
      stores.items.clear();
    },
  };
}

/** Strict JSON copy: drops undefined and functions, turns NaN/Infinity into null. */
const clean = (body) => JSON.parse(JSON.stringify(body));

export class LocalStore {
  constructor(kv) {
    this.kv = kv;
    this.kind = 'local';
    this.persistent = true;
  }

  async load() {
    const rows = await this.kv.all('docs');
    let meta = defaultMeta();
    let diag = null, syncIndex = null, basemapIndex = null;
    const parts = [];
    for (const [id, data] of rows) {
      if (!data) continue;
      if (id === 'meta') meta = { ...defaultMeta(), ...data };
      else if (id === 'diag') diag = data;
      else if (id === 'hsync') syncIndex = data;
      else if (id === 'basemap') basemapIndex = data;
      else parts.push(data);
    }
    return { ds: docsToDataset(parts), meta, diag, syncIndex, basemapIndex };
  }

  loadTrack(id) {
    return this.kv.get('items', `t:${id}`);
  }

  loadBasemapItem(id) {
    return this.kv.get('items', `m:${id}`);
  }

  /** Store a map: its chunks, the index that lists them and the removal of replaced chunks, together. */
  async saveBasemap(index, items = {}, removed = []) {
    await this.kv.write([
      ...Object.entries(items).map(([id, body]) => ({ store: 'items', key: `m:${id}`, value: clean(body) })),
      ...removed.map((id) => ({ store: 'items', key: `m:${id}`, del: true })),
      { store: 'docs', key: 'basemap', value: clean(index) },
    ]);
  }

  async removeBasemap(index) {
    const ids = (index?.areas || []).flatMap((a) => a.items || []);
    await this.kv.write([
      { store: 'docs', key: 'basemap', del: true },
      ...ids.map((id) => ({ store: 'items', key: `m:${id}`, del: true })),
    ]);
  }

  async saveMeta(meta) {
    meta.updatedAt = new Date().toISOString();
    await this.kv.write([{ store: 'docs', key: 'meta', value: clean(meta) }]);
  }

  async saveDiag(diag) {
    await this.kv.write([{ store: 'docs', key: 'diag', value: clean(diag) }]);
  }

  async saveSyncIndex(index) {
    await this.kv.write([{ store: 'docs', key: 'hsync', value: clean(index) }]);
  }

  /**
   * Write changed month documents and removals first (they are what the
   * charts are drawn from), then tracks not yet stored, then meta.
   * @returns {{written: number, tracksWritten: number, tracksSkipped: boolean, error: object|null}}
   */
  async save(ds, meta, { tracks = {}, onProgress = () => {} } = {}) {
    meta.hashes ||= {};
    meta.tracks ||= {};
    const docs = datasetToDocs(ds);
    const changed = [];
    const nextHashes = {};
    for (const [id, body] of docs) {
      const h = hashString(JSON.stringify(body));
      nextHashes[id] = h;
      if (meta.hashes[id] !== h) changed.push([id, body]);
    }
    const removed = Object.keys(meta.hashes).filter((id) => !docs.has(id));
    const pendingTracks = Object.entries(tracks).filter(([id, t]) => t && !meta.tracks[id]);
    const total = changed.length + removed.length + pendingTracks.length;
    let done = 0;

    let error = null;
    const docOps = [
      ...changed.map(([id, body]) => ({ store: 'docs', key: id, value: clean(body), apply: () => { meta.hashes[id] = nextHashes[id]; } })),
      ...removed.map((id) => ({ store: 'docs', key: id, del: true, apply: () => { delete meta.hashes[id]; } })),
    ];
    for (let i = 0; i < docOps.length && !error; i += BATCH) {
      const batch = docOps.slice(i, i + BATCH);
      try {
        await this.kv.write(batch);
        for (const o of batch) o.apply();
        done += batch.length;
        onProgress({ done, total });
      } catch (e) {
        error = coded(e);
      }
    }

    let tracksWritten = 0, tracksSkipped = false;
    if (!error) {
      for (let i = 0; i < pendingTracks.length; i += BATCH) {
        const batch = pendingTracks.slice(i, i + BATCH);
        try {
          await this.kv.write(batch.map(([id, t]) => ({ store: 'items', key: `t:${id}`, value: clean(t) })));
          for (const [id] of batch) meta.tracks[id] = 1;
          tracksWritten += batch.length;
          done += batch.length;
          onProgress({ done, total });
        } catch (e) {
          error = coded(e);
          tracksSkipped = true;
          break;
        }
      }
    }
    await this.saveMeta(meta).catch(() => {});
    return { written: changed.length, tracksWritten, tracksSkipped, error };
  }

  /** Delete everything this copy of the logbook stored on the device. */
  async clear(_meta, onProgress = () => {}) {
    await this.kv.clear();
    onProgress({ done: 1, total: 1 });
  }
}

/** Ask the browser not to evict this origin's storage under pressure. Never throws. */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}
