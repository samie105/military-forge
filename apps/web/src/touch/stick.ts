/**
 * Thumb-stick maths (pure, unit-tested): dead zone, response curve, saturation, and the
 * movement buttons a stick position stands for. Screen offsets come in with y down; vectors go out
 * with y up, like the world (docs/02 §3).
 */
import { Btn } from '@military-forge/sim';

/** A shaped stick reading: direction scaled by `mag`, 0 inside the dead zone, 1 at saturation. */
export interface StickVector {
  x: number;
  y: number;
  mag: number;
}

export interface StickShape {
  /** fraction of the radius ignored around the centre (resting thumbs wobble) */
  deadZone: number;
  /** fraction of the radius that already counts as full deflection (thumbs rarely reach the rim) */
  outer: number;
  /** response exponent: 1 = linear, > 1 = finer control near the centre */
  curve: number;
}

/** Moving: a quick, even response; the sim only needs left/right/jet/down anyway. */
export const MOVE_STICK: StickShape = { deadZone: 0.15, outer: 0.9, curve: 1 };
/** Aiming: the direction is what counts; the magnitude decides when hold-to-fire starts. */
export const AIM_STICK: StickShape = { deadZone: 0.12, outer: 0.85, curve: 1.4 };
/** The grenade button doubles as a small stick: direction = aim, distance = throw strength. */
export const GRENADE_STICK: StickShape = { deadZone: 0.25, outer: 1, curve: 1 };

export function zeroStick(): StickVector {
  return { x: 0, y: 0, mag: 0 };
}

/** Finger offset (px, screen axes) from the stick centre → a shaped vector (y up). */
export function shapeStick(dx: number, dy: number, radius: number, shape: StickShape, out: StickVector = zeroStick()): StickVector {
  const len = Math.hypot(dx, dy);
  const r = len / Math.max(1e-6, radius);
  const t = (r - shape.deadZone) / Math.max(1e-6, shape.outer - shape.deadZone);
  if (t <= 0 || len === 0) {
    out.x = 0;
    out.y = 0;
    out.mag = 0;
    return out;
  }
  const mag = Math.min(1, t) ** shape.curve;
  out.x = (dx / len) * mag;
  out.y = (-dy / len) * mag;
  out.mag = mag;
  return out;
}

/** Where to draw the knob (px from the centre): under the finger, held at the rim. */
export function knobOffset(dx: number, dy: number, radius: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len <= radius || len === 0) return { x: dx, y: dy };
  return { x: (dx / len) * radius, y: (dy / len) * radius };
}

/** World aim angle (radians, counter-clockwise from +x) a stick vector points along. */
export function stickAngle(v: StickVector): number {
  return Math.atan2(v.y, v.x);
}

export interface MoveThresholds {
  /** |x| from which the stick walks left/right */
  x: number;
  /** y from which it jets */
  jet: number;
  /** −y from which it crouches (and drops through one-way platforms) */
  down: number;
}

/**
 * Push past 30 % sideways to walk, half-way up to jet, 60 % down to crouch: a thumb that only
 * means "run right" can wander ±30° without jetting or crouching, and up-right is jet + right.
 */
export const MOVE_THRESHOLDS: MoveThresholds = { x: 0.3, jet: 0.5, down: 0.6 };

/** Movement buttons (Left/Right/Jet/Down) a left-stick reading stands for. */
export function moveButtons(v: StickVector, t: MoveThresholds = MOVE_THRESHOLDS): number {
  let b = 0;
  if (v.x <= -t.x) b |= Btn.Left;
  else if (v.x >= t.x) b |= Btn.Right;
  if (v.y >= t.jet) b |= Btn.Jet;
  else if (v.y <= -t.down) b |= Btn.Down;
  return b;
}

/** A quick stroke and lift on the move stick dashes that way (docs/02 §21): not a held run. */
export const SWIPE = { maxMs: 220, minMag: 0.75 };

export function isSwipe(durationMs: number, peakMag: number): boolean {
  return durationMs <= SWIPE.maxMs && peakMag >= SWIPE.minMag;
}

/** Shortest signed difference a − b, in (−π, π]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t <= 0 ? t + 2 * Math.PI : t) - Math.PI;
}
