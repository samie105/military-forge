/**
 * A* over the nav graph. Costs are seconds (a link's cost comes from the caller, so each bot can
 * weigh fuel, hazards and links that failed it); the heuristic is the straight-line distance at a
 * fast fall's speed, so it never overestimates. Ties break on node id: deterministic. `nearest`
 * is the same search without a heuristic (Dijkstra): the cheapest node that passes a test.
 */
import type { NavGraph, NavLink } from './graph';

/** m/s: faster than any way through the graph (terminal fall speed) */
const HEURISTIC_SPEED = 16;

export class PathFinder {
  private readonly g: Float64Array;
  private readonly via: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closed: Uint32Array;
  private run = 0;
  /** binary heap of (f, node id) entries, ordered by f then id; stale entries are skipped on pop */
  private readonly heapF: number[] = [];
  private readonly heapId: number[] = [];

  constructor(readonly graph: NavGraph) {
    const n = graph.nodes.length;
    this.g = new Float64Array(n);
    this.via = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  /**
   * Fills `out` with the link ids from `start` to `goal` (empty when start === goal). Returns false
   * when there's no way. `cost(link)` < 0 skips the link.
   */
  find(start: number, goal: number, cost: (link: NavLink) => number, out: number[]): boolean {
    out.length = 0;
    if (start === goal) return true;
    const nodes = this.graph.nodes;
    const run = ++this.run;
    const gx = nodes[goal]!.x;
    const gy = nodes[goal]!.y;
    const h = (id: number) => {
      const n = nodes[id]!;
      const dx = n.x - gx;
      const dy = n.y - gy;
      return Math.sqrt(dx * dx + dy * dy) / HEURISTIC_SPEED;
    };
    this.heapF.length = 0;
    this.heapId.length = 0;
    this.stamp[start] = run;
    this.g[start] = 0;
    this.via[start] = -1;
    this.push(h(start), start);
    while (this.heapId.length) {
      const cur = this.pop();
      if (this.closed[cur] === run) continue;
      this.closed[cur] = run;
      if (cur === goal) {
        for (let id = goal; id !== start; ) {
          const l = this.via[id]!;
          out.push(l);
          id = this.graph.links[l]!.from;
        }
        out.reverse();
        return true;
      }
      const gCur = this.g[cur]!;
      for (const lid of this.graph.out[cur]!) {
        const link = this.graph.links[lid]!;
        const to = link.to;
        if (this.closed[to] === run) continue;
        const c = cost(link);
        if (c < 0) continue;
        const gNew = gCur + c;
        if (this.stamp[to] === run && gNew >= this.g[to]!) continue;
        this.stamp[to] = run;
        this.g[to] = gNew;
        this.via[to] = lid;
        this.push(gNew + h(to), to);
      }
    }
    return false;
  }

  /**
   * The cheapest node from `start` that passes `isGoal` (start itself included), at most `maxCost`
   * seconds away, with the link ids there in `out`; −1 when there's none.
   */
  nearest(start: number, isGoal: (node: number) => boolean, cost: (link: NavLink) => number, maxCost: number, out: number[]): number {
    out.length = 0;
    const run = ++this.run;
    this.heapF.length = 0;
    this.heapId.length = 0;
    this.stamp[start] = run;
    this.g[start] = 0;
    this.via[start] = -1;
    this.push(0, start);
    while (this.heapId.length) {
      const cur = this.pop();
      if (this.closed[cur] === run) continue;
      this.closed[cur] = run;
      const gCur = this.g[cur]!;
      if (gCur > maxCost) return -1;
      if (isGoal(cur)) {
        for (let id = cur; id !== start; ) {
          const l = this.via[id]!;
          out.push(l);
          id = this.graph.links[l]!.from;
        }
        out.reverse();
        return cur;
      }
      for (const lid of this.graph.out[cur]!) {
        const link = this.graph.links[lid]!;
        const to = link.to;
        if (this.closed[to] === run) continue;
        const c = cost(link);
        if (c < 0) continue;
        const gNew = gCur + c;
        if (this.stamp[to] === run && gNew >= this.g[to]!) continue;
        this.stamp[to] = run;
        this.g[to] = gNew;
        this.via[to] = lid;
        this.push(gNew, to);
      }
    }
    return -1;
  }

  private push(f: number, id: number): void {
    const hf = this.heapF;
    const hi = this.heapId;
    hf.push(f);
    hi.push(id);
    let i = hf.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private pop(): number {
    const hf = this.heapF;
    const hi = this.heapId;
    const top = hi[0]!;
    const lastF = hf.pop()!;
    const lastId = hi.pop()!;
    if (hi.length) {
      hf[0] = lastF;
      hi[0] = lastId;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < hi.length && this.less(l, m)) m = l;
        if (r < hi.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const fa = this.heapF[a]!;
    const fb = this.heapF[b]!;
    return fa < fb || (fa === fb && this.heapId[a]! < this.heapId[b]!);
  }

  private swap(a: number, b: number): void {
    const hf = this.heapF;
    const hi = this.heapId;
    const f = hf[a]!;
    hf[a] = hf[b]!;
    hf[b] = f;
    const id = hi[a]!;
    hi[a] = hi[b]!;
    hi[b] = id;
  }
}
