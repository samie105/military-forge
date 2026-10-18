/**
 * Launchers and the flamethrower (docs/03 §11): projectiles in the grenade pool. Rockets, shells,
 * saw blades, EMP orbs and flames, the charge weapons, burning, and a full pool.
 */
import {
  BLADE,
  DRAGON,
  FLAME,
  GAS,
  HAMMER,
  ORB,
  POPPER,
  PROJECTILE_TYPE_BASE,
  PULSE,
  RIPPER,
  ROCKET,
  SHELL,
  THUMPER,
  defaultTuning as T,
  type MapPolygon,
} from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { BOUNCED, Btn, Game, MAX_GRENADES, spawnCloud, type GrenadeState, type SimEvent } from '../src';
import { dummyAt, flatMap, hold, makeGame, placeOnGround, rect } from './helpers';

const live = (game: Game, type: number): GrenadeState[] => game.grenades.filter((g) => g.alive && g.type === type);
const rocketType = PROJECTILE_TYPE_BASE + ROCKET.index;

/** A shooter at x 10 on a 120 m flat map (extra solids), holding `weapon` in slot 0. */
function armed(weapon: number, extra: MapPolygon[] = []) {
  const { game, p } = makeGame(flatMap(extra, [], 120));
  game.setLoadout(p, [weapon, HAMMER.index]);
  placeOnGround(game, p, 10);
  return { game, p };
}

/** Steps with nothing held until `until` says so (or n ticks), collecting events. */
function run(game: Game, p: Parameters<typeof hold>[1], n: number, until?: () => boolean): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < n && !until?.(); i++) {
    hold(game, p, 0, 1);
    events.push(...game.events);
  }
  return events;
}

describe('Thumper: rockets', () => {
  it('a rocket flies straight at 20 m/s and a direct hit kills: 100, then its blast', () => {
    const { game, p } = armed(THUMPER.index);
    const target = dummyAt(game, 22);
    hold(game, p, Btn.Fire, 1);
    const [rocket] = live(game, rocketType);
    expect(rocket).toBeDefined();
    expect(Math.sqrt(rocket!.vx ** 2 + rocket!.vy ** 2)).toBeCloseTo(ROCKET.speed, 1);
    expect(p.weapons[0].mag).toBe(THUMPER.mag - 1);
    const events = run(game, p, 60, () => !target.alive);
    expect(target.alive).toBe(false);
    const hit = events.find((e) => e.type === 'hit' && e.target === target.id) as Extract<SimEvent, { type: 'hit' }>;
    expect(hit).toMatchObject({ damage: ROCKET.damage, source: THUMPER.index });
    expect(events).toContainEqual(expect.objectContaining({ type: 'explosion', grenade: rocketType, radius: ROCKET.explosion!.radius }));
    expect(live(game, rocketType)).toHaveLength(0);
  });

  it('a wall in the way: it goes off at the wall; nothing in the way: it self-destructs at 60 m', () => {
    const wall = armed(THUMPER.index, [rect(20, 0, 21, 10)]);
    hold(wall.game, wall.p, Btn.Fire, 1);
    const at = run(wall.game, wall.p, 60).find((e) => e.type === 'explosion') as Extract<SimEvent, { type: 'explosion' }>;
    expect(at.x).toBeGreaterThan(19.5);
    expect(at.x).toBeLessThan(20.01);
    const open = armed(THUMPER.index);
    hold(open.game, open.p, Btn.Fire, 1); // along an empty range
    let flew = 0;
    while (flew < 400 && live(open.game, rocketType).length > 0) {
      hold(open.game, open.p, 0, 1);
      flew++;
    }
    expect(flew / 60).toBeCloseTo(ROCKET.life, 1);
    const blast = open.game.events.find((e) => e.type === 'explosion') as Extract<SimEvent, { type: 'explosion' }>;
    expect(blast.x - open.p.x).toBeGreaterThan(58);
    expect(blast.x - open.p.x).toBeLessThan(62);
  });

  it('a rocket at your feet is a rocket jump: launched up, for half its blast', () => {
    const { game, p } = armed(THUMPER.index);
    hold(game, p, Btn.Fire, 1, -Math.PI / 2); // straight down
    run(game, p, 3);
    expect(p.vy).toBeGreaterThan(8);
    expect(T.healthMax - p.hp).toBeGreaterThan(20);
    expect(T.healthMax - p.hp).toBeLessThanOrEqual(ROCKET.explosion!.maxDamage * ROCKET.explosion!.selfDamageMul + 1e-6);
    let top = p.y;
    for (let i = 0; i < 90; i++) {
      hold(game, p, 0, 1);
      top = Math.max(top, p.y);
    }
    expect(top).toBeGreaterThan(4); // a jump a frag can't give you
  });
});

describe('Popper: shells', () => {
  it('a shell lobs, bounces and goes off after 1.2 s; on a player it goes off at once (70 splash)', () => {
    const { game, p } = armed(POPPER.index);
    hold(game, p, Btn.Fire, 1, 0.5);
    const type = PROJECTILE_TYPE_BASE + SHELL.index;
    expect(live(game, type)).toHaveLength(1);
    const events = run(game, p, 120, () => live(game, type).length === 0);
    const blast = events.find((e) => e.type === 'explosion');
    expect(blast).toMatchObject({ grenade: type, radius: SHELL.explosion!.radius });
    expect(game.tick).toBeGreaterThanOrEqual(Math.round(SHELL.life * 60) - 1);

    const near = armed(POPPER.index);
    const target = dummyAt(near.game, 14);
    hold(near.game, near.p, Btn.Fire, 1);
    const hits = run(near.game, near.p, 30, () => live(near.game, type).length === 0);
    expect(near.game.tick).toBeLessThan(25); // well before the fuse
    const hit = hits.find((e) => e.type === 'hit' && e.target === target.id) as Extract<SimEvent, { type: 'hit' }>;
    expect(hit.damage).toBeGreaterThan(SHELL.explosion!.maxDamage * 0.7);
    expect(hit.source).toBe(POPPER.index);
  });
});

describe('charge weapons: Ripper and Pulse', () => {
  it('Ripper: nothing until 0.4 s held; let go early and it is lost', () => {
    const { game, p } = armed(RIPPER.index);
    const type = PROJECTILE_TYPE_BASE + BLADE.index;
    hold(game, p, Btn.Fire, 20);
    hold(game, p, 0, 1);
    expect(live(game, type)).toHaveLength(0);
    expect(p.weapons[0].spin).toBe(0);
    hold(game, p, Btn.Fire, 23);
    expect(live(game, type)).toHaveLength(0);
    hold(game, p, Btn.Fire, 1);
    expect(live(game, type)).toHaveLength(1);
    hold(game, p, Btn.Fire, 60); // still held: no second charge (and the mag is empty)
    expect(p.weapons[0].mag).toBe(0);
  });

  it('a blade cuts through everyone in a line, bounces back off the wall and cuts its owner', () => {
    const { game, p } = armed(RIPPER.index, [rect(30, 0, 31, 10)]);
    const a = dummyAt(game, 15);
    const b = dummyAt(game, 20);
    hold(game, p, Btn.Fire, 24);
    const blade = live(game, PROJECTILE_TYPE_BASE + BLADE.index)[0]!;
    const events = run(game, p, 300, () => !p.alive);
    expect([a.alive, b.alive]).toEqual([false, false]);
    expect(blade.state).toBe(BOUNCED);
    expect(p.alive).toBe(false); // it came back off the wall
    expect(events).toContainEqual(expect.objectContaining({ type: 'death', victim: p.id, killer: p.id, source: RIPPER.index }));
  });

  it('Pulse: an orb drifts through a wall and bursts on the player behind it: jetpack dead, no damage', () => {
    const { game, p } = armed(PULSE.index, [rect(14, 0, 15, 10)]);
    const target = dummyAt(game, 19);
    hold(game, p, Btn.Fire, Math.round(PULSE.charge! * 60));
    expect(live(game, PROJECTILE_TYPE_BASE + ORB.index)).toHaveLength(1);
    run(game, p, 120, () => target.jetDisabledTicks > 0);
    expect(target.jetDisabledTicks).toBeGreaterThan(0);
    expect(target.hp).toBe(T.healthMax);
  });
});

describe('Dragon: flames and burning', () => {
  it('held: a flame every 0.15 s; 3 m away, dead in about 0.6 s; burning hurts on after the flames stop', () => {
    const { game, p } = armed(DRAGON.index);
    const target = dummyAt(game, 13.5);
    let t = 0;
    for (; t < 120 && target.alive; t++) hold(game, p, Btn.Fire, 1);
    expect(target.alive).toBe(false);
    // 5 flames 0.15 s apart, and each takes ~0.3 s to get there
    expect(t / 60).toBeLessThan(1);
    expect(t / 60).toBeGreaterThan(0.6);

    const burn = armed(DRAGON.index);
    const victim = dummyAt(burn.game, 13.5);
    const events: SimEvent[] = [];
    hold(burn.game, burn.p, Btn.Fire, 1); // one flame, then let go
    events.push(...burn.game.events, ...run(burn.game, burn.p, 30));
    expect(victim.burnTicks).toBeGreaterThan(0);
    events.push(...run(burn.game, burn.p, 150));
    const hits = events.filter((e): e is Extract<SimEvent, { type: 'hit' }> => e.type === 'hit' && e.target === victim.id);
    // the flame, then 2 s of burning in 0.25 s pulses, all the Dragon's
    expect(hits.reduce((sum, e) => sum + e.damage, 0)).toBeCloseTo(FLAME.damage + FLAME.burn!.dps * FLAME.burn!.seconds, 6);
    expect(hits.every((e) => e.source === DRAGON.index && e.attacker === burn.p.id)).toBe(true);
    expect(victim.burnTicks).toBe(0);
  });

  it('8 m away it never reaches; its tank runs dry, then fills up again off the trigger', () => {
    const { game, p } = armed(DRAGON.index);
    const far = dummyAt(game, 18);
    hold(game, p, Btn.Fire, 600);
    expect(far.hp).toBe(T.healthMax);
    expect(p.weapons[0].mag).toBe(0);
    hold(game, p, 0, 60 * 6);
    expect(p.weapons[0].mag).toBe(DRAGON.mag);
  });

  it('puts out toxic gas it reaches, not smoke', () => {
    const { game, p } = armed(DRAGON.index);
    game.step([]);
    spawnCloud(game, GAS.index, 13, 1.2, -1);
    hold(game, p, Btn.Fire, 30);
    expect(game.clouds.filter((c) => c.alive)).toHaveLength(0);
  });
});

describe('slabs (#107 review)', () => {
  it('a slab that stops bullets stops projectiles: nothing hits the player standing on it from below; a plain one-way doesn\'t', () => {
    for (const blocksBullets of [true, false]) {
      for (const weapon of [DRAGON.index, THUMPER.index]) {
        const { game, p } = makeGame(flatMap([], [{ ax: 36, ay: 2.5, bx: 46, by: 2.5, blocksBullets }], 120));
        game.setLoadout(p, [weapon, HAMMER.index]);
        placeOnGround(game, p, 40);
        const top = dummyAt(game, 41.2, 2.5);
        hold(game, p, 0, 10);
        let dmg = 0;
        const aim = Math.atan2(top.y + 1 - p.shoulderY(game.tuning), top.x - p.shoulderX(game.tuning));
        for (let t = 0; t < 90 && top.alive; t++) {
          hold(game, p, weapon === DRAGON.index || t < 2 ? Btn.Fire : 0, 1, aim);
          for (const e of game.events) if (e.type === 'hit' && e.target === top.id) dmg += e.damage;
        }
        expect(dmg > 0, `${weapon} through a ${blocksBullets ? 'slab' : 'plain one-way'}`).toBe(!blocksBullets);
      }
    }
  });
});

describe('the pool', () => {
  it('full: the shot doesn\'t leave and the round isn\'t spent', () => {
    const { game, p } = armed(THUMPER.index);
    for (const g of game.grenades) Object.assign(g, { alive: true, type: 0, fuse: 999, x: 100, y: 5, vx: 0, vy: 0 });
    hold(game, p, Btn.Fire, 1);
    expect(p.weapons[0].mag).toBe(THUMPER.mag);
    expect(game.grenades.filter((g) => g.alive)).toHaveLength(MAX_GRENADES);
  });
});
