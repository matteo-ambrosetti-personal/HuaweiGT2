import { h, chartCard, section, emptyState } from '../ui.js';
import { lineChart, columns } from '../charts.js';
import { tile, weeklySpark, emptyElsewhere } from './common.js';
import { daySeries, rollingMean, hourProfile, summarize, change, comparable } from '../../lib/stats.js';
import { fmtDate } from '../../lib/format.js';

const toX = (date) => new Date(date + 'T00:00:00Z');

export function renderHeart(root, ctx) {
  const { ds, range, prev, settings } = ctx;
  const rows = daySeries(ds, range);
  const cur = summarize(ds, range, settings);
  const old = summarize(ds, prev, settings);
  const has = (f) => rows.some((r) => r[f] != null);
  if (!has('restHr') && !has('hrAvg') && !has('spo2Avg') && !has('stressAvg')) {
    root.append(emptyElsewhere(ctx, {
      title: 'No heart data in this period',
      dates: Object.values(ds.days).filter((d) => d.restHr != null || d.hrAvg != null || d.spo2Avg != null || d.stressAvg != null).map((d) => d.date),
      span: (a, b) => `Your heart data runs from ${a} to ${b}.`,
      one: (a) => `Your only heart data is from ${a}.`,
    }) || emptyState('No heart data in this period', 'Heart rate, SpO2 and stress appear once your export includes them. Try a longer period.'));
    return;
  }
  const cmp = comparable(cur, old);
  const delta = (a, b) => (cmp ? change(a, b) : null);
  const lowRest = rows.filter((r) => r.restHr).sort((a, b) => a.restHr - b.restHr)[0];
  root.append(h('div', { class: 'tiles' },
    tile({ label: 'Resting heart rate', value: cur.restHr == null ? '—' : Math.round(cur.restHr), unit: 'bpm', delta: delta(cur.restHr, old.restHr), goodWhen: 'down', color: 'var(--heart)', spark: { values: weeklySpark(rows, 'restHr'), color: 'var(--heart)' } }),
    tile({ label: 'Lowest resting', value: lowRest ? lowRest.restHr : '—', unit: 'bpm', color: 'var(--heart)', note: lowRest ? fmtDate(lowRest.date) : null }),
    tile({ label: 'Average heart rate', value: cur.hrAvg == null ? '—' : Math.round(cur.hrAvg), unit: 'bpm', delta: delta(cur.hrAvg, old.hrAvg), goodWhen: null, color: 'var(--heart)', note: 'All-day average' }),
    tile({ label: 'Heart rate variability', value: cur.hrv == null ? '—' : Math.round(cur.hrv), unit: cur.hrv == null ? '' : 'ms', delta: delta(cur.hrv, old.hrv), goodWhen: 'up', color: 'var(--heart)', note: cur.hrv == null ? 'Not in your export' : 'RMSSD' }),
    tile({ label: 'Blood oxygen', value: cur.spo2 == null ? '—' : cur.spo2.toFixed(1), unit: cur.spo2 == null ? '' : '%', delta: delta(cur.spo2, old.spo2), goodWhen: null, color: 'var(--spo2)', note: cur.spo2 == null ? 'Not in your export' : 'Average SpO2' }),
    tile({ label: 'Stress', value: cur.stress == null ? '—' : Math.round(cur.stress), unit: cur.stress == null ? '' : '/100', delta: delta(cur.stress, old.stress), goodWhen: 'down', color: 'var(--stress)', note: cur.stress == null ? 'Not in your export' : 'Average score' }),
  ));

  if (has('restHr')) {
    const vals = rows.map((r) => r.restHr ?? null);
    const avg = rollingMean(vals, 30);
    root.append(chartCard({
      id: 'resting-hr',
      title: 'Resting heart rate',
      sub: 'Daily value and 30-day average. Lower usually means better recovery and fitness.',
      render: (el, w) => lineChart(el, w, {
        series: [
          { key: 'rest', label: 'Resting HR', color: 'var(--heart)', points: rows.map((r, i) => ({ x: toX(r.date), y: vals[i] })), width: 1.5, opacity: 0.55, dots: rows.length <= 45 },
          { key: 'avg', label: '30-day average', color: 'var(--ink)', points: rows.map((r, i) => ({ x: toX(r.date), y: avg[i] })), endLabel: true },
        ],
        yFormat: (v) => `${Math.round(v)}`, tipFormat: (v) => `${Math.round(v)} bpm`, title: 'Resting heart rate',
      }),
      legend: [{ label: 'Resting HR', color: 'var(--heart)', kind: 'line' }, { label: '30-day average', color: 'var(--ink)', kind: 'line' }],
      table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Resting HR', get: (r) => r.restHr ?? '—', r: true }], rows: rows.filter((r) => r.restHr).reverse() }),
    }));
  }

  const grid = h('div', { class: 'grid' });
  if (has('hrAvg')) {
    const band = chartCard({
      id: 'daily-hr',
      title: 'Daily heart rate range',
      sub: 'Shaded from lowest to highest reading; line is the daily average',
      render: (el, w) => lineChart(el, w, {
        series: [{ key: 'avg', label: 'Average', color: 'var(--heart)', points: rows.map((r) => ({ x: toX(r.date), y: r.hrAvg ?? null })) }],
        band: { label: 'Range', color: 'var(--heart)', points: rows.map((r) => ({ x: toX(r.date), lo: r.hrMin ?? null, hi: r.hrMax ?? null })) },
        yFormat: (v) => `${Math.round(v)}`, tipFormat: (v) => `${Math.round(v)} bpm`, title: 'Daily heart rate range',
      }),
      legend: [{ label: 'Average', color: 'var(--heart)', kind: 'line' }, { label: 'Lowest to highest', color: 'color-mix(in srgb, var(--heart) 25%, transparent)' }],
      table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Min', get: (r) => r.hrMin ?? '—', r: true }, { label: 'Avg', get: (r) => r.hrAvg ?? '—', r: true }, { label: 'Max', get: (r) => r.hrMax ?? '—', r: true }], rows: rows.filter((r) => r.hrAvg).reverse() }),
    });
    band.classList.add('span-7');
    const hp = hourProfile(rows, 'hrHourly');
    const hpRows = hp.map((v, i) => ({ label: String(i).padStart(2, '0'), title: `${String(i).padStart(2, '0')}:00`, value: v }));
    const hourCard = chartCard({
      id: 'hr-hour',
      title: 'Heart rate through the day',
      sub: 'Average for each hour',
      render: (el, w) => columns(el, w, { rows: hpRows, color: 'var(--heart)', valueLabel: 'Average bpm', yFormat: (v) => `${Math.round(v)}`, tipFormat: (v) => `${Math.round(v)} bpm` }),
      table: () => ({ columns: [{ label: 'Hour', get: (r) => r.title }, { label: 'bpm', get: (r) => (r.value ? Math.round(r.value) : '—'), r: true }], rows: hpRows }),
    });
    hourCard.classList.add('span-5');
    grid.append(band, hourCard);
  }
  const small = [
    { f: 'hrvAvg', title: 'Heart rate variability', sub: 'RMSSD in ms — higher is usually better', color: 'var(--heart)', unit: 'ms' },
    { f: 'spo2Avg', title: 'Blood oxygen (SpO2)', sub: 'Daily average, %', color: 'var(--spo2)', unit: '%' },
    { f: 'stressAvg', title: 'Stress', sub: 'Daily average score (1–99)', color: 'var(--stress)', unit: '' },
  ].filter((m) => has(m.f));
  for (const m of small) {
    const c = chartCard({
      id: `chart-${m.f}`,
      title: m.title,
      sub: m.sub,
      render: (el, w) => lineChart(el, w, {
        series: [{ key: m.f, label: m.title, color: m.color, points: rows.map((r) => ({ x: toX(r.date), y: r[m.f] ?? null })), dots: rows.length <= 45 }],
        yFormat: (v) => `${Math.round(v)}`, tipFormat: (v) => `${Number(v).toFixed(m.f === 'spo2Avg' ? 1 : 0)}${m.unit ? ` ${m.unit}` : ''}`, title: m.title,
      }),
      table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: m.title, get: (r) => r[m.f] ?? '—', r: true }], rows: rows.filter((r) => r[m.f] != null).reverse() }),
    });
    c.classList.add(small.length === 1 ? 'span-12' : small.length === 2 ? 'span-6' : 'span-4');
    grid.append(c);
  }
  root.append(section('Trends', null, grid));
}
