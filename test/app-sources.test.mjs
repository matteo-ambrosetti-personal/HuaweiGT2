// The app's own pieces against stand-ins: on-device documents (the
// Filesystem plugin), the Ask Claude helpers and the full backup export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FsDocs } from '../src/app/local-docs.js';
import { CloudStore, defaultMeta } from '../src/app/store.js';
import { checkInput, echoContent } from '../src/app/claude-api.js';
import { emptyDataset, mergeDataset } from '../src/lib/model.js';
import { backupJson, BACKUP_APP } from '../src/lib/backup.js';

process.env.TZ = 'UTC';

// ------------------------------------------------------------------ on-device documents

function fakeFs() {
  const files = new Map();
  const missing = () => Object.assign(new Error('File does not exist.'), { code: 'OS-PLUG-FILE-0008' });
  return {
    files,
    async readFile({ path }) { if (!files.has(path)) throw missing(); return { data: files.get(path) }; },
    async writeFile({ path, data }) { files.set(path, data); return { uri: `file:///data/${path}` }; },
    async deleteFile({ path }) { if (!files.delete(path)) throw missing(); },
    async readdir({ path }) {
      const names = new Set(), dirs = new Set();
      for (const p of files.keys()) {
        if (!p.startsWith(`${path}/`)) continue;
        const rest = p.slice(path.length + 1);
        if (rest.includes('/')) dirs.add(rest.split('/')[0]); else names.add(rest);
      }
      if (!names.size && !dirs.size) throw Object.assign(new Error('Folder does not exist.'), { code: 'OS-PLUG-FILE-0008' });
      return { files: [...[...names].map((name) => ({ name, type: 'file' })), ...[...dirs].map((name) => ({ name, type: 'directory' }))] };
    },
  };
}

test('the store saves and loads through on-device files', async () => {
  const fs = fakeFs();
  const store = new CloudStore(new FsDocs(fs), 'local', { kind: 'device' });
  assert.equal(store.where, 'this device');
  const empty = await store.load();
  assert.equal(Object.keys(empty.ds.days).length, 0, 'first start: nothing stored yet');
  const ds = emptyDataset();
  mergeDataset(ds, { days: { '2026-03-02': { steps: 1200 } }, workouts: { w1: { id: 'w1', date: '2026-03-02', start: 1, family: 'run' } } }, 'export');
  const meta = defaultMeta();
  await store.save(ds, meta, { tracks: { w1: { n: 2, step: 5, hr: [100, 110] } } });
  assert.ok(fs.files.has('gt2/data/users/local/days-2026-03.json'));
  assert.ok(fs.files.has('gt2/data/users/local/tracks/items/w1.json'));
  const loaded = await store.load();
  assert.equal(loaded.ds.days['2026-03-02'].steps, 1200);
  assert.deepEqual((await store.loadTrack('w1')).hr, [100, 110]);
  await store.clear(loaded.meta);
  assert.equal([...fs.files.keys()].filter((k) => k.endsWith('.json')).length, 0);
});

// ------------------------------------------------------------------ Ask Claude helpers

test('tool inputs are checked against their schema', () => {
  const schema = { type: 'object', properties: { metric: { type: 'string', enum: ['steps', 'hrv'] }, limit: { type: 'number' } }, required: ['metric'] };
  assert.equal(checkInput(schema, { metric: 'steps', limit: 3 }), true);
  assert.equal(checkInput(schema, { metric: 'weight' }), false);
  assert.equal(checkInput(schema, { limit: 3 }), false);
  assert.equal(checkInput(schema, { metric: 'steps', limit: '3' }), false);
  assert.equal(checkInput(schema, null), false);
});

test('after a mid-answer fallback only text before the marker is echoed', () => {
  const content = [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Partial' }, { type: 'tool_use', id: 't1' }, { type: 'fallback' }, { type: 'text', text: 'Rest' }, { type: 'tool_use', id: 't2' }];
  assert.deepEqual(echoContent(content).map((b) => b.type), ['text', 'text', 'tool_use']);
  assert.equal(echoContent(content.slice(0, 2)).length, 2, 'no fallback: unchanged');
});

// ------------------------------------------------------------------ backup

test('a full backup holds days, nights, workouts, routes and settings', () => {
  const ds = emptyDataset();
  mergeDataset(ds, {
    days: { '2026-03-02': { steps: 1200 } },
    nights: { '2026-03-02': { date: '2026-03-02', total: 420 } },
    workouts: { w1: { id: 'w1', date: '2026-03-02', start: 1772438400000, family: 'run', hasTrack: true } },
  }, 'export');
  const b = JSON.parse(backupJson(ds, { w1: { n: 2, step: 5, hr: [100, 110] } }, { settings: { stepGoal: 8000 }, sources: { export: { at: 'x' } } }));
  assert.equal(b.app, BACKUP_APP);
  assert.equal(b.days['2026-03-02'].steps, 1200);
  assert.equal(b.nights['2026-03-02'].total, 420);
  assert.deepEqual(b.workouts.map((w) => [w.id, w.family]), [['w1', 'run']]);
  assert.deepEqual(b.tracks.w1.hr, [100, 110]);
  assert.equal(b.settings.stepGoal, 8000);
});
