/**
 * The #70 review's two highs. H1: a bot fires only at a body its bullets reach (the weapon's range,
 * or what a map's fog leaves of it), and with both guns dry it closes in to bash instead of holding
 * Fire at range. H2: a fight it can't get a shot in (no line of fire, no way to a spot with one)
 * ends within seconds instead of a stand-off.
 */
import { BUZZ, HAMMER, K47, type MapDef } from '@military-forge/content';
import { Btn, DamageSource, Game, type PlayerState } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { botAt, brainOf, dummyAt, flatMap, rect } from './helpers';

/** The flat range with a band of bullet fog from x 24 to 34: a metre in it costs 2.5 of a bullet's range. */
function fogMap(): MapDef {
  const map = flatMap();
  map.zones = [{ id: 'fog', kind: 'damping', rect: [24, -1, 34, 28], bulletRangeMul: 0.4 }];
  return map;
}

/** The weapon range a shot from p's shoulder uses up getting to q's torso, as combat.ts charges it. */
function rangeUsed(game: Game, p: PlayerState, q: PlayerState): number {
  const sx = p.shoulderX(game.tuning);
  const sy = p.shoulderY(game.tuning);
  const dx = q.x - sx;
  const dy = q.y + 0.85 - sy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (!game.mech) return d;
  game.mech.castBullet(sx, sy, dx / d, dy / d);
  return game.mech.bulletCost(d);
}

describe('H1: only at what its bullets reach; dry, in for the bash', () => {
  it('a target across bullet fog, in range by the metres, draws no shot: it closes in until its bullets carry, then fires', () => {
    const game = new Game({ map: fogMap(), seed: 7 });
    const target = dummyAt(game, 40);
    const bot = botAt(game, 14, { level: 'hard' });
    game.setLoadout(bot, [K47.index, K47.index]);
    // 26 m: inside the K-47's 32 m, but the fog makes it 41 m of range
    expect(rangeUsed(game, bot, target)).toBeGreaterThan(K47.range);
    let shots = 0;
    let beyond = 0;
    for (let i = 0; i < 10 * 60 && target.alive; i++) {
      game.step([]);
      for (const e of game.events) {
        if (e.type !== 'shot' || e.shooter !== bot.id) continue;
        shots++;
        if (rangeUsed(game, bot, target) > K47.range + 0.5) beyond++;
      }
    }
    expect(beyond).toBe(0);
    expect(shots).toBeGreaterThan(0);
  });

  it('with both guns dry it never holds Fire at range: it closes in and bashes (within 4 s from 12 m)', () => {
    for (const seed of [8, 9, 10, 11]) {
      for (const level of ['easy', 'normal', 'hard'] as const) {
        const game = new Game({ map: flatMap(), seed });
        const target = dummyAt(game, 40);
        const bot = botAt(game, 28, { level });
        game.setLoadout(bot, [HAMMER.index, BUZZ.index]);
        for (const w of bot.weapons) {
          w.mag = 0;
          w.reserve = 0;
        }
        bot.grenadeCounts.fill(0); // the bash only
        let fireAtRange = 0;
        let bashedAt = -1;
        for (let i = 0; i < 6 * 60 && bashedAt < 0; i++) {
          game.step([]);
          if ((bot.input.buttons & Btn.Fire) !== 0 && Math.abs(target.x - bot.x) > 2) fireAtRange++;
          if (game.events.some((e) => e.type === 'hit' && e.attacker === bot.id && e.source === DamageSource.Melee)) bashedAt = i;
        }
        const where = `seed ${seed}, ${level}`;
        expect(fireAtRange, where).toBe(0);
        expect(bashedAt, where).toBeGreaterThanOrEqual(0);
        expect(bashedAt, where).toBeLessThan(4 * 60);
      }
    }
  });
});

describe('H2: no fight stand-offs', () => {
  it('a target it can see but never get a shot at (shut in a room) is given up within seconds; it moves on', () => {
    const game = new Game({ map: flatMap([rect(40, 0, 41, 8), rect(49, 0, 50, 8), rect(40, 7, 50, 8)]), seed: 9 });
    dummyAt(game, 45);
    const bot = botAt(game, 30, { level: 'normal' });
    let still = 0;
    let worst = 0;
    let ax = bot.x;
    let ay = bot.y;
    let fought = false;
    let movedOn = false;
    for (let i = 0; i < 20 * 60; i++) {
      game.step([]);
      const b = brainOf(bot);
      if (b.mode === 'fight') fought = true;
      else if (fought) movedOn = true;
      // standing in a fight with no shot: how long, at most
      if (b.mode === 'fight' && !b.inReach && Math.abs(bot.x - ax) + Math.abs(bot.y - ay) < 0.5) still++;
      else {
        still = 0;
        ax = bot.x;
        ay = bot.y;
      }
      worst = Math.max(worst, still);
    }
    expect(fought).toBe(true);
    expect(movedOn).toBe(true);
    expect(worst).toBeLessThan(3 * 60);
  });
});

describe('slabs that stop bullets (one-ways with blocksBullets)', () => {
  it('never fires from under a slab at a target standing on it (it flies up through and fights from there); through a plain one-way it fires from below', () => {
    for (const blocks of [false, true]) {
      const map = flatMap();
      map.oneWays = [{ ax: 18, ay: 4, bx: 34, by: 4, ...(blocks ? { blocksBullets: true } : {}) }];
      const game = new Game({ map, seed: 7 });
      const target = dummyAt(game, 26, 4);
      const bot = botAt(game, 14, { level: 'hard' });
      let fromBelow = 0;
      let shots = 0;
      for (let i = 0; i < 4 * 60; i++) {
        game.step([]);
        for (const e of game.events) {
          if (e.type !== 'shot' || e.shooter !== bot.id) continue;
          shots++;
          if (bot.y < 3.9) fromBelow++;
        }
      }
      expect(shots, `blocksBullets ${blocks}`).toBeGreaterThan(0);
      if (blocks) {
        expect(fromBelow).toBe(0);
        expect(bot.y).toBeGreaterThan(3.9); // up on the slab
      } else expect(fromBelow).toBe(shots);
      expect(target.hp).toBeLessThan(100);
    }
  });
});
