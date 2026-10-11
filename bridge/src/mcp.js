// A minimal, stateless MCP server over Streamable HTTP (JSON responses only).
// Implements initialize, ping, tools/list and tools/call; every request is
// self-contained, so no session store is needed.

import { listActivities, getActivityStreams, getWellness, IntervalsError } from './intervals.js';

export const SERVER_INFO = { name: 'gt2-bridge', title: 'GT2 Bridge (intervals.icu)', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = SUPPORTED_VERSIONS[0];

const dateProp = (description) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description });

export const TOOLS = [
  {
    name: 'list_activities',
    title: 'List activities',
    description: 'Workouts synced to intervals.icu (for example from Huawei Health) between two dates, newest first: id, start time (UTC and local), type, distance (m), moving and elapsed time (s), elevation gain (m), heart rate, speed (m/s), cadence, calories and source.',
    inputSchema: {
      type: 'object',
      properties: {
        oldest: dateProp('First day, YYYY-MM-DD'),
        newest: dateProp('Last day, YYYY-MM-DD'),
        limit: { type: 'number', description: 'At most this many activities (default 200, max 500)' },
      },
      required: ['oldest', 'newest'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: listActivities,
  },
  {
    name: 'get_activity_streams',
    title: 'Get activity samples',
    description: 'Per-second samples of one activity, downsampled: time (s from start), latlng ([lat, lng] pairs), heartrate (bpm), altitude (m), velocity_smooth (m/s), cadence and distance (m). `step` says how many original samples each point stands for.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Activity id from list_activities' },
        max_points: { type: 'number', description: 'Maximum points per stream (default 2000)' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: getActivityStreams,
  },
  {
    name: 'get_wellness',
    title: 'Get daily wellness',
    description: 'Daily wellness records between two dates: id (the date), steps, sleepSecs, sleepScore, restingHR, hrv, spO2, weight and stress when available.',
    inputSchema: {
      type: 'object',
      properties: { oldest: dateProp('First day, YYYY-MM-DD'), newest: dateProp('Last day, YYYY-MM-DD') },
      required: ['oldest', 'newest'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: getWellness,
  },
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

/** Handle one JSON-RPC message; returns a response object or null for notifications. */
export async function handleMessage(msg, env, fetchImpl) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'Invalid Request');
  }
  const isNotification = !('id' in msg);
  const { id, method, params = {} } = msg;
  try {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'Read-only access to the owner\'s intervals.icu activities, samples and daily wellness.',
        });
      }
      case 'ping':
        return isNotification ? null : rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS.map(({ run, ...t }) => t) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
        try {
          const data = await tool.run(env, params.arguments || {}, fetchImpl);
          return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
        } catch (err) {
          const message = err instanceof IntervalsError ? err.message : `Unexpected error: ${err?.message || err}`;
          return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
        }
      }
      default:
        if (isNotification) return null; // e.g. notifications/initialized
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(id, -32603, 'Internal error', String(err?.message || err));
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Streamable HTTP entry point for /mcp. */
export async function handleMcpRequest(request, env, fetchImpl) {
  if (request.method === 'GET') return new Response('This MCP server does not offer an SSE stream.', { status: 405, headers: { Allow: 'POST' } });
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  let body;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMessage(m, env, fetchImpl)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const res = await handleMessage(body, env, fetchImpl);
  return res ? json(res) : new Response(null, { status: 202 });
}
