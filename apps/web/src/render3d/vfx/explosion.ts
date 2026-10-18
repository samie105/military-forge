/**
 * The blast (docs/11 §5 "Explosions: flipbook fireball + debris + smoke puffs + shockwave ring +
 * shake, sized by radius"). Sized for NOTES §17's launches: the shockwave reaches the full damage
 * radius and the fireball fills most of it, so a blast reads as the big event it is.
 *
 * Layers: the flash, fireball, sparks and rings are additive light (glow); smoke, ground dust and
 * debris chunks are alpha-blended (smoke); scorch marks are decals. When the Forge's
 * explosions.vfx.json is published (manifest.ts), its flipbook (flash → fireball → smoke) replaces
 * the procedural fireball and most of the smoke, and its shockwave timing applies. Random values come
 * from a PRNG seeded by the blast's position: a blast looks the same on every client and every run.
 * Spawning copies static presets into one reusable spec: no allocation per particle.
 */
import { SegFlag, createRayHit, type CollisionWorld } from '@military-forge/sim';
import { PLANE_FRONT_Z } from '../mapGeometry';
import { Cell } from './atlas';
import type { ExplosionArt, FlipbookArt } from './manifest';
import { particleSpec, type ParticlePool, type ParticleSpec } from './pool';
import { Ramp } from './ramps';

/** the frag's radius: sizes below are for this and scale with the blast */
const REF_RADIUS = 4;
/** a blast this close to a floor (or, with nothing below, a ceiling) scorches it */
const GROUND_PROBE = 1.6;

export interface ExplosionTargets {
  glow: ParticlePool;
  smoke: ParticlePool;
  decals: ParticlePool;
  /** the Forge's explosion art, when published: its flipbook layer's pool, and the style */
  book: { pool: ParticlePool; art: FlipbookArt } | null;
  art: ExplosionArt | null;
}

/** mulberry32: a tiny seeded PRNG */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(x: number, y: number): number {
  return (Math.imul(Math.round(x * 64), 73856093) ^ Math.imul(Math.round(y * 64), 19349663)) >>> 0;
}

const base = particleSpec();
const preset = (over: Partial<ParticleSpec>): Readonly<ParticleSpec> => Object.freeze({ ...base, ...over });

const FLASH_STAR = preset({ z: 0.5, life: 0.11, size0: 3.2, size1: 5, ramp: Ramp.Flash, cell: Cell.Star });
const FLASH_GLOW = preset({ z: 0.4, life: 0.16, size0: 7, size1: 9, ramp: Ramp.Flash, cell: Cell.Glow, alpha: 0.55 });
const CORE = preset({ life: 0.6, size0: 1.6, size1: 5.4, ease: 0.45, ramp: Ramp.Fire, cell: Cell.Fire });
const FIRE = preset({ drag: 3.5, size0: 0.9, size1: 2.4, ease: 0.6, ramp: Ramp.Fire, cell: Cell.Fire });
const RING = preset({ z: 0.7, life: 0.32, size0: 0.8, ease: 0.4, ramp: Ramp.Ring, cell: Cell.Ring, alpha: 0.9 });
const GROUND_RING = preset({ life: 0.42, size0: 1, ease: 0.4, ramp: Ramp.Ring, cell: Cell.Ring, alpha: 0.75, orient: 1 });
const SPARK = preset({ drag: 1.2, grav: 14, size0: 0.2, size1: 0.14, aspect: 0.4, stretch: 0.045, ramp: Ramp.Spark, cell: Cell.Streak });
const CHUNK = preset({ drag: 0.3, grav: 20, ramp: Ramp.Chunk, cell: Cell.Chunk, front: 1 });
const DUST = preset({ drag: 2.6, size0: 0.5, size1: 1.8, ease: 0.6, ramp: Ramp.Dust, cell: Cell.Dust });
const SMOKE = preset({ drag: 0.9, size0: 1.4, size1: 3.6, ease: 0.7, ramp: Ramp.Smoke, cell: Cell.Puff });
const SCORCH = preset({ life: 10, ramp: Ramp.Scorch, cell: Cell.Scorch, orient: 1 });
const SOOT = preset({ z: PLANE_FRONT_Z + 0.01, life: 10, aspect: 0.36, ramp: Ramp.Scorch, cell: Cell.Soot });
const BOOK = preset({ ramp: Ramp.Book });

const spec: ParticleSpec = particleSpec();
const from = (p: Readonly<ParticleSpec>): ParticleSpec => Object.assign(spec, p);
const hit = createRayHit();
const SIDES = [-1, 0, 1] as const;

/**
 * Spawns one blast at (x, y). `detail` scales particle counts (graphics preset), never below a
 * readable minimum.
 */
export function spawnExplosion(t: ExplosionTargets, world: CollisionWorld, x: number, y: number, radius: number, detail: number): void {
  const rand = prng(seedOf(x, y));
  const s = radius / REF_RADIUS;
  const art = t.art;
  /** the Forge's sizes are for its style's radius */
  const k = art ? radius / art.radiusM : s;
  const n = (count: number) => Math.max(3, Math.round(count * detail));
  const range = (a: number, b: number) => a + (b - a) * rand();
  let p: ParticleSpec;

  // what the blast sits on (one-way platforms count: grenades rest on them), or, with no floor
  // below, the ceiling above it (a grenade stuck under one in reversed gravity)
  const floor = world.raycast(x, y + 0.05, 0, -1, GROUND_PROBE + 0.05, 0, hit) && world.ny[hit.seg]! > 0.5;
  const ground = floor || (world.raycast(x, y - 0.05, 0, 1, GROUND_PROBE + 0.05, SegFlag.OneWay, hit) && world.ny[hit.seg]! < -0.5);
  const nx = ground ? world.nx[hit.seg]! : 0;
  const ny = ground ? world.ny[hit.seg]! : 1;
  const platform = ground && (world.flags[hit.seg]! & SegFlag.OneWay) !== 0;
  const gx = hit.x;
  const gy = hit.y;

  // the fireball: the flipbook while its pool has room (a 17th blast in under a second falls back
  // to the procedural fireball below), else a hot core with fire puffs thrown outward. The
  // flipbook is depth-tested, so a centre-anchored one (the frag's) rises a fifth of its height on
  // a floor: most of it shows above the ground's front face instead of half of it going behind. A
  // base-anchored one (a rocket's) already stands on the surface.
  const centred = t.book !== null && t.book.art.anchorV < 0.7;
  const lift = t.book && centred && floor && y - gy < 0.6 ? t.book.art.sizeM * t.book.art.aspect * k * 0.2 : 0;
  const booked = t.book !== null && flipbook(t.book, x, y + lift, 0.6, k);

  // the flash: a star card (the flipbook opens with its own) and a wide soft glow, gone in a few frames
  if (!booked) {
    p = from(FLASH_STAR);
    p.x = x;
    p.y = y;
    p.size0 *= s;
    p.size1 *= s;
    p.rot = rand() * Math.PI;
    t.glow.emit(p);
  }
  p = from(FLASH_GLOW);
  p.x = x;
  p.y = y;
  p.size0 *= s;
  p.size1 *= s;
  t.glow.emit(p);

  if (!booked) {
    p = from(CORE);
    p.x = x;
    p.y = y;
    p.size0 *= s;
    p.size1 *= s;
    p.rot = rand() * 6.28;
    p.spin = range(-0.6, 0.6);
    t.glow.emit(p);
    for (let i = 0, count = n(10); i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand() * 0.6;
      const v = range(2.5, 7.5) * s;
      p = from(FIRE);
      p.x = x + Math.cos(a) * 0.4 * s;
      p.y = y + Math.sin(a) * 0.4 * s;
      p.z = range(0.2, 1);
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v + 2;
      p.life = range(0.4, 0.75);
      p.size0 *= s;
      p.size1 *= s;
      p.rot = rand() * 6.28;
      p.spin = range(-2, 2);
      t.glow.emit(p);
    }
  }

  // shockwave: a ring in the view plane that reaches the damage radius (the Forge's timing when published)
  p = from(RING);
  p.x = x;
  p.y = y;
  p.size0 *= s;
  p.size1 = 2.25 * radius;
  const sw = art?.shockwave;
  if (sw) {
    p.size0 = 2 * sw.fromM * k;
    p.size1 = 2 * sw.toM * k * 1.12; // the ring's bright edge sits at 89 % of the card
    p.life = sw.seconds;
    p.alpha = sw.opacity;
    [p.tr, p.tg, p.tb] = sw.tint;
  }
  t.glow.emit(p);

  // sparks: streaks along their velocity, falling
  for (let i = 0, count = n(26); i < count; i++) {
    const a = rand() * Math.PI * 2;
    const v = range(9, 21) * Math.sqrt(s);
    p = from(SPARK);
    p.x = x;
    p.y = y;
    p.z = range(0, 1);
    p.vx = Math.cos(a) * v;
    p.vy = Math.sin(a) * v + 3;
    p.vz = range(-1, 2);
    p.life = range(0.3, 0.75);
    t.glow.emit(p);
  }

  // debris: dark chunks thrown up and away from the surface (everywhere, in the air)
  const up = Math.atan2(ny, nx);
  for (let i = 0, count = n(10); i < count; i++) {
    const a = ground ? up + range(-1.2, 1.2) : rand() * Math.PI * 2;
    const v = range(6, 13) * Math.sqrt(s);
    p = from(CHUNK);
    p.x = x;
    p.y = y;
    p.z = range(-0.4, 1.2);
    p.vx = Math.cos(a) * v;
    p.vy = Math.sin(a) * v;
    p.life = range(0.9, 1.5);
    p.size0 = p.size1 = range(0.14, 0.3);
    p.rot = rand() * 6.28;
    p.spin = range(-12, 12);
    t.smoke.emit(p);
  }

  if (ground) {
    // the ground shockwave: a ring lying on the surface, seen almost edge-on
    p = from(GROUND_RING);
    p.x = gx;
    p.y = gy + 0.05;
    p.size0 *= s;
    p.size1 = 2.6 * radius;
    p.nx = nx;
    p.ny = ny;
    t.glow.emit(p);
    // dust rolling out along a floor both ways
    for (let i = 0, count = floor ? n(12) : 0; i < count; i++) {
      const dir = i % 2 === 0 ? 1 : -1;
      const v = range(5, 10) * s;
      p = from(DUST);
      p.x = gx + range(-0.3, 0.3);
      p.y = gy + 0.35 * s;
      p.z = range(-0.8, 0.9);
      p.vx = ny * v * dir;
      p.vy = -nx * v * dir + range(0.5, 1.5);
      p.life = range(0.55, 1);
      p.size0 *= s;
      p.size1 *= s;
      p.rot = rand() * 6.28;
      p.spin = range(-1, 1);
      t.smoke.emit(p);
    }
    // scorch on the surface, through the band's depth (z −1…+1)
    const w = 2.6 * s;
    p = from(SCORCH);
    p.x = gx;
    p.y = gy + ny * 0.012;
    p.size0 = p.size1 = w;
    p.aspect = 2 / w;
    p.nx = nx;
    p.ny = ny;
    t.decals.emitRecycling(p);
    // soot on the front face under it, if the ground is solid there (not a platform or an edge)
    if (!platform && solidBelow(world, gx, gy, nx, ny, w * 0.45)) {
      const h = w * 0.18;
      p = from(SOOT);
      p.x = gx - nx * h;
      p.y = gy - ny * h;
      p.size0 = p.size1 = w;
      p.rot = Math.atan2(-nx, ny);
      t.decals.emitRecycling(p);
    }
  }

  // lingering smoke: slow soot-grey puffs that rise and spread (lit from above, so unrotated); the
  // flipbook brings its own smoke, so fewer of them then, to keep the column hanging after it
  {
    for (let i = 0, count = t.book ? n(4) : n(9); i < count; i++) {
      p = from(SMOKE);
      p.x = x + range(-0.8, 0.8) * s;
      p.y = y + range(0, 0.8) * s;
      p.z = range(-0.6, 1.2);
      p.vx = range(-0.8, 0.8);
      p.vy = range(0.5, 1.4);
      p.life = range(2, 3.2);
      p.size0 *= s;
      p.size1 *= s;
      t.smoke.emit(p);
    }
  }
}

/** One flipbook quad, its anchor on the blast point; its layer picks the frame by age. False when its pool is full. */
function flipbook(book: { pool: ParticlePool; art: FlipbookArt }, x: number, y: number, z: number, k: number): boolean {
  const art = book.art;
  const p = from(BOOK);
  const w = art.sizeM * k;
  const h = w * art.aspect;
  p.x = x + (0.5 - art.anchorU) * w;
  p.y = y + (art.anchorV - 0.5) * h;
  p.z = z;
  p.life = art.frames.length / art.fps;
  p.size0 = p.size1 = w;
  p.aspect = art.aspect;
  p.cell = art.frames[0]!;
  return book.pool.emit(p);
}

/** True when the solid under a surface point is at least `depth` thick there and `halfW` to each side. */
export function solidBelow(world: CollisionWorld, gx: number, gy: number, nx: number, ny: number, halfW: number, depth = 0.9): boolean {
  for (const side of SIDES) {
    let sx = gx + ny * halfW * side;
    let sy = gy - nx * halfW * side;
    if (side !== 0) {
      // the surface must continue to each side (an edge or a step leaves the soot hanging in the air)
      if (!world.raycast(sx + nx * 0.3, sy + ny * 0.3, -nx, -ny, 0.6, SegFlag.OneWay, hit) || hit.t < 0.1) return false;
      sx = hit.x;
      sy = hit.y;
    }
    // straight in from just under the surface: a thin slab's far side is hit early
    if (world.raycast(sx - nx * 0.02, sy - ny * 0.02, -nx, -ny, depth, SegFlag.OneWay, hit)) return false;
  }
  return true;
}
