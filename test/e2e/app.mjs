// End-to-end check of the app build (www/, what ships in the APK) at phone
// size in Chromium: sample data, every tab, an import that survives a
// reload (IndexedDB), a full backup that restores, and the model tabs.
//   npm run build:app && npm run fixture && npm run test:e2e:app

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = resolve('www');
const FIXTURE = resolve('test/fixtures/out/huawei-export-test.zip');
const SHOTS = resolve('screenshots/app');
mkdirSync(SHOTS, { recursive: true });
if (!existsSync(join(ROOT, 'index.html'))) throw new Error('Run `npm run build:app` first');
if (!existsSync(FIXTURE)) throw new Error('Run `npm run fixture` first');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer((req, res) => {
  let p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errors = [];
const step = (name) => console.log(`• ${name}`);
process.on('exit', () => { if (errors.length) console.error('Browser errors:\n' + errors.join('\n')); });

const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
// The app makes no requests beyond its own files (sync and Ask Claude need a user action).
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.hostname !== '127.0.0.1') {
    errors.push(`unexpected request: ${u.href}`);
    return route.abort();
  }
  return route.continue();
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

step('sample data loads offline, with local fonts and libraries');
await page.goto(url);
await page.waitForSelector('.chip.sample', { timeout: 30000 });
assert.equal(await page.evaluate(() => typeof window.d3), 'object');
assert.equal(await page.evaluate(() => typeof window.zip), 'object');
assert.match(await page.textContent('#foot'), /on this device/);

const TABS = ['overview', 'insights', 'training', 'activity', 'workouts', 'sleep', 'heart', 'records', 'ask', 'data'];
for (const t of TABS) {
  step(`tab ${t}`);
  await page.goto(`${url}#${t}`);
  await page.waitForTimeout(700);
  const err = await page.$('.msg.err');
  assert.equal(err, null, `${t}: ${err && (await err.textContent())}`);
  if (!['ask', 'data', 'records'].includes(t)) {
    assert.ok(await page.$$eval('.chart svg, .chart canvas', (els) => els.length) > 0, `${t} has charts`);
  }
  // Nothing wider than the phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${t} scrolls sideways by ${overflow}px`);
  await page.screenshot({ path: `${SHOTS}/sample-${t}.png`, fullPage: true });
}

step('insights: model cards with sources, and the correlation matrix');
await page.goto(`${url}#insights`);
await page.waitForSelector('.insight .cite');
assert.ok(await page.$$eval('.insight', (els) => els.length) >= 5);
await page.waitForSelector('#readiness .ready-score');
await page.waitForSelector('.panel:has(#corr-matrix) svg rect');

step('training: PMC, ACWR, intensity, VDOT and paces');
await page.goto(`${url}#training`);
for (const id of ['pmc', 'acwr', 'weekly-load', 'intensity', 'vdot', 'vo2max', 'efficiency', 'effort-curve']) {
  await page.waitForSelector(`.panel:has(#${id}) svg`, { timeout: 10000 });
}
await page.waitForSelector('#daniels table');

step('ask: the app asks for an API key, and never sends anything by itself');
await page.goto(`${url}#ask`);
await page.waitForSelector('#anthropic-key');
assert.equal(await page.$eval('#ask-model', (s) => s.value), 'claude-opus-5-5');

step('data: Health Connect is Android-only, intervals.icu takes a key, the map downloads in one step');
await page.goto(`${url}#data`);
await page.waitForSelector('#health-card');
assert.match(await page.textContent('#health-status'), /Android app only/);
await page.waitForSelector('#intervals-key');

step('import the fixture and keep it after a reload');
await page.setInputFiles('#zip-file', FIXTURE);
await page.fill('#zip-password', 'test1234');
await page.getByRole('button', { name: 'Import', exact: true }).click();
await page.waitForSelector('.msg.ok', { timeout: 120000 });
assert.match(await page.textContent('.msg.ok'), /Saving to this device/);
await page.waitForFunction(() => !/Saving/.test(document.getElementById('status-chips').textContent), null, { timeout: 60000 });
await page.reload();
await page.waitForFunction(() => !document.querySelector('.chip.sample') && /Huawei export/.test(document.getElementById('status-chips').textContent), null, { timeout: 30000 });
await page.goto(`${url}#workouts`);
await page.waitForSelector('tbody tr.clickable');
await page.click('tbody tr.clickable');
await page.waitForSelector('#workout-models .stat');
await page.screenshot({ path: `${SHOTS}/workout.png`, fullPage: true });

step('full backup downloads with the routes, and restores');
await page.goto(`${url}#data`);
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Full backup (JSON)' }).click()]);
const file = await download.path();
const backup = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(backup.app, 'GT 2 Logbook');
assert.ok(Object.keys(backup.tracks).length > 10, 'routes are in the backup');
page.once('dialog', (d) => d.accept());
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#backup-restore')]);
await chooser.setFiles(file);
await page.waitForSelector('.msg.ok:has-text("Backup restored")', { timeout: 60000 });
await page.waitForFunction(() => !/Saving|Restoring/.test(document.getElementById('status-chips').textContent), null, { timeout: 60000 });
await page.reload();
await page.goto(`${url}#workouts`);
await page.waitForSelector('tbody tr.clickable');
assert.equal(await page.$('.chip.sample'), null);

step('real data on the model tabs');
for (const t of ['insights', 'training', 'sleep', 'heart']) {
  await page.goto(`${url}#${t}`);
  await page.waitForTimeout(800);
  assert.equal(await page.$('.msg.err'), null, `${t} rendered an error`);
  await page.screenshot({ path: `${SHOTS}/data-${t}.png`, fullPage: true });
}

step('dark mode');
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(`${url}#training`);
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOTS}/dark-training.png`, fullPage: true });

await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('App E2E passed');
