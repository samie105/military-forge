import { movementTestMap } from '@military-forge/content';
import { CollisionWorld, DASH_DX, DASH_DY, type SimEvent } from '@military-forge/sim';
import { Bone, BufferGeometry, Color, Float32BufferAttribute, Group, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Frame } from '../../view';
import { Cell } from '../vfx/atlas';
import { DASH_TINT, DashFx, LINES_PER_S } from '../vfx/dash';
import { DashGhosts, GHOST_LIFE, type GhostSource } from '../vfx/dashGhosts';
import type { VfxContext } from '../vfx';
import { ParticleLayer } from '../vfx/particles';
import { F, ParticlePool, STRIDE } from '../vfx/pool';
import { Ramp } from '../vfx/ramps';
import { playerView } from './helpers';

/** A two-bone skinned strip: a stand-in character for the afterimages. */
function body(): GhostSource & { bones: Bone[] } {
  const root = new Group();
  const hip = new Bone();
  const chest = new Bone();
  chest.position.y = 0.6;
  hip.add(chest);
  root.add(hip);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0.2, 0, 0, 0, 1.2, 0], 3));
  geo.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], 4));
  geo.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new SkinnedMesh(geo);
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new Skeleton([hip, chest]));
  return { root, meshes: [mesh], bones: [hip, chest] };
}

function context(): VfxContext {
  const layer = new ParticleLayer(8, { texture: null as never, grid: [4, 4], blend: 'additive', depthTest: false, renderOrder: 0 });
  return {
    smoke: new ParticlePool(4000),
    glow: new ParticlePool(4000),
    decals: new ParticlePool(8),
    glowLayer: layer,
    world: new CollisionWorld(movementTestMap),
    scene: new Scene(),
    camera: null as unknown as VfxContext['camera'],
    detail: 1,
    reducedMotion: false,
  };
}

const field = (pool: ParticlePool, i: number, f: number) => pool.data[i * STRIDE + f]!;
const frameOf = (...players: ReturnType<typeof playerView>[]): Frame => ({ tick: 1, localId: 0, players, grenades: [] });

describe('DashFx', () => {
  it('a dash starts with a jet kick: a hot flash, a ring of air, exhaust blown back against it', () => {
    const fx = context();
    const dash = new DashFx(new DashGhosts(fx.scene));
    const dir = 1; // up-right
    const e: SimEvent = { type: 'dash', player: 3, x: 20, y: 0, dir };
    dash.onEvents([e], fx);
    const cells = Array.from({ length: fx.glow.count }, (_, i) => field(fx.glow, i, F.cell));
    expect(cells).toContain(Cell.Glow);
    expect(cells).toContain(Cell.Ring);
    expect(fx.smoke.count).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < fx.smoke.count; i++) {
      const along = field(fx.smoke, i, F.vx) * DASH_DX[dir]! + field(fx.smoke, i, F.vy) * DASH_DY[dir]!;
      expect(along).toBeLessThan(0); // blown back
    }
    // someone else's: the warm ring
    const ring = cells.indexOf(Cell.Ring);
    expect(field(fx.glow, ring, F.tr)).toBeCloseTo(DASH_TINT.other[0]);
  });

  it('speed lines stream off a dashing body, along its motion; none once it stops', () => {
    const fx = context();
    const dash = new DashFx(new DashGhosts(fx.scene));
    const dashing = playerView({ x: 20, y: 2, vx: 14 * Math.SQRT1_2, vy: 14 * Math.SQRT1_2, dashing: true });
    for (let i = 0; i < 8; i++) dash.update(frameOf(dashing), 1 / 60, fx);
    const lines = fx.smoke.count;
    expect(lines).toBeGreaterThanOrEqual(Math.floor((LINES_PER_S * 8) / 60) - 1);
    for (let i = 0; i < lines; i++) {
      expect(field(fx.smoke, i, F.cell)).toBe(Cell.Streak);
      expect(field(fx.smoke, i, F.rot)).toBeCloseTo(Math.PI / 4, 5);
      expect(field(fx.smoke, i, F.ramp)).toBe(Ramp.Haze);
      expect(field(fx.smoke, i, F.tb)).toBeCloseTo(DASH_TINT.local[2]); // our own: cool blue
    }
    dash.update(frameOf({ ...dashing, dashing: false }), 1 / 60, fx);
    expect(fx.smoke.count).toBe(lines);
  });

  it('leaves afterimages through the dash, spaced so `max` can show', () => {
    const fx = context();
    const ghosts = new DashGhosts(fx.scene);
    const snap = vi.spyOn(ghosts, 'snap');
    const b = body();
    const dash = new DashFx(ghosts, (id) => (id === 0 ? b : null));
    const dashing = playerView({ x: 20, vx: 14, dashing: true });
    for (let i = 0; i < 8; i++) dash.update(frameOf(dashing), 1 / 60, fx); // the 8-tick burst
    expect(snap).toHaveBeenCalledTimes(4); // 0, 35, 70, 105 ms
    ghosts.max = 2;
    snap.mockClear();
    dash.update(frameOf({ ...dashing, dashing: false }), 1 / 60, fx);
    for (let i = 0; i < 8; i++) dash.update(frameOf(dashing), 1 / 60, fx);
    expect(snap).toHaveBeenCalledTimes(2); // every 70 ms
    ghosts.max = 0; // Low
    snap.mockClear();
    for (let i = 0; i < 8; i++) dash.update(frameOf(dashing), 1 / 60, fx);
    expect(snap).not.toHaveBeenCalled();
  });
});

describe('DashGhosts', () => {
  it('copies the pose at the snap and keeps it while the character moves on', () => {
    const scene = new Scene();
    const ghosts = new DashGhosts(scene);
    const b = body();
    b.bones[1]!.rotation.z = 0.5;
    ghosts.snap(b, new Color(1, 0, 0));
    const ghost = scene.getObjectByName('vfx-ghost')!;
    const mesh = ghost.children[0] as SkinnedMesh;
    expect(mesh.geometry).toBe(b.meshes[0]!.geometry); // shared, not copied
    const posed = Array.from(mesh.skeleton.boneMatrices!.subarray(0, 32));
    expect(posed).toEqual(Array.from(b.meshes[0]!.skeleton.boneMatrices!.subarray(0, 32)));
    // the character moves on; the renderer updates every skeleton each frame
    b.bones[1]!.rotation.z = -0.5;
    b.root.updateMatrixWorld(true);
    b.meshes[0]!.skeleton.update();
    mesh.skeleton.update();
    expect(Array.from(mesh.skeleton.boneMatrices!.subarray(0, 32))).toEqual(posed);
    expect(Array.from(b.meshes[0]!.skeleton.boneMatrices!.subarray(0, 32))).not.toEqual(posed);
  });

  it('fades out over its life, and never shows more than `max`', () => {
    const scene = new Scene();
    const ghosts = new DashGhosts(scene);
    const b = body();
    for (let i = 0; i < 6; i++) {
      ghosts.snap(b, new Color(1, 1, 1));
      ghosts.update(0.01);
    }
    expect(ghosts.count).toBe(4);
    ghosts.update(GHOST_LIFE);
    expect(ghosts.count).toBe(0);
    ghosts.max = 0;
    ghosts.snap(b, new Color(1, 1, 1));
    expect(ghosts.count).toBe(0);
  });
});
