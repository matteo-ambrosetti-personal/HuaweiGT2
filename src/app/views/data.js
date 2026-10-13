import { h, section, clear, toast } from '../ui.js';
import { fmtDate, fmtInt } from '../../lib/format.js';
import { SOURCE_LABELS, datasetRange } from '../../lib/model.js';
import { estimateMaxHr } from '../../lib/stats.js';
import { skippedFolders } from '../sync-drive.js';
import { workoutCoverage, MAP_ATTRIBUTION } from '../../lib/basemap.js';

function guide(title, steps, open = false) {
  return h('details', { class: 'guide', open },
    h('summary', { text: title }),
    h('ol', { class: 'steps-list', style: { marginTop: '8px' } }, steps.map((s) => h('li', null, ...s))));
}

const when = (iso) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The map card: download OpenStreetMap data for the area around the routes
 * (a link the browser opens), add the saved file, or remove the map.
 */
function mapCard(ctx, flash) {
  const areas = ctx.basemapIndex?.areas || [];
  const cells = new Set(areas.flatMap((a) => a.cells || []));
  const gps = Object.values(ctx.ds.workouts).filter((w) => Array.isArray(w.bbox));
  const covered = gps.filter((w) => (workoutCoverage(w, cells) ?? 0) >= 0.9).length;
  const latest = areas.reduce((a, b) => (!a || b.at > a.at ? b : a), null);
  const panel = h('div', { class: 'panel', id: 'map-card', style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  panel.append(h('div', { class: 'section-head' },
    h('h3', { class: 'chart-title', text: 'OpenStreetMap' }),
    h('span', { class: `chip ${areas.length ? 'ok' : ''}`, id: 'map-status' }, h('span', { class: 'dot' }), areas.length ? 'On' : 'Not added')));
  panel.append(h('p', { style: { margin: 0 }, id: 'map-summary', text: areas.length
    ? `The map covers ${plural(covered, 'route')} of your ${fmtInt(gps.length)}. Downloaded ${fmtDate(latest.at.slice(0, 10))}.`
    : 'Download the map data for the area around your routes once. The page then draws streets, paths, parks, water and place names under them.' }));
  const result = h('div', { id: 'map-result' });
  if (flash) result.append(h('div', { class: 'msg ok' }, h('strong', { text: flash.title }), flash.text));
  const app = ctx.platform?.app;
  const privacy = h('p', { class: 'muted', style: { margin: 0, fontSize: '12px' },
    text: `Map data ${MAP_ATTRIBUTION}. OpenStreetMap's server sees which area you download, never your tracks. The map is saved ${app ? 'on this device' : 'in your private storage'}, next to your health data.` });

  if (ctx.isSample || !gps.length) {
    panel.append(h('p', { class: 'muted', style: { margin: 0 }, text: ctx.isSample
      ? 'Import your own workouts first: the map is downloaded for the area around them.'
      : 'None of your workouts has a GPS route yet.' }), result, privacy);
    return panel;
  }

  const input = h('input', { id: 'map-file', type: 'file', hidden: true });
  const add = h('button', { class: 'btn', type: 'button', id: 'map-add', onclick: () => input.click() }, 'Add the saved file');
  const take = async (file) => {
    clear(result);
    add.disabled = true;
    result.append(h('p', { class: 'muted', style: { margin: 0 }, text: `Reading ${file.name}…` }));
    try {
      await ctx.actions.addMapFile(file); // redraws this tab with a confirmation
    } catch (e) {
      clear(result);
      result.append(h('div', { class: 'msg err', id: 'map-error' }, h('strong', { text: 'The map was not added' }),
        e?.code && !/^(not_json|not_osm|server_page|server_error|empty)$/.test(e.code) ? `It could not be saved (${e.code}). Try again.` : e?.message || String(e)));
      add.disabled = false;
    }
  };
  input.addEventListener('change', () => {
    if (input.files?.[0]) take(input.files[0]);
    input.value = '';
  });
  panel.addEventListener('dragover', (e) => e.preventDefault());
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.[0]) take(e.dataTransfer.files[0]);
  });
  const link = (d, label, primary) => h('a', {
    class: `btn${primary ? ' primary' : ''}`, id: 'map-download', href: d.url, target: '_blank', rel: 'noopener',
    onclick: () => ctx.actions.noteMapRequest(d.areas),
  }, label);
  const dl = ctx.actions.mapDownload();
  if (app) {
    // The app can fetch the data itself: one button instead of save-and-add.
    const target = dl || ctx.actions.mapDownload({ all: true });
    const get = h('button', { class: 'btn primary', type: 'button', id: 'map-download', disabled: !target }, dl ? 'Download map' : 'Download again');
    get.addEventListener('click', async () => {
      get.disabled = true;
      add.disabled = true;
      clear(result);
      const note = h('p', { class: 'muted', style: { margin: 0 } });
      result.append(note);
      try {
        await ctx.actions.downloadMapNow(target, (t) => { note.textContent = t; }); // redraws this tab
      } catch (e) {
        clear(result);
        result.append(h('div', { class: 'msg err', id: 'map-error' }, h('strong', { text: 'The map was not added' }), e?.message || String(e)));
        get.disabled = false;
        add.disabled = false;
      }
    });
    panel.append(h('div', { class: 'btn-row' }, get, add,
      h('span', { class: 'muted', text: dl ? `About ${fmtInt(dl.km2)} km² around ${areas.length ? 'the routes outside the map' : 'your routes'}${dl.leftOut ? `, leaving out ${plural(dl.leftOut, 'long route')}` : ''}.` : 'All your routes are on the map.' })));
  } else if (dl) {
    const missing = gps.length - covered;
    panel.append(h('ol', { class: 'steps-list' },
      h('li', null, link(dl, 'Download map data ↗', true), ' ',
        h('span', { class: 'muted', text: `About ${fmtInt(dl.km2)} km² around ${areas.length ? `the ${plural(missing, 'route')} outside the map` : 'your routes'}${dl.leftOut ? `, leaving out ${plural(dl.leftOut, 'long route')} that would make it too big` : ''}. It opens OpenStreetMap's data service in a new tab${dl.km2 > 250 ? '. This is a big area, so it can take a few minutes; if it fails, try again later' : '; a large area can take a minute'}.${dl.more ? ` After adding it, download the other ${plural(dl.more, 'area')} the same way.` : ''}` })),
      h('li', null, "Save what opens as a file: on a computer press Ctrl+S (⌘S on a Mac); on a phone use your browser's Download option."),
      h('li', null, add, ' ', h('span', { class: 'muted', text: 'Pick the file you saved, or drop it on this card.' }))));
  } else {
    const again = ctx.actions.mapDownload({ all: true });
    panel.append(h('div', { class: 'btn-row' }, add, again ? link(again, 'Download again ↗', false) : null,
      h('span', { class: 'muted', text: 'All your routes are on the map.' })));
  }
  panel.append(input, result);
  if (areas.length) {
    const remove = h('button', { class: 'btn', type: 'button', id: 'map-remove' }, 'Remove map');
    let armed = null;
    remove.addEventListener('click', async () => {
      if (!armed) {
        remove.textContent = 'Select again to remove';
        armed = setTimeout(() => { armed = null; remove.textContent = 'Remove map'; }, 4000);
        return;
      }
      clearTimeout(armed);
      remove.disabled = true;
      try {
        await ctx.actions.removeMap();
        toast('Map removed.');
      } catch {
        toast('The map could not be removed. Try again.');
        remove.disabled = false;
      }
    });
    panel.append(h('div', { class: 'btn-row' }, remove));
  }
  panel.append(privacy);
  return panel;
}
const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? '' : 's'}`;

function driveChip(d, hs) {
  if (d.busy) return { cls: '', text: 'Syncing…' };
  switch (d.status) {
    case 'checking': return { cls: '', text: 'Checking…' };
    case 'unavailable': return { cls: '', text: 'Unavailable here' };
    case 'prompt': return { cls: '', text: 'Ready to connect' };
    case 'missing': return { cls: 'warn', text: 'Not connected' };
    case 'reauth': return { cls: 'warn', text: 'Reconnect' };
    case 'denied': return { cls: 'warn', text: 'Not allowed' };
    case 'choose': return { cls: 'warn', text: 'Choose connector' };
    case 'approval': return { cls: 'warn', text: 'Needs approval' };
    case 'blocked': return { cls: 'bad', text: 'Blocked' };
    case 'nofolders': return { cls: 'warn', text: 'No files yet' };
    default:
      if (d.error) return { cls: 'bad', text: 'Sync failed' };
      return hs?.at ? { cls: 'ok', text: 'Connected' } : { cls: 'ok', text: 'Allowed' };
  }
}

function progressText(p) {
  if (!p || p.phase === 'folders') return 'Looking for Health Sync folders…';
  if (p.phase === 'list') return 'Listing new files…';
  return `Reading files ${fmtInt(p.done)} of ${fmtInt(p.total)}…`;
}

/** The "Google Drive · Health Sync" card; main.js redraws it in place while syncing. */
export function renderDriveCard(el, ctx) {
  clear(el);
  const d = ctx.drive || {};
  const hs = ctx.meta?.sources?.healthsync;
  const chip = driveChip(d, hs);
  el.append(h('div', { class: 'section-head' },
    h('h3', { class: 'chart-title', text: 'Google Drive · Health Sync' }),
    h('span', { class: `chip ${chip.cls}`, id: 'drive-status' }, h('span', { class: 'dot' }), chip.text)));
  el.append(h('p', { style: { margin: 0 }, text: 'Automatic: the Health Sync app copies your Huawei Health data into Google Drive, and this page reads it through the Google Drive connector, when you open it (at most hourly) or press Sync now.' }));

  if (d.status === 'unavailable') el.append(h('p', { class: 'muted', style: { margin: 0 }, text: 'Connectors cannot be used in this view. Open the logbook on claude.ai to sync from Google Drive.' }));
  if (d.status === 'nofolders' && !d.error) el.append(h('div', { class: 'msg' }, h('strong', { text: 'No Health Sync folders found' }), 'Google Drive has no folders named "Health Sync …" yet. Check that Health Sync uses Google Drive as a destination and has synced once.'));
  if (d.error) el.append(h('div', { class: 'msg err', id: 'drive-error' }, h('strong', { text: d.error.title }), d.error.text));
  if (d.busy) el.append(h('p', { class: 'muted', style: { margin: 0 }, text: progressText(d.progress) }));
  else if (hs?.at) {
    const r = d.report;
    const parts = [`Last sync ${when(hs.at)}`];
    if (r) {
      parts.push(`${plural(r.read, 'file')} read`);
      parts.push(r.days || r.workouts ? `${[r.days ? plural(r.days, 'day') : '', r.workouts ? plural(r.workouts, 'workout') : ''].filter(Boolean).join(' and ')} updated${r.metrics?.length ? ` (${r.metrics.join(', ')})` : ''}` : 'nothing new');
      if (r.failed) parts.push(`${plural(r.failed, 'file')} could not be read and will be retried`);
    }
    if (hs.range?.to) parts.push(`data up to ${fmtDate(hs.range.to)}`);
    el.append(h('p', { class: 'muted', style: { margin: 0 }, id: 'drive-summary', text: `${parts.join(' · ')}.` }));
  }

  const skipped = skippedFolders(ctx.syncIndex);
  if (skipped.length) {
    el.append(h('div', { class: 'msg' }, h('strong', { text: 'Not used yet' }),
      ...skipped.map((s) => h('div', { text: `${s.folder}: ${plural(s.n, 'file')}${s.header ? ` (columns: ${s.header})` : s.reason ? ` (${s.reason})` : ''}` })),
      h('div', { class: 'muted', text: 'Ask Claude to add support for these once they appear.' })));
  }

  const row = h('div', { class: 'btn-row' });
  if (d.status !== 'unavailable' && d.status !== 'blocked' && d.status !== 'checking') {
    row.append(h('button', { class: 'btn primary', type: 'button', id: 'drive-sync', disabled: Boolean(d.busy), onclick: () => ctx.actions.syncDrive() },
      d.busy ? 'Syncing…' : d.status === 'prompt' ? 'Connect and sync' : 'Sync now'));
  }
  if (d.status === 'denied' || d.error?.action === 'permissions') {
    row.append(h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.openPermissions() }, 'Open permissions'));
  }
  if (d.status === 'prompt' && !d.busy) row.append(h('span', { class: 'muted', text: 'claude.ai asks once to let this page read Google Drive.' }));
  if (row.childNodes.length) el.append(row);

  el.append(guide('Set it up', [
    ['On your Android phone install ', h('b', { text: 'Health Sync' }), ' (one-week trial, then a small one-time fee).'],
    ['Choose ', h('b', { text: 'Huawei Health' }), ' as the source and ', h('b', { text: 'Google Drive' }), ' as the destination. Enable steps, heart rate and SpO2; activities (GPX/TCX) and sleep are optional.'],
    ['In claude.ai open ', h('b', { text: 'Settings → Connectors' }), ' and connect ', h('b', { text: 'Google Drive' }), '.'],
    ['Press ', h('b', { text: 'Connect and sync' }), ' here and allow Google Drive. From then on the logbook syncs by itself when you open it.'],
  ], !hs?.at && d.status !== 'ready'));
}

const HC_PHASES = {
  steps: 'steps', distance: 'distance', calories: 'calories', heartRate: 'heart rate', restingHeartRate: 'resting heart rate',
  heartRateVariability: 'HRV', oxygenSaturation: 'SpO2', weight: 'weight', vo2Max: 'VO2max', sleep: 'sleep', workouts: 'workouts',
};

/** The Health Connect card (Android app); main.js redraws it in place while syncing. */
export function renderHealthCard(el, ctx) {
  clear(el);
  const hc = ctx.health || {};
  const src = ctx.meta?.sources?.healthconnect;
  const native = ctx.platform?.name === 'android';
  const chip = hc.busy ? { cls: '', text: 'Syncing…' }
    : !native ? { cls: '', text: 'Android app only' }
    : hc.status === 'unavailable' ? { cls: 'warn', text: 'Not available' }
    : hc.status === 'prompt' ? { cls: '', text: 'Ready to connect' }
    : hc.status === 'ready' ? (hc.error ? { cls: 'bad', text: 'Sync failed' } : { cls: 'ok', text: src?.at ? 'Connected' : 'Allowed' })
    : { cls: '', text: 'Checking…' };
  el.append(h('div', { class: 'section-head' },
    h('h3', { class: 'chart-title', text: 'Health Connect · Health Sync' }),
    h('span', { class: `chip ${chip.cls}`, id: 'health-status' }, h('span', { class: 'dot' }), chip.text)));
  el.append(h('p', { style: { margin: 0 }, text: 'Automatic and on the phone: the Health Sync app copies Huawei Health data into Health Connect, and this app reads it from there when you open it (at most hourly) or press Sync now. Nothing goes through a cloud.' }));
  if (!native) {
    el.append(h('p', { class: 'muted', style: { margin: 0 }, text: 'Health Connect exists only on Android. Install the GT 2 Logbook app on your phone to use it.' }));
    return;
  }
  if (hc.status === 'unavailable') {
    el.append(h('div', { class: 'msg' }, h('strong', { text: 'Health Connect is not available' }),
      hc.reason === 'not_installed' || /install/i.test(hc.reason || '') ? 'Install "Health Connect" from the Play Store (built into Android 14 and later), then reopen the app.' : `Android reported: ${hc.reason || 'unavailable'}.`));
  }
  if (hc.error) el.append(h('div', { class: 'msg err', id: 'health-error' }, h('strong', { text: hc.error.title }), hc.error.text));
  if (hc.busy) {
    const p = hc.progress;
    el.append(h('p', { class: 'muted', style: { margin: 0 }, text: p?.phase && p.phase !== 'done' ? `Reading ${HC_PHASES[p.phase] || p.phase}… (${p.done + 1} of ${p.total})` : 'Reading Health Connect…' }));
  } else if (src?.at) {
    const r = hc.report;
    const parts = [`Last sync ${when(src.at)}`];
    if (r) parts.push(`${plural(r.days, 'day')}, ${plural(r.nights, 'night')} and ${plural(r.workouts, 'workout')} read`);
    if (src.range?.to) parts.push(`data up to ${fmtDate(src.range.to)}`);
    el.append(h('p', { class: 'muted', style: { margin: 0 }, id: 'health-summary', text: `${parts.join(' · ')}.` }));
    if (r?.skipped?.length) el.append(h('p', { class: 'muted', style: { margin: 0, fontSize: '12px' }, text: `Not read: ${r.skipped.map((x) => x.split(':')[0]).map((k) => HC_PHASES[k] || k).join(', ')} (not allowed, or Health Connect refused).` }));
  }
  if (hc.status === 'ready' && !hc.history) {
    el.append(h('p', { class: 'muted', style: { margin: 0, fontSize: '12px' }, text: 'Health Connect only shares the last 30 days unless you also allow "Access past data". The Huawei export covers older history.' }));
  }
  const row = h('div', { class: 'btn-row' });
  if (hc.status === 'prompt') row.append(h('button', { class: 'btn primary', type: 'button', id: 'health-connect', onclick: () => ctx.actions.connectHealth() }, 'Connect Health Connect'));
  if (hc.status === 'ready') {
    row.append(h('button', { class: 'btn primary', type: 'button', id: 'health-sync', disabled: Boolean(hc.busy), onclick: () => ctx.actions.syncHealth() }, hc.busy ? 'Syncing…' : 'Sync now'));
    row.append(h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.connectHealth() }, 'Allow more data'));
  }
  if (hc.status === 'ready' || hc.status === 'prompt') row.append(h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.openHealthSettings() }, 'Health Connect settings'));
  if (row.childNodes.length) el.append(row);
  el.append(guide('Set it up', [
    ['Install ', h('b', { text: 'Health Sync' }), ' from the Play Store (one-week trial, then a small one-time fee).'],
    ['In Health Sync choose ', h('b', { text: 'Huawei Health' }), ' as the source and ', h('b', { text: 'Health Connect' }), ' as the destination. Turn on steps, heart rate, sleep, activities and, if offered, SpO2 and HRV.'],
    ['Press ', h('b', { text: 'Connect Health Connect' }), ' here and allow the data types (and "Access past data" for more than 30 days).'],
    ['From then on the app syncs by itself when you open it.'],
  ], !src?.at));
}

/** intervals.icu with your own API key (app); main.js redraws it in place while syncing. */
export function renderIntervalsCard(el, ctx) {
  clear(el);
  const iv = ctx.intervals || {};
  const src = ctx.meta?.sources?.intervals;
  const secrets = ctx.runtime?.secrets;
  const hasKey = Boolean(secrets?.get('intervals'));
  const chip = iv.busy ? { cls: '', text: 'Syncing…' } : iv.error ? { cls: 'bad', text: 'Sync failed' } : hasKey ? { cls: 'ok', text: 'Connected' } : { cls: '', text: 'Not connected' };
  el.append(h('div', { class: 'section-head' },
    h('h3', { class: 'chart-title', text: 'intervals.icu' }),
    h('span', { class: `chip ${chip.cls}`, id: 'intervals-status' }, h('span', { class: 'dot' }), chip.text)));
  el.append(h('p', { style: { margin: 0 }, text: 'Automatic and free: Huawei Health syncs workouts (with GPS and heart rate) and wellness to intervals.icu, and the app reads them with your personal API key. The key stays on this device.' }));
  if (iv.error) el.append(h('div', { class: 'msg err', id: 'intervals-error' }, h('strong', { text: iv.error.title }), iv.error.text));
  if (iv.busy) {
    const p = iv.progress;
    el.append(h('p', { class: 'muted', style: { margin: 0 }, text: p?.phase === 'streams' && p.total ? `Downloading routes ${p.done + 1} of ${p.total}…` : 'Listing activities…' }));
  } else if (src?.at) {
    const r = iv.report;
    const parts = [`Last sync ${when(src.at)}`];
    if (r) parts.push(`${fmtInt(r.activities)} ${r.activities === 1 ? 'activity' : 'activities'} (${r.withStreams} with new routes), ${plural(r.wellnessDays, 'day')} of wellness`);
    if (src.range?.to) parts.push(`data up to ${fmtDate(src.range.to)}`);
    el.append(h('p', { class: 'muted', style: { margin: 0 }, id: 'intervals-summary', text: `${parts.join(' · ')}.` }));
  }
  if (hasKey) {
    el.append(h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', type: 'button', id: 'intervals-sync', disabled: Boolean(iv.busy), onclick: () => ctx.actions.syncIntervals() }, iv.busy ? 'Syncing…' : 'Sync now'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.saveIntervals({ apiKey: null, athleteId: null }) }, 'Forget key')));
    return;
  }
  const key = h('input', { id: 'intervals-key', type: 'password', autocomplete: 'off', placeholder: 'API key' });
  const athlete = h('input', { id: 'intervals-athlete', autocomplete: 'off', placeholder: 'Optional, e.g. i123456', value: ctx.settings?.intervalsAthlete || '' });
  const form = h('form', { style: { display: 'flex', flexDirection: 'column', gap: '10px' }, onsubmit: (e) => {
    e.preventDefault();
    if (!key.value.trim()) return key.focus();
    ctx.actions.saveIntervals({ apiKey: key.value.trim(), athleteId: athlete.value.trim() });
  } },
  h('div', { class: 'fields' },
    h('div', { class: 'field' }, h('label', { for: 'intervals-key', text: 'API key' }), key),
    h('div', { class: 'field' }, h('label', { for: 'intervals-athlete', text: 'Athlete ID' }), athlete)),
  h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Connect and sync')));
  el.append(form, guide('Set it up', [
    ['Create a free account at ', h('b', { text: 'intervals.icu' }), ' → Settings → Connections → ', h('b', { text: 'HUAWEI Health' }), ', and allow the link in Huawei Health.'],
    ['In intervals.icu open ', h('b', { text: 'Settings → Developer settings' }), ' and copy the ', h('b', { text: 'API key' }), ' (and your athlete ID, shown there too).'],
    ['Paste them here. The first sync reads the last 12 months; later ones only what is new.'],
  ], true));
}

export function renderData(root, ctx) {
  const { meta, isSample, runtime, store } = ctx;
  const app = Boolean(ctx.platform?.app);
  const native = ctx.platform?.name === 'android';

  // ---------------------------------------------------------- import export
  const pwd = h('input', { id: 'zip-password', type: 'password', autocomplete: 'off', placeholder: 'Password you chose when requesting it' });
  const fileInput = h('input', { id: 'zip-file', type: 'file', accept: '.zip,application/zip,.json', multiple: true, hidden: true });
  const folderInput = h('input', { id: 'zip-folder', type: 'file', webkitdirectory: true, multiple: true, hidden: true });
  const progress = h('div', { class: 'progress', hidden: true }, h('div'));
  const result = h('div');
  const chosen = h('p', { class: 'muted', text: 'No file chosen' });
  let files = [];
  const pick = (list) => {
    files = [...list];
    chosen.textContent = files.length === 1 ? `${files[0].name} · ${(files[0].size / 1e6).toFixed(1)} MB` : `${files.length} files selected`;
    go.disabled = !files.length;
  };
  fileInput.addEventListener('change', () => pick(fileInput.files));
  folderInput.addEventListener('change', () => pick(folderInput.files));
  const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Import');
  const drop = h('div', { class: 'dropzone', id: 'dropzone' },
    h('p', null, h('b', { text: 'Drop your Huawei export ZIP here' })),
    h('p', { class: 'muted', text: native ? 'Choose the ZIP you downloaded from Huawei. Everything is decrypted and read on your phone.' : 'Or choose the extracted folder. Everything is decrypted and read in your browser.' }),
    h('div', { class: 'btn-row', style: { justifyContent: 'center' } },
      h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Choose ZIP'),
      native ? null : h('button', { class: 'btn', type: 'button', onclick: () => folderInput.click() }, 'Choose folder')),
    chosen, fileInput, folderInput);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer?.files?.length) pick(e.dataTransfer.files);
  });
  go.addEventListener('click', async () => {
    go.disabled = true;
    progress.hidden = false;
    clear(result);
    const bar = progress.firstChild;
    try {
      await ctx.actions.importExport(files, pwd.value, (p) => {
        bar.style.width = `${p.total ? Math.min(100, (p.done / p.total) * 100) : 5}%`;
        chosen.textContent = p.label || (p.file ? `Reading ${p.file}…` : 'Reading…');
      });
      pwd.value = '';
    } catch (e) {
      result.append(h('div', { class: 'msg err' }, h('strong', { text: e.code === 'bad_password' || e.code === 'password_required' ? 'Password needed' : 'Import failed' }), e.message || String(e)));
      if (e.code === 'bad_password' || e.code === 'password_required') pwd.focus();
    } finally {
      go.disabled = !files.length;
      progress.hidden = true;
      bar.style.width = '0';
    }
  });

  const importPanel = h('div', { class: 'panel', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    drop,
    h('div', { class: 'fields' }, h('div', { class: 'field' }, h('label', { for: 'zip-password', text: 'Export password' }), pwd)),
    h('div', { class: 'btn-row' }, go, h('span', { class: 'muted', text: isSample ? 'Your import replaces the sample data.' : 'New data merges with what is already here.' })),
    progress, result,
    guide('How to get your Huawei export', [
      ['Open the ', h('b', { text: 'Huawei Health' }), ' app → ', h('b', { text: 'Me' }), ' → tap your account name.'],
      ['Go to ', h('b', { text: 'Privacy Centre' }), ' → ', h('b', { text: 'Request your data' }), ' and select ', h('b', { text: 'Health' }), '.'],
      ['Set a password (you will need it here) and submit. The email with the download link usually arrives within a day (Huawei allows up to 7). The link works for 21 days.'],
      ['Download the ZIP and drop it above with the same password. Repeat whenever you want to refresh your full history.'],
    ], isSample));

  // ---------------------------------------------------------- GPX/TCX/CSV files
  const actInput = h('input', { id: 'act-files', type: 'file', accept: '.gpx,.tcx,.csv', multiple: true, hidden: true });
  const actResult = h('div');
  actInput.addEventListener('change', async () => {
    clear(actResult);
    try {
      await ctx.actions.importActivityFiles([...actInput.files]);
    } catch (e) {
      actResult.append(h('div', { class: 'msg err' }, e.message || String(e)));
    }
    actInput.value = '';
  });
  const filesPanel = h('div', { class: 'panel', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('p', { style: { margin: 0 }, text: 'Add single workouts between exports: in Huawei Health open a workout, tap the route or share icon and export GPX. Health Sync CSV, GPX and TCX files work too.' }),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onclick: () => actInput.click() }, 'Add GPX / TCX / CSV files'), actInput),
    actResult);

  const flash = ctx.takeFlash?.();
  if (flash && flash.target !== 'map' && flash.title !== 'Backup restored') (flash.target === 'files' ? actResult : result).append(h('div', { class: 'msg ok' }, h('strong', { text: flash.title }), flash.text));
  root.append(section('Import your Huawei export', 'The complete history: workouts with GPS, steps, heart rate, sleep, SpO2 and stress.', importPanel));
  root.append(section('Add individual files', null, filesPanel));
  root.append(section('Map', 'Streets, paths, parks and water under your routes', mapCard(ctx, flash?.target === 'map' ? flash : null)));

  // ---------------------------------------------------------- automatic sources
  const srcCard = (title, state, body) => h('div', { class: 'panel span-6', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', { class: 'section-head' }, h('h3', { class: 'chart-title', text: title }), h('span', { class: `chip ${state.cls}` }, h('span', { class: 'dot' }), state.text)),
    ...body);
  const drive = h('div', { class: 'panel span-6', id: 'drive-card', style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  renderDriveCard(drive, ctx);
  const bridge = srcCard('intervals.icu · GT2 Bridge', { cls: '', text: 'Not connected yet' }, [
    h('p', { style: { margin: 0 }, text: 'Automatic and free: Huawei Health syncs to intervals.icu natively, and a small connector you deploy on Cloudflare (free tier) lets this page read it.' }),
    guide('Set it up', [
      ['Create a free account at ', h('b', { text: 'intervals.icu' }), ' → Settings → Connections → ', h('b', { text: 'HUAWEI Health' }), '; then in Huawei Health allow the Health Service Kit link.'],
      ['In intervals.icu → Settings → Developer, copy your ', h('b', { text: 'API key' }), '.'],
      ['Deploy the ', h('code', { text: 'bridge/' }), ' folder of the GitHub repo with Cloudflare Workers (see ', h('code', { text: 'docs/setup-intervals-bridge.md' }), ').'],
      ['In claude.ai add a custom connector named ', h('b', { text: 'GT2 Bridge' }), ' with the worker URL, then tell Claude it is done.'],
    ]),
  ]);
  if (app) {
    const health = h('div', { class: 'panel span-6', id: 'health-card', style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
    renderHealthCard(health, ctx);
    const iv = h('div', { class: 'panel span-6', id: 'intervals-card', style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
    renderIntervalsCard(iv, ctx);
    root.append(section('Automatic updates', 'Optional. Keep the export for full history; these fill in new days between exports.', h('div', { class: 'grid' }, health, iv)));
  } else {
    root.append(section('Automatic updates', 'Optional. Keep the export for full history; these fill in new days between exports.', h('div', { class: 'grid' }, drive, bridge)));
  }

  // ---------------------------------------------------------- history
  const imports = (meta.imports || []).slice().reverse();
  const cov = datasetRange(ctx.ds);
  const hist = h('div', { class: 'panel' },
    h('dl', { class: 'kv' },
      h('dt', { text: 'Storage' }), h('dd', { text: store?.kind === 'cloud' ? 'Private claude.ai storage (only you can read it)' : store?.kind === 'device' ? (native ? 'On this phone, in the app\'s private storage' : 'In this browser (IndexedDB)') : 'This browser tab only (not saved)' }),
      h('dt', { text: 'Showing' }), h('dd', { text: isSample ? 'Sample data' : cov ? `${fmtDate(cov.from)} – ${fmtDate(cov.to)}` : 'Nothing yet' }),
      h('dt', { text: 'Contents' }), h('dd', { text: `${fmtInt(Object.keys(ctx.ds.days).length)} days · ${fmtInt(Object.keys(ctx.ds.workouts).length)} workouts · ${fmtInt(Object.keys(ctx.ds.nights).length)} nights` })),
    imports.length
      ? h('div', { class: 'table-wrap', style: { marginTop: '12px' } }, h('table', null,
          h('thead', null, h('tr', null, h('th', { text: 'When' }), h('th', { text: 'Source' }), h('th', { text: 'Covers' }), h('th', { class: 'r', text: 'Workouts' }), h('th', { class: 'r', text: 'Days' }), h('th', { class: 'r', text: 'Nights' }))),
          h('tbody', null, imports.map((i) => h('tr', null,
            h('td', { text: new Date(i.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) }),
            h('td', { text: SOURCE_LABELS[i.source] || i.source }),
            h('td', { text: i.range?.from ? `${fmtDate(i.range.from)} – ${fmtDate(i.range.to)}` : '—' }),
            h('td', { class: 'r', text: fmtInt(i.counts?.workouts) }),
            h('td', { class: 'r', text: fmtInt(i.counts?.days) }),
            h('td', { class: 'r', text: fmtInt(i.counts?.nights) }))))))
      : h('p', { class: 'muted', style: { margin: '12px 0 0' }, text: 'No imports yet.' }));
  root.append(section('Your data', null, hist));

  // ---------------------------------------------------------- exports
  const ex = h('div', { class: 'panel', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('p', { style: { margin: 0 }, text: `${native ? 'Each file opens the share sheet: save it to Files or Google Drive, or send it.' : 'Your browser asks before saving each file.'} GPX and TCX files come zipped; tracks are simplified to at most 1,000 points.` }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportCsv('workouts') }, 'Workouts CSV'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportCsv('daily') }, 'Daily metrics CSV'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportRoutesInRange('gpx') }, 'GPX routes (selected period)'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportRoutesInRange('tcx') }, 'TCX (selected period)'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportBackup() }, 'Full backup (JSON)')));
  const restoreInput = h('input', { id: 'backup-file', type: 'file', accept: '.json,application/json', hidden: true });
  const restoreResult = h('div');
  restoreInput.addEventListener('change', async () => {
    const file = restoreInput.files?.[0];
    restoreInput.value = '';
    if (!file) return;
    clear(restoreResult);
    try {
      await ctx.actions.restoreBackup(file);
    } catch (e) {
      restoreResult.append(h('div', { class: 'msg err' }, h('strong', { text: 'Not restored' }), e?.message || String(e)));
    }
  });
  ex.append(h('div', { class: 'btn-row' },
    h('button', { class: 'btn', type: 'button', id: 'backup-restore', onclick: () => {
      if (isSample || window.confirm('Restoring replaces every day, workout, route and setting stored here with the backup. Continue?')) restoreInput.click();
    } }, 'Restore a backup…'),
    h('span', { class: 'muted', text: 'Moves your logbook to a new phone or back after reinstalling.' }), restoreInput), restoreResult);
  if (flash && flash.title === 'Backup restored') restoreResult.append(h('div', { class: 'msg ok' }, h('strong', { text: flash.title }), flash.text));
  root.append(section('Export and backup', null, ex));

  // ---------------------------------------------------------- settings
  const s = ctx.settings;
  const mh = estimateMaxHr(ctx.ds, s);
  const f = (id, label, value, attrs = {}) => h('div', { class: 'field' }, h('label', { for: id, text: label }), h('input', { id, value: value ?? '', inputmode: 'numeric', ...attrs }));
  const form = h('form', { class: 'panel', style: { display: 'flex', flexDirection: 'column', gap: '12px' }, onsubmit: async (e) => {
    e.preventDefault();
    const num = (id) => { const v = Number(form.querySelector(`#${id}`).value); return Number.isFinite(v) && v > 0 ? v : null; };
    await ctx.actions.saveSettings({
      stepGoal: num('set-steps') || 10000,
      sleepGoalMin: Math.round((num('set-sleep') || 8) * 60),
      maxHr: num('set-maxhr'),
      birthYear: num('set-birth'),
      sex: form.querySelector('#set-sex').value || null,
    });
    toast('Settings saved');
  } },
    h('div', { class: 'fields' },
      f('set-steps', 'Daily step goal', s.stepGoal),
      f('set-sleep', 'Sleep goal (hours)', (s.sleepGoalMin / 60).toFixed(1), { inputmode: 'decimal' }),
      f('set-maxhr', 'Max heart rate (bpm)', s.maxHr, { placeholder: `Estimated ${mh.value}` }),
      f('set-birth', 'Birth year (for zones)', s.birthYear, { placeholder: 'Optional' }),
      h('div', { class: 'field' }, h('label', { for: 'set-sex', text: 'Sex (training-load formula)' }),
        h('select', { id: 'set-sex' },
          h('option', { value: '', selected: !s.sex }, 'Not set (men\'s weighting)'),
          h('option', { value: 'female', selected: s.sex === 'female' }, 'Female'),
          h('option', { value: 'male', selected: s.sex === 'male' }, 'Male')))),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save settings'),
      h('span', { class: 'muted', text: `Heart-rate zones use ${mh.value} bpm (${mh.basis === 'setting' ? 'your setting' : mh.basis === 'age' ? 'from birth year, Tanaka: 208 − 0.7 × age' : mh.basis === 'workouts' ? 'estimated from workouts' : 'default'}).` })));
  root.append(section('Settings', null, form));

  // ---------------------------------------------------------- diagnostics
  const diag = ctx.diag;
  const diagPanel = h('div', { class: 'panel', style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  if (!diag || isSample) diagPanel.append(h('p', { class: 'muted', style: { margin: 0 }, text: 'After an import, a format report (file names, record types and counts, never your values) appears here and is saved so Claude can fix anything your watch exports differently.' }));
  else {
    const types = Object.entries(diag.health?.types || {}).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([t, n]) => `${t}×${n}`).join(', ');
    const unknown = Object.keys(diag.health?.unknownKeys || {}).slice(0, 14).join(', ');
    diagPanel.append(h('dl', { class: 'kv' },
      h('dt', { text: 'Files read' }), h('dd', { text: `${Object.keys(diag.files || {}).length}` }),
      h('dt', { text: 'Parse problems' }), h('dd', { text: `${diag.parseErrors || 0} elements skipped` }),
      h('dt', { text: 'Workouts' }), h('dd', { text: `${diag.counts?.workouts ?? 0} (${diag.workoutsDuplicated || 0} duplicates merged, ${diag.workoutsRejected || 0} unreadable)` }),
      h('dt', { text: 'Health record types' }), h('dd', { class: 'mono', text: types || '—' }),
      h('dt', { text: 'Not yet used' }), h('dd', { class: 'mono', text: unknown || 'none' }),
      h('dt', { text: 'Track tags' }), h('dd', { class: 'mono', text: Object.keys(diag.motionTags || {}).join(', ') || '—' })));
  }
  root.append(section('Format report', null, diagPanel));

  // ---------------------------------------------------------- delete
  const del = h('div', { class: 'panel', style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  const step1 = h('button', { class: 'btn danger', type: 'button', disabled: isSample || !runtime }, 'Delete all my data…');
  const confirmRow = h('div', { class: 'btn-row', hidden: true },
    h('span', { text: `This removes every imported day, workout, track and setting from ${app ? 'this app' : 'this artifact'}. It cannot be undone.` }),
    h('button', { class: 'btn danger', type: 'button', onclick: async (e) => {
      e.target.disabled = true;
      await ctx.actions.deleteAll();
    } }, 'Yes, delete everything'),
    h('button', { class: 'btn', type: 'button', onclick: () => { confirmRow.hidden = true; step1.hidden = false; } }, 'Cancel'));
  step1.addEventListener('click', () => { step1.hidden = true; confirmRow.hidden = false; });
  del.append(step1, confirmRow);
  root.append(section('Delete', null, del));
}
