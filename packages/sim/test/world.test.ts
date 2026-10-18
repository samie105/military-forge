import { describe, expect, it } from 'vitest';
import { CollisionWorld, MIN_THICKNESS, SegFlag, createRayHit, thinnestSolid } from '../src';
import { flatMap, hill, rect } from './helpers';

const thin = (extra: { points: number[] }) => new CollisionWorld(flatMap([extra])).warnings.filter((w) => w.includes('thick'));

/** A w-thick, len-long slab centred at (cx, cy), tilted `deg` from vertical (CCW points). */
function slab(cx: number, cy: number, w: number, len: number, deg: number): { points: number[] } {
  const a = (deg * Math.PI) / 180;
  const [ux, uy, vx, vy] = [Math.sin(a), Math.cos(a), Math.cos(a), -Math.sin(a)];
  const points: number[] = [];
  for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) points.push(cx + ((s * w) / 2) * vx + ((t * len) / 2) * ux, cy + ((s * w) / 2) * vy + ((t * len) / 2) * uy);
  return { points };
}

describe('map compiler: thin solids (docs/02 §4)', () => {
  it(`warns about a wall, a floor or a tilted slab thinner than ${MIN_THICKNESS} m`, () => {
    expect(thin(rect(30, 0, 30.2, 10))).toEqual(['solid #4: only 0.20 m thick (walls ≥ 0.3 m; a thin floor is a one-way platform)']);
    expect(thin(rect(20, 5.75, 40, 6))).toHaveLength(1);
    expect(thin(slab(30, 6, 0.1, 5, 30))).toHaveLength(1);
    expect(thin(rect(30, 0, 30 + MIN_THICKNESS, 10))).toEqual([]);
  });

  it('leaves ramps, wedge tips and narrow notches alone', () => {
    expect(thin(hill(10, 25, 2, 4))).toEqual([]);
    expect(thin(hill(10, 45, 0.5, 1))).toEqual([]);
    // a 20° ramp: the slope and the floor face each other, but the solid only thins at the tip
    expect(thin({ points: [10, 0, 10 + 1 / Math.tan(Math.PI / 9), 0, 10 + 1 / Math.tan(Math.PI / 9), 1] })).toEqual([]);
    // a block with a 0.1 m slot cut into it: the slot is outside the solid
    expect(thin({ points: [10, 0, 13, 0, 13, 3, 11.55, 3, 11.55, 1, 11.45, 1, 11.45, 3, 10, 3] })).toEqual([]);
  });

  it('measures the thinnest part: a 0.1 m bridge under a U', () => {
    expect(thinnestSolid([0, 0, 3, 0, 3, 3, 2, 3, 2, 0.1, 1, 0.1, 1, 3, 0, 3])).toBeCloseTo(0.1, 9);
    expect(thinnestSolid(rect(0, 0, 2, 1).points)).toBeCloseTo(1, 9);
    expect(thinnestSolid([0, 0, 1, 0, 0.5, 0.8])).toBe(Infinity); // a triangle has no facing edges
  });
});

describe('raycast', () => {
  it('a NaN origin or direction hits nothing and returns (a ground probe with a NaN y used to walk the grid forever)', () => {
    const world = new CollisionWorld(flatMap([rect(30, 0, 31, 10)]));
    const hit = createRayHit();
    expect(world.raycast(10, 1, 1, 0, 40, SegFlag.OneWay, hit)).toBe(true); // the wall at 30
    expect(hit.t).toBeCloseTo(20, 5);
    for (const [ox, oy, dx, dy] of [
      [10, NaN, 0, -1], // straight down: the walk only ever stepped the NaN row
      [NaN, 1, 1, 0],
      [10, NaN, 1, 0],
      [10, 1, NaN, 0],
      [10, 1, 1, NaN],
      [Infinity, -Infinity, 1, 0],
    ]) {
      expect(world.raycast(ox!, oy!, dx!, dy!, 40, SegFlag.OneWay, hit)).toBe(false);
      expect(hit.seg).toBe(-1);
    }
    // a NaN range still ends (at the grid's edge) and finds nothing
    expect(world.raycast(10, 1, 1, 0, NaN, SegFlag.OneWay, hit)).toBe(false);
  });
});
