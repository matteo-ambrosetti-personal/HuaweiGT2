// The app's own data paths against stand-ins: Health Connect (the plugin),
// intervals.icu (HTTP), on-device documents (the Filesystem plugin), and the
// Ask Claude helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncHealthConnect, nightFromSession, workoutFromSession, healthStatus, healthSince } from '../src/lib/healthconnect.js';
import { syncIntervals, authHeader } from '../src/lib/intervals-api.js';
import { FsDocs } from '../src/app/local-docs.js';
import { CloudStore, defaultMeta } from '../src/app/store.js';
import { checkInput, echoContent } from '../src/app/claude-api.js';
import { emptyDataset, mergeDataset } from '../src/lib/model.js';
import { backupJson, parseBackup } from '../src/lib/backup.js';

process.env.TZ = 'UTC';
const iso = (s) => new Date(s).toISOString();

// ------------------------------------------------------------------ Health Connect

function fakeHealth({ deny = [] } = {}) {
  const calls = [];
  const hours = (from, to, f) => {
    const out = [];
    for (let t = Date.parse(from); t < Date.parse(to); t += 3600000) {
      const v = f(new Date(t));
      if (v != null) out.push({ startDate: iso(t), endDate: iso(t + 3600000), value: v.value ?? v, values: v.values });
    }
    return out;
  };
  return {
    calls,
    async isAvailable() { return { available: true, platform: 'android' }; },
    async checkAuthorization() { return { readAuthorized: ['steps', 'heartRate'], historyAccessAuthorized: true }; },
    async queryAggregated({ dataType, startDate, endDate }) {
      calls.push(['agg', dataType]);
      if (deny.includes(dataType)) throw new Error('SecurityException: not allowed');
      if (dataType === 'steps') return { samples: hours(startDate, endDate, (d) => (d.getUTCHours() === 9 ? 1000 : d.getUTCHours() === 18 ? 500 : null)) };
      if (dataType === 'distance') return { samples: hours(startDate, endDate, (d) => (d.getUTCHours() === 9 ? 800 : null)) };
      if (dataType === 'calories') return { samples: hours(startDate, endDate, (d) => (d.getUTCHours() === 9 ? 60 : null)) };
      if (dataType === 'heartRate') return { samples: hours(startDate, endDate, (d) => ({ value: 60 + d.getUTCHours(), values: { average: 60 + d.getUTCHours(), min: 50, max: 90 + d.getUTCHours() } })) };
      return { samples: [] };
    },
    async readSamples({ dataType, startDate, endDate }) {
      calls.push(['read', dataType]);
      if (deny.includes(dataType)) throw new Error('SecurityException: not allowed');
      const a = Date.parse(startDate), b = Date.parse(endDate);
      const inside = (list) => list.filter((s) => Date.parse(s.startDate) >= a && Date.parse(s.startDate) < b);
      if (dataType === 'restingHeartRate') return { samples: inside([{ startDate: '2026-03-02T06:00:00Z', value: 52 }, { startDate: '2026-03-03T06:00:00Z', value: 50 }]) };
      if (dataType === 'heartRateVariability') return { samples: inside([{ startDate: '2026-03-02T06:00:00Z', value: 40 }, { startDate: '2026-03-02T07:00:00Z', value: 60 }]) };
      if (dataType === 'oxygenSaturation') return { samples: inside([{ startDate: '2026-03-02T03:00:00Z', value: 0.97 }, { startDate: '2026-03-02T04:00:00Z', value: 0.95 }]) };
      if (dataType === 'sleep') {
        return { samples: inside([{
          startDate: '2026-03-01T23:00:00Z', endDate: '2026-03-02T07:00:00Z', value: 480,
          stages: [
            { startDate: '2026-03-01T23:00:00Z', endDate: '2026-03-02T01:00:00Z', stage: 'light' },
            { startDate: '2026-03-02T01:00:00Z', endDate: '2026-03-02T02:30:00Z', stage: 'deep' },
            { startDate: '2026-03-02T02:30:00Z', endDate: '2026-03-02T02:40:00Z', stage: 'awake' },
            { startDate: '2026-03-02T02:40:00Z', endDate: '2026-03-02T05:00:00Z', stage: 'light' },
            { startDate: '2026-03-02T05:00:00Z', endDate: '2026-03-02T07:00:00Z', stage: 'rem' },
          ],
        }]) };
      }
      if (dataType === 'heartRate') {
        const out = [];
        for (let t = a; t < b; t += 5000) out.push({ startDate: iso(t), value: 140 + ((t / 5000) % 10) });
        return { samples: out };
      }
      return { samples: [] };
    },
    async queryWorkouts({ startDate, endDate }) {
      calls.push(['workouts']);
      const w = { workoutType: 'running', duration: 1800, totalDistance: 5000, totalEnergyBurned: 350, startDate: '2026-03-02T09:00:00Z', endDate: '2026-03-02T09:30:00Z', platformId: 'abc', sourceName: 'Health Sync' };
      return { workouts: Date.parse(w.startDate) >= Date.parse(startDate) && Date.parse(w.startDate) < Date.parse(endDate) ? [w] : [] };
    },
  };
}

test('Health Connect: hourly steps, heart rate, sleep stages and a workout with heart rate', async () => {
  const health = fakeHealth();
  const { fragment, report } = await syncHealthConnect({ health, since: Date.parse('2026-03-02T00:00:00Z'), until: Date.parse('2026-03-04T00:00:00Z') });
  const d = fragment.days['2026-03-02'];
  assert.equal(d.steps, 1500);
  assert.equal(d.stepsHourly[9], 1000);
  assert.equal(d.distance, 800);
  assert.equal(d.kcal, 60);
  assert.equal(d.hrHourly[10], 70);
  assert.equal(d.hrMin, 50);
  assert.equal(d.hrMax, 113);
  assert.equal(d.restHr, 52);
  assert.equal(d.hrvAvg, 50);
  assert.equal(d.spo2Avg, 96);
  assert.equal(d.spo2Min, 95);
  const n = fragment.nights['2026-03-02'];
  assert.equal(n.deep, 90);
  assert.equal(n.rem, 120);
  assert.equal(n.awake, 10);
  assert.equal(n.total, 470);
  assert.deepEqual(n.stages[0], [0, 120, 2]);
  const w = fragment.workouts['hc-abc'];
  assert.equal(w.family, 'run');
  assert.equal(w.avgPace, 360);
  assert.ok(w.avgHr >= 140 && w.avgHr <= 150 && w.hrHist);
  assert.equal(report.skipped.length, 0);

  // It merges like any other source.
  const ds = emptyDataset();
  mergeDataset(ds, fragment, 'healthconnect');
  assert.equal(ds.days['2026-03-02'].src.steps, 'healthconnect');
});

test('Health Connect: a refused data type is skipped, the rest still arrives', async () => {
  const { fragment, report } = await syncHealthConnect({ health: fakeHealth({ deny: ['heartRate', 'sleep'] }), since: Date.parse('2026-03-02T00:00:00Z'), until: Date.parse('2026-03-03T00:00:00Z') });
  assert.equal(fragment.days['2026-03-02'].steps, 1500);
  assert.equal(fragment.days['2026-03-02'].hrHourly, undefined);
  assert.deepEqual(report.skipped.map((s) => s.split(':')[0]), ['heartRate', 'sleep']);
  assert.ok(fragment.workouts['hc-abc'], 'workouts without heart rate are summaries');
});

test('Health Connect: sessions, status and where the next sync starts', async () => {
  assert.equal(nightFromSession({ startDate: '2026-03-02T01:00:00Z', endDate: '2026-03-02T01:20:00Z' }), null, 'a 20-minute nap is not a night');
  const plain = nightFromSession({ startDate: '2026-03-01T23:00:00Z', endDate: '2026-03-02T06:00:00Z', stages: [{ startDate: '2026-03-01T23:00:00Z', endDate: '2026-03-02T06:00:00Z', stage: 'asleep' }] });
  assert.equal(plain.total, 420);
  assert.equal(plain.deep, undefined, '"asleep" alone is no stage split');
  assert.equal(workoutFromSession({ workoutType: 'bikingStationary', startDate: '2026-03-02T09:00:00Z', endDate: '2026-03-02T10:00:00Z', duration: 3600 }).family, 'ride');
  assert.deepEqual(await healthStatus(null), { available: false, reason: 'not_android' });
  assert.equal((await healthStatus(fakeHealth())).history, true);
  assert.equal(healthSince(null, { history: true, today: '2026-03-10' }), '2025-03-10');
  assert.equal(healthSince(null, { history: false, today: '2026-03-10' }), '2026-02-09');
  assert.equal(healthSince('2026-03-09', { today: '2026-03-10' }), '2026-03-07');
});

// ------------------------------------------------------------------ intervals.icu

test('intervals.icu: activities, wellness and streams with the API key', async () => {
  const seen = [];
  const http = async (url, { headers }) => {
    seen.push(url);
    assert.equal(headers.Authorization, authHeader('k3y'));
    const u = new URL(url);
    if (u.pathname.endsWith('/activities')) {
      return { status: 200, data: [
        { id: 'i1', start_date: '2026-03-02T08:00:00Z', start_date_local: '2026-03-02T09:00:00', type: 'Run', distance: 5000, moving_time: 1500, elapsed_time: 1550, average_heartrate: 150 },
        { id: 'i2', start_date: '2026-03-01T08:00:00Z', start_date_local: '2026-03-01T09:00:00', type: 'Ride', distance: 20000, moving_time: 3600 },
      ] };
    }
    if (u.pathname.endsWith('/wellness')) return { status: 200, data: [{ id: '2026-03-02', restingHR: 50, hrv: 60, sleepSecs: 27000 }] };
    if (u.pathname.endsWith('/streams')) {
      const n = 300;
      return { status: 200, data: [
        { type: 'time', data: Array.from({ length: n }, (_, i) => i * 5) },
        { type: 'latlng', data: Array.from({ length: n }, (_, i) => 45 + i * 0.00005), data2: Array.from({ length: n }, () => 9.19) },
        { type: 'heartrate', data: Array.from({ length: n }, () => 150) },
      ] };
    }
    return { status: 404, data: 'not found' };
  };
  const { fragment, report } = await syncIntervals({ http, apiKey: 'k3y', oldest: '2026-03-01', newest: '2026-03-02', known: new Set(['iv-i2']) });
  assert.equal(report.activities, 2);
  assert.equal(report.withStreams, 1);
  assert.equal(seen.filter((u) => u.includes('/streams')).length, 1, 'known tracks are not fetched again');
  assert.ok(fragment.tracks['iv-i1']);
  assert.equal(fragment.workouts['iv-i1'].hasTrack, true);
  assert.equal(fragment.days['2026-03-02'].restHr, 50);
  assert.equal(fragment.nights['2026-03-02'].total, 450);
});

test('intervals.icu: a rejected key is reported as such', async () => {
  const http = async () => ({ status: 401, data: { error: 'unauthorized' } });
  await assert.rejects(syncIntervals({ http, apiKey: 'bad', oldest: '2026-03-01', newest: '2026-03-02' }), (e) => e.code === 'auth' && e.status === 401);
});

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

test('a full backup round-trips days, nights, workouts, routes and settings', () => {
  const ds = emptyDataset();
  mergeDataset(ds, {
    days: { '2026-03-02': { steps: 1200 } },
    nights: { '2026-03-02': { date: '2026-03-02', total: 420 } },
    workouts: { w1: { id: 'w1', date: '2026-03-02', start: 1772438400000, family: 'run', hasTrack: true } },
  }, 'export');
  const text = backupJson(ds, { w1: { n: 2, step: 5, hr: [100, 110] }, gone: { n: 1 } }, { settings: { stepGoal: 8000 }, sources: { export: { at: 'x' } } });
  const b = parseBackup(text);
  assert.equal(b.ds.days['2026-03-02'].steps, 1200);
  assert.equal(b.ds.nights['2026-03-02'].total, 420);
  assert.equal(b.ds.workouts.w1.family, 'run');
  assert.deepEqual(Object.keys(b.tracks), ['w1'], 'routes of unknown workouts are dropped');
  assert.equal(b.settings.stepGoal, 8000);
  assert.throws(() => parseBackup('{"hello": 1}'), /not a GT 2 Logbook backup/);
  assert.throws(() => parseBackup('not json'), /not JSON/);
});
