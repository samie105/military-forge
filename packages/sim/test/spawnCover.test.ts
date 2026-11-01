/** Spawn cover (audit B-10: players were hit 0.35 s after spawning and dead about 2 s later). */
import { SPAWN_COVER } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, DamageSource, Game, createInput, hashGame, ticks } from '../src';
import { dummyAt, flatMap } from './helpers';

const idle = createInput();

function covered() {
  const game = new Game({ map: flatMap(), spawnCover: true });
  const a = game.addPlayer('A');
  const b = game.addPlayer('B');
  return { game, a, b };
}

describe('spawn cover', () => {
  it(`nobody else can hurt a player for ${SPAWN_COVER.seconds} s after a spawn; then they can`, () => {
    const { game, a, b } = covered();
    expect(b.coverTicks).toBe(ticks(SPAWN_COVER.seconds));
    game.damage(b, 40, a.id, DamageSource.Grenade, 2);
    expect(b.hp).toBe(100);
    expect(game.events.some((e) => e.type === 'hit')).toBe(false);
    for (let i = 0; i < ticks(SPAWN_COVER.seconds); i++) game.step([idle, idle]);
    expect(b.coverTicks).toBe(0);
    game.damage(b, 40, a.id, DamageSource.Grenade, 2);
    expect(b.hp).toBe(60);
  });

  it('ends the moment its player attacks (fire, grenade or melee); moving keeps it', () => {
    for (const button of [Btn.Fire, Btn.Grenade, Btn.Melee]) {
      const { game, a, b } = covered();
      game.step([idle, { ...idle, buttons: Btn.Right | Btn.Jet }]);
      expect(b.coverTicks).toBeGreaterThan(0);
      game.step([idle, { ...idle, buttons: button }]);
      expect(b.coverTicks).toBe(0);
      game.damage(b, 40, a.id, DamageSource.Grenade, 2);
      expect(b.hp).toBe(60);
    }
  });

  it('your own grenade still hurts you; a respawn after a death covers again', () => {
    const { game, a, b } = covered();
    game.damage(b, 30, b.id, DamageSource.Grenade, 2);
    expect(b.hp).toBe(70);
    b.coverTicks = 0;
    game.damage(b, 200, a.id, DamageSource.Grenade, 2);
    expect(b.alive).toBe(false);
    for (let i = 0; i < ticks(game.tuning.respawnDelay) + 1 && !b.alive; i++) game.step([idle, idle]);
    expect(b.alive).toBe(true);
    expect(b.coverTicks).toBeGreaterThan(0);
  });

  it("the range's dummies have none (they are there to be shot), and games without it are as before", () => {
    const { game } = covered();
    expect(dummyAt(game, 20).coverTicks).toBe(0);
    const plain = new Game({ map: flatMap() });
    const a = plain.addPlayer('A');
    const b = plain.addPlayer('B');
    expect(b.coverTicks).toBe(0);
    plain.damage(b, 40, a.id, DamageSource.Grenade, 2);
    expect(b.hp).toBe(60);
  });

  it('is in the state hash only while it runs (the golden replays, recorded without it, keep their hashes)', () => {
    const plain = new Game({ map: flatMap() });
    const { game } = covered();
    plain.addPlayer('A');
    plain.addPlayer('B');
    expect(hashGame(game)).not.toBe(hashGame(plain));
    for (let i = 0; i < ticks(SPAWN_COVER.seconds); i++) {
      game.step([idle, idle]);
      plain.step([idle, idle]);
    }
    expect(hashGame(game)).toBe(hashGame(plain));
  });
});
