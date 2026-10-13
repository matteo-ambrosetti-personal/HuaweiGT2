# Huawei Health export format (as parsed here)

These notes come from Huawei's own field dictionaries (shipped inside every export), real 2025–2026 exports and existing parsers (Hitrava, TomSkywalker's aggregator). Fields vary by device and firmware; the importer is tolerant, and each import writes a format report.

## ZIP layout

- **Encryption:** AES-encrypted with the password chosen at request time. zip.js decrypts it in the browser.
- **Folders:** current exports put everything under `HUAWEI_HEALTH_<timestamp>/`. Older ones have no prefix, or a `data/` prefix.

| Folder | Files | Used for |
|---|---|---|
| `Motion path detail data & description/` | `motion path detail data<13 digits>.json` (chunks; older: one file) | Workouts and GPS tracks |
| `Health detail data & description/` | `health detail data<13 digits>.json`, one `type` per file | HR, resting HR, SpO2, stress, HRV, sleep spans, daily goals |
| `Sport per minute merged data & description/` | `sport per minute merged data<N>.json` | Steps, distance, calories |
| `Sample sequence data & description/` | `sample sequence data<13 digits>.json` | Nightly sleep summaries (type 700013) |

## Workouts (motion path)

- **Shape:** a flat array of records. Before mid-2020 it was `[{recordDay, motionPathData:[…]}]`.
- **Invalid JSON:** the outer `partTimeMap` uses bare numeric keys (`{1.0:868.0}`), so elements are parsed one at a time with a key-quoting fallback (`src/lib/json-stream.js`).
- **Duplicates:** the same workout can appear in several files. Dedupe by `recordId`, keeping the copy with most GPS points.

Units:

| Field | Unit |
|---|---|
| `startTime`, `endTime` | epoch ms (UTC) |
| `timeZone` | `"+HHMM"` |
| `totalTime` | moving ms |
| `totalDistance` | m |
| `totalCalories` | **cal** (÷ 1000 for kcal) |

`attribute` = `HW_EXT_TRACK_DETAIL@is<lines>&&HW_EXT_TRACK_SIMPLIFY@is<summary JSON>`.

**2026 layout.** Exports from 2026 (seen in an October 2026 export, files at the ZIP root without a `HUAWEI_HEALTH_<ts>/` prefix) store each workout differently:

```
{type: 30001, subType, startTime, endTime, timeZone: "+0200", recordId,
 detailData: "<the same tp=… lines>", summaryData: "<the summary JSON as a string>",
 appType, dataId, dataSource, deviceCode, mergedFlag, modifiedTime, tr, version}
```

- **What moved:** there is no `attribute`, and no top-level `sportType`, `totalDistance`, `totalTime`, `totalCalories` or `totalSteps`. All of them now sit inside the summary JSON, with the same units as before.
- **`subType`:** Huawei's field dictionary calls it "for service use only", so the sport is read from the summary's `sportType` (HiHealth codes: 258 outdoor run, 257 outdoor walk). Code 227 is not identified yet.
- **New detail tags:** `b-p-m`, `pm2`, `bpm2`, `r-r-h`, `apw`, `ext` and `act`. They are counted in the format report and not used yet.

Both layouts are read (`src/lib/huawei/motion.js`), and the synthetic export writes every third workout in the new layout.

- **Detail lines:** `tp=<tag>;k=…;…;`, one per line. Split on `;`; a naive `t=` regex matches inside `lat=`.
- **Summary:**

  | Field | Unit |
  |---|---|
  | `avgPace` | s/km |
  | `avgHeartRate`, `maxHeartRate` | bpm |
  | `avgStepRate` | steps per minute |
  | `creepingWave`, `mTotalDescent` | **decimetres** |
  | `mMaxAlti=1.4e-45`, `mMinAlti=3.4e38` | sentinels for "unset" |

  It also holds an inner `sportType` (HiHealth numbering) and `partTimeMap` (km → cumulative moving seconds; used for splits).

  The watch's own rating of the workout, shown as the **Training** row on a workout:

  | Field | Meaning |
  |---|---|
  | `wearSportData.etraining_effect` | aerobic training effect **× 10** (32 = 3.2 on the 0–5 scale) |
  | `wearSportData.anaerobic_exercise_etraining_effect` | anaerobic training effect × 10 |
  | `wearSportData.load_peak` | training load |
  | `wearSportData.recovery_time` | recovery time advised at the end, in **minutes**; walks carry the time left over from an earlier run |
  | `wearSportData.max_met` | large integers with no documented scale; not used |
  | `mAvgGroundContactTime` | ground contact time, ms; the other running-form fields are −1 on a GT 2 |

  Walks rate 0 for training effect and load, so they show no Training row.

Detail tags:

| Tag | Fields |
|---|---|
| `lbs` | `lat`, `lon`, `alt`, `t`. `t` is 13-digit ms, 10-digit s, scientific notation, or (2020–21) seconds of the local day. `lat=90;lon=-80` = pause marker (segment break). `0/0` = dummy. |
| `h-r` | `k` epoch ms (s in old exports), `v` bpm (keep 1–254) |
| `s-r` | steps per minute; `cad` cycling cadence |
| `alt` / `alti` | barometric altitude, both spellings |
| `rs` | `k` seconds since start, `v` speed in **dm/s** |
| `p-m` | per-km split; `k` = km×10⁷ + point index, `v` s/km |
| `rp`, `sec`, `swf`, `p-f`, `i-h-r` | counted in the format report, not used yet |

Outer `sportType` codes:

| Code | Sport | Code | Sport |
|---|---|---|---|
| 2 | Mountain hike | 103 | Indoor cycle |
| 3 | Outdoor cycle | 104 | Open-water swim |
| 4 | Outdoor run | 111 | Cross trainer |
| 5 | Outdoor walk | 112 | Rower |
| 101 | Indoor run | 117 | Free training |
| 102 | Pool swim | 118 | Cross-country run |
| 145 | CrossFit | 147 | Strength |
| 281 | Indoor walk | 282 | Hike |

Unknown codes show as "Type N"; a workout with no code at all shows as "Workout".

## Health detail

Records look like `{type, timeZone, samplePoints:[{key, value, startTime, endTime}]}`. Legacy keys carry numeric strings; 5000xx keys carry JSON strings.

| Metric | Type → key → value |
|---|---|
| Heart rate | 7 `DATA_POINT_DYNAMIC_HEARTRATE` "83.0" and 500023 `DYNAMIC_HEART_RATE` `{"bpm":83}`. Duplicates: the fuller one wins per day. |
| Resting HR | 7 `DATA_POINT_NEW_REST_HEARTRATE` / 500024 `{"restBpm"}` |
| Sleep stages | 9 `PROFESSIONAL_SLEEP_SHALLOW/DEEP/DREAM/WAKE/NOON` spans (duplicated ~2×; dedupe on stage + start + end); 3 `SLEEP_LIGHT/DEEP/AWAKE` (legacy) |
| SpO2 | 16 / 400021 `BLOOD_OXYGEN_SATURATION` `{"avgSaturation"}` or `{"spo2"}` |
| Stress | 11 `STRESS_DATA` `{"score"}` / 500026 `STRESS` `{"stressScore"}` (duplicates) |
| HRV | 500044 `{"heartRateVariabilityRMSSD"}` (ms) |
| Daily totals | 300002 `SPORT_GOAL_ACHIEVEMENT_DATA` `{stepUserValue, calorieUserValue}` (fallback for steps) |
| On/off bed | 500010 `SLEEP_ON_OFF_BED_RECORD` `{bedTime, risingTime}` in ms |
| Race predictions | 300009 `PREDICTED_TIMES` `{km1, km3, km5, km10, halfMarathon, marathon}` in s, about one record a day (2026 exports) |
| Lactate threshold | 300012 `LACTATE_THRESHOLD` `{lthrHr, lthrPace, source}`: bpm and s/km, after some runs |

The latest prediction and threshold of a day become `day.pred` and `day.lthr` (the Records tab's Running fitness). Two quirks in the predictions:
- **`km1` is not a 1 km time.** Per km it is far slower than `km3`, which no 1 km time next to that 3 km time could be, and Huawei's field list doesn't describe it. It is stored but not shown.
- **Some days don't add up.** For a few weeks the 5 km and longer times can drop below what the 3 km time allows (a 5 km faster than the 3 km). Days where a longer race is faster per km than a shorter one (2% leeway) are left out of the chart, and the page says how many.

## Per-minute data

`[{recordDay: 20250226, timeZone, sportDataUserData:[{startTime, sportBasicInfos:[{steps, distance, calorie, floor}]}]}]`

- **Calories:** small calories per minute. The parser switches to kcal when values look too small for cal.
- **Duplicates:** minutes reported twice (phone and watch) keep the larger count.

## Sleep summaries

Sample sequence type 700013 `summaryData` (a JSON string) holds:
- `bedTime`, `fallAsleepTime`, `wakeupTime`, `risingTime`, in **epoch seconds**;
- `sleepScore`, `sleepEfficiency`, `sleepLatency`, `wakeCount`, `deepPart`;
- min/max heart rate and SpO2.

255 and 65535 mean not available. A night is keyed by its wake-up date.
