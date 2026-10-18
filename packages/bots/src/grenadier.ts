/**
 * Grenade throws: the bot tries a fan of angles and throw strengths, flies each one through the
 * sim's own grenade physics (bounces, wind, pads, the map's gravity) and picks the one that comes to
 * rest closest to where the target will be when the fuse runs out, but never one that ends inside
 * its own blast. Solves are rare (the brain rations them), so the cost is fine.
 */
import { FRAG } from '@military-forge/content';
import { DEG2RAD, simCosSin } from '@military-forge/shared';
import { DT, GrenadeState, SegFlag, createRayHit, stepGrenade, type Game, type PlayerState } from '@military-forge/sim';

export interface Throw {
  /** aim angle (rad) and Input.throwStrength (0..7) */
  angle: number;
  strength: number;
  /** where it should go off, and how far from the target */
  x: number;
  y: number;
  miss: number;
}

/** stays at least this far from its own blast (m): the radius plus a margin */
const SELF_CLEARANCE = FRAG.explosion.radius + 2;
/** good enough: ends within this of the target (m) */
const MAX_MISS = 2.5;
const STRENGTHS = [3, 5, 7];

const scratch = new GrenadeState(-1);
const dir = { x: 0, y: 0 };
const ray = createRayHit();

/**
 * The best throw from `self` at a target whose feet are at (tx, ty), or null. Mirrors throwGrenade's
 * launch (shoulder, spawn distance, strength, inherited velocity) for each candidate.
 */
export function solveThrow(game: Game, self: PlayerState, tx: number, ty: number): Throw | null {
  const t = game.tuning;
  const side = tx >= self.x ? 1 : -1;
  const fuse = Math.round(FRAG.fuse / DT);
  let best: Throw | null = null;
  for (let deg = -20; deg <= 70; deg += 10) {
    const angle = side > 0 ? deg * DEG2RAD : (180 - deg) * DEG2RAD;
    simCosSin(angle, dir);
    // the shoulder the throw starts from faces the throw (facing follows the aim)
    const facing = dir.x >= 0 ? 1 : -1;
    const sx = self.x + facing * t.shoulderForward;
    const sy = self.y + (self.crouched ? t.shoulderCrouch : t.shoulderStand);
    let spawnDist = 0.35;
    if (game.world.raycast(sx, sy, dir.x, dir.y, spawnDist + FRAG.radius, SegFlag.BulletPass, ray)) spawnDist = Math.max(0, ray.t - FRAG.radius - 0.02);
    for (const strength of STRENGTHS) {
      const speed = FRAG.throwSpeed * t.grenadeThrowScale * (0.7 + (0.3 * strength) / 7);
      const g = scratch;
      g.alive = true;
      g.owner = self.id;
      g.type = FRAG.index;
      g.x = sx + dir.x * spawnDist;
      g.y = sy + dir.y * spawnDist;
      g.vx = dir.x * speed + self.vx * FRAG.inheritVelocity;
      g.vy = dir.y * speed + self.vy * FRAG.inheritVelocity;
      g.fuse = 1 << 30; // never goes off here: only flown
      for (let k = 1; k < fuse; k++) stepGrenade(game, g);
      const sdx = g.x - self.x;
      const sdy = g.y - (self.y + 0.75);
      if (sdx * sdx + sdy * sdy < SELF_CLEARANCE * SELF_CLEARANCE) continue;
      const miss = Math.sqrt((g.x - tx) * (g.x - tx) + (g.y - (ty + 0.5)) * (g.y - (ty + 0.5)));
      if (miss <= MAX_MISS && (!best || miss < best.miss)) best = { angle, strength, x: g.x, y: g.y, miss };
    }
  }
  return best;
}
