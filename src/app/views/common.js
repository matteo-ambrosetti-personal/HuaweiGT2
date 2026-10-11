// Shared pieces for views: stat tiles, workout formatting, period labels.

import { h } from '../ui.js';
import { sparkline } from '../charts.js';
import { fmtPace, fmtSpeed, fmtKm, fmtDuration, fmtDate, fmtClock } from '../../lib/format.js';
import { chartBucket, BUCKET_LABELS } from '../../lib/huawei/sport-types.js';
import { SOURCE_LABELS } from '../../lib/model.js';
import { BUCKET_COLOR, FAMILY_COLOR } from '../ui.js';

/**
 * Stat tile: label, value (+unit), delta vs previous period, optional sparkline.
 * goodWhen: 'up' | 'down' | null decides the delta colour.
 */
export function tile({ label, value, unit, delta, deltaText, goodWhen = 'up', spark, color, note }) {
  const el = h('div', { class: 'tile' },
    h('div', { class: 'label' }, color ? h('span', { class: 'key', style: { background: color } }) : null, label),
    h('div', { class: 'value' }, value ?? '—', unit ? h('small', { text: unit }) : null));
  const d = h('div', { class: 'delta' });
  if (delta != null && Number.isFinite(delta)) {
    const up = delta > 0;
    const cls = Math.abs(delta) < 0.005 ? '' : (up ? (goodWhen === 'up' ? 'up-good' : goodWhen === 'down' ? 'up-bad' : '') : (goodWhen === 'down' ? 'down-good' : goodWhen === 'up' ? 'down-bad' : ''));
    if (cls) d.classList.add(cls);
    d.append(h('span', { 'aria-hidden': 'true', text: Math.abs(delta) < 0.005 ? '→' : up ? '▲' : '▼' }),
      `${up ? '+' : ''}${(delta * 100).toFixed(Math.abs(delta) < 0.1 ? 1 : 0)}% ${deltaText || 'vs previous period'}`);
  } else if (note) {
    d.textContent = note;
  }
  el.append(d);
  if (spark && spark.values.filter((v) => v != null).length > 1) {
    const sp = h('div', { class: 'spark' });
    el.append(sp);
    requestAnimationFrame(() => sparkline(sp, sp.clientWidth || 150, { values: spark.values, color: spark.color || color || 'var(--ink-2)' }));
  }
  return el;
}

export function bucketColor(family) {
  return BUCKET_COLOR[chartBucket(family)];
}

export function familyColor(family) {
  return FAMILY_COLOR[family] || 'var(--other)';
}

export function bucketLabel(b) {
  return BUCKET_LABELS[b];
}

/** Pace for foot sports, speed for rides. */
export function paceOrSpeed(w) {
  if (!(w.distance > 0) || !(w.duration > 0)) return { label: w.family === 'ride' ? 'Speed' : 'Pace', value: '—', unit: '' };
  if (w.family === 'ride') return { label: 'Speed', value: fmtSpeed(w.distance / w.duration), unit: 'km/h' };
  if (w.family === 'swim') return { label: 'Pace', value: fmtPace(w.duration / (w.distance / 100)), unit: '/100 m' };
  return { label: 'Pace', value: fmtPace(w.avgPace || w.duration / (w.distance / 1000)), unit: '/km' };
}

export function workoutTitle(w) {
  return `${w.label}${w.name && w.name !== w.label ? ` · ${w.name}` : ''}`;
}

export function workoutWhen(w) {
  return `${fmtDate(w.date, { weekday: true })} · ${fmtClock(w.start, w.tz)}`;
}

export function sourceBadges(item) {
  const list = item.sources || (item.source ? [item.source] : []);
  return list.map((s) => h('span', { class: 'badge', text: SOURCE_LABELS[s] || s }));
}

export function distanceText(w) {
  return w.distance > 0 ? `${fmtKm(w.distance)} km` : '—';
}

export function durationText(w) {
  return fmtDuration(w.duration);
}

export function rangeText({ from, to }) {
  return `${fmtDate(from, { short: from.slice(0, 4) === to.slice(0, 4) })} – ${fmtDate(to)}`;
}

/** Weekly sums of a day field within a range → values for sparklines. */
export function weeklySpark(rows, field, agg = 'mean') {
  const out = [];
  for (let i = 0; i < rows.length; i += 7) {
    const chunk = rows.slice(i, i + 7).map((r) => r[field]).filter((v) => v != null && Number.isFinite(v) && (field !== 'steps' || v > 0));
    if (!chunk.length) out.push(null);
    else out.push(agg === 'sum' ? chunk.reduce((a, b) => a + b, 0) : chunk.reduce((a, b) => a + b, 0) / chunk.length);
  }
  return out;
}
