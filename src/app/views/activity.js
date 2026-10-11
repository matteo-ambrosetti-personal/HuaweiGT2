import { h, chartCard, section } from '../ui.js';
import { dailyBars, columns } from '../charts.js';
import { tile } from './common.js';
import { daySeries, rollingMean, weekdayProfile, hourProfile, streaks, stepBests, summarize, change, comparable } from '../../lib/stats.js';
import { fmtInt, fmtDate, fmtOne, weekdayName } from '../../lib/format.js';

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
}
