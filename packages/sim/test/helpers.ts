import type { DummySpawn, MapDef, MapOneWay, MapPolygon } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { Game, createInput, type Input, type PlayerState } from '../src';

export function rect(x0: number, y0: number, x1: number, y1: number): MapPolygon {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1] };
}

/** A hill rising at `deg` from x0 to `height`, with a plateau, then back down. */
export function hill(x0: number, deg: number, height: number, plateau: number): MapPolygon {
  const run = height / Math.tan((deg * Math.PI) / 180);
  return { points: [x0, 0, x0 + run, height, x0 + run + plateau, height, x0 + 2 * run + plateau, 0] };
}

/** Flat floor at y = 0 from x = 0 to `width`, walls at both ends, ceiling at 28. */
export function flatMap(extra: MapPolygon[] = [], oneWays: MapOneWay[] = [], width = 60): MapDef {
  return {
    id: 'test-flat',
    name: 'Test Flat',
    bounds: { minX: -2, minY: -6, maxX: width + 2, maxY: 30 },
    solids: [rect(-2, -6, width + 2, 0), rect(-2, 0, 0, 28), rect(width, 0, width + 2, 28), rect(-2, 28, width + 2, 30), ...extra],
    oneWays,
    spawns: [{ x: 5, y: 0 }],
    dummies: [],
    labels: [],
  };
}

export function makeGame(map: MapDef, seed = 1): { game: Game; p: PlayerState } {
  const game = new Game({ map, seed });
  const p = game.addPlayer('tester');
  return { game, p };
}

export function dummyAt(game: Game, x: number, y = 0, script: DummySpawn['script'] = { kind: 'idle' }): PlayerState {
  return game.addDummy({ name: 'dummy', x, y, script });
}

const input: Input = createInput();

/** Holds `buttons` for `n` ticks while aiming at `aimRad`. */
export function hold(game: Game, p: PlayerState, buttons: number, n: number, aimRad = 0): void {
  input.buttons = buttons;
  input.aim = angleToU16(aimRad);
  const inputs: (Input | undefined)[] = [];
  inputs[p.id] = input;
  for (let i = 0; i < n; i++) game.step(inputs);
}

/** Places a player standing at x on flat ground and lets them settle. */
export function placeOnGround(game: Game, p: PlayerState, x: number, y = 0): void {
  p.x = x;
  p.y = y + 0.01;
  p.vx = 0;
  p.vy = 0;
  p.grounded = false;
  hold(game, p, 0, 5);
}
