/* global d3 */
import { h, chartCard, section, clear, emptyState } from '../ui.js';
import { stackedBars, rangeBars, columns, hypnogram, lineChart } from '../charts.js';
import { tile, emptyElsewhere } from './common.js';
import { nightsIn, sleepSummary, previousRange, eachDate, bedMinute, weekdayProfile, change } from '../../lib/stats.js';
import { fmtSleep, fmtDate, fmtMinuteOfDay, weekdayName, localMinuteOfDay, fmtClock, addDays } from '../../lib/format.js';
import { twoProcess, socialJetlag, sleepRegularity, weeklyRegularity } from '../../lib/models/sleep.js';

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

  root.append(...sleepScience(ctx, nights));

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

const hm = (min) => {
  const m = Math.round(Math.abs(min));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
};

/** Models of sleep: the two-process model, social jetlag and chronotype, sleep balance and regularity. */
function sleepScience(ctx, nights) {
  const { ds, settings, range } = ctx;
  const out = [];
  const j = socialJetlag(nights);
  const sri = sleepRegularity(nights);
  const tiles = h('div', { class: 'tiles' },
    tile({ label: 'Social jetlag', value: j ? hm(j.jetlag) : '—', color: 'var(--sleep)', note: j ? `Weekend mid-sleep ${j.signed >= 0 ? 'later' : 'earlier'} than workdays` : 'Needs 3 workday and 2 weekend nights' }),
    tile({ label: 'Mid-sleep, workdays', value: j ? fmtMinuteOfDay(j.msw) : '—', color: 'var(--sleep)', note: j ? `Free days ${fmtMinuteOfDay(j.msf)}` : null }),
    tile({ label: 'Chronotype (MSFsc)', value: j ? fmtMinuteOfDay(j.msfsc) : '—', color: 'var(--sleep)', note: j ? (j.msfsc < 180 ? 'Earlier than most adults' : j.msfsc > 300 ? 'Later than most adults' : 'Around the adult middle (03:00–05:00)') : null }),
    tile({ label: 'Sleep regularity', value: sri ? String(sri.sri) : '—', unit: sri ? '/100' : '', color: 'var(--sleep)', note: sri ? `Index of Phillips et al., ${sri.pairs} night pairs` : 'Needs 3 pairs of consecutive nights' }),
  );
  out.push(section('Sleep science', 'Chronobiology models applied to your nights', tiles,
    h('p', { class: 'note muted', style: { margin: 0, fontSize: '12px' }, text: 'Social jetlag and chronotype follow the Munich ChronoType Questionnaire (Wittmann et al. 2006; Roenneberg et al. 2012): free days are nights before Saturday and Sunday, and MSFsc corrects weekend mid-sleep for catch-up sleep. Regularity is the chance of being in the same state, asleep or awake, 24 hours apart (Phillips et al. 2017).' })));

  // ---- two-process model over the last 10 nights of the period
  const withTimes = Object.values(ds.nights).filter((n) => n.start && n.end && n.date <= range.to).sort((a, b) => (a.date < b.date ? -1 : 1));
  const recent = nights.filter((n) => n.start && n.end).slice(-10);
  // Three earlier nights let the simulated pressure settle before the first night shown.
  const tp = recent.length >= 3 ? twoProcess(withTimes.slice(Math.max(0, withTimes.indexOf(recent[0]) - 3), withTimes.indexOf(recent.at(-1)) + 1)) : null;
  const grid = h('div', { class: 'grid' });
  if (tp) {
    const shown = tp.series.filter((p) => p.t >= recent[0].start - 12 * 3600000);
    const x = (p) => new Date(p.t + (recent.at(-1).tz ?? 0) * 60000);
    const spans = recent.map((n) => ({ from: new Date(n.start + (n.tz ?? 0) * 60000), to: new Date(n.end + (n.tz ?? 0) * 60000) }));
    const c = chartCard({
      id: 'two-process',
      title: 'Sleep pressure (two-process model)',
      sub: 'Borbély\'s model run on your actual bed and wake times. Sleep pressure (S) builds while you are awake and drains while you sleep (shaded). You tend to fall asleep when S meets the upper circadian threshold and wake when it falls to the lower one. Waking with S well above the lower line means pressure was not fully discharged.',
      render: (el, w) => lineChart(el, w, {
        series: [
          { key: 's', label: 'Sleep pressure S', color: 'var(--sleep)', points: shown.map((p) => ({ x: x(p), y: p.s })) },
          { key: 'hi', label: 'Upper threshold', color: 'var(--ink-2)', width: 1, opacity: 0.6, points: shown.map((p) => ({ x: x(p), y: p.hi })) },
          { key: 'lo', label: 'Lower threshold', color: 'var(--ink-2)', width: 1, opacity: 0.6, points: shown.map((p) => ({ x: x(p), y: p.lo })) },
        ],
        spans, spanColor: 'var(--sleep)', yDomain: [0, 1], yFormat: (v) => v.toFixed(1), tipFormat: (v) => v.toFixed(2), height: 240,
        title: 'Sleep pressure', tipTitle: (d) => d3.utcFormat('%a %d %b, %H:%M')(d),
      }),
      legend: [{ label: 'Sleep pressure S', color: 'var(--sleep)', kind: 'line' }, { label: 'Circadian thresholds', color: 'var(--ink-2)', kind: 'line' }, { label: 'Asleep', color: 'color-mix(in srgb, var(--sleep) 20%, transparent)' }],
      table: () => ({
        columns: [{ label: 'Night to', get: (n) => fmtDate(n.date, { weekday: true }) }, { label: 'S at sleep onset', get: (n) => (n.sOnset ?? 0).toFixed(2), r: true }, { label: 'Threshold', get: (n) => (n.hiOnset ?? 0).toFixed(2), r: true }, { label: 'S at wake-up', get: (n) => (n.sWake ?? 0).toFixed(2), r: true }],
        rows: tp.nights.filter((n) => n.date >= recent[0].date).reverse(),
      }),
    });
    c.classList.add('span-12');
    grid.append(c);
  }

  // ---- sleep balance and weekly regularity over the period
  const all = Object.values(ds.nights).sort((a, b) => (a.date < b.date ? -1 : 1));
  const bal = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    const week = all.filter((n) => n.date > addDays(d, -7) && n.date <= d && n.total > 0);
    if (week.length >= 4) bal.push({ date: d, v: (week.reduce((t, n) => t + n.total, 0) / week.length - settings.sleepGoalMin) * 7 / 60 });
  }
  if (bal.length > 1) {
    const c = chartCard({
      id: 'sleep-balance',
      title: 'Sleep balance, last 7 nights',
      sub: `Hours over or under your ${fmtSleep(settings.sleepGoalMin)} goal across the previous week. Losses add up (Van Dongen et al. 2003).`,
      render: (el, w) => lineChart(el, w, {
        series: [{ key: 'b', label: 'Balance', color: 'var(--sleep)', points: bal.map((r) => ({ x: new Date(`${r.date}T00:00:00Z`), y: r.v })) }],
        refLines: [{ y: 0, label: 'Goal' }], yFormat: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}h`, tipFormat: (v) => `${v > 0 ? '+' : '−'}${hm(v * 60)}`, title: 'Sleep balance',
      }),
      table: () => ({ columns: [{ label: 'Date', get: (r) => r.date }, { label: 'Balance', get: (r) => `${r.v > 0 ? '+' : '−'}${hm(r.v * 60)}`, r: true }], rows: bal.slice().reverse() }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  const wsri = weeklyRegularity(nights);
  if (wsri.length > 1) {
    const c = chartCard({
      id: 'sleep-regularity',
      title: 'Sleep regularity by week',
      sub: 'Sleep Regularity Index per week (−100 to 100). Higher is more regular; in UK Biobank it predicted mortality risk more strongly than sleep duration (Windred et al. 2024).',
      render: (el, w) => lineChart(el, w, {
        series: [{ key: 'sri', label: 'SRI', color: 'var(--sleep)', points: wsri.map((r) => ({ x: new Date(`${r.week}T00:00:00Z`), y: r.sri })), dots: true }],
        yFormat: (v) => String(Math.round(v)), title: 'Sleep regularity',
      }),
      table: () => ({ columns: [{ label: 'Week of', get: (r) => fmtDate(r.week) }, { label: 'SRI', get: (r) => r.sri, r: true }, { label: 'Night pairs', get: (r) => r.pairs, r: true }], rows: wsri.slice().reverse() }),
    });
    c.classList.add('span-6');
    grid.append(c);
  }
  if (grid.children.length) out.push(grid);
  return out;
}
