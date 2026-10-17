/**
 * Simulated projectiles: the frag grenade (docs/02 §13.2, §14). Swept-circle CCD against
 * segments, bounce with restitution + tangential friction, rest/roll, fuse, explosion.
 */
import type { ExplosionDef, GrenadeDef } from '@military-forge/content';
import { POS_INV, VEL_INV, quantize, simCosSin } from '@military-forge/shared';
import { DT, ticks } from './constants';
import { DamageSource } from './events';
import type { Game } from './game';
import { closestPointOnSegment, rayCapsule } from './geometry';
import { createBodyEnv, type BodyEnv } from './mechanics';
import { hitboxLayout, knockOutOfDash, type PlayerState } from './player';
import { SegFlag, createRayHit, type CollisionWorld } from './world';

export class GrenadeState {
  alive = false;
  owner = -1;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  fuse = 0;
  constructor(readonly id: number) {}
}

const aim = { x: 0, y: 0 };
const pt = { x: 0, y: 0 };
const ray = createRayHit();
const sweepHit = { t: 0, nx: 0, ny: 0 };

/** Earliest hit of a circle moving by (mx, my) this step. */
function sweepCircle(world: CollisionWorld, x: number, y: number, mx: number, my: number, radius: number): boolean {
  const count = world.queryAabb(
    Math.min(x, x + mx) - radius - 0.05,
    Math.min(y, y + my) - radius - 0.05,
    Math.max(x, x + mx) + radius + 0.05,
    Math.max(y, y + my) + radius + 0.05,
  );
  let bestT = Infinity;
  let bestSeg = -1;
  let bestNx = 0;
  let bestNy = 0;
  for (let k = 0; k < count; k++) {
    const seg = world.queryResult[k]!;
    const flags = world.flags[seg]!;
    if (flags & SegFlag.OneWay) {
      // platforms only stop grenades falling onto them from above
      if (my >= 0 || y - radius < world.segmentYAt(seg, x) - 0.01) continue;
    }
    const ax = world.ax[seg]!;
    const ay = world.ay[seg]!;
    const bx = world.bx[seg]!;
    const by = world.by[seg]!;
    const t = rayCapsule(x, y, mx, my, ax, ay, bx, by, radius);
    if (t > 1 || t > bestT) continue;
    const hx = x + mx * t;
    const hy = y + my * t;
    closestPointOnSegment(hx, hy, ax, ay, bx, by, pt);
    let nx = hx - pt.x;
    let ny = hy - pt.y;
    const len = Math.sqrt(nx * nx + ny * ny);
    if (len > 1e-9) {
      nx /= len;
      ny /= len;
    } else {
      nx = world.nx[seg]!;
      ny = world.ny[seg]!;
    }
    if (mx * nx + my * ny >= 0) continue; // moving away (e.g. escaping an initial overlap)
    if (t < bestT) {
      bestT = t;
      bestSeg = seg;
      bestNx = nx;
      bestNy = ny;
    }
  }
  if (bestSeg < 0) return false;
  sweepHit.t = bestT;
  sweepHit.nx = bestNx;
  sweepHit.ny = bestNy;
  return true;
}

export function throwGrenade(game: Game, p: PlayerState, def: GrenadeDef): boolean {
  const g = game.allocGrenade();
  if (!g) return false;
  const t = game.tuning;
  const sx = p.shoulderX(t);
  const sy = p.shoulderY(t);
  simCosSin(p.aim, aim);
  const strength = 0.7 + (0.3 * Math.max(0, Math.min(7, p.input.throwStrength))) / 7;
  const speed = def.throwSpeed * strength;
  // spawn just in front of the shoulder, unless a wall is in the way
  let spawnDist = 0.35;
  if (game.world.raycast(sx, sy, aim.x, aim.y, spawnDist + def.radius, SegFlag.BulletPass, ray)) {
    spawnDist = Math.max(0, ray.t - def.radius - 0.02);
  }
  g.alive = true;
  g.owner = p.id;
  g.x = sx + aim.x * spawnDist;
  g.y = sy + aim.y * spawnDist;
  g.vx = aim.x * speed + p.vx * def.inheritVelocity;
  g.vy = aim.y * speed + p.vy * def.inheritVelocity;
  g.fuse = ticks(def.fuse);
  game.events.push({ type: 'throw', owner: p.id, grenade: g.id });
  return true;
}

/** Fastest a grenade falls (m/s), and rises under reversed gravity. */
const GRENADE_TERMINAL = 30;
const grenadeEnv = createBodyEnv();

/** Map mechanics on a grenade (docs/02 §20): pads, wind and drag, then gravity scaled by the map. */
function grenadeForces(game: Game, g: GrenadeState, def: GrenadeDef, env: BodyEnv): void {
  for (let i = 0; i < env.padCount; i++) {
    const ux = env.padUx[i]!;
    const uy = env.padUy[i]!;
    const short = env.padSpeed[i]! - (g.vx * ux + g.vy * uy);
    if (short <= 0) continue;
    g.vx += short * ux;
    g.vy += short * uy;
  }
  if (env.windX !== 0 || env.windY !== 0) {
    g.vx += env.windX * DT;
    g.vy += env.windY * DT;
  }
  if (env.dragKeep !== 1) {
    g.vx *= env.dragKeep;
    g.vy *= env.dragKeep;
  }
  const gravity = game.tuning.gravity * def.gravityScale * env.gravityMul;
  g.vy = gravity >= 0 ? Math.max(-GRENADE_TERMINAL, g.vy - gravity * DT) : Math.min(GRENADE_TERMINAL, g.vy - gravity * DT);
}

export function stepGrenade(game: Game, g: GrenadeState, def: GrenadeDef): void {
  if (--g.fuse <= 0) {
    explode(game, g.x, g.y, g.owner, def.explosion);
    g.alive = false;
    return;
  }
  if (game.mech) grenadeForces(game, g, def, game.mech.envAt(g.x, g.y, grenadeEnv));
  else g.vy = Math.max(-GRENADE_TERMINAL, g.vy - game.tuning.gravity * def.gravityScale * DT);

  let remaining = 1;
  for (let iter = 0; iter < 3 && remaining > 1e-6; iter++) {
    const mx = g.vx * DT * remaining;
    const my = g.vy * DT * remaining;
    if (!sweepCircle(game.world, g.x, g.y, mx, my, def.radius)) {
      g.x += mx;
      g.y += my;
      break;
    }
    const { t, nx, ny } = sweepHit;
    g.x += mx * t + nx * 1e-4;
    g.y += my * t + ny * 1e-4;
    const vn = g.vx * nx + g.vy * ny;
    if (vn < 0) {
      const tx = g.vx - nx * vn;
      const ty = g.vy - ny * vn;
      if (-vn < def.restNormalSpeed && ny > 0.7) {
        // resting / rolling: no bounce, rolling friction on the tangential part
        const ts = Math.sqrt(tx * tx + ty * ty);
        const k = ts > 1e-9 ? Math.max(0, 1 - (def.rollFriction * DT) / ts) : 0;
        g.vx = tx * k;
        g.vy = ty * k;
      } else {
        g.vx = tx * (1 - def.friction) - nx * vn * def.restitution;
        g.vy = ty * (1 - def.friction) - ny * vn * def.restitution;
      }
    }
    remaining *= 1 - t;
  }

  g.x = quantize(g.x, POS_INV);
  g.y = quantize(g.y, POS_INV);
  g.vx = quantize(g.vx, VEL_INV);
  g.vy = quantize(g.vy, VEL_INV);
}

/** Radial damage with line-of-sight and knockback (docs/02 §12, §14). */
export function explode(game: Game, x: number, y: number, owner: number, def: ExplosionDef): void {
  game.events.push({ type: 'explosion', x, y, radius: def.radius, owner });
  const world = game.world;
  for (const q of game.players) {
    if (!q || !q.alive) continue;
    const box = hitboxLayout(q);
    // damage point: closest point on the torso capsule
    closestPointOnSegment(x, y, q.x, q.y + box.torso.y0, q.x, q.y + box.torso.y1, pt);
    const tx = pt.x;
    const ty = pt.y;
    const dx = tx - x;
    const dy = ty - y;
    const centreDist = Math.sqrt(dx * dx + dy * dy);
    const d = Math.max(0, centreDist - box.torso.r);
    if (d > def.radius) continue;

    // line of sight to torso, then head
    let covered = centreDist > 1e-6 && world.raycast(x, y, dx / centreDist, dy / centreDist, centreDist, SegFlag.BulletPass, ray);
    if (covered) {
      const hx = q.x - x;
      const hy = q.y + box.head.y - y;
      const hd = Math.sqrt(hx * hx + hy * hy);
      covered = hd > 1e-6 && world.raycast(x, y, hx / hd, hy / hd, hd, SegFlag.BulletPass, ray);
    }

    let damage = 0;
    if (!covered) {
      if (d <= def.core) damage = def.maxDamage;
      else {
        const k = (d - def.core) / (def.radius - def.core);
        damage = def.maxDamage * (1 - k * Math.sqrt(k)); // k^1.5
      }
      if (q.crouched) damage *= def.crouchDamageMul;
      if (q.id === owner) damage *= def.selfDamageMul;
    }

    // knockback
    const k = 1 - (d / def.radius) * (d / def.radius);
    const cx = q.x - x;
    const cy = q.y + (box.torso.y0 + box.torso.y1) / 2 - y + def.upBias;
    const cl = Math.sqrt(cx * cx + cy * cy);
    if (cl > 1e-6 && k > 0) {
      knockOutOfDash(q, game.tuning, game.mech ? game.mech.moveSpeedMul(q, game.tuning) : 1); // blasts end a dash (docs/02 §21)
      let mag = def.impulse * k * (covered ? def.coveredImpulseMul : 1) * (q.id === owner ? def.selfImpulseMul : 1);
      if (game.mech) mag *= game.mech.knockbackMul(q, game.tuning);
      let ux = cx / cl;
      let uy = cy / cl;
      // level or low blasts launch in an arc (minLift); blasts from above keep pushing down
      if (uy > -0.2 && uy < def.minLift) {
        uy = def.minLift;
        ux = (ux < 0 ? -1 : 1) * Math.sqrt(1 - uy * uy);
      }
      q.vx += ux * mag;
      q.vy += uy * mag;
      if (uy > 0.2) q.grounded = false;
    }
    if (damage > 0) game.damage(q, damage, owner, DamageSource.Grenade, 2);
  }
}

