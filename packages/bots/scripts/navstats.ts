/** Nav graph stats per map: size, build time, links by kind, spawn-to-spawn paths, sinks (`pnpm --filter @military-forge/bots nav`). */
import { maps } from '@military-forge/content';
import { Game } from '@military-forge/sim';
import { LinkKind, buildNavGraph } from '../src/nav/graph';
import { PathFinder } from '../src/nav/astar';

for (const map of Object.values(maps)) {
  const game = new Game({ map });
  const t0 = performance.now();
  const g = buildNavGraph(map, game.world, game.tuning);
  const ms = performance.now() - t0;
  const walk = g.links.filter((l) => l.kind === LinkKind.Walk).length;
  const air = g.links.length - walk;
  const pads = g.links.filter((l) => l.pad).length;
  const surfaces = new Set(g.nodes.map((n) => n.surface)).size;
  // reachability: from each spawn's nearest node, how many nodes can be reached
  const pf = new PathFinder(g);
  const out: number[] = [];
  const spawnNodes = map.spawns.map((s) => g.nearest(s.x, s.y, 2));
  let reachSum = 0;
  let pairs = 0;
  let ok = 0;
  for (const a of spawnNodes) {
    if (a < 0) continue;
    for (const b of spawnNodes) {
      if (b < 0 || a === b) continue;
      pairs++;
      if (pf.find(a, b, (l) => l.time, out)) ok++;
    }
  }
  // nodes reachable from spawn 0 (BFS)
  const seen = new Uint8Array(g.nodes.length);
  const q = spawnNodes.filter((n) => n >= 0).slice(0, 1);
  for (const n of q) seen[n] = 1;
  while (q.length) {
    const n = q.pop()!;
    for (const lid of g.out[n]!) {
      const to = g.links[lid]!.to;
      if (!seen[to]) {
        seen[to] = 1;
        q.push(to);
      }
    }
  }
  for (const s of seen) reachSum += s;
  // sinks: reachable from spawn 0 but unable to get back to it (reverse BFS over the links)
  const back = new Uint8Array(g.nodes.length);
  const rin: number[][] = g.nodes.map(() => []);
  for (const l of g.links) rin[l.to]!.push(l.from);
  const rq = spawnNodes.filter((n) => n >= 0).slice(0, 1);
  for (const n of rq) back[n] = 1;
  while (rq.length) {
    const n = rq.pop()!;
    for (const f of rin[n]!) if (!back[f]) { back[f] = 1; rq.push(f); }
  }
  const sinks: string[] = [];
  g.nodes.forEach((n, i) => { if (seen[i] && !back[i]) sinks.push(`(${n.x.toFixed(1)},${n.y.toFixed(1)})`); });
  // nodes that can't get back (sinks): reachable from spawn 0 but can't reach spawn 0
  console.log(
    `${map.id.padEnd(15)} nodes ${String(g.nodes.length).padStart(4)} surfaces ${String(surfaces).padStart(3)} walk ${String(walk).padStart(4)} air ${String(air).padStart(4)} (pad ${pads}) ` +
      `build ${ms.toFixed(0)} ms · spawns ${spawnNodes.filter((n) => n >= 0).length}/${map.spawns.length} · spawn↔spawn paths ${ok}/${pairs} · reachable from spawn0 ${reachSum}/${g.nodes.length} · sinks ${sinks.length}${sinks.length ? ' e.g. ' + sinks.slice(0, 6).join(' ') : ''}`,
  );
}
