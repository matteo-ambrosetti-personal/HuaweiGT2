# GT 2 Logbook

A personal dashboard for a **Huawei Watch GT 2**, published as a private claude.ai Artifact. It covers:
- **Activity:** steps, distance and calories.
- **Workouts:** GPS routes on a map you can zoom and hover, km splits, best efforts, heart-rate zones, weekly distance, and the watch's training rating (training effect, load, recovery time, ground contact).
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
- **No other services:** nothing is sent to any other service. Exports are offered through the platform's download prompt.
- **Google Drive:** the page may only call the connector's read tools `search_files` and `download_file_content`, as you, after you allow it once. It reads only files in folders named "Health Sync …".

## Using it

1. Request your data in the Huawei Health app ([docs/setup-export.md](docs/setup-export.md)): Me → your name → Privacy Centre → Request your data → Health. Set a password.
2. Open the artifact, go to **Data**, drop the ZIP and enter the password.
3. Optional automatic updates:
   - Health Sync: [docs/setup-health-sync.md](docs/setup-health-sync.md).
   - intervals.icu: [docs/setup-intervals-bridge.md](docs/setup-intervals-bridge.md).

Before the first import the page shows clearly labelled **sample data** generated in the browser.

## Development

```sh
npm install
npm test            # unit tests (parsers, merge rules, statistics, GPX/TCX, Drive sync against a fake connector)
npm run fixture     # synthetic AES-encrypted export → test/fixtures/out/ (password test1234)
npm run build       # → dist/gt2-logbook.html (the published artifact)
npm run test:e2e    # Chromium: imports the fixture, visits every tab, syncs from a fake Drive, saves screenshots/
npm run lint
```

| Path | Contents |
|---|---|
| `src/lib/` | Pure, Node-testable logic, also bundled into the parser worker |
| `src/lib/huawei/` | Export parsers (format notes: [docs/huawei-export-format.md](docs/huawei-export-format.md)) |
| `src/lib/model.js` | The normalised dataset and source precedence (export > intervals.icu > Health Sync; for steps and heart rate the more complete day wins) |
| `src/app/` | The page: storage on the artifact `db`, importer, views, d3 charts, Ask Claude, exports |
| `src/app/sync-drive.js` | Health Sync → Google Drive sync (file index, change detection, per-minute merge) |
| `bridge/` | The GT2 Bridge Cloudflare Worker (an OAuth-protected MCP connector for intervals.icu) |

d3 7.9.0 and zip.js 2.8.61 load from pinned CDN URLs at runtime. Everything else is inlined by `scripts/build.mjs`.
