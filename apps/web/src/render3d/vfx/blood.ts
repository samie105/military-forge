/**
 * Blood, as an option (the owner's playtest, 18 Oct: "when you're shooting your opponents maybe
 * some blood we can add on the settings"). **Off by default** (age ratings): the Settings toggle
 * calls `Renderer3D.setBlood(on)` and the 2D view's `Renderer.setBlood(on)`. Off, a bullet hitting
 * a player stays the non-gory thud gunfire.ts draws (docs/03 §13). On, it throws instead:
 * - a short spray of droplets out of the far side, along the shot, falling; how many and how big
 *   follow the hit's damage (a headshot more);
 * - a thin mist that hangs a moment;
 * - when the hit hurts (BLOOD_SPLAT_DAMAGE or more) and the floor is close below, a small splat
 *   on it: a strip through the band's depth, as a blast's scorch is, and where the ground is solid
 *   a splash on its front face, which the camera sees. Splats fade over SPLAT_LIFE.
 * All of it is the shared pools' particles (no extra draws); splats recycle the oldest decal.
 */
import { createRayHit, type CollisionWorld } from '@military-forge/sim';
import { PLANE_FRONT_Z } from '../mapGeometry';
import { Cell } from './atlas';
import { solidBelow } from './explosion';
import { particleSpec, type ParticlePool, type ParticleSpec } from './pool';
import { Ramp } from './ramps';

/** a hit dealing this much or more leaves a splat */
export const BLOOD_SPLAT_DAMAGE = 20;
/** how far below a hit the floor may be for a splat (m) */
const FLOOR_REACH = 2.2;
/** seconds a splat stays (it fades over the last fifth) */
export const SPLAT_LIFE = 6;

const spec: ParticleSpec = particleSpec();
const base = particleSpec();
const reset = (): ParticleSpec => Object.assign(spec, base);
const hit = createRayHit();

export interface BloodTargets {
  smoke: ParticlePool;
  /** no splats without it */
  decals?: ParticlePool;
}

/**
 * A bullet dealing `damage` hit a player at (x, y), flying along (ux, uy): the spray, the mist and
 * maybe a splat. `rand`: the caller's deterministic 0…1 source; `detail`: the preset's density.
 */
export function bloodHit(t: BloodTargets, world: CollisionWorld, x: number, y: number, ux: number, uy: number, damage: number, head: boolean, detail: number, rand: () => number): void {
  const k = Math.min(2.2, Math.max(0.4, damage / 30)) * (head ? 1.4 : 1);
  const along = Math.atan2(uy, ux);
  for (let i = 0, n = Math.max(2, Math.round((3 + 6 * k) * detail)); i < n; i++) {
    const a = along + (rand() * 2 - 1) * 0.7;
    const v = (1.5 + 3 * rand()) * (0.8 + 0.25 * k);
    const p = reset();
    p.x = x;
    p.y = y;
    p.z = (rand() - 0.5) * 0.3;
    p.vx = Math.cos(a) * v;
    p.vy = Math.sin(a) * v + 0.6;
    p.vz = (rand() - 0.5) * 0.8;
    p.grav = 9;
    p.drag = 1.5;
    p.life = 0.35 + 0.3 * rand();
    p.size0 = (0.05 + 0.04 * rand()) * (0.8 + 0.3 * k);
    p.size1 = p.size0 * 0.6;
    p.stretch = 0.02;
    p.ramp = Ramp.Blood;
    p.cell = Cell.Dot;
    t.smoke.emit(p);
  }
  {
    const p = reset();
    p.x = x + ux * 0.1;
    p.y = y + uy * 0.1;
    p.z = 0.05;
    p.vx = ux * 0.6;
    p.vy = uy * 0.6;
    p.drag = 3;
    p.life = 0.3;
    p.size0 = 0.16 * k;
    p.size1 = 0.5 * k;
    p.ease = 0.5;
    p.rot = rand() * Math.PI * 2;
    p.ramp = Ramp.BloodMist;
    p.cell = Cell.Puff;
    t.smoke.emit(p);
  }
  const decals = t.decals;
  if (!decals || damage < BLOOD_SPLAT_DAMAGE || !world.raycast(x, y, 0, -1, FLOOR_REACH, 0, hit)) return;
  const nx = world.nx[hit.seg]!;
  const ny = world.ny[hit.seg]!;
  if (ny < 0.5) return;
  const gx = x + ux * 0.3;
  const gy = y - hit.t;
  const w = (0.3 + 0.15 * rand()) * Math.min(k, 1.5);
  let p = reset();
  p.x = gx;
  p.y = gy + ny * 0.012;
  p.size0 = p.size1 = w;
  p.aspect = 1.2 / w; // through 1.2 m of the band's depth
  p.nx = nx;
  p.ny = ny;
  p.orient = 1;
  p.life = SPLAT_LIFE;
  p.ramp = Ramp.BloodDecal;
  p.cell = Cell.Splat;
  decals.emitRecycling(p);
  if (!solidBelow(world, gx, gy, nx, ny, w * 0.45)) return;
  p = reset();
  p.x = gx;
  p.y = gy - w * 0.15;
  p.z = PLANE_FRONT_Z + 0.01;
  p.size0 = p.size1 = w * 0.6;
  p.rot = rand() * Math.PI * 2;
  p.life = SPLAT_LIFE;
  p.ramp = Ramp.BloodDecal;
  p.cell = Cell.Splat;
  decals.emitRecycling(p);
}
