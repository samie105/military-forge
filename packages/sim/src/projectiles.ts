/**
 * Projectiles (docs/03 §11): rockets, launcher shells, saw blades, EMP orbs and flames. They live
 * in the grenade pool (GrenadeState, type PROJECTILE_TYPE_BASE + index) so they travel to clients
 * in the grenade records, and the server runs them like grenades: launched on the tick the trigger
 * is pulled, never rewound, hitting what is there on the tick they get there. The client doesn't
 * predict them (the predictor drops the ones its own shots launch) and draws the server's.
 *
 * A step: forces (gravity × gravityScale, the map's pads, wind and drag), then the move, swept as a
 * circle against walls and against players' bodies, in up to three legs (bounces). What touches it
 * decides what it does (ProjectileDef.walls, .players, .expire).
 */
import { DRAGON, EMP, HitZone, PROJECTILE_TYPE_BASE, STANDING_HITBOXES, projectileOfType, projectileRadius, type ProjectileDef, type WeaponDef } from '@military-forge/content';
import { DEG2RAD, POS_INV, VEL_INV, hash4, hashToUnit, quantize, simCosSin } from '@military-forge/shared';
import { cloudDef, cloudRadius } from './clouds';
import { DT, TICK_RATE, ticks } from './constants';
import { DamageSource } from './events';
import type { Game } from './game';
import { closestPointOnSegment, rayCapsule } from './geometry';
import { emp, explode, grenadeForces, sweepCircle, sweepHit, type GrenadeState } from './grenades';
import { createBodyEnv } from './mechanics';
import type { PlayerState } from './player';
import { SegFlag, createRayHit } from './world';

/** GrenadeState.state of a projectile: it has bounced (a blade or flame can now hit its shooter) */
export const BOUNCED = 1;

const aim = { x: 0, y: 0 };
const pt = { x: 0, y: 0 };
const ray = createRayHit();
const env = createBodyEnv();
/** a body for projectiles: one capsule from the shins to the head's centre (crouched: lower) */
const BODY_FOOT = 0.1;

/** The projectile a grenade-pool slot holds, or undefined (a grenade). */
export function projectileOf(g: GrenadeState): ProjectileDef | undefined {
  return projectileOfType(g.type);
}

/**
 * One shot of a launcher or the flamethrower (stepWeapons, instead of a bullet): the projectile
 * leaves the muzzle along the aim (± the weapon's seeded spread, the same hash as bullets), with a
 * share of the shooter's velocity. Pressed against a wall it starts at the wall: a rocket fired into
 * the floor goes off at once (rocket jumps). False when the pool is full (the shot isn't spent).
 */
export function launchProjectile(game: Game, p: PlayerState, def: WeaponDef, spread: number): GrenadeState | null {
  const proj = def.projectile!;
  const g = game.allocGrenade();
  if (!g) return null;
  const t = game.tuning;
  const sx = p.shoulderX(t);
  const sy = p.shoulderY(t);
  const u = hashToUnit(hash4(game.seed, game.tick, p.id, p.shotCounter));
  p.shotCounter = (p.shotCounter + 1) | 0;
  simCosSin(p.aim + (2 * u - 1) * spread * DEG2RAD, aim);
  let spawnDist = def.muzzleLength;
  if (game.world.raycast(sx, sy, aim.x, aim.y, spawnDist + proj.radius, SegFlag.BulletPass, ray)) spawnDist = Math.max(0, ray.t - proj.radius - 0.02);
  g.alive = true;
  g.owner = p.id;
  g.type = PROJECTILE_TYPE_BASE + proj.index;
  g.weapon = def.index;
  g.state = 0;
  g.hits = 0;
  g.x = quantize(sx + aim.x * spawnDist, POS_INV);
  g.y = quantize(sy + aim.y * spawnDist, POS_INV);
  g.vx = quantize(aim.x * proj.speed + p.vx * proj.inheritVelocity, VEL_INV);
  g.vy = quantize(aim.y * proj.speed + p.vy * proj.inheritVelocity, VEL_INV);
  g.fuse = ticks(proj.life);
  game.events.push({ type: 'launch', owner: p.id, grenade: g.id, weapon: def.index });
  return g;
}

/** The weapon a projectile is credited to (kill feed, damage source). */
function sourceOf(g: GrenadeState): number {
  return g.weapon >= 0 ? g.weapon : DamageSource.Grenade;
}

/** Its blast (an explosion or an EMP burst) where it is, and it's gone. */
function blowUp(game: Game, g: GrenadeState, def: ProjectileDef): void {
  g.alive = false;
  if (def.explosion) explode(game, g.x, g.y, g.owner, def.explosion, sourceOf(g), g.type);
  else if (def.emp) emp(game, g.x, g.y, g.owner, def.emp, EMP.index);
}

/** Can `q` be hit by `g` (its shooter only once it has bounced, and only if the def says so)? */
function hittable(g: GrenadeState, def: ProjectileDef, q: PlayerState): boolean {
  if (!q.alive) return false;
  return q.id !== g.owner || (def.ownerAfterBounce > 0 && g.state === BOUNCED);
}

/** Earliest touch (fraction of the move) of a circle of radius r moving (mx, my) from (x, y) with `q`'s body. */
function bodyT(q: PlayerState, x: number, y: number, mx: number, my: number, r: number): number {
  const top = q.crouched ? STANDING_HITBOXES.head.y * 0.68 : STANDING_HITBOXES.head.y;
  return rayCapsule(x, y, mx, my, q.x, q.y + BODY_FOOT, q.x, q.y + top, STANDING_HITBOXES.torso.r + r);
}

/**
 * Nothing solid between a projectile at (x, y) and `q`'s body (fences and plain one-ways don't count;
 * walls and slabs do): its swept circle can touch a body on the far side of a slab, a flame most
 * of all at its 0.6 m (review: a Dragon under a slab killed the player standing on it).
 */
function reaches(game: Game, x: number, y: number, q: PlayerState): boolean {
  const top = q.crouched ? STANDING_HITBOXES.head.y * 0.68 : STANDING_HITBOXES.head.y;
  closestPointOnSegment(x, y, q.x, q.y + BODY_FOOT, q.x, q.y + top, pt);
  const dx = pt.x - x;
  const dy = pt.y - y;
  const d = Math.sqrt(dx * dx + dy * dy);
  return d < 1e-6 || !game.world.raycast(x, y, dx / d, dy / d, d, SegFlag.BulletPass, ray);
}

/** A direct hit on `q`: the def's damage (× ownerAfterBounce on its shooter), burning, a knock. */
function strike(game: Game, g: GrenadeState, def: ProjectileDef, q: PlayerState): void {
  const mul = q.id === g.owner ? def.ownerAfterBounce : 1;
  if (def.burn) {
    q.burnTicks = Math.max(q.burnTicks, ticks(def.burn.seconds));
    q.burnBy = g.owner;
  }
  if (def.damage > 0) game.damage(q, def.damage * mul, g.owner, sourceOf(g), HitZone.Torso);
}

/** Flames put out the toxic gas they touch (docs/03 §11). */
function douseGas(game: Game, g: GrenadeState, r: number): void {
  for (const c of game.clouds) {
    if (!c.alive) continue;
    const cd = cloudDef(c.type);
    if (!cd || cd.dpsCore <= 0) continue;
    const reach = cloudRadius(cd, c.age) + r;
    const dx = c.x - g.x;
    const dy = c.y - g.y;
    if (dx * dx + dy * dy < reach * reach) c.alive = false;
  }
}

export function stepProjectile(game: Game, g: GrenadeState, def: ProjectileDef): void {
  if (--g.fuse <= 0) {
    if (def.expire === 'explode') blowUp(game, g, def);
    else g.alive = false;
    return;
  }
  const r = projectileRadius(def, (game.tick - g.born) / TICK_RATE);
  if (game.mech) grenadeForces(game, g, def.gravityScale, game.mech.envAt(g.x, g.y, env));
  else if (def.gravityScale !== 0) g.vy -= game.tuning.gravity * def.gravityScale * DT;

  let remaining = 1;
  for (let leg = 0; leg < 3 && remaining > 1e-6 && g.alive; leg++) {
    const mx = g.vx * DT * remaining;
    const my = g.vy * DT * remaining;
    const wall = def.walls !== 'pass' && sweepCircle(game.world, g.x, g.y, mx, my, r);
    const tWall = wall ? sweepHit.t : 1;
    const nx = sweepHit.nx;
    const ny = sweepHit.ny;

    // players along this leg, before the wall
    if (def.players === 'pierce') {
      // through everyone in the way, once each between bounces
      for (const q of game.players) {
        if (!q || !hittable(g, def, q) || (g.hits & (1 << q.id)) !== 0) continue;
        const t = bodyT(q, g.x, g.y, mx, my, r);
        if (t > tWall || !reaches(game, g.x + mx * t, g.y + my * t, q)) continue;
        g.hits |= 1 << q.id;
        strike(game, g, def, q);
      }
    } else {
      let first: PlayerState | null = null;
      let tFirst = tWall;
      for (const q of game.players) {
        if (!q || !hittable(g, def, q)) continue;
        const t = bodyT(q, g.x, g.y, mx, my, r);
        if (t <= tFirst && reaches(game, g.x + mx * t, g.y + my * t, q)) {
          tFirst = t;
          first = q;
        }
      }
      if (first) {
        g.x += mx * tFirst;
        g.y += my * tFirst;
        if (def.players === 'explode') {
          strike(game, g, def, first);
          blowUp(game, g, def);
        } else {
          strike(game, g, def, first);
          g.alive = false;
        }
        break;
      }
    }

    if (!wall) {
      g.x += mx;
      g.y += my;
      break;
    }
    g.x += mx * tWall + nx * 1e-4;
    g.y += my * tWall + ny * 1e-4;
    if (def.walls === 'explode') {
      blowUp(game, g, def);
      break;
    }
    // a bounce: e × the normal speed back, the tangential speed less friction
    const vn = g.vx * nx + g.vy * ny;
    if (vn < 0) {
      const tx = g.vx - nx * vn;
      const ty = g.vy - ny * vn;
      g.vx = tx * (1 - def.friction) - nx * vn * def.restitution;
      g.vy = ty * (1 - def.friction) - ny * vn * def.restitution;
    }
    g.state = BOUNCED;
    g.hits = 0; // a new segment: a blade cuts the same player again
    remaining *= 1 - tWall;
  }
  if (!g.alive) return;
  if (def.clearsGas) douseGas(game, g, r);
  g.x = quantize(g.x, POS_INV);
  g.y = quantize(g.y, POS_INV);
  g.vx = quantize(g.vx, VEL_INV);
  g.vy = quantize(g.vy, VEL_INV);
}

/**
 * Burning (the flamethrower, docs/03 §11): `dps × pulse` damage every `pulse` seconds while it
 * lasts, credited to whoever set it. Before stepStatus counts the other effects down.
 */
export function stepBurn(game: Game, p: PlayerState): void {
  if (p.burnTicks <= 0) return;
  const burn = DRAGON.projectile!.burn!;
  const pulse = Math.max(1, Math.round(burn.pulse * TICK_RATE));
  if (p.burnTicks % pulse === 0) game.damage(p, burn.dps * burn.pulse, p.burnBy, DRAGON.index, HitZone.Torso);
  if (--p.burnTicks === 0) p.burnBy = -1;
}
