import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, handleMcpRequest, TOOLS } from '../src/mcp.js';
import { normaliseStreams, downsampleStreams } from '../src/intervals.js';

const env = { INTERVALS_API_KEY: 'k123' };

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    for (const [path, body] of Object.entries(routes)) {
      if (u.pathname.endsWith(path)) {
        if (body instanceof Error) return new Response('nope', { status: 401 });
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

test('initialize negotiates a supported protocol version', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, env);
  assert.equal(res.result.protocolVersion, '2025-03-26');
  const res2 = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, env);
  assert.equal(res2.result.protocolVersion, '2025-06-18');
  assert.ok(res2.result.capabilities.tools);
});

test('notifications get no response; unknown methods error', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, env), null);
  const r = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, env);
  assert.equal(r.error.code, -32601);
});

test('tools/list exposes read-only tools without implementation details', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, env);
  assert.deepEqual(r.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  for (const t of r.result.tools) {
    assert.equal(t.run, undefined);
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('list_activities calls intervals.icu with Basic auth and trims fields', async () => {
  const f = mockFetch({
    '/athlete/0/activities': [
      { id: 'i1', start_date: '2026-10-01T05:00:00Z', start_date_local: '2026-10-01T07:00:00', type: 'Run', distance: 5000, moving_time: 1500, secret_field: 'x' },
      { id: 'i2', start_date: '2026-10-03T05:00:00Z', type: 'Ride', distance: 30000 },
    ],
  });
  const r = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_activities', arguments: { oldest: '2026-10-01', newest: '2026-10-05' } } }, env, f);
  const data = r.result.structuredContent;
  assert.equal(data.total, 2);
  assert.equal(data.activities[0].id, 'i2', 'newest first');
  assert.equal(data.activities[1].secret_field, undefined);
  assert.equal(f.calls[0].init.headers.Authorization, 'Basic ' + btoa('API_KEY:k123'));
  assert.match(f.calls[0].url, /oldest=2026-10-01&newest=2026-10-05/);
  assert.equal(JSON.parse(r.result.content[0].text).total, 2);
});

test('tool errors come back as isError results', async () => {
  const f = mockFetch({ '/athlete/0/wellness': new Error('401') });
  const r = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_wellness', arguments: { oldest: '2026-10-01', newest: '2026-10-02' } } }, env, f);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /401/);
  const bad = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_wellness', arguments: { oldest: 'yesterday', newest: '2026-10-02' } } }, env, f);
  assert.equal(bad.result.isError, true);
});

test('streams are normalised and downsampled', () => {
  const raw = [
    { type: 'time', data: Array.from({ length: 5000 }, (_, i) => i) },
    { type: 'latlng', data: Array.from({ length: 5000 }, () => 45), data2: Array.from({ length: 5000 }, () => 9) },
    { type: 'heartrate', data: Array.from({ length: 5000 }, () => 140) },
    { type: 'watts', data: [1, 2, 3] },
  ];
  const s = normaliseStreams(raw);
  assert.deepEqual(s.latlng[0], [45, 9]);
  assert.equal(s.watts, undefined);
  const d = downsampleStreams(s, 2000);
  assert.equal(d.step, 3);
  assert.ok(d.time.length <= 2000);
  assert.equal(d.time.length, d.heartrate.length);
});

test('HTTP layer: JSON responses, 202 for notifications, 405 for GET', async () => {
  const post = (body) => new Request('https://x.workers.dev/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const r1 = await handleMcpRequest(post({ jsonrpc: '2.0', id: 1, method: 'ping' }), env);
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { jsonrpc: '2.0', id: 1, result: {} });
  const r2 = await handleMcpRequest(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), env);
  assert.equal(r2.status, 202);
  const r3 = await handleMcpRequest(new Request('https://x.workers.dev/mcp'), env);
  assert.equal(r3.status, 405);
  const r4 = await handleMcpRequest(new Request('https://x.workers.dev/mcp', { method: 'POST', body: '{oops' }), env);
  assert.equal(r4.status, 400);
});
