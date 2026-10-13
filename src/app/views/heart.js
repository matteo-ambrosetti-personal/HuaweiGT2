import { h, chartCard, section, emptyState } from '../ui.js';
import { lineChart, columns } from '../charts.js';
import { tile, weeklySpark, emptyElsewhere } from './common.js';
import { daySeries, rollingMean, hourProfile, summarize, change, comparable } from '../../lib/stats.js';
import { fmtDate, fmtMinuteOfDay } from '../../lib/format.js';
import { hrvBaseline, restingHrBaseline, elevated } from '../../lib/models/recovery.js';
import { cosinor, hourlyPoints } from '../../lib/models/rhythm.js';

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
  root.append(...baselines(ctx, rows));
}

/** HRV and resting HR against your own baselines, and the daily heart-rate rhythm. */
function baselines(ctx, rows) {
  const { ds, range } = ctx;
  const out = [];
  const grid = h('div', { class: 'grid' });
  const hrv = hrvBaseline(ds, range).filter((r) => r.ln != null || r.week != null);
  if (hrv.filter((r) => r.base != null).length > 1) {
    const e = (v) => (v == null ? null : Math.exp(v));
    const c = chartCard({
      id: 'hrv-baseline',
      title: 'HRV against your normal range',
      sub: 'Plews et al.: the 7-day average of ln RMSSD (line) against your 60-day baseline ± half a standard deviation, the smallest worthwhile change (band). A week below the band suggests accumulated stress or fatigue; single days swing a lot (dots).',
      render: (el, w) => lineChart(el, w, {
        series: [
          { key: 'd', label: 'Daily', color: 'var(--heart)', noLine: true, dots: true, r: 2.5, dotOpacity: 0.5, points: hrv.map((r) => ({ x: toX(r.date), y: e(r.ln) })) },
          { key: 'w', label: '7-day average', color: 'var(--ink)', points: hrv.map((r) => ({ x: toX(r.date), y: e(r.week) })), endLabel: true },
        ],
        band: { label: 'Normal range', color: 'var(--div-cool)', points: hrv.map((r) => ({ x: toX(r.date), lo: e(r.lo), hi: e(r.hi) })) },
        yFormat: (v) => `${Math.round(v)}`, tipFormat: (v) => `${Math.round(v)} ms`, title: 'HRV against your normal range',
      }),
      legend: [{ label: 'Daily HRV', color: 'var(--heart)' }, { label: '7-day average', color: 'var(--ink)', kind: 'line' }, { label: 'Normal range', color: 'color-mix(in srgb, var(--div-cool) 25%, transparent)' }],
      table: () => ({
        columns: [{ label: 'Date', get: (r) => r.date }, { label: 'HRV', get: (r) => (r.ln != null ? Math.round(e(r.ln)) : '—'), r: true }, { label: '7-day', get: (r) => (r.week != null ? Math.round(e(r.week)) : '—'), r: true }, { label: 'Normal range', get: (r) => (r.lo != null ? `${Math.round(e(r.lo))}–${Math.round(e(r.hi))}` : '—'), r: true }, { label: 'CV 7-day', get: (r) => (r.cv != null ? `${r.cv.toFixed(1)} %` : '—'), r: true }],
        rows: hrv.slice().reverse(),
      }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  const rest = restingHrBaseline(ds, range).filter((r) => r.rest != null);
  if (rest.filter((r) => r.base != null).length > 1) {
    const flagged = rest.filter(elevated);
    const c = chartCard({
      id: 'rest-baseline',
      title: 'Resting heart rate against your baseline',
      sub: `Your 30-day median (line) and daily values (dots); marked days are at least 3 bpm and one robust SD above it (${flagged.length} in this period). Such rises often follow hard training, short sleep, alcohol or the start of an infection (Radin et al. 2020).`,
      render: (el, w) => lineChart(el, w, {
        series: [
          { key: 'r', label: 'Resting HR', color: 'var(--heart)', noLine: true, dots: true, r: 2.5, dotOpacity: 0.55, points: rest.map((r) => ({ x: toX(r.date), y: r.rest })) },
          { key: 'f', label: 'Elevated', color: 'var(--warning)', noLine: true, dots: true, r: 4.5, points: rest.map((r) => ({ x: toX(r.date), y: elevated(r) ? r.rest : null })) },
          { key: 'b', label: '30-day baseline', color: 'var(--ink)', points: rest.map((r) => ({ x: toX(r.date), y: r.base })) },
        ],
        yFormat: (v) => `${Math.round(v)}`, tipFormat: (v) => `${Math.round(v)} bpm`, title: 'Resting heart rate against your baseline',
      }),
      legend: [{ label: 'Resting HR', color: 'var(--heart)' }, { label: 'Elevated', color: 'var(--warning)' }, { label: '30-day baseline', color: 'var(--ink)', kind: 'line' }],
      table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Resting HR', get: (r) => r.rest, r: true }, { label: 'Baseline', get: (r) => (r.base != null ? Math.round(r.base) : '—'), r: true }, { label: 'Difference', get: (r) => (r.delta != null ? `${r.delta > 0 ? '+' : ''}${Math.round(r.delta)}` : '—'), r: true }], rows: rest.slice().reverse() }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  if (grid.children.length) out.push(section('Recovery baselines', 'Each marker against your own recent normal, not a population norm', grid));

  // ---- daily rhythm (cosinor)
  const fit = cosinor(hourlyPoints(rows, 'hrHourly'));
  if (fit && fit.amplitude > 0) {
    const prof = hourProfile(rows, 'hrHourly');
    const hp = prof.map((v, i) => ({ label: String(i).padStart(2, '0'), title: `${String(i).padStart(2, '0')}:00`, value: v }));
    const trough = (fit.peakHour + 12) % 24;
    const card = chartCard({
      id: 'hr-cosinor',
      title: 'Your daily heart-rate rhythm',
      sub: `A 24-hour cosine fitted to your hourly heart rate (cosinor analysis, Cornelissen 2014): average level (MESOR) ${Math.round(fit.mesor)} bpm, swing ±${Math.round(fit.amplitude)} bpm, peak around ${fmtMinuteOfDay(fit.peakHour * 60)} and low around ${fmtMinuteOfDay(trough * 60)}. The fit explains ${Math.round(fit.r2 * 100)} % of the hour-to-hour variation; a wide swing with a night-time low is the usual healthy pattern.`,
      render: (el, w) => columns(el, w, {
        rows: hp, color: 'var(--heart)', valueLabel: 'Average bpm', yFormat: (v) => `${Math.round(v)}`, tipFormat: (v) => `${Math.round(v)} bpm`,
        overlay: { fn: (i) => fit.at(i + 0.5), color: 'var(--ink)', label: 'Cosinor fit' },
      }),
      legend: [{ label: 'Hourly average', color: 'var(--heart)' }, { label: 'Cosinor fit', color: 'var(--ink)', kind: 'line' }],
      table: () => ({ columns: [{ label: 'Hour', get: (r) => r.title }, { label: 'Average bpm', get: (r) => (r.value ? Math.round(r.value) : '—'), r: true }, { label: 'Fit', get: (r, i) => Math.round(fit.at(Number(r.label) + 0.5)), r: true }], rows: hp }),
    });
    out.push(section('Daily rhythm', null, card));
  }
  return out;
}
