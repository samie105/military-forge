/**
 * Riot shield (docs/03 §5, §9; numbers in @military-forge/content shield.ts): carry modes, weight
 * and the blocking surface. A player carries at most one shield (PlayerState.shieldHp > 0). It is
 * either up in front of the body or slung on the back:
 *   - it comes up (over raiseTime) only with a one-handed weapon in hand and no dual pair;
 *   - a two-handed weapon or going dual slings it, and it comes back up when that ends;
 *   - the shield key slings it on purpose, and raises it again (ending a dual pair).
 * Up, it weighs RIOT_SHIELD.moveSpeedMul (the heaviest item in hand sets the speed, docs/03 §9;
 * heldSpeedMul in player.ts), and no dash starts while it is up or coming up (dashBlocked).
 *
 * It blocks bullets with a vertical segment that follows the facing and the crouch: all the way
 * up, in front of the torso, struck from within ±arcDeg of the facing; slung, behind it, struck
 * from within ±arcDeg of the back (owner's call, 17 Oct 2026). On its way up it blocks neither
 * way. Bullets that strike it wear it down (one HP pool; it breaks at 0) and bounce off
 * (combat.ts). Launcher projectiles stop at its face the same way (projectiles.ts: a rocket, shell
 * or blade goes off there, a flame is spent, and the blast counts its carrier as covered; an EMP
 * orb passes it, as it passes walls). Melee and grenades ignore it.
 */
import { RIOT_SHIELD, weapons } from '@military-forge/content';
import { DEG2RAD, SCALAR_INV, quantize, simCos } from '@military-forge/shared';
import { ticks } from './constants';
import type { Game } from './game';
import { raySegment } from './geometry';
import { Btn, wasPressed } from './input';
import { DUAL_TOGGLE_TIME, cancelReloads, type PlayerState } from './player';

/** Ticks from slung to up and blocking. */
export const SHIELD_RAISE_TICKS = Math.max(1, ticks(RIOT_SHIELD.raiseTime));

/** One-handed weapon (or nothing) in hand. */
function oneHanded(p: PlayerState): boolean {
  const def = weapons[p.weapons[p.active]!.def];
  return def === undefined || def.hands === 1;
}

/** In front of the body: up, or on its way up. It is drawn there and weighs its raised weight. */
export function shieldInFront(p: PlayerState): boolean {
  return p.shieldTicks > 0;
}

/** All the way up: it blocks bullets from the front. */
export function shieldRaised(p: PlayerState): boolean {
  return p.shieldTicks >= SHIELD_RAISE_TICKS;
}

/** On the back (carried, not raised nor on its way up): it blocks bullets from behind. */
export function shieldSlung(p: PlayerState): boolean {
  return p.shieldHp > 0 && p.shieldTicks === 0;
}

/** Hands `p` a shield with `hp`; it comes up from the next tick if the weapon in hand allows. */
export function giveShield(p: PlayerState, hp: number): void {
  p.shieldHp = hp;
  p.shieldStowed = false;
  p.shieldTicks = 0;
}

/** No shield any more (broken or dropped). */
export function clearShield(p: PlayerState): void {
  p.shieldHp = 0;
  p.shieldStowed = false;
  p.shieldTicks = 0;
}

/**
 * The shield key and the carry mode. Game.step runs it for every living player after movement and
 * before anyone fires, so every shot of a tick meets the same shields.
 */
export function stepShield(p: PlayerState): void {
  if (p.shieldHp <= 0) return;
  if (wasPressed(p.input.buttons, p.prevButtons, Btn.Shield)) {
    if (p.shieldTicks > 0) p.shieldStowed = true; // up or coming up: sling it
    else if (!p.shieldStowed && !oneHanded(p)) p.shieldStowed = true; // waiting for a one-handed weapon: keep it on the back
    else {
      // bring it up; it takes the off hand from a dual pair (as if Dual were pressed)
      p.shieldStowed = false;
      if (p.dual) {
        p.dual = false;
        p.swapTicks = ticks(DUAL_TOGGLE_TIME);
        cancelReloads(p);
      }
    }
  }
  p.shieldTicks = !p.shieldStowed && !p.dual && oneHanded(p) ? Math.min(SHIELD_RAISE_TICKS, p.shieldTicks + 1) : 0;
}

/** cos of the block arc: a bullet travelling along d is blocked when side · d.x ≤ −COS_ARC. */
const COS_ARC = simCos(RIOT_SHIELD.arcDeg * DEG2RAD);

/** Bottom of the blocking segment above the feet. */
export function shieldBottom(crouched: boolean): number {
  return crouched ? RIOT_SHIELD.bottomCrouch : RIOT_SHIELD.bottomStand;
}

/**
 * Where a ray from (sx, sy) along the unit vector (dx, dy) strikes the shield of a player standing
 * at (x, y): the ray's t, or Infinity when it misses the segment or comes from outside the block
 * arc. `side` is the shield's outward normal, (side, 0): the facing for a raised shield (a segment
 * `offset` = RIOT_SHIELD.forward in front), the opposite for a slung one (RIOT_SHIELD.backOffset
 * behind). A bullet must travel against the normal, within ±arcDeg of it.
 */
export function shieldHitT(
  sx: number,
  sy: number,
  dx: number,
  dy: number,
  x: number,
  y: number,
  side: number,
  crouched: boolean,
  offset: number = RIOT_SHIELD.forward,
): number {
  if (side * dx > -COS_ARC) return Infinity;
  const fx = x + side * offset;
  const y0 = y + shieldBottom(crouched);
  return raySegment(sx, sy, dx, dy, fx, y0, fx, y0 + RIOT_SHIELD.height);
}

/** A shield's blocking face (shieldFace): its x and its bottom and top. */
export interface ShieldFace {
  x: number;
  y0: number;
  y1: number;
}

/**
 * `q`'s shield facing something travelling along a unit vector whose x is `dx`: raised, in front;
 * slung, behind; struck from within the block arc, as bullets (shieldHitT). Fills `out` (a vertical
 * segment) and returns true, or false when nothing of it faces that way.
 */
export function shieldFace(q: PlayerState, dx: number, out: ShieldFace): boolean {
  if (q.shieldHp <= 0) return false;
  const front = shieldRaised(q);
  if (!front && !shieldSlung(q)) return false; // on its way up it guards neither side
  const side = front ? q.facing : -q.facing;
  if (side * dx > -COS_ARC) return false;
  out.x = q.x + side * (front ? RIOT_SHIELD.forward : RIOT_SHIELD.backOffset);
  out.y0 = q.y + shieldBottom(q.crouched);
  out.y1 = out.y0 + RIOT_SHIELD.height;
  return true;
}

/**
 * Bullet damage to `p`'s shield, struck at (x, y). Returns true when that breaks it: the shield is
 * gone and a `shieldBreak` event marks the spot.
 */
export function damageShield(game: Game, p: PlayerState, amount: number, attacker: number, x: number, y: number): boolean {
  const hp = quantize(p.shieldHp - amount, SCALAR_INV);
  if (hp > 0) {
    p.shieldHp = hp;
    return false;
  }
  clearShield(p);
  game.events.push({ type: 'shieldBreak', owner: p.id, attacker, x, y });
  return true;
}
