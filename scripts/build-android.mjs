// Build the Android app around the standalone page.
//   npm run build:web && npm run build:android   → dist/android/GT2-Logbook.apk
//
// Plain command-line tools, no Gradle: aapt (resources), javac --release 8 and dx
// (code), zipalign and apksigner. On Ubuntu/Debian:
//   sudo apt-get install aapt dalvik-exchange zipalign apksigner android-sdk-platform-23
// It compiles against API 23 and targets API 34 (see android/AndroidManifest.xml).
//
// Signing. Android only installs an update signed with the same key, so keep the
// key you release with. The script reads it from
//   GT2_KEYSTORE (path) and GT2_KEYSTORE_PASS (password), alias GT2_KEY_ALIAS (default gt2logbook)
// or else android/release.keystore with android/release.properties next to it.
// Neither is committed (this repository is public). With no key at all it makes
// one there and says so: back both files up, or the next build cannot update the
// installed app.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = resolve('.');
const SDK = process.env.ANDROID_JAR || '/usr/lib/android-sdk/platforms/android-23/android.jar';
const DX = process.env.DX || 'dalvik-exchange';
const OUT = join(ROOT, 'build/android');
const DIST = join(ROOT, 'dist/android');
const APK = join(DIST, 'GT2-Logbook.apk');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
const need = (cond, msg) => { if (!cond) { console.error(`build-android: ${msg}`); process.exit(1); } };

need(existsSync(join(ROOT, 'dist/web/index.html')), 'dist/web is missing: run `npm run build:web` first.');
need(existsSync(SDK), `no android.jar at ${SDK} (apt-get install android-sdk-platform-23, or set ANDROID_JAR).`);
for (const tool of ['aapt', DX, 'zipalign', 'apksigner', 'javac', 'keytool']) {
  try { run('sh', ['-c', `command -v ${tool}`]); } catch { need(false, `${tool} is not installed (see the top of scripts/build-android.mjs).`); }
}

// ---------------------------------------------------------------- version
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);
const versionCode = maj * 10000 + min * 100 + pat;
const build = JSON.parse(readFileSync('dist/web/version.json', 'utf8')).build;

// ---------------------------------------------------------------- key
function signingKey() {
  if (process.env.GT2_KEYSTORE) {
    need(process.env.GT2_KEYSTORE_PASS, 'GT2_KEYSTORE is set but GT2_KEYSTORE_PASS is not.');
    return { ks: resolve(process.env.GT2_KEYSTORE), pass: process.env.GT2_KEYSTORE_PASS, alias: process.env.GT2_KEY_ALIAS || 'gt2logbook', fresh: false };
  }
  const ks = join(ROOT, 'android/release.keystore');
  const props = join(ROOT, 'android/release.properties');
  if (existsSync(ks) && existsSync(props)) {
    const p = Object.fromEntries(readFileSync(props, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
    return { ks, pass: p.storePassword, alias: p.keyAlias || 'gt2logbook', fresh: false };
  }
  need(!existsSync(ks), 'android/release.keystore exists without android/release.properties: restore the properties file, or set GT2_KEYSTORE and GT2_KEYSTORE_PASS.');
  const pass = randomBytes(18).toString('base64url');
  run('keytool', ['-genkeypair', '-keystore', ks, '-storetype', 'PKCS12', '-storepass', pass, '-keypass', pass, '-alias', 'gt2logbook',
    '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=GT 2 Logbook, O=light-through-the-mirror.com']);
  writeFileSync(props, `# Signing key for GT 2 Logbook builds. Not committed: keep a copy of this file and release.keystore.\nstorePassword=${pass}\nkeyAlias=gt2logbook\n`);
  return { ks, pass, alias: 'gt2logbook', fresh: true };
}

// ---------------------------------------------------------------- build
rmSync(OUT, { recursive: true, force: true });
for (const d of ['gen', 'classes', 'assets/web', 'apk']) mkdirSync(join(OUT, d), { recursive: true });
cpSync('dist/web', join(OUT, 'assets/web'), { recursive: true });
// The service worker is for the web app; the app serves its own files.
rmSync(join(OUT, 'assets/web/sw.js'), { force: true });

const manifest = readFileSync('android/AndroidManifest.xml', 'utf8')
  .replace('android:versionCode="1"', `android:versionCode="${versionCode}"`)
  .replace('android:versionName="0"', `android:versionName="${pkg.version}"`);
need(manifest.includes(`versionCode="${versionCode}"`) && manifest.includes(`versionName="${pkg.version}"`), 'could not stamp the version into the manifest.');
writeFileSync(join(OUT, 'AndroidManifest.xml'), manifest);

const unsigned = join(OUT, 'apk/unsigned.apk');
run('aapt', ['package', '-f', '-m', '--no-version-vectors',
  '-M', join(OUT, 'AndroidManifest.xml'), '-S', 'android/res', '-A', join(OUT, 'assets'), '-I', SDK,
  '-J', join(OUT, 'gen'), '-F', unsigned,
  // Fonts and PNGs are compressed already; the page compresses well.
  '-0', 'woff2', '-0', 'png']);

const sources = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.java')) sources.push(p); } };
walk('android/src');
walk(join(OUT, 'gen'));
run('javac', ['--release', '8', '-Xlint:-options', '-classpath', SDK, '-d', join(OUT, 'classes'), ...sources]);
run(DX, ['--dex', `--output=${join(OUT, 'apk/classes.dex')}`, join(OUT, 'classes')]);
run('zip', ['-q', '-j', unsigned, join(OUT, 'apk/classes.dex')]);

const aligned = join(OUT, 'apk/aligned.apk');
run('zipalign', ['-f', '-p', '4', unsigned, aligned]);

const key = signingKey();
mkdirSync(DIST, { recursive: true });
copyFileSync(aligned, APK);
run('apksigner', ['sign', '--ks', key.ks, '--ks-pass', `pass:${key.pass}`, '--ks-key-alias', key.alias,
  '--min-sdk-version', '24', '--v4-signing-enabled', 'false', APK]);
const verify = run('apksigner', ['verify', '--print-certs', '-v', APK]);
need(/Verifies/.test(verify), `the signed APK does not verify:\n${verify}`);
const cert = /SHA-256 digest: ([0-9a-f]+)/.exec(verify)?.[1];

const size = statSync(APK).size;
const info = { file: 'GT2-Logbook.apk', version: pkg.version, versionCode, build, bytes: size, certSha256: cert, minSdk: 24, targetSdk: 34 };
writeFileSync(join(DIST, 'GT2-Logbook.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`dist/android/GT2-Logbook.apk ${(size / 1024).toFixed(0)} KB · ${pkg.version} (${versionCode}) · web build ${build}`);
console.log(`  signed by ${cert}`);
if (key.fresh) {
  console.log('  A NEW signing key was made: android/release.keystore + android/release.properties.');
  console.log('  Back both up. A build signed with any other key cannot update this one.');
}
