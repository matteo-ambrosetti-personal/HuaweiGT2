// The app builds (entry: app-entry.js). On Android, Capacitor plugins give the
// page on-device storage, the share sheet for exports, HTTP without CORS
// (intervals.icu) and Health Connect. Opened in a browser, the same build uses
// IndexedDB and ordinary downloads.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';
import { Health } from '@capgo/capacitor-health';
import { setPlatform } from './platform.js';
import { FsDocs, IdbDocs } from './local-docs.js';
import { askClaude, MODELS, DEFAULT_MODEL } from './claude-api.js';

const native = Capacitor.isNativePlatform();

// ------------------------------------------------------------------ files

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Native: write the file to the app cache and open the share sheet (Save to Drive, Files, email…). */
const nativeDownloads = {
  async save({ filename, data }) {
    const path = `exports/${filename}`;
    const body = typeof data === 'string'
      ? { data, encoding: Encoding.UTF8 }
      : { data: await blobToBase64(data instanceof Blob ? data : new Blob([data])) };
    const { uri } = await Filesystem.writeFile({ path, directory: Directory.Cache, recursive: true, ...body });
    try {
      await Share.share({ title: filename, files: [uri], dialogTitle: `Save or send ${filename}` });
    } catch (e) {
      // Closing the share sheet is not an error.
      if (/cancel/i.test(String(e?.message || e))) throw Object.assign(new Error('declined'), { code: 'declined' });
      throw e;
    }
  },
};

/** Browser: an ordinary download. */
const browserDownloads = {
  async save({ filename, data }) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: filename.endsWith('.csv') ? 'text/csv' : 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  },
};

// ------------------------------------------------------------------ http

/**
 * GET JSON or text from another site: natively (no CORS) in the app, else fetch.
 * Resolves {status, data}; data is parsed JSON when the response is JSON.
 */
async function httpGet(url, { headers = {}, timeout = 120000 } = {}) {
  if (native) {
    const res = await CapacitorHttp.get({ url, headers, connectTimeout: timeout, readTimeout: timeout });
    return { status: res.status, data: res.data };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ secrets

/** API keys stay on this device (app-private storage), never in exports or backups. */
const secrets = {
  get(name) {
    try {
      return JSON.parse(localStorage.getItem('gt2.secrets') || '{}')[name] || null;
    } catch {
      return null;
    }
  },
  set(name, value) {
    try {
      const all = JSON.parse(localStorage.getItem('gt2.secrets') || '{}');
      if (value) all[name] = value;
      else delete all[name];
      localStorage.setItem('gt2.secrets', JSON.stringify(all));
    } catch {
      /* storage unavailable */
    }
  },
};

// ------------------------------------------------------------------ lifecycle

if (native) {
  // Android back: step back through the app, and leave it from the overview.
  App.addListener('backButton', ({ canGoBack }) => {
    const route = (location.hash || '#overview').slice(1);
    if (route && route !== 'overview' && canGoBack) history.back();
    else if (route && route !== 'overview') location.hash = 'overview';
    else App.exitApp();
  });
  App.addListener('resume', () => window.dispatchEvent(new Event('gt2-resume')));
  document.documentElement.classList.add('native');
}

setPlatform({
  name: native ? 'android' : 'browser',
  app: true,
  getRuntime: async () => {
    const db = native ? new FsDocs(Filesystem, { directory: Directory.Data }) : new IdbDocs();
    if (!native) navigator.storage?.persist?.().catch(() => {});
    return {
      db, uid: 'local', storeKind: 'device',
      downloads: native ? nativeDownloads : browserDownloads,
      sample: null, mcp: null, permissions: null, user: null, inViewer: false,
      http: httpGet, secrets, native,
      health: native ? Health : null,
      ai: { ask: askClaude, models: MODELS, defaultModel: DEFAULT_MODEL },
      openUrl: (url) => window.open(url, '_blank', 'noopener'),
    };
  },
});
