/**
 * Animation level of detail (docs/design/character-feel-research.md §3.8, §5.1 I): how much animation a soldier gets
 * this frame, so a phone with a full room spends its frame on the soldiers you can see.
 * - **Off screen** (more than `margin` outside the view): nothing but the position; the pose waits, and catches up
 *   (with at most 0.1 s of the time it missed) when the soldier comes back on screen.
 * - **Small** (under `minPixels` tall) **or drawn at LOD1** (the Low preset's remote soldiers): the pose every other
 *   frame (30 Hz at 60 fps, with the time owed), and no planted feet (no foot raycasts or leg IK: the feet follow the
 *   clips).
 * - **Everyone else, and always the local player:** everything, every frame.
 */
import type { CharacterLod } from '../character';

export interface AnimDetail {
  /** on screen (with the margin): off screen the body only follows its position */
  readonly visible: boolean;
  /** pose every frame (1) or every other frame (2, with the time owed) */
  readonly every: 1 | 2;
  /** planted feet (FootPlanter's raycasts and leg IK); off, the feet follow the clips */
  readonly planted: boolean;
}

export const ANIM_LOD = {
  /** metres outside the view still posed (a soldier stepping in is already moving) */
  margin: 2,
  /** a soldier this tall on screen (px) or smaller is posed at half rate without planted feet */
  minPixels: 40,
  /** a soldier's height (m), for its size on screen */
  height: 1.25,
} as const;

export const FULL_DETAIL: AnimDetail = { visible: true, every: 1, planted: true };
export const HALF_DETAIL: AnimDetail = { visible: true, every: 2, planted: false };
export const NO_DETAIL: AnimDetail = { visible: false, every: 2, planted: false };

/** The view a soldier is drawn in: the plane camera's centre (m), half extents (m) and the screen band it fills (px). */
export interface LodView {
  readonly x: number;
  readonly y: number;
  readonly halfExtents: { halfW: number; halfH: number };
  readonly band: { top: number; bottom: number };
}

/** How much animation the soldier at (`x`, `y`, its feet) gets. */
export function animDetail(x: number, y: number, local: boolean, lod: CharacterLod, view: LodView): AnimDetail {
  if (local) return FULL_DETAIL;
  const { halfW, halfH } = view.halfExtents;
  const mid = y + ANIM_LOD.height / 2;
  if (Math.abs(x - view.x) > halfW + ANIM_LOD.margin || Math.abs(mid - view.y) > halfH + ANIM_LOD.margin) return NO_DETAIL;
  const pixels = (ANIM_LOD.height / (2 * halfH)) * (view.band.bottom - view.band.top);
  return lod === 1 || pixels < ANIM_LOD.minPixels ? HALF_DETAIL : FULL_DETAIL;
}
