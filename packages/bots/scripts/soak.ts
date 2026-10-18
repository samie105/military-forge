/**
 * No-stuck soak: bots play every registered map for a while and we measure how long each spends
 * stuck (alive, not frozen, and moved less than 0.5 m over the last 3 s).
 *   pnpm --filter @military-forge/bots soak [minutes=5] [bots=4] [level=normal] [map]
 */
import { maps } from '@military-forge/content';
import { Game } from '@military-forge/sim';
import { addBots, type BotLevelId } from '../src';
import { soakMap } from '../test/soakLib';

const minutes = Number(process.argv[2] ?? 5);
const count = Number(process.argv[3] ?? 4);
const level = (process.argv[4] ?? 'normal') as BotLevelId;
const only = process.argv[5];
for (const map of Object.values(maps)) {
  if (only && map.id !== only) continue;
  const game = new Game({ map, seed: 7, pickups: true });
  addBots(game, count, level);
  const t0 = performance.now();
  const r = soakMap(game, minutes * 60 * 60);
  const ms = performance.now() - t0;
  console.log(
    `${map.id.padEnd(15)} stuck ${(100 * r.stuckFraction).toFixed(2)}% (worst bot ${r.worstStuckSeconds.toFixed(0)} s) · ` +
      `${r.deaths} deaths · ${r.kills} kills · moved ${r.metresPerBotMinute.toFixed(0)} m/bot/min · ` +
      `beyond reach ${r.beyondReach}/${r.targetShots} shots · dry ${(100 * r.dryFraction).toFixed(1)}% (Fire held dry ${r.dryFireTicks}) · ` +
      `${(ms / (minutes * 60 * 60)).toFixed(3)} ms/tick${r.stuckAt.length ? ' · stuck at ' + r.stuckAt.slice(0, 5).join(' ') : ''}`,
  );
}
