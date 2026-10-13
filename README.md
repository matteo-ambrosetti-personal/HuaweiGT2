# GT 2 Logbook

A personal logbook for a **Huawei Watch GT 2**, as an **Android app** (and as a
private claude.ai Artifact). It covers:
- **Insights:** what published sports-science and sleep models say about your latest weeks, each with its source, plus a recovery summary and the patterns in your own data.
- **Training:** fitness, fatigue and form, acute:chronic load, monotony, intensity distribution, and running fitness (VDOT, VO2max, efficiency, your speed–distance curve).
- **Activity:** steps, distance and calories, step-count bands, and your rest–activity rhythm.
- **Workouts:** GPS routes on a map you can zoom and hover, km splits, best efforts, heart-rate zones, load and aerobic decoupling, and the watch's training rating.
- **Sleep:** sleep stages, a two-process model of sleep pressure, social jetlag and chronotype, and sleep regularity.
- **Heart and health:** heart rate, SpO2, stress and HRV, each against your own baseline, and your daily heart-rate rhythm.
- **Records:** best efforts, streaks, year-by-year totals, and the watch's race predictions next to your own.

**Install the app:** download [`gt2-logbook.apk`](https://github.com/matteo-ambrosetti-personal/HuaweiGT2/releases/latest/download/gt2-logbook.apk) on your phone and open it ([details](docs/android.md)).

## The models

Every number on the Insights and Training tabs comes from a published model, applied to your own data (`src/lib/models/`, unit-tested against the papers' values):

| Area | Models |
|---|---|
| Training load | Banister TRIMP (heart-rate reserve, exponentially weighted) and Edwards' zone TRIMP; Banister's impulse–response fitness/fatigue/form (Performance Management Chart); EWMA acute:chronic workload ratio (Williams 2017, Gabbett 2016); Foster's monotony and strain (1998) |
| Intensity | Seiler's three-zone distribution, Treff's polarization index (2019) |
| Running | Daniels & Gilbert VDOT with race equivalents and training paces; Riegel's endurance exponent fitted to your best efforts; critical speed (Monod & Scherrer; Hill); VO2max from steady runs (ACSM equation, Swain & Leutholtz %HRR ≈ %VO2R) and from resting HR (Uth 2004); efficiency factor and aerobic decoupling (Friel); max HR after Tanaka (208 − 0.7 × age) |
| Recovery | ln RMSSD 7-day mean against a 60-day baseline ± the smallest worthwhile change (Plews 2012, 2013); resting HR against a robust 30-day baseline |
| Sleep | Borbély's two-process model (Daan 1984 parameters); sleep balance (Van Dongen 2003); social jetlag and MSFsc chronotype (Wittmann 2006, Roenneberg 2012); Sleep Regularity Index (Phillips 2017) |
| Rhythms and steps | Cosinor analysis of heart rate; interdaily stability, intradaily variability and relative amplitude (Witting 1990, Van Someren 1999); Tudor-Locke step bands; Paluch 2022 |
| Patterns | Spearman correlations, same day and next day, with Benjamini–Hochberg false-discovery control |

Wrist sensors estimate, and none of this is medical advice: the app says so where it matters, and frames changes as prompts to look at sleep, stress and load.

## Getting data in

There is one way in: the **Huawei privacy export**. In the Huawei Health app request your data (Me → your account → Privacy Centre → Request your data → Health), download the ZIP from the email link and choose it under **Data → Import** with the password you set ([setup-export.md](docs/setup-export.md)). It brings your full history: workouts with GPS, steps, heart rate, sleep, SpO2 and stress. Import a newer export whenever you want to bring the logbook up to date; it merges with what is already there.

Nothing syncs by itself, and the app reads no other files, accounts or services for data.

**Ask Claude** answers questions about your data: in the artifact with your Claude usage, in the app with your own Anthropic API key (Claude Opus 5.5 by default).

## Privacy

- **App:** data stays in the app's private storage on the phone; cloud backup is off. It connects only to the OpenStreetMap map server and api.anthropic.com, each only when you ask. Details: [docs/android.md](docs/android.md).
- **Artifact:** the export is decrypted and parsed in your browser and stored in the artifact's private per-user storage (`data/users/<you>/`); Claude can read it when you ask. The page calls no connectors.
- **Map:** OpenStreetMap's server sees the area you download, never your tracks. Map data © OpenStreetMap contributors (ODbL). Details: [docs/map-data.md](docs/map-data.md).

## Development

```sh
npm install
npm test               # unit tests: export parsers, merge rules, statistics, the models, storage, exports
npm run fixture        # synthetic AES-encrypted export and OpenStreetMap download → test/fixtures/out/ (password test1234)
npm run build          # → dist/gt2-logbook.html (the artifact)
npm run build:app      # → www/ (the app: runs in the APK or any browser)
npm run android:sync   # build www/ and copy it into android/; then ./gradlew assembleRelease in android/
npm run test:e2e       # Chromium: the artifact, every tab, import, maps, the ZIP as the only way in
npm run test:e2e:app   # Chromium at phone size: the app, every tab, an import that survives a reload, the backup file
npm run lint
```

| Path | Contents |
|---|---|
| `src/lib/` | Pure, Node-testable logic, also bundled into the parser worker |
| `src/lib/models/` | The literature models and the insight cards |
| `src/lib/huawei/` | Export parsers (format notes: [docs/huawei-export-format.md](docs/huawei-export-format.md)) |
| `src/lib/model.js` | The normalised dataset and how exports merge (a newer export fills in; for steps and heart rate the more complete day wins) |
| `src/app/` | The page: storage, the ZIP importer, views, d3 charts, Ask Claude, exports |
| `src/app/native-platform.js` | The app's platform: on-device storage, share sheet, back button, Ask Claude ([docs/android.md](docs/android.md)) |
| `android/` | The Capacitor Android project |

The artifact loads d3 7.9.0 and zip.js 2.8.61 from pinned CDN URLs; the app bundles them, and the fonts, locally.
