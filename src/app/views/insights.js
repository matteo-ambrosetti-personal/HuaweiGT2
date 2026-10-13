// Insights: what the literature models say about your latest weeks — a
// recovery summary, insight cards with their sources, and what moves
// together in your own data.

import { h, chartCard, section, emptyState, renderTable } from '../ui.js';
import { corrMatrix } from '../charts-models.js';
import { tile } from './common.js';
import { analyze, insights } from '../../lib/models/insights.js';
import { formZone, acwrZone } from '../../lib/models/load.js';
import { strength } from '../../lib/models/correlate.js';
import { fmtDate, fmtSleep } from '../../lib/format.js';

const TONE_LABEL = { watch: 'Worth a look', good: 'Going well', info: 'Good to know' };
const sign = (v, d = 0) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);

export function renderInsights(root, ctx) {
  const { ds, settings } = ctx;
  if (!Object.keys(ds.days).length && !Object.keys(ds.workouts).length) {
    root.append(emptyState('No insights yet', 'Insights appear once your data is imported.', h('a', { class: 'btn primary', href: '#data' }, 'Import data')));
    return;
  }
  const a = analyze(ds, settings);
  const cards = insights(a, settings);

  // ---- summary
  const hero = h('div', { class: 'hero' }, readinessPanel(a), summaryTiles(a, settings));
  root.append(h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { text: `Where you stand · ${fmtDate(a.last, { weekday: true })}` }),
      h('p', { class: 'note', text: 'From your latest data. Each number comes from a published model; tap a card\'s source to see which.' })),
    hero));

  // ---- insight cards
  const feed = h('div', { class: 'insight-feed' });
  for (const tone of ['watch', 'good', 'info']) {
    const list = cards.filter((c) => c.tone === tone);
    if (!list.length) continue;
    feed.append(h('h3', { class: 'feed-head', text: TONE_LABEL[tone] }));
    for (const c of list) {
      feed.append(h('article', { class: `insight ${c.tone}` },
        h('div', { class: 'insight-top' }, h('span', { class: `badge tone-${c.tone}`, text: c.area }), h('h4', { text: c.title })),
        h('p', { text: c.text }),
        h('p', { class: 'cite', text: `Source: ${c.cite}` })));
    }
  }
  if (!cards.length) feed.append(h('p', { class: 'muted', text: 'Not enough data yet for the models. A few weeks of workouts, sleep and heart rate fill this in.' }));
  root.append(section('What the models say', ctx.isSample ? 'Computed from the sample data.' : null, feed));

  // ---- correlations
  const corr = a.corr;
  if (corr.keys.length >= 3) {
    const grid = h('div', { class: 'grid' });
    const mat = chartCard({
      id: 'corr-matrix',
      title: 'What moves together (same day)',
      sub: `Spearman correlations over the last 12 months. Warm = rise together, cool = one up, other down. Numbers show only where the link survives a false-discovery-rate cut of 10 %.`,
      render: (el, w) => corrMatrix(el, w, { keys: corr.keys, labels: corr.labels, cells: corr.cells }),
      legend: [
        { label: 'Positive ρ', color: 'var(--div-warm)' },
        { label: 'None', color: 'var(--div-mid)' },
        { label: 'Negative ρ', color: 'var(--div-cool)' },
      ],
      table: () => ({
        columns: [
          { label: 'Pair', get: (c) => `${corr.labels[c.a]} × ${corr.labels[c.b]}` },
          { label: 'ρ', get: (c) => c.rho.toFixed(2), r: true },
          { label: 'Days', get: (c) => c.n, r: true },
          { label: 'q', get: (c) => (c.q < 0.001 ? '< 0.001' : c.q.toFixed(3)), r: true },
        ],
        rows: corr.cells.slice().sort((x, y) => Math.abs(y.rho) - Math.abs(x.rho)),
      }),
    });
    mat.classList.add('span-6');
    const lagWrap = h('div', { class: 'table-wrap' });
    renderTable(lagWrap, {
      columns: [
        { label: 'Today', get: (c) => corr.labels[c.a] },
        { label: 'Tomorrow', get: (c) => corr.labels[c.b] },
        { label: 'ρ', get: (c) => c.rho.toFixed(2).replace('-', '−'), r: true },
        { label: 'Link', get: (c) => (c.q < 0.1 ? strength(c.rho) : '—') },
      ],
      rows: corr.lagged.slice().sort((x, y) => Math.abs(y.rho) - Math.abs(x.rho)),
    });
    const lag = h('div', { class: 'panel span-6' },
      h('h3', { class: 'chart-title', text: 'Next-day effects' }),
      h('p', { class: 'chart-sub', text: `Does today change tomorrow? Sleep is the night after the day; resting HR and HRV are the next morning. Over ${corr.lagged[0]?.n ?? 0} days; a dash means the link does not pass the false-discovery cut.` }),
      lagWrap);
    grid.append(mat, lag);
    root.append(section('Patterns in your data', 'Correlation is not cause: a cold can shorten sleep and raise resting HR at once.', grid));
  }

  root.append(methods());
}

function readinessPanel(a) {
  const r = a.ready;
  const panel = h('div', { class: 'panel readiness', id: 'readiness' });
  if (!r) {
    panel.append(h('h3', { class: 'chart-title', text: 'Recovery' }), h('p', { class: 'muted', text: 'Needs a few weeks of heart rate, HRV or sleep.' }));
    return panel;
  }
  const word = r.score >= 60 ? 'Well recovered' : r.score >= 40 ? 'Normal' : 'Strained';
  panel.append(
    h('div', { class: 'label', text: 'Recovery summary' }),
    h('div', { class: 'ready-score' }, String(r.score), h('small', { text: '/100' })),
    h('div', { class: 'ready-word', text: word }),
    h('div', { class: 'meter', role: 'img', 'aria-label': `Recovery ${r.score} of 100` }, h('div', { style: { width: `${r.score}%` } })),
    h('ul', { class: 'ready-parts' }, r.parts.map((p) => h('li', null,
      h('span', { class: 'k', text: p.label }),
      h('span', { class: 'div-bar', 'aria-label': `${Math.round(p.value * 100)}` },
        h('span', { class: p.value >= 0 ? 'pos' : 'neg', style: { width: `${Math.abs(p.value) * 50}%`, [p.value >= 0 ? 'left' : 'right']: '50%' } }))))),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '8px 0 0' }, text: 'The average of the markers listed, each scaled against your own baseline. A summary, not a validated score.' }));
  return panel;
}

function summaryTiles(a, settings) {
  const s = a.snap;
  const fz = s && !s.warmup ? formZone(s.tsb) : null;
  const az = acwrZone(s?.acwr);
  const hv = a.hrvNow, rn = a.restNow;
  return h('div', { class: 'tiles' },
    tile({ label: 'Form (TSB)', value: s ? sign(s.tsb) : '—', color: 'var(--div-cool)', note: fz ? fz.label : s ? 'Warming up' : 'No workouts with heart rate' }),
    tile({ label: 'Fitness (CTL)', value: s ? Math.round(s.ctl) : '—', unit: s?.ctlChange != null ? `${sign(s.ctlChange, 1)} /wk` : '', color: 'var(--ink)', note: 'Banister 42-day load' }),
    tile({ label: 'Acute:chronic', value: s?.acwr != null ? s.acwr.toFixed(2) : '—', color: 'var(--div-warm)', note: az ? az.label : 'Needs 4 weeks' }),
    tile({ label: 'HRV, 7 days', value: hv?.week != null ? Math.round(Math.exp(hv.week)) : '—', unit: hv?.week != null ? 'ms' : '', color: 'var(--heart)', note: hv?.base != null ? `Normal ${Math.round(Math.exp(hv.lo))}–${Math.round(Math.exp(hv.hi))} ms` : 'Needs 2 weeks of HRV' }),
    tile({ label: 'Resting HR vs usual', value: rn?.delta != null ? sign(rn.delta) : '—', unit: rn?.delta != null ? 'bpm' : '', color: 'var(--heart)', note: rn?.base != null ? `Usual ${Math.round(rn.base)} bpm` : 'Needs 10 days' }),
    tile({ label: 'Sleep, last 7 nights', value: a.balance ? sign(a.balance.balance / 60, 1) : '—', unit: a.balance ? 'h vs goal' : '', color: 'var(--sleep)', note: a.balance ? `Average ${fmtSleep(a.balance.avg)}, goal ${fmtSleep(settings.sleepGoalMin)}` : 'Needs 4 nights' }),
  );
}

const REFS = [
  ['Training load', 'Banister EW et al. (1975) A systems model of training for athletic performance. Aust J Sports Med 7:57–61 · Banister EW (1991) Modeling elite athletic performance. In: Physiological Testing of Elite Athletes · Edwards S (1993) The Heart Rate Monitor Book · Foster C (1998) Monitoring training in athletes with reference to overtraining syndrome. Med Sci Sports Exerc 30:1164–8 · Williams S et al. (2017) Better way to determine the acute:chronic workload ratio? Br J Sports Med 51:209–10 · Gabbett TJ (2016) The training–injury prevention paradox. Br J Sports Med 50:273–80 · Impellizzeri FM et al. (2020) Acute:chronic workload ratio: conceptual issues and fundamental pitfalls. Int J Sports Physiol Perform 15:907–13'],
  ['Intensity', 'Seiler KS & Kjerland GØ (2006) Quantifying training intensity distribution in elite endurance athletes. Scand J Med Sci Sports 16:49–56 · Seiler S (2010) What is best practice for training intensity and duration distribution? Int J Sports Physiol Perform 5:276–91 · Treff G et al. (2019) The polarization-index. Front Physiol 10:707'],
  ['Running', 'Daniels J & Gilbert J (1979) Oxygen Power · Daniels J, Daniels\' Running Formula · Riegel PS (1981) Athletic records and human endurance. Am Sci 69:285–90 · Monod H & Scherrer J (1965) Ergonomics 8:329–38 · Swain DP & Leutholtz BC (1997) Heart rate reserve is equivalent to %VO2 reserve. Med Sci Sports Exerc 29:410–4 · Uth N et al. (2004) Estimation of VO2max from the ratio between HRmax and HRrest. Eur J Appl Physiol 91:111–5 · Tanaka H et al. (2001) Age-predicted maximal heart rate revisited. J Am Coll Cardiol 37:153–6'],
  ['Recovery', 'Plews DJ et al. (2012) Heart rate variability in elite triathletes. Eur J Appl Physiol 112:3729–41 · Plews DJ et al. (2013) Training adaptation and heart rate variability in elite endurance athletes. Sports Med 43:773–81 · Buchheit M (2014) Monitoring training status with HR measures. Front Physiol 5:73 · Radin JM et al. (2020) Lancet Digit Health 2:e85–93 · Mishra T et al. (2020) Nat Biomed Eng 4:1208–20'],
  ['Sleep', 'Borbély AA (1982) A two process model of sleep regulation. Hum Neurobiol 1:195–204 · Daan S, Beersma DG & Borbély AA (1984) Am J Physiol 246:R161–83 · Skeldon AC, Derks G & Dijk DJ (2016) Sleep Med Rev 28:96–107 · Van Dongen HP et al. (2003) The cumulative cost of additional wakefulness. Sleep 26:117–26 · Wittmann M et al. (2006) Social jetlag. Chronobiol Int 23:497–509 · Roenneberg T et al. (2012) Social jetlag and obesity. Curr Biol 22:939–43 · Phillips AJK et al. (2017) Irregular sleep/wake patterns. Sci Rep 7:3216 · Windred DP et al. (2024) Sleep regularity is a stronger predictor of mortality risk than sleep duration. Sleep 47:zsad253'],
  ['Rhythms and steps', 'Cornelissen G (2014) Cosinor-based rhythmometry. Theor Biol Med Model 11:16 · Witting W et al. (1990) Biol Psychiatry 27:563–72 · Van Someren EJ et al. (1999) Chronobiol Int 16:505–18 · Tudor-Locke C & Bassett DR (2004) How many steps/day are enough? Sports Med 34:1–8 · Paluch AE et al. (2022) Daily steps and all-cause mortality. Lancet Public Health 7:e219–28'],
  ['Statistics', 'Spearman rank correlation · Benjamini Y & Hochberg Y (1995) Controlling the false discovery rate. J R Stat Soc B 57:289–300'],
];

function methods() {
  return h('details', { class: 'panel guide methods' },
    h('summary', { text: 'About these models and their sources' }),
    h('p', { class: 'muted', text: 'Wrist sensors estimate; the models assume what their papers assumed (for example steady effort for the heart-rate VO2max). Read trends rather than single values, and none of this is medical advice.' }),
    h('dl', { class: 'kv refs' }, REFS.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])));
}
