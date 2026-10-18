/**
 * Touch state → the same `Input` the keyboard produces (pure, unit-tested). The controller keeps the
 * state from pointer events; once per sim tick these turn it into buttons, an aim and a throw
 * strength, so the sim, prediction and the wire never know a phone was involved.
 */
import { Btn } from '@military-forge/sim';
import type { FireMode } from './settings';
import { moveButtons, stickAngle, wrapAngle, zeroStick, type StickVector } from './stick';

export type { FireMode } from './settings';

/** Hold-to-fire starts once the aim stick is pushed this far; nearer the centre it only aims. */
export const FIRE_AT = 0.5;

export interface TouchState {
  move: StickVector;
  moveActive: boolean;
  aim: StickVector;
  aimActive: boolean;
  /** buttons held down right now (bits) */
  held: number;
  /** presses since the last sample (bits): taps shorter than a tick, swipe dashes, release-to-fire */
  pulses: number;
  /** direction buttons a pulsed dash goes with (the move stick when it was pressed or swiped) */
  dashDir: number;
  /**
   * the grenade button is held (the throw latch, input.ts): a tap is a quick throw at 70 %; a hold
   * shows the arc, aimed with the right stick (or the button's own drag), whose push sets the
   * strength; lifting throws
   */
  grenadeActive: boolean;
  grenade: StickVector;
}

export function createTouchState(): TouchState {
  return { move: zeroStick(), moveActive: false, aim: zeroStick(), aimActive: false, held: 0, pulses: 0, dashDir: 0, grenadeActive: false, grenade: zeroStick() };
}

/** The buttons this sample: held buttons and pulses, movement from the left stick, fire per mode. */
export function touchButtons(s: TouchState, fire: FireMode): number {
  let b = s.held | s.pulses;
  if (s.moveActive) b |= moveButtons(s.move);
  // aiming a throw with the right stick doesn't fire the gun; the grenade itself goes through the
  // throw latch on release, never held (the sim would throw on the finger going down)
  if (fire === 'hold' && s.aimActive && s.aim.mag >= FIRE_AT && !s.grenadeActive) b |= Btn.Fire;
  // a dash goes the way the stick pointed when it was asked for, even if the thumb has moved on
  if (s.pulses & Btn.Dash) b = (b & ~(Btn.Left | Btn.Right | Btn.Jet | Btn.Down)) | s.dashDir;
  return b;
}

/** Throw strength 0–7 (70–100 %) from a stick's push. */
export function throwStrength(v: StickVector): number {
  return Math.round(Math.min(1, v.mag) * 7);
}

/** The strength a held grenade button throws with: the right stick's push when it's pushed, else the button's own drag. */
export function grenadeStrength(s: TouchState): number {
  return throwStrength(s.aimActive && s.aim.mag > 0 ? s.aim : s.grenade);
}

/** The aim the touch controls ask for this sample (radians), or null to keep the last one. */
export function desiredAim(s: TouchState): number | null {
  if (s.grenadeActive && s.grenade.mag > 0) return stickAngle(s.grenade);
  if (s.aimActive && s.aim.mag > 0) return stickAngle(s.aim);
  return null;
}

export interface AimTarget {
  x: number;
  y: number;
}

/** Aim assist (docs/01 §4: light, optional, touch only). */
export const ASSIST = {
  /** how wide a target counts (m, either side of its centre): a body plus a little slack */
  radius: 0.9,
  /** no assist beyond this (m) */
  range: 40,
  /** while the aim lies on a target, the stick turns it this much of the way per tick */
  slow: 0.45,
};

/** Is the aim from (sx, sy) along `angle` on any target? */
export function aimOnTarget(angle: number, sx: number, sy: number, targets: readonly AimTarget[]): boolean {
  for (const t of targets) {
    const dx = t.x - sx;
    const dy = t.y - sy;
    const d = Math.hypot(dx, dy);
    if (d < 0.5 || d > ASSIST.range) continue;
    if (Math.abs(wrapAngle(angle - Math.atan2(dy, dx))) <= Math.atan2(ASSIST.radius, d)) return true;
  }
  return false;
}

/**
 * Friction, never magnetism: while the current aim lies on a target the stick turns it more slowly,
 * so a thumb sweeping past an enemy lingers on it. It still reaches wherever the stick points (in a
 * few ticks), and it never turns the aim toward anyone.
 */
export function assistAim(current: number, desired: number, sx: number, sy: number, targets: readonly AimTarget[], enabled: boolean): number {
  if (!enabled || !aimOnTarget(current, sx, sy, targets)) return desired;
  return wrapAngle(current + wrapAngle(desired - current) * ASSIST.slow);
}
