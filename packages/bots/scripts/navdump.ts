/** A map's nav surfaces and the links between them, and the spawns' nodes: `pnpm --filter @military-forge/bots nav:dump <map>` */
import { getMap } from '@military-forge/content';
import { Game } from '@military-forge/sim';
import { buildNavGraph } from '../src/nav/graph';

const map = getMap(process.argv[2] ?? 'storm-front');
const game = new Game({ map });
const g = buildNavGraph(map, game.world, game.tuning);
const surf = new Map<number, number[]>();
for (const n of g.nodes) {
  const l = surf.get(n.surface) ?? [];
  l.push(n.id);
  surf.set(n.surface, l);
}
for (const [s, ids] of [...surf].sort((a, b) => a[0] - b[0])) {
  const xs = ids.map((i) => g.nodes[i]!.x);
  const ys = ids.map((i) => g.nodes[i]!.y);
  const outSurf = new Map<number, number>();
  for (const i of ids) for (const l of g.out[i]!) {
    const ln = g.links[l]!;
    const ts = g.nodes[ln.to]!.surface;
    if (ts !== s) outSurf.set(ts, (outSurf.get(ts) ?? 0) + 1);
  }
  console.log(`S${s} n=${ids.length} x ${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)} y ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)} oneWay=${g.nodes[ids[0]!]!.oneWay} hazard=${g.nodes[ids[0]!]!.hazard.toFixed(2)} → ${[...outSurf].map(([k, v]) => `S${k}×${v}`).join(' ')}`);
}
console.log('zones', JSON.stringify(map.zones?.map((z) => [z.kind, (z as { rect?: number[] }).rect]) ?? []));
for (const [i, s] of map.spawns.entries()) {
  const n = g.nearest(s.x, s.y, 2);
  console.log(`spawn ${i} (${s.x}, ${s.y}) → node ${n} ${n >= 0 ? `S${g.nodes[n]!.surface} (${g.nodes[n]!.x.toFixed(2)}, ${g.nodes[n]!.y.toFixed(2)})` : ''}`);
}
