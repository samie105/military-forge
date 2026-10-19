/**
 * Spatial navigation (pure, unit-tested): from the focused control's box, the best control in a
 * direction, the way a TV remote moves focus. A candidate must lie beyond the current one in that
 * direction; the nearest wins, and lining up with it (overlapping across the move) counts more than
 * being a little nearer diagonally, so a column of buttons is walked in order and a move right from a
 * tab lands on the row beside it, not on one far below.
 */
import type { NavDir } from './mapping';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How much a gap across the move weighs against a gap along it. */
const CROSS_WEIGHT = 2;
/**
 * A control that doesn't line up with the focus at all (no overlap across the move) loses this much
 * (px): pressing right from a button picks the next one on its row, even past a nearer one a row down.
 */
const OUT_OF_LINE = 400;

/** The gap between two ranges (0 when they overlap). */
const gap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

/** How far `to` lies in `dir` from `from` (lower is better), or null when it isn't that way at all. */
export function navScore(from: Rect, to: Rect, dir: NavDir): number | null {
  // a box round the focus (its panel, its row) is not "that way"
  if (to.left <= from.left && to.top <= from.top && to.right >= from.right && to.bottom >= from.bottom) return null;
  const fcx = (from.left + from.right) / 2;
  const fcy = (from.top + from.bottom) / 2;
  const tcx = (to.left + to.right) / 2;
  const tcy = (to.top + to.bottom) / 2;
  let along: number;
  let cross: number;
  let centre: number;
  switch (dir) {
    case 'right':
      if (tcx <= fcx + 1 || to.right <= from.right) return null;
      along = Math.max(0, to.left - from.right);
      cross = gap(from.top, from.bottom, to.top, to.bottom);
      centre = Math.abs(tcy - fcy);
      break;
    case 'left':
      if (tcx >= fcx - 1 || to.left >= from.left) return null;
      along = Math.max(0, from.left - to.right);
      cross = gap(from.top, from.bottom, to.top, to.bottom);
      centre = Math.abs(tcy - fcy);
      break;
    case 'down':
      if (tcy <= fcy + 1 || to.bottom <= from.bottom) return null;
      along = Math.max(0, to.top - from.bottom);
      cross = gap(from.left, from.right, to.left, to.right);
      centre = Math.abs(tcx - fcx);
      break;
    case 'up':
      if (tcy >= fcy - 1 || to.top >= from.top) return null;
      along = Math.max(0, from.top - to.bottom);
      cross = gap(from.left, from.right, to.left, to.right);
      centre = Math.abs(tcx - fcx);
      break;
  }
  if (cross > 0) {
    // out of line: only when it lies wholly beyond the focus's edge (not a wide box above reaching past it)
    const beyond = dir === 'right' ? to.left >= from.right - 1 : dir === 'left' ? to.right <= from.left + 1 : dir === 'down' ? to.top >= from.bottom - 1 : to.bottom <= from.top + 1;
    if (!beyond) return null;
  }
  return along + CROSS_WEIGHT * cross + (cross > 0 ? OUT_OF_LINE : 0) + 0.05 * centre;
}

/** The index of the best candidate in `dir` from `from`, or −1 when nothing lies that way. */
export function pickNext(from: Rect, candidates: readonly Rect[], dir: NavDir): number {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const s = navScore(from, candidates[i]!, dir);
    if (s !== null && s < bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

/** The first control to focus in a scope: top-left first (reading order), unless one asks to be first. */
export function pickFirst(candidates: readonly Rect[], preferred = -1): number {
  if (preferred >= 0) return preferred;
  let best = -1;
  let bestKey = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i]!;
    const key = Math.round(r.top / 8) * 100000 + r.left;
    if (key < bestKey) {
      bestKey = key;
      best = i;
    }
  }
  return best;
}

/** L1 / R1 in a tab strip: the tab `step` away from the selected one, wrapping round. */
export function nextTab(count: number, selected: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (selected < 0) return step > 0 ? 0 : count - 1;
  return (selected + step + count) % count;
}
