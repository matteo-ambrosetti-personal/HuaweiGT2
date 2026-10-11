# Automatic updates with Health Sync → Google Drive

[Health Sync](https://play.google.com/store/apps/details?id=nl.appyhapps.healthsync) is an Android app that can read Huawei Health. It writes two kinds of files into Google Drive automatically:
- new workouts, as GPX/TCX files with GPS and heart rate;
- daily health data, as CSV files.

The dashboard reads those files through claude.ai's free **Google Drive** connector.

## Status

The file parsers are in place: GPX, TCX and header-driven CSV (`src/lib/healthsync.js`). You can already add Health Sync files by hand from **Data → Add individual files**.

The automatic Drive sync is finished once the real folder layout and the connector's tool formats have been checked against your account. Until then the page does not guess them.

## Set it up

1. Install **Health Sync** on the Android phone paired with the watch. The first week is a free trial, then there is a small one-time fee.
2. Choose **Huawei Health** as the source and allow Health Sync in Huawei Health when asked.
3. Choose **Google Drive** as the destination. Enable activity files (GPX and TCX) and the health data CSVs (steps, heart rate, sleep).
4. In claude.ai open **Settings → Connectors** and reconnect **Google Drive**, then enable it in the chat where you work on the dashboard.
5. Tell Claude it's done. Claude will then:
   - look at one folder listing and one CSV;
   - finish the Drive sync;
   - republish the dashboard with a **Sync now** button.

## Caveats

- **GPS:** Health Sync only gets GPS while Huawei does not enforce its 2023 restriction on third-party apps. At the time of writing, Health Sync's store page says the rule is not enforced.
- **Delay:** data appears after Huawei Health uploads it to Huawei's cloud, which can lag.
