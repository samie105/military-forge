/**
 * Which boards are on screen, for tap-to-save and the ad views (apps/web/src/ads, metrics). No three
 * import: that code runs from boot, before the 3D view's chunk is in (audit 28 Oct); boards.ts adds
 * and removes its boards here.
 */
import type { AdBoards } from './boards';

/** Boards alive now (one per loaded map with ad slots): tap-to-save asks the one being drawn. */
export const liveBoards = new Set<AdBoards>();

/** The boards drawn within the last `withinMs` (the 3D view is up and showing them), or null. */
export function drawnBoards(now: number = performance.now(), withinMs = 400): AdBoards | null {
  let best: AdBoards | null = null;
  for (const b of liveBoards) if (now - b.drawnAt <= withinMs && (!best || b.drawnAt > best.drawnAt)) best = b;
  return best;
}
