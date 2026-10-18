import { maps } from '@military-forge/content';
import { Game, createBodyEnv, createInput, type Input } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Motor } from '../src/motor';
import { PathFinder } from '../src/nav/astar';
import { buildNavGraph } from '../src/nav/graph';
import { Navigator } from '../src/nav/navigator';
import { flatMap, rect } from './helpers';

describe('nav graph: every registered map', () => {
  for (const map of Object.values(maps)) {
    it(`${map.id}: every spawn reaches every other spawn; the build is deterministic`, () => {
      const game = new Game({ map });
      const g = buildNavGraph(map, game.world, game.tuning);
      const spawns = map.spawns.map((s) => g.nearest(s.x, s.y, 2));
      expect(spawns.every((n) => n >= 0)).toBe(true);
      const pf = new PathFinder(g);
      const path: number[] = [];
      for (const a of spawns) for (const b of spawns) if (a !== b) expect(pf.find(a, b, (l) => l.time, path), `${a} → ${b}`).toBe(true);
      const again = buildNavGraph(map, game.world, game.tuning);
      expect(JSON.stringify(again.nodes)).toBe(JSON.stringify(g.nodes));
      expect(JSON.stringify(again.links)).toBe(JSON.stringify(g.links));
    });

    it(`${map.id}: a lone body following the plan crosses to the farthest spawn`, () => {
      const game = new Game({ map, seed: 3 });
      const p = game.addPlayer('walker');
      const start = map.spawns[0]!;
      p.spawn(start.x, start.y + 0.01, game.tuning);
      const far = map.spawns.reduce((a, b) => (Math.abs(b.x - start.x) + Math.abs(b.y - start.y) > Math.abs(a.x - start.x) + Math.abs(a.y - start.y) ? b : a));
      const g = buildNavGraph(map, game.world, game.tuning);
      const nav = new Navigator(g);
      const goal = g.nearest(far.x, far.y, 2);
      const input: Input = createInput();
      const inputs: (Input | undefined)[] = [];
      inputs[p.id] = input;
      for (let i = 0; i < 10; i++) game.step(inputs);
      expect(nav.plan(p, goal)).toBe(true);
      let arrived = false;
      for (let t = 0; t < 90 * 60 && !arrived; t++) {
        if (nav.failed || (!nav.busy && t % 30 === 0)) nav.plan(p, goal);
        input.buttons = nav.step(game, p, game.mech ? game.mech.bodyEnv(p, game.tuning, envScratch) : null);
        game.step(inputs);
        arrived = p.grounded && Math.abs(p.x - g.nodes[goal]!.x) < 0.5 && Math.abs(p.y - g.nodes[goal]!.y) < 0.5;
      }
      expect(arrived).toBe(true);
    });
  }
});

const envScratch = createBodyEnv();

describe('motor', () => {
  it('walks to a point and stops on it; jets up onto a 5 m ledge and lands on it', () => {
    const game = new Game({ map: flatMap([rect(40, 0, 50, 5)]) });
    const p = game.addPlayer('p');
    p.spawn(10, 0.01, game.tuning);
    const motor = new Motor();
    const input: Input = createInput();
    const inputs: (Input | undefined)[] = [];
    inputs[p.id] = input;
    const goal = { x: 20, y: 0, jet: false, early: false };
    for (let i = 0; i < 4 * 60; i++) {
      input.buttons = motor.step(game.world, p, game.tuning, null, goal);
      game.step(inputs);
    }
    expect(Math.abs(p.x - 20)).toBeLessThan(0.15);
    expect(p.vx).toBe(0);

    Object.assign(goal, { x: 43, y: 5, jet: true });
    motor.reset();
    for (let i = 0; i < 6 * 60; i++) {
      input.buttons = motor.step(game.world, p, game.tuning, null, goal);
      game.step(inputs);
    }
    expect(p.grounded).toBe(true);
    expect(Math.abs(p.y - 5)).toBeLessThan(0.05);
    expect(Math.abs(p.x - 43)).toBeLessThan(0.5);
  });
});
