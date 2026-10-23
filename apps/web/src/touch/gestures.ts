/**
 * Touch controls v3 (docs/design/touch-controls-v3.md): what a finger did on a button, pure and
 * unit-tested. The controller feeds it the page's coordinates (ui/landscape.ts: a turned phone too).
 *
 *   grenade   tap: a quick throw · a quick swipe ↑/↓: change type (scrub for more) · hold, then drag: aim, lift: throw
 *   swap      tap or a swipe across: swap · hold: a radial (your two guns and melee), slide and lift to pick
 *   dash      tap: the move stick's way · a swipe: that way (8 directions)
 *   shield    tap: raise or sling · hold: raised while held
 *   camera    two fingers landing on one side: pinch to zoom · a two-finger double tap: recentre
 * Every gesture has its tap, so nobody has to learn one to play.
 */
import { Btn } from '@military-forge/sim';
import { moveButtons } from './stick';

export const GESTURE = {
  /** a finger still down after this long is a hold (the radial, the shield's hold, the grenade's aim) */
  holdMs: 300,
  /** a swipe happens within this long of the finger landing */
  swipeMs: 240,
  /** a finger moving less than this is still (a hold, not a swipe) */
  stillPx: 8,
  /** …and travels at least this far (px, the page's) */
  swipePx: 22,
  /** scrubbing the grenade belt: one type per this much travel (px) */
  stepPx: 30,
  /** the radial's dead centre: lifting inside it picks nothing (px) */
  radialDead: 26,
  /** a pinch: the second finger lands within this long of the first, on the same side */
  pinchMs: 300,
  /** the pinch's ratio of finger distances for one zoom step */
  pinchStep: 1.3,
  /** a two-finger tap: both fingers up within this long, moving less than tapPx */
  twoTapMs: 260,
  tapPx: 18,
  /** two two-finger taps within this long: recentre */
  doubleTapMs: 420,
} as const;

export interface Vec {
  x: number;
  y: number;
}

/** The main direction of a movement (the page's: y grows down). */
export function swipeAxis(dx: number, dy: number): 'up' | 'down' | 'left' | 'right' {
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 'up' : 'down';
  return dx < 0 ? 'left' : 'right';
}

/** A quick swipe: far enough, soon enough. */
export function isQuickSwipe(dx: number, dy: number, ms: number): boolean {
  return ms <= GESTURE.swipeMs && Math.hypot(dx, dy) >= GESTURE.swipePx;
}

/** A dash swipe's direction as the sim's buttons (Left/Right/Jet/Down, 8 ways), like a stick push. */
export function dashButtons(dx: number, dy: number): number {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 0;
  // a stick's y grows up; the page's grows down
  return moveButtons({ x: dx / len, y: -dy / len, mag: 1 });
}

/**
 * Grenade types to step through for a scrub of `dy` px (up: the next types, down: the previous):
 * signed whole steps of GESTURE.stepPx past the swipe's first GESTURE.swipePx.
 */
export function beltSteps(dy: number): number {
  const d = Math.abs(dy);
  if (d < GESTURE.swipePx) return 0;
  return Math.sign(-dy) * (1 + Math.floor((d - GESTURE.swipePx) / GESTURE.stepPx));
}

/**
 * The sim cycles grenades one way only (Btn.CycleGrenade: the next type held). `steps` back or forth
 * over a belt of `held` types is this many presses (0 when there's nothing to change to).
 */
export function cyclePresses(steps: number, held: number): number {
  if (held < 2 || steps === 0) return 0;
  return (((steps % held) + held) % held);
}

/** The types the belt holds, in the sim's cycle order, and where the selected one sits in it. */
export function beltOf(counts: readonly number[] | undefined, selected: number): { types: number[]; at: number } {
  const types = (counts ?? []).map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
  return { types, at: Math.max(0, types.indexOf(selected)) };
}

/** The selected type after `steps` (the fan's preview of where a scrub will land). */
export function beltAfter(types: readonly number[], at: number, steps: number): number {
  if (!types.length) return -1;
  return types[(((at + steps) % types.length) + types.length) % types.length]!;
}

/** A radial choice: its direction from the control's centre (radians, the page's: 0 = right, π/2 = down). */
export interface RadialChoice {
  angle: number;
}

/** The choice a finger at (dx, dy) from the centre points at, or −1 inside the dead centre. */
export function radialPick(dx: number, dy: number, choices: readonly RadialChoice[], dead: number = GESTURE.radialDead): number {
  if (Math.hypot(dx, dy) < dead || !choices.length) return -1;
  const a = Math.atan2(dy, dx);
  let best = -1;
  let bestD = Infinity;
  choices.forEach((c, i) => {
    const d = Math.abs(Math.atan2(Math.sin(a - c.angle), Math.cos(a - c.angle)));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * The radial choice nearest a finger at `at`, once it's left the dead zone round the centre (`dead`
 * px: the pill's own half-height at least); −1 inside it. `spots`: where each choice is drawn.
 */
export function nearestPick(at: Vec, centre: Vec, spots: readonly Vec[], dead: number = GESTURE.radialDead): number {
  if (Math.hypot(at.x - centre.x, at.y - centre.y) < dead) return -1;
  let best = -1;
  let bestD = Infinity;
  spots.forEach((p, i) => {
    const d = Math.hypot(at.x - p.x, at.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Where the radial's choices sit round a pill `halfW` × `halfH` (px): clear of it, on an ellipse. */
export function radialSpots(centre: Vec, choices: readonly RadialChoice[], halfW: number, halfH: number, gap = 60): Vec[] {
  return choices.map((c) => ({ x: centre.x + Math.cos(c.angle) * (halfW + gap), y: centre.y + Math.sin(c.angle) * (halfH + gap) }));
}

/**
 * The swap radial's three choices fanned away from the screen edge the pill sits at: opening down
 * and in from a pill at the top right (the default), mirrored for one at the left, up for one low.
 */
export function radialAngles(cx: number, cy: number, w: number, h: number): RadialChoice[] {
  const down = cy < h / 2;
  const left = cx > w / 2;
  const base = down ? (left ? (3 * Math.PI) / 4 : Math.PI / 4) : left ? (-3 * Math.PI) / 4 : -Math.PI / 4;
  const spread = Math.PI / 4;
  return [-1, 0, 1].map((k) => ({ angle: base + k * spread }));
}

/** A pinch's zoom steps so far: +1 per GESTURE.pinchStep apart (fingers spreading: in, closer = −1 level). */
export function pinchSteps(startDist: number, dist: number): number {
  if (!(startDist > 0) || !(dist > 0)) return 0;
  const r = Math.log(dist / startDist) / Math.log(GESTURE.pinchStep);
  return r >= 0 ? Math.floor(r) : -Math.floor(-r);
}

/** The buttons a shield press stands for: always the toggle (Btn.Shield); a hold sends a second one on release. */
export const SHIELD_TOGGLE = (Btn as Record<string, number>).Shield ?? 0;
