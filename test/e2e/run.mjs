// End-to-end check of the built page in Chromium.
//   npm run build && npm run fixture && npm run test:e2e
// CDN scripts are served from node_modules (this container cannot reach CDNs);
// the claude.ai runtime is absent, so the page uses its in-memory fallback.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = resolve('.');
const FIXTURE = resolve('test/fixtures/out/huawei-export-test.zip');
const SHOTS = resolve('screenshots');
mkdirSync(SHOTS, { recursive: true });
if (!existsSync(FIXTURE)) throw new Error('Run `npm run fixture` first');

const html = readFileSync(resolve('dist/gt2-logbook.html'), 'utf8');
// Wrap like the artifact publisher does.
const page0 = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${html}</body></html>`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page0);
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const LIBS = {
  'cdnjs.cloudflare.com': readFileSync(resolve(ROOT, 'node_modules/d3/dist/d3.min.js')),
  'cdn.jsdelivr.net': readFileSync(resolve(ROOT, 'node_modules/@zip.js/zip.js/dist/zip-native.min.js')),
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errors = [];

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (LIBS[u.hostname]) return route.fulfill({ status: 200, contentType: 'text/javascript', body: LIBS[u.hostname] });
    if (u.hostname.includes('fonts.')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return { ctx, page };
}

const step = (name) => console.log(`• ${name}`);
process.on('exit', () => { if (errors.length) console.error('Browser errors so far:\n' + errors.join('\n')); });

// ---------------------------------------------------------------- desktop, light
const { ctx, page } = await newPage();
await page.goto(url);
step('sample data loads');
await page.waitForSelector('.chip.sample', { timeout: 30000 });
await page.waitForSelector('.dial svg');
await page.waitForTimeout(600);
await page.screenshot({ path: `${SHOTS}/01-overview-sample.png`, fullPage: true });

step('wrong password is reported');
await page.goto(url + '#data');
await page.waitForSelector('#dropzone');
await page.setInputFiles('#zip-file', FIXTURE);
await page.fill('#zip-password', 'nope');
await page.getByRole('button', { name: 'Import', exact: true }).click();
await page.waitForSelector('.msg.err', { timeout: 30000 });
const errText = await page.textContent('.msg.err');
assert.match(errText, /Wrong password/i, errText);

step('correct password imports the fixture');
await page.fill('#zip-password', 'test1234');
await page.getByRole('button', { name: 'Import', exact: true }).click();
await page.waitForSelector('.msg.ok', { timeout: 120000 });
const okText = await page.textContent('.msg.ok');
console.log('  ', okText.replace(/\s+/g, ' ').slice(0, 200));
const plan = JSON.parse(readFileSync(FIXTURE.replace(/\.zip$/, '.plan.json'), 'utf8'));
assert.match(okText, new RegExp(`Read ${plan.workouts} workouts`), okText);
assert.equal(await page.$('.chip.sample'), null, 'sample chip gone');
await page.screenshot({ path: `${SHOTS}/02-data-imported.png`, fullPage: true });

const tabs = ['overview', 'activity', 'workouts', 'sleep', 'heart', 'records', 'ask'];
for (const [i, t] of tabs.entries()) {
  step(`tab ${t}`);
  await page.goto(url + '#' + t);
  await page.waitForTimeout(700);
  const msgErr = await page.$('.msg.err');
  assert.equal(msgErr, null, `${t} rendered an error: ${msgErr && (await msgErr.textContent())}`);
  if (['overview', 'activity', 'workouts', 'sleep', 'heart'].includes(t)) {
    const svgs = await page.$$eval('.chart svg, .chart canvas', (els) => els.length);
    assert.ok(svgs > 0, `${t} has charts`);
  }
  await page.screenshot({ path: `${SHOTS}/${String(i + 3).padStart(2, '0')}-${t}.png`, fullPage: true });
}

step('period presets change the range');
await page.goto(url + '#activity');
await page.click('.seg button:has-text("1Y")');
await page.waitForTimeout(400);
await page.click('.seg button:has-text("30D")');
await page.waitForTimeout(300);

step('an empty period points to where the data is');
await page.goto(url + '#workouts');
await page.click('.seg button:has-text("Custom")');
await page.fill('#range-from', '2020-01-01');
await page.fill('#range-to', '2020-01-31');
await page.dispatchEvent('#range-to', 'change');
await page.waitForSelector('.empty-state:has-text("Your workouts run from")');
await page.getByRole('button', { name: 'Show that period' }).click();
await page.waitForSelector('tbody tr.clickable');
await page.click('.seg button:has-text("1Y")');

step('route explorer: hover names a route, wheel zooms, click opens it');
await page.goto(url + '#workouts');
await page.waitForSelector('.panel:has(#weekly-distance) svg path');
await (await page.waitForSelector('.panel:has(#all-routes) canvas')).scrollIntoViewIfNeeded();
await page.waitForTimeout(800); // full tracks replace the outlines
/** Count of drawn pixels and the page position of the most opaque one. */
const routePixels = () => page.$eval('.panel:has(#all-routes) canvas', (c) => {
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let n = 0, best = -1, at = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (!data[i]) continue;
    n++;
    if (data[i] > best) { best = data[i]; at = (i - 3) / 4; }
  }
  const r = c.getBoundingClientRect();
  return { n, hit: [r.left + ((at % c.width) + 0.5) * (r.width / c.width), r.top + (Math.floor(at / c.width) + 0.5) * (r.height / c.height)] };
});
const drawn = await routePixels();
assert.ok(drawn.n > 200, `routes drawn (${drawn.n} px)`);
await page.mouse.move(...drawn.hit);
await page.waitForFunction(() => document.getElementById('tip')?.style.display === 'block' && /Distance/.test(document.getElementById('tip').textContent));
const mapBox = await (await page.$('.panel:has(#all-routes) canvas')).boundingBox();
await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
await page.mouse.wheel(0, -800);
await page.waitForTimeout(400);
const zoomed = await routePixels();
assert.notEqual(zoomed.n, drawn.n, 'the wheel zooms the map');
await page.screenshot({ path: `${SHOTS}/11-route-explorer-zoomed.png` });
await page.mouse.move(...zoomed.hit);
await page.waitForTimeout(100);
await page.mouse.click(...zoomed.hit);
await page.waitForFunction(() => location.hash.startsWith('#workout-'), null, { timeout: 5000 });

step('workout detail with route and splits');
await page.goto(url + '#workouts');
await page.waitForSelector('tbody tr.clickable');
const rows = await page.$$('tbody tr.clickable');
// pick an outdoor run with GPS (first row with a thumbnail path)
let opened = false;
for (const r of rows) {
  const hasPath = await r.$('svg.thumb path');
  const txt = await r.textContent();
  if (hasPath && /Outdoor run/.test(txt)) { await r.click(); opened = true; break; }
}
assert.ok(opened, 'found a run with a route');
await page.waitForSelector('#route', { timeout: 15000 });
await page.waitForTimeout(600);
const splitRows = await page.$$eval('text=Splits', (els) => els.length);
assert.ok(splitRows > 0, 'splits shown');
const training = await page.textContent('#training-stats');
assert.match(training, /Aerobic training effect/, training);
assert.match(training, /Ground contact/, training);
await page.screenshot({ path: `${SHOTS}/10-workout-detail.png`, fullPage: true });
const routeSvg = await page.$('.panel:has(#route) svg');
await routeSvg.scrollIntoViewIfNeeded();
const routeBox = await routeSvg.boundingBox();
await page.mouse.move(routeBox.x + routeBox.width / 2, routeBox.y + routeBox.height / 2);
await page.mouse.wheel(0, -500);
await page.waitForTimeout(300);
assert.match(await page.$eval('.panel:has(#route) svg > g', (g) => g.getAttribute('transform') || ''), /scale\(/, 'the route map zooms');

step('records show running fitness');
await page.goto(url + '#records');
await page.waitForSelector('#running-fitness');
assert.match(await page.textContent('#running-fitness'), /Predicted race times[\s\S]*5 km[\s\S]*Lactate threshold/);
await page.waitForSelector('.panel:has(#predictions) svg path[stroke="var(--run)"]');
await page.screenshot({ path: `${SHOTS}/12-running-fitness.png`, fullPage: true });
await page.goBack();

step('table view toggle');
await page.click('button:has-text("Table") >> nth=0');
await page.waitForSelector('.table-wrap table');

await ctx.close();

// ---------------------------------------------------------------- dark + phone
step('dark mode and phone width');
const { ctx: c2, page: p2 } = await newPage({ viewport: { width: 400, height: 860 }, colorScheme: 'dark', deviceScaleFactor: 2 });
await p2.goto(url);
await p2.waitForSelector('.chip.sample', { timeout: 30000 });
await p2.waitForTimeout(600);
await p2.screenshot({ path: `${SHOTS}/20-phone-dark-overview.png`, fullPage: true });
const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert.ok(overflow <= 1, `no horizontal page scroll (overflow ${overflow}px)`);
for (const t of ['sleep', 'workouts', 'records', 'data']) {
  await p2.goto(url + '#' + t);
  await p2.waitForTimeout(600);
  const ov = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(ov <= 1, `${t}: no horizontal page scroll (overflow ${ov}px)`);
  await p2.screenshot({ path: `${SHOTS}/21-phone-dark-${t}.png`, fullPage: true });
}
await c2.close();

// ---------------------------------------------------------------- Google Drive sync
// A fake claude.ai runtime: no db (in-memory store), and a "Google Drive"
// connector answering with the shapes observed on the real one. Synthetic files.
function fakeRuntime({ perm, failCode }) {
  const FOLDER = 'application/vnd.google-apps.folder';
  const pad = (n) => String(n).padStart(2, '0');
  const day = (back) => { const d = new Date(); d.setDate(d.getDate() - back); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };
  const csv = (header, rows) => [header, ...rows.map(([d, t, v]) => `${d} ${t},${t},${v}`)].join('\n') + '\n';
  const files = [
    { id: 'wkSteps', parentId: 'fSteps', title: 'Passi weekly Huawei Health.csv', modifiedTime: '2026-01-01T10:00:00.000Z',
      text: csv('Data,Orario,Passi', [[day(2), '20:00:00', 55], [day(1), '08:00:00', 120]]) },
    { id: 'dSteps', parentId: 'fSteps', title: `Passi ${day(1)} Huawei Health.csv`, modifiedTime: '2026-01-01T10:01:00.000Z',
      text: csv('Data,Orario,Passi', [[day(1), '08:00:00', 120], [day(1), '08:01:00', 110], [day(1), '12:30:00', 70]]) },
    { id: 'dHr', parentId: 'fHr', title: `Freq. cardiaca ${day(1)} Huawei Health.csv`, modifiedTime: '2026-01-01T10:02:00.000Z',
      text: csv('Data,Orario,Frequenza cardiaca,Origine', [[day(1), '10:00:00', '60,'], [day(1), '10:10:00', '70,']]) },
    // Same day from another source: must not be added to the watch's steps.
    { id: 'hcSteps', parentId: 'fSteps', title: `Passi ${day(1)} Health Connect.csv`, modifiedTime: '2026-01-01T10:03:00.000Z',
      text: csv('Data,Orario,Passi', [[day(1), '10:22:47', 900]]) },
  ];
  const folders = [{ id: 'fSteps', title: 'Health Sync Passi' }, { id: 'fHr', title: 'Health Sync Freq. cardiaca' }];
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  window.__driveCalls = [];
  const answer = (tool, input) => {
    if (tool === 'search_files') {
      if (input.query.startsWith("title contains 'Health Sync'")) return { files: folders.map((f) => ({ ...f, mimeType: FOLDER })) };
      const parents = [...input.query.matchAll(/parentId = '([^']+)'/g)].map((m) => m[1]);
      const after = /modifiedTime > '([^']+)'/.exec(input.query)?.[1];
      const list = files.filter((f) => parents.includes(f.parentId) && (!after || Date.parse(f.modifiedTime) > Date.parse(after)));
      return list.length ? { files: list.map(({ text, ...m }) => ({ ...m, mimeType: 'text/troff', fileExtension: 'csv', fileSize: String(text.length) })) } : {};
    }
    const f = files.find((x) => x.id === input.fileId);
    return { content: b64(f.text), id: f.id, mimeType: 'text/troff', title: f.title };
  };
  const mcp = {
    async listTools() {
      return { servers: [{ server: 'Google Drive', authStatus: perm === 'granted' ? 'connected' : 'unknown', tools: [{ name: 'search_files', description: '' }, { name: 'download_file_content', description: '' }] }] };
    },
    async callTool(server, tool, input) {
      window.__driveCalls.push(tool);
      if (server !== 'Google Drive') throw { code: 'not_in_manifest', message: 'not declared' };
      if (failCode) throw { code: failCode, message: 'fake failure' };
      const payload = answer(tool, input);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], payload };
    },
  };
  const permissions = { async state() { return perm; }, async request() { return {}; }, async manage() {} };
  window.claude = { use: async (name) => (name === 'mcp' ? mcp : name === 'permissions' ? permissions : null) };
}

step('Drive: allowed connector syncs on open and merges overlapping files');
{
  const { ctx: c3, page: p3 } = await newPage();
  await c3.addInitScript(fakeRuntime, { perm: 'granted' });
  await p3.goto(url);
  await p3.waitForSelector('#status-chips .chip:has-text("Health Sync")', { timeout: 30000 });
  assert.equal(await p3.$('.chip.sample'), null, 'Drive data replaces the sample data');
  await p3.goto(url + '#data');
  await p3.waitForSelector('#drive-summary');
  const summary = await p3.textContent('#drive-summary');
  assert.match(summary, /2 days updated \(steps, heart rate\)/, summary);
  assert.match(await p3.textContent('#drive-status'), /Connected/);
  await p3.screenshot({ path: `${SHOTS}/30-drive-synced.png`, fullPage: true });
  const before = await p3.evaluate(() => window.__driveCalls.length);
  await p3.click('#drive-sync');
  await p3.waitForSelector('.toast:has-text("up to date")', { timeout: 15000 });
  const again = await p3.evaluate((n) => window.__driveCalls.slice(n), before);
  assert.ok(!again.includes('download_file_content'), `nothing new is downloaded (${again.join(', ')})`);
  for (const t of ['activity', 'heart']) {
    await p3.goto(url + '#' + t);
    await p3.waitForTimeout(500);
    assert.equal(await p3.$('.msg.err'), null, `${t} renders with Drive data`);
  }
  await c3.close();
}

step('Drive: first sync waits for the button');
{
  const { ctx: c4, page: p4 } = await newPage({ viewport: { width: 400, height: 860 } });
  await c4.addInitScript(fakeRuntime, { perm: 'prompt' });
  await p4.goto(url + '#data');
  await p4.waitForSelector('#drive-sync:has-text("Connect and sync")', { timeout: 30000 });
  assert.ok(await p4.$('.chip.sample'), 'no automatic sync before consent');
  assert.equal(await p4.evaluate(() => window.__driveCalls.length), 0);
  await p4.screenshot({ path: `${SHOTS}/31-drive-prompt-phone.png`, fullPage: true });
  await p4.click('#drive-sync');
  await p4.waitForSelector('#drive-summary', { timeout: 15000 });
  assert.match(await p4.textContent('#drive-summary'), /2 days updated/);
  assert.equal(await p4.$('.chip.sample'), null);
  const ov = await p4.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(ov <= 1, `data tab: no horizontal page scroll (overflow ${ov}px)`);
  await c4.close();
}

step('Drive: lapsed connector shows how to fix it');
{
  const { ctx: c5, page: p5 } = await newPage();
  await c5.addInitScript(fakeRuntime, { perm: 'granted', failCode: 'needs_reauth' });
  await p5.goto(url + '#data');
  await p5.waitForSelector('#drive-error', { timeout: 30000 });
  assert.match(await p5.textContent('#drive-error'), /Reconnect Google Drive/);
  assert.match(await p5.textContent('#drive-status'), /Reconnect/);
  assert.ok(await p5.$('.chip.sample'), 'sample data stays when the sync fails');
  await p5.screenshot({ path: `${SHOTS}/32-drive-reauth.png`, fullPage: true });
  await c5.close();
}

await browser.close();
server.close();
if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('E2E passed');
