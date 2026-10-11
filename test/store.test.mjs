import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudStore, MemoryStore, defaultMeta } from '../src/app/store.js';
import { emptyIndex } from '../src/app/sync-drive.js';
import { emptyDataset, mergeDataset } from '../src/lib/model.js';

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
            if (rest && !rest.includes('/')) out.push({ id: rest, data: () => structuredClone(data) });
          }
          return { docs: out };
        },
      };
    },
    doc(path) {
      return {
        async get() { return { exists: docs.has(path), data: () => structuredClone(docs.get(path)) }; },
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
