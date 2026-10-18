/**
 * No-stuck soak: six bots (two of each level) play every registered map for five minutes, pickups
 * on (as in local play and rooms). A bot is stuck when it's trying to get somewhere, or standing in
 * a fight it can't hit its target from, and moves less than 0.5 m in 3 s (soakLib.ts). It also
 * checks that bots shoot only at what their bullets reach and never hold Fire with nothing to fire.
 * Then: local play's setup (an idle human and three bots of a level), and three minutes with arsenal
 * B going off around them.
 */
import { GAS, SMOKE, maps } from '@military-forge/content';
import { Xoshiro128 } from '@military-forge/shared';
import { DamageSource, Game, spawnCloud, type PlayerState } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { addBot, addBots } from '../src';
import { soakMap, type SoakResult } from './soakLib';

/** What every soak holds to. */
function expectSound(r: SoakResult): void {
  expect(r.stuckFraction, `stuck at ${r.stuckAt.slice(0, 5).join(' ')}`).toBeLessThan(0.01);
  expect(r.worstStuckSeconds).toBeLessThanOrEqual(5);
  // shots at what the bullets can't reach (the review found 12–64%): only a target moving out of reach mid-shot
  expect(r.beyondReach / Math.max(1, r.targetShots)).toBeLessThan(0.01);
  expect(r.dryFireTicks).toBe(0);
  expect(r.dryFraction).toBeLessThan(0.05);
}

describe('no-stuck soak: 5 minutes on every map', () => {
  for (const map of Object.values(maps)) {
    it(map.id, () => {
      const game = new Game({ map, seed: 21, pickups: true });
      for (const level of ['easy', 'easy', 'normal', 'normal', 'hard', 'hard'] as const) addBot(game, { level });
      const r = soakMap(game, 5 * 60 * 60);
      expectSound(r);
      expect(r.kills).toBeGreaterThan(10); // they find each other and fight
      expect(r.metresPerBotMinute).toBeGreaterThan(100);
    }, 120_000);
  }
});

describe('no-stuck soak in local play’s setup: an idle human and three bots', () => {
  for (const map of Object.values(maps)) {
    for (const level of ['normal', 'hard'] as const) {
      it(`${map.id}, ${level}`, () => {
        const game = new Game({ map, seed: 1234, pickups: true });
        game.addPlayer('human'); // presses nothing: a target that never fights back
        addBots(game, 3, level);
        const r = soakMap(game, 5 * 60 * 60);
        expectSound(r);
        expect(r.kills).toBeGreaterThan(10);
      }, 120_000);
    }
  }
});

describe('no-stuck soak with arsenal B going off around them: smoke, gas, flashbangs, EMP', () => {
  for (const map of Object.values(maps)) {
    it(map.id, () => {
      const game = new Game({ map, seed: 31, pickups: true });
      for (const level of ['easy', 'easy', 'normal', 'normal', 'hard', 'hard'] as const) addBot(game, { level });
      const rng = new Xoshiro128(77);
      let gasDeaths = 0;
      // every 3 s a smoke or gas cloud pops by a bot, every 5 s one is flashbanged, every 7 s one's jetpack dies
      const r = soakMap(game, 3 * 60 * 60, (g, t) => {
        for (const e of g.events) if (e.type === 'death' && e.source === DamageSource.Gas) gasDeaths++;
        const alive = g.players.filter((p): p is PlayerState => p?.alive === true);
        if (alive.length === 0) return;
        const bot = alive[rng.int(alive.length)]!;
        if (t % 180 === 90) spawnCloud(g, rng.nextFloat() < 0.5 ? GAS.index : SMOKE.index, bot.x + (rng.nextFloat() - 0.5) * 4, bot.y, -1);
        if (t % 300 === 150) {
          bot.blindTicks = 150 + rng.int(90);
          bot.blindFade = 60 + rng.int(30);
        }
        if (t % 420 === 210) bot.jetDisabledTicks = 180;
      });
      expectSound(r);
      expect(r.kills).toBeGreaterThan(10);
      // gas pops right by them about every 6 s: they walk out (it kills the odd one already hurt)
      expect(gasDeaths).toBeLessThanOrEqual(5);
    }, 120_000);
  }
});

