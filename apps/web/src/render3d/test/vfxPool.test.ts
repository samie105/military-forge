import { DataTexture } from 'three';
import { describe, expect, it } from 'vitest';
import { ParticleLayer } from '../vfx/particles';
import { F, ParticlePool, STRIDE, particleSpec } from '../vfx/pool';
import { RAMPS, Ramp, rampIndex } from '../vfx/ramps';

function spawn(pool: ParticlePool, over: Partial<ReturnType<typeof particleSpec>>): boolean {
  return pool.emit(Object.assign(particleSpec(), over));
}

const field = (pool: ParticlePool, i: number, f: number) => pool.data[i * STRIDE + f]!;

describe('ParticlePool', () => {
  it('spawns up to its budget, then refuses and counts the drops', () => {
    const pool = new ParticlePool(8);
    pool.limit = 3;
    for (let i = 0; i < 3; i++) expect(spawn(pool, { x: i })).toBe(true);
    expect(spawn(pool, { x: 9 })).toBe(false);
    expect(pool.count).toBe(3);
    expect(pool.dropped).toBe(1);
  });

  it('expires particles at the end of their life and keeps the survivors intact (swap-remove)', () => {
    const pool = new ParticlePool(8);
    spawn(pool, { x: 1, life: 1 });
    spawn(pool, { x: 2, life: 3 });
    spawn(pool, { x: 3, life: 2 });
    spawn(pool, { x: 4, life: 3 });
    pool.update(1.5); // the first expires: the last moves into its slot
    expect(pool.count).toBe(3);
    expect([0, 1, 2].map((i) => field(pool, i, F.x)).sort()).toEqual([2, 3, 4]);
    pool.update(1); // life 2 expires at 2.5 s
    expect([0, 1].map((i) => field(pool, i, F.x)).sort()).toEqual([2, 4]);
    pool.update(1);
    expect(pool.count).toBe(0);
  });

  it('recycles its slots: a long run never grows the storage', () => {
    const pool = new ParticlePool(16);
    const storage = pool.data;
    for (let frame = 0; frame < 600; frame++) {
      spawn(pool, { life: 0.15 });
      spawn(pool, { life: 0.05 });
      pool.update(1 / 60);
    }
    expect(pool.data).toBe(storage);
    // about 9 + 3 alive at any time: expiry frees slots as fast as spawns take them
    expect(pool.count).toBeLessThanOrEqual(14);
    expect(pool.dropped).toBe(0);
  });

  it('decals recycle the mark nearest its end of life when full', () => {
    const pool = new ParticlePool(2);
    pool.emitRecycling(Object.assign(particleSpec(), { x: 1, life: 10 }));
    pool.emitRecycling(Object.assign(particleSpec(), { x: 2, life: 10 }));
    pool.update(4);
    pool.emitRecycling(Object.assign(particleSpec(), { x: 3, life: 10, age: 0 }));
    // both were 40% through; the first found is replaced, and the pool stays full
    expect(pool.count).toBe(2);
    expect([0, 1].map((i) => field(pool, i, F.x)).sort()).toEqual([2, 3]);
  });

  it('integrates velocity, gravity, drag and spin', () => {
    const pool = new ParticlePool(1);
    spawn(pool, { vx: 2, vy: 0, grav: 10, drag: 0, spin: 1, life: 5 });
    for (let i = 0; i < 60; i++) pool.update(1 / 60);
    expect(field(pool, 0, F.x)).toBeCloseTo(2, 5);
    expect(field(pool, 0, F.vy)).toBeCloseTo(-10, 4);
    expect(field(pool, 0, F.y)).toBeLessThan(-4.5);
    expect(field(pool, 0, F.rot)).toBeCloseTo(1, 4);
    const damped = new ParticlePool(1);
    spawn(damped, { vx: 10, drag: 2, life: 5 });
    damped.update(0.5);
    expect(field(damped, 0, F.vx)).toBeCloseTo(10 * Math.exp(-1), 4);
  });
});

describe('ParticleLayer', () => {
  const texture = new DataTexture(new Uint8Array(4), 1, 1);
  const layer = () => new ParticleLayer(16, { texture, grid: [4, 4], blend: 'alpha', depthTest: true, renderOrder: 0 });
  const attr = (l: ParticleLayer, name: string) => l.mesh.geometry.getAttribute(name).array as Float32Array;

  it('writes one quad per visible particle and draws only those', () => {
    const pool = new ParticlePool(8);
    spawn(pool, { x: 1, size0: 2, size1: 2, ramp: Ramp.Book });
    spawn(pool, { x: 2, size0: 2, size1: 2, ramp: Ramp.Book, alpha: 0 }); // invisible: skipped
    const l = layer();
    l.begin();
    l.addPool(pool);
    l.end();
    expect(l.count).toBe(1);
    expect(l.mesh.geometry.instanceCount).toBe(1);
    expect(l.mesh.visible).toBe(true);
    expect(attr(l, 'iPos')[0]).toBe(1);
    expect(attr(l, 'iAxisA')[0]).toBeCloseTo(1); // half of the 2 m width
    l.begin();
    l.end();
    expect(l.mesh.visible).toBe(false); // an empty layer costs no draw call
  });

  it('draws `front` particles last, and orients surface quads through the depth band', () => {
    const pool = new ParticlePool(8);
    spawn(pool, { x: 7, front: 1, ramp: Ramp.Book });
    spawn(pool, { x: 8, ramp: Ramp.Book, orient: 1, nx: 0, ny: 1, size0: 2, size1: 2, aspect: 0.5 });
    const l = layer();
    l.begin();
    l.addPool(pool);
    l.end();
    const pos = attr(l, 'iPos');
    expect([pos[0], pos[3]]).toEqual([8, 7]);
    const a = attr(l, 'iAxisA');
    const b = attr(l, 'iAxisB');
    // along the ground's tangent, and through the band's depth
    [1, 0, 0].forEach((v, i) => expect(a[i]).toBeCloseTo(v));
    [0, 0, 0.5].forEach((v, i) => expect(b[i]).toBeCloseTo(v));
  });

  it('stretches streaks along their velocity', () => {
    const pool = new ParticlePool(2);
    spawn(pool, { vx: 0, vy: 10, stretch: 0.1, size0: 0.2, size1: 0.2, aspect: 0.5, ramp: Ramp.Book });
    const l = layer();
    l.begin();
    l.addPool(pool);
    l.end();
    const a = attr(l, 'iAxisA');
    expect(a[0]).toBeCloseTo(0);
    expect(a[1]).toBeCloseTo(0.1 + 0.5 * 10 * 0.1); // half length + half the speed × stretch
  });

  it('ramps fade the fire to nothing and keep scorch marks opaque until late', () => {
    expect(RAMPS[rampIndex(Ramp.Fire, 0) + 3]).toBe(1);
    expect(RAMPS[rampIndex(Ramp.Fire, 1) + 3]).toBe(0);
    expect(RAMPS[rampIndex(Ramp.Scorch, 0.7) + 3]).toBeCloseTo(0.85);
  });
});
