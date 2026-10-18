/**
 * Proximity mines (docs/02 §14). A mine is a grenade (game.grenades) whose `state` walks
 * Flying → Arming → Armed → Triggered, with `fuse` as the ticks left in that state:
 * - Flying: straight, gravity-free flight for the grenade's fuse, then it drops; a direct hit on a
 *   player sets it off; the first surface it touches, it sticks to.
 * - Arming (2 s), then Armed (180 s, then it despawns): an enemy body within 1.6 m in line of
 *   sight starts the beep.
 * - Triggered: the beep (0.25 s), then the blast. Bullets (10 HP: whoever empties it gets the
 *   credit) and other blasts (after a short chain delay) trigger it too; an EMP disarms it.
 */
import { grenades, type GrenadeDef, type MineDef } from '@military-forge/content';
import { POS_INV, VEL_INV, quantize } from '@military-forge/shared';
import { DT, ticks } from './constants';
import { DamageSource } from './events';
import type { Game } from './game';
import { closestPointOnSegment, rayCapsule, rayCircle } from './geometry';
import { explode, grenadeForces, sweepCircle, sweepHit, type GrenadeState } from './grenades';
import { createBodyEnv } from './mechanics';
import { hitboxLayout } from './player';
import { SegFlag, createRayHit } from './world';

export const MineState = {
  Flying: 0,
  Arming: 1,
  Armed: 2,
  Triggered: 3,
} as const;

const pt = { x: 0, y: 0 };
const ray = createRayHit();
const mineEnv = createBodyEnv();

type MineGrenade = GrenadeDef & { effect: 'mine' };

/** The mine def of a grenade, or null if it isn't a mine. */
export function mineOf(g: GrenadeState): MineDef | null {
  const def = grenades[g.type];
  return g.alive && def?.effect === 'mine' ? def.mine : null;
}

/** One tick of a mine (instead of the bounce-and-fuse code of the other grenades). */
export function stepMine(game: Game, g: GrenadeState, def: MineGrenade): void {
  const m = def.mine;
  switch (g.state) {
    case MineState.Flying:
      flyMine(game, g, def);
      break;
    case MineState.Arming:
      if (--g.fuse <= 0) {
        g.state = MineState.Armed;
        g.fuse = ticks(m.lifetime);
      }
      break;
    case MineState.Armed:
      if (--g.fuse <= 0) g.alive = false; // despawns
      else if (enemyNear(game, g, m)) triggerMine(g, ticks(m.beep));
      break;
    default:
      if (--g.fuse <= 0) blowMine(game, g, m, def.index);
  }
}

/** Starts the countdown to the blast (never lengthens one already running). */
export function triggerMine(g: GrenadeState, delayTicks: number): void {
  if (g.state === MineState.Triggered && g.fuse <= delayTicks) return;
  g.state = MineState.Triggered;
  g.fuse = Math.max(1, delayTicks);
}

function blowMine(game: Game, g: GrenadeState, m: MineDef, grenade: number): void {
  g.alive = false; // before the blast, so it doesn't set itself off again
  explode(game, g.x, g.y, g.owner, m.explosion, DamageSource.Mine, grenade);
}

/** The earliest player (not the thrower) the mine's circle runs into while moving by (mx, my), as t ∈ [0, 1], or Infinity. */
function sweepPlayers(game: Game, g: GrenadeState, mx: number, my: number, radius: number): number {
  let best = Infinity;
  for (const q of game.players) {
    if (!q?.alive || q.id === g.owner) continue;
    const box = hitboxLayout(q);
    const tHead = rayCircle(g.x, g.y, mx, my, q.x, q.y + box.head.y, box.head.r + radius);
    const tTorso = rayCapsule(g.x, g.y, mx, my, q.x, q.y + box.torso.y0, q.x, q.y + box.torso.y1, box.torso.r + radius);
    const tLegs = rayCapsule(g.x, g.y, mx, my, q.x, q.y + box.legs.y0, q.x, q.y + box.legs.y1, box.legs.r + radius);
    best = Math.min(best, tHead, tTorso, tLegs);
  }
  return best <= 1 ? best : Infinity;
}

function flyMine(game: Game, g: GrenadeState, def: MineGrenade): void {
  // straight for the fuse (the throw's short range), then it drops; the map's pads, wind, drag and
  // gravity act on it like on any grenade (docs/02 §20)
  const straight = g.fuse > 0;
  if (straight) g.fuse--;
  if (game.mech) grenadeForces(game, g, straight ? def.gravityScale : 1, game.mech.envAt(g.x, g.y, mineEnv));
  else if (!straight) g.vy = Math.max(-30, g.vy - game.tuning.gravity * DT);
  const mx = g.vx * DT;
  const my = g.vy * DT;
  const tPlayer = sweepPlayers(game, g, mx, my, def.radius);
  const tWorld = sweepCircle(game.world, g.x, g.y, mx, my, def.radius) ? sweepHit.t : Infinity;
  if (tPlayer <= tWorld && tPlayer !== Infinity) {
    // a direct hit on a player
    g.x += mx * tPlayer;
    g.y += my * tPlayer;
    blowMine(game, g, def.mine, def.index);
    return;
  }
  if (tWorld !== Infinity) {
    // sticks to the surface it touched
    g.x += mx * tWorld + sweepHit.nx * 1e-4;
    g.y += my * tWorld + sweepHit.ny * 1e-4;
    g.vx = 0;
    g.vy = 0;
    g.state = MineState.Arming;
    g.fuse = ticks(def.mine.arm);
  } else {
    g.x += mx;
    g.y += my;
  }
  g.x = quantize(g.x, POS_INV);
  g.y = quantize(g.y, POS_INV);
  g.vx = quantize(g.vx, VEL_INV);
  g.vy = quantize(g.vy, VEL_INV);
}

/**
 * Retires the oldest live mines (by the tick they were thrown, then by slot) until `owner` (−1:
 * anyone) has at most `keep` left, removing `limit` at most. Returns how many went. A thrower's new
 * mine retires its oldest past MineDef.maxLive; a full grenade pool gives up the oldest mine of all.
 */
export function retireMines(game: Game, owner: number, keep: number, limit = Infinity): number {
  let removed = 0;
  for (;;) {
    let count = 0;
    let oldest: GrenadeState | null = null;
    for (const g of game.grenades) {
      if (!mineOf(g) || (owner >= 0 && g.owner !== owner)) continue;
      count++;
      if (!oldest || g.born < oldest.born) oldest = g;
    }
    if (!oldest || count <= keep || removed >= limit) return removed;
    oldest.alive = false;
    removed++;
  }
}

/** An enemy (anyone but the thrower) whose body is within the trigger radius, with nothing solid between. */
function enemyNear(game: Game, g: GrenadeState, m: MineDef): boolean {
  const r = game.tuning.capsuleRadius;
  for (const q of game.players) {
    if (!q?.alive || q.id === g.owner) continue;
    closestPointOnSegment(g.x, g.y, q.x, q.y + r, q.x, q.y + q.height(game.tuning) - r, pt);
    const dx = pt.x - g.x;
    const dy = pt.y - g.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d - r > m.triggerRadius) continue;
    if (d > 1e-6 && game.world.raycast(g.x, g.y, dx / d, dy / d, d, SegFlag.BulletPass, ray)) continue;
    return true;
  }
  return false;
}

/** Result of shootableMine: the mine hit and where along the ray. */
export const mineHit = { grenade: -1, t: 0 };

/**
 * The nearest mine a bullet from (sx, sy) along the unit (dx, dy) hits before `maxT`, into
 * mineHit; false if none. Mines sit still, so there's nothing to rewind (lag compensation).
 */
export function shootableMine(game: Game, sx: number, sy: number, dx: number, dy: number, maxT: number): boolean {
  mineHit.grenade = -1;
  mineHit.t = maxT;
  for (const g of game.grenades) {
    const m = mineOf(g);
    if (!m) continue;
    const t = rayCircle(sx, sy, dx, dy, g.x, g.y, m.hitRadius);
    if (t < mineHit.t) {
      mineHit.t = t;
      mineHit.grenade = g.id;
    }
  }
  return mineHit.grenade >= 0;
}

/** A bullet hits a mine: emptied, it goes off at once, credited to whoever emptied it. */
export function damageMine(g: GrenadeState, amount: number, attacker: number): void {
  const m = mineOf(g);
  if (!m) return;
  if (g.hp === 0) g.hp = m.hp; // never hit before
  g.hp = quantize(g.hp - amount, POS_INV);
  if (g.hp > 0) return;
  g.hp = -1; // spent
  g.owner = attacker;
  triggerMine(g, 1);
}

/** A blast at (x, y) with `radius` sets off the mines it reaches (line of sight), after their chain delay. */
export function chainMines(game: Game, x: number, y: number, radius: number): void {
  for (const g of game.grenades) {
    const m = mineOf(g);
    if (!m) continue;
    const dx = g.x - x;
    const dy = g.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > radius) continue;
    if (d > 1e-6 && game.world.raycast(x, y, dx / d, dy / d, d, SegFlag.BulletPass, ray)) continue;
    triggerMine(g, ticks(m.chainDelay));
  }
}

/** An EMP at (x, y) disarms the mines within `radius` (through walls): they're gone. */
export function disarmMines(game: Game, x: number, y: number, radius: number): number {
  let n = 0;
  for (const g of game.grenades) {
    if (!mineOf(g)) continue;
    if ((g.x - x) * (g.x - x) + (g.y - y) * (g.y - y) > radius * radius) continue;
    g.alive = false;
    n++;
  }
  return n;
}
