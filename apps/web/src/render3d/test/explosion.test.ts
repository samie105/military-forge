import { readFileSync } from 'node:fs';
import { movementTestMap } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { DirectionalLight, HemisphereLight } from 'three';
import { describe, expect, it } from 'vitest';
import { spawnExplosion, type ExplosionTargets } from '../vfx/explosion';
import { FLASH_MIN_INTERVAL, SceneFlash } from '../vfx/flash';
import { parseExplosionManifest } from '../vfx/manifest';
import { F, ParticlePool, STRIDE } from '../vfx/pool';
import { Ramp } from '../vfx/ramps';
import { CameraShake, SHAKE_MAX, blastTrauma } from '../vfx/shake';

const world = new CollisionWorld(movementTestMap);

function targets(): ExplosionTargets {
  return { glow: new ParticlePool(1000), smoke: new ParticlePool(1000), decals: new ParticlePool(32), book: null, art: null };
}

/** The Forge's explosions.vfx.json as built by art/pipeline/build_explosions.py (ws/forge-explosions), trimmed. */
const FORGE = {
  version: 1,
  atlas: 'explosion_atlas.webp',
  atlasSize: [2048, 1024],
  cell: [256, 256],
  blend: 'normal',
  flipbooks: {
    frag: { cellM: 4.035, anchorUV: [0.5, 0.5], fps: 18, frames: 16, anchor: 'centre', firstCell: [0, 0] },
    rocket: { cellM: 5.785, anchorUV: [0.5, 0.9141], fps: 16, frames: 16, anchor: 'base', firstCell: [4, 0] },
  },
  styles: {
    frag: {
      flipbook: 'frag',
      scale: 1.0,
      radiusM: 4.0,
      shockwave: { fromM: 0.3, toM: 4.0, ms: 220, tint: '#fff6e0', opacity: 0.85 },
      light: { color: '#ffcf80', intensity: 8.0, rangeM: 8.8, ms: 160 },
      cameraShake: { amplitudeM: 0.35, freqHz: 14, decayMs: 420, fullWithinM: 4.0, zeroAtM: 14.0, verticalBias: 0.6 },
    },
    rocket: { flipbook: 'rocket', scale: 1.0, radiusM: 5.0 },
  },
};

const ramps = (pool: ParticlePool) => Array.from({ length: pool.count }, (_, i) => pool.data[i * STRIDE + F.ramp]!);

describe('explosion', () => {
  it('a blast on the floor: flash, fire, ring, sparks, debris, ground dust, smoke and scorch marks', () => {
    const t = targets();
    spawnExplosion(t, world, 151, 0.1, 4, 1); // a frag resting on the range's flat floor
    const glow = ramps(t.glow);
    for (const r of [Ramp.Flash, Ramp.Fire, Ramp.Ring, Ramp.Spark]) expect(glow).toContain(r);
    const smoke = ramps(t.smoke);
    for (const r of [Ramp.Chunk, Ramp.Dust, Ramp.Smoke]) expect(smoke).toContain(r);
    // the cap scorch, and soot on the front face (the floor is 6 m of solid ground)
    expect(t.decals.count).toBe(2);
    // the shockwave reaches the damage radius: final width 2.25 × 4 m
    const rings = Array.from({ length: t.glow.count }, (_, i) => i * STRIDE).filter((o) => t.glow.data[o + F.ramp] === Ramp.Ring);
    expect(Math.max(...rings.map((o) => t.glow.data[o + F.size1]!))).toBeCloseTo(2.6 * 4); // the ground ring is the wider one
  });

  it('next to a step: the scorch on top, but no soot hanging off the front face', () => {
    const t = targets();
    spawnExplosion(t, world, 20, 0.1, 4, 1); // 1 m from the foot of the 1 m ledge
    expect(t.decals.count).toBe(1);
  });

  it('a blast in the air: no ground dust and no scorch', () => {
    const t = targets();
    spawnExplosion(t, world, 20, 9, 4, 1);
    expect(ramps(t.smoke)).not.toContain(Ramp.Dust);
    expect(t.decals.count).toBe(0);
  });

  it('no soot on a thin one-way platform (only the scorch on its top)', () => {
    const t = targets();
    spawnExplosion(t, world, 127, 2.6, 4, 1); // on the 2.5 m one-way platform
    expect(t.decals.count).toBe(1);
  });

  it('is the same blast every time at the same spot, and the Low preset spawns fewer particles', () => {
    const a = targets();
    const b = targets();
    spawnExplosion(a, world, 20, 0.1, 4, 1);
    spawnExplosion(b, world, 20, 0.1, 4, 1);
    expect(a.glow.data).toEqual(b.glow.data);
    const low = targets();
    spawnExplosion(low, world, 20, 0.1, 4, 0.6);
    expect(low.glow.count + low.smoke.count).toBeLessThan(a.glow.count + a.smoke.count);
  });

  it('the Forge flipbook replaces the procedural fireball, its anchor on the blast point', () => {
    const t = targets();
    t.art = parseExplosionManifest(FORGE)!;
    t.book = { pool: new ParticlePool(4), art: t.art.book! };
    spawnExplosion(t, world, 151, 0.1, 4, 1);
    expect(t.book.pool.count).toBe(1);
    expect(ramps(t.glow)).not.toContain(Ramp.Fire);
    expect(t.book.pool.data[F.life]).toBeCloseTo(16 / 18);
    expect(t.book.pool.data[F.x]).toBeCloseTo(151);
    // on the floor it rises a fifth of its height, so most of it shows above the ground's front face
    expect(t.book.pool.data[F.y]).toBeCloseTo(0.1 + 0.2 * 4.035);
    // its shockwave timing: from 0.3 m to the 4 m radius in 220 ms
    const ring = ramps(t.glow).indexOf(Ramp.Ring);
    expect(t.glow.data[ring * STRIDE + F.life]).toBeCloseTo(0.22);
  });

  it('a base-anchored flipbook (the rocket) stands on the blast point', () => {
    const t = targets();
    t.art = parseExplosionManifest(FORGE, 'rocket')!;
    t.book = { pool: new ParticlePool(4), art: t.art.book! };
    spawnExplosion(t, world, 151, 0.1, 5, 1);
    const w = 5.785;
    expect(t.book.pool.data[F.y]).toBeCloseTo(0.1 + (0.9141 - 0.5) * w);
  });
});

describe('explosions.vfx.json (the Forge, ws/forge-explosions)', () => {
  it('reads a flipbook: a 4 × 4 block of cells from firstCell, row by row, in a 8 × 4 atlas', () => {
    const frag = parseExplosionManifest(FORGE)!.book!;
    expect(frag.grid).toEqual([8, 4]);
    expect(frag.frames).toEqual([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 24, 25, 26, 27]);
    expect(frag.blend).toBe('alpha');
    expect(frag.sizeM).toBeCloseTo(4.035);
    const rocket = parseExplosionManifest(FORGE, 'rocket')!.book!;
    expect(rocket.frames.slice(0, 5)).toEqual([4, 5, 6, 7, 12]);
    expect(rocket.anchorV).toBeCloseTo(0.9141);
  });

  it('reads the style: shockwave, light and the camera-shake suggestion', () => {
    const art = parseExplosionManifest(FORGE)!;
    expect(art.radiusM).toBe(4);
    expect(art.shockwave).toMatchObject({ fromM: 0.3, toM: 4, seconds: 0.22, opacity: 0.85 });
    expect(art.light!.seconds).toBeCloseTo(0.16);
    expect(art.shake).toEqual({ amplitudeM: 0.35, fullWithinM: 4, zeroAtM: 14 });
  });

  it('keeps the procedural effect for anything missing or malformed', () => {
    expect(parseExplosionManifest(null)).toBeNull();
    expect(parseExplosionManifest({ styles: {} })).toBeNull();
    // a block running off the atlas, a bad fps, an atlas path out of the folder: no flipbook
    const bad = (book: object, root: object = {}) => parseExplosionManifest({ ...FORGE, ...root, flipbooks: { frag: { ...FORGE.flipbooks.frag, ...book } } })?.book ?? null;
    expect(bad({ firstCell: [6, 0] })).toBeNull();
    expect(bad({ fps: 0 })).toBeNull();
    expect(bad({}, { atlas: '../../secret.png' })).toBeNull();
    expect(bad({}, { cell: [0, 256] })).toBeNull();
    // the style's other parts still apply without a flipbook
    expect(parseExplosionManifest({ ...FORGE, atlas: 'a/b.webp' })!.shockwave).not.toBeNull();
  });
});

describe('camera shake', () => {
  it('adds trauma by distance: strongest inside the blast, none far away', () => {
    expect(blastTrauma(2, 4)).toBeCloseTo(0.85);
    expect(blastTrauma(20, 4)).toBeLessThan(blastTrauma(10, 4));
    expect(blastTrauma(40, 4)).toBe(0);
    // the Forge's suggestion: full within 4 m, nothing from 14 m
    expect(blastTrauma(4, 4, 14)).toBeCloseTo(0.85);
    expect(blastTrauma(14, 4, 14)).toBe(0);
  });

  it('never moves the camera more than SHAKE_MAX, and settles', () => {
    const s = new CameraShake();
    s.add(5);
    let max = 0;
    for (let i = 0; i < 120; i++) {
      const o = s.update(1 / 60);
      max = Math.max(max, Math.hypot(o.x, o.y));
    }
    expect(max).toBeGreaterThan(0.05);
    expect(max).toBeLessThanOrEqual(SHAKE_MAX + 1e-9);
    expect(s.trauma).toBe(0);
  });

  it('reduced motion: no shake at all', () => {
    const s = new CameraShake();
    s.enabled = false;
    s.add(1);
    const o = s.update(1 / 60);
    expect([o.x, o.y]).toEqual([0, 0]);
  });
});

describe('blast light', () => {
  it('flashes at most 3 times a second however many blasts there are (photosensitivity)', () => {
    const f = new SceneFlash(new HemisphereLight(0xffffff, 0x000000, 1.6), new DirectionalLight(0xffffff, 2));
    let flashes = 0;
    for (let frame = 0; frame < 60; frame++) {
      if (f.trigger(0, 0, 1)) flashes++; // a blast every frame for a second
      f.update(1 / 60);
    }
    expect(flashes).toBeLessThanOrEqual(Math.ceil(1 / FLASH_MIN_INTERVAL));
    expect(flashes).toBeGreaterThanOrEqual(2);
  });

  it('lights the scene up and fades back to the map’s own light', () => {
    const hemi = new HemisphereLight(0xffffff, 0x000000, 1.6);
    const sun = new DirectionalLight(0xffffff, 2);
    const f = new SceneFlash(hemi, sun);
    f.trigger(0, 0, 1);
    f.update(1 / 60);
    expect(hemi.intensity).toBeGreaterThan(2.5);
    expect(sun.intensity).toBeGreaterThan(3);
    for (let i = 0; i < 120; i++) f.update(1 / 60);
    expect(hemi.intensity).toBeCloseTo(1.6, 3);
    expect(sun.intensity).toBeCloseTo(2, 3);
  });

  it('reduced motion keeps a third of the flash', () => {
    const hemi = new HemisphereLight(0xffffff, 0x000000, 1);
    const f = new SceneFlash(hemi, new DirectionalLight(0xffffff, 1));
    f.reduced = true;
    f.trigger(0, 0, 1);
    expect(f.level).toBeCloseTo(0.33);
  });
});

describe('review follow-ups', () => {
  it('L2: a blast past the flipbook pool’s 16 still gets a fireball (the procedural one)', () => {
    const t = targets();
    t.art = parseExplosionManifest(FORGE)!;
    t.book = { pool: new ParticlePool(16), art: t.art.book! };
    for (let i = 0; i < 16; i++) spawnExplosion(t, world, 140 + i, 0.1, 4, 1);
    expect(ramps(t.glow)).not.toContain(Ramp.Fire);
    spawnExplosion(t, world, 160, 0.1, 4, 1);
    expect(ramps(t.glow)).toContain(Ramp.Fire);
  });

  it('L6: a blast under a ceiling with no floor near scorches the ceiling', () => {
    const t = targets();
    spawnExplosion(t, world, 114, 3.9, 4, 1); // under the overhang (its underside at y 4), 3.9 m over the floor
    expect(t.decals.count).toBeGreaterThanOrEqual(1);
    expect(t.decals.data[F.ny]).toBeCloseTo(-1); // lying on the underside
    expect(ramps(t.smoke)).not.toContain(Ramp.Dust); // no floor dust up there
  });

  it('L4: the shipped explosions.vfx.json parses, frame by frame, with the block layout from the manifest when given', () => {
    const shipped = JSON.parse(readFileSync(new URL('../../../public/assets/vfx/explosions.vfx.json', import.meta.url), 'utf8'));
    const art = parseExplosionManifest(shipped)!;
    expect(art.book!.frames).toEqual([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 24, 25, 26, 27]);
    expect(art.book!.fps).toBeGreaterThan(0);
    expect(art.shockwave!.toM).toBeCloseTo(art.radiusM);
    const wide = parseExplosionManifest({ ...shipped, flipbooks: { ...shipped.flipbooks, frag: { ...shipped.flipbooks.frag, frames: 8, cols: 8 } } })!;
    expect(wide.book!.frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // one row of 8
  });
});
