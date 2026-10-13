// The full backup file: every day, night, workout and route, plus settings,
// as one JSON file, for keeping a copy outside the app.

import { workoutList } from './model.js';

export const BACKUP_APP = 'GT 2 Logbook';

export function backupJson(ds, tracks, meta = {}) {
  return JSON.stringify({
    app: BACKUP_APP,
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: meta.settings || {},
    sources: meta.sources || {},
    days: ds.days,
    nights: ds.nights,
    workouts: workoutList(ds, { asc: true }),
    tracks,
  });
}
