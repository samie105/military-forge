/**
 * A launcher's blast at a riot shield's face (#111): a rocket, shell or Ripper blade that meets a
 * raised shield, or a slung one from behind, goes off at its face. The steel plate flares along its
 * face and throws a fan of sparks back the way the projectile came, over the blast's own fireball;
 * the struck spot glows on as it cools.
 *
 * The sim's `explosion` event doesn't say that a shield stopped it, so the blast is matched to a
 * shield face from the last drawn frame (render only, no protocol change). It must be:
 * - within reach of the face's x, on its strike side;
 * - along the face's height.
 * The face is the sim's (shieldFace): RIOT_SHIELD.forward in front when raised, backOffset behind
 * when slung, from shieldBottom up RIOT_SHIELD.height. A launcher's blast that happens to go off
 * right at a face it never touched (a blade's life running out there) sparks the plate too.
 */
import { RIOT_SHIELD, projectileOfType } from '@military-forge/content';
import { shieldBottom } from '@military-forge/sim';
import type { PlayerView } from '../../view';
import { facingOf } from '../locomotion';
import { Cell } from './atlas';
import { particleSpec, type ParticlePool, type ParticleSpec } from './pool';
import { Ramp } from './ramps';

/** how far off the face (past the projectile's radius) a blast still counts as at it: a frame's motion */
const SLACK = 0.18;
/** above and below the face: a projectile's radius, and a frame's motion */
const SLACK_Y = 0.25;
/** a warm white for the plate's flare */
const FLARE_TINT = [1, 0.9, 0.72] as const;
/** the struck spot, hot steel */
const HOT_TINT = [1, 0.62, 0.3] as const;

const spec: ParticleSpec = particleSpec();
const base = particleSpec();
const reset = (): ParticleSpec => Object.assign(spec, base);

/** where the last match was (tests): the face's x, the side it faces, and its span */
export interface ShieldHit {
  x: number;
  side: 1 | -1;
  y0: number;
  y1: number;
}

export class ShieldBlasts {
  /** the last drawn frame's players (Vfx.update): their shields as the blast met them */
  players: readonly PlayerView[] = [];
  private seed = 0x5eed;
  private readonly hit: ShieldHit = { x: 0, side: 1, y0: 0, y1: 0 };

  /**
   * A blast of `grenade` at (x, y): when it's a launcher's and it went off at a shield's face, the
   * flare and sparks into `glow`; returns that face, or null. `detail` is the preset's density;
   * `reducedMotion` halves the sparks; `steady` (Reduce flashes) dims the flare.
   */
  blast(x: number, y: number, grenade: number, glow: ParticlePool, detail: number, reducedMotion: boolean, steady: boolean): ShieldHit | null {
    const def = projectileOfType(grenade);
    if (!def?.explosion) return null;
    const face = this.faceAt(x, y, def.radius);
    if (!face) return null;
    const { side, y0, y1 } = face;
    const fy = Math.min(y1, Math.max(y0, y));
    // the plate flares along its face, a streak stood upright
    let p = reset();
    p.x = face.x + side * 0.05;
    p.y = (y0 + y1) / 2;
    p.z = 0.5; // in front of the plate, as the ricochet's sparks
    p.rot = Math.PI / 2;
    p.life = 0.14;
    p.size0 = RIOT_SHIELD.height * 1.15;
    p.size1 = RIOT_SHIELD.height;
    p.aspect = 0.32;
    p.alpha = steady ? 0.45 : 1;
    p.ramp = Ramp.Flash;
    p.cell = Cell.Streak;
    [p.tr, p.tg, p.tb] = FLARE_TINT;
    glow.emit(p);
    // a hot spot where it struck, cooling after the fireball's flash has gone
    p = reset();
    p.x = face.x + side * 0.04;
    p.y = fy;
    p.z = 0.5;
    p.life = 0.4;
    p.size0 = 0.42;
    p.size1 = 0.22;
    p.alpha = steady ? 0.6 : 1;
    p.ramp = Ramp.Spark;
    p.cell = Cell.Glow;
    [p.tr, p.tg, p.tb] = HOT_TINT;
    glow.emit(p);
    // and throws sparks back off its face, the way the projectile came
    const out = side > 0 ? 0 : Math.PI;
    for (let i = 0, count = Math.max(4, Math.round(18 * detail * (reducedMotion ? 0.5 : 1))); i < count; i++) {
      const a = out + (this.rand() * 2 - 1) * 1.25;
      const v = 6 + this.rand() * 9;
      p = reset();
      p.x = face.x + side * 0.06;
      p.y = fy + (this.rand() - 0.5) * 0.3;
      p.z = 0.5;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v;
      p.grav = 12;
      p.drag = 2.2;
      p.life = 0.25 + this.rand() * 0.35; // outlasting the blast's own debris streaks
      p.size0 = 0.13;
      p.size1 = 0.05;
      p.aspect = 0.35;
      p.stretch = 0.035;
      p.ramp = Ramp.Spark;
      p.cell = Cell.Streak;
      glow.emit(p);
    }
    return face;
  }

  /** The face of a shield that a blast at (x, y) from a projectile of radius `r` went off against, or null. */
  private faceAt(x: number, y: number, r: number): ShieldHit | null {
    let best: ShieldHit | null = null;
    let bestD = r + SLACK;
    for (const p of this.players) {
      if (!p.alive || (p.shield !== 'front' && p.shield !== 'back')) continue;
      const front = p.shield === 'front';
      const facing = facingOf(p.aim);
      const side = front ? facing : (-facing as 1 | -1);
      const fx = p.x + side * (front ? RIOT_SHIELD.forward : RIOT_SHIELD.backOffset);
      // on the strike side of the face (a hair behind it for a frame's motion)
      const d = (x - fx) * side;
      if (d < -0.08 || d > bestD) continue;
      const y0 = p.y + shieldBottom(p.crouched);
      const y1 = y0 + RIOT_SHIELD.height;
      if (y < y0 - SLACK_Y || y > y1 + SLACK_Y) continue;
      bestD = Math.max(d, 0);
      best = Object.assign(this.hit, { x: fx, side, y0, y1 });
    }
    return best;
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
}

/** shards of the broken plate: the shield's light steel */
const SHARD_TINT = [0.42, 0.55, 0.68] as const;
const breakSpec: ParticleSpec = particleSpec();

/**
 * A riot shield broken at (x, y) (`shieldBreak`, at 0 HP: docs/03 §5), which drew nothing in 3D: a
 * flash, the plate's steel shards thrown out and falling, and sparks. `smoke` takes the shards
 * (alpha-blended, in front), `glow` the flash and sparks.
 */
export function shieldBreak(x: number, y: number, glow: ParticlePool, smoke: ParticlePool, detail: number, rand: () => number): void {
  const p = breakSpec;
  const fresh = (): ParticleSpec => Object.assign(p, base);
  fresh();
  p.x = x;
  p.y = y;
  p.z = 0.5;
  p.life = 0.14;
  p.size0 = 1.3;
  p.size1 = 0.7;
  p.rot = rand() * Math.PI;
  p.ramp = Ramp.Flash;
  p.cell = Cell.Star;
  [p.tr, p.tg, p.tb] = FLARE_TINT;
  glow.emit(p);
  fresh();
  p.x = x;
  p.y = y;
  p.z = 0.5;
  p.life = 0.22;
  p.size0 = 0.4;
  p.size1 = 1.6;
  p.ease = 0.5;
  p.alpha = 0.7;
  p.ramp = Ramp.Ring;
  p.cell = Cell.Ring;
  glow.emit(p);
  for (let i = 0, n = Math.max(5, Math.round(12 * detail)); i < n; i++) {
    const a = rand() * Math.PI * 2;
    const v = 2 + rand() * 4.5;
    fresh();
    p.x = x + Math.cos(a) * 0.15;
    p.y = y + (rand() - 0.3) * 0.6;
    p.z = 0.5;
    p.vx = Math.cos(a) * v;
    p.vy = Math.abs(Math.sin(a)) * v + 1.5;
    p.grav = 16;
    p.drag = 0.4;
    p.life = 0.6 + rand() * 0.4;
    p.size0 = p.size1 = 0.08 + rand() * 0.09;
    p.rot = rand() * Math.PI;
    p.spin = (rand() - 0.5) * 18;
    p.front = 1;
    p.ramp = Ramp.Book;
    p.cell = Cell.Chunk;
    [p.tr, p.tg, p.tb] = SHARD_TINT;
    smoke.emit(p);
  }
  for (let i = 0, n = Math.max(4, Math.round(14 * detail)); i < n; i++) {
    const a = rand() * Math.PI * 2;
    const v = 4 + rand() * 8;
    fresh();
    p.x = x;
    p.y = y;
    p.z = 0.5;
    p.vx = Math.cos(a) * v;
    p.vy = Math.sin(a) * v + 1;
    p.grav = 12;
    p.drag = 2.2;
    p.life = 0.2 + rand() * 0.3;
    p.size0 = 0.12;
    p.size1 = 0.05;
    p.aspect = 0.35;
    p.stretch = 0.035;
    p.ramp = Ramp.Spark;
    p.cell = Cell.Streak;
    glow.emit(p);
  }
}
