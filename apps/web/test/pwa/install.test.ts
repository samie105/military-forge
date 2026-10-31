import { describe, expect, it } from 'vitest';
import { gameChunks, serviceWorkerSource } from '../../pwa';
import { AGAIN_AFTER_SESSIONS, counted, freshMemory, freshStats, isIosSafari, launchedInstalled, loadInstallMemory, saveInstallMemory, shouldOffer, type InstallMemory } from '../../src/pwa/install';

const ctx = (p: Partial<Parameters<typeof shouldOffer>[1]> = {}) => ({ kind: 'prompt' as const, installed: false, matchesFinished: 1, shownThisSession: false, ...p });
const mem = (p: Partial<InstallMemory> = {}) => ({ ...freshMemory(), sessions: 1, ...p });

describe('the install toast: when it may show', () => {
  it('first on the first Home visit (Android and iPhone alike), only where the browser can install us, never once installed', () => {
    expect(shouldOffer(mem(), ctx({ matchesFinished: 0 }))).toBe(true);
    expect(shouldOffer(mem({ dismissedAt: 1 }), ctx({ matchesFinished: 0 }))).toBe(false);
    expect(shouldOffer(mem(), ctx())).toBe(true);
    expect(shouldOffer(mem(), ctx({ kind: null }))).toBe(false);
    expect(shouldOffer(mem(), ctx({ kind: 'ios' }))).toBe(true);
    // iPhone Safari: from the first Home visit, before any match (only a home-screen launch drops the bars)
    expect(shouldOffer(mem(), ctx({ kind: 'ios', matchesFinished: 0 }))).toBe(true);
    expect(shouldOffer(mem({ dismissedAt: 1 }), ctx({ kind: 'ios', matchesFinished: 0 }))).toBe(false);
    expect(shouldOffer(mem(), ctx({ installed: true }))).toBe(false);
    expect(shouldOffer(mem({ accepted: true }), ctx())).toBe(false);
    expect(shouldOffer(mem(), ctx({ shownThisSession: true }))).toBe(false);
  });

  it('after Not now: again every 3rd session, or after another match; never twice a session', () => {
    const said = mem({ sessions: 4, dismissedAt: 4, matchesAtDismiss: 2 });
    expect(shouldOffer(said, ctx({ matchesFinished: 2 }))).toBe(false);
    expect(shouldOffer({ ...said, sessions: 4 + AGAIN_AFTER_SESSIONS - 1 }, ctx({ matchesFinished: 2 }))).toBe(false);
    expect(shouldOffer({ ...said, sessions: 4 + AGAIN_AFTER_SESSIONS }, ctx({ matchesFinished: 2 }))).toBe(true);
    expect(shouldOffer(said, ctx({ matchesFinished: 3 }))).toBe(true);
    expect(shouldOffer(said, ctx({ matchesFinished: 3, shownThisSession: true }))).toBe(false);
  });

  it('iPhone and iPad Safari get the guide; Chrome or an in-app browser on iOS don’t', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    expect(isIosSafari(iphone)).toBe(true);
    expect(isIosSafari(iphone.replace('Version/17.5', 'CriOS/130.0'))).toBe(false);
    expect(isIosSafari(`${iphone} Instagram 300.0`)).toBe(false);
    expect(isIosSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 5, 'MacIntel')).toBe(true); // iPadOS
    expect(isIosSafari('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36')).toBe(false);
  });

  it('installed: launched in full screen or standalone, or an iOS home-screen app', () => {
    expect(launchedInstalled((q) => q === '(display-mode: fullscreen)')).toBe(true);
    expect(launchedInstalled(() => false, true)).toBe(true);
    expect(launchedInstalled(() => false)).toBe(false);
  });

  it('its memory round-trips and survives junk', () => {
    const data: Record<string, string> = {};
    const store = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
    const stats = { offered: 3, prompted: 2, accepted: 1, dismissed: 1 };
    saveInstallMemory(store, mem({ sessions: 7, dismissedAt: 5, matchesAtDismiss: 2, stats }));
    expect(loadInstallMemory(store)).toEqual({ sessions: 7, dismissedAt: 5, matchesAtDismiss: 2, accepted: false, stats });
    // a memory from before the counts: they start at 0
    data['mf.install.v1'] = '{"sessions":4,"dismissedAt":null,"matchesAtDismiss":0,"accepted":false}';
    expect(loadInstallMemory(store).stats).toEqual(freshStats());
    data['mf.install.v1'] = '{"sessions":"x","dismissedAt":"y"}';
    expect(loadInstallMemory(store)).toEqual(freshMemory());
  });
});

describe('the install counts (on the device only)', () => {
  it('counts one at a time, never changing the memory in place', () => {
    const m = mem();
    const once = counted(m, 'offered');
    expect(once.stats).toEqual({ ...freshStats(), offered: 1 });
    expect(m.stats.offered).toBe(0);
    expect(counted(counted(once, 'prompted'), 'accepted').stats).toEqual({ offered: 1, prompted: 1, accepted: 1, dismissed: 0 });
  });
});

describe('the service worker', () => {
  const src = serviceWorkerSource('20261023-abc');
  it('is this build’s (a deploy is a new worker), and waits to be told to take over', () => {
    expect(src).toContain('"20261023-abc"');
    expect(src).not.toMatch(/skipWaiting\(\)\s*;?\s*\n\s*\}\);\s*\n\s*self\.addEventListener\('activate'/);
    expect(src).toMatch(/if \(event\.data === 'activate'\) self\.skipWaiting\(\)/);
  });
  it('never touches the API, the game sockets, the admin page, health or the probe; hashed bundles only right under /assets/', () => {
    const NEVER = new RegExp(/const NEVER = \/(.+)\/;/.exec(src)![1]!.replace(/\\\\/g, '\\'));
    for (const p of ['/api/rooms', '/ws/ABCD', '/admin', '/admin.html', '/sw.js', '/health', '/echo', '/probe-api/results', '/probe-config.json', '/trial-status/', '/owner-abc/']) expect(NEVER.test(p), p).toBe(true);
    for (const p of ['/', '/r/ABCD', '/assets/index-Ab12Cd34.js', '/art/key-art/key-art-phone.avif', '/assets/weapons/k47.glb']) expect(NEVER.test(p), p).toBe(false);
    const HASHED = new RegExp(/const IS_HASHED = \/(.+)\/;/.exec(src)![1]!.replace(/\\\\/g, '\\'));
    expect(HASHED.test('/assets/index-Ab12Cd34.js')).toBe(true);
    expect(HASHED.test('/assets/art/soldier.glb')).toBe(false);
    // a public file whose name ends in a long word isn't a bundle (until 28 Oct it was taken for one)
    expect(HASHED.test('/assets/cosmetics/top/textures/jacket-basecolor.png')).toBe(false);
    // nor are the map posters (remade under the same names: scripts/map-posters.mjs)
    expect(HASHED.test('/assets/posters/storm-front-card@2x.webp')).toBe(false);
    expect(HASHED.test('/assets/posters/quick-match.webp')).toBe(false);
  });
});

/** The worker, run against fake caches and a fake network (on or off). */
function runWorker(version = '1', chunks: readonly string[] = []) {
  const listeners = new Map<string, (e: unknown) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const state = { online: true, files: new Map<string, string>(), fetched: [] as string[], modes: new Map<string, RequestCache>() };
  const net = async (r: Request | string): Promise<Response> => {
    const path = new URL(typeof r === 'string' ? r : r.url, 'https://mf.test').pathname;
    state.fetched.push(path);
    if (typeof r !== 'string') state.modes.set(path, r.cache);
    if (!state.online) throw new TypeError('Failed to fetch');
    const body = state.files.get(path);
    return body === undefined ? new Response('no', { status: 404 }) : new Response(body, { status: 200 });
  };
  const key = (r: Request | string) => (typeof r === 'string' ? new URL(r, 'https://mf.test').href : r.url);
  const cacheOf = (name: string) => {
    let map = stores.get(name);
    if (!map) stores.set(name, (map = new Map()));
    const m = map;
    return {
      match: async (r: Request | string) => m.get(key(r))?.clone(),
      put: async (r: Request | string, res: Response) => void m.set(key(r), res),
      delete: async (r: Request | string) => m.delete(key(r)),
      keys: async () => [...m.keys()].map((u) => new Request(u)),
      add: async (r: string) => void m.set(key(r), await net(r)),
    };
  };
  const caches = {
    open: async (name: string) => cacheOf(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (r: Request | string) => {
      for (const name of stores.keys()) {
        const hit = await cacheOf(name).match(r);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    location: new URL('https://mf.test/sw.js'),
    clients: { claim: async () => {} },
    skipWaiting: () => {},
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
  };
  new Function('self', 'caches', 'fetch', serviceWorkerSource(version, chunks))(self, caches, net);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    state,
    stores,
    async lifecycle() {
      for (const type of ['install', 'activate']) {
        let wait: Promise<unknown> = Promise.resolve();
        listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => (wait = p) });
        await wait;
      }
    },
    /** what the page gets for a GET ('none': the worker leaves it to the browser; 'error': a network error) */
    async get(path: string, mode: RequestMode = 'cors'): Promise<string> {
      let answer: Promise<Response> | null = null;
      const request = new Request(`https://mf.test${path}`);
      Object.defineProperty(request, 'mode', { value: mode });
      listeners.get('fetch')!({ request, respondWith: (p: Promise<Response>) => (answer = p) });
      if (!answer) return 'none';
      try {
        const res: Response = await answer;
        await settle();
        return res.type === 'error' ? 'error' : await res.text();
      } catch {
        return 'error';
      }
    },
    async message(data: unknown) {
      let wait: Promise<unknown> = Promise.resolve();
      listeners.get('message')!({ data, waitUntil: (p: Promise<unknown>) => (wait = p) });
      await wait;
      await settle();
    },
  };
}

describe('the service worker offline (audit 28 Oct: training drew no soldiers offline)', () => {
  it("asks the server for every model and texture, past a copy the browser still counts as fresh (29 Oct: models cached for 7 days named the old .png dye masks)", async () => {
    const w = runWorker();
    await w.lifecycle();
    w.state.files.set('/assets/characters/rookie/rookie_body.glb', 'glb');
    expect(await w.get('/assets/characters/rookie/rookie_body.glb')).toBe('glb');
    expect(w.state.modes.get('/assets/characters/rookie/rookie_body.glb')).toBe('no-cache');
  });

  it("keeps the game's models, textures and art it fetched, and serves them when the network is gone", async () => {
    const w = runWorker();
    w.state.files.set('/', 'page').set('/assets/weapons/k47.glb', 'gun').set('/assets/characters/rookie/textures/rookie_body_dye_mask.webp', 'mask').set('/art/key-art/key-art-phone.avif', 'art');
    await w.lifecycle();
    expect(await w.get('/assets/weapons/k47.glb')).toBe('gun');
    expect(await w.get('/assets/characters/rookie/textures/rookie_body_dye_mask.webp')).toBe('mask');
    expect(await w.get('/art/key-art/key-art-phone.avif')).toBe('art');
    w.state.online = false;
    expect(await w.get('/assets/weapons/k47.glb')).toBe('gun');
    expect(await w.get('/assets/characters/rookie/textures/rookie_body_dye_mask.webp')).toBe('mask');
    expect(await w.get('/r/ABCDEF', 'navigate')).toBe('page');
    // never fetched: a network error, as without the worker
    expect(await w.get('/assets/weapons/widow.glb')).toBe('error');
  });

  it('keeps the map posters with the game\'s art: asked for every time (a remade poster keeps its name), served offline (31 Oct)', async () => {
    const w = runWorker();
    w.state.files.set('/assets/posters/storm-front-card.webp', 'poster v1').set('/assets/posters/quick-match@2x.webp', 'key art');
    await w.lifecycle();
    expect(await w.get('/assets/posters/storm-front-card.webp')).toBe('poster v1');
    expect(w.state.modes.get('/assets/posters/storm-front-card.webp')).toBe('no-cache');
    expect(await w.get('/assets/posters/quick-match@2x.webp')).toBe('key art');
    w.state.files.set('/assets/posters/storm-front-card.webp', 'poster v2');
    expect(await w.get('/assets/posters/storm-front-card.webp')).toBe('poster v2');
    w.state.online = false;
    expect(await w.get('/assets/posters/storm-front-card.webp')).toBe('poster v2');
    expect(await w.get('/assets/posters/quick-match@2x.webp')).toBe('key art');
    expect([...w.stores.keys()].filter((k) => [...(w.stores.get(k)?.keys() ?? [])].some((u) => String(u).includes('/posters/')))).toEqual(['mf-assets']);
  });

  it('asks the network first while online, so a deploy never serves a stale model', async () => {
    const w = runWorker();
    w.state.files.set('/assets/weapons/k47.glb', 'gun v1');
    await w.lifecycle();
    await w.get('/assets/weapons/k47.glb');
    w.state.files.set('/assets/weapons/k47.glb', 'gun v2');
    expect(await w.get('/assets/weapons/k47.glb')).toBe('gun v2');
    w.state.online = false;
    expect(await w.get('/assets/weapons/k47.glb')).toBe('gun v2');
  });

  it('keeps the files the page loaded before it took control (a first visit), and leaves the API and the game server alone', async () => {
    const w = runWorker();
    w.state.files.set('/assets/main-Ab12Cd34.js', 'game').set('/assets/vfx/flash_atlas.webp', 'fx').set('/api/version', '{}').set('/health', 'ok');
    await w.lifecycle();
    await w.message({ type: 'keep', urls: ['https://mf.test/assets/main-Ab12Cd34.js', 'https://mf.test/assets/vfx/flash_atlas.webp', 'https://mf.test/api/version', 'https://mf.test/health', 'https://elsewhere.test/x.js'] });
    expect(w.state.fetched).not.toContain('/api/version');
    expect(w.state.fetched).not.toContain('/health');
    w.state.online = false;
    expect(await w.get('/assets/main-Ab12Cd34.js')).toBe('game');
    expect(await w.get('/assets/vfx/flash_atlas.webp')).toBe('fx');
    expect(await w.get('/api/version')).toBe('none');
    expect(await w.get('/health')).toBe('none');
  });

  it("names its caches per version, except the assets' (each fetch refreshes that one, so it can outlive a version); leaves the page's own", async () => {
    const w = runWorker('7');
    w.state.files.set('/assets/weapons/k47.glb', 'gun').set('/assets/main-Ab12Cd34.js', 'game');
    // the last version's, and the portraits' cache the page keeps (src/portrait/cache.ts)
    for (const name of ['mf-pages-6', 'mf-hashed-6', 'mf-portraits-v1']) w.stores.set(name, new Map());
    await w.lifecycle();
    expect([...w.stores.keys()].sort()).toEqual(['mf-pages-7', 'mf-portraits-v1']);
    await w.get('/assets/weapons/k47.glb');
    await w.get('/assets/main-Ab12Cd34.js');
    expect([...w.stores.keys()].sort()).toEqual(['mf-assets', 'mf-hashed-7', 'mf-pages-7', 'mf-portraits-v1']);
  });

  it('serves hashed bundles from the cache first, and keeps no error page', async () => {
    const w = runWorker();
    w.state.files.set('/assets/main-Ab12Cd34.js', 'game');
    await w.lifecycle();
    expect(await w.get('/assets/main-Ab12Cd34.js')).toBe('game');
    w.state.files.set('/assets/main-Ab12Cd34.js', 'changed under the same name');
    expect(await w.get('/assets/main-Ab12Cd34.js')).toBe('game');
    expect(await w.get('/assets/weapons/missing.glb')).toBe('no');
    expect(w.stores.get('mf-assets')?.has('https://mf.test/assets/weapons/missing.glb') ?? false).toBe(false);
  });
});

describe("the worker's list of the game's code", () => {
  it("is every chunk the game page can load, static and lazy, with their CSS; never another page's", () => {
    const css = (...f: string[]) => ({ importedCss: new Set(f) });
    const bundle = {
      'assets/main-A.js': { type: 'chunk' as const, fileName: 'assets/main-A.js', isEntry: true, facadeModuleId: '/w/apps/web/index.html', imports: ['assets/game-B.js'], dynamicImports: [], viteMetadata: css('assets/main-A.css') },
      'assets/game-B.js': { type: 'chunk' as const, fileName: 'assets/game-B.js', imports: [], dynamicImports: ['assets/locker-C.js', 'assets/game-B.js'] },
      'assets/locker-C.js': { type: 'chunk' as const, fileName: 'assets/locker-C.js', viteMetadata: css('assets/locker-C.css') },
      'assets/admin-D.js': { type: 'chunk' as const, fileName: 'assets/admin-D.js', isEntry: true, facadeModuleId: '/w/apps/web/admin.html' },
      'assets/k47.png': { type: 'asset' as const, fileName: 'assets/k47.png' },
    };
    expect(gameChunks(bundle)).toEqual(['/assets/game-B.js', '/assets/locker-C.css', '/assets/locker-C.js', '/assets/main-A.css', '/assets/main-A.js']);
    expect(serviceWorkerSource('1', gameChunks(bundle))).toContain('const CHUNKS = ["/assets/game-B.js",');
  });

  it('keeps those chunks once the page says the player is heading for play, and only then', async () => {
    const w = runWorker('1', ['/assets/render-Ab12Cd34.js', '/assets/locker-Ab12Cd34.css']);
    w.state.files.set('/assets/render-Ab12Cd34.js', 'portraits').set('/assets/locker-Ab12Cd34.css', 'css');
    await w.lifecycle();
    await w.message({ type: 'keep', urls: [] });
    expect(w.state.fetched).not.toContain('/assets/render-Ab12Cd34.js');
    await w.message({ type: 'keep', urls: [], all: true });
    w.state.online = false;
    expect(await w.get('/assets/render-Ab12Cd34.js')).toBe('portraits');
    expect(await w.get('/assets/locker-Ab12Cd34.css')).toBe('css');
  });
});
