/**
 * The map's acoustics, from its collision geometry (sim CollisionWorld): how many walls or slabs
 * stand between you and a sound (occlusion), and whether you're out in the open or under cover
 * (which reverb fits). Cheap rules, not a simulation: one walk along a single ray per sound start
 * (cached for a moment per metre cell), and three rays from the listener a few times a second.
 */
import type { MapDef } from '@military-forge/content';
import { CollisionWorld, SegFlag, createRayHit, type RayHit } from '@military-forge/sim';

/** What acoustics needs from the world: a raycast (CollisionWorld's; tests pass their own). */
export interface Raycaster {
  raycast(ox: number, oy: number, dx: number, dy: number, maxT: number, ignoreFlags: number, out: RayHit): boolean;
}

/** Most crossings counted on one path (two walls' worth). */
const MAX_CROSSINGS = 4;
/** How long a cached occlusion answer holds (s). */
const CACHE_S = 0.15;

export class Acoustics {
  private readonly hit = createRayHit();
  private readonly cache = new Map<string, { at: number; value: number }>();

  constructor(private readonly world: Raycaster) {}

  static forMap(map: MapDef): Acoustics {
    return new Acoustics(new CollisionWorld(map));
  }

  /**
   * Walls between (lx, ly) and (x, y): 0 = clear, 1 = one wall or slab, 2 = two or more. A solid's
   * two faces are one wall; a slab (one segment) is one too. Fences and railings that bullets pass
   * don't count. `now` (s) keys the short cache.
   */
  occlusion(lx: number, ly: number, x: number, y: number, now = 0): number {
    const key = `${Math.round(lx)},${Math.round(ly)}:${Math.round(x)},${Math.round(y)}`;
    const c = this.cache.get(key);
    if (c && now - c.at < CACHE_S) return c.value;
    const value = this.walls(lx, ly, x, y);
    if (this.cache.size > 512) this.cache.clear();
    this.cache.set(key, { at: now, value });
    return value;
  }

  private walls(lx: number, ly: number, x: number, y: number): number {
    const dx = x - lx;
    const dy = y - ly;
    const d = Math.hypot(dx, dy);
    if (d < 0.5) return 0;
    const ux = dx / d;
    const uy = dy / d;
    let t = 0;
    let crossings = 0;
    while (crossings < MAX_CROSSINGS && t < d - 0.2) {
      if (!this.world.raycast(lx + ux * t, ly + uy * t, ux, uy, d - t, SegFlag.BulletPass, this.hit)) break;
      crossings++;
      t += this.hit.t + 0.02;
    }
    return Math.min(2, Math.ceil(crossings / 2));
  }

  /**
   * How enclosed the listener is, 0 (open street) … 1 (indoors): a roof overhead within 10 m
   * counts most, walls close on both sides the rest.
   */
  enclosure(x: number, y: number): number {
    const h = this.hit;
    const roof = this.world.raycast(x, y + 0.5, 0, 1, 10, SegFlag.BulletPass, h) ? 1 - h.t / 12 : 0;
    const left = this.world.raycast(x, y + 1, -1, 0, 9, SegFlag.BulletPass, h) ? 1 : 0;
    const right = this.world.raycast(x, y + 1, 1, 0, 9, SegFlag.BulletPass, h) ? 1 : 0;
    return Math.min(1, roof * 0.65 + (left + right) * 0.175 + (roof > 0 && left && right ? 0.1 : 0));
  }
}
