/**
 * The installable app's service worker (the owner, 23 Oct: "make it a PWA"), emitted as /sw.js with
 * this build's version in it, so every deploy is a new worker. Deliberately small:
 * - pages (navigations): network first, the last good copy when offline (an installed app opens to
 *   its own screen, not the browser's error);
 * - hashed bundles (/assets/name-HASH.ext, right under /assets/): cache first, per version (they never
 *   change under a name);
 * - the game's art, models, maps and sounds (/assets/…/, /art/, /icons/, the manifest): network first,
 *   so a deploy never serves stale files (each fetch revalidates, 304 when unchanged, even past a copy
 *   the browser's own cache still counts as fresh),
 *   and the last good copy when offline, so training draws its soldiers and guns with no connection
 *   (audit 28 Oct: they were invisible offline). That cache outlives versions (each fetch refreshes it)
 *   and keeps the newest MAX_ASSETS files;
 * - the page tells the worker what it loaded before the worker took control (src/pwa: the game's own
 *   chunks on a first visit), and the worker keeps those too;
 * - never: /api, /ws (game sockets), /admin, /health, the probe, other origins, anything but GET,
 *   ranges (a video's parts).
 * Updates: a new worker installs and waits; the page tells it to take over on Home (src/pwa), never in
 * a match, and reloads there.
 */
import type { Plugin } from 'vite';

export function serviceWorkerSource(version: string, chunks: readonly string[] = []): string {
  return `/* Military Forge service worker, build ${version} (apps/web/pwa.ts) */
const VERSION = ${JSON.stringify(version)};
// the game page's code, every chunk it can load (the Locker's, the portraits'…): kept once the player
// heads for play, so training starts offline even where a chunk never loaded online
const CHUNKS = ${JSON.stringify(chunks)};
const PAGES = 'mf-pages-' + VERSION;
const HASHED = 'mf-hashed-' + VERSION;
const ASSETS = 'mf-assets';
const MAX_ASSETS = 600;
const NEVER = /^\\/(api|ws|admin|probe-api|trial-status)(\\/|$)|^\\/(admin\\.html|sw\\.js|health|echo|probe-config\\.json)$|^\\/owner-/;
const IS_HASHED = /^\\/assets\\/[^/]+-[A-Za-z0-9_-]{8}\\.[a-z0-9]+$/;
const IS_ASSET = /^\\/(assets|art|icons|audio|licenses)\\/|^\\/(manifest\\.webmanifest|boot\\.js|favicon\\.svg)$/;

self.addEventListener('install', (event) => {
  // the start page, for an installed app opened offline; no skipWaiting: the page says when
  event.waitUntil(caches.open(PAGES).then((c) => c.add('/')).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // the last version's own caches only (the page keeps its own, e.g. the portraits')
      for (const key of await caches.keys()) if (/^mf-(pages|hashed)-/.test(key) && key !== PAGES && key !== HASHED) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

/** Keeps the newest MAX_ASSETS files (a cache lists its entries oldest first). */
async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i]);
}

/** A copy worth keeping: a whole file (not a part, a redirect or an error). */
function keep(cacheName, request, response) {
  if (response.status !== 200 || response.type === 'opaque') return;
  const copy = response.clone();
  caches
    .open(cacheName)
    .then(async (cache) => {
      if (cacheName === ASSETS) await cache.delete(request);
      await cache.put(request, copy);
      if (cacheName === ASSETS) await trim(cache);
    })
    .catch(() => {});
}

/** Which cache a same-origin path belongs in (null: none). */
function cacheFor(pathname) {
  if (NEVER.test(pathname)) return null;
  if (IS_HASHED.test(pathname)) return HASHED;
  if (IS_ASSET.test(pathname)) return ASSETS;
  return null;
}

// the page (src/pwa/index.ts): a waiting worker takes over (on Home only); the files it loaded before we
// took control are kept, so a first visit can reload offline
self.addEventListener('message', (event) => {
  if (event.data === 'activate') self.skipWaiting();
  else if (event.data && event.data.type === 'keep' && Array.isArray(event.data.urls)) event.waitUntil(keepLoaded(event.data.all ? event.data.urls.concat(CHUNKS) : event.data.urls));
});

async function keepLoaded(urls) {
  for (const href of urls.slice(0, 600)) {
    try {
      const url = new URL(href, self.location.origin);
      const name = url.origin === self.location.origin ? cacheFor(url.pathname) : null;
      if (!name || (await caches.match(url.href))) continue;
      keep(name, new Request(url.href), await fetch(url.href));
    } catch (e) {
      // offline already, or gone: the next visit tries again
    }
  }
}

// assets ask the server every time (cache: 'no-cache'), even where the browser still holds a copy it
// may reuse: before 28 Oct the server let browsers keep models for 7 days, so a returning player's
// cached model could name a file a later deploy renamed (29 Oct: the dye masks became .webp)
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(cacheName === ASSETS ? new Request(request, { cache: 'no-cache' }) : request);
    keep(cacheName, request, response);
    return response;
  } catch (e) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    if (cacheName === PAGES) return (await cache.match('/')) || Response.error();
    throw e;
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  keep(HASHED, request, response);
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (request.mode === 'navigate') return event.respondWith(networkFirst(request, PAGES));
  const name = cacheFor(url.pathname);
  if (name === HASHED) event.respondWith(cacheFirst(request));
  else if (name === ASSETS) event.respondWith(networkFirst(request, ASSETS));
});
`;
}

/** Emits /sw.js into the build (none in dev: the page registers it in production builds only). */
export function pwa(): Plugin {
  const version = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: 'pwa-service-worker',
    apply: 'build',
    // after Vite's own: CSS-only chunks are gone from the bundle by then
    enforce: 'post',
    generateBundle(_options, bundle) {
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(version, gameChunks(bundle)) });
    },
  };
}

interface ChunkLike {
  type: 'chunk' | 'asset';
  fileName: string;
  isEntry?: boolean;
  facadeModuleId?: string | null;
  imports?: readonly string[];
  dynamicImports?: readonly string[];
  viteMetadata?: { importedCss?: Set<string> };
}

/** Every script and stylesheet the game page (index.html) can load, static and lazy, as /assets/… paths. */
export function gameChunks(bundle: Record<string, ChunkLike>): string[] {
  const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry && /[/\\]index\.html$/.test(c.facadeModuleId ?? ''));
  if (!entry) return [];
  const seen = new Set<string>();
  const css = new Set<string>();
  const walk = (name: string) => {
    if (seen.has(name)) return;
    const chunk = bundle[name];
    if (!chunk || chunk.type !== 'chunk') return;
    seen.add(name);
    for (const c of chunk.viteMetadata?.importedCss ?? []) css.add(c);
    for (const next of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) walk(next);
  };
  walk(entry.fileName);
  return [...seen, ...css].map((f) => `/${f}`).sort();
}
