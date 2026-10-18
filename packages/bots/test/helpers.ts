import type { DummySpawn, MapDef, MapPolygon } from '@military-forge/content';
import { createInput, Game, type Input, type PlayerState } from '@military-forge/sim';
import { addBot, type BotSpec } from '../src';
import { BotBrain } from '../src/brain';

export function rect(x0: number, y0: number, x1: number, y1: number): MapPolygon {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1] };
}

/** Flat floor at y = 0 from x = 0 to `width`, walls at both ends, ceiling at 28, spawns as given. */
export function flatMap(extra: MapPolygon[] = [], spawns = [{ x: 10, y: 0 }], width = 80): MapDef {
  return {
    id: `bots-flat-${width}-${extra.length}-${spawns.length}`,
    name: 'Bots flat',
    bounds: { minX: -2, minY: -6, maxX: width + 2, maxY: 30 },
    solids: [rect(-2, -6, width + 2, 0), rect(-2, 0, 0, 28), rect(width, 0, width + 2, 28), rect(-2, 28, width + 2, 30), ...extra],
    oneWays: [],
    spawns,
    dummies: [],
    labels: [],
  };
}

export function brainOf(p: PlayerState): BotBrain {
  if (!(p.brain instanceof BotBrain)) throw new Error(`${p.name} has no bot brain`);
  return p.brain;
}

/** A bot placed standing at x on the floor (its brain forgets the spawn it came from). */
export function botAt(game: Game, x: number, spec: BotSpec = {}, y = 0): PlayerState {
  const p = addBot(game, spec);
  p.spawn(x, y + 0.01, game.tuning);
  return p;
}

export function dummyAt(game: Game, x: number, y = 0, script: DummySpawn['script'] = { kind: 'idle' }): PlayerState {
  return game.addDummy({ name: 'dummy', x, y, script });
}

/** Steps the game `n` ticks; `human` (if given) holds `input`. Returns every event seen. */
export function run(game: Game, n: number, human?: PlayerState, input: Input = createInput()) {
  const inputs: (Input | undefined)[] = [];
  const events: Game['events'][number][] = [];
  for (let i = 0; i < n; i++) {
    if (human) inputs[human.id] = input;
    game.step(inputs);
    events.push(...game.events);
  }
  return events;
}
