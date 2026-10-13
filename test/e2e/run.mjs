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
const MAP_FIXTURE = resolve('test/fixtures/out/map-overpass.json');
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
  const rel = [((at % c.width) + 0.5) * (r.width / c.width), (Math.floor(at / c.width) + 0.5) * (r.height / c.height)];
  return { n, rel, hit: [r.left + rel[0], r.top + rel[1]] };
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

step('map: the download link covers the routes, the saved file draws a map under them');
await page.goto(url + '#data');
await page.waitForSelector('#map-card');
assert.match(await page.textContent('#map-status'), /Not added/);
const mapHref = await page.getAttribute('#map-download', 'href');
assert.ok(mapHref.startsWith('https://overpass-api.de/api/interpreter?data='), mapHref.slice(0, 80));
assert.match(decodeURIComponent(mapHref.split('?data=')[1]), /\(45\.\d{3},9\.\d{3},45\.\d{3},9\.\d{3}\)/, 'a box around the routes');
await page.setInputFiles('#map-file', MAP_FIXTURE);
await page.waitForSelector('#map-card .msg.ok', { timeout: 30000 });
assert.match(await page.textContent('#map-status'), /On/);
assert.match(await page.textContent('#map-summary'), /covers/);
await page.screenshot({ path: `${SHOTS}/13-map-card.png`, fullPage: true });

await page.goto(url + '#workouts');
const mapCanvas = await page.waitForSelector('.panel:has(#all-routes) canvas');
await mapCanvas.scrollIntoViewIfNeeded();
await page.waitForTimeout(900);
const withMap = await routePixels();
assert.ok(withMap.n > drawn.n + 3000, `the map is drawn under the routes (${withMap.n} px vs ${drawn.n} for routes alone)`);
const box2 = await mapCanvas.boundingBox();
await page.mouse.move(box2.x + drawn.rel[0], box2.y + drawn.rel[1]);
await page.waitForFunction(() => /Where/.test(document.getElementById('tip')?.textContent || '') && document.getElementById('tip').style.display === 'block', null, { timeout: 5000 });
const where = await page.$$eval('td.where', (tds) => tds.map((t) => t.textContent));
assert.ok(where.some((t) => /Sample/.test(t)), `place names in the table: ${where.slice(0, 4).join(', ')}`);
await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
await page.mouse.wheel(0, 600); // zooming out past the routes' frame works over a map
await page.waitForTimeout(300);
await mapCanvas.screenshot({ path: `${SHOTS}/14-map-explorer.png` });
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(url + '#workouts');
const darkCanvas = await page.waitForSelector('.panel:has(#all-routes) canvas');
await darkCanvas.scrollIntoViewIfNeeded();
await page.waitForTimeout(900);
await darkCanvas.screenshot({ path: `${SHOTS}/15-map-explorer-dark.png` });
await page.emulateMedia({ colorScheme: 'light' });

await page.goto(url + '#workouts');
await page.waitForSelector('tbody tr.clickable');
for (const r of await page.$$('tbody tr.clickable')) {
  if ((await r.$('svg.thumb path')) && /Outdoor run/.test(await r.textContent())) { await r.click(); break; }
}
await page.waitForSelector('#route', { timeout: 15000 });
await page.waitForFunction(() => /near/.test(document.getElementById('workout-place')?.textContent || ''), null, { timeout: 5000 });
const detailMap = await page.$eval('.panel:has(#route) canvas', (c) => {
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
  return n;
});
assert.ok(detailMap > 1000, `the route map has a map underneath (${detailMap} px)`);
await page.screenshot({ path: `${SHOTS}/16-workout-map.png`, fullPage: true });

step('map: remove asks twice');
await page.goto(url + '#data');
await page.click('#map-remove');
assert.match(await page.textContent('#map-remove'), /again/);
await page.click('#map-remove');
await page.waitForFunction(() => /Not added/.test(document.getElementById('map-status')?.textContent || ''), null, { timeout: 10000 });
await page.goto(url + '#workouts');
await page.waitForSelector('.panel:has(#all-routes) canvas');
assert.equal(await page.$('td.where'), null, 'no Where column without a map');

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

// ---------------------------------------------------------------- the ZIP is the only source
// A claude.ai runtime that offers a Google Drive connector: the page must not
// touch it. Data comes only from the Huawei export ZIP.
function connectorRuntime() {
  window.__connectorCalls = [];
  const mcp = {
    async listTools() { window.__connectorCalls.push('listTools'); return { servers: [{ server: 'Google Drive', authStatus: 'connected', tools: [{ name: 'search_files', description: '' }] }] }; },
    async callTool(server, tool) { window.__connectorCalls.push(tool); return { content: [], payload: {} }; },
  };
  const permissions = { async state() { window.__connectorCalls.push('permissions'); return 'granted'; }, async request() { return {}; }, async manage() {} };
  window.claude = { use: async (name) => (name === 'mcp' ? mcp : name === 'permissions' ? permissions : null) };
}

step('the export ZIP is the only way in: no connectors, no other files');
{
  const { ctx: c3, page: p3 } = await newPage({ viewport: { width: 400, height: 860 } });
  await c3.addInitScript(connectorRuntime);
  await p3.goto(url + '#data');
  await p3.waitForSelector('#zip-file', { state: 'attached', timeout: 30000 });
  await p3.waitForTimeout(800);
  assert.deepEqual(await p3.evaluate(() => window.__connectorCalls), [], 'no connector is asked for data');
  const inputs = await p3.$$eval('input[type=file]', (els) => els.map((e) => [e.id, e.accept, e.multiple]));
  assert.deepEqual(inputs.filter(([id]) => id !== 'map-file'), [['zip-file', '.zip,application/zip', false]]);
  for (const gone of ['#drive-sync', '#health-card', '#intervals-key', '#backup-restore', '#activity-files']) {
    assert.equal(await p3.$(gone), null, `${gone} is gone`);
  }
  // A dropped file that is not a ZIP is turned away.
  await p3.setInputFiles('#zip-file', { name: 'run.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from('<gpx/>') });
  await p3.waitForSelector('#dropzone:has-text("not a ZIP file")', { timeout: 10000 });
  assert.equal(await p3.getByRole('button', { name: 'Import', exact: true }).isDisabled(), true);
  assert.ok(await p3.$('.chip.sample'), 'the sample data stays');
  await p3.screenshot({ path: `${SHOTS}/30-data-zip-only-phone.png`, fullPage: true });
  await c3.close();
}

await browser.close();
server.close();
if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('E2E passed');
