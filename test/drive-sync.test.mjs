import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncDrive, emptyIndex, fitIndex, protectPruned, skippedFolders, driveErrorCopy, decodeBase64Text } from '../src/app/sync-drive.js';
import { emptyDataset, mergeDataset } from '../src/lib/model.js';
import { toGpx } from '../src/lib/gpx.js';
import { analyzeSeries, emptySeries } from '../src/lib/track.js';

// A fake "Google Drive" connector with the response shapes observed on the
// real one. All file contents are synthetic.
const FOLDER = 'application/vnd.google-apps.folder';
const STEPS = 'fStepsFolder01';
const HR = 'fHeartFolder02';

function fakeDrive(files = [], folders = { [STEPS]: 'Health Sync Passi', [HR]: 'Health Sync Freq. cardiaca' }) {
  const drive = { files, folders, calls: [], broken: new Set(), failNext: [] };
  const page = (list, input, size) => {
    const from = Number(String(input.pageToken || 'p0').slice(1));
    const slice = list.slice(from, from + size);
    if (!slice.length) return {};
    // Like the real backend, hand out a token even when nothing is left.
    return { files: slice, nextPageToken: `p${from + size}` };
  };
  drive.call = async (tool, input) => {
    drive.calls.push({ tool, input });
    const fail = drive.failNext.shift();
    if (fail) throw fail;
    if (tool === 'search_files') {
      const q = input.query;
      if (q.startsWith("title contains 'Health Sync'")) {
        const list = Object.entries(drive.folders).map(([id, title]) => ({ id, title, mimeType: FOLDER, modifiedTime: '2026-03-01T00:00:00.000Z' }));
        return page(list, input, 2);
      }
      const parents = [...q.matchAll(/parentId = '([^']+)'/g)].map((m) => m[1]);
      const after = /modifiedTime > '([^']+)'/.exec(q)?.[1];
      const exact = /modifiedTime = '([^']+)'/.exec(q)?.[1];
      let list = drive.files.filter((f) => parents.includes(f.parentId));
      if (after) list = list.filter((f) => Date.parse(f.modifiedTime) > Date.parse(after));
      if (exact) list = list.filter((f) => f.modifiedTime === exact);
      const meta = list.map(({ text, ...m }) => ({ ...m, mimeType: 'text/troff', fileExtension: m.title.split('.').pop(), fileSize: String(text.length) }));
      return page(meta, input, input.pageSize || 100);
    }
    if (tool === 'download_file_content') {
      const f = drive.files.find((x) => x.id === input.fileId);
      if (!f || drive.broken.has(f.id)) throw Object.assign(new Error('File not found'), { code: 'tool_error' });
      return { content: Buffer.from(f.text, 'utf8').toString('base64'), id: f.id, mimeType: 'text/troff', title: f.title };
    }
    throw Object.assign(new Error('unknown tool'), { code: 'bad_request' });
  };
  drive.downloads = () => drive.calls.filter((c) => c.tool === 'download_file_content').map((c) => c.input.fileId);
  drive.reset = () => { drive.calls.length = 0; };
  return drive;
}

const stepsCsv = (rows) => ['Data,Orario,Passi', ...rows.map(([d, t, v]) => `${d} ${t},${t},${v}`)].join('\n') + '\n';
const hrCsv = (rows) => ['Data,Orario,Frequenza cardiaca,Origine', ...rows.map(([d, t, v]) => `${d} ${t},${t},${v},`)].join('\n') + '\n';
const file = (id, parentId, title, modifiedTime, text) => ({ id, parentId, title, modifiedTime, text });
const noSleep = async () => {};

function weeklyAndDaily() {
  return [
    file('wk10', STEPS, 'Passi 10-2026 Huawei Health.csv', '2026-03-08T20:00:00.000Z', stepsCsv([
      ['2026.03.07', '09:00:00', 100], ['2026.03.08', '10:00:00', 50],
    ])),
    file('d0308', STEPS, 'Passi 2026.03.08 Huawei Health.csv', '2026-03-08T20:01:00.000Z', stepsCsv([
      ['2026.03.08', '10:00:00', 50], ['2026.03.08', '10:01:00', 25],
    ])),
    file('h0308', HR, 'Freq. cardiaca 2026.03.08 Huawei Health.csv', '2026-03-08T20:02:00.000Z', hrCsv([
      ['2026.03.08', '10:00:00', 70], ['2026.03.08', '10:10:00', 90],
    ])),
  ];
}

test('first sync reads every file and counts overlapping minutes once', async () => {
  const drive = fakeDrive(weeklyAndDaily());
  const { fragment, index, report } = await syncDrive({ call: drive.call, index: null, sleep: noSleep });
  assert.equal(report.folders, 2);
  assert.equal(report.listed, 3);
  assert.equal(report.changed, 3);
  assert.equal(fragment.days['2026-03-07'].steps, 100);
  assert.equal(fragment.days['2026-03-08'].steps, 75); // 50 appears in both files
  assert.equal(fragment.days['2026-03-08'].hrAvg, 80);
  assert.deepEqual(index.files.wk10.slice(1), ['steps', '2026-03-07', '2026-03-08', 'Huawei Health']);
  assert.deepEqual(index.files.d0308.slice(1), ['steps', '2026-03-08', '2026-03-08', 'Huawei Health']);
  assert.equal(index.cursor, Date.parse('2026-03-08T20:02:00.000Z'));
  assert.deepEqual(report.metrics.sort(), ['heart rate', 'steps']);
  // the first listing has no time filter and folder ids are the only query input
  const fileQuery = drive.calls.find((c) => c.tool === 'search_files' && c.input.query.includes('parentId')).input.query;
  assert.ok(!fileQuery.includes('modifiedTime'), fileQuery);
});

test('a sync with nothing new downloads nothing', async () => {
  const drive = fakeDrive(weeklyAndDaily());
  const first = await syncDrive({ call: drive.call, index: null, sleep: noSleep });
  drive.reset();
  const second = await syncDrive({ call: drive.call, index: first.index, sleep: noSleep });
  assert.deepEqual(drive.downloads(), []);
  assert.deepEqual(second.fragment.days, {});
  assert.equal(second.index.cursor, first.index.cursor);
  const fileQuery = drive.calls.find((c) => c.input.query?.includes('parentId')).input.query;
  assert.match(fileQuery, /modifiedTime > '2026-03-08T19:57:00Z'/); // cursor minus 5 minutes
});

test('a file rewritten in place is merged with the other files covering its day', async () => {
  const drive = fakeDrive(weeklyAndDaily());
  const first = await syncDrive({ call: drive.call, index: null, sleep: noSleep });
  const daily = drive.files.find((f) => f.id === 'd0308');
  daily.modifiedTime = '2026-03-08T23:00:00.000Z';
  daily.text = stepsCsv([['2026.03.08', '10:00:00', 50], ['2026.03.08', '10:01:00', 25], ['2026.03.08', '18:00:00', 30]]);
  drive.reset();
  const { fragment, index } = await syncDrive({ call: drive.call, index: first.index, sleep: noSleep });
  assert.deepEqual(drive.downloads().sort(), ['d0308', 'wk10']); // the weekly file shares 8 March
  assert.deepEqual(Object.keys(fragment.days), ['2026-03-08']);
  assert.equal(fragment.days['2026-03-08'].steps, 105);
  assert.equal(fragment.days['2026-03-08'].hrAvg, undefined); // heart rate untouched
  assert.equal(index.files.d0308[0], Date.parse('2026-03-08T23:00:00.000Z'));
});

test('a second file with the same name adds its minutes', async () => {
  const drive = fakeDrive(weeklyAndDaily());
  const first = await syncDrive({ call: drive.call, index: null, sleep: noSleep });
  drive.files.push(file('d0308b', STEPS, 'Passi 2026.03.08 Huawei Health.csv', '2026-03-09T06:00:00.000Z', stepsCsv([['2026.03.08', '21:00:00', 40]])));
  const { fragment } = await syncDrive({ call: drive.call, index: first.index, sleep: noSleep });
  assert.equal(fragment.days['2026-03-08'].steps, 115);
});

test('a deleted file leaves the index; an unreadable one waits for a retry', async () => {
  const drive = fakeDrive(weeklyAndDaily());
  const first = await syncDrive({ call: drive.call, index: null, sleep: noSleep });
  const daily = drive.files.find((f) => f.id === 'd0308');
  daily.modifiedTime = '2026-03-09T01:00:00.000Z';

  // Weekly file still listed but unreadable: 8 March waits, cursor stays behind the daily file.
  drive.broken.add('wk10');
  const waiting = await syncDrive({ call: drive.call, index: first.index, sleep: noSleep });
  assert.deepEqual(waiting.fragment.days, {});
  assert.equal(waiting.report.failed, 1);
  assert.equal(waiting.index.files.d0308[0], first.index.files.d0308[0]);
  assert.ok(waiting.index.cursor < Date.parse(daily.modifiedTime));

  // Weekly file deleted from Drive: rebuild 8 March from the daily file alone.
  drive.files = drive.files.filter((f) => f.id !== 'wk10');
  const rebuilt = await syncDrive({ call: drive.call, index: waiting.index, sleep: noSleep });
  assert.equal(rebuilt.fragment.days['2026-03-08'].steps, 75);
  assert.equal(rebuilt.index.files.wk10, undefined);
  assert.equal(rebuilt.index.cursor, Date.parse(daily.modifiedTime));
});

test('unknown CSVs are noted once, GPX activities become workouts', async () => {
  const t0 = Date.UTC(2026, 2, 8, 7, 0, 0);
  const s = emptySeries();
  for (let i = 0; i < 300; i++) {
    s.gps.push({ t: t0 + i * 2000, lat: 45 + (i * 6) / 111320, lon: 9, alt: 100, seg: 0 });
    s.hr.push({ t: t0 + i * 2000, v: 140 });
  }
  const w = { id: 'x', label: 'Outdoor run', family: 'run', date: '2026-03-08', start: t0, end: t0 + 600000, duration: 600, distance: 1800 };
  const { track } = analyzeSeries(w, s);
  const ACT = 'fActFolder03';
  const OTHER = 'fOtherFolder04';
  const drive = fakeDrive([
    file('run1', ACT, 'Run 2026-03-08.gpx', '2026-03-08T09:00:00.000Z', toGpx(w, track)),
    file('odd1', OTHER, 'Esempio 2026.03.08 Huawei Health.csv', '2026-03-08T09:01:00.000Z', 'Data,Orario,Valore sconosciuto\n2026.03.08 01:00:00,01:00:00,3\n'),
    file('fit1', ACT, 'Run 2026-03-08.fit', '2026-03-08T09:02:00.000Z', 'binary'),
  ], { [ACT]: 'Health Sync Attività', [OTHER]: 'Health Sync Esempio' });
  const first = await syncDrive({ call: drive.call, index: emptyIndex(), sleep: noSleep });
  const workouts = Object.values(first.fragment.workouts);
  assert.equal(workouts.length, 1);
  assert.equal(workouts[0].id, 'hs-run1');
  assert.equal(workouts[0].source, 'healthsync');
  assert.ok(first.fragment.tracks['hs-run1']);
  const skipped = skippedFolders(first.index);
  assert.deepEqual(skipped.map((x) => [x.folder, x.n]).sort(), [['Health Sync Attività', 1], ['Health Sync Esempio', 1]]);
  assert.equal(skipped.find((x) => x.folder === 'Health Sync Esempio').header, 'Data,Orario,Valore sconosciuto');
  drive.reset();
  await syncDrive({ call: drive.call, index: first.index, sleep: noSleep });
  assert.deepEqual(drive.downloads(), []);
});

test('connector errors: one retry when retryable, otherwise the run is abandoned', async () => {
  const drive = fakeDrive(weeklyAndDaily());
  let slept = 0;
  drive.failNext.push(Object.assign(new Error('busy'), { code: 'server_unavailable', retryable: true, retryAfterMs: 1000 }));
  const ok = await syncDrive({ call: drive.call, index: null, sleep: async (ms) => { slept = ms; } });
  assert.equal(ok.report.changed, 3);
  assert.ok(slept >= 1000);

  const twice = fakeDrive(weeklyAndDaily());
  const busy = () => Object.assign(new Error('busy'), { code: 'server_unavailable', retryable: true });
  twice.failNext.push(busy(), busy());
  await assert.rejects(syncDrive({ call: twice.call, index: null, sleep: noSleep }), { code: 'server_unavailable' });

  const lapsed = fakeDrive(weeklyAndDaily());
  lapsed.failNext.push(null, null, Object.assign(new Error('expired'), { code: 'needs_reauth' }));
  await assert.rejects(syncDrive({ call: lapsed.call, index: null, sleep: noSleep }), { code: 'needs_reauth' });

  const none = fakeDrive([], {});
  const empty = await syncDrive({ call: none.call, index: null, sleep: noSleep });
  assert.equal(empty.report.folders, 0);
  assert.deepEqual(empty.fragment.days, {});
});

test('the index stays small and pruned days are only filled', () => {
  const index = emptyIndex();
  for (let i = 0; i < 4000; i++) {
    const day = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    index.files[`file${i}abcdefghijklmnopqrstuvwxyz`] = [1700000000000 + i, 'steps', day, day];
  }
  const fitted = fitIndex(index);
  assert.ok(JSON.stringify(fitted).length <= 200 * 1024);
  assert.ok(fitted.prunedBefore > '2024-01-01');
  assert.ok(fitted.files.file3999abcdefghijklmnopqrstuvwxyz, 'newest entries are kept');

  const ds = emptyDataset();
  mergeDataset(ds, { days: { '2024-01-02': { steps: 900, stepsHourly: new Array(24).fill(0), activeMin: 0 } } }, 'healthsync');
  const frag = { days: { '2024-01-02': { steps: 100, hrAvg: 60, hrMin: 50, hrMax: 70, hrN: 1, hrHourly: [] }, '2030-01-01': { steps: 5 } } };
  protectPruned(frag, ds, '2025-01-01');
  assert.equal(frag.days['2024-01-02'].steps, undefined);
  assert.equal(frag.days['2024-01-02'].hrAvg, 60);
  assert.equal(frag.days['2030-01-01'].steps, 5);
});

test('each error code has its own copy', () => {
  assert.equal(driveErrorCopy({ code: 'needs_reauth' }).status, 'reauth');
  assert.equal(driveErrorCopy({ code: 'server_not_connected' }).status, 'missing');
  assert.equal(driveErrorCopy({ code: 'not_in_manifest' }).action, 'permissions');
  assert.equal(driveErrorCopy({ code: 'capability_disabled' }).status, 'unavailable');
  assert.equal(driveErrorCopy({ code: 'cancelled' }), null);
  assert.match(driveErrorCopy({ code: 'tool_error', message: 'Quota' }).text, /Quota/);
  assert.equal(driveErrorCopy({ code: 'something_new' }).status, 'error');
  assert.equal(decodeBase64Text(Buffer.from('Attività ✓', 'utf8').toString('base64')), 'Attività ✓');
});

test('watch and Health Connect files for the same day are not added together', async () => {
  const files = weeklyAndDaily();
  files.push(file('hc0308', STEPS, 'Passi 2026.03.08 Health Connect.csv', '2026-03-08T21:00:00.000Z', stepsCsv([
    ['2026.03.08', '10:00:31', 900], ['2026.03.09', '07:00:12', 400],
  ])));
  files.push(file('kcal08', 'fEnergyFolder05', 'Energia bruciata 2026.03.08 Health Connect.csv', '2026-03-08T21:01:00.000Z',
    'Data,Orario,Calorie attive,Calorie a riposo,Calorie totali\n2026.03.08 00:00:00,00:00:00,"0.0","0.0","0.0"\n'));
  const drive = fakeDrive(files, { [STEPS]: 'Health Sync Passi', [HR]: 'Health Sync Freq. cardiaca', fEnergyFolder05: 'Health Sync Energia bruciata' });
  const { fragment, index, report } = await syncDrive({ call: drive.call, index: null, sleep: noSleep });
  assert.equal(fragment.days['2026-03-08'].steps, 75); // the watch's minutes only
  assert.equal(fragment.days['2026-03-09'].steps, 400); // only Health Connect has this day
  assert.equal(fragment.days['2026-03-08'].kcal, undefined); // all-zero calories store nothing
  assert.equal(index.files.hc0308[4], 'Health Connect');
  assert.equal(index.files.d0308[4], 'Huawei Health');
  assert.equal(index.files.kcal08[1], 'kcal');
  assert.deepEqual(skippedFolders(index), []); // calories files are understood, not "not used yet"
  assert.ok(!report.metrics.includes('calories'));

  // A later rewrite of the watch file keeps the Health Connect file apart.
  drive.files.find((f) => f.id === 'd0308').modifiedTime = '2026-03-09T08:00:00.000Z';
  const again = await syncDrive({ call: drive.call, index, sleep: noSleep });
  assert.equal(again.fragment.days['2026-03-08'].steps, 75);
});

test('an index from an older version is rebuilt from scratch', async () => {
  const drive = fakeDrive(weeklyAndDaily());
  const first = await syncDrive({ call: drive.call, index: null, sleep: noSleep });
  drive.reset();
  const again = await syncDrive({ call: drive.call, index: { ...first.index, v: 1 }, sleep: noSleep });
  assert.deepEqual(drive.downloads().sort(), ['d0308', 'h0308', 'wk10']);
  assert.equal(again.fragment.days['2026-03-08'].steps, 75);
  assert.equal(again.index.v, 2);
});
