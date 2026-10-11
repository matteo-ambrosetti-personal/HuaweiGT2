// Chart components (d3 v7 global). Every chart: hairline grid, muted axes,
// 2px lines, bars ≤ 24px with a 4px rounded data end, 2px surface gaps,
// and a hover/focus tooltip. Text uses ink tokens, never series colours.

/* global d3 */
import { s, showTip, hideTip, clear, compact, cssVar } from './ui.js';
import { decodePolyline, fitProjection, bbox } from '../lib/geo.js';
import { fmtMinuteOfDay } from '../lib/format.js';

const MARGIN = { top: 12, right: 12, bottom: 26, left: 40 };
const parseDay = (k) => new Date(k + 'T00:00:00Z');

function svgRoot(el, width, height, label) {
  const root = s('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img', 'aria-label': label || '' });
  el.append(root);
  return d3.select(root);
}

/** Path for a bar with a rounded data end (top for positive values). */
export function roundedBar(x, y, w, hgt, r = 4) {
  if (hgt <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}

function gridY(g, y, width, ticks = 4, fmt = compact, tickValues = null) {
  const t = tickValues || y.ticks(ticks);
  g.append('g').attr('class', 'grid')
    .selectAll('line').data(t).join('line')
    .attr('x1', 0).attr('x2', width).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  g.append('g').attr('class', 'axis')
    .selectAll('text').data(t).join('text')
    .attr('x', -8).attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end')
    .text((d) => fmt(d));
}

/** Domain max and tick values on whole hours for values in `unit`s (60 = minutes, 3600 = seconds). */
function hourTicks(maxValue, unit) {
  const hours = maxValue / unit;
  const step = [1, 2, 3, 4, 6, 12, 24, 48].find((st) => hours / st <= 5) || Math.ceil(hours / 5);
  const top = Math.max(step, Math.ceil(hours / step) * step);
  return { max: top * unit, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step * unit) };
}

function timeAxis(g, x, innerH, width, opts = {}) {
  const axis = d3.axisBottom(x).ticks(Math.max(2, Math.floor(width / 90))).tickSizeOuter(0);
  if (opts.format) axis.tickFormat(opts.format);
  else axis.tickFormat(d3.utcFormat(opts.long ? '%b %Y' : '%d %b'));
  const a = g.append('g').attr('class', 'axis').attr('transform', `translate(0,${innerH})`).call(axis);
  a.select('.domain').attr('stroke', 'var(--line)');
  a.selectAll('.tick line').attr('stroke', 'var(--line)');
}

function emptyMessage(svg, w, hgt, msg = 'No data in this period') {
  svg.append('text').attr('class', 'empty-msg').attr('x', w / 2).attr('y', hgt / 2).attr('text-anchor', 'middle').text(msg);
}

function pointerXY(event) {
  const e = event.touches?.[0] || event;
  return [e.clientX, e.clientY];
}

// ------------------------------------------------------------------ daily bars

/**
 * Daily bars with optional rolling-average line and goal rule.
 * rows: [{date, value}], avg: [values aligned] | null
 */
export function dailyBars(el, width, { rows, color, avg, avgLabel = '7-day average', goal, height = 220, yFormat = compact, valueLabel, tipValue, onClick, tickUnit }) {
  const m = { ...MARGIN, left: 44 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = svgRoot(el, width, height, valueLabel);
  const values = rows.map((r) => r.value).filter((v) => v != null);
  if (!values.length) return emptyMessage(svg, width, height);
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const x = d3.scaleBand().domain(rows.map((r) => r.date)).range([0, innerW]).paddingInner(rows.length > 60 ? 0.1 : 0.25);
  const ymax = Math.max(d3.max(values), goal || 0, d3.max(avg || [0]) || 0) * 1.08;
  const ht = tickUnit ? hourTicks(ymax, tickUnit) : null;
  const y = d3.scaleLinear().domain([0, ht ? ht.max : ymax]).range([innerH, 0]);
  if (!ht) y.nice();
  gridY(g, y, innerW, 4, yFormat, ht?.ticks);
  const bw = Math.min(24, x.bandwidth());
  const off = (x.bandwidth() - bw) / 2;
  g.append('g').selectAll('path').data(rows.filter((r) => r.value != null)).join('path')
    .attr('d', (r) => roundedBar(x(r.date) + off, y(r.value), bw, innerH - y(r.value), Math.min(4, bw / 2)))
    .attr('fill', color);
  if (goal) {
    g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', y(goal)).attr('y2', y(goal))
      .attr('stroke', 'var(--ink-2)').attr('stroke-width', 1).attr('opacity', 0.55);
    g.append('text').attr('class', 'lbl halo').attr('x', 4).attr('y', y(goal) - 5).text(`Goal ${yFormat(goal)}`);
  }
  if (avg) {
    const line = d3.line().defined((d) => d != null).x((_, i) => x(rows[i].date) + x.bandwidth() / 2).y((d) => y(d)).curve(d3.curveMonotoneX);
    g.append('path').attr('d', line(avg)).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2).attr('stroke-linecap', 'round').attr('opacity', 0.85);
  }
  timeAxis(g, d3.scaleUtc().domain([parseDay(rows[0].date), parseDay(rows.at(-1).date)]).range([x.bandwidth() / 2, innerW - x.bandwidth() / 2]), innerH, innerW);
  // hover: band hit areas
  const hl = g.append('rect').attr('fill', 'var(--ink)').attr('opacity', 0).attr('pointer-events', 'none');
  g.append('g').selectAll('rect').data(rows).join('rect')
    .attr('x', (r) => x(r.date)).attr('y', 0).attr('width', x.step()).attr('height', innerH)
    .attr('fill', 'transparent').style('cursor', onClick ? 'pointer' : 'default')
    .on('pointermove', (event, r) => {
      hl.attr('x', x(r.date)).attr('y', 0).attr('width', x.bandwidth()).attr('height', innerH).attr('opacity', 0.05);
      const i = rows.indexOf(r);
      const [cx, cy] = pointerXY(event);
      showTip(cx, cy, tipValue?.title(r) || r.date, [
        { label: valueLabel, value: r.value == null ? '—' : tipValue ? tipValue.value(r.value) : yFormat(r.value), color, kind: 'box' },
        ...(avg && avg[i] != null ? [{ label: avgLabel, value: tipValue ? tipValue.value(avg[i]) : yFormat(avg[i]), color: 'var(--ink)' }] : []),
      ]);
    })
    .on('pointerleave', () => { hl.attr('opacity', 0); hideTip(); })
    .on('click', (_, r) => onClick && onClick(r));
}

// ------------------------------------------------------------------ stacked bars

/**
 * Stacked columns. rows: [{key, label, ...values}], keys: [{key, label, color}]
 */
export function stackedBars(el, width, { rows, keys, height = 220, yFormat = compact, xLabel, title, tipTitle, tipValue, goal, goalLabel, onClick, maxBar = 24, tickUnit }) {
  const m = { ...MARGIN, left: 44 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = svgRoot(el, width, height, title);
  const totals = rows.map((r) => keys.reduce((sum, k) => sum + (r[k.key] || 0), 0));
  if (!rows.length || !d3.max(totals)) return emptyMessage(svg, width, height);
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const x = d3.scaleBand().domain(rows.map((r) => r.key)).range([0, innerW]).paddingInner(rows.length > 40 ? 0.12 : 0.28);
  const top = Math.max(d3.max(totals), goal || 0) * 1.08;
  const ht = tickUnit ? hourTicks(top, tickUnit) : null;
  const y = d3.scaleLinear().domain([0, ht ? ht.max : top]).range([innerH, 0]);
  if (!ht) y.nice();
  gridY(g, y, innerW, 4, yFormat, ht?.ticks);
  const bw = Math.min(maxBar, x.bandwidth());
  const off = (x.bandwidth() - bw) / 2;
  const gap = 2;
  rows.forEach((r, i) => {
    let acc = 0;
    const present = keys.filter((k) => (r[k.key] || 0) > 0);
    present.forEach((k, j) => {
      const v = r[k.key];
      const y0 = y(acc), y1 = y(acc + v);
      acc += v;
      const isTop = j === present.length - 1;
      const hgt = Math.max(0, y0 - y1 - (j > 0 ? gap : 0));
      const top = y1;
      g.append('path')
        .attr('d', isTop ? roundedBar(x(r.key) + off, top, bw, hgt, Math.min(4, bw / 2)) : `M${x(r.key) + off},${top}h${bw}v${hgt}h${-bw}Z`)
        .attr('fill', k.color);
    });
    void totals[i];
  });
  if (goal) {
    g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', y(goal)).attr('y2', y(goal)).attr('stroke', 'var(--ink-2)').attr('opacity', 0.55);
    g.append('text').attr('class', 'lbl halo').attr('x', 4).attr('y', y(goal) - 5).text(goalLabel || `Goal ${yFormat(goal)}`);
  }
  // x labels: sparse
  const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(innerW / 64))));
  g.append('g').attr('class', 'axis').selectAll('text').data(rows.filter((_, i) => i % every === 0)).join('text')
    .attr('x', (r) => x(r.key) + x.bandwidth() / 2).attr('y', innerH + 17).attr('text-anchor', 'middle').text((r) => (xLabel ? xLabel(r) : r.label));
  g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', innerH).attr('y2', innerH).attr('stroke', 'var(--line)');
  const hl = g.append('rect').attr('fill', 'var(--ink)').attr('opacity', 0).attr('pointer-events', 'none');
  g.append('g').selectAll('rect').data(rows).join('rect')
    .attr('x', (r) => x(r.key) - (x.step() - x.bandwidth()) / 2).attr('y', 0).attr('width', x.step()).attr('height', innerH)
    .attr('fill', 'transparent').attr('tabindex', 0).style('cursor', onClick ? 'pointer' : 'default')
    .on('pointermove focus', (event, r) => {
      hl.attr('x', x(r.key)).attr('width', x.bandwidth()).attr('y', 0).attr('height', innerH).attr('opacity', 0.05);
      const rect = event.target.getBoundingClientRect();
      const [cx, cy] = event.type === 'focus' ? [rect.left + rect.width / 2, rect.top] : pointerXY(event);
      showTip(cx, cy, tipTitle ? tipTitle(r) : r.label, keys.filter((k) => r[k.key]).map((k) => ({
        label: k.label, value: tipValue ? tipValue(r[k.key]) : yFormat(r[k.key]), color: k.color, kind: 'box',
      })));
    })
    .on('pointerleave blur', () => { hl.attr('opacity', 0); hideTip(); })
    .on('click', (_, r) => onClick && onClick(r));
}

// ------------------------------------------------------------------ line chart

/**
 * Time-series lines with optional min–max band, crosshair tooltip.
 * series: [{key, label, color, points:[{x: Date, y}], width?, dots?}]
 * band: {points:[{x, lo, hi}], color, label}
 */
export function lineChart(el, width, { series, band, height = 220, yFormat = compact, tipFormat, yDomain, invertY = false, title, xFormat, zeroBased = false, refLines = [] }) {
  const m = { ...MARGIN, left: 44 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = svgRoot(el, width, height, title);
  const all = series.flatMap((sr) => sr.points).filter((p) => p.y != null);
  const bandPts = band ? band.points.filter((p) => p.lo != null && p.hi != null) : [];
  if (!all.length && !bandPts.length) return emptyMessage(svg, width, height);
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const xs = [...all.map((p) => p.x), ...bandPts.map((p) => p.x)];
  const x = d3.scaleUtc().domain(d3.extent(xs)).range([0, innerW]);
  const ysAll = [...all.map((p) => p.y), ...bandPts.flatMap((p) => [p.lo, p.hi]), ...refLines.map((r) => r.y)];
  let [lo, hi] = yDomain || d3.extent(ysAll);
  if (zeroBased) lo = 0;
  if (lo === hi) { lo -= 1; hi += 1; }
  const padY = (hi - lo) * 0.08;
  const y = d3.scaleLinear().domain(invertY ? [hi + padY, lo - padY] : [lo - (zeroBased ? 0 : padY), hi + padY]).nice().range([innerH, 0]);
  gridY(g, y, innerW, 4, yFormat);
  timeAxis(g, x, innerH, innerW, { format: xFormat, long: (x.domain()[1] - x.domain()[0]) > 400 * 864e5 });
  if (bandPts.length) {
    const area = d3.area().x((p) => x(p.x)).y0((p) => y(p.lo)).y1((p) => y(p.hi)).curve(d3.curveMonotoneX);
    g.append('path').attr('d', area(bandPts)).attr('fill', band.color).attr('opacity', 0.12);
  }
  for (const r of refLines) {
    g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', y(r.y)).attr('y2', y(r.y)).attr('stroke', 'var(--ink-2)').attr('opacity', 0.5);
    g.append('text').attr('class', 'lbl halo').attr('x', 4).attr('y', y(r.y) - 5).text(r.label);
  }
  for (const sr of series) {
    const pts = sr.points.filter((p) => p.y != null);
    if (sr.area) {
      const area = d3.area().defined((p) => p.y != null).x((p) => x(p.x)).y0(innerH).y1((p) => y(p.y)).curve(d3.curveMonotoneX);
      g.append('path').attr('d', area(sr.points)).attr('fill', sr.color).attr('opacity', 0.1);
    }
    if (sr.dots) {
      g.append('g').selectAll('circle').data(pts).join('circle')
        .attr('cx', (p) => x(p.x)).attr('cy', (p) => y(p.y)).attr('r', sr.r || 3)
        .attr('fill', sr.color).attr('stroke', 'var(--surface)').attr('stroke-width', 2).attr('opacity', sr.dotOpacity ?? 1);
    }
    if (!sr.noLine) {
      const line = d3.line().defined((p) => p.y != null).x((p) => x(p.x)).y((p) => y(p.y)).curve(sr.curve === 'step' ? d3.curveStepAfter : d3.curveMonotoneX);
      g.append('path').attr('d', line(sr.points)).attr('fill', 'none').attr('stroke', sr.color)
        .attr('stroke-width', sr.width || 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round').attr('opacity', sr.opacity ?? 1);
    }
    if (sr.endLabel && pts.length) {
      const last = pts.at(-1);
      g.append('circle').attr('cx', x(last.x)).attr('cy', y(last.y)).attr('r', 4).attr('fill', sr.color).attr('stroke', 'var(--surface)').attr('stroke-width', 2);
    }
  }
  // crosshair
  const cross = g.append('line').attr('y1', 0).attr('y2', innerH).attr('stroke', 'var(--ink-2)').attr('opacity', 0);
  const dots = g.append('g');
  const allX = [...new Set(xs.map((d) => +d))].sort((a, b) => a - b);
  g.append('rect').attr('width', innerW).attr('height', innerH).attr('fill', 'transparent')
    .on('pointermove', (event) => {
      const [px] = d3.pointer(event);
      const t = +x.invert(px);
      const i = d3.bisectCenter(allX, t);
      const xv = allX[i];
      cross.attr('x1', x(xv)).attr('x2', x(xv)).attr('opacity', 0.35);
      dots.selectAll('*').remove();
      const rows = [];
      for (const sr of series) {
        const p = sr.points.find((q) => +q.x === xv && q.y != null);
        if (!p) continue;
        dots.append('circle').attr('cx', x(xv)).attr('cy', y(p.y)).attr('r', 4).attr('fill', sr.color).attr('stroke', 'var(--surface)').attr('stroke-width', 2);
        rows.push({ label: sr.label, value: (tipFormat || yFormat)(p.y, sr), color: sr.color });
      }
      if (band) {
        const b = band.points.find((q) => +q.x === xv);
        if (b && b.lo != null) rows.push({ label: band.label, value: `${(tipFormat || yFormat)(b.lo)}–${(tipFormat || yFormat)(b.hi)}`, color: band.color, kind: 'box' });
      }
      const [cx, cy] = pointerXY(event);
      if (rows.length) showTip(cx, cy, d3.utcFormat('%a %d %b %Y')(new Date(xv)), rows);
    })
    .on('pointerleave', () => { cross.attr('opacity', 0); dots.selectAll('*').remove(); hideTip(); });
}

// ------------------------------------------------------------------ scatter + trend

/**
 * Workout scatter (e.g. pace over time) with a trend line; clickable dots.
 * points: [{x: Date, y, id, label, color}], trend: [{x, y}]
 */
export function scatterTrend(el, width, { points, trend, height = 240, yFormat, yLabel, invertY = false, onClick, tip }) {
  const m = { ...MARGIN, left: 48 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = svgRoot(el, width, height, yLabel);
  if (!points.length) return emptyMessage(svg, width, height);
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const x = d3.scaleUtc().domain(d3.extent(points, (p) => p.x)).range([0, innerW]);
  if (x.domain()[0] - x.domain()[1] === 0) x.domain([new Date(+x.domain()[0] - 864e5), new Date(+x.domain()[0] + 864e5)]);
  const [lo, hi] = d3.extent(points, (p) => p.y);
  const pad = Math.max((hi - lo) * 0.1, 5);
  const y = d3.scaleLinear().domain(invertY ? [hi + pad, lo - pad] : [lo - pad, hi + pad]).range([innerH, 0]);
  gridY(g, y, innerW, 4, yFormat);
  timeAxis(g, x, innerH, innerW, { long: (x.domain()[1] - x.domain()[0]) > 400 * 864e5 });
  if (trend?.length) {
    const line = d3.line().defined((p) => p.y != null).x((p) => x(p.x)).y((p) => y(p.y)).curve(d3.curveMonotoneX);
    g.append('path').attr('d', line(trend)).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2).attr('opacity', 0.8);
  }
  const dots = g.append('g').selectAll('g').data(points).join('g').attr('transform', (p) => `translate(${x(p.x)},${y(p.y)})`);
  dots.append('circle').attr('r', 4.5).attr('fill', (p) => p.color).attr('stroke', 'var(--surface)').attr('stroke-width', 2);
  dots.append('circle').attr('r', 12).attr('fill', 'transparent').attr('tabindex', 0).style('cursor', onClick ? 'pointer' : 'default')
    .on('pointermove focus', (event, p) => {
      const rect = event.target.getBoundingClientRect();
      const [cx, cy] = event.type === 'focus' ? [rect.left, rect.top] : pointerXY(event);
      showTip(cx, cy, p.label, tip ? tip(p) : [{ label: yLabel, value: yFormat(p.y), color: p.color }]);
    })
    .on('pointerleave blur', hideTip)
    .on('click keydown', (event, p) => {
      if (event.type === 'keydown' && event.key !== 'Enter') return;
      onClick && onClick(p);
    });
}

// ------------------------------------------------------------------ calendar heatmap

/**
 * GitHub-style year calendar of a daily value. weeks run Monday → Sunday.
 * values: Map(date → number), marks: Set(date) (workout days), thresholds: 4 cut points.
 */
export function calendarHeatmap(el, width, { from: from0, to, values, marks, thresholds, tipRows, onClick, label }) {
  const end = parseDay(to);
  const left = 28, top = 18;
  let start = d3.utcMonday.floor(parseDay(from0));
  let weeks = d3.utcMonday.count(start, end) + 1;
  const fit = Math.max(8, Math.floor((width - left - 4) / 11));
  if (weeks > fit) {
    start = d3.utcMonday.offset(d3.utcMonday.floor(end), -(fit - 1));
    weeks = fit;
  }
  const from = start.toISOString().slice(0, 10) > from0 ? start.toISOString().slice(0, 10) : from0;
  const cell = Math.max(6, Math.min(16, Math.floor((width - left - 4) / weeks) - 2));
  const gap = cell >= 10 ? 3 : 2;
  const step = cell + gap;
  const height = top + 7 * step + 4;
  const svg = svgRoot(el, Math.max(width, left + weeks * step), height, label);
  const g = svg.append('g').attr('transform', `translate(${left},${top})`);
  const days = d3.utcDays(start, d3.utcDay.offset(end, 1));
  const colorFor = (v) => {
    if (v == null) return 'var(--surface-2)';
    let i = 0;
    while (i < thresholds.length && v >= thresholds[i]) i++;
    return `var(--heat-${Math.min(4, i)})`;
  };
  // month labels
  const months = d3.utcMonths(d3.utcMonth.ceil(start), end);
  g.append('g').attr('class', 'axis').selectAll('text').data(months).join('text')
    .attr('x', (d) => d3.utcMonday.count(start, d) * step).attr('y', -6).text((d) => d3.utcFormat('%b')(d));
  g.append('g').attr('class', 'axis').selectAll('text').data([0, 2, 4]).join('text')
    .attr('x', -6).attr('y', (d) => d * step + cell / 2).attr('dy', '0.32em').attr('text-anchor', 'end')
    .text((d) => ['Mon', '', 'Wed', '', 'Fri'][d]);
  const key = (d) => d.toISOString().slice(0, 10);
  const cells = g.append('g').selectAll('rect').data(days.filter((d) => key(d) >= from)).join('rect')
    .attr('x', (d) => d3.utcMonday.count(start, d) * step)
    .attr('y', (d) => ((d.getUTCDay() + 6) % 7) * step)
    .attr('width', cell).attr('height', cell).attr('rx', Math.min(3, cell / 4))
    .attr('fill', (d) => colorFor(values.get(key(d))))
    .attr('tabindex', 0)
    .style('cursor', onClick ? 'pointer' : 'default');
  g.append('g').selectAll('circle').data(days.filter((d) => marks?.has(key(d)) && key(d) >= from)).join('circle')
    .attr('cx', (d) => d3.utcMonday.count(start, d) * step + cell / 2)
    .attr('cy', (d) => ((d.getUTCDay() + 6) % 7) * step + cell / 2)
    .attr('r', Math.max(1.5, cell / 6)).attr('fill', 'var(--surface)').attr('pointer-events', 'none');
  cells.on('pointermove focus', (event, d) => {
    const rect = event.target.getBoundingClientRect();
    const [cx, cy] = event.type === 'focus' ? [rect.left, rect.top] : pointerXY(event);
    showTip(cx, cy, d3.utcFormat('%a %d %b %Y')(d), tipRows(key(d)));
  }).on('pointerleave blur', hideTip).on('click', (_, d) => onClick && onClick(key(d)));
}

// ------------------------------------------------------------------ range bars (bed/wake)

/** Floating bars from start to end minute-of-day per night (evening negative). */
export function rangeBars(el, width, { rows, color, height = 220, title }) {
  const m = { ...MARGIN, left: 48 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = svgRoot(el, width, height, title);
  const valid = rows.filter((r) => r.start != null && r.end != null);
  if (!valid.length) return emptyMessage(svg, width, height);
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const x = d3.scaleBand().domain(rows.map((r) => r.date)).range([0, innerW]).paddingInner(0.3);
  const lo = Math.floor((d3.min(valid, (r) => r.start) - 30) / 60) * 60;
  const hi = Math.ceil((d3.max(valid, (r) => r.end) + 30) / 60) * 60;
  const y = d3.scaleLinear().domain([lo, hi]).range([0, innerH]);
  const ticks = d3.range(lo, hi + 1, (hi - lo) > 600 ? 120 : 60);
  g.append('g').attr('class', 'grid').selectAll('line').data(ticks).join('line').attr('x1', 0).attr('x2', innerW).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  g.append('g').attr('class', 'axis').selectAll('text').data(ticks).join('text').attr('x', -8).attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text((d) => fmtMinuteOfDay(d));
  const bw = Math.min(14, x.bandwidth());
  const off = (x.bandwidth() - bw) / 2;
  g.append('g').selectAll('rect').data(valid).join('rect')
    .attr('x', (r) => x(r.date) + off).attr('y', (r) => y(r.start)).attr('width', bw).attr('height', (r) => Math.max(2, y(r.end) - y(r.start)))
    .attr('rx', Math.min(4, bw / 2)).attr('fill', color)
    .on('pointermove', (event, r) => {
      const [cx, cy] = pointerXY(event);
      showTip(cx, cy, d3.utcFormat('%a %d %b')(parseDay(r.date)), [
        { label: 'Asleep', value: fmtMinuteOfDay(r.start) },
        { label: 'Woke', value: fmtMinuteOfDay(r.end) },
      ]);
    })
    .on('pointerleave', hideTip);
  timeAxis(g, d3.scaleUtc().domain([parseDay(rows[0].date), parseDay(rows.at(-1).date)]).range([x.bandwidth() / 2, innerW - x.bandwidth() / 2]), innerH, innerW);
}

// ------------------------------------------------------------------ simple column profile

/** Columns for categories (weekday or hour profiles). rows: [{label, value}] */
export function columns(el, width, { rows, color, height = 180, yFormat = compact, valueLabel, tipFormat, highlight, tickUnit }) {
  const m = { ...MARGIN, left: 40 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = svgRoot(el, width, height, valueLabel);
  if (!rows.some((r) => r.value)) return emptyMessage(svg, width, height);
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const x = d3.scaleBand().domain(rows.map((r) => r.label)).range([0, innerW]).paddingInner(0.3);
  const top = d3.max(rows, (r) => r.value || 0) * 1.1;
  const ht = tickUnit ? hourTicks(top, tickUnit) : null;
  const y = d3.scaleLinear().domain([0, ht ? ht.max : top]).range([innerH, 0]);
  if (!ht) y.nice();
  gridY(g, y, innerW, 3, yFormat, ht?.ticks);
  const bw = Math.min(24, x.bandwidth());
  const off = (x.bandwidth() - bw) / 2;
  g.append('g').selectAll('path').data(rows.filter((r) => r.value)).join('path')
    .attr('d', (r) => roundedBar(x(r.label) + off, y(r.value), bw, innerH - y(r.value)))
    .attr('fill', (r) => (highlight && highlight !== r.label ? color : color)).attr('opacity', (r) => (highlight && highlight !== r.label ? 0.55 : 1));
  const every = Math.max(1, Math.ceil(rows.length / Math.floor(innerW / 28)));
  g.append('g').attr('class', 'axis').selectAll('text').data(rows.filter((_, i) => i % every === 0)).join('text')
    .attr('x', (r) => x(r.label) + x.bandwidth() / 2).attr('y', innerH + 17).attr('text-anchor', 'middle').text((r) => r.label);
  g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', innerH).attr('y2', innerH).attr('stroke', 'var(--line)');
  g.append('g').selectAll('rect').data(rows).join('rect')
    .attr('x', (r) => x(r.label)).attr('y', 0).attr('width', x.bandwidth()).attr('height', innerH).attr('fill', 'transparent')
    .on('pointermove', (event, r) => {
      const [cx, cy] = pointerXY(event);
      showTip(cx, cy, r.title || r.label, [{ label: valueLabel, value: r.value == null ? '—' : (tipFormat || yFormat)(r.value), color, kind: 'box' }]);
    })
    .on('pointerleave', hideTip);
}

// ------------------------------------------------------------------ horizontal bars

/** Horizontal bars with value labels at the tip. rows: [{label, value, color}] */
export function hBars(el, width, { rows, format, height }) {
  const rowH = 28;
  const hgt = height || rows.length * rowH + 8;
  const labelW = Math.min(150, width * 0.36);
  const svg = svgRoot(el, width, hgt, 'bars');
  const max = d3.max(rows, (r) => r.value) || 1;
  const x = d3.scaleLinear().domain([0, max]).range([0, width - labelW - 64]);
  rows.forEach((r, i) => {
    const y = i * rowH + 6;
    svg.append('text').attr('class', 'lbl').attr('x', 0).attr('y', y + 10).attr('dy', '0.32em').text(r.label).style('fill', 'var(--ink-2)').style('font-size', '12px');
    const w = Math.max(r.value > 0 ? 2 : 0, x(r.value));
    svg.append('path').attr('d', w > 4 ? `M${labelW},${y}H${labelW + w - 4}Q${labelW + w},${y} ${labelW + w},${y + 4}V${y + 16}Q${labelW + w},${y + 20} ${labelW + w - 4},${y + 20}H${labelW}Z` : `M${labelW},${y}h${w}v20h${-w}Z`).attr('fill', r.color);
    svg.append('text').attr('class', 'val').attr('x', labelW + w + 6).attr('y', y + 10).attr('dy', '0.32em').text(format(r.value));
  });
}

// ------------------------------------------------------------------ sparkline

export function sparkline(el, width, { values, color, height = 28 }) {
  const svg = svgRoot(el, width, height, 'trend');
  const pts = values.map((v, i) => [i, v]).filter((p) => p[1] != null);
  if (pts.length < 2) return;
  const x = d3.scaleLinear().domain([0, values.length - 1]).range([2, width - 4]);
  const y = d3.scaleLinear().domain(d3.extent(pts, (p) => p[1])).range([height - 3, 3]);
  if (y.domain()[0] === y.domain()[1]) y.domain([y.domain()[0] - 1, y.domain()[1] + 1]);
  const area = d3.area().x((p) => x(p[0])).y0(height).y1((p) => y(p[1])).curve(d3.curveMonotoneX);
  const line = d3.line().x((p) => x(p[0])).y((p) => y(p[1])).curve(d3.curveMonotoneX);
  svg.append('path').attr('d', area(pts)).attr('fill', color).attr('opacity', 0.1);
  svg.append('path').attr('d', line(pts)).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 1.5);
  const last = pts.at(-1);
  svg.append('circle').attr('cx', x(last[0])).attr('cy', y(last[1])).attr('r', 3).attr('fill', color).attr('stroke', 'var(--surface)').attr('stroke-width', 1.5);
}

// ------------------------------------------------------------------ dial (goal ring)

/** The GT 2-style ring: progress of value against goal, with centre text. */
export function dial(el, { value, goal, label, sub, color = 'var(--steps)', ring2 }) {
  clear(el);
  const size = 300, c = size / 2, r = 124, w = 16;
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${size} ${size}`).attr('role', 'img')
    .attr('aria-label', `${label}: ${Math.round(value || 0)} of ${goal}`);
  const arc = d3.arc().innerRadius(r - w / 2).outerRadius(r + w / 2).cornerRadius(w / 2).startAngle(0);
  svg.append('path').attr('transform', `translate(${c},${c})`).attr('d', arc({ endAngle: Math.PI * 2 })).attr('fill', 'var(--surface-2)');
  const frac = Math.max(0, Math.min(1, (value || 0) / goal));
  if (frac > 0) svg.append('path').attr('transform', `translate(${c},${c})`).attr('d', arc({ endAngle: Math.PI * 2 * frac })).attr('fill', color);
  if (ring2) {
    const r2 = r - 28;
    const arc2 = d3.arc().innerRadius(r2 - 6).outerRadius(r2 + 6).cornerRadius(6).startAngle(0);
    svg.append('path').attr('transform', `translate(${c},${c})`).attr('d', arc2({ endAngle: Math.PI * 2 })).attr('fill', 'var(--surface-2)');
    const f2 = Math.max(0, Math.min(1, ring2.value / ring2.goal));
    if (f2 > 0) svg.append('path').attr('transform', `translate(${c},${c})`).attr('d', arc2({ endAngle: Math.PI * 2 * f2 })).attr('fill', ring2.color);
  }
  // minute ticks like a watch bezel
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const long = i % 5 === 0;
    const r0 = r + w / 2 + 6, r1 = r0 + (long ? 7 : 3);
    svg.append('line').attr('x1', c + Math.sin(a) * r0).attr('y1', c - Math.cos(a) * r0)
      .attr('x2', c + Math.sin(a) * r1).attr('y2', c - Math.cos(a) * r1)
      .attr('stroke', 'var(--line)').attr('stroke-width', long ? 1.5 : 1);
  }
  svg.append('text').attr('class', 'small').attr('x', c).attr('y', c - 36).attr('text-anchor', 'middle').text(label);
  svg.append('text').attr('class', 'big').attr('x', c).attr('y', c + 12).attr('text-anchor', 'middle').style('font-size', '48px')
    .text(value == null ? '—' : d3.format(',')(Math.round(value)));
  svg.append('text').attr('class', 'small').attr('x', c).attr('y', c + 40).attr('text-anchor', 'middle').text(sub);
}

// ------------------------------------------------------------------ routes

/** Route outline coloured by a per-point metric. points: [{lat, lon, v}] */
export function routeMap(el, width, { points, segments, colorScale, height, title }) {
  const hgt = height || Math.round(Math.min(460, width * 0.75));
  const svg = svgRoot(el, width, hgt, title || 'Route');
  if (!points.length) return emptyMessage(svg, width, hgt, 'No GPS route for this workout');
  const b = bbox(points);
  const proj = fitProjection(b, width, hgt, 24);
  const xy = points.map((p) => proj.project(p.lat, p.lon));
  // halo first, then coloured segments
  const pathFor = (idxs) => idxs.map((i, j) => `${j ? 'L' : 'M'}${xy[i][0].toFixed(1)},${xy[i][1].toFixed(1)}`).join('');
  const segs = segments || [points.map((_, i) => i)];
  for (const sIdx of segs) svg.append('path').attr('d', pathFor(sIdx)).attr('fill', 'none').attr('stroke', 'var(--surface)').attr('stroke-width', 7).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
  for (const sIdx of segs) {
    for (let k = 1; k < sIdx.length; k++) {
      const i0 = sIdx[k - 1], i1 = sIdx[k];
      const v = points[i1].v;
      svg.append('line').attr('x1', xy[i0][0]).attr('y1', xy[i0][1]).attr('x2', xy[i1][0]).attr('y2', xy[i1][1])
        .attr('stroke', v == null || !colorScale ? 'var(--ink)' : colorScale(v)).attr('stroke-width', 3.5).attr('stroke-linecap', 'round');
    }
  }
  const [sx, sy] = xy[0], [ex, ey] = xy.at(-1);
  svg.append('circle').attr('cx', sx).attr('cy', sy).attr('r', 6).attr('fill', 'var(--good)').attr('stroke', 'var(--surface)').attr('stroke-width', 2);
  svg.append('circle').attr('cx', ex).attr('cy', ey).attr('r', 6).attr('fill', 'var(--ink)').attr('stroke', 'var(--surface)').attr('stroke-width', 2);
  // scale bar
  const target = (width * 0.22) / proj.pxPerMetre;
  const nice = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000].reduce((a, n) => (n <= target ? n : a), 50);
  const len = nice * proj.pxPerMetre;
  svg.append('line').attr('x1', 16).attr('x2', 16 + len).attr('y1', hgt - 16).attr('y2', hgt - 16).attr('stroke', 'var(--ink-2)').attr('stroke-width', 2);
  svg.append('text').attr('class', 'lbl').attr('x', 16).attr('y', hgt - 22).text(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`);
}

/** Tiny route thumbnail from an encoded polyline. */
export function routeThumb(poly, color, w = 44, hgt = 30) {
  const root = s('svg', { class: 'thumb', viewBox: `0 0 ${w} ${hgt}`, 'aria-hidden': 'true' });
  if (!poly) return root;
  const pts = decodePolyline(poly);
  if (pts.length < 2) return root;
  const proj = fitProjection(bbox(pts), w, hgt, 3);
  const d = pts.map((p, i) => {
    const [x, y] = proj.project(p.lat, p.lon);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join('');
  root.append(s('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  return root;
}

/** All routes of a region overlaid on a canvas (a personal heatmap). */
export function allRoutes(el, width, { routes, height }) {
  const hgt = height || Math.round(Math.min(520, width * 0.7));
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = hgt * dpr;
  canvas.style.width = '100%';
  canvas.style.height = `${hgt}px`;
  canvas.style.borderRadius = '10px';
  canvas.style.background = cssVar('--surface-2');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${routes.length} routes overlaid`);
  el.append(canvas);
  const all = routes.flatMap((r) => r.points);
  if (!all.length) return;
  const proj = fitProjection(bbox(all), width, hgt, 16);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = Math.max(0.18, Math.min(0.7, 6 / Math.sqrt(routes.length)));
  for (const r of routes) {
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    r.points.forEach((p, i) => {
      const [x, y] = proj.project(p.lat, p.lon);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
}

// ------------------------------------------------------------------ hypnogram

const STAGE_Y = { 4: 0, 3: 1, 2: 2, 1: 3 };
const STAGE_LABEL = { 4: 'Awake', 3: 'REM', 2: 'Light', 1: 'Deep' };
const STAGE_COLOR = { 4: 'var(--awake)', 3: 'var(--rem)', 2: 'var(--light)', 1: 'var(--deep)' };

/** Stage-by-stage view of one night. stages: [[offsetMin, durMin, code]] */
export function hypnogram(el, width, { stages, start, tz, height = 170 }) {
  const m = { top: 8, right: 12, bottom: 24, left: 52 };
  const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
  const svg = svgRoot(el, width, height, 'Sleep stages');
  if (!stages?.length) return emptyMessage(svg, width, height, 'No stage data for this night');
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const total = d3.max(stages, (st) => st[0] + st[1]);
  const x = d3.scaleLinear().domain([0, total]).range([0, innerW]);
  const rowH = innerH / 4;
  for (const code of [4, 3, 2, 1]) {
    g.append('text').attr('class', 'lbl').attr('x', -8).attr('y', STAGE_Y[code] * rowH + rowH / 2).attr('dy', '0.32em').attr('text-anchor', 'end').text(STAGE_LABEL[code]);
    g.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', STAGE_Y[code] * rowH + rowH).attr('y2', STAGE_Y[code] * rowH + rowH).attr('stroke', 'var(--hair)');
  }
  g.append('g').selectAll('rect').data(stages).join('rect')
    .attr('x', (st) => x(st[0])).attr('width', (st) => Math.max(1, x(st[0] + st[1]) - x(st[0]) - 0.5))
    .attr('y', (st) => STAGE_Y[st[2]] * rowH + 3).attr('height', rowH - 6).attr('rx', 2)
    .attr('fill', (st) => STAGE_COLOR[st[2]])
    .on('pointermove', (event, st) => {
      const [cx, cy] = pointerXY(event);
      const t0 = start + st[0] * 60000;
      showTip(cx, cy, STAGE_LABEL[st[2]], [
        { label: 'From', value: d3.utcFormat('%H:%M')(new Date(t0 + (tz ?? 0) * 60000)) },
        { label: 'Length', value: `${st[1]} min` },
      ]);
    })
    .on('pointerleave', hideTip);
  const hours = d3.range(0, total + 1, 60);
  g.append('g').attr('class', 'axis').selectAll('text').data(hours).join('text')
    .attr('x', (mm) => x(mm)).attr('y', innerH + 16).attr('text-anchor', 'middle')
    .text((mm) => d3.utcFormat('%H:%M')(new Date(start + mm * 60000 + (tz ?? 0) * 60000)));
}

export { STAGE_COLOR, STAGE_LABEL };
