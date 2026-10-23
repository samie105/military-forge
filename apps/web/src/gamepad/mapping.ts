/**
 * Pad readings → the same `Input` the keyboard and touch produce (pure, unit-tested): dead zones and
 * response curves for the sticks, thresholds with hysteresis for analog triggers, the movement zones
 * (run, the stick-jet cone, crouch) with hysteresis, the dash's direction and strength, the aim's turn
 * (a fast flip past 90°) and the reticle's reach. The numbers are docs/design/controls-research.md §5.
 */
import { Btn } from '@military-forge/sim';
import { wrapAngle, type StickVector } from '../touch/stick';
import type { ButtonMap } from './settings';

export type { StickVector } from '../touch/stick';

/** A trigger lets go this far under its threshold: press at 0.30, let go under 0.20 (spec §5.5). */
export const TRIGGER_HYSTERESIS = 0.1;
/** A stick past this fraction of its throw already counts as all the way (few sticks reach the rim; spec §5.1). */
export const STICK_OUTER = 0.92;

/**
 * Raw stick axes (−1..1, y down as the Gamepad API gives them) → a shaped vector (y up, like the world):
 * a radial dead zone (no drift at rest, no square corners), the rest rescaled to 0..1, then `curve`
 * (1 = linear; above 1, finer control near the centre).
 */
export function shapeAxes(x: number, y: number, deadzone: number, curve = 1, out: StickVector = { x: 0, y: 0, mag: 0 }, snapDeg = 0): StickVector {
  const len = Math.hypot(x, y);
  const t = (len - deadzone) / Math.max(1e-6, STICK_OUTER - deadzone);
  if (!(t > 0) || len === 0) {
    out.x = 0;
    out.y = 0;
    out.mag = 0;
    return out;
  }
  const mag = Math.min(1, t) ** curve;
  out.x = (x / len) * mag;
  out.y = (-y / len) * mag;
  out.mag = mag;
  // an angular snap: a push within `snapDeg` of pure left or right is pure left or right (a run stays level)
  if (snapDeg > 0 && Math.abs(out.y) <= Math.sin((snapDeg * Math.PI) / 180) * mag) {
    out.x = Math.sign(out.x) * mag;
    out.y = 0;
  }
  return out;
}

/** The angle of a shaped vector, in degrees (−180..180, 0 = right, 90 = up). */
export const stickDeg = (v: StickVector): number => (Math.atan2(v.y, v.x) * 180) / Math.PI;

/** An analog trigger (or any button) held: past `threshold`, and it stays held until it drops a little under it. */
export function triggerHeld(value: number, pressed: boolean, wasHeld: boolean, threshold: number): boolean {
  // (the release point never drops under a hair trigger's 0.05: a resting finger reads ~0.02)
  // digital triggers (some pads, some browsers) report 0 or 1 only, or just `pressed`
  if (pressed && value === 0) return true;
  return value >= (wasHeld ? Math.max(0.05, threshold - TRIGGER_HYSTERESIS) : threshold);
}

/**
 * The move stick's zones (spec §5.1–5.2), on the shaped vector (dead zone 0.15, outer 0.92, linear):
 * - **run** from |x| ≥ 0.18 (about 0.30 of the raw throw), until it drops under 0.12; the y axis
 *   never stops a run;
 * - **jet** (stick-up) starts only inside the steep cone 55°–125° with a push ≥ 0.60, then holds
 *   while the angle stays within 20°–160° and the push ≥ 0.40, so a run that drifts up doesn't take
 *   off, and diagonal flight stays easy;
 * - **crouch** only within ±30° of straight down, with a push ≥ 0.70 (held to 0.55).
 */
export const MOVE_ZONES = {
  snapDeg: 12,
  runOn: 0.18,
  runOff: 0.12,
  jetStart: { minDeg: 55, maxDeg: 125, push: 0.6 },
  jetHold: { minDeg: 20, maxDeg: 160, push: 0.4 },
  crouch: { halfDeg: 30, push: 0.7, holdPush: 0.55 },
} as const;

/** What the move stick held last tick: its zones have hysteresis. */
export interface MoveState {
  run: -1 | 0 | 1;
  jet: boolean;
  crouch: boolean;
}

export const createMoveState = (): MoveState => ({ run: 0, jet: false, crouch: false });

/** The movement bits for this tick's move-stick reading (updates `st`). `stickJet` off: no jet from the stick. */
export function moveStep(st: MoveState, v: StickVector, stickJet: boolean): number {
  const z = MOVE_ZONES;
  if (v.mag === 0) {
    st.run = 0;
    st.jet = false;
    st.crouch = false;
    return 0;
  }
  const deg = stickDeg(v);
  // run: hysteresis on |x|, and a reversal flips at once
  const dir = v.x > 0 ? 1 : -1;
  const ax = Math.abs(v.x);
  if (ax >= z.runOn) st.run = dir;
  else if (st.run === dir && ax >= z.runOff) st.run = dir;
  else st.run = 0;
  // jet: the steep start cone, the wide hold zone
  if (!stickJet) st.jet = false;
  else if (st.jet) st.jet = deg >= z.jetHold.minDeg && deg <= z.jetHold.maxDeg && v.mag >= z.jetHold.push;
  else st.jet = deg >= z.jetStart.minDeg && deg <= z.jetStart.maxDeg && v.mag >= z.jetStart.push;
  // crouch: within ±30° of straight down
  const down = Math.abs(deg + 90) <= z.crouch.halfDeg;
  st.crouch = down && v.mag >= (st.crouch ? z.crouch.holdPush : z.crouch.push);
  let b = 0;
  if (st.run > 0) b |= Btn.Right;
  else if (st.run < 0) b |= Btn.Left;
  if (st.jet) b |= Btn.Jet;
  else if (st.crouch) b |= Btn.Down;
  return b;
}

/** Stateless: the bits a reading gives from rest (the check page and tests; play uses moveStep). */
export function moveBits(move: StickVector, stickJet: boolean): number {
  return moveStep(createMoveState(), move, stickJet);
}

/** Held buttons → the sim's bits (the grenade's is the throw latch's, never held: input.ts ThrowLatch). */
export function heldBits(held: readonly boolean[], map: ButtonMap): number {
  let b = 0;
  for (let i = 0; i < held.length; i++) if (held[i]) b |= map.bits[i] ?? 0;
  return b & ~Btn.Grenade;
}

/**
 * The dash's zones match movement's (spec §5.2): left or right within ±35° of horizontal, up within
 * ±35° of vertical (55°–125°, the stick-jet's start cone), down likewise, the diagonals in between.
 */
export const DASH_ZONES = { sideDeg: 35, diagonalTo: 55 } as const;

/** The dash's direction bits (8 ways) from the move stick at the press; none (the soldier's facing) below a run's push. */
export function dashDirection(move: StickVector): number {
  if (move.mag < MOVE_ZONES.runOn) return 0;
  const deg = stickDeg(move);
  const a = Math.abs(deg);
  let b = 0;
  if (a < DASH_ZONES.diagonalTo) b |= Btn.Right;
  else if (a > 180 - DASH_ZONES.diagonalTo) b |= Btn.Left;
  if (deg > DASH_ZONES.sideDeg && deg < 180 - DASH_ZONES.sideDeg) b |= Btn.Jet;
  else if (deg < -DASH_ZONES.sideDeg && deg > -180 + DASH_ZONES.sideDeg) b |= Btn.Down;
  return b;
}

/** Flick speed (stick throw per second) at which a dash is full whatever the stick's push. */
export const FULL_FLICK = 8;

/**
 * A dash's strength 0..7 (v14's `Input.dashStrength`, the dash agent's field): the stick resting is a
 * plain full dash (as the keyboard's); otherwise the push or the flick, whichever is more, from about
 * half (3) to full (7). A quick flick from the centre to the rim (≈ 125 ms) is always full.
 */
export function padDashStrength(mag: number, flickPerSecond: number): number {
  if (mag <= 0) return 7;
  const push = Math.min(1, Math.max(0, (mag - 0.2) / 0.7));
  const flick = Math.min(1, Math.max(0, flickPerSecond / FULL_FLICK));
  return Math.round((0.45 + 0.55 * Math.max(push, flick)) * 7);
}

/** At aim speed 1 the aim turns at most this far per tick toward the stick (rad; ≈ 1200°/s, spec §5.3). */
export const AIM_TURN = 0.35;
/** A turn of more than 90° (a facing flip) completes within this many ticks, whatever the aim speed (spec §5.3). */
export const FLIP_TICKS = 3;
/** The aim stick's raw push under which its angle holds (no wobble near the dead zone; spec §5.3). */
export const AIM_MIN_PUSH = 0.3;

/** The aim's turn: a flip past 90° keeps its pace until it lands. */
export interface AimState {
  /** rad per tick while a flip is under way, 0 otherwise */
  flipRate: number;
}

export const createAimState = (): AimState => ({ flipRate: 0 });

/**
 * The aim one tick on, turning toward where the stick points: `speed` (0.3..2) scales the turn cap,
 * 2 is at once. A change of more than 90° completes in ≤ FLIP_TICKS ticks (a turnaround), at least
 * as fast as the cap. Stateless calls (no `st`) cap small turns only.
 */
export function stepAim(current: number, desired: number, speed: number, st?: AimState): number {
  if (speed >= 1.95) {
    if (st) st.flipRate = 0;
    return desired;
  }
  const d = wrapAngle(desired - current);
  let max = AIM_TURN * speed;
  if (st) {
    if (Math.abs(d) > Math.PI / 2 && st.flipRate === 0) st.flipRate = Math.abs(d) / FLIP_TICKS;
    if (st.flipRate > 0) max = Math.max(max, st.flipRate);
    if (Math.abs(d) <= max + 1e-9) st.flipRate = 0;
  }
  return wrapAngle(current + Math.max(-max, Math.min(max, d)));
}

/** The reticle's reach along the aim (m): the aim stick's push (after its curve) from near to far. */
export const RETICLE = { near: 3, far: 12 };

export function reticleDistance(mag: number): number {
  return RETICLE.near + (RETICLE.far - RETICLE.near) * Math.min(1, Math.max(0, mag));
}

/** A held grenade's throw strength 0..7 from the aim stick's push (as the touch stick's). */
export function padThrowStrength(mag: number): number {
  return Math.round(Math.min(1, Math.max(0, mag)) * 7);
}

export type NavDir = 'up' | 'down' | 'left' | 'right';

/** A stick reading (raw axes, y down) as a menu direction: past half-way, along its stronger axis. */
export function stickNavDirection(x: number, y: number): NavDir | null {
  if (Math.hypot(x, y) < 0.5) return null;
  if (Math.abs(x) > Math.abs(y)) return x < 0 ? 'left' : 'right';
  return y < 0 ? 'up' : 'down';
}

/** Menu key repeat: the first move at once, the next after a pause, then steadily. */
export const NAV_REPEAT = { first: 380, every: 120 };

/** Whether a held direction moves again at `now` (ms), given when it went down and last moved. */
export function navRepeats(downAt: number, lastAt: number, now: number): boolean {
  if (now - downAt < NAV_REPEAT.first) return false;
  return now - lastAt >= NAV_REPEAT.every;
}
