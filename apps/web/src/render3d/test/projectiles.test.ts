import { DRAGON, FLAME, PULSE, RIPPER, movementTestMap } from '@military-forge/content';
import { CollisionWorld, type SimEvent } from '@military-forge/sim';
import { DataTexture, Matrix4, Quaternion, Scene, Vector3, type InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../camera';
import type { Frame, GrenadeView, PlayerView } from '../../view';
import { CloudLayer } from '../clouds';
import type { VfxContext } from '../vfx';
import { ParticleLayer } from '../vfx/particles';
import { F, ParticlePool, STRIDE } from '../vfx/pool';
import { DRAW_SCALE, ProjectileFx, T_BLADE, T_FLAME, T_ORB, T_ROCKET, T_SHELL } from '../vfx/projectiles';
import { Ramp } from '../vfx/ramps';
import { playerView } from './helpers';

const tex = new DataTexture(new Uint8Array(4), 1, 1);

function ctx(over: Partial<VfxContext> = {}): VfxContext {
  return {
    smoke: new ParticlePool(1024),
    glow: new ParticlePool(1024),
    decals: new ParticlePool(32),
    glowLayer: new ParticleLayer(64, { texture: tex, grid: [4, 4], blend: 'additive', depthTest: false, renderOrder: 12 }),
    world: new CollisionWorld(movementTestMap),
    scene: new Scene(),
    camera: new Camera(),
    detail: 1,
    reducedMotion: false,
    ...over,
  };
}

/** Every gun's sockets sit at (shooter x, 1.2). */
function setup(over: Partial<VfxContext> = {}) {
  const fx = ctx(over);
  const p = new ProjectileFx(fx.scene, tex, tex, (shooter, _w, _name, out) => (out.set(10 + shooter, 1.2, 0.1), true));
  return { fx, p };
}

const view = (type: number, id: number, x: number, y: number, vx: number, vy: number, over: Partial<GrenadeView> = {}): GrenadeView => ({ type, id, x, y, vx, vy, fuse: 30, ...over });
const frame = (grenades: GrenadeView[], players: PlayerView[] = []): Frame => ({ tick: 1, localId: 0, players, grenades });
const count = (pool: ParticlePool, field: 'ramp' | 'cell', v: number) => {
  let n = 0;
  for (let i = 0; i < pool.count; i++) if (pool.data[i * STRIDE + F[field]] === v) n++;
  return n;
};
const m = new Matrix4();
const pos = new Vector3();
const rot = new Quaternion();
const scl = new Vector3();
const matrixOf = (mesh: InstancedMesh, i = 0) => (mesh.getMatrixAt(i, m), m.decompose(pos, rot, scl), { pos: pos.clone(), rot: rot.clone(), scale: scl.x });

describe('the launchers’ projectiles in 3D', () => {
  it('a rocket: nose along its flight, drawn larger, with a smoke trail; a shell and a blade too; one draw per kind', () => {
    const { fx, p } = setup();
    let x = 10;
    for (let i = 0; i < 10; i++) {
      x += 20 / 60;
      p.update(frame([view(T_ROCKET, 1, x, 2, 20, 0), view(T_SHELL, 2, 12, 3, 5, 5), view(T_BLADE, 3, 14, 2, 18, 0)]), 1 / 60, fx);
    }
    expect([p.meshes.rocket.count, p.meshes.shell.count, p.meshes.blade.count]).toEqual([1, 1, 1]);
    const rocket = matrixOf(p.meshes.rocket);
    expect(rocket.pos.x).toBeCloseTo(x);
    expect(new Vector3(0, 1, 0).applyQuaternion(rocket.rot).x).toBeCloseTo(1, 3); // pointing along +x
    expect(rocket.scale).toBeCloseTo(DRAW_SCALE.rocket);
    expect(count(fx.smoke, 'ramp', Ramp.Trail)).toBeGreaterThan(4);
    // the blade faces the camera: its face (+X) along +Z
    expect(new Vector3(1, 0, 0).applyQuaternion(matrixOf(p.meshes.blade).rot).z).toBeCloseTo(1, 3);
    // gone from the frame: gone from the screen
    p.update(frame([]), 1 / 60, fx);
    expect([p.meshes.rocket.visible, p.meshes.shell.visible, p.meshes.blade.visible]).toEqual([false, false, false]);
    expect(p.count).toBe(0);
  });

  it('a blade throws sparks off each wall it bounces from, and its trail runs hot after the first', () => {
    const { fx, p } = setup();
    p.update(frame([view(T_BLADE, 3, 14, 2, 18, 0)]), 1 / 60, fx);
    const before = fx.glow.count;
    p.update(frame([view(T_BLADE, 3, 14.2, 2, -18, 0, { state: 1 })]), 1 / 60, fx); // back off a wall
    expect(fx.glow.count).toBeGreaterThan(before + 3);
    p.update(frame([view(T_BLADE, 3, 14.0, 2, -18, 0, { state: 1 })]), 1 / 60, fx);
    expect(fx.glow.count).toBe(count(fx.glow, 'ramp', Ramp.Spark)); // no new sparks flying straight on
  });

  it('a Pulse orb: the orb on show with its trail; its EMP burst flashes and rings', () => {
    const { fx, p } = setup();
    for (let i = 0; i < 6; i++) p.update(frame([view(T_ORB, 4, 12 + i * 0.13, 2, 8, 0)]), 1 / 60, fx);
    expect(p.cards.count).toBeGreaterThanOrEqual(2);
    const trail = p.cardPool.count;
    expect(trail).toBeGreaterThan(0);
    p.onEvents([{ type: 'explosion', x: 12.7, y: 2, radius: 2.5, owner: 0, grenade: 5 } as SimEvent]);
    expect(p.cardPool.count).toBe(trail + 2);
    // an EMP grenade far from any orb: clouds.ts's ring alone
    p.onEvents([{ type: 'explosion', x: 40, y: 2, radius: 2.5, owner: 0, grenade: 5 } as SimEvent]);
    expect(p.cardPool.count).toBe(trail + 2);
  });

  it('Dragon flames: three flipbook puffs each, older frames as the flame ages, a shimmer above (not under Reduce motion or on Low)', () => {
    const run = (over: Partial<VfxContext>) => {
      const { fx, p } = setup(over);
      p.setArt({ flame: tex, specials: tex });
      for (let i = 0; i < 12; i++) p.update(frame([view(T_FLAME, 5, 12, 2, 7, 0, { fuse: 40 })]), 1 / 60, fx);
      return { fx, p };
    };
    const { fx, p } = run({});
    expect(p.flames.count).toBe(3);
    const cells = Array.from((p.flames.mesh.geometry.getAttribute('iCell').array as Float32Array).subarray(0, 3));
    expect(cells[0]).toBe(Math.floor((16 * (FLAME.life - 40 / 60)) / FLAME.life)); // the flame's age into the flipbook
    expect(count(fx.smoke, 'ramp', Ramp.Haze)).toBeGreaterThan(0); // the shimmer
    expect(count(run({ reducedMotion: true }).fx.smoke, 'ramp', Ramp.Haze)).toBe(0);
    expect(count(run({ detail: 0.6 }).fx.smoke, 'ramp', Ramp.Haze)).toBe(0);
  });

  it('a burning player: flames at the chest and embers (fewer under Reduce motion)', () => {
    const embers = (reducedMotion: boolean) => {
      const { fx, p } = setup({ reducedMotion });
      for (let i = 0; i < 30; i++) p.update(frame([], [playerView({ id: 2, x: 20, burning: true })]), 1 / 60, fx);
      expect(p.flames.count).toBe(2);
      return count(fx.glow, 'ramp', Ramp.Fire);
    };
    const full = embers(false);
    expect(full).toBeGreaterThan(4);
    expect(embers(true)).toBeLessThan(full);
  });

  it('the tells: a Ripper charging sparks, a Pulse gathers a glow, a Dragon’s pilot light is always lit', () => {
    const holding = (def: number, windup: boolean) => playerView({ id: 1, x: 11, windup, weapons: [{ def, mag: 1, reserve: 9, reloadTicks: 0 }], active: 0 });
    const ripper = setup();
    for (let i = 0; i < 10; i++) ripper.p.update(frame([], [holding(RIPPER.index, true)]), 1 / 60, ripper.fx);
    expect(count(ripper.fx.glow, 'ramp', Ramp.Spark)).toBeGreaterThanOrEqual(3); // one every 50 ms
    const pulse = setup();
    pulse.p.update(frame([], [holding(PULSE.index, true)]), 1 / 60, pulse.fx);
    expect(pulse.p.cards.count).toBe(2); // the glow and the closing ring
    const idle = setup();
    idle.p.update(frame([], [holding(PULSE.index, false)]), 1 / 60, idle.fx);
    expect(idle.p.cards.count).toBe(0);
    const dragon = setup();
    dragon.p.update(frame([], [holding(DRAGON.index, false)]), 1 / 60, dragon.fx);
    expect(dragon.p.cards.count).toBe(1); // the pilot light
  });
});

describe('clouds.ts no longer draws the launchers’ placeholders', () => {
  it('a projectile view gets no ball', () => {
    const fx = ctx();
    const layer = new CloudLayer(fx.scene);
    layer.update(frame([view(T_ROCKET, 1, 10, 2, 20, 0)]), 1 / 60, fx);
    let balls = 0;
    layer.group.traverse((o) => {
      if (o.visible && o !== layer.group && (o as { isMesh?: boolean }).isMesh) balls++;
    });
    expect(balls).toBe(0);
  });
});
