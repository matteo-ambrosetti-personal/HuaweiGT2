import { h, chartCard, section, clear, emptyState } from '../ui.js';
import { stackedBars, rangeBars, columns, hypnogram, lineChart } from '../charts.js';
import { tile, emptyElsewhere } from './common.js';
import { nightsIn, sleepSummary, previousRange, eachDate, bedMinute, weekdayProfile, change } from '../../lib/stats.js';
import { fmtSleep, fmtDate, fmtMinuteOfDay, weekdayName, localMinuteOfDay, fmtClock } from '../../lib/format.js';

const STAGES = [
  { key: 'deep', label: 'Deep', color: 'var(--deep)' },
  { key: 'light', label: 'Light', color: 'var(--light)' },
  { key: 'rem', label: 'REM', color: 'var(--rem)' },
  { key: 'awake', label: 'Awake', color: 'var(--awake)' },
];

export function renderSleep(root, ctx) {
  const { ds, range, settings } = ctx;
  const nights = nightsIn(ds, range);
  const s = sleepSummary(nights);
  const p = sleepSummary(nightsIn(ds, previousRange(range)));
  if (!nights.length) {
    root.append(emptyElsewhere(ctx, {
      title: 'No sleep in this period',
      dates: Object.keys(ds.nights),
      span: (a, b) => `Your recorded nights run from ${a} to ${b}.`,
      one: (a) => `Your only recorded night is ${a}.`,
    }) || emptyState('No sleep in this period', 'Sleep appears here once your export includes TruSleep data. Try a longer period.'));
    return;
  }
  const cmp = p.nights > 0 && p.nights >= 0.8 * s.nights;
  const delta = (a, b) => (cmp ? change(a, b) : null);
  const pct = (a) => (a == null || !s.avgTotal ? '—' : `${Math.round((a / s.avgTotal) * 100)}%`);
  root.append(h('div', { class: 'tiles' },
    tile({ label: 'Average sleep', value: fmtSleep(s.avgTotal), delta: delta(s.avgTotal, p.avgTotal), color: 'var(--sleep)', note: `${s.nights} nights` }),
    tile({ label: 'Deep sleep', value: pct(s.avgDeep), unit: s.avgDeep ? `· ${fmtSleep(s.avgDeep)}` : '', color: 'var(--deep)', note: 'Share of time asleep' }),
    tile({ label: 'REM sleep', value: pct(s.avgRem), unit: s.avgRem ? `· ${fmtSleep(s.avgRem)}` : '', color: 'var(--rem)' }),
    tile({ label: 'Usual bedtime', value: fmtMinuteOfDay(s.avgStart), color: 'var(--sleep)', note: s.startSpread != null ? `Varies by ±${Math.round(s.startSpread)} min` : null }),
    tile({ label: 'Usual wake-up', value: fmtMinuteOfDay(s.avgEnd), color: 'var(--sleep)' }),
    tile({ label: 'Sleep score', value: s.avgScore == null ? '—' : Math.round(s.avgScore), unit: s.avgScore == null ? '' : '/100', delta: delta(s.avgScore, p.avgScore), color: 'var(--sleep)', note: s.avgScore == null ? 'Not in your export' : null }),
  ));

  const byDate = new Map(nights.map((n) => [n.date, n]));
  const dates = eachDate(range.from, range.to);
  const rows = dates.map((d) => {
    const n = byDate.get(d);
    return { key: d, date: d, label: fmtDate(d, { short: true }), deep: n?.deep || 0, light: n?.light || 0, rem: n?.rem || 0, awake: n?.awake || 0, total: n?.total, onlyTotal: n && n.deep == null ? n.total : 0 };
  });
  const hasStages = nights.some((n) => n.deep != null);
  const keys = hasStages ? STAGES : [{ key: 'onlyTotal', label: 'Asleep', color: 'var(--sleep)' }];
  const detail = h('div');
  const showNight = (date) => {
    clear(detail);
    const n = byDate.get(date) || nights.at(-1);
    if (!n) return;
    detail.append(chartCard({
      id: 'hypnogram',
      title: `Night to ${fmtDate(n.date, { weekday: true })}`,
      sub: [n.start ? `Asleep ${fmtClock(n.start, n.tz)}` : null, n.end ? `woke ${fmtClock(n.end, n.tz)}` : null, n.total ? `${fmtSleep(n.total)} asleep` : null, n.score ? `score ${n.score}` : null].filter(Boolean).join(' · '),
      render: (el, w) => hypnogram(el, w, { stages: n.stages, start: n.start, tz: n.tz }),
      legend: STAGES.map((st) => ({ label: st.label, color: st.color })),
      table: () => ({
        columns: [{ label: 'Stage', get: (r) => STAGES.find((x) => x.key === r.k)?.label }, { label: 'Minutes', get: (r) => r.v ?? '—', r: true }],
        rows: STAGES.map((st) => ({ k: st.key, v: n[st.key] })),
      }),
    }));
  };
  root.append(chartCard({
    id: 'nightly-sleep',
    title: 'Sleep per night',
    sub: `Stacked by stage; goal ${fmtSleep(settings.sleepGoalMin)}. Select a night to see its stages.`,
    render: (el, w) => stackedBars(el, w, {
      rows, keys, goal: settings.sleepGoalMin, goalLabel: `Goal ${fmtSleep(settings.sleepGoalMin)}`,
      yFormat: (v) => `${Math.round(v / 60)}h`, tickUnit: 60, tipValue: (v) => fmtSleep(v),
      tipTitle: (r) => `Night to ${fmtDate(r.date, { weekday: true })}${r.total ? ` · ${fmtSleep(r.total)}` : ''}`,
      title: 'Sleep per night', onClick: (r) => showNight(r.date),
    }),
    legend: keys.map((k) => ({ label: k.label, color: k.color })),
    table: () => ({
      columns: [
        { label: 'Night to', get: (r) => fmtDate(r.date, { weekday: true }) },
        { label: 'Asleep', get: (r) => (r.total ? fmtSleep(r.total) : '—'), r: true },
        ...STAGES.map((st) => ({ label: st.label, get: (r) => (r[st.key] ? fmtSleep(r[st.key]) : '—'), r: true })),
        { label: 'Score', get: (r) => byDate.get(r.date)?.score ?? '—', r: true },
      ],
      rows: rows.filter((r) => r.total).reverse(),
    }),
  }));
  root.append(detail);
  showNight(nights.at(-1).date);

  const grid = h('div', { class: 'grid' });
  const bw = rows.map((r) => {
    const n = byDate.get(r.date);
    return { date: r.date, start: n?.start ? bedMinute(n.start, n.tz) : null, end: n?.end ? localMinuteOfDay(n.end, n.tz) : null };
  });
  const bwCard = chartCard({
    id: 'bed-wake',
    title: 'Bedtime and wake-up',
    sub: 'Each bar runs from falling asleep to waking',
    render: (el, w) => rangeBars(el, w, { rows: bw, color: 'var(--sleep)', title: 'Bedtime and wake-up' }),
    table: () => ({
      columns: [{ label: 'Night to', get: (r) => r.date }, { label: 'Asleep', get: (r) => fmtMinuteOfDay(r.start) }, { label: 'Woke', get: (r) => fmtMinuteOfDay(r.end) }],
      rows: bw.filter((r) => r.start != null).reverse(),
    }),
  });
  bwCard.classList.add('span-7');
  const wd = weekdayProfile(nights.map((n) => ({ date: n.date, total: n.total })), 'total');
  const wdCard = chartCard({
    id: 'sleep-weekday',
    title: 'Sleep by wake-up day',
    render: (el, w) => columns(el, w, { rows: wd.map((v, i) => ({ label: weekdayName(i), value: v })), color: 'var(--sleep)', valueLabel: 'Average sleep', yFormat: (v) => `${Math.round(v / 60)}h`, tickUnit: 60, tipFormat: (v) => fmtSleep(v) }),
    table: () => ({ columns: [{ label: 'Day', get: (r) => r.label }, { label: 'Average', get: (r) => (r.value ? fmtSleep(r.value) : '—'), r: true }], rows: wd.map((v, i) => ({ label: weekdayName(i), value: v })) }),
  });
  wdCard.classList.add('span-5');
  grid.append(bwCard, wdCard);
  root.append(section('Rhythm', null, grid));

  if (nights.some((n) => n.score)) {
    root.append(chartCard({
      id: 'sleep-score',
      title: 'Sleep score',
      render: (el, w) => lineChart(el, w, {
        series: [{ key: 'score', label: 'Score', color: 'var(--sleep)', points: nights.filter((n) => n.score).map((n) => ({ x: new Date(n.date + 'T00:00:00Z'), y: n.score })), dots: nights.length < 60 }],
        yFormat: (v) => String(Math.round(v)), title: 'Sleep score',
      }),
      table: () => ({ columns: [{ label: 'Night to', get: (r) => r.date }, { label: 'Score', get: (r) => r.score, r: true }], rows: nights.filter((n) => n.score).reverse() }),
    }));
  }
}
