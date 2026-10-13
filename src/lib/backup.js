// The full backup file: every day, night, workout and route, plus settings,
// as one JSON file. Restoring it brings the logbook back on a new phone or
// after reinstalling the app.

import { emptyDataset, workoutList } from './model.js';

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

/** Read a backup file's text: {ds, tracks, settings, sources, exportedAt}, or throw with a readable message. */
export function parseBackup(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('This file is not a GT 2 Logbook backup (it is not JSON).');
  }
  if (j?.app !== BACKUP_APP || typeof j.days !== 'object' || !Array.isArray(j.workouts)) {
    throw new Error('This file is not a GT 2 Logbook backup. Choose the file saved with "Full backup (JSON)".');
  }
  const ds = emptyDataset();
  for (const [date, row] of Object.entries(j.days || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(date) && row) ds.days[date] = row;
  for (const [date, n] of Object.entries(j.nights || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(date) && n) ds.nights[date] = n;
  for (const w of j.workouts) if (w?.id && w.date && Number.isFinite(w.start)) ds.workouts[w.id] = w;
  const tracks = {};
  for (const [id, t] of Object.entries(j.tracks || {})) if (ds.workouts[id] && t && typeof t === 'object') tracks[id] = t;
  return { ds, tracks, settings: j.settings || null, sources: j.sources || null, exportedAt: j.exportedAt || null };
}
