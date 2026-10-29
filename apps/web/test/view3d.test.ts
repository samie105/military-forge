/**
 * The 3D view's stand-in (src/view3d): three.js and render3d come as a chunk of their own, after the
 * landing and the title (audit 28 Oct). Settings made before it arrives still apply, and the boot code
 * never imports three.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Renderer3D } from '../src/render3d';
import { View3dSlot } from '../src/view3d';

/** A view that writes down what it's told, in order. */
function fakeView(drawing = true) {
  const log: string[] = [];
  const view = {
    drawing,
    setPreset: (n: string) => log.push(`preset ${n}`),
    setAutoTier: (t: string | null) => log.push(`auto ${t}`),
    setBlood: (on: boolean) => log.push(`blood ${on}`),
    setShowKillEffects: (on: boolean) => log.push(`kills ${on}`),
    setReducedMotion: (on: boolean) => log.push(`reduced ${on}`),
    setShakeScale: (k: number) => log.push(`shake ${k}`),
    setDprCap: (c: number | null) => log.push(`dpr ${c}`),
    setTouchDevice: (on: boolean) => log.push(`touch ${on}`),
    load: (s: { x: number; y: number }) => {
      log.push(`load ${s.x},${s.y}`);
      return Promise.resolve();
    },
    render: () => log.push('render'),
    resize: () => log.push('resize'),
    setMap: () => log.push('map'),
  };
  return { view: view as unknown as Renderer3D, log };
}

describe('the 3D view stand-in', () => {
  it('keeps the settings made before the chunk is in (the latest of each, in the order made) and applies them on arrival', async () => {
    const { view, log } = fakeView();
    let asked = 0;
    const slot = new View3dSlot(() => {
      asked++;
      return Promise.resolve(view);
    });
    slot.setAutoTier('high');
    slot.setReducedMotion(false);
    slot.setShakeScale(1);
    slot.setReducedMotion(true); // Settings → Reduce motion before the 3D view exists
    slot.setShakeScale(0.4); // Camera shake
    slot.setAutoTier(null);
    slot.setPreset('low');
    slot.setAutoTier('medium'); // Auto again: after the preset, as it was made
    slot.setBlood(true);
    let spawnX = 1;
    slot.load(() => ({ x: spawnX, y: 2 }));
    spawnX = 7; // the map of the moment the view arrives
    slot.render({ tick: 0, localId: -1, players: [], grenades: [] }, 0.016); // nothing to draw yet
    slot.resize();
    expect(slot.drawing).toBe(true); // on its way: the 2D canvas stays an overlay (a blank world, as before its models)
    expect(asked).toBe(0); // nothing fetched until asked

    const order: string[] = [];
    slot.onReady(() => order.push('ready hook'));
    await Promise.all([slot.start(), slot.start()]);
    expect(asked).toBe(1);
    expect(order).toEqual(['ready hook']);
    expect(log).toEqual(['reduced true', 'shake 0.4', 'preset low', 'auto medium', 'blood true', 'load 7,2']);

    // here now: calls go straight through
    slot.setBlood(false);
    slot.resize();
    expect(log.slice(-2)).toEqual(['blood false', 'resize']);
    expect(slot.view).toBe(view);
  });

  it('a page drawing in 2D (no maker) ignores the calls and never draws in 3D', async () => {
    const slot = new View3dSlot(null);
    slot.setReducedMotion(true);
    expect(slot.wanted).toBe(false);
    expect(slot.drawing).toBe(false);
    expect(await slot.start()).toBeNull();
    expect(await slot.whenSettled()).toBeNull();
  });

  it('WebGL failing to start: the 2D view for good, waiters hear null', async () => {
    const slot = new View3dSlot(() => Promise.resolve(null));
    const settled = slot.whenSettled();
    await slot.start();
    expect(await settled).toBeNull();
    expect(slot.wanted).toBe(false);
    expect(slot.drawing).toBe(false);
  });

  it('a chunk that does not come (offline): the 2D view meanwhile, and the next start fetches it again', async () => {
    const { view, log } = fakeView();
    let tries = 0;
    const slot = new View3dSlot(() => (++tries === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(view)));
    slot.setReducedMotion(true);
    const first = slot.whenSettled();
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await slot.start()).toBeNull();
    } finally {
      console.warn = warn;
    }
    expect(await first).toBeNull(); // the portraits show silhouettes and ask again later
    expect(slot.drawing).toBe(false); // the 2D view while it's missing
    expect(slot.wanted).toBe(true);
    expect(await slot.start()).toBe(view);
    expect(tries).toBe(2);
    expect(log).toEqual(['reduced true']); // what was kept survived the failed fetch
    expect(slot.drawing).toBe(true);
  });

  it('the portraits wait for the view without fetching it', async () => {
    const { view } = fakeView();
    let asked = 0;
    const slot = new View3dSlot(() => {
      asked++;
      return Promise.resolve(view);
    });
    const waiting = slot.whenSettled();
    await Promise.resolve();
    expect(asked).toBe(0);
    void slot.start();
    expect(await waiting).toBe(view);
  });
});

/** The modules main.ts loads at boot, statically (type-only imports and dynamic import() don't count). */
function bootGraph(entry: string): { modules: Set<string>; packages: Map<string, string> } {
  const modules = new Set<string>([entry]);
  const packages = new Map<string, string>();
  const queue = [entry];
  const at = (from: string, spec: string) => {
    const base = resolve(dirname(from), spec);
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
  };
  while (queue.length) {
    const file = queue.shift()!;
    if (!/\.tsx?$/.test(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
      if (m[1]) continue;
      const names = m[2]?.trim() ?? '';
      if (/^\{\s*(type\s+[\w$]+(\s+as\s+[\w$]+)?\s*,?\s*)+\}$/.test(names)) continue;
      const spec = (m[3] ?? m[4])!;
      if (!spec.startsWith('.')) {
        if (!packages.has(spec)) packages.set(spec, file);
        continue;
      }
      const found = at(file, spec);
      if (found && !modules.has(found)) {
        modules.add(found);
        queue.push(found);
      }
    }
  }
  return { modules, packages };
}

describe('the boot code', () => {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
  const { modules, packages } = bootGraph(resolve(src, 'main.ts'));

  it('imports no three.js: the 3D view is a chunk of its own (view3d/start.ts)', () => {
    const three = [...packages].filter(([spec]) => spec === 'three' || spec.startsWith('three/')).map(([spec, file]) => `${spec} from ${relative(src, file)}`);
    expect(three).toEqual([]);
    expect([...modules].map((f) => relative(src, f))).not.toContain('view3d/start.ts');
    expect([...modules].map((f) => relative(src, f))).not.toContain('render3d/index.ts');
    expect([...modules].map((f) => relative(src, f))).not.toContain('character/index.ts');
  });
});
