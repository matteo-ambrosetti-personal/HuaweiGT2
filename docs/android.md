# The Android app

GT 2 Logbook runs as an Android app (Android 8.0 or later). It is the same
logbook as the claude.ai artifact, packaged with [Capacitor](https://capacitorjs.com),
with everything stored on the phone, the map for your routes downloaded in one
tap, and Ask Claude with your own API key.

## Install it

1. On your phone, open the repository's
   [latest release](https://github.com/matteo-ambrosetti-personal/HuaweiGT2/releases/latest)
   and download `gt2-logbook.apk`. The direct link is always
   `…/releases/latest/download/gt2-logbook.apk`.
2. Open the file. Android asks once to let your browser install apps; allow it.
3. Open **GT 2 Logbook**. It starts on sample data until you add your own.

Releases are built by GitHub Actions (`.github/workflows/android.yml`) on every
push to the default branch. Every other branch and pull request gets the APK as
a downloadable artifact on its workflow run.

## Get your data in

The only source of data is the ZIP you download from Huawei:

1. Huawei Health app → **Me** → your account name → **Privacy Centre** →
   **Request your data** → **Health**; set a password and submit.
2. Download the ZIP from the email link (it usually arrives within a day and
   works for 21 days). Keep it as it is; do not unzip it.
3. In GT 2 Logbook: **Data → Import → Choose ZIP**, pick the file from your
   Downloads, type the password and press **Import**.

Everything is decrypted and parsed on the phone. To bring the logbook up to
date, request a new export and import it the same way: it merges with what is
already there. More detail: [setup-export.md](setup-export.md).

## Privacy

- Data is stored in the app's private storage on the phone. Android cloud
  backup and device-to-device transfer are turned off for it
  (`data_extraction_rules.xml`). **Data → Export** saves CSV, GPX/TCX and a
  full JSON copy through the share sheet; **Delete all** wipes it.
- The app asks only for the network permission. It reads no health services,
  accounts or other files.
- It connects only to: the OpenStreetMap Overpass server (when you download
  the map: it sees the area, never your tracks) and api.anthropic.com (when
  you press Ask, with your own API key). The key stays on the phone.

## Signing, and updating without losing data

Android installs an update only when it is signed with the same key as the
installed copy. The workflow signs with your own key when these repository
secrets exist (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | its password |
| `ANDROID_KEY_ALIAS` | optional, default `gt2logbook` |
| `ANDROID_KEY_PASSWORD` | optional, default: the keystore password |

To make a keystore (any computer with Java):

```sh
keytool -genkeypair -v -keystore gt2-logbook.keystore -alias gt2logbook \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=GT 2 Logbook"
base64 -w0 gt2-logbook.keystore   # paste the output into ANDROID_KEYSTORE_BASE64
```

Keep the keystore somewhere safe and never commit it (the repository is
public; `*.keystore` is git-ignored). Without the secrets each build is signed
with a throwaway key: it installs fine the first time, but to update you must
uninstall, install the new APK and import your Huawei ZIP again.

## Build it yourself

You need Node 22, JDK 21 and the Android SDK (platform 36).

```sh
npm ci
npm run android:sync          # build www/ and copy it into android/
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

`npm run build:app` alone builds `www/`, which also runs in any browser (it
then stores data in IndexedDB); `npm run test:e2e:app` drives it at phone size
in Chromium.

## How it fits together

| Path | Contents |
|---|---|
| `src/app/app-entry.js` | The app's entry: registers the platform, then starts the same page as the artifact |
| `src/app/native-platform.js` | Capacitor wiring: on-device storage, the share sheet for exports, back button, Ask Claude |
| `src/app/local-docs.js` | Document storage on the phone (`FsDocs`, JSON files) or in a browser (`IdbDocs`) behind the artifact db's interface |
| `src/app/importer.js`, `src/lib/huawei/` | The export ZIP: decryption, then the parsers, in a worker |
| `src/app/claude-api.js` | Ask Claude through the Anthropic API (streaming tool loop) |
| `src/lib/models/` | The training, running, recovery, sleep and rhythm models behind the Insights and Training tabs |
| `scripts/build-app.mjs` | Bundles `www/` with d3, zip.js and the fonts local (the app loads nothing from CDNs) |
| `android/` | The Capacitor Android project (icons, manifest, signing) |
