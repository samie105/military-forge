import { movementTestMap } from '@military-forge/content';
import { CollisionWorld, DT, DamageSource, MELEE_WINDUP_TICKS, type SimEvent } from '@military-forge/sim';
import { BoxGeometry, DataTexture, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import type { Frame } from '../../view';
import { ShieldKit, ShieldRig } from '../shield';
import { SLASH_FROM, SLASH_TO, SWING_S, SWING_WINDUP_S, SwingClock, swingPose, type SwingPose } from '../swing';
import { MeleeFx, type SwingSegment } from '../vfx/melee';
import { F, ParticlePool, STRIDE } from '../vfx/pool';
import { Ramp } from '../vfx/ramps';
import { shieldBreak } from '../vfx/shieldBlast';
import { playerView } from './helpers';

const world = new CollisionWorld(movementTestMap);
const pose = (): SwingPose => ({ weight: 0, angle: 0, reach: 0, striking: false });
const pools = () => ({ glow: new ParticlePool(512), smoke: new ParticlePool(512), decals: new ParticlePool(64) });

describe('the melee swing on the soldier (swing.ts)', () => {
  it('a blade draws back over the shoulder, strikes down through the arc on the landing tick, then eases back', () => {
    expect(swingPose(-1, true, pose()).weight).toBe(0);
    const windup = swingPose(SWING_WINDUP_S * 0.9, true, pose());
    expect(windup.angle).toBeGreaterThan(SLASH_FROM * 0.8);
    expect(windup.striking).toBe(false);
    const strike = swingPose(SWING_WINDUP_S + 0.02, true, pose());
    expect(strike.striking).toBe(true);
    expect(strike.weight).toBe(1);
    const end = swingPose(SWING_WINDUP_S + 0.12, true, pose());
    expect(end.angle).toBeCloseTo(SLASH_TO, 5);
    expect(end.weight).toBeLessThan(1);
    expect(swingPose(SWING_S, true, pose()).weight).toBe(0);
    // a gun's bash: a jab along the aim, never raised overhead
    expect(Math.abs(swingPose(SWING_WINDUP_S * 0.9, false, pose()).angle)).toBeLessThan(0.5);
  });

  it("follows the sim's meleeTicks frame by frame, runs on through the recovery, and a remote hit starts it at the strike", () => {
    const c = new SwingClock();
    expect(c.update(0, 1 / 60)).toBe(-1);
    expect(c.update(1, 1 / 60)).toBe(0);
    for (let k = 2; k <= MELEE_WINDUP_TICKS + 1; k++) c.update(k, DT);
    expect(c.t).toBeCloseTo(MELEE_WINDUP_TICKS * DT, 6);
    for (let i = 0; i < 60; i++) c.update(0, DT);
    expect(c.t).toBe(-1);
    c.struck();
    expect(c.t).toBeCloseTo(SWING_WINDUP_S, 6);
  });
});

describe('melee effects (vfx/melee.ts)', () => {
  const frame = (players = [playerView({ id: 0, x: 10 }), playerView({ id: 1, x: 11, isLocal: false })]): Frame => ({ tick: 1, localId: 0, players, grenades: [] });

  it("a strike's trail: streaks between where the weapon was last frame and where it is; none outside a strike", () => {
    let striking = true;
    let x = 0;
    const fx = new MeleeFx((id, out: SwingSegment) => {
      if (id !== 0 || !striking) return false;
      Object.assign(out, { hx: 10, hy: 1.2, tx: 10.4 + x, ty: 1.8 - x });
      return true;
    });
    const t = pools();
    fx.update(frame(), t, 1, false);
    expect(t.glow.count).toBe(0); // the first frame of a strike only marks where it starts
    x = 0.5;
    fx.update(frame(), t, 1, false);
    expect(t.glow.count).toBe(16);
    striking = false;
    const before = t.glow.count;
    fx.update(frame(), t, 1, false);
    expect(t.glow.count).toBe(before);
  });

  it('a melee hit flashes and sparks at the target; blood instead when it is on; other hits leave it to the gunfire', () => {
    const fx = new MeleeFx(() => false);
    const t = pools();
    fx.update(frame(), t, 1, false);
    const hit = (source: number): SimEvent => ({ type: 'hit', attacker: 0, target: 1, damage: 100, zone: 1, source });
    fx.onEvents([hit(2)], t, world, 1);
    expect(t.glow.count).toBe(0);
    fx.onEvents([hit(DamageSource.Melee)], t, world, 1);
    expect(t.glow.count).toBe(10);
    let star = false;
    for (let i = 0; i < t.glow.count; i++) if (t.glow.data[i * STRIDE + F.ramp] === Ramp.Flash) star = true;
    expect(star).toBe(true);
    fx.blood = true;
    const b = pools();
    fx.onEvents([hit(DamageSource.Melee)], b, world, 1);
    expect(b.glow.count).toBe(0);
    expect(b.smoke.count).toBeGreaterThan(0);
  });
});

describe('the riot shield (shield.ts, vfx/shieldBlast.ts)', () => {
  it('a break: a flash and a ring, steel shards falling, sparks', () => {
    const t = pools();
    let seed = 1;
    shieldBreak(10, 1, t.glow, t.smoke, 1, () => ((seed = (seed * 16807) % 2147483647) / 2147483647));
    expect(t.smoke.count).toBe(12); // shards
    expect(t.glow.count).toBe(16); // flash, ring, sparks
  });

  it("the Forge's model replaces the placeholder plate on every shield already drawn", () => {
    const kit = new ShieldKit(new DataTexture(new Uint8Array([128]), 1, 1));
    const rig = new ShieldRig(() => null, kit);
    const plate = kit.geometry;
    const model = new BoxGeometry(0.56, 0.9, 0.1);
    kit.setModel(model);
    expect(rig.mesh.geometry).toBe(model);
    expect(kit.geometry).toBe(model);
    expect(new Mesh(kit.geometry).geometry).not.toBe(plate);
  });
});
