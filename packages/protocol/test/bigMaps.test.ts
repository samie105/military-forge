/**
 * Big maps on the wire (maps-vertical): every position a snapshot carries must survive the trip
 * anywhere on every registered map. Positions are 24-bit at 1/1024 m (±8 km), but SOUND events
 * carry 8-bit cells of 4 m: ±127 cells, so no map may reach past ±500 m from the origin.
 */
import { maps, type MapDef } from '@military-forge/content';
import { Btn, Game, createInput } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { SnapshotBaselines, SnapshotDecoder, SnapshotEncoder, type ViewRect } from '../src';

/** the farthest from the origin a map may reach (m): SOUND's ±127 cells of 4 m, less a cell */
const MAX_MAP_EXTENT = 500;

/** fires from (x, y) unseen by a viewer elsewhere; what the viewer decodes */
function soundFrom(map: MapDef, x: number, y: number) {
  const game = new Game({ map, seed: 2 });
  const me = game.addPlayer('me');
  const far = game.addPlayer('far');
  const inputs: ReturnType<typeof createInput>[] = [];
  inputs[far.id] = { ...createInput(), buttons: Btn.Fire };
  far.x = x;
  far.y = y;
  game.step(inputs);
  // the shot happens where `far` stood (the step may move it a hair)
  const view: ViewRect = { minX: me.x - 1, minY: me.y - 1, maxX: me.x + 1, maxY: me.y + 1 };
  const enc = new SnapshotEncoder();
  enc.begin(game, 1, game.events);
  const snap = new SnapshotDecoder().decode(enc.encodeFor({ baselines: new SnapshotBaselines(), ackInputTick: 0, inputBufferHealth: 0, local: me, view }));
  return { snap, far, me };
}

describe('big maps on the wire', () => {
  for (const map of Object.values(maps)) {
    it(`${map.id}: fits SOUND's range`, () => {
      const b = map.bounds;
      for (const v of [b.minX, b.minY, b.maxX, b.maxY]) expect(Math.abs(v)).toBeLessThanOrEqual(MAX_MAP_EXTENT);
    });
  }

  it('a shot heard from a corner of a 1 km map decodes near where it was fired', () => {
    const big: MapDef = {
      ...maps['vertical-test']!,
      id: 'big',
      bounds: { minX: -MAX_MAP_EXTENT, minY: -MAX_MAP_EXTENT, maxX: MAX_MAP_EXTENT, maxY: MAX_MAP_EXTENT },
    };
    for (const [x, y] of [
      [-499, -499],
      [499, 499],
      [-499, 499],
      [499, -499],
    ] as const) {
      const { snap, far } = soundFrom(big, x, y);
      const sounds = snap.events.filter((e) => e.type === 'sound') as { x: number; y: number }[];
      expect(sounds).toHaveLength(1);
      // half a cell of rounding, plus the muzzle's reach from the feet (no wrap-around)
      expect(Math.abs(sounds[0]!.x - far.x)).toBeLessThanOrEqual(3.5);
      expect(Math.abs(sounds[0]!.y - far.y)).toBeLessThanOrEqual(3.5);
    }
  });

  it('players at the top of a tall map decode exactly, in full and as deltas', () => {
    const map = maps['vertical-test']!;
    const game = new Game({ map, seed: 4 });
    const me = game.addPlayer('me');
    const other = game.addPlayer('other');
    other.x = 100;
    other.y = map.bounds.maxY - 3;
    const enc = new SnapshotEncoder();
    const baselines = new SnapshotBaselines();
    const dec = new SnapshotDecoder();
    enc.begin(game, 1, []);
    const first = dec.decode(enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: me, view: null }));
    const at = first.players.find((p) => p.id === other.id)!;
    expect(at.y).toBeCloseTo(other.y, 3);
    baselines.ack(1);
    // a long fall in one snapshot (past the ±4 m small-delta range) and a short one
    for (const dy of [-60, -1.5]) {
      other.y += dy;
      game.step([]);
      enc.begin(game, 2 + Math.abs(dy), []);
      const s = dec.decode(enc.encodeFor({ baselines, ackInputTick: 0, inputBufferHealth: 0, local: me, view: null }));
      expect(s.players.find((p) => p.id === other.id)!.y).toBeCloseTo(other.y, 3);
    }
  });
});
