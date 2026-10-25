/**
 * The layout bay's pure parts (board "VOICE + HUD EDITOR · landscape-first", E1–E5), unit-tested:
 * the undo history, which controls overlap, where the picked control's card goes, where the tray of
 * controls off the HUD fits, and the base cards' little drawings.
 */
import { anchorPlacement, PRESETS, REF_BOX, type ControlId, type TouchLayout } from '../layout';
import type { Handed, PresetId, TouchSettings } from '../settings';

/** What the bay can take back: the places, the base (with the settings a base sets) and the hand. */
export interface BaySnapshot {
  layout: TouchLayout;
  preset: PresetId;
  handed: Handed;
  settings: Pick<TouchSettings, 'fire' | 'fireChosen' | 'stickJet' | 'tapFire' | 'leftFire'>;
}

const same = (a: BaySnapshot, b: BaySnapshot): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Undo and redo, one step per finished change (a drop, a pinch, a slider let go, a base, a pin). */
export class BayHistory {
  private readonly past: BaySnapshot[] = [];
  private future: BaySnapshot[] = [];

  constructor(private readonly limit = 50) {}

  /** `before` was the state before a change that is now done (`after`): nothing recorded if they match. */
  record(before: BaySnapshot, after: BaySnapshot): void {
    if (same(before, after)) return;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** The state to go back to (now: the current one, kept for redo); null with nothing to undo. */
  undo(now: BaySnapshot): BaySnapshot | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(now);
    return prev;
  }

  redo(now: BaySnapshot): BaySnapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(now);
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}

/** A control on screen: its centre and radius (px, in the safe box). */
export interface Disc {
  id: ControlId;
  x: number;
  y: number;
  r: number;
}

/**
 * Controls that overlap (E5: both turn red, so a stray thumb can't hit both). A sliver is allowed
 * (`slack` px): the skins' rings reach past their hit circles.
 */
export function overlaps(discs: readonly Disc[], slack = 4): Set<ControlId> {
  const out = new Set<ControlId>();
  for (let i = 0; i < discs.length; i++) {
    for (let j = i + 1; j < discs.length; j++) {
      const a = discs[i]!;
      const b = discs[j]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - slack) {
        out.add(a.id);
        out.add(b.id);
      }
    }
  }
  return out;
}

/**
 * Where the picked control's card goes (E3): beside it, never over it. The side with more room first
 * (left of a control on the right half), centred on it and kept inside the box below the top bar; if
 * neither side fits, above or below it.
 */
export function cardAt(c: { x: number; y: number; r: number }, card: { w: number; h: number }, box: { w: number; h: number }, top = 0, gap = 12): { x: number; y: number } {
  const clampY = (y: number) => Math.min(Math.max(top, y), Math.max(top, box.h - card.h - 4));
  const clampX = (x: number) => Math.min(Math.max(4, x), Math.max(4, box.w - card.w - 4));
  const left = c.x - c.r - gap - card.w;
  const right = c.x + c.r + gap;
  const sides = c.x > box.w / 2 ? [left, right] : [right, left];
  for (const x of sides) if (x >= 4 && x + card.w <= box.w - 4) return { x, y: clampY(c.y - card.h / 2) };
  const above = c.y - c.r - gap - card.h;
  return { x: clampX(c.x - card.w / 2), y: above >= top ? above : clampY(c.y + c.r + gap) };
}

/**
 * The tray of controls off the HUD (E2): the widest free stretch of the bottom band (the lowest
 * `band` px of the box), centred in it. Null when no stretch is `need` px wide.
 */
export function trayAt(discs: readonly Disc[], box: { w: number; h: number }, need: number, band = 56): { x: number; width: number } | null {
  const top = box.h - band;
  const blocked = discs
    .filter((d) => d.y + d.r > top)
    .map((d) => [d.x - d.r, d.x + d.r] as const)
    .sort((a, b) => a[0] - b[0]);
  let best = { from: 0, to: 0 };
  let at = 8;
  for (const [l, r] of blocked) {
    if (l - 8 - at > best.to - best.from) best = { from: at, to: l - 8 };
    at = Math.max(at, r + 8);
  }
  if (box.w - 8 - at > best.to - best.from) best = { from: at, to: box.w - 8 };
  const room = best.to - best.from;
  if (room < need) return null;
  return { x: best.from + (room - need) / 2, width: need };
}

/** What a base shows on its card (E1): the controls it carries, and the context slot. */
const ON_CARD: Readonly<Record<PresetId, readonly ControlId[]>> = {
  classic: ['move', 'aim', 'grenade', 'jet', 'swap', 'reload', 'scores', 'pause', 'take'],
  claw: ['move', 'aim', 'jet', 'dash', 'fire', 'grenade', 'swap', 'scores', 'pause', 'take'],
  oneThumb: ['move', 'dash', 'grenade', 'swap', 'scores', 'pause', 'take'],
};

/** A base's controls as circles in the reference box (fractions: x of its width, y of its height, r of its height). */
export function baseDrawing(preset: PresetId, handed: Handed): { id: ControlId; x: number; y: number; r: number; slot: boolean }[] {
  return ON_CARD[preset].map((id) => {
    const a = PRESETS[preset][id];
    const p = anchorPlacement(a, REF_BOX.w, REF_BOX.h);
    const r = (p.size * Math.min(REF_BOX.w, REF_BOX.h)) / 2 / REF_BOX.h;
    return { id, x: handed === 'left' ? 1 - p.x : p.x, y: p.y, r, slot: id === 'take' };
  });
}

/** How many thumbs (and fingers) a base asks for. */
export const BASE_HANDS: Readonly<Record<PresetId, number>> = { classic: 2, claw: 4, oneThumb: 1 };
