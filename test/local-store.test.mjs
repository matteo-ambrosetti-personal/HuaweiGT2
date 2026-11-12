import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore, memoryKv } from '../src/app/local-store.js';
import { defaultMeta } from '../src/app/store.js';
import { toBase64, mimeFor } from '../src/app/downloads.js';
import { emptyDataset } from '../src/lib/model.js';

function dataset() {
  const ds = emptyDataset();
  ds.days['2026-03-01'] = { steps: 9000, sources: ['export'] };
  ds.days['2026-04-02'] = { steps: 12000, sources: ['export'] };
  ds.nights['2026-04-02'] = { total: 420, deep: 80 };
  ds.workouts.w1 = { id: 'w1', date: '2026-04-02', start: 1775100000000, family: 'run', label: 'Outdoor run', distance: 5000, hasTrack: true };
  return ds;
}

test('LocalStore round-trips days, nights, workouts, tracks and meta', async () => {
  const kv = memoryKv();
  const store = new LocalStore(kv);
  assert.equal(store.kind, 'local');
  assert.equal(store.persistent, true);
  const meta = defaultMeta();
  const res = await store.save(dataset(), meta, { tracks: { w1: { n: 3, step: 1, hr: [120, 130, NaN] } } });
  assert.deepEqual(res, { written: 4, tracksWritten: 1, tracksSkipped: false, error: null });
  assert.equal(meta.tracks.w1, 1);

  const loaded = await new LocalStore(kv).load();
  assert.equal(loaded.ds.days['2026-04-02'].steps, 12000);
  assert.equal(loaded.ds.nights['2026-04-02'].deep, 80);
  assert.equal(loaded.ds.workouts.w1.label, 'Outdoor run');
  assert.deepEqual(Object.keys(loaded.meta.hashes).sort(), ['days-2026-03', 'days-2026-04', 'sleep-2026-04', 'wk-2026-04']);
  // Strict JSON on the way in: NaN is stored as null, like CloudStore.
  assert.deepEqual((await store.loadTrack('w1')).hr, [120, 130, null]);
  assert.equal(await store.loadTrack('missing'), null);
});

test('LocalStore rewrites only changed months and drops emptied ones', async () => {
  const kv = memoryKv();
  const store = new LocalStore(kv);
  const meta = defaultMeta();
  const ds = dataset();
  await store.save(ds, meta);
  const writes = [];
  const origWrite = kv.write;
  kv.write = async (ops) => { writes.push(...ops.map((o) => `${o.del ? 'del' : 'put'} ${o.key}`)); return origWrite(ops); };

  delete ds.days['2026-03-01'];
  ds.days['2026-04-03'] = { steps: 4000 };
  const res = await store.save(ds, meta);
  assert.equal(res.written, 1);
  assert.deepEqual(writes.filter((w) => w !== 'put meta').sort(), ['del days-2026-03', 'put days-2026-04']);
  assert.ok(!('days-2026-03' in meta.hashes));
  assert.equal((await store.load()).ds.days['2026-03-01'], undefined);
});

test('LocalStore reports a full disk with the code main.js knows', async () => {
  const full = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
  const kv = memoryKv({ failOn: (o) => (o.key.startsWith('t:') ? full : null) });
  const store = new LocalStore(kv);
  const meta = defaultMeta();
  const res = await store.save(dataset(), meta, { tracks: { w1: { n: 1 } } });
  assert.equal(res.error.code, 'quota_exceeded');
  assert.equal(res.tracksSkipped, true);
  assert.equal(res.written, 4, 'the summaries are kept');
  assert.equal(meta.tracks.w1, undefined, 'the route is not marked as stored');
});

test('LocalStore keeps the map index and chunks together, and clear empties everything', async () => {
  const kv = memoryKv();
  const store = new LocalStore(kv);
  const index = { kind: 'basemap-index', v: 1, areas: [{ id: 'a', items: ['a-0', 'a-1'] }] };
  await store.saveBasemap(index, { 'a-0': { lines: [1] }, 'a-1': { lines: [2] } });
  assert.deepEqual((await store.loadBasemapItem('a-1')).lines, [2]);
  assert.equal((await store.load()).basemapIndex.areas[0].id, 'a');

  const next = { ...index, areas: [{ id: 'b', items: ['b-0'] }] };
  await store.saveBasemap(next, { 'b-0': { lines: [3] } }, ['a-0', 'a-1']);
  assert.equal(await store.loadBasemapItem('a-0'), null);
  await store.removeBasemap(next);
  assert.equal(await store.loadBasemapItem('b-0'), null);
  assert.equal((await store.load()).basemapIndex, null);

  await store.save(dataset(), defaultMeta(), { tracks: { w1: { n: 1 } } });
  await store.saveSyncIndex({ kind: 'hsync' });
  await store.clear(defaultMeta());
  assert.equal(kv.stores.docs.size + kv.stores.items.size, 0);
  const empty = await store.load();
  assert.deepEqual(empty.ds, emptyDataset());
  assert.equal(empty.syncIndex, null);
});

test('downloads: base64 chunks decode to the original bytes', () => {
  const bytes = new Uint8Array(100003).map((_, i) => (i * 31) % 256);
  assert.deepEqual(new Uint8Array(Buffer.from(toBase64(bytes), 'base64')), bytes);
  assert.equal(mimeFor('gt2-daily.csv'), 'text/csv');
  assert.equal(mimeFor('routes.ZIP'), 'application/zip');
  assert.equal(mimeFor('x.bin'), 'application/octet-stream');
});
