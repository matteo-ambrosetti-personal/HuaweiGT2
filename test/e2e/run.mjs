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
await page.screenshot({ path: `${SHOTS}/10-workout-detail.png`, fullPage: true });

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
for (const t of ['sleep', 'workouts', 'data']) {
  await p2.goto(url + '#' + t);
  await p2.waitForTimeout(600);
  const ov = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(ov <= 1, `${t}: no horizontal page scroll (overflow ${ov}px)`);
  await p2.screenshot({ path: `${SHOTS}/21-phone-dark-${t}.png`, fullPage: true });
}
await c2.close();

await browser.close();
server.close();
if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('E2E passed');
