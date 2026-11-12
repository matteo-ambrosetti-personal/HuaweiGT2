// Copy the standalone builds into the light-through-the-mirror.com repository.
//   npm run build:web && npm run build:android
//   npm run publish:site -- ../light-through-the-mirror
//
// Writes, in that repository:
//   public/lab/gt2-logbook/                 the web app (dist/web) and GT2-Logbook.apk beside it
//   app/studio/bench/gt2-logbook/release.json   version, sizes and checksums the bench page shows
// The site serves /lab/* only to signed-in accounts (worker/index.ts), so neither
// the app nor the APK is public. Commit and deploy the site as usual afterwards.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const site = resolve(process.argv[2] || '../light-through-the-mirror');
const fail = (msg) => { console.error(`publish-site: ${msg}`); process.exit(1); };
if (!existsSync(join(site, 'wrangler.jsonc')) || !existsSync(join(site, 'app/studio/bench'))) fail(`${site} does not look like the light-through-the-mirror repository.`);
if (!existsSync('dist/web/index.html')) fail('dist/web is missing: run `npm run build:web`.');
if (!existsSync('dist/android/GT2-Logbook.apk')) fail('dist/android/GT2-Logbook.apk is missing: run `npm run build:android`.');

const web = JSON.parse(readFileSync('dist/web/version.json', 'utf8'));
const apk = JSON.parse(readFileSync('dist/android/GT2-Logbook.json', 'utf8'));
if (apk.build !== web.build) fail(`the APK bundles web build ${apk.build} but dist/web is ${web.build}: run \`npm run build:android\` again.`);

const dest = join(site, 'public/lab/gt2-logbook');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync('dist/web', dest, { recursive: true });
copyFileSync('dist/android/GT2-Logbook.apk', join(dest, 'GT2-Logbook.apk'));

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const release = {
  version: web.version,
  build: web.build,
  published: new Date().toISOString().slice(0, 10),
  web: { path: '/lab/gt2-logbook/', pageBytes: statSync('dist/web/index.html').size },
  android: {
    path: '/lab/gt2-logbook/GT2-Logbook.apk',
    file: 'GT2-Logbook.apk',
    bytes: apk.bytes,
    sha256: sha256('dist/android/GT2-Logbook.apk'),
    certSha256: apk.certSha256,
    versionCode: apk.versionCode,
    minSdk: apk.minSdk,
    targetSdk: apk.targetSdk,
  },
};
const benchDir = join(site, 'app/studio/bench/gt2-logbook');
mkdirSync(benchDir, { recursive: true });
writeFileSync(join(benchDir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(`published GT 2 Logbook ${release.version} (build ${release.build}) to ${dest}`);
console.log(`  APK ${(release.android.bytes / 1024).toFixed(0)} KB, sha256 ${release.android.sha256}`);
