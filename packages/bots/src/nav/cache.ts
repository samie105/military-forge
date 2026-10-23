/**
 * Nav graphs per map and movement tuning, shared by every bot (and every room) on that map. A graph
 * is a pure function of the two, so sharing it is deterministic. A few tunings are kept per map
 * (live tuning, rooms with their own): rooms on different tunings don't rebuild in turn.
 *
 * A build takes 90–330 ms. `navGraphFor` builds at once (local play, replays, tests); a server
 * must not: one build on a room's tick froze every room on the box (QA, 23 Oct). So rooms ask with
 * `requestNavGraph`, which queues the build, and the server runs the queue in the time between its
 * ticks (`workNavBuilds`, a step of a few milliseconds at most at a time). A bot that comes in
 * before its graph is ready gets the map's newest graph meanwhile, or waits for one.
 */
import { createTuning, defaultTuning, type MapDef, type Tuning } from '@military-forge/content';
import { CollisionWorld, Game } from '@military-forge/sim';
import { navGraphSteps, type NavGraph } from './graph';

/** tunings kept per map; the least recently used goes first */
const PER_MAP = 4;
/** builds queued at most; the least recently asked for goes (a room that still wants it asks again) */
const MAX_QUEUED = 8;

/**
 * Tuning that can't change a graph: nothing in the movement code reads it (health, respawns, the
 * aim origin, grenades and blasts, the touch flick). A change to these keeps the graph; any other
 * field is movement (the probe flies the real movement code with the whole tuning) and builds anew.
 */
const NOT_MOVEMENT: ReadonlySet<keyof Tuning> = new Set<keyof Tuning>([
  'healthMax',
  'healthRegen',
  'healthRegenDelay',
  'respawnDelay',
  'shoulderStand',
  'shoulderCrouch',
  'shoulderForward',
  'grenadeThrowScale',
  'blastImpulseScale',
  'dashFlickFull',
]);
const MOVEMENT_FIELDS = (Object.keys(defaultTuning) as (keyof Tuning)[]).filter((k) => !NOT_MOVEMENT.has(k));

/** What a graph is built from, of a tuning: its movement fields. Equal keys, equal graphs. */
export function navKey(t: Tuning): string {
  let key = '';
  for (const k of MOVEMENT_FIELDS) key += `${t[k]},`;
  return key;
}

interface Build {
  map: MapDef;
  key: string;
  steps: Generator<void, NavGraph, void>;
}

/** per map: built graphs by key (most recently used last) and the builds queued for it */
const cache = new WeakMap<MapDef, { graphs: Map<string, NavGraph>; builds: Map<string, Build> }>();
/**
 * queued builds, least recently asked for first: workNavBuilds runs the last. A host dragging a
 * tuning slider queues a build per value; the newest is the one its room wants.
 */
const queue: Build[] = [];

function graphsOf(map: MapDef): { graphs: Map<string, NavGraph>; builds: Map<string, Build> } {
  let entry = cache.get(map);
  if (!entry) {
    entry = { graphs: new Map(), builds: new Map() };
    cache.set(map, entry);
  }
  return entry;
}

function keep(map: MapDef, key: string, graph: NavGraph): void {
  const graphs = graphsOf(map).graphs;
  graphs.delete(key);
  graphs.set(key, graph);
  if (graphs.size > PER_MAP) graphs.delete(graphs.keys().next().value!);
}

/** Runs a build's remaining steps now and keeps the graph. */
function finish(build: Build): NavGraph {
  let r = build.steps.next();
  while (!r.done) r = build.steps.next();
  done(build, r.value);
  return r.value;
}

function done(build: Build, graph: NavGraph): void {
  graphsOf(build.map).builds.delete(build.key);
  const i = queue.indexOf(build);
  if (i >= 0) queue.splice(i, 1);
  keep(build.map, build.key, graph);
}

/** The graph for this map and tuning if it's built (and now the most recently used), else null. */
export function readyNavGraph(map: MapDef, t: Tuning): NavGraph | null {
  const key = navKey(t);
  const graph = graphsOf(map).graphs.get(key);
  if (!graph) return null;
  keep(map, key, graph);
  return graph;
}

/** The map's most recently used graph, whatever its tuning (null: none built). */
export function latestNavGraph(map: MapDef): NavGraph | null {
  let last: NavGraph | null = null;
  for (const g of graphsOf(map).graphs.values()) last = g;
  return last;
}

/**
 * The graph for this map and tuning if it's built; else null, and its build is queued (once) for
 * `workNavBuilds`. Nothing is built here.
 */
export function requestNavGraph(map: MapDef, world: CollisionWorld, t: Tuning): NavGraph | null {
  const ready = readyNavGraph(map, t);
  if (ready) return ready;
  const key = navKey(t);
  const entry = graphsOf(map);
  let build = entry.builds.get(key);
  const at = build ? queue.indexOf(build) : -1;
  if (at >= 0) queue.splice(at, 1);
  if (!build) {
    // a copy: the room's tuning object can change before the build is through
    build = { map, key, steps: navGraphSteps(map, world, { ...t }) };
    entry.builds.set(key, build);
  }
  queue.push(build);
  if (queue.length > MAX_QUEUED) {
    const dropped = queue.shift()!;
    graphsOf(dropped.map).builds.delete(dropped.key);
  }
  return null;
}

/**
 * Runs queued builds a step at a time, the most recently asked for first, until `stop()` says so
 * (it's asked after every step) or the queue is empty. True while builds are left. A step is a
 * settle, a walk or a flight of the probe: well under a millisecond, 2.5 ms at most (a cold JIT).
 */
export function workNavBuilds(stop: () => boolean): boolean {
  while (queue.length) {
    const build = queue[queue.length - 1]!;
    const r = build.steps.next();
    if (r.done) done(build, r.value);
    if (stop()) break;
  }
  return queue.length > 0;
}

/** How many builds are queued. */
export function navBuildsQueued(): number {
  return queue.length;
}

/** The graph for this game's map and tuning, built now if it isn't (a queued build is finished). */
export function navGraphFor(game: Game): NavGraph {
  const t = game.tuning;
  const ready = readyNavGraph(game.map, t);
  if (ready) return ready;
  const key = navKey(t);
  const queued = graphsOf(game.map).builds.get(key);
  if (queued) return finish(queued);
  const build: Build = { map: game.map, key, steps: navGraphSteps(game.map, game.world, t) };
  return finish(build);
}

/** Queues the graphs for these maps (and tuning): a server builds them in its spare time. */
export function queueNavGraphs(maps: Iterable<MapDef>, tuning: Partial<Tuning> = {}): void {
  const t = createTuning(tuning);
  for (const map of maps) requestNavGraph(map, new CollisionWorld(map), t);
}

/** Builds the graphs for these maps (and tuning) now, so the first bot on each doesn't wait or stall. */
export function warmNavGraphs(maps: Iterable<MapDef>, tuning: Partial<Tuning> = {}): void {
  for (const map of maps) navGraphFor(new Game({ map, tuning, dummies: false }));
}
