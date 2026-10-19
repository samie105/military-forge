/** Acoustics: walls between you and a sound, and whether you're in the open or under cover. */
import { getMap } from '@military-forge/content';
import type { RayHit } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Acoustics, type Raycaster } from './acoustics';

/** A test world of axis-aligned lines: vertical x = c (y0..y1) and horizontal y = c (x0..x1). */
function world(vertical: [number, number, number][], horizontal: [number, number, number][]): Raycaster {
  return {
    raycast(ox, oy, dx, dy, maxT, _ignore, out: RayHit) {
      let best = Infinity;
      for (const [c, a, b] of vertical)
        if (dx !== 0) {
          const t = (c - ox) / dx;
          const y = oy + dy * t;
          if (t > 1e-6 && t <= maxT && y >= a && y <= b) best = Math.min(best, t);
        }
      for (const [c, a, b] of horizontal)
        if (dy !== 0) {
          const t = (c - oy) / dy;
          const x = ox + dx * t;
          if (t > 1e-6 && t <= maxT && x >= a && x <= b) best = Math.min(best, t);
        }
      if (best === Infinity) return false;
      out.t = best;
      out.x = ox + dx * best;
      out.y = oy + dy * best;
      return true;
    },
  };
}

describe('occlusion', () => {
  it('counts a solid wall (two faces) as one, a slab as one, two walls as two', () => {
    const wall: [number, number, number][] = [
      [5, -10, 10],
      [5.5, -10, 10],
    ];
    const a = new Acoustics(world(wall, [[3, -10, 10]]));
    expect(a.occlusion(0, 0, 3, 0)).toBe(0);
    expect(a.occlusion(0, 0, 8, 0)).toBe(1);
    expect(a.occlusion(0, 0, 0, 6)).toBe(1); // through the slab overhead
    const two = new Acoustics(world([...wall, [9, -10, 10], [9.5, -10, 10]], []));
    expect(two.occlusion(0, 0, 12, 0)).toBe(2);
  });

  it('caches an answer for a moment per metre cell', () => {
    let rays = 0;
    const w = world([[5, -10, 10]], []);
    const counting: Raycaster = { raycast: (...args) => (rays++, w.raycast(...args)) };
    const a = new Acoustics(counting);
    a.occlusion(0, 0, 8, 0, 1);
    const after = rays;
    a.occlusion(0.2, 0.1, 8.1, 0, 1.05);
    expect(rays).toBe(after);
    a.occlusion(0, 0, 8, 0, 1.3);
    expect(rays).toBeGreaterThan(after);
  });
});

describe('enclosure', () => {
  it('open street is 0; a roof with walls on both sides is (nearly) indoors', () => {
    expect(new Acoustics(world([], [])).enclosure(0, 0)).toBe(0);
    const room = new Acoustics(world([[-4, -10, 10], [4, -10, 10]], [[4, -10, 10]]));
    expect(room.enclosure(0, 0)).toBeGreaterThan(0.8);
  });

  it('works on a real map', () => {
    const a = Acoustics.forMap(getMap('street-market'));
    const e = a.enclosure(0, 2);
    expect(e).toBeGreaterThanOrEqual(0);
    expect(e).toBeLessThanOrEqual(1);
    expect([0, 1, 2]).toContain(a.occlusion(0, 2, 30, 2));
  });
});
