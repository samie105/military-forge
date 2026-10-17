/**
 * Area of interest (docs/05 §9): the most of the map a client's camera can show, plus a margin.
 * Snapshots only carry players and grenades inside it, so zoom hacks and off-screen ESP get
 * nothing; gunfire and blasts outside it arrive as coarse SOUND events.
 *
 * The camera model is defined here and imported by the web camera (apps/web/src/camera.ts), so
 * the server's idea of "what you can see" can't drift from what's drawn. The web camera never
 * shows more than 4:3 of the view width (taller screens are letterboxed; apps/web/test/camera.test.ts
 * sweeps it). A renderer that shows more than this (wider zoom, taller than 4:3, bigger
 * look-ahead) will see players pop in.
 */
import { NO_WEAPON, weapons, type MapDef } from '@military-forge/content';
import type { ViewRect } from '@military-forge/protocol';
import type { PlayerState } from '@military-forge/sim';

/** visible width in metres at zoom level 0 */
export const VIEW_BASE_WIDTH = 36;
/** width multiplier per zoom level (a weapon's zoomMax = how many levels it allows) */
export const VIEW_ZOOM_MULTIPLIERS: readonly number[] = [1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.3];
/** camera look-ahead toward the reticle, as a fraction of the half view */
export const VIEW_LOOKAHEAD = 0.35;
/** the camera centres this far above the feet */
export const VIEW_FOCUS_Y = 0.9;
/** tallest screen shape served (height / width): 4:3 */
export const VIEW_MAX_ASPECT = 0.75;
/** slack beyond the camera (docs/05 §9) */
export const AOI_MARGIN = 6;
/** seconds of movement covered beyond the camera: the next snapshot plus the camera's spring lag */
export const AOI_VELOCITY_LOOKAHEAD = 0.25;

/** Zoom levels the player's weapons allow (the widest of the two slots: no pop-in on swap). */
export function maxZoomLevels(p: PlayerState): number {
  let levels = 1;
  for (const slot of p.weapons) if (slot.def !== NO_WEAPON) levels = Math.max(levels, weapons[slot.def]?.zoomMax ?? 1);
  return Math.min(levels, VIEW_ZOOM_MULTIPLIERS.length);
}

export function viewWidth(zoomLevel: number): number {
  return VIEW_BASE_WIDTH * VIEW_ZOOM_MULTIPLIERS[Math.max(0, Math.min(VIEW_ZOOM_MULTIPLIERS.length - 1, zoomLevel))]!;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Everything `p`'s camera could show this tick (any look-ahead, max zoom), plus the margin. */
export function aoiRect(p: PlayerState, map: MapDef, out: ViewRect): ViewRect {
  const halfW = viewWidth(maxZoomLevels(p) - 1) / 2;
  const halfH = halfW * VIEW_MAX_ASPECT;
  const b = map.bounds;
  // the camera centre's range: the focus ± look-ahead, clamped to the map like the client's camera
  const fx = p.x;
  const fy = p.y + VIEW_FOCUS_Y;
  const cx0 = clamp(fx - halfW * VIEW_LOOKAHEAD, b.minX + halfW, b.maxX - halfW);
  const cx1 = clamp(fx + halfW * VIEW_LOOKAHEAD, b.minX + halfW, b.maxX - halfW);
  const cy0 = clamp(fy - halfH * VIEW_LOOKAHEAD, b.minY + halfH, b.maxY - halfH);
  const cy1 = clamp(fy + halfH * VIEW_LOOKAHEAD, b.minY + halfH, b.maxY - halfH);
  const mx = AOI_MARGIN + Math.abs(p.vx) * AOI_VELOCITY_LOOKAHEAD;
  const my = AOI_MARGIN + Math.abs(p.vy) * AOI_VELOCITY_LOOKAHEAD;
  out.minX = Math.min(cx0, cx1) - halfW - mx;
  out.maxX = Math.max(cx0, cx1) + halfW + mx;
  out.minY = Math.min(cy0, cy1) - halfH - my;
  out.maxY = Math.max(cy0, cy1) + halfH + my;
  return out;
}
