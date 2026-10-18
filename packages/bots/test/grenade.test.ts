import { FRAG, SMOKE } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { Btn, DamageSource, Game, createInput, type Input } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { solveThrow } from '../src/grenadier';
import { botAt, dummyAt, flatMap, rect } from './helpers';

describe('grenades: the sim’s own physics, never into its own blast', () => {
  it('finds a throw that goes off near a target 12 m away, and the sim agrees', () => {
    const game = new Game({ map: flatMap() });
    const me = game.addPlayer('thrower');
    me.spawn(20, 0.01, game.tuning);
    for (let i = 0; i < 5; i++) game.step([]);
    const shot = solveThrow(game, me, 32, 0)!;
    expect(shot).not.toBeNull();
    expect(shot.miss).toBeLessThanOrEqual(2.5);
    expect(Math.abs(shot.x - me.x)).toBeGreaterThan(FRAG.explosion.radius + 2 - 1e-6);

    // throw it for real: the explosion lands where the solver said
    const input: Input = createInput();
    input.aim = angleToU16(shot.angle);
    input.throwStrength = shot.strength;
    const inputs: (Input | undefined)[] = [];
    inputs[me.id] = input;
    game.step(inputs); // turn to the throw angle first
    input.buttons = Btn.Grenade;
    let boom: { x: number; y: number } | null = null;
    for (let i = 0; i < 200 && !boom; i++) {
      game.step(inputs);
      input.buttons = 0;
      for (const e of game.events) if (e.type === 'explosion') boom = { x: e.x, y: e.y };
    }
    expect(boom).not.toBeNull();
    expect(Math.abs(boom!.x - shot.x)).toBeLessThan(0.5);
    expect(Math.abs(boom!.x - 32)).toBeLessThan(3);
  });

  it('refuses a throw at someone inside its own blast radius', () => {
    const game = new Game({ map: flatMap() });
    const me = game.addPlayer('thrower');
    me.spawn(20, 0.01, game.tuning);
    expect(solveThrow(game, me, 23, 0)).toBeNull();
  });

  it('a Hard bot lobs grenades at someone it hears behind a wall, and never hurts itself with them', () => {
    const game = new Game({ map: flatMap([rect(17, 0, 18, 3.5)]), seed: 3 });
    const bot = botAt(game, 10, { level: 'hard' });
    const human = game.addPlayer('human');
    human.spawn(26, 0.01, game.tuning);
    const input: Input = createInput();
    input.aim = angleToU16(Math.PI / 2); // shooting at the sky: loud, harmless
    const inputs: (Input | undefined)[] = [];
    inputs[human.id] = input;
    let throws = 0;
    let selfHarm = 0;
    for (let i = 0; i < 25 * 60; i++) {
      input.buttons = i % 2 === 0 ? Btn.Fire : 0;
      game.step(inputs);
      for (const e of game.events) {
        if (e.type === 'throw' && e.owner === bot.id) throws++;
        if (e.type === 'hit' && e.target === bot.id && e.attacker === bot.id && e.source === DamageSource.Grenade) selfHarm++;
      }
    }
    expect(throws).toBeGreaterThan(0);
    expect(selfHarm).toBe(0);
  });

  it('throws frags only (for now): back on frags when the belt sits on another type, never the others', () => {
    /** A Hard bot fighting a dummy 15 m away for up to `secs`, its belt as given; the types it threw. */
    const fight = (counts: Record<number, number>, selected: number, secs: number) => {
      const game = new Game({ map: flatMap(), seed: 3 });
      const bot = botAt(game, 10, { level: 'hard' });
      dummyAt(game, 25);
      bot.grenadeCounts.fill(0);
      for (const [type, n] of Object.entries(counts)) bot.grenadeCounts[Number(type)] = n;
      bot.grenadeType = selected;
      const thrown: number[] = [];
      for (let i = 0; i < secs * 60 && thrown.length === 0; i++) {
        game.step([]);
        for (const e of game.events) if (e.type === 'throw' && e.owner === bot.id) thrown.push(game.grenades[e.grenade]!.type);
      }
      return { bot, thrown };
    };
    const mixed = fight({ [FRAG.index]: 2, [SMOKE.index]: 2 }, SMOKE.index, 40);
    expect(mixed.thrown).toEqual([FRAG.index]);
    expect(mixed.bot.grenadeCounts[SMOKE.index]).toBe(2);
    const smokeOnly = fight({ [SMOKE.index]: 2 }, SMOKE.index, 20);
    expect(smokeOnly.thrown).toEqual([]);
    expect(smokeOnly.bot.grenadeCounts[SMOKE.index]).toBe(2);
  });
});
