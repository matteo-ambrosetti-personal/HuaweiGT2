// Every model run once over the dataset, and the insight cards the Insights
// tab shows: what each model says about your latest weeks, in plain words,
// with the paper it comes from. Wording avoids medical claims.

import { addDays, daysBetween, fmtDuration, fmtPace, fmtSleep } from '../format.js';
import { latestDate, estimateMaxHr, nightsIn } from '../stats.js';
import { workoutLoads, fitnessFatigue, acwr, monotonyStrain, weeklyIntensity, loadSnapshot, formZone, acwrZone } from './load.js';
import { runVdots, rollingBestVdot, trainingPaces, raceTime, vo2maxFromRuns, vo2maxSummary, efficiencyFactors, bestEfforts, riegelFit } from './running.js';
import { hrvBaseline, restingHrBaseline, elevated, readiness } from './recovery.js';
import { sleepBalance, socialJetlag, sleepRegularity } from './sleep.js';
import { restActivity } from './rhythm.js';
import { correlations, strength } from './correlate.js';
import { median, mean } from './util.js';

const cache = new WeakMap();

/** Run the models once per dataset+settings (memoised on the dataset object). */
export function analyze(ds, settings) {
  const key = JSON.stringify([settings, Object.keys(ds.workouts).length, Object.keys(ds.days).length, Object.keys(ds.nights).length, latestDate(ds)]);
  const hit = cache.get(ds);
  if (hit?.key === key) return hit.value;
  const value = run(ds, settings);
  cache.set(ds, { key, value });
  return value;
}

function run(ds, settings) {
  const last = latestDate(ds);
  if (!last) return { last: null };
  const maxHr = estimateMaxHr(ds, settings).value;
  const sex = settings.sex || null;
  const loads = workoutLoads(ds, { maxHr, sex });
  const pmc = fitnessFatigue(ds, loads, { to: last });
  const ratio = acwr(pmc);
  const weeks = monotonyStrain(pmc);
  const span = { from: addDays(last, -365), to: last };
  const hrv = hrvBaseline(ds, { from: addDays(last, -120), to: last });
  const rest = restingHrBaseline(ds, { from: addDays(last, -120), to: last });
  const nightsAll = Object.values(ds.nights).sort((a, b) => (a.date < b.date ? -1 : 1));
  const recentNights = nightsIn(ds, { from: addDays(last, -55), to: last });
  const vdots = runVdots(ds);
  const bestV = rollingBestVdot(vdots);
  const lastWith = (rows, f) => rows.filter((r) => r[f] != null).at(-1) || null;
  const snap = loadSnapshot(pmc, ratio);
  const balance = sleepBalance(nightsAll, settings.sleepGoalMin, last);
  const out = {
    last, maxHr, sex, loads, pmc, acwr: ratio, weeks, snap,
    intensity: weeklyIntensity(ds, { from: addDays(last, -83), to: last }, maxHr),
    hrv, rest, hrvNow: lastWith(hrv, 'week'), restNow: lastWith(rest, 'z'),
    balance,
    jetlag: socialJetlag(recentNights),
    sri: sleepRegularity(recentNights),
    rhythm: restActivity(Object.values(ds.days).filter((d) => d.date >= addDays(last, -27) && d.date <= last).sort((a, b) => (a.date < b.date ? -1 : 1))),
    vdots, bestVdot: bestV, vdotNow: bestV.at(-1)?.vdot ?? null,
    vo2runs: vo2maxFromRuns(ds, { maxHr }), vo2: vo2maxSummary(ds, { maxHr }),
    ef: efficiencyFactors(ds, { maxHr }),
    riegel: riegelFit(bestEfforts(Object.values(ds.workouts).filter((w) => w.date >= addDays(last, -365)))),
  };
  out.paces = trainingPaces(out.vdotNow);
  out.ready = readiness({
    hrv: out.hrvNow && daysBetween(out.hrvNow.date, last) <= 3 ? out.hrvNow : null,
    rest: out.restNow && daysBetween(out.restNow.date, last) <= 3 ? out.restNow : null,
    sleep: balance,
    form: snap && !snap.warmup && snap.ctl >= 10 ? snap.tsb : null,
  });
  const loadByDay = new Map(pmc.map((r) => [r.date, r.load]));
  const worn = new Set(Object.values(ds.days).filter((d) => d.steps > 0).map((d) => d.date));
  out.corr = correlations(ds, { from: span.from, to: last }, { load: loadByDay, loadDays: worn });
  return out;
}

/** Minutes → "1 h 20 min" / "45 min". */
const H = (min) => {
  const m = Math.round(Math.abs(min));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
};
const sign = (v, d = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

/**
 * Insight cards, most actionable first:
 * [{tone: 'watch'|'good'|'info', area, title, text, cite}]
 */
export function insights(a, settings) {
  if (!a?.last) return [];
  const list = [];
  const add = (tone, area, title, text, cite) => list.push({ tone, area, title, text, cite });

  // ---- training load
  const s = a.snap;
  if (s && s.ctl >= 10 && !s.warmup) {
    const z = formZone(s.tsb);
    add(z.tone, 'Training', `Form ${sign(s.tsb)} · ${z.label}`,
      `Fitness (42-day load) is ${s.ctl}${s.ctlChange != null ? ` (${sign(s.ctlChange, 1)} in a week)` : ''} and fatigue (7-day load) ${s.atl}. Form is fitness minus fatigue: negative while you build, positive once you taper.`,
      'Banister et al. 1975 impulse–response model, as the Performance Management Chart');
    if (s.ramp != null && s.ctlChange > 7) {
      add('watch', 'Training', 'Fitness is ramping up quickly', `Your 42-day load rose ${s.ctlChange} points in a week. Coaches commonly keep the ramp to about 5–8 points a week to limit injury and illness risk.`, 'Coggan & Allen, Training and Racing with a Power Meter');
    }
  } else if (s?.warmup) {
    add('info', 'Training', 'Training load is still warming up', 'Fitness and fatigue need about six weeks of workouts before they mean much. Import a longer history to fill them in.', 'Banister et al. 1975');
  }
  const r = a.acwr.at(-1)?.ratio;
  const rz = acwrZone(r);
  if (rz && (rz.key === 'spike' || rz.key === 'high')) {
    add('watch', 'Training', `Acute:chronic load ${r.toFixed(2)} · ${rz.label}`, `Your last week's load is ${r.toFixed(2)}× your 4-week average. Ratios above about 1.5 have been linked to more injuries in team sports. The measure is debated, but a sudden jump is worth easing into.`, 'Gabbett 2016; Williams et al. 2017 (EWMA); Impellizzeri et al. 2020 (critique)');
  } else if (rz?.key === 'sweet') {
    add('good', 'Training', `Acute:chronic load ${r.toFixed(2)} · steady build`, 'Your recent load matches what you are used to (0.8–1.3 is the commonly cited range).', 'Gabbett 2016; Williams et al. 2017');
  }
  const wk = a.weeks.filter((w) => w.load > 0).at(-1);
  if (wk?.monotony > 2) {
    add('watch', 'Training', `Monotonous week (monotony ${wk.monotony.toFixed(1)})`, 'Your daily loads last week were very similar. In Foster\'s study, illnesses often followed weeks of high monotony (above about 2) and strain. Alternate hard and easy days.', 'Foster 1998');
  }
  const recent = a.intensity.slice(-4);
  const zt = recent.reduce((t, w) => [t[0] + w.z1, t[1] + w.z2, t[2] + w.z3], [0, 0, 0]);
  const zsum = zt[0] + zt[1] + zt[2];
  if (zsum > 3 * 3600) {
    const [f1, f2, f3] = zt.map((v) => v / zsum);
    const pct = (f) => `${Math.round(f * 100)} %`;
    if (f2 > 0.25) {
      add('watch', 'Training', 'Lots of moderate-intensity time', `Over 4 weeks: ${pct(f1)} easy, ${pct(f2)} moderate, ${pct(f3)} hard. Well-trained endurance athletes do roughly 80 % of their training at low intensity and little in the middle zone.`, 'Seiler & Kjerland 2006; Seiler 2010');
    } else if (f1 >= 0.75) {
      add('good', 'Training', 'Mostly easy, with some hard work', `Over 4 weeks: ${pct(f1)} easy, ${pct(f2)} moderate, ${pct(f3)} hard, close to the polarized pattern of endurance athletes.`, 'Seiler 2010; Treff et al. 2019');
    }
  }

  // ---- recovery
  const hv = a.hrvNow;
  if (hv?.status && daysBetween(hv.date, a.last) <= 3) {
    const ms = Math.round(Math.exp(hv.week)), base = Math.round(Math.exp(hv.base));
    if (hv.status === 'below') add('watch', 'Recovery', 'HRV below your normal range', `Your 7-day HRV averages ${ms} ms against a usual ${base} ms. A sustained dip often reflects accumulated training, illness, alcohol or poor sleep; easier days usually bring it back.`, 'Plews et al. 2012, 2013 (lnRMSSD, 7-day mean vs SWC)');
    else if (hv.status === 'within') add('good', 'Recovery', 'HRV within your normal range', `7-day HRV ${ms} ms, usual ${base} ms.`, 'Plews et al. 2013');
    else add('info', 'Recovery', 'HRV above your normal range', `7-day HRV ${ms} ms, usual ${base} ms. Usually a sign of good recovery; in heavily trained athletes it can also mean saturation.`, 'Plews et al. 2013');
  }
  const rn = a.restNow;
  if (rn && daysBetween(rn.date, a.last) <= 2 && elevated(rn)) {
    add('watch', 'Recovery', `Resting HR ${rn.rest} bpm, ${sign(rn.delta)} over your baseline`, 'A rise like this can come with hard training, a short night, alcohol, heat or an infection starting. Wearable studies used such rises to spot illness early. This is not a diagnosis: take it easy and see how you feel.', 'Radin et al. 2020; Mishra et al. 2020');
  }

  // ---- sleep
  if (a.balance) {
    const b = a.balance.balance;
    if (b <= -120) add('watch', 'Sleep', `${H(b)} short of your sleep goal this week`, `You averaged ${fmtSleep(a.balance.avg)} a night against a goal of ${fmtSleep(settings.sleepGoalMin)}. Deficits add up: two weeks at 6 h impaired attention as much as a night without sleep.`, 'Van Dongen et al. 2003');
    else if (b >= -30) add('good', 'Sleep', 'Sleep goal met this week', `You averaged ${fmtSleep(a.balance.avg)} a night.`, 'Van Dongen et al. 2003');
  }
  const j = a.jetlag;
  if (j) {
    if (j.jetlag >= 60) add('watch', 'Sleep', `Social jetlag ${H(j.jetlag)}`, `Your mid-sleep is ${H(j.jetlag)} ${j.signed > 0 ? 'later' : 'earlier'} at weekends than on workdays, like flying across time zones every week. Social jetlag has been linked with worse mood, metabolism and performance.`, 'Wittmann et al. 2006; Roenneberg et al. 2012');
    else if (j.jetlag <= 30) add('good', 'Sleep', 'Regular week and weekend sleep', `Weekend mid-sleep is within ${Math.round(j.jetlag)} min of workdays.`, 'Wittmann et al. 2006');
  }
  if (a.sri) add('info', 'Sleep', `Sleep regularity ${a.sri.sri} / 100`, `How often you are asleep, or awake, at the same clock time on consecutive days (${a.sri.pairs} night pairs). Higher is more regular; in a large cohort, regularity predicted mortality risk more strongly than sleep duration.`, 'Phillips et al. 2017; Windred et al. 2024');

  // ---- running
  if (a.vdotNow) {
    const k5 = raceTime(a.vdotNow, 5000), k10 = raceTime(a.vdotNow, 10000);
    const then = a.bestVdot.filter((p) => p.start < a.bestVdot.at(-1).start - 90 * 864e5).at(-1);
    const delta = then ? a.vdotNow - then.vdot : null;
    add(delta != null && delta >= 1 ? 'good' : 'info', 'Running', `VDOT ${a.vdotNow.toFixed(1)}${delta != null ? ` (${sign(delta, 1)} vs 3 months ago)` : ''}`,
      `From your best runs of the last 90 days: equivalent to ${fmtDuration(k5)} for 5 km and ${fmtDuration(k10)} for 10 km. Threshold pace ${fmtPace(a.paces.threshold)} /km, easy ${fmtPace(a.paces.easy[0])}–${fmtPace(a.paces.easy[1])} /km.`,
      'Daniels & Gilbert 1979; Daniels\' Running Formula');
  }
  if (a.vo2runs.length >= 6) {
    const pts = a.vo2runs;
    const lastT = pts.at(-1).start;
    const now = median(pts.filter((p) => p.start > lastT - 60 * 864e5).map((p) => p.vo2max));
    const before = median(pts.filter((p) => p.start <= lastT - 60 * 864e5 && p.start > lastT - 150 * 864e5).map((p) => p.vo2max));
    if (now != null) {
      const d = before != null ? now - before : null;
      add(d != null && d >= 1 ? 'good' : d != null && d <= -1.5 ? 'watch' : 'info', 'Running', `Estimated VO2max ${now.toFixed(1)} ml/kg/min${d != null ? ` (${sign(d, 1)})` : ''}`,
        `From pace and heart rate on steady, flat runs. Errors of ±10 % are common for any wrist estimate; the trend is more useful than the number.${a.vo2.watch ? ` The watch reports ${a.vo2.watch.value}.` : ''}`,
        'ACSM running equation; Swain & Leutholtz 1997 (%HRR ≈ %VO2R)');
    }
  }
  if (a.ef.length >= 8) {
    const e = a.ef.map((p) => p.ef);
    const recentEf = mean(e.slice(-5)), earlier = mean(e.slice(-15, -5));
    if (earlier) {
      const ch = ((recentEf - earlier) / earlier) * 100;
      if (Math.abs(ch) >= 3) add(ch > 0 ? 'good' : 'watch', 'Running', `Efficiency factor ${ch > 0 ? 'up' : 'down'} ${Math.abs(ch).toFixed(0)} %`, `You cover ${ch > 0 ? 'more' : 'fewer'} metres per heartbeat on your last 5 steady runs than on the 10 before. Rising efficiency at the same effort usually means improving aerobic fitness. Heat, hills and fatigue lower it.`, 'Friel; Allen & Coggan (efficiency factor)');
    }
  }
  if (a.riegel?.n >= 3) {
    const ex = a.riegel.exponent;
    add('info', 'Running', `Endurance exponent ${ex.toFixed(2)}`, `Fitted to your best efforts this year (Riegel's population value is 1.06). ${ex > 1.08 ? 'You slow more than most as distance grows: longer easy runs build endurance.' : ex < 1.04 ? 'You hold pace well over distance: speed work may pay off most.' : 'You are close to typical.'}`, 'Riegel 1981');
  }

  // ---- activity and rhythm
  const rh = a.rhythm;
  if (rh) {
    add('info', 'Activity', `Daily rhythm: stability ${rh.is}, fragmentation ${rh.iv}`, `Over the last ${rh.days} days your most active 10 hours start around ${String(rh.m10Start).padStart(2, '0')}:00. Interdaily stability runs 0–1 (higher = same pattern every day); intradaily variability runs 0–2 (higher = more broken up).`, 'Witting et al. 1990; Van Someren et al. 1999');
  }

  // ---- correlations (FDR-controlled)
  const top = [...a.corr.lagged, ...a.corr.cells]
    .filter((c) => c.q < 0.1 && Math.abs(c.rho) >= 0.25)
    .sort((x, y) => Math.abs(y.rho) - Math.abs(x.rho))
    .slice(0, 3);
  for (const c of top) {
    const L = a.corr.labels;
    const dir = c.rho > 0 ? 'higher' : 'lower';
    const text = c.lag
      ? `On days after more ${L[c.a].toLowerCase()}, your ${L[c.b].toLowerCase()} tends to be ${dir} (ρ = ${String(c.rho).replace('-', '−')}, ${c.n} days).`
      : `Days with more ${L[c.a].toLowerCase()} tend to have ${dir} ${L[c.b].toLowerCase()} (ρ = ${String(c.rho).replace('-', '−')}, ${c.n} days).`;
    add('info', 'Patterns', `${L[c.a]} ${c.lag ? '→ next day' : '↔'} ${L[c.b].toLowerCase()} · ${strength(c.rho)}`, `${text} A correlation in your own data, not proof of cause.`, 'Spearman correlation, Benjamini–Hochberg FDR < 10 %');
  }
  const order = { watch: 0, good: 1, info: 2 };
  return list.sort((x, y) => order[x.tone] - order[y.tone]);
}

