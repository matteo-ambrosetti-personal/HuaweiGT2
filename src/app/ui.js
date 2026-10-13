// DOM helpers, tooltip, toast and the chart card wrapper.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('div', {class: 'x', onclick}, child, 'text', [more]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

function applyAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ------------------------------------------------------------------ tooltip

const tipEl = () => document.getElementById('tip');

/**
 * Show the shared tooltip near (x, y) with a title and rows
 * [{label, value, color?, kind: 'line'|'box'}]. Values lead visually.
 */
export function showTip(x, y, title, rows = []) {
  const tip = tipEl();
  if (!tip) return;
  clear(tip);
  if (title) tip.append(h('div', { class: 't-title', text: title }));
  for (const r of rows) {
    tip.append(
      h('div', { class: 't-row' },
        h('span', { class: 't-k' },
          r.color ? h('span', { class: 't-key', style: { background: r.color, height: r.kind === 'box' ? '8px' : '2px', width: r.kind === 'box' ? '8px' : '12px' } }) : null,
          r.label),
        h('span', { class: 't-v', text: r.value })),
    );
  }
  tip.style.display = 'block';
  const pad = 14;
  const w = tip.offsetWidth, hgt = tip.offsetHeight;
  let left = x + pad, top = y + pad;
  if (left + w > window.innerWidth - 8) left = x - w - pad;
  if (top + hgt > window.innerHeight - 8) top = y - hgt - pad;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

export function hideTip() {
  const tip = tipEl();
  if (tip) tip.style.display = 'none';
}

/** Tooltip for keyboard focus on an element (uses its bounding box). */
export function tipAtElement(el, title, rows) {
  const r = el.getBoundingClientRect();
  showTip(r.left + r.width / 2, r.top, title, rows);
}

// ------------------------------------------------------------------ toast

let toastTimer = null;
export function toast(message, ms = 3200) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status', text: message });
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

// ------------------------------------------------------------------ colors

export const BUCKET_COLOR = { run: 'var(--run)', walkhike: 'var(--walk)', ride: 'var(--ride)', other: 'var(--other)' };
export const FAMILY_COLOR = {
  run: 'var(--run)', walk: 'var(--walk)', hike: 'var(--walk)', ride: 'var(--ride)',
  swim: 'var(--other)', gym: 'var(--other)', other: 'var(--other)',
};

/** Resolve a CSS variable (for canvas drawing). */
/** How to zoom a map, worded for touch screens or for a mouse. */
export function mapHint(open) {
  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  const how = touch ? 'Pinch to zoom, move with two fingers, double-tap to reset.' : 'Scroll or pinch to zoom, drag to pan, double-click to reset.';
  return open ? `${how} ${touch ? 'Tap' : 'Select'} a route to open it.` : how;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

// ------------------------------------------------------------------ chart card

/**
 * A titled chart block with a Chart/Table toggle (every chart has a table twin).
 * render(el) draws the chart; table() returns {columns:[{label, get, r?}], rows}.
 * Charts re-render on resize.
 */
export function chartCard({ id, title, sub, render, table, legend, panel = true, actions }) {
  const body = h('div', { class: 'chart' });
  const legendEl = legend ? h('div', { class: 'legend' }) : null;
  const tableEl = h('div', { class: 'table-wrap', hidden: true });
  let showingTable = false;
  const toggle = table
    ? h('button', {
        class: 'btn', type: 'button', style: { padding: '3px 10px', fontSize: '12px' },
        'aria-pressed': 'false',
        onclick: () => {
          showingTable = !showingTable;
          toggle.textContent = showingTable ? 'Chart' : 'Table';
          toggle.setAttribute('aria-pressed', String(showingTable));
          body.hidden = showingTable;
          if (legendEl) legendEl.hidden = showingTable;
          tableEl.hidden = !showingTable;
          if (showingTable) renderTable(tableEl, table());
        },
      }, 'Table')
    : null;
  const head = h('div', { class: 'section-head' },
    h('div', null, h('h3', { class: 'chart-title', id, text: title }), sub ? h('p', { class: 'chart-sub', text: sub }) : null),
    h('div', { class: 'btn-row' }, actions || null, toggle));
  const wrap = h('div', { class: panel ? 'panel' : '' }, head, body, legendEl, tableEl);
  let lastW = 0;
  const draw = () => {
    const w = body.clientWidth;
    if (!w || Math.abs(w - lastW) < 2) return;
    lastW = w;
    clear(body);
    render(body, w);
    if (legendEl && legend) {
      clear(legendEl);
      for (const item of legend) {
        legendEl.append(h('span', { class: 'item' },
          h('span', { class: item.kind === 'line' ? 'ln' : 'sw', style: { background: item.color } }), item.label));
      }
    }
  };
  const ro = new ResizeObserver(() => draw());
  ro.observe(body);
  requestAnimationFrame(draw);
  return wrap;
}

export function renderTable(el, { columns, rows, onRowClick, maxRows = 400 }) {
  clear(el);
  const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.r ? 'r' : null, scope: 'col', text: c.label }))));
  const tbody = h('tbody');
  rows.slice(0, maxRows).forEach((row) => {
    const tr = h('tr', onRowClick ? { class: 'clickable', tabindex: '0', onclick: () => onRowClick(row), onkeydown: (e) => { if (e.key === 'Enter') onRowClick(row); } } : null,
      columns.map((c) => {
        const v = c.get(row);
        return h('td', { class: c.r ? 'r' : null }, v instanceof Node ? v : v == null ? '—' : String(v));
      }));
    tbody.append(tr);
  });
  el.append(h('table', null, thead, tbody));
  if (rows.length > maxRows) el.append(h('p', { class: 'muted', style: { padding: '8px 12px', margin: 0 }, text: `Showing ${maxRows} of ${rows.length} rows.` }));
}

export function section(title, note, ...children) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { text: title }), note ? h('p', { class: 'note', text: note }) : null),
    ...children);
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty-state' }, h('h3', { text: title }), h('p', { style: { margin: '0 0 10px' }, text }), action || null);
}

/** Compact number for axes: 1.2K, 12K, 1.2M. */
export function compact(n) {
  if (n == null || !Number.isFinite(n)) return '';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}
