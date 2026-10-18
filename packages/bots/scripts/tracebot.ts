/** A seeded game of Normal bots to `from` s, then one bot's state every 3 ticks: `pnpm --filter @military-forge/bots trace <map> <bots> <name> <from> <secs>` */
import { getMap } from '@military-forge/content';
import { Game } from '@military-forge/sim';
import { addBots, BotBrain } from '../src';
const [mapId, count, name, from, secs] = process.argv.slice(2);
const game = new Game({ map: getMap(mapId ?? 'flux-lab'), seed: 7 });
const bots = addBots(game, Number(count ?? 6), 'normal');
const p = bots.find((b) => b.name.includes(name ?? 'Mantis'))!;
const start = Math.round(Number(from ?? 115) * 60);
for (let t = 0; t < start + Math.round(Number(secs ?? 2) * 60); t++) {
  game.step([]);
  if (t < start || t % 3) continue;
  const b = p.brain as BotBrain;
  const l = b.nav.link;
  console.log(`${(t / 60).toFixed(2)} (${p.x.toFixed(2)},${p.y.toFixed(2)}) v(${p.vx.toFixed(2)},${p.vy.toFixed(2)}) g=${p.grounded} btn=${p.input.buttons} hp=${p.hp.toFixed(0)} mode=${b.mode} link=${l ? `${l.kind ? 'A' : 'W'}${l.from}→${l.to}(${b.graph.nodes[l.to]!.x.toFixed(1)},${b.graph.nodes[l.to]!.y.toFixed(1)})` : '-'} goal=${b.nav.goal} tgt=${b.target}`);
}
