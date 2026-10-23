/**
 * A nav graph as plain data and back (a page builds its training map's graph in a worker and
 * posts it: apps/web navWarm.ts): the same nodes, links, outgoing lists and spatial queries.
 */
import { createTuning, maps } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { buildNavGraph, navGraphData, navGraphFromData, provideNavGraph, readyNavGraph, requestNavGraph, navBuildsQueued } from '../src';

describe('nav graph data', () => {
  for (const id of ['vertical-test', 'street-market']) {
    it(`${id}: a structured clone of the data rebuilds the same graph`, () => {
      const map = maps[id]!;
      const world = new CollisionWorld(map);
      const g = buildNavGraph(map, world, createTuning());
      const back = navGraphFromData(map, world, structuredClone(navGraphData(g)));
      expect(JSON.stringify(back.nodes)).toBe(JSON.stringify(g.nodes));
      expect(JSON.stringify(back.links)).toBe(JSON.stringify(g.links));
      expect(back.out).toEqual(g.out);
      for (const n of g.nodes.filter((_, i) => i % 37 === 0)) {
        expect(back.nearest(n.x + 0.3, n.y + 0.1)).toBe(g.nearest(n.x + 0.3, n.y + 0.1));
        expect(back.nearestUsable(n.x, n.y + 3, 6)).toBe(g.nearestUsable(n.x, n.y + 3, 6));
      }
    }, 60_000);
  }

  it('a provided graph is ready, and its queued build is dropped', () => {
    const map = maps['mechanics-test']!;
    const world = new CollisionWorld(map);
    const t = createTuning({ jetThrust: 37.5 });
    expect(requestNavGraph(map, world, t)).toBeNull();
    const queued = navBuildsQueued();
    const g = buildNavGraph(map, world, t);
    provideNavGraph(map, t, g);
    expect(readyNavGraph(map, t)).toBe(g);
    expect(navBuildsQueued()).toBe(queued - 1);
  }, 60_000);
});
