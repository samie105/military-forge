import { Game } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { mapEventView } from '../src/mapEvent';

describe('map event view (docs/02 §20.7)', () => {
  it('follows the game: nothing, then the warning counting down, then the event with its zones', () => {
    const game = new Game({ mapId: 'mechanics-test', seed: 1234 });
    const step = (n: number) => {
      for (let i = 0; i < n; i++) game.step([]);
    };
    step(60);
    expect(mapEventView(game)).toBeNull();
    step(90 - 60 + 60); // tick 150: the surge's warning (120–179)
    const warning = mapEventView(game)!;
    expect(warning).toMatchObject({ id: 'surge', kind: 'gravitySurge', name: 'GRAVITY SURGE', phase: 'warning' });
    expect(warning.secondsLeft).toBeCloseTo(31 / 60, 9); // read at the last tick simulated, 149: 31 to go
    step(60);
    expect(mapEventView(game)).toMatchObject({ id: 'surge', phase: 'active' });
    // the pocket (36 s in): one picked site
    step(2290 - game.tick);
    const pocket = mapEventView(game)!;
    expect(pocket).toMatchObject({ id: 'pocket', phase: 'active' });
    expect(pocket.zones).toHaveLength(1);
    expect(game.map.zones![pocket.zones[0]!]!.event).toBe('pocket');
  });

  it('is null on maps without events', () => {
    expect(mapEventView(new Game({ mapId: 'movement-test' }))).toBeNull();
  });
});
