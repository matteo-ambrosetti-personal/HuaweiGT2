// Training: load from heart rate and what it adds up to (fitness, fatigue,
// form), how hard the sessions were, and what your runs say about your
// running fitness. Follows the period filter; history before the period
// still feeds the 42-day averages.

import { h, chartCard, section, emptyState, BUCKET_COLOR } from '../ui.js';
import { lineChart, stackedBars, scatterTrend } from '../charts.js';
import { pmcChart, scatterXY } from '../charts-models.js';
import { tile, workoutTitle } from './common.js';
import { analyze } from '../../lib/models/insights.js';
import { formZone, acwrZone, SEILER } from '../../lib/models/load.js';
import { raceTime, RACES, bestEfforts, riegelFit, riegel, criticalSpeed } from '../../lib/models/running.js';
import { trailing, median } from '../../lib/models/util.js';
import { fmtDate, fmtDuration, fmtPace, fmtOne, fmtInt, weekStart, addDays } from '../../lib/format.js';
import { BUCKETS, BUCKET_LABELS, chartBucket } from '../../lib/huawei/sport-types.js';

const day = (k) => new Date(`${k}T00:00:00Z`);
const sign = (v, d = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

export function renderTraining(root, ctx) {
  const { ds, settings, range } = ctx;
  const a = analyze(ds, settings);
  if (!a.last || !a.pmc.length) {
    root.append(emptyState('No training load yet', 'Training load comes from workouts with heart rate. Import your export, or sync Health Connect or intervals.icu.', h('a', { class: 'btn primary', href: '#data' }, 'Import data')));
    return;
  }
  const inRange = (r) => r.date >= range.from && r.date <= range.to;
  const pmc = a.pmc.filter(inRange);
  const s = a.snap;
  const fz = formZone(s.tsb), az = acwrZone(s.acwr);
  const lastWeek = a.weeks.at(-1);
  const imputed = [...a.loads.values()].filter((l) => l.basis === 'imputed').length;

  root.append(h('div', { class: 'tiles' },
    tile({ label: 'Fitness (CTL)', value: Math.round(s.ctl), unit: s.ctlChange != null ? `${sign(s.ctlChange, 1)} in a week` : '', color: 'var(--ink)', note: s.warmup ? 'Still warming up (under 6 weeks of data)' : null }),
    tile({ label: 'Fatigue (ATL)', value: Math.round(s.atl), color: 'var(--div-warm)', note: '7-day load' }),
    tile({ label: 'Form (TSB)', value: sign(s.tsb), color: s.tsb >= 0 ? 'var(--div-cool)' : 'var(--div-warm)', note: s.warmup ? 'Warming up' : fz.label }),
    tile({ label: 'Acute:chronic ratio', value: s.acwr != null ? s.acwr.toFixed(2) : '—', color: 'var(--div-warm)', note: az ? `${az.label} (0.8–1.3 steady)` : 'Needs 4 weeks' }),
    tile({ label: 'Monotony, last week', value: lastWeek?.monotony != null ? lastWeek.monotony.toFixed(1) : '—', color: 'var(--ink-2)', note: lastWeek?.monotony > 2 ? 'Above 2: vary hard and easy days' : 'Foster: keep it under 2' }),
    tile({ label: 'Load, last 7 days', value: fmtInt(a.pmc.slice(-7).reduce((t, r) => t + r.load, 0)), unit: 'TRIMP', color: 'var(--ink-2)', note: `${fmtInt(a.loads.size)} workouts rated${imputed ? `, ${imputed} without HR estimated` : ''}` }),
  ));

  // ---- PMC
  if (pmc.length > 1) {
    root.append(chartCard({
      id: 'pmc',
      title: 'Fitness, fatigue and form',
      sub: 'Banister\'s impulse–response model as a Performance Management Chart. Fitness is your 42-day load, fatigue your 7-day load (Banister TRIMP from heart rate); form is yesterday\'s fitness minus fatigue. Build with form around −10 to −30; taper to a positive form before a race.',
      render: (el, w) => pmcChart(el, w, { rows: pmc, height: w < 520 ? 300 : 340 }),
      legend: [
        { label: 'Fitness (CTL)', color: 'var(--ink)', kind: 'line' },
        { label: 'Fatigue (ATL)', color: 'var(--div-warm)', kind: 'line' },
        { label: 'Form: fresh', color: 'var(--div-cool)' },
        { label: 'Form: fatigued', color: 'var(--div-warm)' },
      ],
      table: () => ({
        columns: [
          { label: 'Date', get: (r) => r.date },
          { label: 'Load', get: (r) => (r.load ? Math.round(r.load) : '—'), r: true },
          { label: 'Fitness', get: (r) => Math.round(r.ctl), r: true },
          { label: 'Fatigue', get: (r) => Math.round(r.atl), r: true },
          { label: 'Form', get: (r) => sign(r.tsb), r: true },
        ],
        rows: pmc.slice().reverse(),
      }),
    }));
  }

  const grid = h('div', { class: 'grid' });
  // ---- ACWR
  const ac = a.acwr.filter(inRange).filter((r) => r.ratio != null);
  if (ac.length > 1) {
    const c = chartCard({
      id: 'acwr',
      title: 'Acute:chronic workload ratio',
      sub: 'Last week\'s load against the last four weeks (EWMA, Williams et al. 2017). The band is the 0.8–1.3 range often called a steady build; spikes above 1.5 were linked to injuries in team sports (Gabbett 2016). Treat it as a prompt, not a rule (Impellizzeri 2020).',
      render: (el, w) => lineChart(el, w, {
        series: [{ key: 'r', label: 'Ratio', color: 'var(--div-warm)', points: ac.map((r) => ({ x: day(r.date), y: r.ratio })) }],
        band: { label: 'Steady build', color: 'var(--div-cool)', points: ac.map((r) => ({ x: day(r.date), lo: 0.8, hi: 1.3 })) },
        refLines: [{ y: 1.5, label: '1.5' }],
        yFormat: (v) => v.toFixed(1), tipFormat: (v) => v.toFixed(2), title: 'Acute:chronic workload ratio',
      }),
      legend: [{ label: 'Ratio', color: 'var(--div-warm)', kind: 'line' }, { label: '0.8–1.3', color: 'color-mix(in srgb, var(--div-cool) 25%, transparent)' }],
      table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Acute', get: (r) => Math.round(r.acute), r: true }, { label: 'Chronic', get: (r) => Math.round(r.chronic), r: true }, { label: 'Ratio', get: (r) => r.ratio.toFixed(2), r: true }], rows: ac.slice().reverse() }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }

  // ---- weekly load by sport + monotony
  const weeks = new Map();
  const firstLoad = Object.values(ds.workouts).filter((w) => a.loads.has(w.id) && w.date >= range.from).reduce((m, w) => (w.date < m ? w.date : m), range.to);
  for (let w = weekStart(firstLoad); w <= range.to; w = addDays(w, 7)) weeks.set(w, { week: w, key: w, label: fmtDate(w, { short: true }), run: 0, walkhike: 0, ride: 0, other: 0 });
  for (const w of Object.values(ds.workouts)) {
    const l = a.loads.get(w.id);
    const row = weeks.get(weekStart(w.date));
    if (l && row) row[chartBucket(w.family)] += l.trimp;
  }
  const wrows = [...weeks.values()];
  const keys = BUCKETS.filter((b) => wrows.some((r) => r[b] > 0)).map((b) => ({ key: b, label: BUCKET_LABELS[b], color: BUCKET_COLOR[b] }));
  if (keys.length) {
    const c = chartCard({
      id: 'weekly-load',
      title: 'Weekly training load',
      sub: 'Banister TRIMP per week, by sport: time weighted exponentially by heart-rate reserve, so hard minutes count far more than easy ones.',
      render: (el, w) => stackedBars(el, w, { rows: wrows, keys, title: 'Weekly training load', tipTitle: (r) => `Week of ${fmtDate(r.week)}`, tipValue: (v) => fmtInt(v) }),
      legend: keys.map((k) => ({ label: k.label, color: k.color })),
      table: () => ({ columns: [{ label: 'Week of', get: (r) => fmtDate(r.week) }, ...keys.map((k) => ({ label: k.label, get: (r) => (r[k.key] ? fmtInt(r[k.key]) : '—'), r: true }))], rows: wrows.slice().reverse() }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  const mono = a.weeks.filter((w) => w.week >= weekStart(range.from) && w.week <= range.to && w.monotony != null);
  if (mono.length > 1) {
    const c = chartCard({
      id: 'monotony',
      title: 'Training monotony',
      sub: 'Foster (1998): a week\'s mean daily load divided by its standard deviation. Above 2, with high load, illness became more likely; alternating hard and easy days keeps it low.',
      render: (el, w) => lineChart(el, w, {
        series: [{ key: 'm', label: 'Monotony', color: 'var(--ink-2)', points: mono.map((r) => ({ x: day(r.week), y: r.monotony })), dots: true }],
        refLines: [{ y: 2, label: '2.0' }], yFormat: (v) => v.toFixed(1), tipFormat: (v) => v.toFixed(2), title: 'Training monotony', zeroBased: true,
      }),
      table: () => ({ columns: [{ label: 'Week of', get: (r) => fmtDate(r.week) }, { label: 'Load', get: (r) => fmtInt(r.load), r: true }, { label: 'Monotony', get: (r) => r.monotony.toFixed(2), r: true }, { label: 'Strain', get: (r) => fmtInt(r.strain), r: true }], rows: mono.slice().reverse() }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  // ---- intensity distribution
  const zoneColor = (i) => `color-mix(in oklab, var(--heart) ${[35, 65, 100][i]}%, var(--surface))`;
  const zrows = weeklyZones(ds, range, a.maxHr);
  if (zrows.some((r) => r.total > 0)) {
    const tot = zrows.reduce((t, r) => [t[0] + r.z1s, t[1] + r.z2s, t[2] + r.z3s], [0, 0, 0]);
    const all = tot[0] + tot[1] + tot[2];
    const pct = (v) => `${Math.round((v / all) * 100)} %`;
    const c = chartCard({
      id: 'intensity',
      title: 'Intensity distribution',
      sub: `Seiler's three zones from heart rate: easy below ${Math.round(SEILER[0] * 100)} % of max HR (${Math.round(SEILER[0] * a.maxHr)} bpm), moderate up to ${Math.round(SEILER[1] * 100)} %, hard above. This period: ${pct(tot[0])} easy, ${pct(tot[1])} moderate, ${pct(tot[2])} hard. Endurance athletes typically do about 80 % easy (line).`,
      render: (el, w) => stackedBars(el, w, {
        rows: zrows.filter((r) => r.total > 0),
        keys: [{ key: 'z1', label: 'Easy', color: zoneColor(0) }, { key: 'z2', label: 'Moderate', color: zoneColor(1) }, { key: 'z3', label: 'Hard', color: zoneColor(2) }],
        goal: 0.8, goalLabel: '80 % easy', yMax: 1, yFormat: (v) => `${Math.round(v * 100)}%`, tipValue: (v) => `${Math.round(v * 100)} %`,
        tipTitle: (r) => `Week of ${fmtDate(r.week)} · ${fmtDuration(r.total)}`, title: 'Intensity distribution',
      }),
      legend: [{ label: 'Easy', color: zoneColor(0) }, { label: 'Moderate', color: zoneColor(1) }, { label: 'Hard', color: zoneColor(2) }],
      table: () => ({
        columns: [
          { label: 'Week of', get: (r) => fmtDate(r.week) }, { label: 'Easy', get: (r) => fmtDuration(r.z1s), r: true },
          { label: 'Moderate', get: (r) => fmtDuration(r.z2s), r: true }, { label: 'Hard', get: (r) => fmtDuration(r.z3s), r: true },
          { label: 'Polarization index', get: (r) => (r.pi != null ? r.pi.toFixed(2) : '—'), r: true },
        ],
        rows: zrows.filter((r) => r.total > 0).reverse(),
      }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  if (grid.children.length) root.append(section('Load and intensity', null, grid));

  root.append(...runningSection(ctx, a));
  root.append(h('p', { class: 'note muted', style: { fontSize: '12px' }, text: `Load uses max HR ${a.maxHr} bpm and your 30-day median resting HR before each workout, with ${settings.sex === 'female' ? 'women\'s' : 'men\'s'} TRIMP weighting${settings.sex ? '' : ' (set your sex under Data → Settings for the other)'}. Workouts without heart rate are estimated from your own minutes-to-load ratio for that sport.` }));
}

/** Weekly seconds in Seiler's zones as shares (z1…z3), plus totals for the table. */
function weeklyZones(ds, range, maxHr) {
  const rows = new Map();
  for (let w = weekStart(range.from); w <= range.to; w = addDays(w, 7)) rows.set(w, { week: w, key: w, label: fmtDate(w, { short: true }), z1s: 0, z2s: 0, z3s: 0 });
  for (const w of Object.values(ds.workouts)) {
    if (!w.hrHist || w.date < range.from || w.date > range.to) continue;
    const r = rows.get(weekStart(w.date));
    if (!r) continue;
    w.hrHist.secs.forEach((sec, i) => {
      const pct = (w.hrHist.from + w.hrHist.step * (i + 0.5)) / maxHr;
      if (pct >= SEILER[1]) r.z3s += sec; else if (pct >= SEILER[0]) r.z2s += sec; else r.z1s += sec;
    });
  }
  return [...rows.values()].map((r) => {
    const total = r.z1s + r.z2s + r.z3s;
    const f = (v) => (total ? v / total : 0);
    const pi = total && r.z3s ? Math.log10((f(r.z1s) / (f(r.z2s) || 0.01)) * f(r.z3s) * 100) : null;
    return { ...r, total, z1: f(r.z1s), z2: f(r.z2s), z3: f(r.z3s), pi };
  });
}

function runningSection(ctx, a) {
  const { ds, range } = ctx;
  const out = [];
  const grid = h('div', { class: 'grid' });
  const inR = (p) => p.date >= range.from && p.date <= range.to;
  // ---- VDOT
  const vd = a.vdots.filter(inR);
  if (vd.length) {
    const best = a.bestVdot.filter(inR);
    const c = chartCard({
      id: 'vdot',
      title: 'Running fitness (VDOT)',
      sub: 'Daniels & Gilbert: each dot is a run\'s VDOT from its time over distance (or its best 5 km/10 km effort, if better). The line is your best of the previous 90 days. Easy runs sit lower by design.',
      render: (el, w) => scatterTrend(el, w, {
        points: vd.map((p) => ({ x: new Date(p.start), y: p.vdot, id: p.id, label: `${workoutTitle(ds.workouts[p.id])} · ${fmtDate(p.date)}`, color: 'var(--run)' })),
        trend: best.map((p) => ({ x: new Date(p.start), y: p.vdot })),
        yFormat: (v) => fmtOne(v), yLabel: 'VDOT', onClick: (p) => ctx.actions.openWorkout(p.id),
      }),
      legend: [{ label: 'Run', color: 'var(--run)' }, { label: 'Best of 90 days', color: 'var(--ink)', kind: 'line' }],
      table: () => ({ columns: [{ label: 'Date', get: (p) => p.date }, { label: 'VDOT', get: (p) => p.vdot.toFixed(1), r: true }, { label: 'From', get: (p) => (p.from === 'run' ? 'whole run' : `best ${p.from}`) }], rows: vd.slice().reverse() }),
    });
    c.classList.add('span-7');
    grid.append(c, pacesPanel(a, ds));
  }
  // ---- VO2max
  const vo = a.vo2runs.filter(inR);
  if (vo.length >= 2) {
    const med = trailing(vo.map((p) => p.vo2max), 7, median, 3);
    const watch = Object.values(ds.days).filter((d) => d.vo2max > 0 && d.date >= range.from && d.date <= range.to).sort((x, y) => (x.date < y.date ? -1 : 1));
    const c = chartCard({
      id: 'vo2max',
      title: 'Estimated VO2max',
      sub: `From steady, flat runs: the ACSM running equation gives the oxygen cost of your pace, and heart-rate reserve ≈ VO2 reserve (Swain & Leutholtz 1997) scales it to a maximum. Line: median of the last 7. Resting-HR estimate (Uth et al. 2004): ${a.vo2.uth ?? '—'} ml/kg/min.`,
      render: (el, w) => scatterTrend(el, w, {
        points: [
          ...vo.map((p) => ({ x: new Date(p.start), y: p.vo2max, id: p.id, label: `${workoutTitle(ds.workouts[p.id])} · ${fmtDate(p.date)}`, color: 'var(--run)' })),
          ...watch.map((d) => ({ x: day(d.date), y: d.vo2max, label: `Watch estimate · ${fmtDate(d.date)}`, color: 'var(--ink-2)' })),
        ],
        trend: vo.map((p, i) => ({ x: new Date(p.start), y: med[i] })),
        yFormat: (v) => fmtOne(v), yLabel: 'ml/kg/min', onClick: (p) => p.id && ctx.actions.openWorkout(p.id),
      }),
      legend: [{ label: 'Run estimate', color: 'var(--run)' }, ...(watch.length ? [{ label: 'Watch', color: 'var(--ink-2)' }] : []), { label: 'Median of 7', color: 'var(--ink)', kind: 'line' }],
      table: () => ({ columns: [{ label: 'Date', get: (p) => p.date }, { label: 'VO2max', get: (p) => p.vo2max.toFixed(1), r: true }, { label: '%HRR', get: (p) => `${Math.round(p.hrr * 100)} %`, r: true }], rows: vo.slice().reverse() }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  // ---- efficiency factor
  const ef = a.ef.filter(inR);
  if (ef.length >= 2) {
    const med = trailing(ef.map((p) => p.ef), 7, median, 3);
    const c = chartCard({
      id: 'efficiency',
      title: 'Efficiency factor',
      sub: 'Metres per minute per heartbeat on steady, flat runs (Friel; Allen & Coggan). Up means more speed for the same heart rate, the usual sign of a growing aerobic base. Heat and fatigue push it down.',
      render: (el, w) => scatterTrend(el, w, {
        points: ef.map((p) => ({ x: new Date(p.start), y: p.ef, id: p.id, label: `${workoutTitle(ds.workouts[p.id])} · ${fmtDate(p.date)}`, color: 'var(--run)' })),
        trend: ef.map((p, i) => ({ x: new Date(p.start), y: med[i] })),
        yFormat: (v) => v.toFixed(2), yLabel: 'm/min per beat', onClick: (p) => ctx.actions.openWorkout(p.id),
      }),
      legend: [{ label: 'Run', color: 'var(--run)' }, { label: 'Median of 7', color: 'var(--ink)', kind: 'line' }],
      table: () => ({ columns: [{ label: 'Date', get: (p) => p.date }, { label: 'EF', get: (p) => p.ef.toFixed(3), r: true }], rows: ef.slice().reverse() }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  // ---- best efforts curve
  const runs = Object.values(ds.workouts).filter((w) => w.family === 'run' && w.efforts && w.date >= addDays(range.to, -365) && w.date <= range.to);
  const efforts = bestEfforts(runs);
  if (efforts.length >= 2) {
    const fit = riegelFit(efforts);
    const cs = criticalSpeed(efforts);
    const anchor = efforts.find((e) => e.key === '5k') || efforts[0];
    const paceOf = (m, t) => t / (m / 1000);
    const c = chartCard({
      id: 'effort-curve',
      title: 'Your speed–distance curve',
      sub: `Best efforts in the last 12 months (pace, log scale). Riegel's population curve (exponent 1.06, from your ${anchor.label}) is grey${fit ? `; your own fitted exponent is ${fit.exponent.toFixed(3)} (line)` : ''}.${cs ? ` Critical speed ${fmtPace(1000 / cs.cs)} /km with D′ ${Math.round(cs.dPrime)} m (Monod & Scherrer; Hill).` : ''}`,
      render: (el, w) => scatterXY(el, w, {
        points: efforts.map((e) => ({ x: e.metres / 1000, y: paceOf(e.metres, e.time), label: `${e.label} · ${fmtDate(e.date)}`, id: e.id, color: 'var(--run)', rows: [{ label: 'Time', value: fmtDuration(e.time) }, { label: 'Pace', value: `${fmtPace(paceOf(e.metres, e.time))} /km`, color: 'var(--run)' }] })),
        lines: [
          { fn: (km) => paceOf(km * 1000, riegel(anchor.time, anchor.metres, km * 1000)), color: 'var(--ink-2)', width: 1.5, opacity: 0.6 },
          ...(fit ? [{ fn: (km) => paceOf(km * 1000, fit.scale * (km * 1000) ** fit.exponent), color: 'var(--ink)' }] : []),
        ],
        xLog: true, xFormat: (v) => `${+v.toFixed(1)}`, xLabel: 'km (log scale)', yFormat: (v) => fmtPace(v), yLabel: 'Pace /km',
        xTicks: [1, 2, 5, 10, 21.1, 42.2].filter((v) => v >= efforts[0].metres / 1000 / 1.2 && v <= efforts.at(-1).metres / 1000 * 1.2),
        invertY: true, onClick: (p) => ctx.actions.openWorkout(p.id),
      }),
      legend: [{ label: 'Best effort', color: 'var(--run)' }, ...(fit ? [{ label: 'Your fit', color: 'var(--ink)', kind: 'line' }] : []), { label: 'Riegel 1.06', color: 'var(--ink-2)', kind: 'line' }],
      table: () => ({
        columns: [{ label: 'Distance', get: (e) => e.label }, { label: 'Time', get: (e) => fmtDuration(e.time), r: true }, { label: 'Pace', get: (e) => `${fmtPace(paceOf(e.metres, e.time))} /km`, r: true }, { label: 'When', get: (e) => fmtDate(e.date) }],
        rows: efforts,
      }),
    });
    c.classList.add('span-12');
    grid.append(c);
  }
  if (grid.children.length) out.push(section('Running fitness', 'Models of running performance applied to your runs', grid));
  return out;
}

function pacesPanel(a, ds) {
  const v = a.vdotNow;
  const panel = h('div', { class: 'panel span-5', id: 'daniels' });
  if (!v) return panel;
  const p = a.paces;
  const watch = Object.values(ds.days).filter((d) => d.pred).sort((x, y) => (x.date < y.date ? -1 : 1)).at(-1)?.pred || {};
  const tb = h('tbody', null, RACES.map((r) => {
    const t = raceTime(v, r.metres);
    const w = watch[{ '5k': 'k5', '10k': 'k10', hm: 'hm', m: 'm' }[r.key]];
    return h('tr', null, h('td', { text: r.label }), h('td', { class: 'r', text: fmtDuration(t) }), h('td', { class: 'r', text: `${fmtPace(t / (r.metres / 1000))} /km` }), h('td', { class: 'r muted', text: w > 0 ? fmtDuration(w) : '—' }));
  }));
  const paces = [
    ['Easy', `${fmtPace(p.easy[0])}–${fmtPace(p.easy[1])}`, 'Most of your running'],
    ['Marathon', fmtPace(p.marathon), 'Long steady runs'],
    ['Threshold', fmtPace(p.threshold), 'About 20–40 min of tempo'],
    ['Interval', fmtPace(p.interval), '3–5 min repeats'],
    ['Repetition', fmtPace(p.repetition), '200–400 m, full recovery'],
  ];
  panel.append(
    h('h3', { class: 'chart-title', text: `VDOT ${v.toFixed(1)}: race equivalents` }),
    h('p', { class: 'chart-sub', text: 'What your best recent runs are worth at other distances (Daniels & Gilbert), next to the watch\'s own prediction.' }),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', { text: 'Race' }), h('th', { class: 'r', text: 'Time' }), h('th', { class: 'r', text: 'Pace' }), h('th', { class: 'r', text: 'Watch' }))), tb)),
    h('h3', { class: 'chart-title', style: { marginTop: '16px' }, text: 'Training paces' }),
    h('p', { class: 'chart-sub', text: 'Daniels\' Running Formula, per km.' }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'pace-table' }, h('tbody', null, paces.map(([k, val, use]) => h('tr', null, h('td', { text: k }), h('td', { class: 'r', text: val }), h('td', { class: 'muted', text: use })))))));
  return panel;
}

