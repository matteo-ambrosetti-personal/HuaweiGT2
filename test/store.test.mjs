import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudStore, MemoryStore, defaultMeta } from '../src/app/store.js';
import { emptyIndex } from '../src/app/sync-drive.js';
import { emptyDataset, mergeDataset } from '../src/lib/model.js';

// Like the platform's db, reads hand back deep-frozen bodies.
function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

// In-memory stand-in for the artifact db (documents addressed by path).
function fakeDb() {
  const docs = new Map();
  return {
    docs,
    collection(path) {
      return {
        limit() { return this; },
        async get() {
          const out = [];
          for (const [p, data] of docs) {
            const rest = p.startsWith(`${path}/`) ? p.slice(path.length + 1) : null;
            if (rest && !rest.includes('/')) out.push({ id: rest, data: () => deepFreeze(structuredClone(data)) });
          }
          return { docs: out };
        },
      };
    },
    doc(path) {
      return {
        async get() { return { exists: docs.has(path), data: () => (docs.has(path) ? deepFreeze(structuredClone(docs.get(path))) : undefined) }; },
        async set(body) { docs.set(path, structuredClone(body)); },
        async delete() { docs.delete(path); },
      };
    },
  };
}

test('the Drive sync index round-trips through private storage', async () => {
  const db = fakeDb();
  const store = new CloudStore(db, 'u1');
  const ds = emptyDataset();
  mergeDataset(ds, { days: { '2026-03-08': { steps: 75 } } }, 'healthsync');
  await store.save(ds, defaultMeta());
  const index = { ...emptyIndex(), cursor: 123, files: { a: [123, 'steps', '2026-03-08', '2026-03-08'] } };
  await store.saveSyncIndex(index);

  const loaded = await store.load();
  assert.deepEqual(loaded.syncIndex, index);
  assert.equal(loaded.ds.days['2026-03-08'].steps, 75);
  assert.equal(Object.keys(loaded.ds.days).length, 1, 'the index is not read as data');

  // Later saves keep it; deleting everything removes it.
  mergeDataset(ds, { days: { '2026-04-01': { steps: 5 } } }, 'healthsync');
  await store.save(ds, loaded.meta);
  assert.ok(db.docs.has('data/users/u1/hsync'));
  await store.clear(loaded.meta);
  assert.equal(db.docs.size, 0);

  const huge = { ...emptyIndex(), files: { x: ['y'.repeat(300 * 1024)] } };
  await assert.rejects(store.saveSyncIndex(huge), { code: 'invalid_argument' });
});

test('the memory store keeps the sync index across saves', async () => {
  const mem = new MemoryStore();
  assert.equal((await mem.load()).syncIndex, null);
  const index = { ...emptyIndex(), cursor: 5 };
  await mem.saveSyncIndex(index);
  const ds = emptyDataset();
  mergeDataset(ds, { days: { '2026-03-08': { steps: 1 } } }, 'healthsync');
  await mem.save(ds, defaultMeta());
  await mem.saveMeta(defaultMeta());
  assert.deepEqual((await mem.load()).syncIndex, index);
});

test('data loaded from storage can be updated (snapshots are frozen)', async () => {
  const db = fakeDb();
  const store = new CloudStore(db, 'u2');
  const ds = emptyDataset();
  mergeDataset(ds, { days: { '2026-03-08': { steps: 75 } } }, 'healthsync');
  const w = { id: 'hw-1', date: '2026-03-08', start: Date.UTC(2026, 2, 8, 7), duration: 600, family: 'other', label: 'Type NaN' };
  mergeDataset(ds, { workouts: { 'hw-1': w } }, 'export');
  await store.save(ds, defaultMeta());

  const loaded = await store.load();
  // A higher-ranked source updates a day that came from storage...
  mergeDataset(loaded.ds, { days: { '2026-03-08': { steps: 80, distance: 50 } } }, 'export');
  assert.equal(loaded.ds.days['2026-03-08'].steps, 80);
  assert.equal(loaded.ds.days['2026-03-08'].src.steps, 'export');
  // ...a re-import replaces a stored workout...
  mergeDataset(loaded.ds, { workouts: { 'hw-1': { ...w, family: 'run', label: 'Outdoor run', distance: 1800 } } }, 'export');
  assert.equal(loaded.ds.workouts['hw-1'].family, 'run');
  // ...and saving records the new hashes and tracks.
  const before = { ...loaded.meta.hashes };
  await store.save(loaded.ds, loaded.meta, { tracks: { 'hw-1': { id: 'hw-1', n: 2, step: 1, t0: 0, d: [0, 1] } } });
  assert.notEqual(loaded.meta.hashes['days-2026-03'], before['days-2026-03']);
  assert.equal(loaded.meta.tracks['hw-1'], 1);
  const again = await store.load();
  assert.equal(again.ds.days['2026-03-08'].steps, 80);
  assert.equal(again.meta.tracks['hw-1'], 1);
  assert.deepEqual((await store.loadTrack('hw-1')).d, [0, 1]);
});

test('the map is stored privately: index, chunks, replacement and deletion', async () => {
  const db = fakeDb();
  const store = new CloudStore(db, 'u1');
  const chunk = (n) => ({ kind: 'basemap', v: 1, lines: { minor: [`poly${n}`] }, fills: {}, labels: [] });
  const index = { kind: 'basemap-index', v: 1, areas: [{ id: 'a1', cells: ['1000_2000'], items: ['a1-0', 'a1-1'] }] };
  await store.saveBasemap(index, { 'a1-0': chunk(0), 'a1-1': chunk(1) });
  assert.ok(db.docs.has('data/users/u1/basemap/items/a1-1'));

  const loaded = await store.load();
  assert.deepEqual(loaded.basemapIndex, index);
  assert.equal(Object.keys(loaded.ds.days).length, 0, 'the map index is not read as data');
  const item = await store.loadBasemapItem('a1-0');
  item.labels.push(['editable', 0, 0, 'place', 3]); // loads are mutable copies
  assert.equal(await store.loadBasemapItem('missing'), null);

  // A newer download replaces the area; its old chunks go.
  const next = { kind: 'basemap-index', v: 1, areas: [{ id: 'a2', cells: ['1000_2000'], items: ['a2-0'] }] };
  await store.saveBasemap(next, { 'a2-0': chunk(2) }, ['a1-0', 'a1-1']);
  assert.ok(!db.docs.has('data/users/u1/basemap/items/a1-0'));
  assert.deepEqual((await store.load()).basemapIndex, next);

  // Deleting everything includes the map.
  await store.clear(defaultMeta());
  assert.equal([...db.docs.keys()].filter((k) => k.includes('basemap')).length, 0);

  await store.saveBasemap(next, { 'a2-0': chunk(2) });
  await store.removeBasemap(next);
  assert.equal([...db.docs.keys()].length, 0);
});

test('the memory store keeps a map for the session', async () => {
  const store = new MemoryStore();
  const index = { kind: 'basemap-index', v: 1, areas: [{ id: 'a1', cells: [], items: ['a1-0'] }] };
  await store.saveBasemap(index, { 'a1-0': { kind: 'basemap', lines: {}, fills: {}, labels: [] } });
  await store.save(emptyDataset(), defaultMeta());
  assert.deepEqual((await store.load()).basemapIndex, index, 'a later save keeps it');
  assert.equal((await store.loadBasemapItem('a1-0')).kind, 'basemap');
  await store.removeBasemap(index);
  assert.equal((await store.load()).basemapIndex, null);
});
