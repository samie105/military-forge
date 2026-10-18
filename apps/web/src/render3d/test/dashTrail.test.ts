import { movementTestMap } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { DoubleSide, Scene, type MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import type { Frame } from '../../view';
import { Camera } from '../../camera';
import { DashTrail, MAX_TRAILS, TRAIL_GREEN, TRAIL_SECONDS } from '../vfx/dashTrail';
import { ParticlePool } from '../vfx/pool';
import { ParticleLayer } from '../vfx/particles';
import type { VfxContext } from '../vfx';
import { DataTexture } from 'three';
import { playerView } from './helpers';

function ctx(over: Partial<VfxContext> = {}): VfxContext {
  const scene = new Scene();
  return {
    smoke: new ParticlePool(256),
    glow: new ParticlePool(256),
    decals: new ParticlePool(32),
    glowLayer: new ParticleLayer(64, { texture: new DataTexture(new Uint8Array(4), 1, 1), grid: [4, 4], blend: 'additive', depthTest: false, renderOrder: 12 }),
    world: new CollisionWorld(movementTestMap),
    scene,
    camera: new Camera(),
    detail: 1,
    reducedMotion: false,
    ...over,
  };
}

/** A soldier at x dashing right at 14 m/s (frame by frame), or standing. */
const dasher = (id: number, x: number, dashing = true) => playerView({ id, x, y: 2, vx: dashing ? 14 : 0, dashing, isLocal: id === 0 });

describe('the dash trail (green ribbon + sparkles)', () => {
  it('a ribbon behind a dashing body, one mesh for every dasher, fading after the dash', () => {
    const fx = ctx();
    const trail = new DashTrail(fx.scene);
    let x = 10;
    for (let i = 0; i < 10; i++) {
      x += 14 / 60;
      const frame: Frame = { tick: i, localId: 0, players: [dasher(0, x), dasher(3, 30 - x)], grenades: [] };
      trail.update(frame, 1 / 60, fx);
    }
    expect(trail.count).toBe(2);
    expect(trail.mesh.visible).toBe(true);
    expect(fx.scene.children.filter((o) => o.visible).length).toBe(1); // one draw for both
    expect((trail.mesh.material as MeshBasicMaterial).side).toBe(DoubleSide); // the strip's winding flips with the direction
    // the ribbon spans the last TRAIL_SECONDS of path behind the body, greenest at the head
    const pos = trail.mesh.geometry.getAttribute('position');
    const col = trail.mesh.geometry.getAttribute('color');
    let minX = Infinity;
    let maxX = -Infinity;
    for (let v = 0; v < 2 * 10; v++) {
      minX = Math.min(minX, pos.getX(v));
      maxX = Math.max(maxX, pos.getX(v));
    }
    expect(maxX).toBeCloseTo(x, 1);
    expect(maxX - minX).toBeGreaterThan(14 * 0.1);
    expect(maxX - minX).toBeLessThan(14 * TRAIL_SECONDS + 0.1);
    expect(col.getY(19)).toBeGreaterThan(col.getX(19)); // green over red at the head
    expect(col.getY(19)).toBeGreaterThan(col.getZ(19)); // and over blue
    // the dash ends: the ribbon drains away within TRAIL_SECONDS
    for (let i = 0; i < 20; i++) trail.update({ tick: 20 + i, localId: 0, players: [dasher(0, x, false)], grenades: [] }, 1 / 60, fx);
    expect(trail.count).toBe(0);
    expect(trail.mesh.visible).toBe(false);
  });

  it('sparkles along the way, fewer under Reduce motion, steady under Reduce flashes', () => {
    const run = (over: Partial<VfxContext>, steady = false) => {
      const fx = ctx(over);
      const trail = new DashTrail(fx.scene);
      trail.steady = steady;
      let x = 10;
      for (let i = 0; i < 10; i++) {
        x += 14 / 60;
        trail.update({ tick: i, localId: 0, players: [dasher(0, x)], grenades: [] }, 1 / 60, fx);
      }
      return fx.glow;
    };
    const full = run({});
    const calm = run({ reducedMotion: true });
    const low = run({ detail: 0.6 });
    expect(full.count).toBeGreaterThan(10);
    expect(calm.count).toBeLessThan(full.count * 0.7);
    expect(low.count).toBeLessThan(full.count);
    expect(TRAIL_GREEN[1]).toBeGreaterThan(TRAIL_GREEN[0] * 2); // green, far from orange…
    expect(TRAIL_GREEN[1]).toBeGreaterThan(TRAIL_GREEN[2] * 2); // …and from blue
  });

  it(`at most ${MAX_TRAILS} ribbons; remote dashers too (it reads the frame, not the input)`, () => {
    const fx = ctx();
    const trail = new DashTrail(fx.scene);
    const players = Array.from({ length: MAX_TRAILS + 3 }, (_, i) => dasher(i, 5 + i * 3));
    for (let i = 0; i < 4; i++) {
      for (const p of players) p.x += 0.2;
      trail.update({ tick: i, localId: 0, players, grenades: [] }, 1 / 60, fx);
    }
    expect(trail.count).toBe(MAX_TRAILS);
  });
});
