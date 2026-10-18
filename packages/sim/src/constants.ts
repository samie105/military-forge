/** Fixed simulation rate, identical on client and server (docs/02 §3). */
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

/** Contact skin: resolved bodies rest this far from surfaces. */
export const SKIN = 0.002;

export const MAX_PLAYERS = 16;
export const MAX_GRENADES = 64;
/** items lying on the map at once: spawner items and drops (pickups.ts) */
export const MAX_PICKUPS = 32;
/** smoke and gas clouds alive at once (the wire count is u5); a new one replaces the oldest */
export const MAX_CLOUDS = 24;

/** Broadphase cell size in metres (docs/02 §5). */
export const GRID_CELL = 4;

/** Seconds → whole ticks. */
export function ticks(seconds: number): number {
  return Math.round(seconds * TICK_RATE);
}
