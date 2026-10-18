import { DT, Game } from '@military-forge/sim';
import { Xoshiro128, wrapAngle } from '@military-forge/shared';
import { describe, expect, it } from 'vitest';
import { Aim, gauss } from '../src/aim';
import { BOT_LEVELS, type BotLevelId } from '../src/levels';
import { flatMap } from './helpers';

/** A shooter and a target standing `dist` m apart on the flat. */
function pair(dist: number) {
  const game = new Game({ map: flatMap() });
  const self = game.addPlayer('self');
  self.spawn(20, 0.01, game.tuning);
  const q = game.addPlayer('target');
  q.spawn(20 + dist, 0.01, game.tuning);
  return { game, self, q, sx: self.shoulderX(game.tuning), sy: self.shoulderY(game.tuning) };
}

/** Mean miss distance (m) at the target over `ticks` of tracking (`impair`: a flashbang's fade). */
function meanMiss(level: BotLevelId, dist: number, ticks = 900, impair = 0): number {
  const { self, q, sx, sy } = pair(dist);
  const aim = new Aim(BOT_LEVELS[level], new Xoshiro128(99));
  aim.impair = impair;
  aim.acquire(q.id);
  let sum = 0;
  for (let i = 0; i < ticks; i++) {
    const centre = aim.track(self, q, sx, sy);
    if (i >= 120) sum += Math.abs(wrapAngle(aim.angle - centre)) * dist;
  }
  return sum / (ticks - 120);
}

describe('aim: a hand on a mouse, not a turret', () => {
  it('gauss() is a standard normal (mean 0, variance 1) and deterministic', () => {
    const rng = new Xoshiro128(1);
    let s = 0;
    let s2 = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const g = gauss(rng);
      s += g;
      s2 += g * g;
    }
    expect(Math.abs(s / n)).toBeLessThan(0.03);
    expect(s2 / n).toBeCloseTo(1, 1);
    expect(gauss(new Xoshiro128(5))).toBe(gauss(new Xoshiro128(5)));
  });

  it('waits out its reaction time on a new target before it may fire', () => {
    for (const level of ['easy', 'normal', 'hard'] as const) {
      const { self, q, sx, sy } = pair(10);
      const aim = new Aim(BOT_LEVELS[level], new Xoshiro128(7));
      aim.acquire(q.id);
      let first = -1;
      for (let i = 0; i < 120 && first < 0; i++) {
        const centre = aim.track(self, q, sx, sy);
        if (aim.onTarget(centre, 10)) first = i;
      }
      expect(first * DT, level).toBeGreaterThanOrEqual(BOT_LEVELS[level].reaction * 0.8 - DT);
    }
  });

  it('holds it tighter the harder the level (mean miss at 12 m: Hard < Normal < Easy)', () => {
    const easy = meanMiss('easy', 12);
    const normal = meanMiss('normal', 12);
    const hard = meanMiss('hard', 12);
    expect(hard).toBeLessThan(normal);
    expect(normal).toBeLessThan(easy);
    expect(hard).toBeGreaterThan(0.05); // never a perfect turret
  });

  it('turns no faster than its turn rate: a flick behind it takes time', () => {
    const { self, q, sx, sy } = pair(-10); // target behind (to the left)
    const level = BOT_LEVELS.normal;
    const aim = new Aim(level, new Xoshiro128(3));
    aim.angle = 0;
    aim.acquire(q.id);
    const ticks = 5;
    let prev = aim.angle;
    for (let i = 0; i < ticks; i++) {
      aim.track(self, q, sx, sy);
      // the hand turns ≤ turnRate per tick; the tremor rides on top (a few degrees at most here)
      expect(Math.abs(wrapAngle(aim.angle - prev))).toBeLessThan(level.turnRate * DT + 0.2);
      prev = aim.angle;
    }
    expect(Math.abs(wrapAngle(aim.angle - Math.PI))).toBeGreaterThan(1);
  });

  it('aims worse the whiter a flashbang’s fade still is', () => {
    for (const level of ['easy', 'normal', 'hard'] as const) {
      const clear = meanMiss(level, 12);
      const half = meanMiss(level, 12, 900, 0.5);
      const white = meanMiss(level, 12, 900, 1);
      expect(half, level).toBeGreaterThan(clear * 1.8);
      expect(white, level).toBeGreaterThan(half * 1.4);
    }
  });
});
