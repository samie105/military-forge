/**
 * The installable app's service worker (the owner, 23 Oct: "make it a PWA"), emitted as /sw.js with
 * this build's version in it, so every deploy is a new worker. Deliberately small:
 * - pages (navigations): network first, the last good copy when offline (the game needs the network
 *   anyway; this is so an installed app opens to its own screen, not the browser's error);
 * - hashed bundles (/assets/name-HASH.ext): cache first, per version (they never change under a name);
 * - everything else (art, audio, models, the manifest): straight to the network and the browser's own
 *   cache, so a deploy never serves stale code or art;
 * - never: /api, /ws (game sockets), /admin, other origins, anything but GET.
 * Updates: a new worker installs and waits; the page tells it to take over on Home (src/pwa), never in
 * a match, and reloads there.
 */
import type { Plugin } from 'vite';

export function serviceWorkerSource(version: string): string {
  return `/* Military Forge service worker, build ${version} (apps/web/pwa.ts) */
const VERSION = ${JSON.stringify(version)};
const PAGES = 'mf-pages-' + VERSION;
const HASHED = 'mf-hashed-' + VERSION;
const NEVER = /^\\/(api|ws|admin)(\\/|$)|^\\/admin\\.html$|^\\/sw\\.js$/;
const IS_HASHED = /^\\/assets\\/.+-[A-Za-z0-9_-]{8,}\\.[a-z0-9]+$/;

self.addEventListener('install', (event) => {
  // the start page, for an installed app opened offline; no skipWaiting: the page says when
  event.waitUntil(caches.open(PAGES).then((c) => c.add('/')).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== PAGES && key !== HASHED) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// the page (src/pwa/index.ts) asks a waiting worker to take over, on Home only
self.addEventListener('message', (event) => {
  if (event.data === 'activate') self.skipWaiting();
});

async function networkFirst(request) {
  const cache = await caches.open(PAGES);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (e) {
    return (await cache.match(request)) || (await cache.match('/')) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(HASHED);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (request.mode === 'navigate') event.respondWith(networkFirst(request));
  else if (IS_HASHED.test(url.pathname)) event.respondWith(cacheFirst(request));
});
`;
}

/** Emits /sw.js into the build (none in dev: the page registers it in production builds only). */
export function pwa(): Plugin {
  const version = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: 'pwa-service-worker',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(version) });
    },
  };
}
