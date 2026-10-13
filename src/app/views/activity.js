import { h, chartCard, section } from '../ui.js';
import { dailyBars, columns, stackedBars } from '../charts.js';
import { STEP_BANDS, monthlyStepBands, restActivity } from '../../lib/models/rhythm.js';
import { tile } from './common.js';
import { daySeries, rollingMean, weekdayProfile, hourProfile, streaks, stepBests, summarize, change, comparable } from '../../lib/stats.js';
import { fmtInt, fmtDate, fmtOne, weekdayName, monthName } from '../../lib/format.js';

export function renderActivity(root, ctx) {
  const { ds, range, prev, settings } = ctx;
  const rows = daySeries(ds, range);
  const cur = summarize(ds, range, settings);
  const old = summarize(ds, prev, settings);
  const st = streaks(ds, settings.stepGoal);
  const best = stepBests(ds);
  const cmp = comparable(cur, old);
  const delta = (a, b) => (cmp ? change(a, b) : null);

  root.append(h('div', { class: 'tiles' },
    tile({ label: 'Total steps', value: fmtInt(cur.totalSteps), delta: delta(cur.totalSteps, old.totalSteps), color: 'var(--steps)' }),
    tile({ label: 'Walking distance', value: fmtOne(cur.walkDistance / 1000), unit: 'km', delta: delta(cur.walkDistance, old.walkDistance), color: 'var(--steps)', note: 'From all-day step tracking' }),
    tile({ label: 'Active calories', value: fmtInt(cur.kcal), unit: 'kcal', delta: delta(cur.kcal, old.kcal), color: 'var(--steps)' }),
    tile({ label: 'Current goal streak', value: fmtInt(st.current), unit: st.current === 1 ? 'day' : 'days', color: 'var(--steps)', note: `Longest ${st.longest} days${st.longestEnd ? ` (to ${fmtDate(st.longestEnd, { short: true })})` : ''}` }),
    tile({ label: 'Best day', value: best.day ? fmtInt(best.day.steps) : '—', unit: 'steps', color: 'var(--steps)', note: best.day ? fmtDate(best.day.date) : null }),
    tile({ label: 'Best week', value: best.week ? fmtInt(best.week.steps) : '—', unit: 'steps', color: 'var(--steps)', note: best.week ? `Week of ${fmtDate(best.week.key)}` : null }),
  ));

  const steps = rows.map((r) => ({ date: r.date, value: r.steps > 0 ? r.steps : null }));
  const avg = rollingMean(steps.map((r) => r.value), 7);
  root.append(chartCard({
    id: 'daily-steps',
    title: 'Daily steps',
    sub: `Bars are days; the line is the 7-day average. Goal ${fmtInt(settings.stepGoal)}.`,
    render: (el, w) => dailyBars(el, w, {
      rows: steps, avg, goal: settings.stepGoal, color: 'var(--steps)', valueLabel: 'Steps',
      tipValue: { title: (r) => fmtDate(r.date, { weekday: true }), value: (v) => fmtInt(v) },
      onClick: (r) => ctx.actions.focusDay(r.date),
    }),
    legend: [{ label: 'Steps', color: 'var(--steps)' }, { label: '7-day average', color: 'var(--ink)', kind: 'line' }],
    table: () => ({
      columns: [
        { label: 'Date', get: (r) => fmtDate(r.date, { weekday: true }) },
        { label: 'Steps', get: (r) => (r.steps ? fmtInt(r.steps) : '—'), r: true },
        { label: 'Distance (km)', get: (r) => (r.distance ? fmtOne(r.distance / 1000) : '—'), r: true },
        { label: 'Active kcal', get: (r) => (r.kcal ? fmtInt(r.kcal) : '—'), r: true },
        { label: 'Active minutes', get: (r) => r.activeMin ?? '—', r: true },
      ],
      rows: rows.slice().reverse(),
    }),
  }));

  const grid = h('div', { class: 'grid' });
  const dist = chartCard({
    id: 'daily-distance',
    title: 'Distance per day',
    sub: 'Kilometres from all-day tracking',
    render: (el, w) => dailyBars(el, w, {
      rows: rows.map((r) => ({ date: r.date, value: r.distance > 0 ? r.distance / 1000 : null })),
      color: 'var(--steps)', valueLabel: 'Distance', yFormat: (v) => `${fmtOne(v)}`,
      tipValue: { title: (r) => fmtDate(r.date, { weekday: true }), value: (v) => `${fmtOne(v)} km` },
    }),
    table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'km', get: (r) => (r.distance ? fmtOne(r.distance / 1000) : '—'), r: true }], rows: rows.slice().reverse() }),
  });
  dist.classList.add('span-6');
  const kcal = chartCard({
    id: 'daily-kcal',
    title: 'Active calories per day',
    sub: 'kcal burned through movement',
    render: (el, w) => dailyBars(el, w, {
      rows: rows.map((r) => ({ date: r.date, value: r.kcal > 0 ? r.kcal : null })),
      color: 'var(--steps)', valueLabel: 'Active kcal',
      tipValue: { title: (r) => fmtDate(r.date, { weekday: true }), value: (v) => `${fmtInt(v)} kcal` },
    }),
    table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'kcal', get: (r) => (r.kcal ? fmtInt(r.kcal) : '—'), r: true }], rows: rows.slice().reverse() }),
  });
  kcal.classList.add('span-6');
  grid.append(dist, kcal);

  const wd = weekdayProfile(rows, 'steps');
  const wdCard = chartCard({
    id: 'weekday-steps',
    title: 'Average steps by weekday',
    render: (el, w) => columns(el, w, {
      rows: wd.map((v, i) => ({ label: weekdayName(i), value: v })), color: 'var(--steps)', valueLabel: 'Average steps', tipFormat: (v) => fmtInt(v),
    }),
    table: () => ({ columns: [{ label: 'Weekday', get: (r) => r.label }, { label: 'Average steps', get: (r) => (r.value ? fmtInt(r.value) : '—'), r: true }], rows: wd.map((v, i) => ({ label: weekdayName(i), value: v })) }),
  });
  wdCard.classList.add('span-6');
  const hp = hourProfile(rows, 'stepsHourly');
  const hpRows = hp.map((v, i) => ({ label: String(i).padStart(2, '0'), title: `${String(i).padStart(2, '0')}:00–${String(i + 1).padStart(2, '0')}:00`, value: v }));
  const hourCard = chartCard({
    id: 'hour-steps',
    title: 'When you move',
    sub: 'Average steps in each hour of the day',
    render: (el, w) => columns(el, w, { rows: hpRows, color: 'var(--steps)', valueLabel: 'Average steps', tipFormat: (v) => fmtInt(v) }),
    table: () => ({ columns: [{ label: 'Hour', get: (r) => r.title }, { label: 'Average steps', get: (r) => (r.value ? fmtInt(r.value) : '—'), r: true }], rows: hpRows }),
  });
  hourCard.classList.add('span-6');
  grid.append(wdCard, hourCard);
  root.append(section('Patterns', null, grid));
  root.append(...activityModels(rows));
}

/** Step-count bands (Tudor-Locke) per month and the rest–activity rhythm (Van Someren). */
function activityModels(rows) {
  const out = [];
  const grid = h('div', { class: 'grid' });
  const months = monthlyStepBands(rows);
  if (months.length) {
    const colors = STEP_BANDS.map((_, i) => `var(--heat-${i})`);
    const keys = STEP_BANDS.map((b, i) => ({ key: b.key, label: `${b.label} (${b.hi === Infinity ? `${fmtInt(b.lo)}+` : `${fmtInt(b.lo)}–${fmtInt(b.hi - 1)}`})`, color: colors[i] }));
    const share = months.map((m) => ({ ...m, key: m.month, label: monthName(Number(m.month.slice(5)) - 1), ...Object.fromEntries(STEP_BANDS.map((b) => [b.key, m[b.key] / m.n])) }));
    const days = months.reduce((t, m) => t + m.n, 0);
    const over = months.reduce((t, m) => t + m.somewhat + m.active + m.high, 0);
    const c = chartCard({
      id: 'step-bands',
      title: 'Days by activity level',
      sub: `Tudor-Locke & Bassett's step bands, as a share of each month's days. ${Math.round((over / days) * 100)} % of your days in this period reached 7,500 steps or more. A meta-analysis found mortality risk falling with steps up to about 6,000–8,000 a day at 60+ and 8,000–10,000 below 60 (Paluch et al. 2022).`,
      render: (el, w) => stackedBars(el, w, {
        rows: share, keys, yMax: 1, yFormat: (v) => `${Math.round(v * 100)}%`, tipValue: (v) => `${Math.round(v * 100)} %`,
        tipTitle: (r) => `${r.label} ${r.month.slice(0, 4)} · ${r.n} days`, title: 'Days by activity level',
      }),
      legend: keys.map((k) => ({ label: k.label, color: k.color })),
      table: () => ({ columns: [{ label: 'Month', get: (r) => r.month }, ...STEP_BANDS.map((b) => ({ label: b.label, get: (r) => r[b.key], r: true })), { label: 'Days', get: (r) => r.n, r: true }], rows: months.slice().reverse() }),
    });
    c.classList.add('span-7');
    grid.append(c);
  }
  const ra = restActivity(rows);
  if (ra) {
    const hour = (h0) => `${String(h0).padStart(2, '0')}:00`;
    const panel = h('div', { class: 'panel span-5', id: 'rest-activity' },
      h('h3', { class: 'chart-title', text: 'Rest–activity rhythm' }),
      h('p', { class: 'chart-sub', text: `Non-parametric rhythm analysis of your hourly steps over ${ra.days} days (Witting et al. 1990; Van Someren et al. 1999).` }),
      h('div', { class: 'tiles' },
        tile({ label: 'Interdaily stability', value: ra.is.toFixed(2), unit: '/ 1', color: 'var(--steps)', note: 'Same pattern every day = 1' }),
        tile({ label: 'Intradaily variability', value: ra.iv.toFixed(2), unit: '/ 2', color: 'var(--steps)', note: 'Higher = more broken up' }),
        tile({ label: 'Most active 10 h', value: hour(ra.m10Start), color: 'var(--steps)', note: `${fmtInt(ra.m10)} steps an hour` }),
        tile({ label: 'Quietest 5 h', value: hour(ra.l5Start), color: 'var(--steps)', note: ra.ra != null ? `Relative amplitude ${ra.ra.toFixed(2)}` : null })));
    grid.append(panel);
  }
  if (grid.children.length) out.push(section('Activity models', null, grid));
  return out;
}
