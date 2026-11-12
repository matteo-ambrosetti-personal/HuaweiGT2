# The web app and the Android app

Besides the claude.ai Artifact, the logbook builds as a standalone page
(`npm run build:web` → `dist/web/`) and as an Android app around that page
(`npm run build:android` → `dist/android/GT2-Logbook.apk`). Both are published on
light-through-the-mirror.com, behind the site's sign-in:

- web app: `/lab/gt2-logbook/`
- bench page with the download and install notes: `/studio/bench/gt2-logbook/`

## What is different from the artifact

| | Artifact | Web app | Android app |
|---|---|---|---|
| Storage | claude.ai private storage | IndexedDB in this browser | Inside the app (WebView IndexedDB) |
| Ask Claude | Yes | No | No |
| Health Sync via Google Drive | Automatic, through the connector | Add the files by hand | Add the files by hand |
| intervals.icu bridge | Through the connector | No | No |
| Map background | Download link, then add the file | One button (the page fetches it) | One button |
| Exports | claude.ai download prompt | Ordinary browser downloads | The system "Save to" dialog |
| Offline | No | Yes, after the first visit (service worker) | Always |

`src/app/platform.js` holds the switch (`BUILD_TARGET`, set by `scripts/build.mjs`) and
the few places that use it are marked. Everything else is the same code.

## Privacy

- The page loads nothing from anywhere else: d3 and zip.js are inlined, and the fonts sit beside the page.
- Your data is stored only on the device: IndexedDB for the web app, and the app's private storage on Android, which is excluded from Android's cloud backups (`allowBackup="false"`).
- The only outside request is **Download map**. It sends OpenStreetMap's data service (overpass-api.de) the boxes around your routes, never the routes themselves.
- The Android app's only permission is `INTERNET`, and it uses it for that map download. It has no account and no analytics.
- Deleting the app, or clearing the site's data in the browser, deletes everything. Use **Data → Export → Full backup** first if you want a copy.

## The web app

- **Install:** open it in Chrome or Edge and use the browser's Install (or "Add to Home screen") option.
- **Offline:** `src/sw.js` caches only the page, its fonts and icons. It fetches from the network first and falls back to the cache, so a redeploy shows up on the next online visit. Nothing it caches contains health data.
- **Per device:** each browser on each device has its own copy of the data.

## The Android app

`android/` holds a single activity:

- `MainActivity.java` shows a WebView and serves `assets/web/` (the built `dist/web`, minus the service worker) from `https://appassets.androidplatform.net/`. That host is reserved for app assets, so the page gets a secure origin with IndexedDB without any network request. Links to anywhere else open in the browser. Back walks back through the tabs.
- File inputs open the system document picker (`ACTION_OPEN_DOCUMENT`, any type, so a Huawei ZIP is never hidden by its MIME label). A WebView cannot pick a folder, so the app offers **Choose ZIP** only.
- `Bridge.java` is `window.GT2Native`. A WebView cannot download a `blob:` URL, so `src/app/downloads.js` sends exports in base64 chunks (`begin`, `append`, `finish`). The bridge spools them to the app's cache, asks where to save them (`ACTION_CREATE_DOCUMENT`) and reports back through `window.GT2NativeSaved(id, result)`.
- Light and dark follow the system: `values-night` swaps the theme, and the WebView passes that to the page as `prefers-color-scheme`.
- minSdk 24 (Android 7), targetSdk 34, compiled against API 23. Nothing it uses is newer than 23.

### Building

The build uses plain command-line tools, with no Gradle and no Android Studio:

```sh
sudo apt-get install aapt dalvik-exchange zipalign apksigner android-sdk-platform-23
npm run build:web
npm run build:android
```

`scripts/build-android.mjs` stamps `versionName` and `versionCode` from `package.json`
(`1.2.3` → `10203`), so bump the version for every release.

### The signing key

Android installs an update only if it is signed with the same key as the installed app.
If the key changes, the app must be uninstalled first, and that deletes its data. The key
is therefore never committed (this repository is public). The build reads it from:

1. `GT2_KEYSTORE` (path), `GT2_KEYSTORE_PASS` and optionally `GT2_KEY_ALIAS` (default `gt2logbook`), or
2. `android/release.keystore` with `android/release.properties` beside it (both gitignored).

With neither, it creates a new key in (2) and says so. Keep both files safe: every later
release has to be signed with them. The certificate's SHA-256 is printed after each build
and recorded in the site's `release.json`, so you can check a download with
`apksigner verify --print-certs GT2-Logbook.apk`.

## Publishing to the website

```sh
npm run build && npm run build:android
npm run publish:site -- ../light-through-the-mirror
```

This copies `dist/web/` and the APK to `public/lab/gt2-logbook/` in the site repository
and writes `app/studio/bench/gt2-logbook/release.json`, which holds the version, size and
checksums that the bench page shows. Then commit the site and deploy it as usual.
`/lab/*` is served only to signed-in accounts (`worker/index.ts`), and
`public/_headers` keeps the files out of shared caches.
