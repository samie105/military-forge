import {
  DROPPED_PICKUP_SECONDS,
  GRENADE_PICKUP_COUNT,
  RIOT_SHIELD,
  RIOT_SHIELD_PICKUP,
  fluxLabMap,
  grenades,
  lunarOutpostMap,
  movementTestMap,
  pickups,
  stormFrontMap,
  type MapDef,
  type MapSpawner,
} from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, DamageSource, Game, Match, MatchPhase, createInput, giveShield, hashGame, type Input, type PlayerState, type SimEvent } from '../src';
import { flatMap, hold, placeOnGround, rect } from './helpers';

const SPOTS = [
  { x: 10, y: 0 },
  { x: 20, y: 0 },
  { x: 30, y: 0 },
];

function spawnerMap(over: Partial<MapSpawner> = {}, base: MapDef = flatMap()): MapDef {
  return { ...base, spawners: [{ id: 'test', pool: 'shield', spots: SPOTS, first: [1, 1], respawn: [2, 4], ...over }] };
}

function withPickups(map: MapDef, seed = 1): { game: Game; p: PlayerState } {
  const game = new Game({ map, seed, pickups: true });
  const p = game.addPlayer('tester');
  return { game, p };
}

const alive = (game: Game) => game.pickups.filter((k) => k.alive);

function events<K extends SimEvent['type']>(game: Game, type: K): Extract<SimEvent, { type: K }>[] {
  return game.events.filter((e): e is Extract<SimEvent, { type: K }> => e.type === type);
}

/** Lets items appear and takes each one (teleporting onto it), logging [tick it appeared, spot]. */
function spawnLog(seed: number, cycles: number): [number, number][] {
  const { game, p } = withPickups(spawnerMap(), seed);
  p.x = 50; // well away from every spot
  const log: [number, number][] = [];
  while (log.length < cycles) {
    hold(game, p, 0, 1);
    const k = alive(game)[0];
    if (!k) continue;
    log.push([game.tick, k.spot]);
    expect([k.x, k.y]).toEqual([SPOTS[k.spot]!.x, SPOTS[k.spot]!.y]);
    p.x = k.x;
    p.y = k.y;
    hold(game, p, 0, 1);
    expect(k.alive).toBe(false);
    p.shieldHp = 0; // drop it on the floor of the test, not the map
    p.shieldTicks = 0;
    p.x = 50;
  }
  return log;
}

describe('pickup spawners', () => {
  it('pick the spot and the time from the seeded PRNG: same seed, same items; every spot gets used', () => {
    const a = spawnLog(7, 40);
    expect(spawnLog(7, 40)).toEqual(a);
    expect(spawnLog(8, 40)).not.toEqual(a);
    expect(new Set(a.map(([, spot]) => spot)).size).toBe(SPOTS.length);
    // the first item after `first` (1 s); each next one 2–4 s after the last was taken
    expect(a[0]![0]).toBe(60);
    const gaps = a.slice(1).map(([t], i) => t - a[i]![0] - 1);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(120);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(240);
    expect(new Set(gaps).size).toBeGreaterThan(10); // random times, not a fixed period
  }, 30_000); // three 40-item runs: ~0.2 s, but the shared build machine can be very slow

  it('keeps maxActive items out at once, each on its own spot, and waits while they are all out', () => {
    const { game, p } = withPickups(spawnerMap({ maxActive: 2, respawn: [1, 1] }));
    p.x = 50;
    hold(game, p, 0, 60 * 10);
    const items = alive(game);
    expect(items.length).toBe(2);
    expect(items[0]!.spot).not.toBe(items[1]!.spot);
    expect(game.spawners[0]!.active).toBe(2);
  });

  it('a spot already holding an item is never chosen again until it is taken', () => {
    const { game, p } = withPickups(spawnerMap({ maxActive: 3, first: [0, 0], respawn: [0, 0] }));
    p.x = 50;
    hold(game, p, 0, 5);
    expect(alive(game).map((k) => k.spot).sort()).toEqual([0, 1, 2]);
  });

  it('unknown pools and impossible spawners are refused when the game is made', () => {
    expect(() => new Game({ map: spawnerMap({ pool: 'nope' }), pickups: true })).toThrow(/unknown pool/);
    expect(() => new Game({ map: spawnerMap({ maxActive: 4 }), pickups: true })).toThrow(/maxActive/);
    expect(() => new Game({ map: spawnerMap({ spots: [] }), pickups: true })).toThrow(/no spots/);
    expect(() => new Game({ map: spawnerMap({ respawn: [5, 2] }), pickups: true })).toThrow(/time range/);
    // with pickups off the spawners are not even read
    expect(() => new Game({ map: spawnerMap({ pool: 'nope' }) })).not.toThrow();
  });
});

describe('taking and dropping', () => {
  it('walking over a shield picks it up (full HP) and frees the spot', () => {
    const { game, p } = withPickups(spawnerMap({ spots: [SPOTS[0]!] }));
    placeOnGround(game, p, 6);
    hold(game, p, 0, 60);
    const k = alive(game)[0]!;
    expect(k.def).toBe(RIOT_SHIELD_PICKUP.index);
    let taken: Extract<SimEvent, { type: 'pickup' }> | undefined;
    for (let i = 0; i < 120 && !taken; i++) {
      hold(game, p, Btn.Right, 1);
      taken = events(game, 'pickup')[0];
    }
    expect(taken).toEqual({ type: 'pickup', player: p.id, item: RIOT_SHIELD_PICKUP.index, x: 10, y: 0 });
    expect(Math.abs(p.x - 10)).toBeLessThanOrEqual(RIOT_SHIELD_PICKUP.reach);
    expect(p.shieldHp).toBe(RIOT_SHIELD.hp);
    expect(k.alive).toBe(false);
    expect(game.spawners[0]!.active).toBe(0);
    expect(game.spawners[0]!.timer).toBeGreaterThanOrEqual(120);
  });

  it('flying over an item well above it does not take it', () => {
    const { game, p } = withPickups(spawnerMap({ spots: [SPOTS[0]!] }));
    placeOnGround(game, p, 6);
    hold(game, p, 0, 60);
    p.x = 10;
    p.y = 1.2;
    p.grounded = false;
    hold(game, p, Btn.Jet, 1);
    expect(alive(game).length).toBe(1);
    expect(p.shieldHp).toBe(0);
  });

  it('a carrier only takes a shield with more HP left than its own (it tops its own up)', () => {
    const { game, p } = withPickups(spawnerMap({ spots: [SPOTS[0]!] }));
    hold(game, p, 0, 60);
    giveShield(p, RIOT_SHIELD.hp);
    p.x = 10;
    p.y = 0;
    hold(game, p, 0, 2);
    expect(alive(game).length).toBe(1); // ours is as good: the item stays
    p.shieldHp = 120;
    hold(game, p, 0, 1);
    expect(alive(game).length).toBe(0);
    expect(p.shieldHp).toBe(RIOT_SHIELD.hp);
  });

  it('dying drops the shield on the floor below with the HP it had; it stays 30 s', () => {
    const { game, p } = withPickups(flatMap());
    const other = game.addPlayer('other');
    other.x = 40;
    placeOnGround(game, p, 12);
    giveShield(p, 180);
    p.y = 4; // in the air
    p.grounded = false;
    game.damage(p, 500, other.id, DamageSource.World, 0);
    expect(p.alive).toBe(false);
    expect(p.shieldHp).toBe(0);
    const k = alive(game)[0]!;
    expect([k.x, k.y, k.hp, k.spawner]).toEqual([12, 0, 180, -1]);
    expect(k.ttl).toBe(DROPPED_PICKUP_SECONDS * 60);

    // the other player takes it with the HP it had
    placeOnGround(game, other, 11);
    const inputs: Input[] = [];
    inputs[other.id] = { ...createInput(), buttons: Btn.Right };
    for (let i = 0; i < 30 && other.shieldHp === 0; i++) game.step(inputs);
    expect(other.shieldHp).toBe(180);
    expect(k.alive).toBe(false);
  });

  it('a dropped item vanishes after 30 s; over a pit, or with pickups off, nothing drops', () => {
    const { game, p } = withPickups(flatMap());
    placeOnGround(game, p, 12);
    giveShield(p, 90);
    game.damage(p, 500, -1, DamageSource.World, 0);
    const k = alive(game)[0]!;
    for (let t = 0; t < DROPPED_PICKUP_SECONDS * 60 - 1; t++) game.step([]);
    expect(k.alive).toBe(true);
    game.step([]);
    expect(k.alive).toBe(false);

    const pit: MapDef = { ...flatMap(), solids: [rect(-2, -6, 20, 0), rect(30, -6, 62, 0), rect(-2, 0, 0, 28), rect(60, 0, 62, 28), rect(-2, 28, 62, 30)] };
    const g2 = new Game({ map: pit, pickups: true });
    const q = g2.addPlayer('q');
    q.x = 25;
    q.y = 3;
    giveShield(q, 90);
    g2.damage(q, 500, -1, DamageSource.World, 0);
    expect(alive(g2).length).toBe(0);

    const off = new Game({ map: flatMap() });
    const r = off.addPlayer('r');
    placeOnGround(off, r, 12);
    giveShield(r, 90);
    off.damage(r, 500, -1, DamageSource.World, 0);
    expect(r.shieldHp).toBe(0);
    expect(alive(off).length).toBe(0);
  });

  it('a carrier leaving the game drops its shield like a death does (review L4)', () => {
    const { game, p } = withPickups(flatMap());
    const other = game.addPlayer('other');
    placeOnGround(game, p, 12);
    giveShield(p, 140);
    game.removePlayer(p.id);
    const k = alive(game)[0]!;
    expect([k.x, k.y, k.hp, k.spawner]).toEqual([12, 0, 140, -1]);
    placeOnGround(game, other, 11.8);
    expect(other.shieldHp).toBe(140);
  });

  it('a match start clears the warm-up items and starts the spawners over', () => {
    const game = new Game({ map: spawnerMap(), seed: 3, pickups: true, dummies: false });
    const a = game.addPlayer('a');
    const b = game.addPlayer('b');
    a.x = b.x = 50;
    const match = new Match(game, { countdown: 1 });
    for (let t = 0; t < 70; t++) match.step([]);
    expect(alive(game).length).toBe(1);
    match.start();
    match.step([]);
    expect(match.phase).toBe(MatchPhase.Countdown);
    expect(alive(game).length).toBe(0);
    expect(game.spawners[0]!.timer).toBe(60);
  });
});

describe('grenade pairs (arsenal B; owner: a random pair of one type from each spot\'s pool)', () => {
  it('a spawner on the grenades pool puts out pairs of one type each, drawn by the seeded PRNG', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const { game, p } = withPickups(spawnerMap({ pool: 'grenades', spots: [{ x: 10, y: 0 }] }), seed);
      p.x = 50;
      hold(game, p, 0, 61); // first: [1, 1] s
      const k = alive(game)[0]!;
      const def = pickups[k.def]!;
      expect(def.kind).toBe('grenades');
      seen.add(def.grenade!);
    }
    // all six types turn up across seeds (frags most often: SPAWN_POOLS.grenades weights)
    expect([...seen].sort()).toEqual(grenades.map((g) => g.index));
  });

  it('touching one adds the pair to the belt, up to the carry limit; a full type leaves it on the floor', () => {
    const { game, p } = withPickups(spawnerMap({ pool: 'grenades', spots: [{ x: 10, y: 0 }], respawn: [600, 600] }), 3);
    p.x = 50;
    hold(game, p, 0, 61); // first: [1, 1] s
    const k = alive(game)[0]!;
    const type = pickups[k.def]!.grenade!;
    const def = grenades[type]!;
    // full of that type: it stays
    game.setGrenadeLoadout(p, grenades.map((g) => (g.index === type ? g.maxCount : 0)));
    placeOnGround(game, p, 10);
    hold(game, p, 0, 1);
    expect(k.alive).toBe(true);
    expect(events(game, 'pickup')).toHaveLength(0);
    // room for it: a pair (or what fits), and the event names the item
    game.setGrenadeLoadout(p, grenades.map((g) => (g.index === type ? def.maxCount - 1 : 0)));
    hold(game, p, 0, 1);
    expect(k.alive).toBe(false);
    expect(p.grenadeCounts[type]).toBe(def.maxCount);
    expect(events(game, 'pickup')).toEqual([expect.objectContaining({ player: p.id, item: k.def })]);
    // empty-handed: two of it, and it's selected
    const q = withPickups(spawnerMap({ pool: 'grenades', spots: [{ x: 10, y: 0 }] }), 3);
    q.game.setGrenadeLoadout(q.p, grenades.map(() => 0));
    q.p.x = 50;
    hold(q.game, q.p, 0, 61);
    placeOnGround(q.game, q.p, 10);
    hold(q.game, q.p, 0, 1);
    expect(q.p.grenadeCounts[type]).toBe(Math.min(GRENADE_PICKUP_COUNT, def.maxCount));
    expect(q.p.grenadeType).toBe(type);
  });

  it('every demo map and the test range have a grenades spawner', () => {
    for (const map of [movementTestMap, lunarOutpostMap, stormFrontMap, fluxLabMap]) {
      expect(map.spawners?.some((s) => s.pool === 'grenades'), map.id).toBe(true);
      new Game({ map, pickups: true }); // valid spots, pools and timers
    }
  });
});

describe('maps without pickups play bit-identically', () => {
  /** Per-tick hashes of a fixed scripted run with a shooter and a walker. */
  function run(game: Game): number[] {
    const a = game.addPlayer('a');
    const b = game.addPlayer('b');
    placeOnGround(game, a, 8);
    placeOnGround(game, b, 16);
    const inputs: Input[] = [];
    const hashes: number[] = [];
    for (let t = 0; t < 600; t++) {
      inputs[a.id] = { ...createInput(), buttons: (t % 120 < 60 ? Btn.Right : Btn.Left) | (t % 7 === 0 ? Btn.Fire : 0) | (t % 200 === 5 ? Btn.Shield : 0) };
      inputs[b.id] = { ...createInput(), buttons: t % 90 < 30 ? Btn.Jet : Btn.Down, aim: 32768 };
      game.step(inputs);
      hashes.push(hashGame(game));
    }
    return hashes;
  }

  it('a map without spawners: pickups on or off, same hashes', () => {
    expect(run(new Game({ map: flatMap(), seed: 5, pickups: true }))).toEqual(run(new Game({ map: flatMap(), seed: 5 })));
  });

  it("the movement-test map with pickups off is the map without its spawners", () => {
    const { spawners: _ignored, ...bare } = movementTestMap;
    expect(movementTestMap.spawners?.length).toBeGreaterThan(0);
    expect(run(new Game({ map: movementTestMap, seed: 5, dummies: true }))).toEqual(run(new Game({ map: bare, seed: 5, dummies: true, pickups: true })));
  });
});
