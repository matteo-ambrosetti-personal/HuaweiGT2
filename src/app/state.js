// App state with a tiny subscribe/notify loop.

import { emptyDataset } from '../lib/model.js';
import { DEFAULT_SETTINGS } from '../lib/stats.js';
import { defaultMeta } from './store.js';

export const state = {
  ds: emptyDataset(),
  meta: defaultMeta(),
  diag: null,
  isSample: false,
  loading: true,
  route: 'overview',
  param: null,
  filter: { preset: '1y', custom: null, families: null },
  runtime: null,
  store: null,
  importer: null,
  tracks: {}, // id → track cache (session)
  busy: null, // {label, done, total}
  storageNote: null,
  // Google Drive (Health Sync) sync: status checking|unavailable|prompt|ready|denied|missing|reauth|…,
  // busy while running, progress {phase, done, total}, error {status, title, text, action?}, report.
  drive: { status: 'checking', busy: false, progress: null, error: null, report: null },
  syncIndex: null, // the stored Drive sync index (doc "hsync")
};

export function settings() {
  return { ...DEFAULT_SETTINGS, ...(state.meta.settings || {}) };
}

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function update(patch = {}) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

try {
  const saved = JSON.parse(localStorage.getItem('gt2.filter') || 'null');
  if (saved && typeof saved === 'object') state.filter = { ...state.filter, ...saved, custom: saved.custom || null };
} catch {
  /* storage unavailable */
}

export function saveFilter() {
  try {
    localStorage.setItem('gt2.filter', JSON.stringify(state.filter));
  } catch {
    /* ignore */
  }
}
