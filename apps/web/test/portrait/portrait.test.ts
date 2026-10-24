/** Portraits (research §7): keys, the cache, the queue and its policy, fallbacks. The WebGL render itself is shot in headless Chrome (scripts/portrait-renders.mjs). */
import { DEFAULT_COSMETIC_LOADOUT, cosmeticLoadoutWireIds, type CosmeticLoadout } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { PortraitMemory } from '../../src/portrait/cache';
import { initialOf, silhouetteUrl } from '../../src/portrait/fallback';
import { PortraitService, type PortraitBackend, type PortraitPolicy } from '../../src/portrait';
import { POSTER_POSES, defaultPosterPose, portraitDims, portraitKey, textHash } from '../../src/portrait/key';

const look = (items: Partial<CosmeticLoadout['items']>, dyes: Partial<CosmeticLoadout['dyes']> = {}): CosmeticLoadout => ({
  items: { ...DEFAULT_COSMETIC_LOADOUT.items, ...items },
  dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes, ...dyes },
});
const RED = look({}, { primary: 'dye_red' });
const BLUE = look({}, { primary: 'dye_navy' });

describe('portrait keys', () => {
  it('a dye, skin or part change is a new key; wire ids and the look give the same one', () => {
    const k = (l: CosmeticLoadout, size = 64 as const) => portraitKey({ look: l, size }, 'art1');
    expect(k(RED)).not.toBe(k(BLUE));
    expect(k(RED)).not.toBe(k(look({ skinTone: 'skin_09' }, { primary: 'dye_red' })));
    expect(k(RED)).not.toBe(k(look({ headgear: 'headgear_beret' }, { primary: 'dye_red' })));
    expect(portraitKey({ look: cosmeticLoadoutWireIds(RED), size: 64 }, 'art1')).toBe(k(RED));
    expect(k(RED)).toMatch(/^p1:\d+:art1:\d+:portrait:64$/);
    expect(portraitKey({ look: RED, size: 64 }, 'art2')).not.toBe(k(RED)); // new art, new pictures
  });

  it('sizes: square head-and-shoulders, 2:3 full-body posters', () => {
    expect(portraitDims(128)).toEqual({ width: 128, height: 128 });
    expect(portraitDims(512, 'poster-3')).toEqual({ width: 512, height: 768 });
  });

  it('a look strikes the same poster pose every time, and a lineup varies', () => {
    expect(defaultPosterPose(RED)).toBe(defaultPosterPose(RED));
    const poses = new Set(['dye_red', 'dye_navy', 'dye_lime', 'dye_white', 'dye_charcoal', 'dye_forest', 'dye_sky', 'dye_brown'].map((d) => defaultPosterPose(look({}, { primary: d }))));
    expect(poses.size).toBeGreaterThan(2);
    for (const p of poses) expect(POSTER_POSES).toContain(p);
    expect(textHash('a')).not.toBe(textHash('b'));
  });
});

describe('the memory cache', () => {
  it('keeps the 96 most recently used and revokes what it drops', () => {
    const revoked: string[] = [];
    const mem = new PortraitMemory(3, (u) => revoked.push(u));
    for (const k of ['a', 'b', 'c']) mem.set(k, { url: `blob:${k}`, width: 1, height: 1 });
    mem.get('a'); // a is recent now
    mem.set('d', { url: 'blob:d', width: 1, height: 1 });
    expect(revoked).toEqual(['blob:b']);
    expect(mem.has('a') && mem.has('c') && mem.has('d')).toBe(true);
    mem.clear();
    expect(revoked).toHaveLength(4);
  });
});

/** A service on a manual frame clock, with a fake renderer and disk. */
function rig(opts: { fail?: boolean; disk?: Map<string, Blob> } = {}) {
  const frames: (() => void)[] = [];
  const renders: string[] = [];
  const backend: PortraitBackend = {
    render: async (l, pose, w, h) => {
      renders.push(`${l.dyes.primary}:${pose}:${w}x${h}`);
      if (opts.fail) throw new Error('no WebGL');
      return { blob: new Blob(['x'], { type: 'image/webp' }), width: w, height: h };
    },
  };
  const disk = opts.disk ?? new Map<string, Blob>();
  let urls = 0;
  let now = 1000;
  const svc = new PortraitService(
    { get: async (k) => disk.get(k) ?? null, put: async (k, b) => void disk.set(k, b), prune: async () => {} },
    new PortraitMemory(96, () => {}),
    (fn) => frames.push(fn),
    () => `blob:${++urls}`,
    () => now,
  );
  let policy: PortraitPolicy = 'menus';
  svc.policy = () => policy;
  svc.install(backend, 'art1');
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 0));
      const due = frames.splice(0);
      for (const f of due) f();
    }
  };
  return { svc, renders, disk, settle, setPolicy: (p: PortraitPolicy) => (policy = p), advance: (ms: number) => (now += ms) };
}

describe('the portrait service', () => {
  it('renders a look once; the same request from two places shares it; then it is a cached hit (0 renders)', async () => {
    const { svc, renders, settle } = rig();
    expect(svc.peek({ look: RED, size: 64 })).toBeNull();
    const [a, b] = [svc.get({ look: RED, size: 64 }, 'now'), svc.get({ look: cosmeticLoadoutWireIds(RED), size: 64 })];
    await settle();
    const [ia, ib] = await Promise.all([a, b]);
    expect(ia).toEqual(ib);
    expect(ia.fallback).toBeUndefined();
    expect(renders).toEqual(['dye_red:portrait:64x64']);
    expect(svc.peek({ look: RED, size: 64 })?.url).toBe(ia.url);
    await svc.get({ look: RED, size: 64 });
    expect(renders).toHaveLength(1);
  });

  it('a different dye renders again (the key changes)', async () => {
    const { svc, renders, settle } = rig();
    void svc.get({ look: RED, size: 64 });
    void svc.get({ look: BLUE, size: 64 });
    await settle();
    expect(renders).toEqual(['dye_red:portrait:64x64', 'dye_navy:portrait:64x64']);
  });

  it('mid-fight nothing renders (jobs wait); dead, in a lobby or in menus they go, one at a time', async () => {
    const { svc, renders, settle, setPolicy } = rig();
    setPolicy('busy');
    const done = svc.get({ look: RED, size: 512, pose: 'poster-2' });
    await settle();
    expect(renders).toEqual([]);
    setPolicy('idle');
    await settle();
    expect((await done).width).toBe(512);
    expect(renders).toEqual(['dye_red:poster-2:512x768']);
  });

  it('"now" jumps the queue (a list on screen before the lobby warm-up)', async () => {
    const { svc, renders, settle, setPolicy } = rig();
    setPolicy('busy');
    svc.warm([{ look: RED, size: 64 }, { look: BLUE, size: 64 }]);
    await settle();
    void svc.get({ look: BLUE, size: 64 }, 'now');
    setPolicy('menus');
    await settle();
    expect(renders[0]).toBe('dye_navy:portrait:64x64');
  });

  it('after a reload the picture comes from the disk cache, no render', async () => {
    const disk = new Map<string, Blob>();
    const first = rig({ disk });
    void first.svc.get({ look: RED, size: 128 });
    await first.settle();
    const second = rig({ disk });
    const img = second.svc.get({ look: RED, size: 128 });
    await second.settle();
    expect((await img).fallback).toBeUndefined();
    expect(second.renders).toEqual([]);
  });

  it('a failed render shows the silhouette and is tried again after 30 s, not every frame', async () => {
    const { svc, renders, settle, advance } = rig({ fail: true });
    const img = svc.get({ look: RED, size: 64 });
    await settle();
    expect((await img).fallback).toBe(true);
    await svc.get({ look: RED, size: 64 });
    await settle();
    expect(renders).toHaveLength(1);
    advance(31_000);
    void svc.get({ look: RED, size: 64 });
    await settle();
    expect(renders).toHaveLength(2);
  });

  it('with no 3D on the page: silhouettes, at once', async () => {
    const svc = new PortraitService({ get: async () => null, put: async () => {}, prune: async () => {} });
    const img = await svc.get({ look: RED, size: 512, pose: 'poster-1' });
    expect(img.fallback).toBe(true);
    expect(img.height).toBe(768);
    expect(svc.peek({ look: RED, size: 64 })).toBeNull();
  });

  it('a view that asked before the renderer was installed hears when it is (Home, while the game still loads)', async () => {
    const svc = new PortraitService({ get: async () => null, put: async () => {}, prune: async () => {} });
    let heard = 0;
    const waiting = svc.whenInstalled().then(() => heard++);
    await new Promise((r) => setTimeout(r, 0));
    expect(heard).toBe(0);
    svc.install({ render: async (_l, _p, w, h) => ({ blob: new Blob(['x']), width: w, height: h }) }, 'art1');
    await waiting;
    expect(heard).toBe(1);
    await svc.whenInstalled(); // at once now
  });
});

describe("the player's own look (Home's soldier)", () => {
  it("starts from this device's saved look, else the default, and hears every new one", async () => {
    const { myLook, onMyLook, setMyLook } = await import('../../src/looks/mine');
    expect(myLook().items.bodyType).toBe(DEFAULT_COSMETIC_LOADOUT.items.bodyType);
    let heard = 0;
    const off = onMyLook(() => heard++);
    setMyLook(RED);
    expect(myLook()).toBe(RED);
    setMyLook(RED);
    expect(heard).toBe(1);
    off();
  });
});

describe('the silhouette', () => {
  it('carries the initial (never a bot tag), escaped; tall for posters', () => {
    expect(initialOf('[BOT] Kolo')).toBe('K');
    expect(initialOf('  ')).toBe('?');
    expect(initialOf('émeka')).toBe('É');
    const svg = decodeURIComponent(silhouetteUrl('<script>', 'volt'));
    expect(svg).toContain('&#60;');
    expect(svg).not.toContain('<script>');
    expect(decodeURIComponent(silhouetteUrl('Ade', 'none', true))).toContain('viewBox="0 0 100 150"');
  });
});
