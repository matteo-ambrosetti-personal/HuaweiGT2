import { h, section, clear, toast } from '../ui.js';
import { fmtDate, fmtInt } from '../../lib/format.js';
import { SOURCE_LABELS, datasetRange } from '../../lib/model.js';
import { estimateMaxHr } from '../../lib/stats.js';
import { skippedFolders } from '../sync-drive.js';

function guide(title, steps, open = false) {
  return h('details', { class: 'guide', open },
    h('summary', { text: title }),
    h('ol', { class: 'steps-list', style: { marginTop: '8px' } }, steps.map((s) => h('li', null, ...s))));
}

const when = (iso) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
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

export function renderData(root, ctx) {
  const { meta, isSample, runtime, store } = ctx;

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
    h('p', { class: 'muted', text: 'Or choose the extracted folder. Everything is decrypted and read in your browser.' }),
    h('div', { class: 'btn-row', style: { justifyContent: 'center' } },
      h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Choose ZIP'),
      h('button', { class: 'btn', type: 'button', onclick: () => folderInput.click() }, 'Choose folder')),
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
  if (flash) (flash.target === 'files' ? actResult : result).append(h('div', { class: 'msg ok' }, h('strong', { text: flash.title }), flash.text));
  root.append(section('Import your Huawei export', 'The complete history: workouts with GPS, steps, heart rate, sleep, SpO2 and stress.', importPanel));
  root.append(section('Add individual files', null, filesPanel));

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
  root.append(section('Automatic updates', 'Optional. Keep the export for full history; these fill in new days between exports.', h('div', { class: 'grid' }, drive, bridge)));

  // ---------------------------------------------------------- history
  const imports = (meta.imports || []).slice().reverse();
  const cov = datasetRange(ctx.ds);
  const hist = h('div', { class: 'panel' },
    h('dl', { class: 'kv' },
      h('dt', { text: 'Storage' }), h('dd', { text: store?.kind === 'cloud' ? 'Private claude.ai storage (only you can read it)' : 'This browser tab only (not saved)' }),
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
    h('p', { style: { margin: 0 }, text: 'Your browser asks before saving each file. GPX and TCX files come zipped; tracks are simplified to at most 1,000 points.' }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportCsv('workouts') }, 'Workouts CSV'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportCsv('daily') }, 'Daily metrics CSV'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportRoutesInRange('gpx') }, 'GPX routes (selected period)'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportRoutesInRange('tcx') }, 'TCX (selected period)'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.actions.exportBackup() }, 'Full backup (JSON)')));
  root.append(section('Export', null, ex));

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
    });
    toast('Settings saved');
  } },
    h('div', { class: 'fields' },
      f('set-steps', 'Daily step goal', s.stepGoal),
      f('set-sleep', 'Sleep goal (hours)', (s.sleepGoalMin / 60).toFixed(1), { inputmode: 'decimal' }),
      f('set-maxhr', 'Max heart rate (bpm)', s.maxHr, { placeholder: `Estimated ${mh.value}` }),
      f('set-birth', 'Birth year (for zones)', s.birthYear, { placeholder: 'Optional' })),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save settings'),
      h('span', { class: 'muted', text: `Heart-rate zones use ${mh.value} bpm (${mh.basis === 'setting' ? 'your setting' : mh.basis === 'age' ? 'from birth year' : mh.basis === 'workouts' ? 'estimated from workouts' : 'default'}).` })));
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
    h('span', { text: 'This removes every imported day, workout, track and setting from this artifact. It cannot be undone.' }),
    h('button', { class: 'btn danger', type: 'button', onclick: async (e) => {
      e.target.disabled = true;
      await ctx.actions.deleteAll();
    } }, 'Yes, delete everything'),
    h('button', { class: 'btn', type: 'button', onclick: () => { confirmRow.hidden = true; step1.hidden = false; } }, 'Cancel'));
  step1.addEventListener('click', () => { step1.hidden = true; confirmRow.hidden = false; });
  del.append(step1, confirmRow);
  root.append(section('Delete', null, del));
}
