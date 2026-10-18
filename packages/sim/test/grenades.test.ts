import { BUZZ, EMP, FLASHBANG, FRAG, GAS, GRENADE_TYPES, HAMMER, MINE, SMOKE, defaultTuning as T, weapons } from '@military-forge/content';
import type { MapZone } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import {
  Btn,
  DamageSource,
  Game,
  MineState,
  SMOKE_NEAR_SIGHT,
  SmokeSight,
  addGrenades,
  blindIntensity,
  createInput,
  canSee,
  clearGasAt,
  cloudRadius,
  lineOfSight,
  smokeMaskAt,
  smokeMaskBody,
  spawnCloud,
  stepGrenade,
  visionRadius,
  type PlayerState,
  type SimEvent,
} from '../src';
import { dummyAt, flatMap, hold, makeGame, placeOnGround, rect } from './helpers';

function events<K extends SimEvent['type']>(game: Game, type: K): Extract<SimEvent, { type: K }>[] {
  return game.events.filter((e): e is Extract<SimEvent, { type: K }> => e.type === type);
}

/** Steps the game `n` ticks with nobody pressing anything (bots still think). */
function idle(game: Game, n: number): void {
  for (let i = 0; i < n; i++) game.step([]);
}

/** A belt with `counts` (by grenade type), standing at x on a flat floor. */
function belted(counts: number[], x = 5, extra: Parameters<typeof flatMap>[0] = []): { game: Game; p: PlayerState } {
  const { game, p } = makeGame(flatMap(extra, [], 120));
  game.setGrenadeLoadout(p, counts);
  placeOnGround(game, p, x);
  return { game, p };
}

const belt = (...pairs: [number, number][]): number[] => {
  const out = new Array<number>(GRENADE_TYPES).fill(0);
  for (const [type, n] of pairs) out[type] = n;
  return out;
};

describe('grenade belt: carrying and cycling (docs/02 §14)', () => {
  it('spawns with frag ×3 selected', () => {
    const { p } = makeGame(flatMap());
    expect(p.grenadeCounts).toEqual(belt([FRAG.index, 3]));
    expect(p.grenadeType).toBe(FRAG.index);
    expect(p.frags).toBe(3);
  });

  it('addGrenades caps at the type’s maximum and says how many it took', () => {
    const { p } = makeGame(flatMap());
    expect(addGrenades(p, SMOKE.index, 2)).toBe(2);
    expect(addGrenades(p, SMOKE.index, 2)).toBe(0); // full: a pickup stays on the floor
    expect(addGrenades(p, FRAG.index, 2)).toBe(2);
    expect(addGrenades(p, FRAG.index, 2)).toBe(0);
    expect(p.frags).toBe(FRAG.maxCount);
    expect(addGrenades(p, GAS.index, 5)).toBe(GAS.maxCount);
    expect(addGrenades(p, 99, 2)).toBe(0);
    expect(p.grenadeType).toBe(FRAG.index); // the selection only moves off an empty type
  });

  it('the cycle key steps through the types held, skipping empty ones and wrapping', () => {
    const { game, p } = belted(belt([FRAG.index, 1], [GAS.index, 2]));
    const press = (btn: number) => {
      hold(game, p, btn, 1);
      hold(game, p, 0, 1);
    };
    press(Btn.CycleGrenade);
    expect(p.grenadeType).toBe(GAS.index); // smoke skipped: none held
    press(Btn.CycleGrenade);
    expect(p.grenadeType).toBe(FRAG.index);
    addGrenades(p, SMOKE.index, 1);
    press(Btn.CycleGrenade);
    expect(p.grenadeType).toBe(SMOKE.index);
  });

  it('throws the selected type; the last one of a type brings up the next type held', () => {
    const { game, p } = belted(belt([SMOKE.index, 1], [GAS.index, 1]));
    expect(p.grenadeType).toBe(SMOKE.index);
    hold(game, p, Btn.Grenade, 1, Math.PI / 4);
    const thrown = game.grenades.filter((g) => g.alive);
    expect(thrown.map((g) => g.type)).toEqual([SMOKE.index]);
    expect(p.grenadeCounts[SMOKE.index]).toBe(0);
    expect(p.grenadeType).toBe(GAS.index);
    hold(game, p, 0, 40);
    hold(game, p, Btn.Grenade, 1, Math.PI / 4);
    expect(game.grenades.filter((g) => g.alive && g.type === GAS.index)).toHaveLength(1);
    expect(p.grenadeType).toBe(GAS.index); // nothing left to move to
    hold(game, p, 0, 40);
    hold(game, p, Btn.Grenade, 1);
    expect(events(game, 'throw')).toHaveLength(0); // empty belt
  });

  it('the grenade loadout comes back on respawn', () => {
    const { game, p } = belted(belt([GAS.index, 2]));
    hold(game, p, Btn.Grenade, 1);
    expect(p.grenadeCounts[GAS.index]).toBe(1);
    game.damage(p, 500, -1, DamageSource.World, 2);
    idle(game, Math.round(T.respawnDelay * 60) + 2);
    expect(p.alive).toBe(true);
    expect(p.grenadeCounts[GAS.index]).toBe(2);
    expect(p.grenadeType).toBe(GAS.index);
  });
});

describe('smoke', () => {
  it('pops into a cloud a metre above where it lands; grows in, holds, thins out, goes', () => {
    const { game, p } = belted(belt([SMOKE.index, 1]));
    hold(game, p, Btn.Grenade, 1, 0.3);
    const g = game.grenades.find((x) => x.alive)!;
    let popped: { x: number; y: number } | null = null;
    for (let i = 0; i < 200 && g.alive; i++) {
      const at = { x: g.x, y: g.y };
      hold(game, p, 0, 1);
      if (!g.alive) popped = at;
    }
    expect(popped).not.toBeNull();
    expect(events(game, 'explosion')).toHaveLength(0); // no blast: a cloud
    const c = game.clouds.find((x) => x.alive)!;
    expect(c.type).toBe(SMOKE.index);
    expect(c.owner).toBe(p.id);
    expect(c.x).toBeCloseTo(popped!.x, 1);
    expect(c.y).toBeCloseTo(popped!.y + 1, 1);

    const def = SMOKE.cloud;
    expect(cloudRadius(def, 0)).toBeCloseTo(def.radius * def.startFraction, 9);
    expect(cloudRadius(def, Math.round(def.grow * 60))).toBeCloseTo(def.radius, 9);
    expect(cloudRadius(def, 60 * 9)).toBe(def.radius);
    expect(cloudRadius(def, 60 * def.duration)).toBeCloseTo(def.radius * def.endFraction, 9);
    expect(visionRadius(def, 60 * 5)).toBeCloseTo(def.radius * 0.85, 9);
    expect(visionRadius(def, 60 * (def.duration - 0.5))).toBe(0); // thinned out: see-through

    const ticksLeft = 60 * def.duration - c.age;
    idle(game, ticksLeft - 1);
    expect(c.alive).toBe(true);
    idle(game, 1);
    expect(c.alive).toBe(false);
    expect(p.hp).toBe(T.healthMax); // harmless
  });

  it('blocks sight lines through it, not around it, and never through a wall', () => {
    const { game, p } = belted(belt(), 4, [rect(20, 0, 20.4, 12)]);
    expect(lineOfSight(game, 8, 1.24, 14, 1.24)).toBe(true);
    const c = spawnCloud(game, SMOKE.index, 12, 0, p.id)!;
    expect(c.y).toBe(1); // a metre above the floor it popped on
    idle(game, 80);
    expect(lineOfSight(game, 8, 1.24, 14, 1.24)).toBe(false);
    expect(lineOfSight(game, 8, 6, 14, 6)).toBe(true); // over the top
    // a cloud next to a wall: inside on its side, nothing on the far side
    const c2 = spawnCloud(game, SMOKE.index, 18.5, 0, p.id)!;
    idle(game, 80);
    expect(smokeMaskAt(game, 17.5, 1)).toBe(1 << c2.id);
    expect(smokeMaskAt(game, 21, 1)).toBe(0);
    // gas never blocks sight
    spawnCloud(game, GAS.index, 40, 0, p.id);
    idle(game, 80);
    expect(lineOfSight(game, 30, 1.24, 50, 1.24)).toBe(true);
    // thinned out near the end of its life
    idle(game, 60 * SMOKE.cloud.duration - c.age - 60);
    expect(lineOfSight(game, 8, 1.24, 14, 1.24)).toBe(true);
  });

  it('hides a whole body only well inside it; nobody outside can see that player', () => {
    const { game, p } = belted(belt(), 10);
    const hider = dummyAt(game, 30);
    const edge = dummyAt(game, 33.2);
    spawnCloud(game, SMOKE.index, 30, 0, p.id);
    idle(game, 80);
    expect(smokeMaskBody(game, hider)).not.toBe(0);
    expect(smokeMaskBody(game, edge)).toBe(0); // the head pokes out of the opaque part
    expect(canSee(game, p, hider)).toBe(false);
    expect(canSee(game, hider, p)).toBe(false); // nor see out of it
  });

  it('SmokeSight: inside or behind a cloud is hidden, beside or above it is not; shared clouds and thin ones don\'t hide', () => {
    const { game, p } = belted(belt(), 10);
    const inside = dummyAt(game, 30);
    const behind = dummyAt(game, 37);
    const front = dummyAt(game, 26.1);
    const sight = new SmokeSight();
    sight.gather(game);
    expect([sight.hides(p.id, inside.id), sight.hides(p.id, behind.id)]).toEqual([false, false]); // no smoke yet
    const c = spawnCloud(game, SMOKE.index, 30, 0, p.id)!;
    c.age = 120;
    sight.gather(game);
    expect(sight.count).toBe(1);
    expect([sight.hides(p.id, inside.id), sight.hides(p.id, behind.id), sight.hides(p.id, front.id)]).toEqual([true, true, false]);
    expect(sight.hides(inside.id, p.id)).toBe(true); // from deep inside you can't see out
    expect(sight.hides(inside.id, behind.id)).toBe(true);
    expect(sight.hides(p.id, p.id)).toBe(false);
    // a tracer from us toward the cloud vanishes where it enters the core (3.4 m around (30, 1))
    expect(sight.tracerCut(p.id, 10, 1.1, 40, 1.1)).toBeCloseTo((30 - 3.4 - 10) / 30, 2);
    // …however little of it it crosses (review H2)
    const graze = sight.tracerCut(p.id, 10, 4.3, 50, 4.3);
    expect(graze).toBeGreaterThan(0.45);
    expect(graze).toBeLessThan(0.55);
    // from inside the cloud a tracer shows only near the eyes (SMOKE_NEAR_SIGHT), not across the smoke
    const near = sight.tracerCut(inside.id, 30, 1.1, 40, 1.1) * 10;
    expect(near).toBeGreaterThan(1);
    expect(near).toBeLessThan(SMOKE_NEAR_SIGHT);
    c.age = 60 * SMOKE.cloud.duration - 20;
    sight.gather(game);
    expect(sight.count).toBe(0);
    expect(sight.hides(p.id, behind.id)).toBe(false);
    expect(sight.tracerCut(p.id, 10, 1.1, 40, 1.1)).toBe(1);
  });

  it('SmokeSight: inside a cloud you see who is next to you, not across it; eyes in the rim see out, not in (review M1)', () => {
    const { game, p } = belted(belt(), 10);
    const a = dummyAt(game, 30);
    const b = dummyAt(game, 31);
    const across = dummyAt(game, 33);
    const rim = dummyAt(game, 27.1); // eyes 0.5 m inside the core's edge, all of it in the core
    const c = spawnCloud(game, SMOKE.index, 30, 0, p.id)!;
    c.age = 120;
    const sight = new SmokeSight();
    sight.gather(game);
    expect([sight.hides(a.id, b.id), sight.hides(b.id, a.id)]).toEqual([false, false]); // 1 m apart
    expect([sight.hides(a.id, across.id), sight.hides(across.id, a.id)]).toEqual([true, true]); // 3 m of smoke
    expect(sight.hides(rim.id, a.id)).toBe(true);
    expect(sight.hides(rim.id, p.id)).toBe(false); // out of the edge
    expect(sight.hides(p.id, rim.id)).toBe(true); // …but not back in: one-way at the rim
  });

  it('SmokeSight.pointHidden: what a grenade there would show (review M2)', () => {
    const { game, p } = belted(belt(), 10);
    const a = dummyAt(game, 30);
    spawnCloud(game, SMOKE.index, 30, 0, p.id)!.age = 120;
    const sight = new SmokeSight();
    sight.gather(game);
    expect(sight.pointHidden(p.id, 30, 1)).toBe(true); // in the core
    expect(sight.pointHidden(p.id, 40, 1)).toBe(true); // behind it
    expect(sight.pointHidden(p.id, 30, 7)).toBe(false); // over it
    expect(sight.pointHidden(p.id, 20, 1)).toBe(false); // short of it
    expect(sight.pointHidden(a.id, 30.6, 1.2)).toBe(false); // next to a, in the same smoke
    expect(sight.pointHidden(a.id, 32.9, 1)).toBe(true); // across it
    expect(sight.pointHidden(-1, 30, 1)).toBe(true); // no eyes: anything in a core
  });

  it('SmokeSight.carryOn: a shot into a hidden player goes on to the wall, or to the end of its range', () => {
    const { game, p } = belted(belt(), 10, [rect(60, 0, 62, 10)]);
    const sight = new SmokeSight();
    sight.gather(game);
    const range = weapons[p.weapons[0].def]!.range;
    sight.carryOn(50, 1, 52, 1, p.weapons[0].def);
    expect(sight.missed).toMatchObject({ x: 60, y: 1, hit: 1 });
    sight.carryOn(30, 1, 30 - 2, 1, p.weapons[0].def);
    expect(sight.missed.hit).toBe(0);
    expect(sight.missed.x).toBeCloseTo(30 - range, 6);
  });

  it('bots stop tracking a player hidden in smoke', () => {
    const { game, p } = belted(belt(), 10);
    const bot = dummyAt(game, 25);
    hold(game, p, 0, 2);
    const tracking = bot.input.aim;
    expect(tracking).not.toBe(0);
    spawnCloud(game, SMOKE.index, 10, 0, p.id);
    hold(game, p, Btn.Jet, 20); // fly up inside the cloud
    expect(bot.input.aim).toBe(tracking);
    hold(game, p, Btn.Jet | Btn.Right, 40); // out of it, up and away
    expect(bot.input.aim).not.toBe(tracking);
  });
});

describe('toxic gas', () => {
  /** Gas popped at the floor under x = 20; a dummy standing at `dx` from it. Damage over one second once grown. */
  function dps(dx: number, extra: Parameters<typeof flatMap>[0] = []): { taken: number; victim: PlayerState; game: Game } {
    const { game, p } = belted(belt(), 5, extra);
    const victim = dummyAt(game, 20 + dx);
    spawnCloud(game, GAS.index, 20, 0, p.id);
    idle(game, 60);
    const before = victim.hp;
    idle(game, 60);
    return { taken: before - victim.hp, victim, game };
  }

  it('hurts 14 dmg/s at the core and about 4 at the edge, in pulses', () => {
    expect(dps(0).taken).toBeCloseTo(14, 1);
    const edge = dps(3.6); // torso 3.3 m from the centre: past the 1 m core, inside 3.5 m
    expect(edge.taken).toBeGreaterThan(4);
    expect(edge.taken).toBeLessThan(6);
    expect(dps(4.2).taken).toBe(0);
  });

  it('a wall between the cloud and you protects you', () => {
    expect(dps(1.5, [rect(20.6, 0, 21, 8)]).taken).toBe(0);
    expect(dps(-1.5, [rect(20.6, 0, 21, 8)]).taken).toBeGreaterThan(5);
  });

  it('staying in the middle kills (~7 s), credited to the thrower, with the Gas source', () => {
    const { game, p } = belted(belt(), 5);
    const victim = dummyAt(game, 20);
    spawnCloud(game, GAS.index, 20, 0, p.id);
    let diedAt = -1;
    const hits: number[] = [];
    for (let t = 1; t <= 60 * 15 && diedAt < 0; t++) {
      idle(game, 1);
      for (const e of events(game, 'hit')) if (e.target === victim.id) hits.push(e.source);
      const death = events(game, 'death').find((e) => e.victim === victim.id);
      if (death) {
        diedAt = t / 60;
        expect(death.killer).toBe(p.id);
        expect(death.source).toBe(DamageSource.Gas);
      }
    }
    expect(diedAt).toBeGreaterThan(6.5);
    expect(diedAt).toBeLessThan(8);
    expect(new Set(hits)).toEqual(new Set([DamageSource.Gas]));
    expect(hits.length).toBeLessThan(40); // pulses, not a hit every tick
    expect(p.kills).toBe(1);
  });

  it('the thrower takes half; a victim coughs for half a second after each pulse', () => {
    const { game, p } = belted(belt(), 20);
    spawnCloud(game, GAS.index, 20, 0, p.id);
    idle(game, 60);
    const before = p.hp;
    idle(game, 60);
    expect(before - p.hp).toBeCloseTo(14 * GAS.cloud.selfDamageMul, 1);
    expect(p.gasTicks).toBeGreaterThan(0);
    p.x = 40;
    idle(game, 30);
    expect(p.gasTicks).toBe(0);
  });

  it('flames clear gas (the Dragon’s hook), not smoke', () => {
    const { game, p } = belted(belt(), 5);
    const gas = spawnCloud(game, GAS.index, 20, 0, p.id)!;
    const smoke = spawnCloud(game, SMOKE.index, 22, 0, p.id)!;
    idle(game, 70);
    expect(clearGasAt(game, 23, 1, 0.5)).toBe(1);
    expect(gas.alive).toBe(false);
    expect(smoke.alive).toBe(true);
  });

  it('a full set of clouds makes room by retiring the oldest', () => {
    const { game, p } = belted(belt(), 5);
    const first = spawnCloud(game, SMOKE.index, 10, 0, p.id)!;
    idle(game, 1);
    for (let i = 1; i < game.clouds.length; i++) spawnCloud(game, SMOKE.index, 10 + i, 0, p.id);
    const extra = spawnCloud(game, GAS.index, 50, 0, p.id)!;
    expect(extra).toBe(first);
    expect(extra.type).toBe(GAS.index);
    expect(extra.age).toBe(0);
  });

  it('an unknown grenade type just disappears', () => {
    const { game } = belted(belt(), 5);
    const g = game.allocGrenade()!;
    Object.assign(g, { alive: true, owner: 0, x: 10, y: 1, vx: 0, vy: 0, fuse: 30, type: 7 });
    stepGrenade(game, g);
    expect(g.alive).toBe(false);
  });
});

describe('flashbang', () => {
  /** Two humans standing on a flat floor: `p` at x = 20, `q` at x = 40 (out of the way). */
  function setup(extra: Parameters<typeof flatMap>[0] = []) {
    const { game, p } = makeGame(flatMap(extra, [], 120));
    const q = game.addPlayer('other');
    placeOnGround(game, p, 20);
    q.x = 40;
    return { game, p, q };
  }

  /** Steps with each listed player aiming at an angle (radians), no buttons. */
  function look(game: Game, aims: [PlayerState, number][], n = 2): void {
    const inputs = [];
    for (const [pl, rad] of aims) inputs[pl.id] = { ...createInput(), aim: Math.round(((((rad / (2 * Math.PI)) % 1) + 1) % 1) * 65536) & 0xffff };
    for (let i = 0; i < n; i++) game.step(inputs);
  }

  /** A flashbang of `owner`'s at (x, y) that goes off on the next step. */
  function bang(game: Game, x: number, y: number, owner: number): void {
    const g = game.allocGrenade()!;
    Object.assign(g, { alive: true, owner, x, y, vx: 0, vy: 0, fuse: 1, type: FLASHBANG.index });
  }

  const EYE = 1.24;

  it('close and looking at it: 2.5 s of white, then a 1.5 s fade; the thrower too', () => {
    const { game, p } = setup();
    look(game, [[p, 0]]);
    bang(game, 23, EYE, p.id);
    look(game, [[p, 0]], 1);
    expect(events(game, 'explosion')).toEqual([expect.objectContaining({ grenade: FLASHBANG.index, radius: FLASHBANG.flash.fullRadius })]);
    expect(p.blindFade).toBe(90);
    expect(p.blindTicks).toBe(240 - 1); // counted down at the end of the tick it went off
    expect(blindIntensity(p)).toBe(1);
    look(game, [[p, 0]], 149);
    expect(p.blindTicks).toBe(90);
    expect(blindIntensity(p)).toBe(1);
    look(game, [[p, 0]], 45);
    expect(blindIntensity(p)).toBeCloseTo(0.5, 2);
    look(game, [[p, 0]], 45);
    expect(p.blindTicks).toBe(0);
    expect(p.blindFade).toBe(0);
    expect(blindIntensity(p)).toBe(0);
    expect(p.hp).toBe(T.healthMax); // no damage
  });

  it('shorter looking away, through smoke and behind cover; half as long at 10 m; nothing at 17 m', () => {
    const blindFor = (aim: number, at: number, extra: Parameters<typeof flatMap>[0] = [], smoke = false) => {
      const { game, p, q } = setup(extra);
      if (smoke) {
        spawnCloud(game, SMOKE.index, 21.5, 0, q.id);
        look(game, [[p, aim]], 80);
      }
      look(game, [[p, aim]]);
      bang(game, 20 + at, EYE, q.id);
      look(game, [[p, aim]], 1);
      return p.blindTicks > 0 ? p.blindTicks + 1 : 0; // + the tick counted down already
    };
    // ticks of white + fade at a strength (the fade is at least 0.3 s), give or take a tick of rounding
    const expected = (strength: number) => 150 * strength + Math.max(18, 90 * strength);
    expect(blindFor(0, 3)).toBe(240);
    expect(Math.abs(blindFor(Math.PI / 2, 3) - expected(0.625))).toBeLessThanOrEqual(1); // looking up
    expect(Math.abs(blindFor(Math.PI, 3) - expected(0.25))).toBeLessThanOrEqual(1); // looking away
    expect(Math.abs(blindFor(0, 3, [], true) - expected(0.5))).toBeLessThanOrEqual(1); // through smoke
    expect(Math.abs(blindFor(0, 3, [rect(21.4, 0, 21.6, 4)]) - expected(0.15))).toBeLessThanOrEqual(1); // behind a wall
    expect(Math.abs(blindFor(0, 10) - expected(0.5))).toBeLessThanOrEqual(1);
    expect(blindFor(0, 17)).toBe(0);
  });

  it('a weaker flash never shortens a blindness already running; a stronger one renews it', () => {
    const { game, p, q } = setup();
    look(game, [[p, 0]]);
    bang(game, 23, EYE, q.id);
    look(game, [[p, 0]], 1);
    look(game, [[p, 0]], 100);
    const left = p.blindTicks;
    bang(game, 33, EYE, q.id); // 13 m: weak
    look(game, [[p, 0]], 1);
    expect(p.blindTicks).toBe(left - 1);
    bang(game, 22, EYE, q.id);
    look(game, [[p, 0]], 1);
    expect(p.blindTicks).toBe(239);
    expect(p.blindFade).toBe(90);
  });

  it('a blinded dummy stares off target', () => {
    const { game, p } = makeGame(flatMap([], [], 120));
    placeOnGround(game, p, 20);
    const bot = dummyAt(game, 26);
    hold(game, p, 0, 2);
    const tracking = bot.input.aim;
    bang(game, 25, EYE, p.id); // in the bot's face, behind the player's back
    hold(game, p, 0, 1, Math.PI); // it goes off after the bot has aimed for this tick
    const aims = new Set<number>();
    for (let i = 0; i < 60; i++) {
      hold(game, p, 0, 1, Math.PI);
      aims.add(bot.input.aim);
    }
    expect(bot.blindTicks).toBeGreaterThan(0);
    expect(aims.has(tracking)).toBe(false);
    expect(aims.size).toBeGreaterThan(3);
  });
});

describe('proximity mine', () => {
  const ARM = Math.round(MINE.mine.arm * 60);
  const BEEP = Math.round(MINE.mine.beep * 60);

  /** An armed mine of `owner`'s lying on the floor at x. */
  function armedMine(game: Game, x: number, owner: number) {
    const g = game.allocGrenade()!;
    Object.assign(g, { alive: true, owner, x, y: MINE.radius, vx: 0, vy: 0, type: MINE.index, state: MineState.Armed, fuse: Math.round(MINE.mine.lifetime * 60) });
    return g;
  }

  it('flies straight for 0.9 s, then drops; sticks to the first surface it touches and arms after 2 s', () => {
    const { game, p } = belted(belt([MINE.index, 2]), 20);
    hold(game, p, Btn.Grenade, 1, 0);
    const g = game.grenades.find((x) => x.alive)!;
    expect(g.type).toBe(MINE.index);
    const y0 = g.y;
    hold(game, p, 0, 50);
    expect(g.state).toBe(MineState.Flying);
    expect(g.y).toBe(y0); // no gravity yet
    expect(g.x - 20).toBeGreaterThan(8);
    for (let i = 0; i < 120 && g.state === MineState.Flying; i++) hold(game, p, 0, 1);
    expect(g.state).toBe(MineState.Arming);
    expect([g.vx, g.vy]).toEqual([0, 0]);
    expect(g.y).toBeCloseTo(MINE.radius, 2); // on the floor
    hold(game, p, 0, ARM);
    expect(g.state).toBe(MineState.Armed);

    // a wall in the way: it sticks to the wall, in mid-air
    const w = belted(belt([MINE.index, 1]), 20, [rect(24, 0, 24.4, 10)]);
    hold(w.game, w.p, Btn.Grenade, 1, 0);
    const g2 = w.game.grenades.find((x) => x.alive)!;
    hold(w.game, w.p, 0, 30);
    expect(g2.state).toBe(MineState.Arming);
    expect(g2.x).toBeCloseTo(24 - MINE.radius, 2);
    expect(g2.y).toBeGreaterThan(1);
  });

  it('an enemy within 1.6 m starts a 0.25 s beep, then 120 damage in 3.2 m; the thrower walks over it', () => {
    const { game, p } = belted(belt(), 20);
    const g = armedMine(game, 21, p.id);
    hold(game, p, Btn.Right, 30); // the owner walks right over it
    expect(g.state).toBe(MineState.Armed);
    const victim = dummyAt(game, 40);
    victim.x = 22.2; // 1.2 m: in reach
    hold(game, p, 0, 1);
    expect(g.state).toBe(MineState.Triggered);
    hold(game, p, 0, BEEP - 1);
    expect(g.alive).toBe(true);
    hold(game, p, 0, 1);
    expect(g.alive).toBe(false);
    expect(events(game, 'explosion')).toEqual([expect.objectContaining({ grenade: MINE.index, radius: MINE.mine.explosion.radius, owner: p.id })]);
    const death = events(game, 'death').find((e) => e.victim === victim.id)!;
    expect(death).toMatchObject({ killer: p.id, source: DamageSource.Mine });
  });

  it('stays quiet for an enemy behind a wall or out of reach, and despawns after 180 s', () => {
    const { game, p } = belted(belt(), 10, [rect(21.6, 0, 21.8, 6)]);
    const g = armedMine(game, 21, p.id);
    const behind = dummyAt(game, 22.4); // 1.4 m, but behind the wall
    const far = dummyAt(game, 23.5);
    far.x = 18.8; // 2.2 m: out of reach
    hold(game, p, 0, 60);
    expect(g.state).toBe(MineState.Armed);
    expect([behind.hp, far.hp]).toEqual([T.healthMax, T.healthMax]);
    g.fuse = 2;
    hold(game, p, 0, 2);
    expect(g.alive).toBe(false);
    expect(events(game, 'explosion')).toHaveLength(0);
  });

  it('a direct hit on a player in flight sets it off', () => {
    const { game, p } = belted(belt([MINE.index, 1]), 20);
    const victim = dummyAt(game, 26);
    hold(game, p, Btn.Grenade, 1, 0); // level: into the dummy's chest
    let blast = false;
    for (let i = 0; i < 40 && !blast; i++) {
      hold(game, p, 0, 1);
      blast = events(game, 'explosion').length > 0;
    }
    expect(blast).toBe(true);
    expect(victim.alive).toBe(false);
  });

  it('can be shot: 10 HP; whoever empties it gets the credit, and the bullet stops at it', () => {
    const { game, p } = belted(belt(), 20);
    game.setLoadout(p, [BUZZ.index, HAMMER.index]);
    const owner = game.addPlayer('owner');
    owner.x = 60;
    const g = armedMine(game, 22, owner.id);
    g.state = MineState.Arming; // not armed yet: only bullets can set it off
    g.fuse = 600;
    const victim = dummyAt(game, 23);
    const aim = Math.atan2(g.y - (p.y + T.shoulderStand), g.x - (p.x + T.shoulderForward));
    hold(game, p, Btn.Fire, 1, aim); // one Buzz bullet: 7 damage
    expect(events(game, 'shot')[0]).toMatchObject({ hit: 1, target: -1 });
    expect(events(game, 'shot')[0]!.ex).toBeCloseTo(22 - MINE.mine.hitRadius, 0); // stopped at the mine
    expect(g.alive).toBe(true);
    expect(g.hp).toBeCloseTo(MINE.mine.hp - BUZZ.damage, 3);
    hold(game, p, 0, 6, aim);
    hold(game, p, Btn.Fire, 1, aim); // the second empties it: it goes off at once
    expect(g.alive).toBe(false);
    expect(events(game, 'explosion')).toEqual([expect.objectContaining({ grenade: MINE.index, owner: p.id })]);
    expect(events(game, 'death').find((e) => e.victim === victim.id)).toMatchObject({ killer: p.id, source: DamageSource.Mine });
  });

  it('a blast sets off the mines in it a moment later, and they chain', () => {
    const { game, p } = belted(belt(), 5);
    const a = armedMine(game, 30, p.id);
    const b = armedMine(game, 32.5, p.id); // within the first mine's 3.2 m
    const c = armedMine(game, 50, p.id); // out of everything
    const frag = game.allocGrenade()!;
    Object.assign(frag, { alive: true, owner: p.id, x: 28, y: 0.5, vx: 0, vy: 0, fuse: 1 });
    const blasts: number[] = [];
    for (let t = 0; t < 30; t++) {
      hold(game, p, 0, 1);
      for (const e of events(game, 'explosion')) blasts.push(e.grenade === MINE.index ? t : -1);
    }
    // the frag, then a 4 ticks later, then b a few ticks after a (3 or 4: grenade slots step in order)
    expect(blasts.slice(0, 2)).toEqual([-1, 4]);
    expect(blasts[2]! - blasts[1]!).toBeGreaterThanOrEqual(3);
    expect(blasts[2]! - blasts[1]!).toBeLessThanOrEqual(4);
    expect(blasts).toHaveLength(3);
    expect([a.alive, b.alive, c.alive]).toEqual([false, false, true]);
  });

  it('a thrower keeps 3 out at most: a new one retires its oldest; a full pool gives up the oldest of all (review M4)', () => {
    const { game, p } = belted(belt([MINE.index, 2]), 20);
    const other = game.addPlayer('other');
    other.x = 90;
    const theirs = armedMine(game, 80, other.id); // someone else's, older than all of ours
    const born: number[] = [];
    for (let k = 0; k < 5; k++) {
      addGrenades(p, MINE.index, 1);
      p.grenadeType = MINE.index;
      born.push(game.tick); // the tick it's thrown on (Game.tick counts up after the step)
      hold(game, p, Btn.Grenade, 1, k % 2 ? 0 : Math.PI); // left and right: they don't stack
      hold(game, p, 0, 40);
    }
    const ours = () => game.grenades.filter((g) => g.alive && g.owner === p.id && g.type === MINE.index);
    expect(ours().map((g) => g.born).sort((a, b) => a - b)).toEqual(born.slice(-MINE.mine.maxLive)); // the last three
    expect([theirs.alive, theirs.owner]).toEqual([true, other.id]); // others' mines don't count against ours

    // every slot taken (mines left all over the map): a frag still goes, the oldest mine of all makes room
    for (let g = game.allocGrenade(); g; g = game.allocGrenade()) Object.assign(g, { alive: true, owner: other.id, x: 100, y: MINE.radius, vx: 0, vy: 0, type: MINE.index, state: MineState.Armed, fuse: 10800 });
    addGrenades(p, FRAG.index, 1);
    p.grenadeType = FRAG.index;
    const frags = p.frags;
    hold(game, p, Btn.Grenade, 1, 1);
    expect(events(game, 'throw')).toHaveLength(1);
    expect(p.frags).toBe(frags - 1);
    expect([theirs.type, theirs.owner]).toEqual([FRAG.index, p.id]); // the oldest mine's slot now holds the frag
    expect(ours()).toHaveLength(MINE.mine.maxLive);
  });

  it('a player who leaves takes its mines with it; its grenades in flight and its clouds become nobody\'s (review M5)', () => {
    const { game, p } = belted(belt(), 5);
    const leaver = game.addPlayer('leaver');
    leaver.x = 60;
    const mine = armedMine(game, 40, leaver.id);
    const frag = game.allocGrenade()!;
    Object.assign(frag, { alive: true, owner: leaver.id, x: 70, y: 3, vx: 0, vy: 0, fuse: 30 });
    const gas = spawnCloud(game, GAS.index, 80, 0, leaver.id)!;
    const mineOfP = armedMine(game, 30, p.id);
    game.removePlayer(leaver.id);
    expect(mine.alive).toBe(false);
    expect([frag.alive, frag.owner]).toEqual([true, -1]);
    expect(gas.owner).toBe(-1);
    expect([mineOfP.alive, mineOfP.owner]).toEqual([true, p.id]);
    // the next player given that id inherits nothing: no kill credit for a blast it didn't throw
    const newcomer = game.addPlayer('newcomer');
    expect(newcomer.id).toBe(leaver.id);
    const victim = dummyAt(game, 70.5);
    hold(game, p, 0, 40);
    expect(events(game, 'death').filter((e) => e.killer === newcomer.id)).toHaveLength(0);
    expect(victim.hp).toBeLessThan(T.healthMax);
  });

  it('flies through the map\'s air like any grenade: wind pushes it, low gravity floats its drop (review M8)', () => {
    const throwIn = (zones: MapZone[]) => {
      const { game, p } = belted(belt([MINE.index, 1]), 20);
      const mech = new Game({ map: { ...flatMap([], [], 120), zones }, seed: 1 });
      const q = mech.addPlayer('q');
      mech.setGrenadeLoadout(q, belt([MINE.index, 1]));
      placeOnGround(mech, q, 20);
      void game;
      void p;
      hold(mech, q, Btn.Grenade, 1, 0);
      const g = mech.grenades.find((x) => x.alive)!;
      hold(mech, q, 0, 30);
      return g;
    };
    const calm = throwIn([]);
    const windy = throwIn([{ id: 'w', kind: 'wind', rect: [0, 0, 120, 28], wind: [0, 6] }]);
    expect(calm.vy).toBe(0); // straight
    expect(windy.vy).toBeGreaterThan(1); // carried up by the wind on its straight flight
  });
});

describe('EMP grenade', () => {
  it('kills jetpacks for 3 s within 4 m (the thrower too, through walls) and disarms mines; 0 damage', () => {
    const { game, p } = belted(belt([EMP.index, 1]), 20, [rect(22, 0, 22.2, 3)]);
    const near = dummyAt(game, 23, 0, { kind: 'jet', periodTicks: 600, burstTicks: 600 }); // behind the wall, jetting
    const far = dummyAt(game, 40, 0, { kind: 'jet', periodTicks: 600, burstTicks: 600 });
    const mine = game.allocGrenade()!;
    Object.assign(mine, { alive: true, owner: p.id, x: 19, y: MINE.radius, vx: 0, vy: 0, type: MINE.index, state: MineState.Armed, fuse: 9999 });
    hold(game, p, Btn.Jet, 20); // we're up too
    const g = game.allocGrenade()!;
    Object.assign(g, { alive: true, owner: p.id, x: 21, y: 1, vx: 0, vy: 0, fuse: 1, type: EMP.index });
    hold(game, p, Btn.Jet, 1);
    expect(events(game, 'explosion')).toEqual([expect.objectContaining({ grenade: EMP.index, radius: EMP.emp.radius })]);
    expect(mine.alive).toBe(false); // disarmed: no blast
    for (const q of [p, near]) {
      expect(q.jetDisabledTicks).toBe(Math.round(EMP.emp.jetDisable * 60) - 1);
      expect(q.jetting).toBe(false);
    }
    expect(far.jetDisabledTicks).toBe(0);
    expect(far.jetting).toBe(true);
    // holding jet does nothing until it wears off: we fall
    hold(game, p, Btn.Jet, 60);
    expect(p.jetting).toBe(false);
    expect(p.grounded).toBe(true);
    hold(game, p, Btn.Jet, Math.round(EMP.emp.jetDisable * 60) - 61);
    expect(p.jetDisabledTicks).toBe(0);
    hold(game, p, Btn.Jet, 2);
    expect(p.jetting).toBe(true);
    expect([p.hp, near.hp]).toEqual([T.healthMax, T.healthMax]);
  });

  it('its lockout blocks the dash too (a dash is a jetpack burst, docs/02 §21)', () => {
    const { game, p } = belted(belt(), 20);
    p.jetDisabledTicks = 60;
    const x0 = p.x;
    hold(game, p, Btn.Dash | Btn.Right, 1);
    hold(game, p, Btn.Right, 5);
    expect(p.dashTicks).toBe(0);
    expect(p.x - x0).toBeLessThan(0.5); // walking, not a 14 m/s burst
    hold(game, p, 0, 60);
    const x1 = p.x;
    hold(game, p, Btn.Dash | Btn.Right, 1);
    expect(p.dashTicks).toBeGreaterThan(0);
    hold(game, p, 0, 8);
    expect(p.x - x1).toBeGreaterThan(1);
  });
});
