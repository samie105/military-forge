/**
 * Pad readings → the same `Input` the keyboard and touch produce (pure, unit-tested): dead zones and
 * response curves for the sticks, thresholds with a little hysteresis for analog triggers, the
 * movement bits, the dash's direction and strength, the aim's turn and the reticle's reach.
 */
import { Btn } from '@military-forge/sim';
import { MOVE_THRESHOLDS, moveButtons, wrapAngle, type MoveThresholds, type StickVector } from '../touch/stick';
import type { ButtonMap } from './settings';

export type { StickVector } from '../touch/stick';

/** A trigger lets go this far under its threshold (no chatter while a finger rests on it). */
export const TRIGGER_HYSTERESIS = 0.06;
/** A stick past this fraction of its throw already counts as all the way (few sticks reach the rim). */
export const STICK_OUTER = 0.95;

/**
 * Raw stick axes (−1..1, y down as the Gamepad API gives them) → a shaped vector (y up, like the world):
 * a radial dead zone (no drift at rest, no square corners), the rest rescaled to 0..1, then `curve`
 * (1 = linear; above 1, finer control near the centre).
 */
export function shapeAxes(x: number, y: number, deadzone: number, curve = 1, out: StickVector = { x: 0, y: 0, mag: 0 }): StickVector {
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
  return out;
}

/** An analog trigger (or any button) held: past `threshold`, and it stays held until it drops a little under it. */
export function triggerHeld(value: number, pressed: boolean, wasHeld: boolean, threshold: number): boolean {
  // digital triggers (some pads, some browsers) report 0 or 1 only, or just `pressed`
  if (pressed && value === 0) return true;
  return value >= (wasHeld ? threshold - TRIGGER_HYSTERESIS : threshold);
}

/** The movement bits a move-stick reading stands for: the touch stick's thresholds; no jet when `stickJet` is off. */
export function moveBits(move: StickVector, stickJet: boolean): number {
  const t: MoveThresholds = stickJet ? MOVE_THRESHOLDS : { ...MOVE_THRESHOLDS, jet: Infinity };
  return moveButtons(move, t);
}

/** Held buttons → the sim's bits (the grenade's is the throw latch's, never held: input.ts ThrowLatch). */
export function heldBits(held: readonly boolean[], map: ButtonMap): number {
  let b = 0;
  for (let i = 0; i < held.length; i++) if (held[i]) b |= map.bits[i] ?? 0;
  return b & ~Btn.Grenade;
}

/** sin 22.5°: an 8-way dash splits the circle into 45° sectors. */
const DASH_SECTOR = Math.sin(Math.PI / 8);

/** The dash's direction bits (8 ways) from the move stick at the press; none (the soldier's facing) when it rests. */
export function dashDirection(move: StickVector): number {
  if (move.mag === 0) return 0;
  const x = move.x / move.mag;
  const y = move.y / move.mag;
  let b = 0;
  if (x <= -DASH_SECTOR) b |= Btn.Left;
  else if (x >= DASH_SECTOR) b |= Btn.Right;
  if (y >= DASH_SECTOR) b |= Btn.Jet;
  else if (y <= -DASH_SECTOR) b |= Btn.Down;
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

/** At aim speed 1 the aim turns at most this far per tick toward the stick (rad; ≈ 21 rad/s, a half turn in 0.15 s). */
export const AIM_TURN = 0.35;

/** The aim one tick on, turning toward where the stick points: `speed` (0.3..2) scales the turn, 2 is at once. */
export function stepAim(current: number, desired: number, speed: number): number {
  if (speed >= 1.95) return desired;
  const d = wrapAngle(desired - current);
  const max = AIM_TURN * speed;
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
