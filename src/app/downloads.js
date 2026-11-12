// Saving exported files in the standalone build, with the same interface as the
// artifact runtime's `downloads` capability: save({filename, data}) resolves when
// the file is saved and rejects with {code: 'declined'} when the person cancels.
//
// In a browser that is an ordinary download. In the Android app a WebView cannot
// download a blob: URL, so the bytes go to the app's bridge in base64 chunks and
// the app asks where to save them (the system "Save to" dialog).

import { nativeBridge } from './platform.js';

const MIME = { csv: 'text/csv', json: 'application/json', zip: 'application/zip', gpx: 'application/gpx+xml', tcx: 'application/vnd.garmin.tcx+xml' };
export const mimeFor = (name) => MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

// 3 × 2^18 bytes: a multiple of 3, so each chunk is complete base64 on its own.
const CHUNK = 3 * 262144;

export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return new TextEncoder().encode(String(data));
}

const pending = new Map();
let seq = 0;

/** Called by the app when its save dialog is done: result is 'ok', 'cancelled' or 'error'. */
function onNativeSaved(id, result) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (result === 'ok') p.resolve();
  else p.reject(Object.assign(new Error(`Save ${result}`), { code: result === 'cancelled' ? 'declined' : 'native_error' }));
}

async function saveNative(bridge, { filename, data }) {
  const bytes = await toBytes(data);
  const id = `s${Date.now().toString(36)}${(++seq).toString(36)}`;
  if (typeof window !== 'undefined') window.GT2NativeSaved = onNativeSaved;
  const done = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  bridge.begin(id, filename, mimeFor(filename));
  for (let i = 0; i < bytes.length; i += CHUNK) bridge.append(id, toBase64(bytes.subarray(i, i + CHUNK)));
  bridge.finish(id);
  return done;
}

function saveBrowser({ filename, data }) {
  const blob = typeof Blob !== 'undefined' && data instanceof Blob ? data : new Blob([data], { type: mimeFor(filename) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return Promise.resolve();
}

/** The `downloads` stand-in for the standalone build. */
export function standaloneDownloads() {
  return {
    save(file) {
      const bridge = nativeBridge();
      return bridge ? saveNative(bridge, file) : saveBrowser(file);
    },
  };
}
