/**
 * Every registered map (packages/content maps): it compiles (collision, rules, zones, events), and
 * every spawn stands clear on walkable ground where it's put: no depenetration nudge, no fall.
 */
import { maps } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Game, depenetrate } from '../src';

describe('registered maps', () => {
  for (const map of Object.values(maps)) {
    it(`${map.id}: compiles, and every spawn stands where it is put`, () => {
      expect(() => new Game({ map, dummies: true })).not.toThrow();
      map.spawns.forEach((s, i) => {
        const game = new Game({ map });
        const p = game.addPlayer('probe');
        p.spawn(s.x, s.y + 0.01, game.tuning);
        depenetrate(game.world, p, game.tuning);
        expect(Math.abs(p.x - s.x), `spawn ${i} (${s.x}, ${s.y}) is inside geometry`).toBeLessThan(1e-9);
        for (let t = 0; t < 30; t++) game.step([]);
        expect(p.grounded, `spawn ${i} (${s.x}, ${s.y}) doesn't land`).toBe(true);
        expect(Math.abs(p.x - s.x) + Math.abs(p.y - s.y), `spawn ${i} (${s.x}, ${s.y}) moved`).toBeLessThan(0.02);
      });
    });
  }
});

describe('demo map promises', () => {
  it('flux-lab: each jump pad lands you on the catwalk above it', () => {
    for (const x of [13.5, 96.5]) {
      const game = new Game({ mapId: 'flux-lab' });
      const p = game.addPlayer('probe');
      p.spawn(x, 0.01, game.tuning);
      for (let t = 0; t < 180; t++) game.step([]);
      expect(p.grounded).toBe(true);
      expect(p.y).toBeCloseTo(7, 2);
    }
  });
});
