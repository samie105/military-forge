/**
 * Nav graphs per map and tuning, built on first use and shared by every bot (and every room) on
 * that map. A graph is a pure function of the two, so sharing it is deterministic. A few tunings are
 * kept per map (live tuning, rooms with their own): rooms on different tunings don't rebuild in
 * turn. A build takes 90–270 ms and is synchronous: a server warms its maps at startup.
 */
import type { MapDef, Tuning } from '@military-forge/content';
import { Game } from '@military-forge/sim';
import { buildNavGraph, type NavGraph } from './graph';

/** tunings kept per map; the least recently used goes first */
const PER_MAP = 4;

const cache = new WeakMap<MapDef, Map<string, NavGraph>>();

export function navGraphFor(game: Game): NavGraph {
  // live tuning (the dev panel) can change movement: a new tuning, a new graph
  const key = JSON.stringify(game.tuning);
  let byTuning = cache.get(game.map);
  if (!byTuning) {
    byTuning = new Map();
    cache.set(game.map, byTuning);
  }
  const hit = byTuning.get(key);
  if (hit) {
    // most recently used last
    byTuning.delete(key);
    byTuning.set(key, hit);
    return hit;
  }
  const graph = buildNavGraph(game.map, game.world, game.tuning);
  byTuning.set(key, graph);
  if (byTuning.size > PER_MAP) byTuning.delete(byTuning.keys().next().value!);
  return graph;
}

/** Builds the graphs for these maps (and tuning) now, so the first bot on each doesn't stall its room. */
export function warmNavGraphs(maps: Iterable<MapDef>, tuning: Partial<Tuning> = {}): void {
  for (const map of maps) navGraphFor(new Game({ map, tuning, dummies: false }));
}
