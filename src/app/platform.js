// Where this copy of the logbook runs.
//
// The same source builds twice (scripts/build.mjs):
//  - artifact: the claude.ai Artifact. Storage, downloads, Ask Claude and the
//    Google Drive connector come from the artifact runtime (runtime.js).
//  - standalone: a plain web page (light-through-the-mirror.com/lab/gt2-logbook/,
//    installable as a PWA) and the Android app that bundles the same page.
//    Storage is the browser's IndexedDB on this device, downloads go through the
//    browser (or the app's save dialog), and the claude.ai-only features are
//    left out rather than shown broken.

/* global BUILD_TARGET */
export const STANDALONE = typeof BUILD_TARGET !== 'undefined' && BUILD_TARGET === 'standalone';

/** The Android app's bridge (android/src/.../Bridge.java), or null in a browser. */
export function nativeBridge() {
  try {
    const n = typeof window !== 'undefined' ? window.GT2Native : null;
    return n && typeof n.begin === 'function' ? n : null;
  } catch {
    return null;
  }
}

/** Short words for where the data is kept, used in messages ("Saved to …"). */
export function storageWords(store) {
  if (store?.kind === 'cloud') return { saved: 'Saved to your private storage.', saving: 'Saving to your private storage in the background.', where: 'Private claude.ai storage (only you can read it)' };
  if (store?.kind === 'local') return { saved: 'Saved on this device.', saving: 'Saving on this device in the background.', where: nativeBridge() ? 'This app, on this phone only' : 'This browser, on this device only' };
  return { saved: null, saving: null, where: 'This browser tab only (not saved)' };
}
