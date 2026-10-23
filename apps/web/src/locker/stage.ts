/**
 * The creator and Locker stage's craft (docs/design/character-feel-research.md §3.12, §5.1 H): pure pieces the
 * Turntable uses, kept apart so they can be tested without WebGL.
 * - **Shots:** a camera framing per look tab and per slot (head and shoulders for hair and headwear, waist up for the
 *   outfit, the whole body a little lower for trousers and boots, from behind for the jetpack and its exhaust), eased
 *   over 450 ms.
 * - **Equip reactions:** a short one-shot per slot when something changes (adjust the helmet, flex the gloves, stamp a
 *   boot, shrug the jetpack, look down at a sleeve), an envelope over procedural poses.
 * - **When to draw:** render on demand (dragging, easing, reacting, the idle), at most 30 fps idle on a phone, and
 *   not at all a few seconds after the last input under Reduce motion.
 */
import type { LoadoutSlot } from '@military-forge/content';

/** A camera framing: the point looked at (m up), the distance (m) and the turntable's yaw (rad; null: as it is). */
export interface Shot {
  y: number;
  distance: number;
  yaw: number | null;
}

const DEG = Math.PI / 180;

export const SHOTS = {
  full: { y: 0.9, distance: 4.2, yaw: null },
  face: { y: 1.18, distance: 1.8, yaw: 0.25 },
  jetpack: { y: 0.8, distance: 2.6, yaw: Math.PI * 0.85 },
  /** the whole body from the front (a tab with no closer shot) */
  front: { y: 0.9, distance: 4.2, yaw: 0.35 },
  /** head and shoulders, turned 20° */
  head: { y: 1.12, distance: 1.9, yaw: 20 * DEG },
  /** waist up */
  waist: { y: 1.05, distance: 3.3, yaw: 25 * DEG },
  /** the whole body, the camera 0.35 m lower */
  legs: { y: 0.5, distance: 3.6, yaw: 25 * DEG },
  /** from behind at 150° */
  back: { y: 1.05, distance: 3.8, yaw: 150 * DEG },
} as const satisfies Record<string, Shot>;
export type ShotName = keyof typeof SHOTS;

/** The shot for a slot (a creator tab's or the slot that just changed). */
export function shotForSlot(slot: LoadoutSlot | string): ShotName {
  switch (slot) {
    case 'hair':
    case 'headgear':
    case 'eyewear':
      return 'head';
    case 'top':
    case 'jacket':
    case 'gloves':
    case 'accessory':
      return 'waist';
    case 'legs':
    case 'boots':
      return 'legs';
    case 'jetpack':
    case 'exhaust':
    case 'trail':
      return 'back';
    default:
      return 'front';
  }
}

/** The shot for a creator look tab (creator/model.ts TABS ids). */
export function shotForTab(tab: string): ShotName {
  return tab === 'hair' || tab === 'head' ? 'head' : tab === 'outfit' ? 'waist' : tab === 'gear' ? 'back' : 'front';
}

/** The camera moves between shots over this long (s), on the UI's travel ease (--ease-travel: cubic in-out). */
export const SHOT_SECONDS = 0.45;

export function easeTravel(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// ------------------------------------------------------------------ equip reactions

export type Reaction = 'helmet' | 'gloves' | 'stamp' | 'shrug' | 'sleeve' | 'legs' | 'proud';

/** The reaction a change to `slot` plays. */
export function reactionFor(slot: LoadoutSlot | string): Reaction {
  switch (slot) {
    case 'hair':
    case 'headgear':
    case 'eyewear':
      return 'helmet';
    case 'gloves':
      return 'gloves';
    case 'boots':
      return 'stamp';
    case 'jetpack':
    case 'exhaust':
    case 'trail':
      return 'shrug';
    case 'top':
    case 'jacket':
    case 'accessory':
      return 'sleeve';
    case 'legs':
      return 'legs';
    default:
      return 'proud';
  }
}

/** How long each reaction plays (s): 0.6–1.0 s. */
export const REACTION_SECONDS: Record<Reaction, number> = { helmet: 0.9, gloves: 0.8, stamp: 0.7, shrug: 0.8, sleeve: 1.0, legs: 0.8, proud: 0.7 };

/** A reaction's weight at `t` s of `seconds`: in, hold, out (smooth at both ends). */
export function reactionWeight(t: number, seconds: number): number {
  if (!(t >= 0) || t >= seconds) return 0;
  const u = t / seconds;
  const s = (x: number) => x * x * (3 - 2 * x);
  return u < 0.3 ? s(u / 0.3) : u > 0.7 ? s((1 - u) / 0.3) : 1;
}

/** The slots whose items differ between two looks. */
export function changedSlots(a: { items: Record<string, string>; dyes: Record<string, string> } | null, b: { items: Record<string, string>; dyes: Record<string, string> }): string[] {
  if (!a) return [];
  const out = Object.keys(b.items).filter((k) => a.items[k] !== b.items[k]);
  if (Object.keys(b.dyes).some((k) => a.dyes[k] !== b.dyes[k])) out.push('dyes');
  return out;
}

// ------------------------------------------------------------------ when to draw

export interface DrawPolicy {
  /** a phone or tablet: the idle draws at most this often (fps) */
  touchIdleFps: number;
  /** under Reduce motion, the stage stops drawing this long (s) after the last input */
  reducedRestSeconds: number;
}

export const DRAW: DrawPolicy = { touchIdleFps: 30, reducedRestSeconds: 3 };

/**
 * Whether to draw this frame: always while something moves on purpose (dragging, a camera move, a reaction, a look
 * change); otherwise the idle, at most `touchIdleFps` on a phone, and under Reduce motion only for a few seconds
 * after the last input.
 */
export function shouldDraw(now: number, lastDraw: number, busyUntil: number, touch: boolean, reduced: boolean, policy: DrawPolicy = DRAW): boolean {
  if (now < busyUntil) return true;
  if (reduced) return now < busyUntil + policy.reducedRestSeconds;
  if (touch) return now - lastDraw >= 1 / policy.touchIdleFps - 1e-3;
  return true;
}
