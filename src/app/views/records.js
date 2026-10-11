/* global d3 */
import { h, chartCard, section, emptyState } from '../ui.js';
import { lineChart } from '../charts.js';
import { personalRecords, yearSummary, cumulativeByYear, streaks, stepBests } from '../../lib/stats.js';
import { fmtDuration, fmtDate, fmtInt, fmtKm, fmtSleep, fmtPace, fmtHoursMinutes } from '../../lib/format.js';
import { BUCKET_LABELS } from '../../lib/huawei/sport-types.js';
import { workoutTitle } from './common.js';

export function renderRecords(root, ctx) {
  const { ds, settings } = ctx;
  if (!Object.keys(ds.workouts).length && !Object.keys(ds.days).length) {
    root.append(emptyState('No records yet', 'Records appear after your first import.'));
    return;
  }
  const pr = personalRecords(ds);
  const st = streaks(ds, settings.stepGoal);
  const best = stepBests(ds);
  const link = (w, text) => (w ? h('a', { href: `#workout-${encodeURIComponent(w.id)}`, onclick: (e) => { e.preventDefault(); ctx.actions.openWorkout(w.id); } }, text) : '—');

  // best efforts
  const tb = h('tbody');
  for (const e of pr.efforts) {
    const w = e.best ? ds.workouts[e.best.id] : null;
    tb.append(h('tr', null,
      h('td', { text: e.label }),
      h('td', { class: 'r', style: { fontWeight: 600 }, text: e.best ? fmtDuration(e.best.time) : '—' }),
      h('td', { class: 'r', text: e.best ? `${fmtPace(e.best.time / (e.metres / 1000))} /km` : '—' }),
      h('td', null, e.best ? link(w, fmtDate(e.best.date)) : h('span', { class: 'muted', text: 'Not run yet' }))));
  }
  const efforts = h('div', { class: 'panel span-6' },
    h('h3', { class: 'chart-title', text: 'Fastest running efforts' }),
    h('p', { class: 'chart-sub', text: 'Best time over each distance inside any GPS-tracked run' }),
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', { text: 'Distance' }), h('th', { class: 'r', text: 'Time' }), h('th', { class: 'r', text: 'Pace' }), h('th', { text: 'When' }))), tb)));

  const items = [
    ['Longest run', pr.longest.run, (w) => `${fmtKm(w.distance)} km`],
    ['Longest walk or hike', pr.longest.walkhike, (w) => `${fmtKm(w.distance)} km`],
    ['Longest ride', pr.longest.ride, (w) => `${fmtKm(w.distance)} km`],
    ['Biggest climb', pr.biggestClimb, (w) => `${Math.round(w.ascent)} m`],
    ['Fastest run (3 km+)', pr.fastestRun, (w) => `${fmtPace(w.avgPace)} /km`],
  ];
  const tb2 = h('tbody');
  for (const [label, w, fmt] of items) {
    tb2.append(h('tr', null, h('td', { text: label }), h('td', { class: 'r', style: { fontWeight: 600 }, text: w ? fmt(w) : '—' }), h('td', null, w ? link(w, `${workoutTitle(w)} · ${fmtDate(w.date)}`) : '—')));
  }
  tb2.append(h('tr', null, h('td', { text: 'Most steps in a day' }), h('td', { class: 'r', style: { fontWeight: 600 }, text: best.day ? fmtInt(best.day.steps) : '—' }), h('td', { text: best.day ? fmtDate(best.day.date) : '—' })));
  tb2.append(h('tr', null, h('td', { text: 'Best week of steps' }), h('td', { class: 'r', style: { fontWeight: 600 }, text: best.week ? fmtInt(best.week.steps) : '—' }), h('td', { text: best.week ? `Week of ${fmtDate(best.week.key)}` : '—' })));
  tb2.append(h('tr', null, h('td', { text: 'Longest goal streak' }), h('td', { class: 'r', style: { fontWeight: 600 }, text: `${st.longest} days` }), h('td', { text: st.longestEnd ? `Ended ${fmtDate(st.longestEnd)}` : '—' })));
  const bests = h('div', { class: 'panel span-6' },
    h('h3', { class: 'chart-title', text: 'Personal bests' }),
    h('p', { class: 'chart-sub', text: 'Across your whole history' }),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', { text: 'Record' }), h('th', { class: 'r', text: 'Value' }), h('th', { text: 'Where' }))), tb2)));
  root.append(section('Records', null, h('div', { class: 'grid' }, efforts, bests)));

  // year in review
  const years = yearSummary(ds);
  const ty = h('tbody');
  for (const y of years) {
    ty.append(h('tr', null,
      h('td', { style: { fontWeight: 600 }, text: y.year }),
      h('td', { class: 'r', text: fmtInt(y.workouts) }),
      h('td', { class: 'r', text: fmtHoursMinutes(y.time) }),
      h('td', { class: 'r', text: y.run ? `${fmtKm(y.run, 0)} km` : '—' }),
      h('td', { class: 'r', text: y.walkhike ? `${fmtKm(y.walkhike, 0)} km` : '—' }),
      h('td', { class: 'r', text: y.ride ? `${fmtKm(y.ride, 0)} km` : '—' }),
      h('td', { class: 'r', text: y.avgSteps ? fmtInt(y.avgSteps) : '—' }),
      h('td', { class: 'r', text: y.avgSleep ? fmtSleep(y.avgSleep) : '—' })));
  }
  root.append(section('Year by year', null, h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, ...['Year', 'Workouts', 'Time', BUCKET_LABELS.run, BUCKET_LABELS.walkhike, BUCKET_LABELS.ride, 'Avg steps', 'Avg sleep'].map((t, i) => h('th', { class: i ? 'r' : null, text: t })))), ty))));

  const cum = cumulativeByYear(ds);
  const yearKeys = Object.keys(cum).sort();
  if (yearKeys.length) {
    const current = yearKeys.at(-1);
    const base = new Date(Date.UTC(2000, 0, 1)); // leap year so day 366 fits
    const series = yearKeys.map((y) => ({
      key: y,
      label: y,
      color: y === current ? 'var(--accent)' : 'var(--other)',
      width: y === current ? 2.5 : 1.5,
      opacity: y === current ? 1 : 0.7,
      endLabel: y === current,
      curve: 'step',
      points: cum[y].map((p) => ({ x: new Date(+base + p.doy * 864e5), y: p.km })),
    }));
    root.append(chartCard({
      id: 'cumulative',
      title: 'Distance through the year',
      sub: `Cumulative workout kilometres by day of year; ${current} is highlighted`,
      render: (el, w) => lineChart(el, w, {
        series, yFormat: (v) => `${Math.round(v)}`, tipFormat: (v) => `${Math.round(v)} km`, zeroBased: true, height: 260,
        xFormat: (d) => d3.utcFormat('%b')(d), title: 'Distance through the year',
      }),
      legend: [{ label: current, color: 'var(--accent)', kind: 'line' }, ...(yearKeys.length > 1 ? [{ label: 'Earlier years', color: 'var(--other)', kind: 'line' }] : [])],
      table: () => ({ columns: [{ label: 'Year', get: (r) => r.year }, { label: 'Total km', get: (r) => Math.round(r.km), r: true }], rows: yearKeys.map((y) => ({ year: y, km: cum[y].at(-1).km })).reverse() }),
    }));
  }
}
