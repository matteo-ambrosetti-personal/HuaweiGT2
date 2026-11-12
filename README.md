# GT 2 Logbook

A personal dashboard for a **Huawei Watch GT 2**. The same page ships three ways:

| Form | Where | Storage | Extras |
|---|---|---|---|
| **claude.ai Artifact** | Private artifact on claude.ai | The artifact's private per-user storage | Ask Claude, Google Drive (Health Sync) sync, intervals.icu bridge |
| **Web app** | [light-through-the-mirror.com/lab/gt2-logbook/](https://light-through-the-mirror.com/lab/gt2-logbook/) (signed-in accounts) | IndexedDB in your browser, on that device | Installable (PWA), works offline |
| **Android app** | `GT2-Logbook.apk`, from the bench page on the same site | Inside the app, on the phone | No account, no network except map downloads |

The web and Android versions are described in [docs/standalone.md](docs/standalone.md). The dashboard covers:
- **Activity:** steps, distance and calories.
- **Workouts:** GPS routes on a map you can zoom and hover (with an OpenStreetMap background of streets, paths, parks and water once you add it), km splits, best efforts, heart-rate zones, weekly distance, and the watch's training rating (training effect, load, recovery time, ground contact).
- **Sleep:** sleep stages.
- **Health:** heart rate, SpO2, stress and HRV.
- **Statistics:** records, streaks, year-by-year totals, and running fitness (the watch's race predictions and lactate threshold).

The page also has an **Ask Claude** panel and CSV/GPX/TCX exports.

Huawei offers no free API for personal use, so data gets in three ways:

| Path | What it brings | Automation | Cost |
|---|---|---|---|
| **Huawei privacy export** (ZIP + password) | Full history: workouts with GPS, steps, heart rate, sleep, SpO2, stress | Manual: request, download, drop into the page | Free |
| **Health Sync → Google Drive** | New days of steps, heart rate and SpO2 (per-minute CSVs); workouts as GPX/TCX when enabled | Automatic: read through the Google Drive connector when the page opens (at most hourly) or on **Sync now** | Small one-time fee for the Android app |
| **intervals.icu + GT2 Bridge** | New activities with GPS/HR, daily wellness | Automatic | Free (Cloudflare Workers free tier) |

## Privacy

- **Decryption:** the export ZIP is decrypted and parsed in your browser (zip.js and a Web Worker).
- **Storage:**
  - Parsed data is stored in the artifact's private per-user storage, under `data/users/<you>/`.
  - Other people who can open the artifact cannot read it.
  - Claude can read it when you ask, in a conversation or through the page's Ask Claude panel.
- **No other services:** the page sends nothing to any other service. Exports are offered through the platform's download prompt.
- **Map background:** claude.ai pages can't load map tiles, so the page draws its own map from OpenStreetMap data. You download that data once in your browser, through a link the page builds for the area around your routes. OpenStreetMap's server sees that area, never your tracks. The map is kept in your private storage. Map data © OpenStreetMap contributors (ODbL). Details: [docs/map-data.md](docs/map-data.md).
- **Google Drive:** the page may only call the connector's read tools `search_files` and `download_file_content`, as you, after you allow it once. It reads only files in folders named "Health Sync …".

## Using it

1. Request your data in the Huawei Health app ([docs/setup-export.md](docs/setup-export.md)): Me → your name → Privacy Centre → Request your data → Health. Set a password.
2. Open the artifact, go to **Data**, drop the ZIP and enter the password.
3. Optional automatic updates:
   - Health Sync: [docs/setup-health-sync.md](docs/setup-health-sync.md).
   - intervals.icu: [docs/setup-intervals-bridge.md](docs/setup-intervals-bridge.md).
4. Optional map background: **Data → Map → Download map data**, save what opens, then **Add the saved file** ([docs/map-data.md](docs/map-data.md)).

Before the first import the page shows clearly labelled **sample data** generated in the browser.

The web and Android apps work the same way, minus the claude.ai-only parts: no Ask Claude and no automatic sync. Add Health Sync's CSV, GPX and TCX files by hand under **Data → Add individual files**, and download the map with one button.

## Development

```sh
npm install
npm test               # unit tests (parsers, merge rules, statistics, GPX/TCX, Drive sync against a fake connector, IndexedDB store)
npm run fixture        # synthetic AES-encrypted export and OpenStreetMap download → test/fixtures/out/ (password test1234)
npm run build          # → dist/gt2-logbook.html (the published artifact) and dist/web/ (the standalone web app)
npm run build:android  # → dist/android/GT2-Logbook.apk (needs dist/web; tools listed in docs/standalone.md)
npm run test:e2e       # Chromium: imports the fixture, visits every tab, syncs from a fake Drive, saves screenshots/
npm run test:e2e:web   # Chromium: the standalone build — storage across reloads, offline, downloads, the app's save bridge
npm run publish:site -- ../light-through-the-mirror   # copy dist/web and the APK into the website repository
npm run lint
```

In this environment Playwright's Chromium lives outside its default path: prefix the e2e commands with `CHROMIUM_PATH=/opt/pw-browsers/chromium`.

| Path | Contents |
|---|---|
| `src/lib/` | Pure, Node-testable logic, also bundled into the parser worker |
| `src/lib/huawei/` | Export parsers (format notes: [docs/huawei-export-format.md](docs/huawei-export-format.md)) |
| `src/lib/model.js` | The normalised dataset and source precedence (export > intervals.icu > Health Sync; for steps and heart rate the more complete day wins) |
| `src/app/` | The page: storage on the artifact `db`, importer, views, d3 charts, Ask Claude, exports |
| `src/app/platform.js`, `local-store.js`, `downloads.js`, `src/sw.js` | The standalone build: what differs outside claude.ai, IndexedDB storage, file saving, the offline service worker |
| `android/` | The Android app: a WebView around `dist/web`, with a file picker and a save bridge |
| `assets/icons/` | App icons, drawn by `npm run icons` |
| `src/app/sync-drive.js` | Health Sync → Google Drive sync (file index, change detection, per-minute merge) |
| `src/lib/basemap.js`, `src/app/map-layer.js` | The OpenStreetMap background: download link, file conversion, drawing ([docs/map-data.md](docs/map-data.md)) |
| `bridge/` | The GT2 Bridge Cloudflare Worker (an OAuth-protected MCP connector for intervals.icu) |

In the artifact, d3 7.9.0 and zip.js 2.8.61 load from pinned CDN URLs at runtime and everything else is inlined by `scripts/build.mjs`. The standalone build loads nothing from elsewhere: it inlines both libraries and serves its fonts (Archivo and IBM Plex Sans, OFL, from Fontsource) beside the page.
