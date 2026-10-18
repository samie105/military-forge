/**
 * How a bot aims: like a hand on a mouse, not a turret.
 * - The aim chases where it wants to point with a lag (BotLevel.aimLag) and a turn-rate limit.
 * - That point wobbles, in metres at the target (the screen is a fixed-scale side view, so a hand's
 *   error is in metres, not degrees): a slow drift (Ornstein–Uhlenbeck, 1σ = BotLevel.aimError)
 *   plus a fast tremor (BotLevel.aimJitter), both bigger while the bot or its target moves fast
 *   across the line (BotLevel.moveError).
 * - It leads a moving target by part of its velocity (BotLevel.lead).
 * - A new target starts with a flick that overshoots, and the first shot waits out BotLevel.reaction.
 * - A flashbang's fade (`impair`, the white-out left) multiplies the error, up to BLIND_ERROR times.
 * - Far away, the error grows with the view a human widens to (the mouse wheel) to keep the target on
 *   screen: a hand's error is on the screen, and a pixel covers more ground zoomed out (viewScale).
 * It fires only while the aim is on the target's body (BotLevel.fireCone × its half-width).
 */
import { VIEW_BASE_WIDTH, VIEW_LOOKAHEAD, VIEW_MAX_ASPECT, maxZoomLevels, viewWidth } from '@military-forge/netcode';
import { DT, type PlayerState } from '@military-forge/sim';
import { PI, simAtan2, simExp, wrapAngle, type Xoshiro128 } from '@military-forge/shared';
import type { BotLevel } from './levels';

/** correlation times (s): how long a drift lasts, and the tremor */
const DRIFT_TIME = 0.4;
const TREMOR_TIME = 0.07;
/** inside this distance (m) the aim error shrinks in proportion */
const CLOSE = 4;
/** a flashbang's fade at its whitest makes the drift and tremor this many times bigger */
const BLIND_ERROR = 5;
/** a body's half-width for aiming (m): the capsule plus a little hitbox */
export const BODY_HALF_WIDTH = 0.36;
/** torso centre above the feet (m), standing / crouched */
const TORSO = 0.85;
const TORSO_CROUCHED = 0.6;

/** the target sits at least this far (m) inside the edge of the view a human picks for it */
const ZOOM_MARGIN = 2;

/**
 * How many times the closest view (VIEW_BASE_WIDTH) the human's screen is when it keeps a target
 * (dx, dy) away in view: the closest zoom level the loadout allows that shows it, with the camera's
 * look-ahead toward the aim. 1 out to about 22 m; the Widow's widest is 2.3.
 */
export function viewScale(self: PlayerState, dx: number, dy: number): number {
  const levels = maxZoomLevels(self);
  const need = Math.max(Math.abs(dx), Math.abs(dy) / VIEW_MAX_ASPECT) + ZOOM_MARGIN;
  for (let z = 0; z < levels - 1; z++) {
    if ((viewWidth(z) / 2) * (1 + VIEW_LOOKAHEAD) >= need) return viewWidth(z) / VIEW_BASE_WIDTH;
  }
  return viewWidth(levels - 1) / VIEW_BASE_WIDTH;
}

/** A standard normal from four uniforms (Irwin–Hall): deterministic, no logarithms. */
export function gauss(rng: Xoshiro128): number {
  return (rng.nextFloat() + rng.nextFloat() + rng.nextFloat() + rng.nextFloat() - 2) * 1.7320508075688772;
}

export class Aim {
  /** where the hand points (rad), smoothed */
  private hand = 0;
  /** the aim this tick (rad): the hand plus its tremor; what the Input carries */
  angle = 0;
  /** drift and tremor at the target (m) */
  private nx = 0;
  private ny = 0;
  private jx = 0;
  private jy = 0;
  /** the player being aimed at (−1: none) */
  target = -1;
  /** ticks before the first shot at the current target */
  wait = 0;
  /** how whited out the bot still is (0…1; the brain sets it every tick): a fading flashbang */
  impair = 0;
  /** the view it aims in at the last track (viewScale): errors and the fire window are on the screen */
  private view = 1;
  private readonly follow: number;
  private readonly maxTurn: number;

  constructor(
    readonly level: BotLevel,
    private readonly rng: Xoshiro128,
  ) {
    this.follow = 1 - simExp(-DT / level.aimLag);
    this.maxTurn = level.turnRate * DT;
  }

  /** Starts on a new target: a flick that overshoots, then the reaction wait. */
  acquire(target: number): void {
    if (target === this.target) return;
    this.target = target;
    const flick = this.level.aimError * 2 * (1 + (BLIND_ERROR - 1) * this.impair);
    this.nx = gauss(this.rng) * flick;
    this.ny = gauss(this.rng) * flick;
    this.wait = Math.max(1, Math.round((this.level.reaction * (0.8 + 0.4 * this.rng.nextFloat())) / DT));
  }

  drop(): void {
    this.target = -1;
  }

  /** Turns toward an angle (no target: looking where it goes, at a grenade's throw angle). */
  turnTo(angle: number): void {
    const d = wrapAngle(angle - this.hand);
    this.hand = wrapAngle(this.hand + Math.max(-this.maxTurn, Math.min(this.maxTurn, d * this.follow * 2)));
    this.angle = this.hand;
  }

  /**
   * Tracks `q` for one tick from the shooter's shoulder at (sx, sy); `self` moving adds wobble.
   * Returns the angle to the target's torso centre (what "on target" is measured against).
   */
  track(self: PlayerState, q: PlayerState, sx: number, sy: number): number {
    const L = this.level;
    if (this.wait > 0) this.wait--;
    const tx = q.x;
    const ty = q.y + (q.crouched ? TORSO_CROUCHED : TORSO);
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    // motion across the line of fire makes aiming harder (both ends)
    const across = (vx: number, vy: number) => Math.abs((vx * dy - vy * dx) / dist);
    const motion = Math.min(1, across(self.vx, self.vy) / 6) + Math.min(1, across(q.vx, q.vy) / 6);
    this.view = viewScale(self, dx, dy);
    const worse = (1 + (L.moveError - 1) * motion) * (1 + (BLIND_ERROR - 1) * this.impair) * this.view;
    // Ornstein–Uhlenbeck: pulls back to 0 over its time, kicked by noise of the right size
    const k = DT / DRIFT_TIME;
    const kick = L.aimError * worse * Math.sqrt(2 * k);
    this.nx += -this.nx * k + kick * gauss(this.rng);
    this.ny += -this.ny * k + kick * gauss(this.rng);
    const kj = DT / TREMOR_TIME;
    const kickJ = L.aimJitter * worse * Math.sqrt(2 * kj);
    this.jx += -this.jx * kj + kickJ * gauss(this.rng);
    this.jy += -this.jy * kj + kickJ * gauss(this.rng);
    // up close the body fills the view and a hand's error shrinks with it (inside CLOSE metres)
    const near = Math.min(1, dist / CLOSE);
    // the hand chases the drifting point (leading part of the target's motion over its lag)...
    const lead = L.lead * L.aimLag;
    const want = simAtan2(ty + q.vy * lead + this.ny * near - sy, tx + q.vx * lead + this.nx * near - sx);
    const d = wrapAngle(want - this.hand);
    this.hand = wrapAngle(this.hand + Math.max(-this.maxTurn, Math.min(this.maxTurn, d * this.follow)));
    // ...and the tremor sits on top of it: the part across the line of sight moves the aim
    const tremor = ((this.jy * dx - this.jx * dy) * near) / (dist * dist);
    this.angle = wrapAngle(this.hand + tremor);
    return simAtan2(dy, dx);
  }

  /** On the body: within fireCone × the half-width at this distance, on the screen it aims in (and no reaction wait left). */
  onTarget(centre: number, dist: number): boolean {
    if (this.wait > 0) return false;
    const err = Math.abs(wrapAngle(this.angle - centre));
    const allowed = Math.min(PI / 4, (BODY_HALF_WIDTH * this.level.fireCone * this.view) / Math.max(1, dist));
    return err <= allowed;
  }
}
