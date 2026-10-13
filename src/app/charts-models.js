// Charts for the model views: the Performance Management Chart (two panels
// on one time axis, never two y-scales on one plot), a correlation matrix,
// and an XY scatter with fitted lines. Same specs as charts.js: hairline
// grid, 2px lines, ≤ 24px bars with 4px rounded data ends, text in ink tokens.

/* global d3 */
import { s, showTip, hideTip, compact } from './ui.js';

const svgRoot = (el, width, height, label) => {
  const root = s('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img', 'aria-label': label || '' });
  el.append(root);
  return d3.select(root);
};
const pointerXY = (event) => {
  const e = event.touches?.[0] || event;
  return [e.clientX, e.clientY];
};

function gridY(g, y, width, ticks, fmt) {
  const t = y.ticks(ticks);
  g.append('g').attr('class', 'grid').selectAll('line').data(t).join('line')
    .attr('x1', 0).attr('x2', width).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  g.append('g').attr('class', 'axis').selectAll('text').data(t).join('text')
    .attr('x', -8).attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text((d) => fmt(d));
}

function timeAxis(g, x, y0, width) {
  const long = x.domain()[1] - x.domain()[0] > 400 * 864e5;
  const a = g.append('g').attr('class', 'axis').attr('transform', `translate(0,${y0})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(width / 90))).tickSizeOuter(0).tickFormat(d3.utcFormat(long ? '%b %Y' : '%d %b')));
  a.select('.domain').attr('stroke', 'var(--line)');
  a.selectAll('.tick line').attr('stroke', 'var(--line)');
}

/** Rounded bar growing up (positive) or down (negative) from y0. */
function signedBar(x, y0, y1, w, r = 4) {
  const top = Math.min(y0, y1), h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const rr = Math.min(r, w / 2, h);
  if (y1 <= y0) return `M${x},${y0}V${top + rr}Q${x},${top} ${x + rr},${top}H${x + w - rr}Q${x + w},${top} ${x + w},${top + rr}V${y0}Z`;
  const bot = top + h;
  return `M${x},${y0}V${bot - rr}Q${x},${bot} ${x + rr},${bot}H${x + w - rr}Q${x + w},${bot} ${x + w},${bot - rr}V${y0}Z`;
}

/**
 * Performance Management Chart. Top: fitness (CTL) and fatigue (ATL) lines.
 * Bottom: form (TSB) as bars around zero (cool = fresh, warm = fatigued).
 * rows: [{date, ctl, atl, tsb, load, warmup}]. One crosshair spans both.
 */
export function pmcChart(el, width, { rows, height = 320, onPick }) {
  const m = { top: 14, right: 12, bottom: 26, left: 44 };
  const innerW = width - m.left - m.right;
  const gap = 18;
  const h1 = Math.round((height - m.top - m.bottom - gap) * 0.62);
  const h2 = height - m.top - m.bottom - gap - h1;
  const svg = svgRoot(el, width, height, 'Fitness, fatigue and form');
  if (!rows.length) return;
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const x = d3.scaleUtc().domain(d3.extent(rows, (r) => new Date(`${r.date}T00:00:00Z`))).range([0, innerW]);
  const xd = (r) => x(new Date(`${r.date}T00:00:00Z`));
  const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => Math.max(r.ctl, r.atl)) * 1.08 || 1]).nice().range([h1, 0]);
  const top = g.append('g');
  gridY(top, y, innerW, 4, compact);
  const warm = rows.filter((r) => r.warmup);
  if (warm.length > 1) {
    top.append('rect').attr('x', 0).attr('y', 0).attr('width', xd(warm.at(-1))).attr('height', h1).attr('fill', 'var(--ink-2)').attr('opacity', 0.06);
    top.append('text').attr('class', 'lbl halo').attr('x', 4).attr('y', 12).text('warming up');
  }
  const line = (f) => d3.line().x(xd).y((r) => y(r[f])).curve(d3.curveMonotoneX)(rows);
  top.append('path').attr('d', line('atl')).attr('fill', 'none').attr('stroke', 'var(--div-warm)').attr('stroke-width', 1.5).attr('opacity', 0.9);
  top.append('path').attr('d', line('ctl')).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2).attr('stroke-linecap', 'round');
  const last = rows.at(-1);
  top.append('circle').attr('cx', xd(last)).attr('cy', y(last.ctl)).attr('r', 4).attr('fill', 'var(--ink)').attr('stroke', 'var(--surface)').attr('stroke-width', 2);

  // form panel
  const bot = g.append('g').attr('transform', `translate(0,${h1 + gap})`);
  const ext = d3.max(rows, (r) => Math.abs(r.tsb)) || 1;
  const y2 = d3.scaleLinear().domain([-ext, ext]).nice().range([h2, 0]);
  gridY(bot, y2, innerW, 3, (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`);
  bot.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', y2(0)).attr('y2', y2(0)).attr('stroke', 'var(--line)');
  const bw = Math.max(1, Math.min(24, innerW / rows.length - 1));
  bot.append('g').selectAll('path').data(rows).join('path')
    .attr('d', (r) => signedBar(xd(r) - bw / 2, y2(0), y2(r.tsb), bw, Math.min(4, bw / 2)))
    .attr('fill', (r) => (r.tsb >= 0 ? 'var(--div-cool)' : 'var(--div-warm)'))
    .attr('opacity', (r) => (r.warmup ? 0.4 : 0.85));
  bot.append('text').attr('class', 'lbl halo').attr('x', 4).attr('y', 10).text('Form');
  timeAxis(g, x, h1 + gap + h2, innerW);

  // crosshair over both panels
  const cross = g.append('line').attr('y1', 0).attr('y2', h1 + gap + h2).attr('stroke', 'var(--ink-2)').attr('opacity', 0);
  const dots = g.append('g');
  const xs = rows.map((r) => +new Date(`${r.date}T00:00:00Z`));
  g.append('rect').attr('width', innerW).attr('height', h1 + gap + h2).attr('fill', 'transparent')
    .on('pointermove', (event) => {
      const [px] = d3.pointer(event);
      const i = d3.bisectCenter(xs, +x.invert(px));
      const r = rows[i];
      cross.attr('x1', xd(r)).attr('x2', xd(r)).attr('opacity', 0.35);
      dots.selectAll('*').remove();
      for (const [f, c] of [['ctl', 'var(--ink)'], ['atl', 'var(--div-warm)']]) {
        dots.append('circle').attr('cx', xd(r)).attr('cy', y(r[f])).attr('r', 4).attr('fill', c).attr('stroke', 'var(--surface)').attr('stroke-width', 2);
      }
      const [cx, cy] = pointerXY(event);
      showTip(cx, cy, d3.utcFormat('%a %d %b %Y')(new Date(xs[i])), [
        { label: 'Fitness (CTL)', value: r.ctl.toFixed(0), color: 'var(--ink)' },
        { label: 'Fatigue (ATL)', value: r.atl.toFixed(0), color: 'var(--div-warm)' },
        { label: 'Form (TSB)', value: `${r.tsb > 0 ? '+' : ''}${r.tsb.toFixed(0)}`, color: r.tsb >= 0 ? 'var(--div-cool)' : 'var(--div-warm)', kind: 'box' },
        { label: 'Load that day', value: r.load ? r.load.toFixed(0) : '—' },
      ]);
    })
    .on('pointerleave', () => { cross.attr('opacity', 0); dots.selectAll('*').remove(); hideTip(); })
    .on('click', (event) => {
      if (!onPick) return;
      const [px] = d3.pointer(event);
      onPick(rows[d3.bisectCenter(xs, +x.invert(px))]);
    });
}

/**
 * Lower-triangle correlation matrix. cells: [{a, b, rho, n, q}], keys in
 * order. Diverging fill: warm = positive, cool = negative, gray = none;
 * cells that don't pass the FDR cut are faded and carry no number.
 */
export function corrMatrix(el, width, { keys, labels, cells, qCut = 0.1 }) {
  const n = keys.length;
  const labelW = Math.min(118, width * 0.32);
  const size = Math.max(22, Math.min(54, Math.floor((width - labelW - 8) / Math.max(1, n - 1))));
  const height = (n - 1) * size + 70;
  const svg = svgRoot(el, Math.max(width, labelW + (n - 1) * size + 8), height, 'Correlation matrix');
  if (n < 2) return;
  const g = svg.append('g').attr('transform', `translate(${labelW},8)`);
  // color-mix keeps the cells on the current theme's tokens (they follow light/dark live).
  const fill = (rho) => `color-mix(in oklab, var(${rho >= 0 ? '--div-warm' : '--div-cool'}) ${Math.round(Math.min(1, Math.abs(rho) / 0.7) * 100)}%, var(--div-mid))`;
  const cell = new Map(cells.map((c) => [`${c.a}|${c.b}`, c]));
  const get = (a, b) => cell.get(`${a}|${b}`) || cell.get(`${b}|${a}`);
  for (let i = 1; i < n; i++) {
    g.append('text').attr('class', 'lbl').attr('x', -8).attr('y', (i - 1) * size + size / 2).attr('dy', '0.32em').attr('text-anchor', 'end').text(labels[keys[i]]);
    for (let j = 0; j < i; j++) {
      const c = get(keys[i], keys[j]);
      const gx = j * size, gy = (i - 1) * size;
      const sig = c && c.q < qCut;
      const rect = g.append('rect').attr('x', gx + 1).attr('y', gy + 1).attr('width', size - 2).attr('height', size - 2).attr('rx', 3)
        .style('fill', c ? fill(c.rho) : 'var(--surface-2)').attr('opacity', c ? (sig ? 1 : 0.45) : 1).attr('tabindex', 0);
      if (sig && size >= 30) {
        const strong = Math.abs(c.rho) >= 0.5;
        g.append('text').attr('x', gx + size / 2).attr('y', gy + size / 2).attr('dy', '0.32em').attr('text-anchor', 'middle')
          .style('font-size', '11px').style('font-weight', 600).style('pointer-events', 'none')
          .style('fill', strong ? 'var(--surface)' : 'var(--ink)').text(c.rho.toFixed(2).replace('-', '−').replace(/^(−?)0\./, '$1.'));
      }
      rect.on('pointermove focus', (event) => {
        const r = event.target.getBoundingClientRect();
        const [cx, cy] = event.type === 'focus' ? [r.left + r.width / 2, r.top] : pointerXY(event);
        showTip(cx, cy, `${labels[keys[i]]} × ${labels[keys[j]]}`, c ? [
          { label: 'Spearman ρ', value: c.rho.toFixed(2), color: fill(c.rho), kind: 'box' },
          { label: 'Days', value: String(c.n) },
          { label: 'q (FDR)', value: c.q < 0.001 ? '< 0.001' : c.q.toFixed(3) },
        ] : [{ label: 'Not enough days with both', value: '—' }]);
      }).on('pointerleave blur', hideTip);
    }
  }
  // column labels, rotated
  for (let j = 0; j < n - 1; j++) {
    g.append('text').attr('class', 'lbl').attr('transform', `translate(${j * size + size / 2},${(n - 1) * size + 8}) rotate(35)`)
      .attr('text-anchor', 'start').text(labels[keys[j]]);
  }
}

/**
 * XY scatter with optional fitted lines and log scales. points: [{x, y,
 * label, color, rows?, id}], lines: [{fn, color, label, from, to}] drawn over
 * the x range. Hover picks the nearest point (Delaunay), so small dots are easy to hit.
 */
export function scatterXY(el, width, { points, lines = [], height = 240, xLog = false, yLog = false, xFormat = compact, yFormat = compact, xLabel, yLabel, invertY = false, onClick, xTicks, yTicks }) {
  const m = { top: 12, right: 14, bottom: 38, left: 50 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = svgRoot(el, width, height, yLabel);
  if (!points.length) return;
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const [x0, x1] = d3.extent(points, (p) => p.x);
  const [y0, y1] = d3.extent([...points.map((p) => p.y), ...lines.flatMap((l) => [l.fn(x0), l.fn(x1)])]);
  const pad = (a, b, log) => (log ? [a / 1.15, b * 1.15] : [a - (b - a || 1) * 0.08, b + (b - a || 1) * 0.08]);
  const x = (xLog ? d3.scaleLog() : d3.scaleLinear()).domain(pad(x0, x1, xLog)).range([0, innerW]);
  const yd = pad(y0, y1, yLog);
  const y = (yLog ? d3.scaleLog() : d3.scaleLinear()).domain(invertY ? [yd[1], yd[0]] : yd).range([innerH, 0]);
  const yt = yTicks || (yLog ? y.ticks(4).filter((_, i, a) => a.length <= 6 || i % Math.ceil(a.length / 5) === 0) : y.ticks(4));
  g.append('g').attr('class', 'grid').selectAll('line').data(yt).join('line').attr('x1', 0).attr('x2', innerW).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  g.append('g').attr('class', 'axis').selectAll('text').data(yt).join('text').attr('x', -8).attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text(yFormat);
  const xt = xTicks || (xLog ? x.ticks(5).filter((_, i, a) => a.length <= 6 || i % Math.ceil(a.length / 5) === 0) : x.ticks(Math.max(2, Math.floor(innerW / 80))));
  g.append('g').attr('class', 'axis').selectAll('text').data(xt).join('text').attr('x', (d) => x(d)).attr('y', innerH + 16).attr('text-anchor', 'middle').text(xFormat);
  g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', innerH).attr('y2', innerH).attr('stroke', 'var(--line)');
  if (xLabel) g.append('text').attr('class', 'lbl').attr('x', innerW).attr('y', innerH + 32).attr('text-anchor', 'end').text(xLabel);
  for (const l of lines) {
    const a = l.from ?? x.domain()[0], b = l.to ?? x.domain()[1];
    const xsLine = d3.range(0, 41).map((i) => (xLog ? a * (b / a) ** (i / 40) : a + ((b - a) * i) / 40));
    g.append('path').attr('d', d3.line().x((v) => x(v)).y((v) => y(l.fn(v)))(xsLine.filter((v) => Number.isFinite(l.fn(v)))))
      .attr('fill', 'none').attr('stroke', l.color || 'var(--ink)').attr('stroke-width', l.width || 2).attr('opacity', l.opacity ?? 0.85).attr('stroke-linecap', 'round');
  }
  g.append('g').selectAll('circle').data(points).join('circle')
    .attr('cx', (p) => x(p.x)).attr('cy', (p) => y(p.y)).attr('r', 4.5)
    .attr('fill', (p) => p.color || 'var(--run)').attr('stroke', 'var(--surface)').attr('stroke-width', 2);
  const ring = g.append('circle').attr('r', 8).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 1.5).attr('opacity', 0);
  const delaunay = d3.Delaunay.from(points, (p) => x(p.x), (p) => y(p.y));
  let picked = null;
  g.append('rect').attr('width', innerW).attr('height', innerH).attr('fill', 'transparent').style('cursor', onClick ? 'pointer' : 'default')
    .on('pointermove', (event) => {
      const [px, py] = d3.pointer(event);
      const i = delaunay.find(px, py);
      const p = points[i];
      if (Math.hypot(x(p.x) - px, y(p.y) - py) > 40) { ring.attr('opacity', 0); hideTip(); picked = null; return; }
      picked = p;
      ring.attr('cx', x(p.x)).attr('cy', y(p.y)).attr('opacity', 0.6);
      const [cx, cy] = pointerXY(event);
      showTip(cx, cy, p.label, p.rows || [{ label: yLabel, value: yFormat(p.y), color: p.color }]);
    })
    .on('pointerleave', () => { ring.attr('opacity', 0); hideTip(); picked = null; })
    .on('click', () => { if (picked && onClick) onClick(picked); });
}
