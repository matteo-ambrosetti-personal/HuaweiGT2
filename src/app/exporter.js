// Exports through the `downloads` capability (the viewer confirms each save).
// GPX/TCX are not on the platform's download allowlist, so routes ship in a .zip.

import { toCsv } from '../lib/csv.js';
import { toGpx, toTcx } from '../lib/gpx.js';
import { fmtDuration, fmtPace, fmtClock } from '../lib/format.js';
import { backupJson } from '../lib/backup.js';
import { toast } from './ui.js';

const stamp = () => new Date().toISOString().slice(0, 10);

async function save(downloads, filename, data) {
  if (!downloads) {
    toast('Saving files is not available in this view.');
    return false;
  }
  try {
    await downloads.save({ filename, data });
    toast(`Saved ${filename}`);
    return true;
  } catch (e) {
    const copy = {
      declined: null,
      rate_limited: 'Another download prompt is open. Finish it first.',
      too_large: 'That file is too large for this destination. Try a shorter period.',
      rejected_extension: 'That file type cannot be downloaded here.',
      extension_not_enabled: 'That file type is turned off in this view.',
    }[e?.code];
    if (copy !== null) toast(copy || 'The download did not start. Try again.');
    return false;
  }
}

export function workoutsCsv(workouts) {
  return toCsv(workouts.slice().sort((a, b) => a.start - b.start), [
    { label: 'date', get: (w) => w.date },
    { label: 'start', get: (w) => fmtClock(w.start, w.tz) },
    { label: 'sport', get: (w) => w.label },
    { label: 'family', get: (w) => w.family },
    { label: 'distance_km', get: (w) => (w.distance ? (w.distance / 1000).toFixed(3) : '') },
    { label: 'moving_time', get: (w) => fmtDuration(w.duration) },
    { label: 'moving_seconds', get: (w) => w.duration ?? '' },
    { label: 'pace_per_km', get: (w) => (w.family !== 'ride' && w.distance > 0 ? fmtPace(w.duration / (w.distance / 1000)) : '') },
    { label: 'speed_kmh', get: (w) => (w.distance > 0 && w.duration > 0 ? ((w.distance / w.duration) * 3.6).toFixed(2) : '') },
    { label: 'avg_hr', get: (w) => w.avgHr ?? '' },
    { label: 'max_hr', get: (w) => w.maxHr ?? '' },
    { label: 'ascent_m', get: (w) => w.ascent ?? '' },
    { label: 'kcal', get: (w) => w.kcal ?? '' },
    { label: 'steps', get: (w) => w.steps ?? '' },
    { label: 'cadence', get: (w) => w.avgCadence ?? '' },
    { label: 'source', get: (w) => (w.sources || [w.source]).join('+') },
  ]);
}

export function dailyCsv(ds) {
  const dates = [...new Set([...Object.keys(ds.days), ...Object.keys(ds.nights)])].sort();
  return toCsv(dates.map((d) => ({ d, day: ds.days[d] || {}, night: ds.nights[d] || {} })), [
    { label: 'date', get: (r) => r.d },
    { label: 'steps', get: (r) => r.day.steps ?? '' },
    { label: 'distance_km', get: (r) => (r.day.distance != null ? (r.day.distance / 1000).toFixed(2) : '') },
    { label: 'active_kcal', get: (r) => r.day.kcal ?? '' },
    { label: 'active_minutes', get: (r) => r.day.activeMin ?? '' },
    { label: 'resting_hr', get: (r) => r.day.restHr ?? '' },
    { label: 'hr_min', get: (r) => r.day.hrMin ?? '' },
    { label: 'hr_avg', get: (r) => r.day.hrAvg ?? '' },
    { label: 'hr_max', get: (r) => r.day.hrMax ?? '' },
    { label: 'hrv_ms', get: (r) => r.day.hrvAvg ?? '' },
    { label: 'spo2', get: (r) => r.day.spo2Avg ?? '' },
    { label: 'stress', get: (r) => r.day.stressAvg ?? '' },
    { label: 'sleep_min', get: (r) => r.night.total ?? '' },
    { label: 'deep_min', get: (r) => r.night.deep ?? '' },
    { label: 'light_min', get: (r) => r.night.light ?? '' },
    { label: 'rem_min', get: (r) => r.night.rem ?? '' },
    { label: 'awake_min', get: (r) => r.night.awake ?? '' },
    { label: 'sleep_score', get: (r) => r.night.score ?? '' },
  ]);
}

export async function exportWorkoutsCsv(downloads, workouts) {
  return save(downloads, `gt2-workouts-${stamp()}.csv`, workoutsCsv(workouts));
}

export async function exportDailyCsv(downloads, ds) {
  return save(downloads, `gt2-daily-${stamp()}.csv`, dailyCsv(ds));
}

export async function exportBackup(downloads, ds, tracks, meta) {
  return save(downloads, `gt2-logbook-backup-${stamp()}.json`, backupJson(ds, tracks, meta));
}

/**
 * Zip GPX or TCX files for workouts with tracks.
 * loadTrack(id) → Promise<track|null>
 */
export async function exportRoutes(downloads, workouts, format, loadTrack, onProgress = () => {}) {
  const zip = window.zip;
  if (!zip) {
    toast('The ZIP writer did not load. Reload the page and try again.');
    return false;
  }
  const withTrack = workouts.filter((w) => w.hasTrack);
  if (!withTrack.length) {
    toast('None of these workouts has a route or samples to export.');
    return false;
  }
  zip.configure({ useWebWorkers: false });
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
  let n = 0;
  for (const w of withTrack) {
    const track = await loadTrack(w.id);
    onProgress({ done: ++n, total: withTrack.length });
    if (!track) continue;
    const text = format === 'tcx' ? toTcx(w, track) : toGpx(w, track);
    const name = `${w.date}_${String(fmtClock(w.start, w.tz)).replace(':', '')}_${w.family}.${format}`;
    await writer.add(name, new zip.TextReader(text));
  }
  const blob = await writer.close();
  const fname = withTrack.length === 1
    ? `${withTrack[0].date}-${withTrack[0].family}-${format}.zip`
    : `gt2-routes-${format}-${stamp()}.zip`;
  return save(downloads, fname, blob);
}
