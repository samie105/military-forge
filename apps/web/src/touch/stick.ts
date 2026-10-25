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

/**
 * The phone's sticks (docs/design/controls-research.md §4.3): a dead zone of 8 % of the radius, full
 * at 90 %, linear. The thresholds below are fractions of that shaped push (a 66–68 px radius: run at
 * 16 px, jet at 30 px straight up, crouch at 38 px, Pull fires at 27 px).
 */
export const MOVE_STICK: StickShape = { deadZone: 0.08, outer: 0.9, curve: 1 };
/** Aiming: the direction is what counts; the push decides when Pull fires (FIRE_ON in mapping.ts). */
export const AIM_STICK: StickShape = { deadZone: 0.08, outer: 0.9, curve: 1 };
/**
 * Fixed sticks (settings.sticks 'fixed', the default since the owner's phone report of 25 Oct): the
 * stick stays where it's drawn and reads the thumb from its drawn centre, so the landing itself is a
 * push. A thumb meaning "rest here" lands within a couple of mm of the centre, never on it, so the dead
 * zones are wider than the floating sticks' (whose centre is wherever the thumb landed), and both are
 * full a little sooner (the thumb starts off-centre and the knob is held at the rim). Linear: the aim
 * only reads the direction, and the move thresholds (TOUCH_MOVE) are the place to tune feel. On a 66 px
 * stick:
 * - move: dead zone 8 px (0.12), run at 18 px, jet at 30 px straight up, crouch at 37 px down;
 * - aim: dead zone 10 px (0.15), the aim follows from 17 px (AIM_MIN), Pull fires from 36 px and stops
 *   under 30 px (mapping.ts FIRE_FIXED), Auto's rim at 51 px.
 */
export const MOVE_FIXED: StickShape = { deadZone: 0.12, outer: 0.85, curve: 1 };
export const AIM_FIXED: StickShape = { deadZone: 0.15, outer: 0.85, curve: 1 };

/**
 * A fixed stick grabs a thumb landing within this many radii of its drawn centre (a thumb a little off
 * the ring still means the stick: 1.6 is 6–7 mm of slack outside a 22 mm dial). Further out on its half
 * of the screen, the stick reads the drag from where the thumb landed instead (it still doesn't move):
 * a thumb that missed by a lot says nothing by where it landed, only by how it drags.
 */
export const FIXED_GRAB = 1.6;

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

/**
 * The touch move stick's thresholds (§4.3), each with a lower line to stop at, so a thumb resting on
 * a line doesn't flicker: run at |x| 0.20 (stops under 0.14); jet when the stick points within
 * 45°–135° and is pushed 0.45 (keeps jetting while it stays within 15°–165° and above 0.30); crouch
 * within ±30° of straight down at 0.60 (stops under 0.45). A full push runs within ±78° of pure left
 * or right, so up-right is jet and run once jetting.
 */
export const TOUCH_MOVE = {
  runOn: 0.2,
  runOff: 0.14,
  jetOn: 0.45,
  jetOff: 0.3,
  /** the jet's starting cone and the wider one it keeps going in (degrees above horizontal, 0–180) */
  jetCone: [45, 135] as const,
  jetKeep: [15, 165] as const,
  downOn: 0.6,
  downOff: 0.45,
  /** crouch starts within this many degrees of straight down */
  downCone: 30,
} as const;

/** The touch move stick's buttons this reading stands for, given the last ones (`prev`): §4.3's thresholds with hysteresis. */
export function touchMoveButtons(v: StickVector, prev: number, t = TOUCH_MOVE): number {
  let b = 0;
  // run: a side once started holds down to runOff; the other side needs runOn
  if (prev & Btn.Left ? v.x <= -t.runOff : v.x <= -t.runOn) b |= Btn.Left;
  else if (prev & Btn.Right ? v.x >= t.runOff : v.x >= t.runOn) b |= Btn.Right;
  const deg = (Math.atan2(v.y, v.x) * 180) / Math.PI; // 90 = straight up, −90 = straight down
  const jetting = prev & Btn.Jet ? v.mag >= t.jetOff && deg >= t.jetKeep[0] && deg <= t.jetKeep[1] : v.mag >= t.jetOn && deg >= t.jetCone[0] && deg <= t.jetCone[1];
  if (jetting) b |= Btn.Jet;
  else if (prev & Btn.Down ? v.mag >= t.downOff && v.y < 0 : v.mag >= t.downOn && Math.abs(deg + 90) <= t.downCone) b |= Btn.Down;
  return b;
}

/** A stick's origin follows a thumb that goes past this many radii (dynamic follow, §4.3). */
export const STICK_FOLLOW = 1.2;

/**
 * Dynamic follow: when the thumb is further than STICK_FOLLOW radii from the origin, the origin slides
 * after it so the thumb stays at that distance, and reversing costs the same travel as starting from
 * the centre. Returns the origin to use.
 */
export function followOrigin(ox: number, oy: number, x: number, y: number, radius: number): { x: number; y: number } {
  const dx = x - ox;
  const dy = y - oy;
  const len = Math.hypot(dx, dy);
  const reach = STICK_FOLLOW * radius;
  if (len <= reach) return { x: ox, y: oy };
  const k = (len - reach) / len;
  return { x: ox + dx * k, y: oy + dy * k };
}

/**
 * A flick to dash on the move stick (§4.6), not a nudge: lifted within 180 ms of landing, pushed to
 * 0.85 or more, reaching that push within 90 ms of setting off from under 0.3, and still moving
 * outward at the lift (0.4 px/ms over the last 32 ms or more). A thumb that pushes, stops and lifts
 * doesn't dash.
 */
export const FLICK = { maxMs: 180, minPeak: 0.85, riseMs: 90, outPxPerMs: 0.4, windowMs: 32 } as const;

export interface FlickStroke {
  /** landing to lift (ms) */
  durationMs: number;
  /** the stroke's peak push */
  peak: number;
  /** from the last moment under 0.3 to the peak (ms) */
  riseMs: number;
  /** the thumb's speed away from the origin over the last FLICK.windowMs or more before the lift (px/ms) */
  outSpeed: number;
}

export function isFlick(f: FlickStroke): boolean {
  return f.durationMs <= FLICK.maxMs && f.peak >= FLICK.minPeak && f.riseMs <= FLICK.riseMs && f.outSpeed >= FLICK.outPxPerMs;
}

/**
 * A flick to dash on a fixed move stick. Its centre isn't under the thumb, so the push says little (a
 * thumb landing at the rim is at full push before it moves): the flick is measured from where the
 * thumb landed. Lifted within 220 ms of landing, 0.6 radii (40 px, 6.5 mm) or more from the landing,
 * and still moving that way at the lift (0.4 px/ms over the last 32 ms or more). Its direction is the
 * swipe's (landing → lift), not the stick's push: a thumb that lands left of centre and flicks right
 * dashes right. Floating sticks keep FLICK (180 ms, 0.85 of the push): the fixed one's window is a
 * little longer because the owner found the dash hard to pull off.
 */
export const FIXED_FLICK = { maxMs: 220, minTravel: 0.6, outPxPerMs: 0.4, windowMs: 32 } as const;

export interface SwipeStroke {
  /** landing to lift (ms) */
  durationMs: number;
  /** landing to lift, in stick radii */
  travel: number;
  /** the thumb's speed along the swipe (landing → lift) over the last FIXED_FLICK.windowMs or more (px/ms) */
  outSpeed: number;
}

export function isFixedFlick(f: SwipeStroke): boolean {
  return f.durationMs <= FIXED_FLICK.maxMs && f.travel >= FIXED_FLICK.minTravel && f.outSpeed >= FIXED_FLICK.outPxPerMs;
}

/** Movement buttons (Left/Right/Jet/Down) a stick reading stands for (the pad's; the touch stick uses touchMoveButtons). */
export function moveButtons(v: StickVector, t: MoveThresholds = MOVE_THRESHOLDS): number {
  let b = 0;
  if (v.x <= -t.x) b |= Btn.Left;
  else if (v.x >= t.x) b |= Btn.Right;
  if (v.y >= t.jet) b |= Btn.Jet;
  else if (v.y <= -t.down) b |= Btn.Down;
  return b;
}


/** Shortest signed difference a − b, in (−π, π]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t <= 0 ? t + 2 * Math.PI : t) - Math.PI;
}
