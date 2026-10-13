// Runtime capabilities (claude.ai artifact viewer). Every capability may be
// absent: in a local copy of the page window.claude does not exist, and inside
// the viewer a capability resolves null when it is not served or not granted.
// The app builds register their own runtime (platform.js).

import { platform } from './platform.js';

async function useCap(name) {
  try {
    if (!window.claude || typeof window.claude.use !== 'function') return null;
    return await window.claude.use(name);
  } catch {
    return null;
  }
}

/** Resolve the capabilities this page uses. Never throws. */
export async function getRuntime() {
  if (platform.getRuntime) return platform.getRuntime();
  // Only capabilities this page declares (an undeclared one may take ~10 s to
  // resolve null), plus the built-in `permissions`.
  const names = ['db', 'user', 'downloads', 'sample', 'mcp', 'permissions'];
  const [db, user, downloads, sample, mcp, permissions] = await Promise.all(names.map(useCap));
  let uid = null;
  if (user) {
    try {
      uid = await user.id();
    } catch {
      uid = null;
    }
  }
  return { db, user, uid, downloads, sample, mcp, permissions, storeKind: 'cloud', inViewer: Boolean(window.claude) };
}
