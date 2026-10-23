/**
 * Training's nav graph is built in idle slices while the player is in the menus (navWarm.ts), and
 * training's bots then find it ready: the same graph a build at once makes.
 */
import { buildNavGraph, readyNavGraph } from '@military-forge/bots';
import { createTuning, getMap } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { warmNavGraph } from '../src/navWarm';

describe('warmNavGraph', () => {
  it('builds the map’s graph in many small slices; it is then ready, and the same as a build at once', async () => {
    const map = getMap('mechanics-test');
    expect(readyNavGraph(map, createTuning())).toBeNull();
    const r = await warmNavGraph(map, {}, undefined, false); // no workers under vitest: the idle-slice fallback
    expect(r.slices).toBeGreaterThan(5);
    const ready = readyNavGraph(map, createTuning());
    expect(ready).not.toBeNull();
    const once = buildNavGraph(map, new CollisionWorld(map), createTuning());
    expect(JSON.stringify(ready!.links)).toBe(JSON.stringify(once.links));
    // a second warm has nothing to do
    expect(await warmNavGraph(map, {}, undefined, false)).toMatchObject({ how: 'ready', slices: 0 });
  }, 60_000);
});
