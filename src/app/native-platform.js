// The app builds (entry: app-entry.js). On Android, Capacitor plugins give the
// page on-device storage, the share sheet for exports and the back button.
// Opened in a browser, the same build uses IndexedDB and ordinary downloads.

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';
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
      sample: null, user: null, inViewer: false,
      secrets, native,
      ai: { ask: askClaude, models: MODELS, defaultModel: DEFAULT_MODEL },
      openUrl: (url) => window.open(url, '_blank', 'noopener'),
    };
  },
});
