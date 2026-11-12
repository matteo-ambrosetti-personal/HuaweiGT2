// End-to-end check of the standalone build (dist/web) in Chromium.
//   npm run build && npm run fixture && npm run test:e2e:web
// Served under /lab/gt2-logbook/ as on light-through-the-mirror.com. Every request
// that leaves the local server fails the run, except OpenStreetMap's data service,
// which is answered with the map fixture.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, normalize, join } from 'node:path';
import assert from 'node:assert/strict';

const WEB = resolve('dist/web');
const FIXTURE = resolve('test/fixtures/out/huawei-export-test.zip');
const MAP_FIXTURE = resolve('test/fixtures/out/map-overpass.json');
const SHOTS = resolve('screenshots/web');
mkdirSync(SHOTS, { recursive: true });
if (!existsSync(FIXTURE)) throw new Error('Run `npm run fixture` first');
if (!existsSync(join(WEB, 'index.html'))) throw new Error('Run `npm run build` first');

const BASE = '/lab/gt2-logbook/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const served = [];
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  served.push(path);
  if (!path.startsWith(BASE)) { res.writeHead(404); return res.end(); }
  const rel = normalize(path.slice(BASE.length) || 'index.html');
  const file = join(WEB, rel.endsWith('/') || rel === '.' ? 'index.html' : rel);
  if (!file.startsWith(WEB) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const url = origin + BASE;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errors = [];
const outside = [];
let overpassCalls = 0;

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, ...opts });
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin === origin) return route.continue();
    if (u.hostname === 'overpass-api.de') {
      overpassCalls++;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: readFileSync(MAP_FIXTURE) });
    }
    outside.push(u.href.slice(0, 120));
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return { ctx, page };
}

const step = (name) => console.log(`• ${name}`);
process.on('exit', () => { if (errors.length) console.error('Browser errors so far:\n' + errors.join('\n')); });

// ---------------------------------------------------------------- browser
const { ctx, page } = await newPage();
step('sample data, self-hosted fonts, no Ask Claude');
await page.goto(url);
await page.waitForSelector('.chip.sample', { timeout: 30000 });
await page.waitForSelector('.dial svg');
assert.equal(await page.$('#tabs [data-route="ask"]'), null, 'no Ask Claude tab');
assert.match(await page.textContent('#foot'), /stays in this browser/);
await page.evaluate(() => document.fonts.ready);
assert.ok(await page.evaluate(() => document.fonts.check('700 20px Archivo') && [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Archivo' && f.status === 'loaded')), 'Archivo loaded from fonts/');
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/01-overview-sample.png`, fullPage: true });
await page.goto(url + '#ask');
await page.waitForTimeout(300);
assert.ok(await page.$('.dial svg'), '#ask falls back to the overview');

step('import is stored on the device and survives a reload');
await page.goto(url + '#data');
await page.waitForSelector('#dropzone');
assert.ok(await page.$('button:has-text("Choose folder")'), 'a browser can choose a folder');
await page.setInputFiles('#zip-file', FIXTURE);
await page.fill('#zip-password', 'test1234');
await page.getByRole('button', { name: 'Import', exact: true }).click();
await page.waitForSelector('.msg.ok', { timeout: 120000 });
assert.match(await page.textContent('.msg.ok'), /Saving on this device/);
await page.waitForSelector('.toast:has-text("Saved on this device")', { timeout: 60000 });
const plan = JSON.parse(readFileSync(FIXTURE.replace(/\.zip$/, '.plan.json'), 'utf8'));
await page.reload();
await page.waitForSelector('#status-chips .chip:has-text("Huawei export")', { timeout: 30000 });
assert.equal(await page.$('.chip.sample'), null, 'own data after reload');
assert.equal(await page.$('.chip:has-text("Not saved")'), null);
const contents = await page.textContent('.kv');
assert.match(contents, /This browser, on this device only/, contents);
assert.match(contents, new RegExp(`${plan.workouts} workouts`), contents);
assert.ok(await page.$('#auto-note'), 'automatic updates explained');
assert.equal(await page.$('#drive-card'), null, 'no Google Drive card');

step('a stored route opens after reload');
await page.goto(url + '#workouts');
await page.waitForSelector('tbody tr.clickable');
for (const r of await page.$$('tbody tr.clickable')) {
  if ((await r.$('svg.thumb path')) && /Outdoor run/.test(await r.textContent())) { await r.click(); break; }
}
await page.waitForSelector('#route', { timeout: 15000 });
assert.ok(await page.$('.panel:has(#route) svg, .panel:has(#route) canvas'), 'the route is drawn from the stored track');
assert.ok(await page.$('text=/samples, every/'), 'samples come from the stored track');

step('the map downloads in one step and is kept');
await page.goto(url + '#data');
await page.waitForSelector('#map-fetch');
assert.match(await page.getAttribute('#map-download', 'href'), /^https:\/\/overpass-api\.de\/api\/interpreter\?data=/);
await page.click('#map-fetch');
await page.waitForSelector('#map-card .msg.ok', { timeout: 30000 });
assert.equal(overpassCalls, 1);
assert.match(await page.textContent('#map-card .msg.ok'), /Saved on this device/);
await page.screenshot({ path: `${SHOTS}/02-data.png`, fullPage: true });
await page.reload();
await page.waitForSelector('#map-status');
assert.match(await page.textContent('#map-status'), /On/);

step('exports are ordinary downloads');
const [csv] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Daily metrics CSV")')]);
assert.match(csv.suggestedFilename(), /^gt2-daily-\d{4}-\d{2}-\d{2}\.csv$/);
assert.match(readFileSync(await csv.path(), 'utf8'), /^date,steps,/);
const [zip] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("GPX routes")')]);
assert.match(zip.suggestedFilename(), /\.zip$/);
assert.equal(readFileSync(await zip.path()).subarray(0, 2).toString(), 'PK');

step('offline: the service worker opens the app with no network');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload();
await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15000 });
await page.waitForTimeout(500); // let the fresh copies land in the cache
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('#status-chips .chip:has-text("Huawei export")', { timeout: 30000 });
await page.evaluate(() => document.fonts.ready);
assert.ok(await page.evaluate(() => document.fonts.check('700 20px Archivo')), 'fonts offline too');
await ctx.setOffline(false);
const errorsBefore = errors.length;
const cachedElse = await page.evaluate(async () => {
  await fetch('GT2-Logbook.apk').catch(() => null);
  const names = await caches.keys();
  const urls = (await Promise.all(names.map(async (n) => (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname)))).flat();
  return urls.filter((u) => !/\/(index\.html|manifest\.webmanifest|favicon\.svg|icon-[\w-]+\.png|fonts\/[\w.-]+\.woff2)?$/.test(u));
});
assert.deepEqual(cachedElse, [], 'the service worker caches only the app itself');
await page.waitForTimeout(200);
// The probe above asks for a file dist/web does not have: its 404 is expected.
errors.splice(errorsBefore, errors.length - errorsBefore, ...errors.slice(errorsBefore).filter((e) => !/404 \(Not Found\)/.test(e)));

step('delete all returns to the sample, also after reload');
await page.goto(url + '#data');
await page.click('button:has-text("Delete all my data")');
assert.match(await page.textContent('.btn-row:has(button:has-text("Yes, delete"))'), /from this browser/);
await page.click('button:has-text("Yes, delete everything")');
await page.waitForSelector('.chip.sample', { timeout: 30000 });
await page.reload();
await page.waitForSelector('.chip.sample', { timeout: 30000 });
await ctx.close();

// ---------------------------------------------------------------- the Android app's bridge
step('inside the app: saves go through the bridge in chunks');
{
  const { ctx: c2, page: p2 } = await newPage({ viewport: { width: 400, height: 860 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  await c2.addInitScript(() => {
    const files = {};
    window.__saved = files;
    window.GT2Native = {
      begin(id, name, mime) { files[id] = { name, mime, parts: [] }; },
      append(id, b64) { files[id].parts.push(b64); },
      finish(id) { setTimeout(() => window.GT2NativeSaved(id, files[id].name.endsWith('.json') ? 'cancelled' : 'ok'), 50); },
    };
  });
  await p2.goto(url + '#data');
  await p2.waitForSelector('#dropzone', { timeout: 30000 });
  assert.match(await p2.textContent('#foot'), /stays in this app/);
  assert.equal(await p2.$('button:has-text("Choose folder")'), null, 'no folder picker in the app');
  assert.match(await p2.textContent('.kv'), /This app, on this phone only|This browser tab only/);
  await p2.click('button:has-text("Workouts CSV")');
  await p2.waitForSelector('.toast:has-text("Saved gt2-workouts-")', { timeout: 10000 });
  const saved = await p2.evaluate(() => Object.values(window.__saved));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mime, 'text/csv');
  assert.match(Buffer.from(saved[0].parts.join(''), 'base64').toString('utf8'), /^date,start,sport,/);
  await p2.click('button:has-text("Full backup")');
  await p2.waitForTimeout(400);
  assert.equal(await p2.$('.toast:has-text("did not start")'), null, 'a cancelled save says nothing');
  await p2.screenshot({ path: `${SHOTS}/10-app-dark-data.png`, fullPage: true });
  for (const t of ['overview', 'workouts', 'sleep', 'data']) {
    await p2.goto(url + '#' + t);
    await p2.waitForTimeout(500);
    const ov = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(ov <= 1, `${t}: no horizontal page scroll (overflow ${ov}px)`);
  }
  await p2.goto(url);
  await p2.waitForTimeout(500);
  await p2.screenshot({ path: `${SHOTS}/11-app-dark-overview.png`, fullPage: true });
  await c2.close();
}

await browser.close();
server.close();
assert.deepEqual(outside, [], `requests left the page's origin: ${outside.join(', ')}`);
if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('Standalone E2E passed');
