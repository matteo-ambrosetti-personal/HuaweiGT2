// Bundle the app into one self-contained HTML file for the claude.ai Artifact.
//   node scripts/build.mjs  →  dist/gt2-logbook.html
// d3 and zip.js load from CDNs at runtime (pinned versions in src/index.html).

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const common = { bundle: true, format: 'iife', write: false, target: 'es2020', legalComments: 'none' };

const worker = await build({ ...common, entryPoints: ['src/app/worker.js'], minify: true });
const workerCode = worker.outputFiles[0].text;

const app = await build({
  ...common,
  entryPoints: ['src/app/main.js'],
  define: { WORKER_SOURCE: JSON.stringify(workerCode) },
  minifySyntax: true,
});
const js = app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync('src/styles.css', 'utf8');
const html = readFileSync('src/index.html', 'utf8')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => js);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/gt2-logbook.html', html);
console.log(`dist/gt2-logbook.html ${(html.length / 1024).toFixed(0)} KB (worker ${(workerCode.length / 1024).toFixed(0)} KB)`);
