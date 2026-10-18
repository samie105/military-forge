/**
 * The nav graph (docs/08 §9): where a bot can stand and how it gets between those places, built
 * once per map and tuning from the collision world.
 *
 * - **Nodes:** points on walkable ground (solid tops within the walk slope, one-way platforms)
 *   about a metre apart, where a probe body actually comes to rest.
 * - **Walk links:** to the nearest node on either side that the probe reaches without the jetpack
 *   (stepping up, sliding down slopes and walking off ledges included).
 * - **Air links:** from every node to the nearest node of each other walkable surface in jet range.
 *   The probe flies the motor there through the real movement code, so jets, drops, drop-throughs,
 *   pads, wind and low gravity all count. A link keeps the time and fuel the flight took. If the
 *   probe lands somewhere else useful and stops, that becomes the link instead.
 *
 * Deterministic: the same map and tuning build the same graph on every machine.
 */
import type { MapDef, Tuning } from '@military-forge/content';
import { DEG2RAD, simCos } from '@military-forge/shared';
import { CollisionWorld, MapMechanics, SegFlag, createBodyEnv, createRayHit, overlaps } from '@military-forge/sim';
import { Motor, type MotorGoal } from '../motor';
import { Probe } from './probe';

export const LinkKind = {
  Walk: 0,
  Air: 1,
} as const;
export type LinkKind = (typeof LinkKind)[keyof typeof LinkKind];

export interface NavNode {
  id: number;
  /** feet, where the probe came to rest */
  x: number;
  y: number;
  /** the walkable segment it was sampled from */
  seg: number;
  oneWay: boolean;
  /** connected walkable surface (component of walk links) */
  surface: number;
  /** extra cost per second spent here: mud, deep water, an EMP field */
  hazard: number;
  /** a spawn can get here and back: somewhere to go (the roof of the map's ceiling isn't) */
  usable: boolean;
}

export interface NavLink {
  id: number;
  from: number;
  to: number;
  kind: LinkKind;
  /** seconds the probe took */
  time: number;
  /** fuel the probe burned (0 = no jet) */
  fuel: number;
  /** a pad launched the probe on the way */
  pad: boolean;
  /** flown taking off at once (MotorGoal.early) */
  early: boolean;
}

/** walkable ground is sampled about this often (m) */
const NODE_SPACING = 1;
/** samples keep this far from a segment's ends (m) */
const END_INSET = 0.25;
/** nodes closer than this merge (m) */
const MERGE = 0.3;
/** walk links reach the nearest node within this (m) */
const WALK_REACH_X = 2.4;
const WALK_REACH_Y = 1.3;
/** air links: targets within this box (m): sideways, up, down */
const AIR_REACH_X = 22;
const AIR_REACH_UP = 12.5;
const AIR_REACH_DOWN = 40;
/** an air check gives up after this long (s), or after this long without getting closer */
const AIR_MAX_TIME = 5;
const AIR_STALL_TIME = 1.5;
/** spatial index cell (m) */
const CELL = 2;

const hit = createRayHit();

export class NavGraph {
  readonly nodes: NavNode[] = [];
  readonly links: NavLink[] = [];
  /** outgoing link ids per node */
  readonly out: number[][] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly minX: number;
  private readonly minY: number;
  private readonly cols: number;

  constructor(
    readonly map: MapDef,
    readonly world: CollisionWorld,
  ) {
    this.minX = map.bounds.minX;
    this.minY = map.bounds.minY;
    this.cols = Math.ceil((map.bounds.maxX - map.bounds.minX) / CELL) + 1;
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.minX) / CELL)));
    const cy = Math.max(0, Math.floor((y - this.minY) / CELL));
    return cy * this.cols + cx;
  }

  /** Calls `fn` with every node id within the box around (x, y), in ascending id order per cell. */
  forNear(x: number, y: number, rx: number, ry: number, fn: (id: number) => void): void {
    const c0 = Math.max(0, Math.floor((x - rx - this.minX) / CELL));
    const c1 = Math.min(this.cols - 1, Math.floor((x + rx - this.minX) / CELL));
    const r0 = Math.max(0, Math.floor((y - ry - this.minY) / CELL));
    const r1 = Math.max(0, Math.floor((y + ry - this.minY) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const ids = this.cells.get(r * this.cols + c);
        if (!ids) continue;
        for (const id of ids) {
          const n = this.nodes[id]!;
          if (Math.abs(n.x - x) <= rx && Math.abs(n.y - y) <= ry) fn(id);
        }
      }
    }
  }

  /**
   * The node nearest to feet at (x, y) within `reach` m that the body could walk to from there: about
   * the same height and nothing solid between. −1 if none.
   */
  nearest(x: number, y: number, reach = 1.5): number {
    let best = -1;
    let bestD = Infinity;
    this.forNear(x, y, reach, 1.2, (id) => {
      const n = this.nodes[id]!;
      const dx = n.x - x;
      const dy = n.y - y;
      const d = dx * dx + 4 * dy * dy;
      if (d >= bestD) return;
      // the line between the two body centres is clear (one-way platforms don't block)
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-6 && this.world.raycast(x, y + 0.75, dx / len, dy / len, len, SegFlag.OneWay, hit)) return;
      best = id;
      bestD = d;
    });
    return best;
  }

  /** The nearest usable node within `reach` m of (x, y), whatever's between (−1 if none). */
  nearestUsable(x: number, y: number, reach: number, skip?: (id: number) => boolean): number {
    let best = -1;
    let bestD = Infinity;
    this.forNear(x, y, reach, reach, (id) => {
      const n = this.nodes[id]!;
      if (!n.usable || skip?.(id)) return;
      const d = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    });
    return best;
  }

  addNode(x: number, y: number, seg: number, oneWay: boolean, hazard: number): number {
    let clash = false;
    this.forNear(x, y, MERGE, MERGE, () => (clash = true));
    if (clash) return -1;
    const id = this.nodes.length;
    this.nodes.push({ id, x, y, seg, oneWay, surface: -1, hazard, usable: false });
    this.out.push([]);
    const cell = this.cellOf(x, y);
    const list = this.cells.get(cell);
    if (list) list.push(id);
    else this.cells.set(cell, [id]);
    return id;
  }

  /** The link from → to, or −1. */
  linkBetween(from: number, to: number): number {
    for (const l of this.out[from]!) if (this.links[l]!.to === to) return l;
    return -1;
  }

  addLink(from: number, to: number, kind: LinkKind, time: number, fuel: number, pad: boolean, early = false): void {
    const existing = this.linkBetween(from, to);
    if (existing >= 0) {
      const l = this.links[existing]!;
      if (time < l.time) Object.assign(l, { kind, time, fuel, pad, early });
      return;
    }
    const id = this.links.length;
    this.links.push({ id, from, to, kind, time, fuel, pad, early });
    this.out[from]!.push(id);
  }
}

/**
 * Strongly connected components of the graph's links (Tarjan, iterative). Each node gets the
 * smallest node id in its component: deterministic.
 */
function stronglyConnected(graph: NavGraph): Int32Array {
  const n = graph.nodes.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const work: [number, number][] = [];
  let next = 0;
  for (let root = 0; root < n; root++) {
    if (index[root]! >= 0) continue;
    work.push([root, 0]);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const v = frame[0];
      if (frame[1] === 0) {
        index[v] = low[v] = next++;
        stack.push(v);
        onStack[v] = 1;
      }
      const out = graph.out[v]!;
      let descended = false;
      while (frame[1] < out.length) {
        const w = graph.links[out[frame[1]++]!]!.to;
        if (index[w]! < 0) {
          work.push([w, 0]);
          descended = true;
          break;
        }
        if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
      }
      if (descended) continue;
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]![0];
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        const members: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          members.push(w);
        } while (w !== v);
        const id = Math.min(...members);
        for (const m of members) comp[m] = id;
      }
    }
  }
  return comp;
}

/** Even-odd point-in-polygon against the map's solids (the collision world only knows edges). */
export function insideSolid(map: MapDef, x: number, y: number): boolean {
  for (const poly of map.solids) {
    const pts = poly.points;
    let inside = false;
    for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      const xi = pts[i]!;
      const yi = pts[i + 1]!;
      const xj = pts[j]!;
      const yj = pts[j + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** Builds the graph for a map (see the file header). Tens of milliseconds for the shipped maps. */
export function buildNavGraph(map: MapDef, world: CollisionWorld, t: Tuning): NavGraph {
  const graph = new NavGraph(map, world);
  const mech = MapMechanics.compile(map);
  const probe = new Probe(world, t, mech, map);
  const cosMax = simCos(t.maxWalkSlopeDeg * DEG2RAD);
  const env = createBodyEnv();

  // 1. nodes: settle a probe on samples of every walkable segment
  for (let s = 0; s < world.segCount; s++) {
    const oneWay = (world.flags[s]! & SegFlag.OneWay) !== 0;
    if (!oneWay && world.ny[s]! < cosMax) continue;
    const ax = world.ax[s]!;
    const ay = world.ay[s]!;
    const bx = world.bx[s]!;
    const by = world.by[s]!;
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const span = x1 - x0;
    if (span < 0.2) continue;
    const n = Math.max(1, Math.round(span / NODE_SPACING));
    for (let i = 0; i <= n; i++) {
      const x = span > 2 * END_INSET ? Math.min(x1 - END_INSET, Math.max(x0 + END_INSET, x0 + (span * i) / n)) : (x0 + x1) / 2;
      const y = ay + ((by - ay) * (x - ax)) / (bx - ax);
      probe.place(x, y + 0.02);
      if (!probe.settle()) continue;
      const p = probe.p;
      if (Math.abs(p.x - x) > 0.25 || Math.abs(p.y - y) > 0.25) continue;
      // inside a solid (a tower standing on the floor) or touching one: not a place to stand
      if (insideSolid(map, p.x, p.y + t.standHeight / 2) || overlaps(world, p.x, p.y, t.standHeight, t.capsuleRadius, p.y)) continue;
      let hazard = 0;
      if (mech) {
        mech.envAt(p.x, p.y + t.standHeight / 2, env);
        // nobody stands in zero-g or reversed gravity (a nudge and you float): air links cross it
        if (env.gravityMul < 0.2) continue;
        if (env.moveSpeedMul < 1) hazard += 1 / Math.max(0.1, env.moveSpeedMul) - 1;
        if (env.jetDisabled) hazard += 0.5;
      }
      graph.addNode(p.x, p.y, s, oneWay, hazard);
    }
  }

  // 2. walk links: the nearest node on each side, if the probe walks there
  const motor = new Motor();
  const goal: MotorGoal = { x: 0, y: 0, jet: false, early: false };
  const speed = t.walkMax * 0.9;
  for (const a of graph.nodes) {
    for (const side of [-1, 1]) {
      let best = -1;
      let bestD = Infinity;
      graph.forNear(a.x, a.y, WALK_REACH_X, WALK_REACH_Y, (id) => {
        const b = graph.nodes[id]!;
        const dx = (b.x - a.x) * side;
        if (dx < 0.2) return;
        const d = dx + 2 * Math.abs(b.y - a.y);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      });
      if (best < 0) continue;
      const b = graph.nodes[best]!;
      probe.place(a.x, a.y + 0.02);
      if (!probe.settle()) continue;
      motor.reset();
      goal.x = b.x;
      goal.y = b.y;
      goal.jet = false;
      const maxTicks = Math.ceil((Math.abs(b.x - a.x) / speed + 0.6) * 60);
      const p = probe.p;
      for (let k = 1; k <= maxTicks; k++) {
        probe.step(motor.step(world, p, t, probe.feel(), goal));
        if (probe.dead) break;
        if (p.grounded && Math.abs(p.x - b.x) < 0.15 && Math.abs(p.y - b.y) < 0.3) {
          graph.addLink(a.id, b.id, LinkKind.Walk, k / 60, 0, false);
          break;
        }
      }
    }
  }

  // 3. surfaces: strongly connected components of the walk links (walk both ways between any two
  // nodes of a surface); a ledge you can walk off but not up splits it, so air links get tried there
  const scc = stronglyConnected(graph);
  for (const n of graph.nodes) n.surface = scc[n.id]!;

  // 4. air links: to the nearest node of every other surface in range, if the probe gets there
  goal.jet = true;
  const nearestBySurface = new Map<number, number>();
  for (const a of graph.nodes) {
    nearestBySurface.clear();
    const dist = new Map<number, number>();
    graph.forNear(a.x, a.y + (AIR_REACH_UP - AIR_REACH_DOWN) / 2, AIR_REACH_X, (AIR_REACH_UP + AIR_REACH_DOWN) / 2, (id) => {
      const b = graph.nodes[id]!;
      if (b.surface === a.surface) return;
      const d = (b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y);
      const prev = dist.get(b.surface);
      if (prev === undefined || d < prev || (d === prev && id < nearestBySurface.get(b.surface)!)) {
        dist.set(b.surface, d);
        nearestBySurface.set(b.surface, id);
      }
    });
    const targets = [...nearestBySurface.values()].sort((x, y) => x - y);
    for (const bid of targets) {
      goal.early = false;
      if (flyAirLink(graph, probe, motor, goal, a.id, bid, t)) continue;
      goal.early = true;
      flyAirLink(graph, probe, motor, goal, a.id, bid, t);
    }
  }

  // 5. usable nodes: reachable from a spawn, and a spawn is reachable from them
  const spawns = map.spawns.map((s) => graph.nearest(s.x, s.y, 2)).filter((n) => n >= 0);
  const fwd = reach(graph, spawns, false);
  const back = reach(graph, spawns, true);
  for (const n of graph.nodes) n.usable = fwd[n.id] === 1 && back[n.id] === 1;
  return graph;
}

/** Nodes reachable from `from` along the links (or against them, `reverse`). */
function reach(graph: NavGraph, from: readonly number[], reverse: boolean): Uint8Array {
  const seen = new Uint8Array(graph.nodes.length);
  const into: number[][] = reverse ? graph.nodes.map(() => []) : [];
  if (reverse) for (const l of graph.links) into[l.to]!.push(l.from);
  const queue = [...from];
  for (const n of queue) seen[n] = 1;
  while (queue.length) {
    const n = queue.pop()!;
    const next = reverse ? into[n]! : graph.out[n]!.map((l) => graph.links[l]!.to);
    for (const m of next) {
      if (seen[m]) continue;
      seen[m] = 1;
      queue.push(m);
    }
  }
  return seen;
}

/** Flies the probe from node `aid` toward node `bid` and records the link it found, if any (true). */
function flyAirLink(graph: NavGraph, probe: Probe, motor: Motor, goal: MotorGoal, aid: number, bid: number, t: Tuning): boolean {
  const a = graph.nodes[aid]!;
  const b = graph.nodes[bid]!;
  probe.place(a.x, a.y + 0.02);
  if (!probe.settle()) return false;
  motor.reset();
  goal.x = b.x;
  goal.y = b.y;
  const p = probe.p;
  let minFuel = p.fuel;
  let pad = false;
  let best = Infinity;
  let stall = 0;
  let resting = 0;
  const maxTicks = AIR_MAX_TIME * 60;
  for (let k = 1; k <= maxTicks; k++) {
    probe.step(motor.step(graph.world, p, t, probe.feel(), goal));
    if (probe.dead) return false;
    minFuel = Math.min(minFuel, p.fuel);
    if (probe.env && probe.env.padCount > 0) pad = true;
    if (p.grounded) {
      if (Math.abs(p.x - b.x) < 0.45 && Math.abs(p.y - b.y) < 0.35) {
        graph.addLink(aid, bid, LinkKind.Air, k / 60, t.fuelMax - minFuel, pad, goal.early);
        return true;
      }
      // landed and stopped somewhere else: a link to there if it's another surface
      if (Math.abs(p.vx) < 0.5 && ++resting >= 8) {
        const n = graph.nearest(p.x, p.y, 0.6);
        if (n < 0 || graph.nodes[n]!.surface === a.surface) return false;
        graph.addLink(aid, n, LinkKind.Air, k / 60, t.fuelMax - minFuel, pad, goal.early);
        return true;
      }
    } else resting = 0;
    const d = Math.abs(p.x - b.x) + Math.abs(p.y - b.y);
    if (d < best - 0.05) {
      best = d;
      stall = 0;
    } else if (++stall > AIR_STALL_TIME * 60) return false;
  }
  return false;
}
