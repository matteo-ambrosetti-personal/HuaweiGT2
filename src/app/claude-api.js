// "Ask Claude" in the app: the Messages API with the user's own API key,
// called from the phone (the key never leaves the device except to
// api.anthropic.com). Claude reads the dataset through the same page tools as
// in the artifact (ask.js), in a streaming manual tool loop.

import Anthropic from '@anthropic-ai/sdk';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most capable (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Faster, about half the price' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest and cheapest' },
];
export const DEFAULT_MODEL = MODELS[0].id;
const MAX_ROUNDS = 8;

/**
 * Server-side refusal fallback: on a policy decline the API re-runs the
 * request on Anthropic's recommended model for that category. Haiku has none.
 */
function fallbackParams(model) {
  if (model.startsWith('claude-haiku')) return {};
  return { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
}

/**
 * Tool inputs stream as they are generated (eager_input_streaming), so the
 * server no longer validates them: check required fields, types and enums here.
 */
export function checkInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  for (const k of schema.required || []) if (input[k] == null) return false;
  for (const [k, v] of Object.entries(input)) {
    const p = schema.properties?.[k];
    if (!p || v == null) continue;
    if (p.type === 'string' && typeof v !== 'string') return false;
    if (p.type === 'number' && typeof v !== 'number') return false;
    if (p.enum && !p.enum.includes(v)) return false;
  }
  return true;
}

/**
 * After a mid-answer fallback, blocks before the last `fallback` marker are
 * echoed as text only (the fallback model continues from the text).
 */
export function echoContent(content) {
  const cut = content.map((b) => b.type).lastIndexOf('fallback');
  if (cut < 0) return content;
  return [...content.slice(0, cut).filter((b) => b.type === 'text'), ...content.slice(cut + 1)];
}

/** Map an SDK error to the copy keys the Ask view shows. */
export function errorCode(e) {
  if (e instanceof Anthropic.APIUserAbortError) return 'cancelled';
  if (e instanceof Anthropic.AuthenticationError) return 'bad_key';
  if (e instanceof Anthropic.PermissionDeniedError) return 'bad_key';
  if (e instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (e instanceof Anthropic.BadRequestError) return /too long|too large|context/i.test(e.message) ? 'prompt_too_large' : 'bad_request';
  if (e instanceof Anthropic.APIConnectionError) return 'offline';
  if (e instanceof Anthropic.InternalServerError) return 'upstream_error';
  if (e instanceof Anthropic.APIError) return 'upstream_error';
  return e?.code || 'upstream_error';
}

/**
 * Answer the last user turn of `history` ([{role, content: string}]).
 * tools: [{name, description, inputSchema, execute(args)}].
 * onText(fullTextSoFar) streams the answer; onTool(name) reports lookups.
 * Resolves {text, model}; rejects with {code, text?}.
 */
export async function askClaude({ apiKey, model = DEFAULT_MODEL, system, history, tools, onText = () => {}, onTool = () => {}, signal }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, eager_input_streaming: true }));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const messages = history.map((t) => ({ role: t.role, content: t.content }));
  let shown = '';
  let served = model;
  let jsonRetries = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 16000,
      // Stable across questions, so it is cached.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: toolDefs,
      messages,
      output_config: { effort: 'medium' },
      ...fallbackParams(model),
    }, { signal });
    const before = shown;
    stream.on('text', (delta) => {
      shown += delta;
      onText(shown);
    });
    let msg;
    try {
      msg = await stream.finalMessage();
      jsonRetries = 0;
    } catch (e) {
      // A tool input that could not be parsed at all: re-issue the turn (capped).
      if (!(e instanceof Anthropic.APIError) && !(e instanceof Anthropic.APIUserAbortError) && e?.name !== 'AbortError' && jsonRetries++ < 2) {
        shown = before;
        round--;
        continue;
      }
      throw Object.assign(new Error(e?.message || String(e)), { code: errorCode(e), text: shown || undefined });
    }
    served = msg.model || served;
    if (msg.stop_reason === 'refusal') throw Object.assign(new Error('refused'), { code: 'refused', text: shown || undefined });
    const uses = msg.content.filter((b) => b.type === 'tool_use');
    if (msg.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: echoContent(msg.content) });
      continue;
    }
    if (!uses.length || msg.stop_reason === 'end_turn') return { text: shown.trim(), model: served, truncated: msg.stop_reason === 'max_tokens' };
    if (msg.stop_reason === 'max_tokens') return { text: shown.trim(), model: served, truncated: true };
    messages.push({ role: 'assistant', content: echoContent(msg.content) });
    const results = [];
    for (const u of uses) {
      const tool = byName.get(u.name);
      if (!tool || !checkInput(tool.inputSchema, u.input)) {
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(u.input ?? null) }) });
        continue;
      }
      onTool(u.name);
      try {
        const out = await tool.execute(u.input);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: String(e?.message || e) });
      }
    }
    messages.push({ role: 'user', content: results });
    if (shown && !shown.endsWith('\n')) shown += '\n\n';
  }
  return { text: shown.trim(), model: served, truncated: true };
}
