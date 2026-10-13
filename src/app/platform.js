// Where the page runs, and the capabilities that differ between targets:
//   artifact — the claude.ai Artifact (runtime capabilities from window.claude);
//   android  — the Capacitor Android app (native-platform.js fills this in);
//   browser  — the app build opened in a browser (same, without native plugins).
// Entry points register their platform before main.js boots.

export const platform = {
  name: 'artifact',
  /** True for the app builds (android and browser). */
  app: false,
  /** () => Promise<runtime> replacing the artifact runtime, or null. */
  getRuntime: null,
};

export function setPlatform(patch) {
  Object.assign(platform, patch);
}
