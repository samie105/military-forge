import { BREACHER, BUZZ, DRAGON, HAMMER, K47, POPPER, RIPPER, THUMPER, WIDOW, type WeaponDef } from '@military-forge/content';
import { Btn, DamageSource, Game, type PlayerState } from '@military-forge/sim';
import { Xoshiro128 } from '@military-forge/shared';
import { describe, expect, it } from 'vitest';
import { Gunner, weaponValue } from '../src/gunner';
import { BOT_LEVELS } from '../src/levels';
import { botAt, brainOf, dummyAt, flatMap, run } from './helpers';

/** A bot with `w` in both hands facing a standing dummy `dist` m away; returns its buttons per tick. */
function duel(w: WeaponDef, dist: number, ticks: number, level: 'easy' | 'normal' | 'hard' = 'normal') {
  const game = new Game({ map: flatMap(), seed: 5 });
  const target = dummyAt(game, 50);
  const bot = botAt(game, 50 - dist, { level });
  game.setLoadout(bot, [w.index, w.index]);
  const buttons: number[] = [];
  const events = [];
  for (let i = 0; i < ticks && target.alive; i++) {
    game.step([]);
    buttons.push(bot.input.buttons);
    events.push(...game.events);
  }
  return { game, bot, target, buttons, events };
}

describe('gunner: launchers and the flamethrower', () => {
  it('a charge weapon is pressed and held until it fires, then let go for the next charge', () => {
    const { events, bot, target } = duel(RIPPER, 12, 10 * 60);
    expect(events.filter((e) => e.type === 'launch' && e.owner === bot.id).length).toBeGreaterThanOrEqual(1);
    expect(target.alive).toBe(false); // the blade went through it
  });

  it('never a rocket or a shell at a body inside its own blast; no lobbed shell far out; flames only in reach', () => {
    expect(weaponValue(THUMPER, 2)).toBe(0);
    expect(weaponValue(THUMPER, 12)).toBeGreaterThan(0);
    expect(weaponValue(POPPER, 2)).toBe(0);
    expect(weaponValue(POPPER, 8)).toBeGreaterThan(0);
    expect(weaponValue(POPPER, 14)).toBe(0);
    expect(weaponValue(DRAGON, 4)).toBeGreaterThan(0);
    expect(weaponValue(DRAGON, 8)).toBe(0);
  });
});

describe('gunner: same buttons and rules as a human', () => {
  it('a semi-automatic gets a fresh press per shot, never a held trigger', () => {
    const { buttons, events, bot } = duel(HAMMER, 10, 600);
    const fire = buttons.map((b) => (b & Btn.Fire) !== 0);
    for (let i = 1; i < fire.length; i++) expect(fire[i] && fire[i - 1], `tick ${i}`).toBe(false);
    expect(events.filter((e) => e.type === 'shot' && e.shooter === bot.id).length).toBeGreaterThan(2);
  });

  it('an automatic fires in bursts at range (Normal: ~6 shots, then a pause)', () => {
    const { buttons } = duel(K47, 15, 6 * 60);
    const runs: number[] = [];
    let len = 0;
    for (const b of buttons) {
      if (b & Btn.Fire) len++;
      else if (len) {
        runs.push(len);
        len = 0;
      }
    }
    expect(runs.length).toBeGreaterThan(2);
    // a burst of 6 at 0.1 s is 36 ticks; none holds the trigger for long
    expect(Math.max(...runs)).toBeLessThanOrEqual(40);
  });

  it('picks the gun that suits the range: the Widow far out, the Breacher up close', () => {
    expect(weaponValue(WIDOW, 30)).toBeGreaterThan(weaponValue(HAMMER, 30));
    expect(weaponValue(BREACHER, 3)).toBeGreaterThan(weaponValue(WIDOW, 3));
    expect(weaponValue(BUZZ, 40)).toBe(0); // out of its range
    const game = new Game({ map: flatMap() });
    const p = game.addPlayer('p') as PlayerState;
    game.setLoadout(p, [HAMMER.index, WIDOW.index]);
    const g = new Gunner(BOT_LEVELS.normal, new Xoshiro128(1));
    expect(g.bestSlot(p, 35)).toBe(1);
    game.setLoadout(p, [WIDOW.index, BREACHER.index]);
    expect(g.bestSlot(p, 3)).toBe(1);
  });

  it('swaps by weaponSelect when the other gun suits the fight better', () => {
    const game = new Game({ map: flatMap(), seed: 5 });
    dummyAt(game, 50);
    const bot = botAt(game, 47);
    game.setLoadout(bot, [WIDOW.index, BREACHER.index]); // Widow in hand, 3 m away
    run(game, 60);
    expect(bot.active).toBe(1);
  });

  it('reloads between fights, and bashes a target in reach', () => {
    const game = new Game({ map: flatMap(), seed: 5 });
    const bot = botAt(game, 20);
    game.setLoadout(bot, [BUZZ.index, HAMMER.index]);
    bot.weapons[0]!.mag = 10; // a quarter left, nobody about
    run(game, 3 * 60);
    expect(bot.weapons[0]!.mag).toBe(BUZZ.mag);

    const close = new Game({ map: flatMap(), seed: 5 });
    const t = dummyAt(close, 50);
    const b2 = botAt(close, 49.2);
    close.setLoadout(b2, [K47.index, K47.index]);
    const events = run(close, 90);
    expect(events.some((e) => e.type === 'hit' && e.attacker === b2.id && e.target === t.id && e.source === DamageSource.Melee)).toBe(true);
    expect(brainOf(b2).mode).toBe('fight');
  });

  it('picks no gun (−1) when none reaches the target or both are dry; a gun past its reach is worth nothing', () => {
    expect(weaponValue(K47, 20, 33)).toBe(0); // 20 m, but fog makes it 33 m of the K-47's 32
    expect(weaponValue(K47, 20, 30)).toBeGreaterThan(0);
    const game = new Game({ map: flatMap() });
    const p = game.addPlayer('p') as PlayerState;
    game.setLoadout(p, [HAMMER.index, BUZZ.index]);
    const g = new Gunner(BOT_LEVELS.normal, new Xoshiro128(1));
    expect(g.bestSlot(p, 10)).toBeGreaterThanOrEqual(0);
    expect(g.bestSlot(p, 30)).toBe(-1); // past both ranges (26 m, 20 m)
    expect(g.bestSlot(p, 10, 27)).toBe(-1); // 10 m through fog that eats 27 m of range
    for (const w of p.weapons) {
      w.mag = 0;
      w.reserve = 0;
    }
    expect(g.bestSlot(p, 10)).toBe(-1);
    p.weapons[1]!.reserve = 40; // something to reload: still a gun
    expect(g.bestSlot(p, 10)).toBe(1);
  });
});

