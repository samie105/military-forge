/**
 * Respawns on a map with tiers (maps-vertical): players spread across the stacked battle zones.
 */
import { maps, tierIndexAt, verticalTestMap, type MapDef } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, CollisionWorld, Game, SegFlag, createInput, createRayHit } from '../src';

describe('respawns spread across tiers', () => {
  it('each new player lands on the tier with the fewest players', () => {
    const game = new Game({ map: verticalTestMap });
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 9; i++) {
      const p = game.addPlayer(`p${i}`);
      counts[tierIndexAt(verticalTestMap, p.y)]!++;
    }
    // three tiers have spawns (the sky deck is a prize, not a spawn): 3, 3, 3
    expect(counts).toEqual([3, 3, 3, 0]);
  });

  it('a respawn goes to the emptiest tier, and farthest from everyone on it', () => {
    const game = new Game({ map: verticalTestMap });
    const a = game.addPlayer('a');
    const b = game.addPlayer('b');
    // both on the streets, at its west end
    a.x = 2;
    a.y = 0;
    b.x = 5;
    b.y = 0;
    const c = game.addPlayer('c');
    expect(tierIndexAt(verticalTestMap, c.y)).toBe(1);
    // the farthest rooftop spawn from a and b
    expect(c.x).toBe(173);
  });

  it('a map without tiers keeps the plain farthest-spawn rule', () => {
    const { tiers: _tiers, ...flat } = verticalTestMap;
    const map: MapDef = flat;
    const game = new Game({ map });
    const a = game.addPlayer('a');
    a.x = 2;
    a.y = 0;
    const b = game.addPlayer('b');
    // the spawn farthest from (2, 0), whatever its tier: the street's east end
    expect([b.x, b.y]).toEqual([196, 0]);
  });
});

describe('vertical-test: climbing is a choice, the ceiling is soft', () => {
  const run = (game: Game, p: ReturnType<Game['addPlayer']>, ticks: number, buttons: number, each?: () => void) => {
    const input = { ...createInput(), buttons };
    const inputs: ReturnType<typeof createInput>[] = [];
    inputs[p.id] = input;
    for (let t = 0; t < ticks; t++) {
      game.step(inputs);
      each?.();
    }
  };

  it('a full tank climbs one tier (rooftops, 20 m) but not two (high, 42 m)', () => {
    const game = new Game({ map: verticalTestMap });
    const p = game.addPlayer('p');
    p.spawn(70, 0.01, game.tuning); // the open street between the west and centre towers
    let top = 0;
    run(game, p, 8 * 60, Btn.Jet, () => (top = Math.max(top, p.y)));
    expect(top).toBeGreaterThan(20);
    expect(top).toBeLessThan(42);
  });

  it('an updraft lifts a body that stops jetting from the street to the high platforms, no fuel spent', () => {
    const game = new Game({ map: verticalTestMap });
    const p = game.addPlayer('p');
    p.spawn(10, 0.01, game.tuning);
    run(game, p, 8, Btn.Jet); // hop off the street into the rising air
    run(game, p, 12 * 60, 0);
    expect(p.y).toBeGreaterThan(41);
    expect(p.fuel).toBeCloseTo(game.tuning.fuelMax, 0); // refuelled on the way
    run(game, p, 60, Btn.Left); // step out of the column onto the platform's west end
    run(game, p, 60, 0);
    expect(p.grounded).toBe(true);
    expect(p.y).toBeCloseTo(42, 1);
  });

  it('thin air: jetting from the sky deck, a body never reaches the hard ceiling and comes back down', () => {
    const game = new Game({ map: verticalTestMap });
    const p = game.addPlayer('p');
    p.spawn(100 + 10, 66.01, game.tuning);
    let top = 0;
    run(game, p, 10 * 60, Btn.Jet, () => (top = Math.max(top, p.y)));
    expect(top + game.tuning.standHeight / 2).toBeGreaterThan(82); // its body centre reaches the thin air (a full tank alone would climb past 83)
    expect(top + game.tuning.standHeight).toBeLessThan(100 - 4); // well under the ceiling
    run(game, p, 6 * 60, 0);
    expect(p.grounded).toBe(true);
    expect(p.y).toBeCloseTo(66, 1);
  });
});

for (const map of Object.values(maps).filter((m) => m.tiers)) {
  describe(`${map.id}: anything drawn solid stops bullets (owner, 18 Oct; QA, 23 Oct)`, () => {
    const world = new CollisionWorld(map);
    const hit = createRayHit();
    const b = map.bounds;

    it('every slab, from below and from above', () => {
      for (const o of map.oneWays) {
        const x = (o.ax + o.bx) / 2;
        // a slab can sit on something solid (a balcony on a wall): only the free side is tested
        if (!world.raycastBullet(x, o.ay - 3, 0, 1, 6, SegFlag.BulletPass, hit) || hit.y > o.ay + 1e-6) expect.fail(`slab ${o.ax}..${o.bx}@${o.ay} from below`);
        expect(world.raycastBullet(x, o.ay + 3, 0, -1, 6, SegFlag.BulletPass, hit), `slab ${o.ax}..${o.bx}@${o.ay} from above`).toBe(true);
        expect(hit.y).toBeGreaterThanOrEqual(o.ay - 1e-6);
      }
    });

    it('every solid and every thin post, from either side', () => {
      for (const poly of [...map.solids, ...(map.bulletOnly ?? [])]) {
        const xs = poly.points.filter((_, i) => i % 2 === 0);
        const ys = poly.points.filter((_, i) => i % 2 === 1);
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        if (x0 <= b.minX + 2 || x1 >= b.maxX - 2) continue; // the walls, the ground and the ceiling are the map's edges
        const y = (y0 + y1) / 2;
        expect(world.raycastBullet(x0 - 2, y, 1, 0, 4 + x1 - x0, SegFlag.BulletPass, hit), `${x0}..${x1} × ${y0}..${y1} from the west`).toBe(true);
        expect(hit.x).toBeLessThanOrEqual(x0 + 1e-6);
        expect(world.raycastBullet(x1 + 2, y, -1, 0, 4 + x1 - x0, SegFlag.BulletPass, hit), `${x0}..${x1} × ${y0}..${y1} from the east`).toBe(true);
        expect(hit.x).toBeGreaterThanOrEqual(x1 - 1e-6);
      }
    });
  });
}
