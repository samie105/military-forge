/**
 * View-model helpers for grenade variety (sim grenades.ts, clouds.ts), shared by local and online
 * mode: clouds sized by the sim's own functions, and the local player's belt and status effects.
 */
import { GRENADE_TYPES, grenades } from '@military-forge/content';
import { SegFlag, TICK_RATE, blindIntensity, cloudDef, cloudDensity, cloudRadius, createRayHit, visionRadius, type CollisionWorld, type PlayerState } from '@military-forge/sim';
import type { CloudView, PlayerView } from './view';

/** A cloud of grenade `type`, `age` ticks after it popped; null if the type makes no cloud. */
export function cloudView(id: number, type: number, x: number, y: number, age: number): CloudView | null {
  const def = cloudDef(type);
  if (!def) return null;
  return { id, type, x, y, radius: cloudRadius(def, age), density: cloudDensity(def, age), opaque: visionRadius(def, age), age: age / TICK_RATE };
}

type StatusView = Required<Pick<PlayerView, 'grenadeType' | 'grenadeCounts' | 'blind' | 'blindTicks' | 'gasTicks' | 'jetDisabledTicks'>>;

/**
 * The belt and status effects of a player whose state we hold (local mode: everyone; online: us).
 * `peakBlind`: the most blinded it was over the ticks since the last frame, so a flashbang that
 * came and went inside a long frame still reaches the screen (fx FlashLimiter).
 */
export function statusView(p: PlayerState, peakBlind = 0): StatusView {
  return {
    grenadeType: p.grenadeType,
    grenadeCounts: p.grenadeCounts.slice(),
    blind: Math.max(blindIntensity(p), p.alive ? peakBlind : 0),
    blindTicks: p.blindTicks,
    gasTicks: p.gasTicks,
    jetDisabledTicks: p.jetDisabledTicks,
  };
}

/** Every grenade type at its carry limit (dev: `?grenades` in local mode, until map pickups hand them out). */
export function fullBelt(): number[] {
  const out = new Array<number>(GRENADE_TYPES).fill(0);
  for (const g of grenades) out[g.index] = g.maxCount;
  return out;
}

/** Directions a cloud's reach is sampled in (cloudReach): 3.75° apart, ~0.26 m at a 4 m rim. */
export const REACH_RAYS = 96;
const reachHit = createRayHit();

/**
 * How far a cloud centred at (x, y) reaches in each of REACH_RAYS directions (m, into `out`; ray i
 * points at angle 2πi/REACH_RAYS). The sim bounds smoke and gas by walls: a point is in the cloud
 * only with no wall (fences and platforms don't count) between it and the centre. Returns false
 * when nothing within `radius` cuts it: the whole disc.
 */
export function cloudReach(world: CollisionWorld, x: number, y: number, radius: number, out: Float32Array): boolean {
  let walled = false;
  for (let i = 0; i < REACH_RAYS; i++) {
    const a = (i / REACH_RAYS) * Math.PI * 2;
    const hit = world.raycast(x, y, Math.cos(a), Math.sin(a), radius, SegFlag.BulletPass, reachHit);
    out[i] = hit ? reachHit.t : radius;
    if (hit) walled = true;
  }
  return walled;
}

/** The reach (cloudReach) toward the offset (dx, dy) from the centre, between the two nearest rays. */
export function reachToward(reach: Float32Array, dx: number, dy: number): number {
  let a = Math.atan2(dy, dx) / (Math.PI * 2);
  if (a < 0) a += 1;
  const f = a * REACH_RAYS;
  const i = Math.floor(f) % REACH_RAYS;
  const j = (i + 1) % REACH_RAYS;
  const u = f - Math.floor(f);
  return reach[i]! + (reach[j]! - reach[i]!) * u;
}

/** True if (x, y) is inside the opaque part of a cloud: things there are hidden from view. */
export function inSmoke(clouds: readonly CloudView[] | undefined, x: number, y: number): boolean {
  if (!clouds) return false;
  for (const c of clouds) if (c.opaque > 0 && (x - c.x) * (x - c.x) + (y - c.y) * (y - c.y) < c.opaque * c.opaque) return true;
  return false;
}
