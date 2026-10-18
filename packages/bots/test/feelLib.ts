/**
 * Bot feel measurements (NOTES §23), shared by `pnpm --filter @military-forge/bots feel` and the
 * feel test: a bot against a standing target on a flat range.
 */
import { weapons, type MapDef, type MapPolygon } from '@military-forge/content';
import { Btn, Game, type Input, type PlayerState } from '@military-forge/sim';
import { addBot } from '../src';
import { BotBrain } from '../src/brain';
import { botLevel, type BotLevelId } from '../src/levels';

function rect(x0: number, y0: number, x1: number, y1: number): MapPolygon {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1] };
}

/** Flat floor at y = 0 from x = 0 to 80, walls at both ends, ceiling at 28. */
export const RANGE_MAP: MapDef = {
  id: 'bot-range',
  name: 'Bot range',
  bounds: { minX: -2, minY: -6, maxX: 82, maxY: 30 },
  solids: [rect(-2, -6, 82, 0), rect(-2, 0, 0, 28), rect(80, 0, 82, 28), rect(-2, 28, 82, 30)],
  oneWays: [],
  spawns: [{ x: 20, y: 0 }],
  dummies: [],
  labels: [],
};

/** A bot that aims and shoots but doesn't move (pure aim measurements). */
class PinnedBrain extends BotBrain {
  override think(game: Game, self: PlayerState, out: Input): void {
    super.think(game, self, out);
    out.buttons &= ~(Btn.Left | Btn.Right | Btn.Jet | Btn.Down | Btn.Dash);
  }
}

export interface DuelResult {
  /** the gun's hits / bullets fired (grenades and bashes aside) */
  hitRate: number;
  /** mean seconds from the start (target in view) to the kill, over duels that ended in one */
  ttk: number;
  /** duels that ended in a kill within the time limit */
  killRate: number;
}

/**
 * `samples` duels: a `level` bot with `weapon` in hand starts `distance` m from a standing target
 * (in view at once); each runs until the kill or `limit` s.
 */
export function measureDuel(level: BotLevelId, weaponId: string, distance: number, pinned: boolean, samples = 20, limit = 15): DuelResult {
  const def = weapons.find((w) => w.id === weaponId)!;
  let shots = 0;
  let hits = 0;
  let kills = 0;
  let ttkSum = 0;
  for (let s = 0; s < samples; s++) {
    const game = new Game({ map: RANGE_MAP, seed: 1000 + s });
    const target = game.addDummy({ name: 'target', x: 50, y: 0, script: { kind: 'idle' } });
    const bot = addBot(game, { level });
    if (pinned) bot.brain = new PinnedBrain(game, botLevel(level), 0);
    game.setLoadout(bot, [def.index, def.index]);
    bot.spawn(50 - distance, 0.01, game.tuning);
    let killed = -1;
    for (let t = 0; t < limit * 60 && killed < 0; t++) {
      game.step([]);
      for (const e of game.events) {
        if (e.type === 'shot' && e.shooter === bot.id) shots += def.pellets;
        else if (e.type === 'hit' && e.attacker === bot.id && e.target === target.id && e.source === def.index) hits++;
        else if (e.type === 'death' && e.victim === target.id) killed = t + 1;
      }
    }
    if (killed >= 0) {
      kills++;
      ttkSum += killed / 60;
    }
  }
  return { hitRate: shots ? hits / shots : 0, ttk: kills ? ttkSum / kills : Infinity, killRate: kills / samples };
}
