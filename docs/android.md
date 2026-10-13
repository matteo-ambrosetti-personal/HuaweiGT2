# The Android app

GT 2 Logbook runs as an Android app (Android 8.0 or later). It is the same
logbook as the claude.ai artifact, packaged with [Capacitor](https://capacitorjs.com),
with everything stored on the phone and three things the artifact cannot do:

- read **Health Connect** directly, so Health Sync's copy of your Huawei Health
  data arrives without Google Drive or Claude in between;
- read **intervals.icu** directly with your API key (no Cloudflare bridge);
- **download the map** for your routes in one tap.

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

| Source | In the app | Setup |
|---|---|---|
| Huawei privacy export (ZIP) | Data → Import, choose the ZIP from your Downloads, enter its password | [setup-export.md](setup-export.md) |
| Health Connect (via Health Sync) | Data → Automatic updates → **Connect Health Connect** | Health Sync: Huawei Health → Health Connect; then allow the data types and "Access past data" |
| intervals.icu | Data → Automatic updates → paste your **API key** | intervals.icu → Settings → Developer settings |
| GPX/TCX/CSV files | Data → Add individual files | — |

Health Connect and intervals.icu sync by themselves when you open the app (at
most hourly). Health Connect only shares 30 days unless you allow "Access past
data"; the Huawei export is the way to bring in older history.

## Privacy

- Data is stored in the app's private storage on the phone. Android cloud
  backup and device-to-device transfer are turned off for it
  (`data_extraction_rules.xml`); move it with **Data → Export → Full backup**
  and **Restore a backup…**.
- The app reads Health Connect with read-only permissions for steps, distance,
  active calories, heart rate, resting heart rate, HRV, SpO2, sleep, exercise,
  weight and VO2max. It asks for nothing else and writes nothing.
- It connects only to: intervals.icu (when you add a key), the OpenStreetMap
  Overpass server (when you download the map: it sees the area, never your
  tracks) and api.anthropic.com (when you press Ask, with your own API key).
  API keys stay on the phone.

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
save a full backup, uninstall, install the new APK and restore the backup.

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
| `src/app/native-platform.js` | Capacitor wiring: on-device storage, the share sheet for exports, native HTTP, back button, Health Connect, Ask Claude |
| `src/app/local-docs.js` | Document storage on the phone (`FsDocs`, JSON files) or in a browser (`IdbDocs`) behind the artifact db's interface |
| `src/lib/healthconnect.js` | Health Connect → dataset (hourly aggregates, samples, sleep stages, workouts with heart rate) |
| `src/lib/intervals-api.js` | intervals.icu REST client with your API key |
| `src/app/claude-api.js` | Ask Claude through the Anthropic API (streaming tool loop) |
| `src/lib/models/` | The training, running, recovery, sleep and rhythm models behind the Insights and Training tabs |
| `scripts/build-app.mjs` | Bundles `www/` with d3, zip.js and the fonts local (the app loads nothing from CDNs) |
| `android/` | The Capacitor Android project (icons, manifest, signing) |
