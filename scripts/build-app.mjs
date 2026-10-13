// Bundle the app build (Android, or any browser) into www/:
//   node scripts/build-app.mjs  →  www/index.html + www/vendor/* + www/fonts/*
// Unlike the artifact, everything is local: d3, zip.js and the fonts ship in
// the APK, so the app works offline and loads nothing from CDNs.

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';

const OUT = 'www';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/vendor`, { recursive: true });
mkdirSync(`${OUT}/fonts`, { recursive: true });

const common = { bundle: true, format: 'iife', write: false, target: 'es2020', legalComments: 'none' };
const worker = await build({ ...common, entryPoints: ['src/app/worker.js'], minify: true });
const workerCode = worker.outputFiles[0].text;
const app = await build({
  ...common,
  entryPoints: ['src/app/app-entry.js'],
  define: { WORKER_SOURCE: JSON.stringify(workerCode) },
  minify: true,
});
writeFileSync(`${OUT}/app.js`, app.outputFiles[0].text);

copyFileSync('node_modules/d3/dist/d3.min.js', `${OUT}/vendor/d3.min.js`);
copyFileSync('node_modules/@zip.js/zip.js/dist/zip-native.min.js', `${OUT}/vendor/zip-native.min.js`);

// Fonts: Archivo (variable, with the width axis the headings use) and IBM Plex Sans.
const fonts = [
  ['@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2', 'archivo-wdth.woff2'],
  ['@fontsource-variable/archivo/files/archivo-latin-ext-wdth-normal.woff2', 'archivo-wdth-ext.woff2'],
  ...[400, 500, 600].map((w) => [`@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${w}-normal.woff2`, `plex-${w}.woff2`]),
];
for (const [from, to] of fonts) copyFileSync(`node_modules/${from}`, `${OUT}/fonts/${to}`);
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const fontCss = [
  `@font-face{font-family:"Archivo";font-style:normal;font-display:swap;font-weight:100 900;font-stretch:62% 125%;src:url(fonts/archivo-wdth.woff2) format("woff2");unicode-range:${LATIN}}`,
  '@font-face{font-family:"Archivo";font-style:normal;font-display:swap;font-weight:100 900;font-stretch:62% 125%;src:url(fonts/archivo-wdth-ext.woff2) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+A720-A7FF}',
  ...[400, 500, 600].map((w) => `@font-face{font-family:"IBM Plex Sans";font-style:normal;font-display:swap;font-weight:${w};src:url(fonts/plex-${w}.woff2) format("woff2")}`),
].join('\n');

const body = readFileSync('src/index.html', 'utf8')
  .replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>\n?/g, '')
  .replace(/<title>.*<\/title>\n?/, '')
  .replace(/<meta name="description"[^>]*>\n?/, '')
  .replace('<style>/*__CSS__*/</style>', '')
  .replace(/<script src="https:\/\/cdnjs[^"]*d3[^"]*"><\/script>/, '<script src="vendor/d3.min.js"></script>')
  .replace(/<script src="https:\/\/cdn\.jsdelivr[^"]*zip[^"]*"><\/script>/, '<script src="vendor/zip-native.min.js"></script>')
  .replace('<script>/*__JS__*/</script>', '<script src="app.js"></script>')
  .replace('Your data stays in this artifact\'s private storage. Charts are drawn in your browser.', 'Your data stays on this device. Charts are drawn on your phone.');
if (/cdnjs|jsdelivr|googleapis|__JS__|__CSS__/.test(body)) throw new Error('index.html changed: a CDN reference or placeholder was not replaced');

const css = readFileSync('src/styles.css', 'utf8');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://api.anthropic.com https://intervals.icu https://overpass-api.de">
<title>GT 2 Logbook</title>
<style>
${fontCss}
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`;
writeFileSync(`${OUT}/index.html`, html);
console.log(`www/index.html + app.js ${(app.outputFiles[0].text.length / 1024).toFixed(0)} KB (worker ${(workerCode.length / 1024).toFixed(0)} KB)`);
