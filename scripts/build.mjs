// Build the logbook.
//   node scripts/build.mjs            both targets
//   node scripts/build.mjs artifact   → dist/gt2-logbook.html, the claude.ai Artifact (one file;
//                                       d3 and zip.js load from pinned CDN URLs at runtime)
//   node scripts/build.mjs web        → dist/web/, the standalone page: plain web, installable
//                                       PWA and the Android app's bundled files. Nothing loads
//                                       from anywhere else: libraries are inlined, fonts sit
//                                       beside it, and storage is IndexedDB (src/app/platform.js).

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

const targets = process.argv[2] ? [process.argv[2]] : ['artifact', 'web'];
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const common = { bundle: true, format: 'iife', write: false, target: 'es2020', legalComments: 'none' };
const noCloseScript = (js) => js.replace(/<\/script/gi, '<\\/script');

const worker = await build({ ...common, entryPoints: ['src/app/worker.js'], minify: true });
const workerCode = worker.outputFiles[0].text;
const css = readFileSync('src/styles.css', 'utf8');
const source = readFileSync('src/index.html', 'utf8');

async function appJs(target) {
  const app = await build({
    ...common,
    entryPoints: ['src/app/main.js'],
    define: { WORKER_SOURCE: JSON.stringify(workerCode), BUILD_TARGET: JSON.stringify(target) },
    minifySyntax: true,
  });
  return noCloseScript(app.outputFiles[0].text);
}

/** Replace `from` exactly once, or fail the build: the source markup changed under us. */
function swap(text, from, to) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`build: expected one ${JSON.stringify(from.slice(0, 60))} in src/index.html, found ${n}`);
  return text.replace(from, () => to);
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

if (targets.includes('artifact')) {
  const js = await appJs('artifact');
  const html = source.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/gt2-logbook.html', html);
  console.log(`dist/gt2-logbook.html ${(html.length / 1024).toFixed(0)} KB (worker ${(workerCode.length / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------- standalone

/** Self-hosted faces: the same families and axes the artifact takes from Google Fonts. */
const FONTS = [
  ...['latin', 'latin-ext'].map((subset) => ({
    file: `archivo-${subset}-standard-normal.woff2`,
    from: `node_modules/@fontsource-variable/archivo/files/archivo-${subset}-standard-normal.woff2`,
    face: { family: 'Archivo', weight: '100 900', stretch: '62% 125%', subset },
  })),
  ...[400, 500, 600].flatMap((w) => ['latin', 'latin-ext'].map((subset) => ({
    file: `ibm-plex-sans-${subset}-${w}-normal.woff2`,
    from: `node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-${subset}-${w}-normal.woff2`,
    face: { family: 'IBM Plex Sans', weight: String(w), subset },
  }))),
];
const RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};
const fontFaces = FONTS.map(({ file, face }) => `@font-face{font-family:"${face.family}";font-style:normal;font-display:swap;font-weight:${face.weight};${face.stretch ? `font-stretch:${face.stretch};` : ''}src:url(fonts/${file}) format("woff2");unicode-range:${RANGES[face.subset]}}`).join('\n');

const ICONS = ['favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

if (targets.includes('web')) {
  const js = await appJs('standalone');
  const d3 = noCloseScript(readFileSync('node_modules/d3/dist/d3.min.js', 'utf8'));
  const zip = noCloseScript(readFileSync('node_modules/@zip.js/zip.js/dist/zip-native.min.js', 'utf8'));

  const split = source.indexOf('<header');
  let head = source.slice(0, split);
  let body = source.slice(split);
  head = swap(head, '<link rel="preconnect" href="https://fonts.googleapis.com">\n', '');
  head = swap(head, '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n', '');
  head = head.replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\n/, () => '');
  if (head.includes('fonts.googleapis')) throw new Error('build: a Google Fonts link is left in the standalone page');
  head = swap(head, '/*__CSS__*/', `${fontFaces}\n[hidden]{display:none!important}\n${css}`);
  body = swap(body, '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>', `<script>${d3}</script>`);
  body = swap(body, '<script src="https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.8.61/dist/zip-native.min.js"></script>', `<script>${zip}</script>`);
  body = swap(body, '/*__JS__*/', js);
  if (/<script src=|https:\/\/cdn/.test(body)) throw new Error('build: the standalone page still loads a script from elsewhere');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f4f6f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1417" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex">
<meta name="generator" content="GT 2 Logbook ${pkg.version}">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-192.png">
<link rel="preload" href="fonts/ibm-plex-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
${head.trim()}
<style>body{margin:0}</style>
</head>
<body>
${body.trim()}
</body>
</html>
`;

  rmSync('dist/web', { recursive: true, force: true });
  mkdirSync('dist/web/fonts', { recursive: true });
  writeFileSync('dist/web/index.html', html);
  for (const f of FONTS) copyFileSync(f.from, `dist/web/fonts/${f.file}`);
  for (const icon of ICONS) copyFileSync(`assets/icons/${icon}`, `dist/web/${icon}`);

  writeFileSync('dist/web/manifest.webmanifest', `${JSON.stringify({
    name: 'GT 2 Logbook',
    short_name: 'GT 2 Logbook',
    description: 'Activity, workouts, sleep and heart data from a Huawei Watch GT 2, kept on your device.',
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#f4f6f7',
    theme_color: '#111c24',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  }, null, 2)}\n`);

  // The service worker's cache name carries a hash of the build, so a new build retires the old cache.
  const shell = ['./', 'index.html', 'manifest.webmanifest', ...ICONS, ...FONTS.map((f) => `fonts/${f.file}`)];
  const version = sha(html + FONTS.map((f) => f.file).join());
  const sw = readFileSync('src/sw.js', 'utf8')
    .replace("'__CACHE__'", () => JSON.stringify(`gt2-logbook-${version}`))
    .replace("['__SHELL__']", () => JSON.stringify(shell));
  writeFileSync('dist/web/sw.js', sw);
  writeFileSync('dist/web/version.json', `${JSON.stringify({ version: pkg.version, build: version }, null, 2)}\n`);
  console.log(`dist/web/index.html ${(html.length / 1024).toFixed(0)} KB · ${FONTS.length} fonts · build ${version}`);
}
