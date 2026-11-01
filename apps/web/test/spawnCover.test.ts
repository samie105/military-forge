/** Spawn cover as an online client follows it (audit B-10): from the spawn and attack events, no wire change. */
import { SPAWN_COVER } from '@military-forge/content';
import type { SimEvent } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { SpawnCoverWatch } from '../src/spawnCover';

const spawn = (player: number): SimEvent => ({ type: 'spawn', player });
const shot = (shooter: number): SimEvent => ({ type: 'shot', shooter, weapon: 0, ox: 0, oy: 0, ex: 1, ey: 0, hit: 0, target: -1, zone: 0 });

describe('spawn cover, online', () => {
  it(`starts at a spawn and lasts ${SPAWN_COVER.seconds} s`, () => {
    const w = new SpawnCoverWatch();
    w.onEvents([spawn(3)]);
    expect(w.has(3)).toBe(true);
    expect(w.has(4)).toBe(false);
    w.advance(SPAWN_COVER.seconds - 0.1);
    expect(w.has(3)).toBe(true);
    w.advance(0.2);
    expect(w.has(3)).toBe(false);
  });

  it('ends when that player fires, throws or launches, or dies', () => {
    const w = new SpawnCoverWatch();
    w.onEvents([spawn(1), spawn(2), spawn(3), spawn(4)]);
    w.onEvents([shot(1), { type: 'throw', owner: 2, grenade: 0 }, { type: 'launch', owner: 3, grenade: 0, weapon: 0 }, { type: 'death', victim: 4, killer: 4, source: 0 }]);
    for (const id of [1, 2, 3, 4]) expect(w.has(id)).toBe(false);
  });

  it('the admin turning it off (0 s) shows none', () => {
    const was = SPAWN_COVER.seconds;
    SPAWN_COVER.seconds = 0;
    try {
      const w = new SpawnCoverWatch();
      w.onEvents([spawn(1)]);
      expect(w.has(1)).toBe(false);
    } finally {
      SPAWN_COVER.seconds = was;
    }
  });
});
