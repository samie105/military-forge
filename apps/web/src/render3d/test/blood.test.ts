import { BUZZ, HitZone, WIDOW, movementTestMap } from '@military-forge/content';
import { CollisionWorld, type SimEvent } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Cell } from '../vfx/atlas';
import { BLOOD_SPLAT_DAMAGE, bloodHit } from '../vfx/blood';
import { F, ParticlePool, STRIDE } from '../vfx/pool';
import { Gunfire } from '../vfx/gunfire';
import { Ramp } from '../vfx/ramps';

const world = new CollisionWorld(movementTestMap);
const pools = () => ({ smoke: new ParticlePool(512), glow: new ParticlePool(512), decals: new ParticlePool(32) });
/** the live particles of `pool` with ramp `ramp` (or cell `cell`) */
const count = (pool: ParticlePool, field: 'ramp' | 'cell', value: number) => {
  let n = 0;
  for (let i = 0; i < pool.count; i++) if (pool.data[i * STRIDE + F[field]] === value) n++;
  return n;
};
let seed = 1;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

describe('bloodHit', () => {
  it('a spray along the shot, more for a harder hit and more for a headshot, and a mist', () => {
    const spray = (damage: number, head: boolean) => {
      const t = pools();
      bloodHit(t, world, 118, 1.2, 1, 0, damage, head, 1, rand);
      return t;
    };
    const light = spray(10, false);
    const heavy = spray(80, false);
    const head = spray(80, true);
    expect(count(light.smoke, 'ramp', Ramp.Blood)).toBeGreaterThan(2);
    expect(count(heavy.smoke, 'ramp', Ramp.Blood)).toBeGreaterThan(count(light.smoke, 'ramp', Ramp.Blood));
    expect(count(head.smoke, 'ramp', Ramp.Blood)).toBeGreaterThan(count(heavy.smoke, 'ramp', Ramp.Blood));
    expect(count(heavy.smoke, 'ramp', Ramp.BloodMist)).toBe(1);
    // out of the far side: the droplets fly on along the shot
    let vx = 0;
    for (let i = 0; i < heavy.smoke.count; i++) vx += heavy.smoke.data[i * STRIDE + F.vx]!;
    expect(vx).toBeGreaterThan(0);
  });

  it('a splat on the floor below a hit that hurts; none for a graze or far above the floor', () => {
    const at = (damage: number, y: number) => {
      const t = pools();
      bloodHit(t, world, 118, y, 1, 0, damage, false, 1, rand);
      return t.decals.count;
    };
    expect(at(BLOOD_SPLAT_DAMAGE - 1, 1.2)).toBe(0);
    expect(at(BLOOD_SPLAT_DAMAGE, 1.2)).toBeGreaterThanOrEqual(1);
    expect(at(80, 6)).toBe(0); // in the air, 6 m up
  });
});

describe('Gunfire: a player hit is a thud, or blood when it is on (off by default)', () => {
  const hitShot = (weapon: number, zone: number = HitZone.Torso): SimEvent => ({ type: 'shot', shooter: 0, weapon, ox: 112, oy: 1.2, ex: 118, ey: 1.2, hit: 2, target: 1, zone });
  const fire = (blood: boolean, e: SimEvent) => {
    const g = new Gunfire(world);
    expect(g.blood).toBe(false);
    g.blood = blood;
    const t = pools();
    g.onEvents([e]);
    g.update(1 / 60, t, () => false);
    return t;
  };

  it('off: the non-gory star thud, no blood', () => {
    const t = fire(false, hitShot(WIDOW.index));
    expect(count(t.glow, 'cell', Cell.Star)).toBeGreaterThan(0);
    expect(count(t.smoke, 'ramp', Ramp.Blood)).toBe(0);
    expect(t.decals.count).toBe(0);
  });

  it('on: droplets and a splat instead of the thud, scaled by the weapon (a Widow more than a Buzz)', () => {
    const widow = fire(true, hitShot(WIDOW.index));
    const buzz = fire(true, hitShot(BUZZ.index));
    expect(count(widow.glow, 'cell', Cell.Star)).toBe(count(fire(false, hitShot(WIDOW.index)).glow, 'cell', Cell.Star) - 1); // the thud's star is gone
    expect(count(widow.smoke, 'ramp', Ramp.Blood)).toBeGreaterThan(count(buzz.smoke, 'ramp', Ramp.Blood));
    expect(widow.decals.count).toBeGreaterThanOrEqual(1);
  });
});
