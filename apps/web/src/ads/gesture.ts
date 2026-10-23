/**
 * The tap-to-save gestures, one per device, chosen so a save can never fire a gun and a shot can
 * never save an ad (the owner: "so we don't just interrupt their gaming"):
 *
 * - **Mouse and keyboard:** point at a lit billboard and press the interact key (E unless rebound),
 *   or middle-click it. Neither is a gun button. The key saves only when it does nothing else there:
 *   with a gun underfoot, E takes the gun (the sim's) and saves nothing. Middle-click saves only
 *   while mouse 3 isn't bound to an action.
 * - **Touch:** a quick, still tap on a lit billboard (≤ 250 ms, ≤ 6 px), one finger, not on a control.
 *   The touch layer still sees it as a stick touch at rest, which moves and fires nothing; if any shot
 *   went out between the finger landing and just after the lift (auto-fire, release-to-fire), the tap
 *   saves nothing.
 * - **Controller:** aim the reticle at a lit billboard and tap the View / Share / − button (the
 *   scoreboard's, whose tap already means "the thing on screen"). Not while it opens an on-screen
 *   prompt (the warm-up's Ready), and not when a second tap follows (a double tap opens the big map).
 * - **Every device:** never while a fire button is held or a shot went out during the gesture, never
 *   in the menus, at most one save every SAVE_GAP_MS.
 */
import { Btn } from '@military-forge/sim';
import type { KeyBindings } from '../input';

/** a tap lifts within this (ms) … */
export const TAP_MAX_MS = 250;
/** … and moves at most this far (CSS px): inside the aim stick's dead zone at its usual sizes */
export const TAP_SLOP_PX = 6;
/** a second finger landing this soon before or during a tap makes it a camera gesture, not a save */
export const MULTI_MS = 300;
/** after a tap's lift, wait this long for the samples to show whether it fired (ms) */
export const FIRE_SETTLE_MS = 90;
/** at most one save this often (ms) */
export const SAVE_GAP_MS = 700;
/** the pad's tap: let go within this (ms; gamepad/manager.ts SELECT_TAP_MS) */
export const PAD_TAP_MS = 250;

/** The gun's buttons: none of them ever saves, and a save never happens while they're in use. */
export const FIRE_BITS = Btn.Fire | Btn.Fire2;

/** The key is the interact key and nothing else (its press then does nothing to the gun). */
export function keySaves(code: string, bindings: Pick<KeyBindings, 'keys'>): boolean {
  return (bindings.keys[code] ?? 0) === Btn.Interact;
}

/** A middle-click, while mouse 3 isn't bound to anything. */
export function middleClickSaves(button: number, bindings: Pick<KeyBindings, 'mouse'>): boolean {
  return button === 1 && !bindings.mouse[1];
}

/** When the last sampled input carried a gun button: a save's guard against firing. */
export class FireLog {
  private last = -Infinity;
  /** the last sample's gun buttons were down */
  held = false;

  /** One sampled input (the sim's, after keyboard, touch and pad are all in). */
  note(buttons: number, now: number): void {
    this.held = (buttons & FIRE_BITS) !== 0;
    if (this.held) this.last = now;
  }

  /** A shot was asked for at or after `t` (ms). */
  firedSince(t: number): boolean {
    return this.last >= t;
  }
}

interface Track {
  x: number;
  y: number;
  at: number;
  eligible: boolean;
}

/** A tap that may save, at (x, y) in page px, decided once the samples after it are in. */
export interface Tap {
  x: number;
  y: number;
  downAt: number;
  upAt: number;
}

/** Finger and pen taps: only a quick, still, single-finger tap off the controls counts. */
export class TapTracker {
  private readonly downs = new Map<number, Track>();

  /** A finger landed. `eligible`: on the game itself, not on a control or a button. */
  down(id: number, x: number, y: number, at: number, eligible: boolean): void {
    // a second finger: the camera's pinch or two-finger tap, never a save (both fingers)
    let multi = false;
    for (const t of this.downs.values()) {
      if (at - t.at <= MULTI_MS) {
        t.eligible = false;
        multi = true;
      }
    }
    this.downs.set(id, { x, y, at, eligible: eligible && !multi });
  }

  move(id: number, x: number, y: number): void {
    const t = this.downs.get(id);
    if (t && Math.hypot(x - t.x, y - t.y) > TAP_SLOP_PX) t.eligible = false;
  }

  /** The finger lifted: the tap, if it was one. */
  up(id: number, x: number, y: number, at: number): Tap | null {
    const t = this.downs.get(id);
    this.downs.delete(id);
    if (!t || !t.eligible || at - t.at > TAP_MAX_MS || Math.hypot(x - t.x, y - t.y) > TAP_SLOP_PX) return null;
    return { x: t.x, y: t.y, downAt: t.at, upAt: at };
  }

  cancel(id: number): void {
    this.downs.delete(id);
  }

  clear(): void {
    this.downs.clear();
  }
}

/** A gesture waiting to see whether a shot went with it. */
export interface Pending {
  x: number;
  y: number;
  /** when the gesture started (shots from then on cancel it) */
  since: number;
  /** decide at */
  at: number;
}

/**
 * Decides a waiting gesture at `now`: 'wait', 'drop' (a shot went out with it, or it's too soon after
 * the last save) or 'save'.
 */
export function decide(p: Pending, now: number, fire: FireLog, lastSaveAt: number): 'wait' | 'drop' | 'save' {
  if (fire.firedSince(p.since)) return 'drop';
  if (now < p.at) return 'wait';
  if (now - lastSaveAt < SAVE_GAP_MS) return 'drop';
  return 'save';
}

/** The pad's tap on a button: pressed, then let go within PAD_TAP_MS. */
export class PadTap {
  private downAt = -1;

  /** One poll: whether the button is held now. A tap returns its press time on the poll it ends. */
  poll(held: boolean, now: number): number | null {
    if (held) {
      if (this.downAt < 0) this.downAt = now;
      return null;
    }
    const at = this.downAt;
    this.downAt = -1;
    return at >= 0 && now - at <= PAD_TAP_MS ? at : null;
  }
}
