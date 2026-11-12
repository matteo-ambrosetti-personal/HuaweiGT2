/**
 * Offline shell for the standalone logbook (dist/web/sw.js, written by scripts/build.mjs).
 *
 * The page is one HTML file plus its fonts and icons, so caching those is
 * enough for it to open with no signal. Health data is never cached here: it
 * lives in IndexedDB, written by the page itself.
 *
 * Network first, cache as the fallback: the page is redeployed now and then,
 * and on light-through-the-mirror.com it sits behind a sign-in, so a
 * cache-first worker would keep handing back a build the server has replaced.
 * Only real successes are stored: a redirect to the login page must never
 * become the cached copy of the app.
 *
 * The build stamps CACHE with a hash of the page; a new name retires the old cache.
 */

const CACHE = '__CACHE__';
const SHELL = ['__SHELL__'];
const SCOPE = new URL('./', self.location).pathname;
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.location).pathname));

self.addEventListener('install', (event) => {
  // One missing file must not cost the whole offline copy, so each is added on its own.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(new Request(path, { cache: 'reload', redirect: 'error' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('gt2-logbook-') && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // The app's own files only. OpenStreetMap downloads, the rest of the site and
  // anything else in this folder (the Android build beside it) pass straight through.
  if (url.origin !== self.location.origin) return;
  const isPage = request.mode === 'navigate' && url.pathname === SCOPE;
  if (!isPage && !SHELL_PATHS.has(url.pathname)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic' && !response.redirected) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const page = await caches.match('index.html') || await caches.match('./');
          if (page) return page;
        }
        return Response.error();
      }),
  );
});
