// Draw the app icons from the logbook's mark (the ring in the page header):
//   node scripts/make-icons.mjs
// → assets/icons/   favicon.svg, icon-192.png, icon-512.png, icon-maskable-512.png (web app)
// → android/res/     mipmap-*/ic_launcher.png (legacy), mipmap-*/ic_launcher_foreground.png (adaptive)
// Rendered in the pre-installed Chromium. The PNGs are committed, so a build never needs a browser.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BG = '#111c24';
const RING = '#e9eef1';
const ACCENT = '#f0679a';

/** The mark on a 26-unit grid: a watch-face ring, a lap arc in the accent, the centre. */
const mark = `
  <circle cx="13" cy="13" r="11" fill="none" stroke="${RING}" stroke-width="2.5"/>
  <path d="M13 2 A11 11 0 0 1 23.6 15.8" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="13" cy="13" r="2.4" fill="${RING}"/>`;

/**
 * An icon `size` px square. `scale` is the ring's outer diameter as a share of
 * the canvas; `shape` is 'rounded' (transparent corners), 'full' or 'none'.
 */
function svg({ size, scale, shape }) {
  const k = (size * scale) / 26; // the ring's outer edge is 24.5 units wide; 26 leaves a hair of margin
  const off = (size - 26 * k) / 2;
  const bg = shape === 'none' ? '' : `<rect width="${size}" height="${size}" rx="${shape === 'rounded' ? size * 0.22 : 0}" fill="${BG}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}<g transform="translate(${off} ${off}) scale(${k})">${mark}</g></svg>`;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(path, opts) {
  await page.setViewportSize({ width: opts.size, height: opts.size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(opts)}</body></html>`);
  const buf = await page.locator('svg').screenshot({ omitBackground: true });
  writeFileSync(path, buf);
}

mkdirSync('assets/icons', { recursive: true });
writeFileSync('assets/icons/favicon.svg', svg({ size: 64, scale: 0.78, shape: 'rounded' }) + '\n');
await png('assets/icons/icon-192.png', { size: 192, scale: 0.66, shape: 'rounded' });
await png('assets/icons/icon-512.png', { size: 512, scale: 0.66, shape: 'rounded' });
// Maskable: full bleed, the mark inside the 80% safe circle.
await png('assets/icons/icon-maskable-512.png', { size: 512, scale: 0.56, shape: 'full' });

// Android: 48dp legacy icons and 108dp adaptive foregrounds (the 66dp centre is always visible).
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, d] of Object.entries(DENSITIES)) {
  const dir = `android/res/mipmap-${name}`;
  mkdirSync(dir, { recursive: true });
  await png(`${dir}/ic_launcher.png`, { size: Math.round(48 * d), scale: 0.66, shape: 'rounded' });
  await png(`${dir}/ic_launcher_foreground.png`, { size: Math.round(108 * d), scale: 0.4, shape: 'none' });
}
await browser.close();
console.log('icons written to assets/icons and android/res/mipmap-*');
