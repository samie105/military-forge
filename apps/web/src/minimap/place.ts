/**
 * Where a phone's minimap goes: the top-left of the safe box, unless a touch control is there (a
 * player's own layout, the left FIRE…); then lower down, or smaller. Pure, unit-tested.
 */

/** the phone design's screen (px) and its safe box's top-left inset (touch/layout.ts SAFE_INSETS) */
export const PHONE = { w: 812, h: 375, safeL: 44, safeT: 10 } as const;
/** the header's height (design px) */
export const HEAD = { desk: 26, phone: 16 } as const;
/** phone sizes (design px) and where they may sit, tried in order until one is clear of the controls */
const PHONE_SIZES = [
  { w: 176, maxH: 72 },
  { w: 132, maxH: 46 },
] as const;
const PHONE_SLOTS = [
  { x: PHONE.safeL + 8, y: PHONE.safeT + 6 },
  // on the top bar, right of the 🏆 scores button (the top-left one is the scores button's own, in
  // the default layout): a short screen (the browser's bars showing) has no room lower down (the
  // mobile audit, P1-10)
  { x: PHONE.safeL + 58, y: PHONE.safeT + 2 },
  { x: PHONE.safeL + 8, y: PHONE.safeT + 132 },
] as const;
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The overlap area of two rects (px²). */
function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The minimap's width for a height: the level's aspect fills the box (between `min` and `max`). */
export function widthFor(h: number, head: number, aspect: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, (h - head - 6) * aspect + 10)));
}

/**
 * Where a phone's minimap goes (design px): the first size and slot clear of every control rect
 * (also design px, a margin added), else the one that covers the least of them. The width follows
 * the level's shape, so a tall map gets a narrower box. Pure.
 */
export function phonePlace(controls: readonly Box[], aspect: number, margin = 6): { x: number; y: number; w: number; h: number } {
  let best: { x: number; y: number; w: number; h: number } | null = null;
  let bestCover = Infinity;
  for (const size of PHONE_SIZES) {
    const h = size.maxH;
    const w = widthFor(h, HEAD.phone, aspect, 96, size.w);
    for (const slot of PHONE_SLOTS) {
      const box = { left: slot.x - margin, top: slot.y - margin, right: slot.x + w + margin, bottom: slot.y + h + margin };
      let cover = 0;
      for (const c of controls) cover += overlapArea(box, c);
      if (cover === 0) return { x: slot.x, y: slot.y, w, h };
      if (cover < bestCover) {
        bestCover = cover;
        best = { x: slot.x, y: slot.y, w, h };
      }
    }
  }
  return best!;
}

/** a phone's big map at most: between the move dial and the right-hand buttons, under the clock */
export const BIG_PHONE = { x: 202, y: 60, w: 336, h: 190 } as const;
/** the big map never gets smaller than this (design px) */
const BIG_PHONE_MIN = { w: 220, h: 120 } as const;

/**
 * A phone's big map (design px): BIG_PHONE, its bottom raised above any control under it and its
 * right edge pulled in from any control beside it (a player's own layout, the context slot), so it
 * covers no control. Pure.
 */
export function bigPhonePlace(controls: readonly Box[], margin = 6): { x: number; y: number; w: number; h: number } {
  let right = BIG_PHONE.x + BIG_PHONE.w;
  let bottom = BIG_PHONE.y + BIG_PHONE.h;
  for (const c of controls) {
    if (!(c.left < right + margin && c.right > BIG_PHONE.x - margin && c.top < bottom + margin && c.bottom > BIG_PHONE.y - margin)) continue;
    // a control low down raises the bottom; one high up (or one the bottom can't clear) pulls the right edge in
    if (c.top - margin - BIG_PHONE.y >= BIG_PHONE_MIN.h) bottom = Math.min(bottom, c.top - margin);
    else if (c.left - margin - BIG_PHONE.x >= BIG_PHONE_MIN.w) right = Math.min(right, c.left - margin);
  }
  return { x: BIG_PHONE.x, y: BIG_PHONE.y, w: right - BIG_PHONE.x, h: bottom - BIG_PHONE.y };
}

/** A tap away from the big map closes it (the owner, 24 Oct 2026: "tapping outside should close the map"): quick and still, so a thumb working a dial never does. */
export const TAP_AWAY_MS = 300;
export const TAP_AWAY_SLOP_PX = 12;

export interface TouchMark {
  x: number;
  y: number;
  t: number;
}

/** Whether a press and its release outside the big map were a tap (close it), not a hold or a drag. */
export function isTapAway(down: TouchMark, up: TouchMark): boolean {
  return up.t - down.t <= TAP_AWAY_MS && Math.hypot(up.x - down.x, up.y - down.y) <= TAP_AWAY_SLOP_PX;
}
