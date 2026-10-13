import { h, chartCard, section, compact, emptyState } from '../ui.js';
import { dial, calendarHeatmap, stackedBars, routeThumb } from '../charts.js';
import { tile, bucketColor, paceOrSpeed, workoutTitle, workoutWhen, distanceText, durationText, weeklySpark, dataSpan, oldImportNotice } from './common.js';
import { summarize, change, comparable, daySeries, weeklyVolume, workoutsIn, latestDate } from '../../lib/stats.js';
import { fmtInt, fmtHoursMinutes, fmtSleep, fmtKm, fmtDate, addDays } from '../../lib/format.js';
import { BUCKETS, BUCKET_LABELS } from '../../lib/huawei/sport-types.js';
import { BUCKET_COLOR } from '../ui.js';

export function renderOverview(root, ctx) {
  const { ds, range, prev, settings } = ctx;
  const cur = summarize(ds, range, settings);
  const old = summarize(ds, prev, settings);
  const rows = daySeries(ds, range);
  const cmp = comparable(cur, old);
  const delta = (a, b) => (cmp ? change(a, b) : null);

  // ---- hero: dial for the latest day + headline tiles
  const last = latestDate(ds);
  const lastDay = last ? ds.days[last] : null;
  const lastNight = last ? ds.nights[last] : null;
  const dialEl = h('div', { class: 'dial' });
  dial(dialEl, {
    value: lastDay?.steps ?? null,
    goal: settings.stepGoal,
    label: last ? `Steps · ${fmtDate(last, { short: true, weekday: true })}` : 'Steps',
    sub: `Goal ${fmtInt(settings.stepGoal)}${lastNight?.total ? ` · slept ${fmtSleep(lastNight.total)}` : ''}`,
    ring2: lastNight?.total ? { value: lastNight.total, goal: settings.sleepGoalMin, color: 'var(--sleep)' } : null,
  });
  const runKm = cur.byBucket.run.distance, rideKm = cur.byBucket.ride.distance, walkKm = cur.byBucket.walkhike.distance;
  const tiles = h('div', { class: 'tiles' },
    tile({ label: 'Average steps', value: cur.avgSteps == null ? '—' : fmtInt(cur.avgSteps), unit: '/day', delta: delta(cur.avgSteps, old.avgSteps), color: 'var(--steps)', spark: { values: weeklySpark(rows, 'steps'), color: 'var(--steps)' } }),
    tile({ label: 'Goal days', value: `${cur.goalDays}`, unit: `of ${cur.stepDays}`, delta: delta(cur.goalDays, old.goalDays), color: 'var(--steps)', note: `${fmtInt(settings.stepGoal)} steps or more` }),
    tile({ label: 'Workouts', value: fmtInt(cur.workouts), unit: fmtHoursMinutes(cur.workoutTime), delta: delta(cur.workouts, old.workouts), color: 'var(--run)' }),
    tile({ label: 'Distance', value: fmtKm(cur.workoutDistance, 0), unit: 'km', delta: delta(cur.workoutDistance, old.workoutDistance), color: 'var(--run)', note: `Run ${fmtKm(runKm, 0)} · Walk & hike ${fmtKm(walkKm, 0)} · Ride ${fmtKm(rideKm, 0)}` }),
    tile({ label: 'Resting heart rate', value: cur.restHr == null ? '—' : Math.round(cur.restHr), unit: 'bpm', delta: delta(cur.restHr, old.restHr), goodWhen: 'down', color: 'var(--heart)', spark: { values: weeklySpark(rows, 'restHr'), color: 'var(--heart)' } }),
    tile({ label: 'Average sleep', value: cur.sleepAvg == null ? '—' : fmtSleep(cur.sleepAvg), delta: delta(cur.sleepAvg, old.sleepAvg), color: 'var(--sleep)', note: cur.nights ? `${cur.nights} nights tracked` : null }),
  );
  const stale = oldImportNotice(ds);
  if (stale) root.append(stale);
  root.append(h('section', { class: 'section' }, h('div', { class: 'hero' }, dialEl, tiles),
    cmp ? null : h('p', { class: 'note muted', style: { margin: 0 }, text: 'Changes are hidden: the previous period of the same length has too little data to compare.' })));

  // ---- 12-month calendar
  const calTo = range.to;
  const calFrom = addDays(calTo, -364);
  const values = new Map(Object.values(ds.days).filter((d) => d.steps > 0).map((d) => [d.date, d.steps]));
  const marks = new Set(Object.values(ds.workouts).map((w) => w.date));
  const g = settings.stepGoal;
  const thresholds = [g * 0.4, g * 0.7, g, g * 1.4];
  root.append(chartCard({
    id: 'calendar',
    title: 'Steps calendar',
    sub: `Up to 12 months to ${fmtDate(calTo, { short: true })}. Darker means more steps; a dot marks a workout day. Goal ${fmtInt(g)}.`,
    render: (el, w) => calendarHeatmap(el, w, {
      from: calFrom, to: calTo, values, marks, thresholds, label: 'Daily steps calendar',
      tipRows: (date) => {
        const d = ds.days[date];
        const ws = Object.values(ds.workouts).filter((x) => x.date === date);
        return [
          { label: 'Steps', value: d?.steps != null ? fmtInt(d.steps) : '—', color: 'var(--steps)', kind: 'box' },
          ...ws.map((x) => ({ label: x.label, value: distanceText(x) !== '—' ? distanceText(x) : durationText(x), color: bucketColor(x.family) })),
        ];
      },
      onClick: (date) => ctx.actions.focusDay(date),
    }),
    legend: [
      { label: `< ${compact(thresholds[0])}`, color: 'var(--heat-0)' },
      { label: `${compact(thresholds[0])}–${compact(thresholds[1])}`, color: 'var(--heat-1)' },
      { label: `${compact(thresholds[1])}–${compact(g)}`, color: 'var(--heat-2)' },
      { label: `${compact(g)}–${compact(thresholds[3])}`, color: 'var(--heat-3)' },
      { label: `${compact(thresholds[3])}+`, color: 'var(--heat-4)' },
      { label: 'No data', color: 'var(--surface-2)' },
    ],
    table: () => ({
      columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Steps', get: (r) => fmtInt(r.steps), r: true }],
      rows: [...values.entries()].filter(([d]) => d >= calFrom && d <= calTo).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, steps]) => ({ date, steps })),
    }),
  }));

  // ---- weekly volume + recent workouts
  const vol = weeklyVolume(ds, range, 'duration');
  const keys = BUCKETS.map((b) => ({ key: b, label: BUCKET_LABELS[b], color: BUCKET_COLOR[b] }));
  const grid = h('div', { class: 'grid' });
  const volCard = chartCard({
    id: 'weekly-volume',
    title: 'Training time per week',
    sub: 'Workout duration, stacked by sport',
    render: (el, w) => stackedBars(el, w, {
      rows: vol.map((r) => ({ ...r, key: r.week, label: fmtDate(r.week, { short: true }) })),
      keys: keys.map((k) => ({ ...k, key: k.key })),
      yFormat: (v) => `${Math.round(v / 3600)}h`, tickUnit: 3600,
      tipValue: (v) => fmtHoursMinutes(v),
      tipTitle: (r) => `Week of ${fmtDate(r.week)}`,
      title: 'Training time per week',
    }),
    legend: keys.map((k) => ({ label: k.label, color: k.color })),
    table: () => ({
      columns: [{ label: 'Week of', get: (r) => fmtDate(r.week) }, ...keys.map((k) => ({ label: k.label, get: (r) => (r[k.key] ? fmtHoursMinutes(r[k.key]) : '—'), r: true }))],
      rows: vol.slice().reverse(),
    }),
  });
  volCard.classList.add('span-7');
  grid.append(volCard);

  const recent = workoutsIn(ds, range).slice(-6).reverse();
  const list = h('div', { class: 'panel span-5' },
    h('div', { class: 'section-head' }, h('h3', { class: 'chart-title', text: 'Latest workouts' }),
      h('a', { href: '#workouts', class: 'btn', style: { padding: '3px 10px', fontSize: '12px' } }, 'All workouts')));
  const span = recent.length ? null : dataSpan(Object.values(ds.workouts).map((w) => w.date));
  if (span) {
    list.append(h('p', { class: 'muted', text: `No workouts in this period. Yours run from ${fmtDate(span.from)} to ${fmtDate(span.to)}.` }),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.showRange(span.from, span.to) }, 'Show that period'));
  } else if (!recent.length) list.append(h('p', { class: 'muted', text: 'No workouts in this period.' }));
  else {
    const tb = h('tbody');
    for (const w of recent) {
      const ps = paceOrSpeed(w);
      tb.append(h('tr', { class: 'clickable', tabindex: '0', onclick: () => ctx.actions.openWorkout(w.id), onkeydown: (e) => { if (e.key === 'Enter') ctx.actions.openWorkout(w.id); } },
        h('td', null, routeThumb(w.thumb, bucketColor(w.family))),
        h('td', null, h('div', { style: { fontWeight: 600 }, text: workoutTitle(w) }), h('div', { class: 'muted', style: { fontSize: '12px' }, text: workoutWhen(w) })),
        h('td', { class: 'r' }, h('div', { text: distanceText(w) }), h('div', { class: 'muted', style: { fontSize: '12px' }, text: `${durationText(w)}${ps.value !== '—' ? ` · ${ps.value} ${ps.unit}` : ''}` }))));
    }
    list.append(h('div', { class: 'table-wrap', style: { border: 0 } }, h('table', { class: 'wlist' }, tb)));
  }
  grid.append(list);
  root.append(section('This period', null, grid));

  if (!Object.keys(ds.workouts).length && !Object.keys(ds.days).length) {
    root.append(emptyState('No data yet', 'Import your Huawei export from the Data tab to fill the logbook.', h('a', { class: 'btn primary', href: '#data' }, 'Import data')));
  }
}
