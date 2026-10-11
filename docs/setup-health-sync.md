# Automatic updates with Health Sync → Google Drive

[Health Sync](https://play.google.com/store/apps/details?id=nl.appyhapps.healthsync) is an Android app that reads Huawei Health and writes the data into Google Drive. The dashboard reads those files through claude.ai's **Google Drive** connector:
- when you open it, at most once an hour;
- when you press **Sync now** in **Data → Automatic updates**.

## Set it up

1. Install **Health Sync** on the Android phone paired with the watch. The first week is a free trial, then there is a small one-time fee.
2. Choose **Huawei Health** as the source and allow Health Sync in Huawei Health when asked.
3. Choose **Google Drive** as the destination and enable steps, heart rate and SpO2. Activities (GPX/TCX) and sleep are optional.
4. In claude.ai open **Settings → Connectors** and connect **Google Drive**.
5. Open the logbook → **Data** → **Connect and sync**. claude.ai asks once whether this page may use Google Drive; choose **Allow**.

   From then on the logbook syncs by itself when you open it. If Google Drive is not allowed for the page, nothing happens until you press the button: the page never asks on its own.

## What it reads

Health Sync makes one folder per data type in My Drive. The names follow the phone's language; in Italian they look like this:

| Folder | Files | Used for |
|---|---|---|
| `Health Sync Passi` | `Passi YYYY.MM.DD Huawei Health.csv` (one per day) and `Passi WW-YYYY Huawei Health.csv` (weekly history) | Steps per day and per hour, active minutes |
| `Health Sync Freq. cardiaca` | same pattern | Heart rate: min, average, max, per hour |
| `Health Sync Saturazione di ossigeno` | same pattern | SpO2: average and minimum |

Each CSV has one row per minute that has data, in local time:

```
Data,Orario,Passi
2026.03.07 08:00:00,08:00:00,40
```

Heart-rate files add an `Origine` column (empty so far).

- **Folders:** any folder whose name starts with "Health Sync" is read, so new types are picked up when you enable them.
- **GPX/TCX:** activity files become workouts with their route.
- **Other files:** a CSV the page does not understand yet (for example sleep) is listed under **Not used yet** with its column names. Ask Claude to add it once such a file exists.

## How a sync works

`src/app/sync-drive.js` does the work.

1. **Find the files.** The page finds the "Health Sync …" folders, then lists the files changed since the last sync. The list is scoped to those folders and filtered by modified time.
2. **Read and merge.** It downloads only new or changed files. A daily file and a weekly file can contain the same minutes, so every touched day is rebuilt from all the files that cover it, minute by minute. A minute is never counted twice; if two files disagree, the newer one wins.
3. **Save.** The days go to your private storage. Then a small index of the files read goes to `data/users/<you>/hsync`: file ids, modified times and the days each covers, never values. If saving fails, the same files are simply read again next time.
4. **Handle failures.** A file that cannot be read is retried on the next sync. A problem with the connector (reconnect, not allowed, not connected) is shown in the Drive card with the fix, and nothing is changed.

**Precedence:** data from a Huawei export always wins over Health Sync for the same day.

## Privacy

- **Tools:** the page declares only two read tools of the Google Drive connector, `search_files` and `download_file_content`. It cannot create, change, share or delete anything in your Drive.
- **Scope:** it only lists folders named "Health Sync …" and the files inside them.
- **Credentials:** calls run with your Google Drive connection through claude.ai; the page never sees a token.
- **Sharing:** because the page uses a connector, it cannot be shared with a public link.

## Caveats

- **History:** during the trial, Health Sync only syncs data from when you started using it. Older history comes from the Huawei export.
- **Delay:** data appears after the watch has synced to Huawei Health and Health Sync has run, which can take a while.
- **GPS:** Health Sync only gets GPS for activities while Huawei does not enforce its 2023 restriction on third-party apps.
