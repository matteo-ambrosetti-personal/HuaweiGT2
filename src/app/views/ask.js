import { h, clear } from '../ui.js';
import { buildTools, instructions, SUGGESTIONS, ERROR_COPY } from '../ask.js';
import { summarize, resolveRange } from '../../lib/stats.js';

// The conversation lives for this page session only.
const turns = [];
let controller = null;

const HIDE_CODES = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed']);

export function renderAsk(root, ctx) {
  const sample = ctx.runtime?.sample;
  root.append(h('div', { class: 'section-head' },
    h('h2', { class: 'section-title', text: 'Ask Claude about your data' }),
    h('p', { class: 'note', text: 'Claude reads your numbers through this page when you ask; nothing is sent until you press Ask. Uses your Claude usage.' })));
  if (!sample) {
    root.append(h('div', { class: 'msg' }, h('strong', { text: 'Available inside claude.ai' }), 'Open this artifact on claude.ai to ask questions about your data.'));
    return;
  }
  if (ctx.isSample) root.append(h('div', { class: 'msg' }, 'You are viewing sample data, so answers describe the sample, not you. Import your export first for real insights.'));

  const chat = h('div', { class: 'chat', 'aria-live': 'polite' });
  const status = h('p', { class: 'tool-note' });
  const input = h('textarea', { id: 'ask-input', rows: 2, placeholder: 'For example: How did my sleep change since I started running more?', 'aria-label': 'Your question' });
  const askBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Ask');
  const stopBtn = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => controller?.abort() }, 'Stop');
  const form = h('form', { class: 'ask-form', onsubmit: (e) => { e.preventDefault(); ask(input.value); } }, input, askBtn, stopBtn);
  const suggest = h('div', { class: 'suggest' }, SUGGESTIONS.map((q) => h('button', { type: 'button', onclick: () => ask(q) }, q)));

  const drawTurns = () => {
    clear(chat);
    for (const t of turns) chat.append(h('div', { class: `bubble ${t.role === 'user' ? 'me' : 'ai'}`, text: t.content }));
  };
  drawTurns();
  root.append(chat, suggest, form, status);

  async function ask(question) {
    const q = String(question || '').trim();
    if (!q || controller) return;
    input.value = '';
    turns.push({ role: 'user', content: q });
    drawTurns();
    const bubble = h('div', { class: 'bubble ai thinking', text: 'Thinking…' });
    chat.append(bubble);
    controller = new AbortController();
    askBtn.disabled = true;
    stopBtn.hidden = false;
    status.textContent = '';
    const toolsOk = await sample.limits().then((l) => Boolean(l?.tools)).catch(() => false);
    const standing = instructions(ctx.getAskCtx());
    let input0 = standing;
    if (!toolsOk) {
      const c = ctx.getAskCtx();
      const all = summarize(c.ds, resolveRange(c.ds, 'all'), c.settings);
      const last90 = summarize(c.ds, resolveRange(c.ds, '90d'), c.settings);
      input0 += `\n\nData summary (all time): ${JSON.stringify(all).slice(0, 6000)}\nLast 90 days: ${JSON.stringify(last90).slice(0, 6000)}`;
    }
    const messages = [{ role: 'user', content: input0 }, ...turns.slice(-12)];
    try {
      const opts = {
        signal: controller.signal,
        cache: false,
        onText: ({ text }) => {
          bubble.classList.remove('thinking');
          bubble.textContent = text;
        },
      };
      if (toolsOk) {
        opts.tools = buildTools(ctx.getAskCtx).map((t) => ({
          ...t,
          execute: (args, context) => {
            status.textContent = `Looking up ${t.name.replace(/_/g, ' ')}…`;
            return t.execute(args || {}, context);
          },
        }));
      }
      const res = await sample(messages, opts);
      bubble.classList.remove('thinking');
      bubble.textContent = res.text;
      turns.push({ role: 'assistant', content: res.text });
      status.textContent = res.truncated ? 'The answer was cut short. Ask for less at a time.' : '';
    } catch (e) {
      const code = e?.code || 'upstream_error';
      bubble.classList.remove('thinking');
      if (code === 'cancelled') {
        bubble.textContent = e.text || 'Stopped.';
        status.textContent = '';
      } else if (code === 'refused') {
        bubble.remove();
        turns.pop();
        status.textContent = ERROR_COPY.refused;
      } else {
        if (e.text) bubble.textContent = e.text;
        else bubble.remove();
        status.textContent = ERROR_COPY[code] || ERROR_COPY.upstream_error;
        if (HIDE_CODES.has(code)) {
          form.hidden = true;
          suggest.hidden = true;
        }
      }
      if (e.text) turns.push({ role: 'assistant', content: e.text });
    } finally {
      controller = null;
      askBtn.disabled = false;
      stopBtn.hidden = true;
    }
  }
}
