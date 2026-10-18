/**
 * One nav graph per map and tuning, built on first use and shared by every bot (and every room)
 * on that map. The graph is a pure function of the two, so sharing it is deterministic.
 */
import type { MapDef } from '@military-forge/content';
import type { Game } from '@military-forge/sim';
import { buildNavGraph, type NavGraph } from './graph';

const cache = new WeakMap<MapDef, { key: string; graph: NavGraph }>();

export function navGraphFor(game: Game): NavGraph {
  // live tuning (the dev panel) can change movement: rebuild when it does
  const key = JSON.stringify(game.tuning);
  const hit = cache.get(game.map);
  if (hit && hit.key === key) return hit.graph;
  const graph = buildNavGraph(game.map, game.world, game.tuning);
  cache.set(game.map, { key, graph });
  return graph;
}
