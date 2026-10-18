/**
 * Map rules and zones (docs/02 §20): one test per effect, the bullet range maths, validation, and
 * the guarantee that a map's mechanics change nothing where they don't apply.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAG, HAMMER, defaultTuning, getMap, type MapDef, type MapModifiers, type MapZone } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, Game, MapMechanics, SPEED_LIMIT, createBodyEnv, decodeRuns, hashGame, type Input, type ReplayFile } from '../src';
import { dummyAt, flatMap, hold, makeGame, placeOnGround, rect } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));

function withMech(zones: MapZone[] = [], rules?: MapModifiers, base: MapDef = flatMap()): MapDef {
  return { ...base, zones, ...(rules ? { rules } : {}) };
}

/** A replay's per-tick hashes on another map object (same inputs, seed and starts). */
function replayOn(file: string, map: MapDef): number[] {
  const replay = JSON.parse(readFileSync(join(here, 'replays', file), 'utf8')) as ReplayFile;
  const game = new Game({ map, seed: replay.seed, dummies: replay.dummies, tuning: replay.tuning ?? {} });
  const ids = replay.players.map((_, i) => {
    const p = game.addPlayer(`P${i + 1}`);
    const start = replay.starts?.[i];
    if (start) p.spawn(start.x, start.y, game.tuning);
    const loadout = replay.loadouts?.[i];
    if (loadout) game.setLoadout(p, loadout);
    return p.id;
  });
  const streams = replay.players.map((runs) => decodeRuns(runs, replay.ticks));
  const inputs: (Input | undefined)[] = [];
  const hashes: number[] = [];
  for (let t = 0; t < replay.ticks; t++) {
    ids.forEach((id, i) => (inputs[id] = streams[i]![t]));
    game.step(inputs);
    hashes.push(hashGame(game));
  }
  return hashes;
}

/** Feet height reached (max over `n` ticks) holding `buttons`. */
function apex(game: Game, p: ReturnType<typeof makeGame>['p'], buttons: number, n: number): number {
  let top = p.y;
  for (let i = 0; i < n; i++) {
    hold(game, p, buttons, 1);
    top = Math.max(top, p.y);
  }
  return top;
}

describe('compiling map mechanics', () => {
  it('maps without rules or zones (or with neutral rules) get none', () => {
    expect(new Game({ mapId: 'movement-test' }).mech).toBeNull();
    expect(MapMechanics.compile(flatMap())).toBeNull();
    expect(MapMechanics.compile(withMech([], { gravityMul: 1, drag: 0 }))).toBeNull();
    expect(MapMechanics.compile(withMech([], { gravityMul: 0.5 }))).not.toBeNull();
    expect(MapMechanics.compile(withMech([{ id: 'a', kind: 'lowG', rect: [0, 0, 1, 1] }]))).not.toBeNull();
  });

  it('fills a zone in from its kind; explicit fields win', () => {
    const mech = MapMechanics.compile(withMech([{ id: 'a', kind: 'water', rect: [0, 0, 10, 10], drag: 0.5 }]))!;
    const d = mech.zones[0]!.def;
    expect(d.moveSpeedMul).toBe(0.6);
    expect(d.bulletRangeMul).toBe(0.4);
    expect(d.drag).toBe(0.5);
  });

  it('rejects bad zones with a message naming them', () => {
    const bad: [MapZone, RegExp][] = [
      [{ id: 'a', kind: 'lowG' }, /exactly one of rect or points/],
      [{ id: 'a', kind: 'lowG', rect: [0, 0, 1, 1], points: [0, 0, 1, 0, 1, 1] }, /exactly one/],
      [{ id: 'a', kind: 'nope' as MapZone['kind'], rect: [0, 0, 1, 1] }, /unknown kind/],
      [{ id: 'a', kind: 'toString' as MapZone['kind'], rect: [0, 0, 1, 1] }, /unknown kind "toString"/],
      [{ id: 'a', kind: 'constructor' as MapZone['kind'], rect: [0, 0, 1, 1] }, /unknown kind "constructor"/],
      [{ id: 'a', kind: 'lowG', rect: [1, 0, 0, 1] }, /min < max/],
      [{ id: 'a', kind: 'damping', rect: [0, 0, 1, 1], bulletRangeMul: 0 }, /bulletRangeMul/],
      [{ id: 'a', kind: 'jumpPad', rect: [0, 0, 1, 1], launch: [0, 0] }, /launch/],
      [{ id: 'a', kind: 'jumpPad', rect: [0, 0, 1, 1], launch: [0, 40] }, /launch/],
      [{ id: 'a', kind: 'wind', rect: [0, 0, 1, 1], wind: [1] as unknown as [number, number] }, /wind/],
      [{ id: 'a', kind: 'custom', points: [0, 0, 1, 0] }, /points/],
      [{ id: 'a', kind: 'custom', rect: [0, 0, 1, 1], gravityMul: -1 }, /needs dive > 0/],
      [{ id: 'a', kind: 'reverseG', rect: [0, 0, 1, 1], dive: 0 }, /needs dive > 0/],
    ];
    for (const [zone, msg] of bad) expect(() => new Game({ map: withMech([zone]) }), JSON.stringify(zone)).toThrow(msg);
    expect(() => new Game({ map: withMech([{ id: 'a', kind: 'lowG', rect: [0, 0, 1, 1] }, { id: 'a', kind: 'lowG', rect: [2, 0, 3, 1] }]) })).toThrow(/unique/);
    expect(() => new Game({ map: withMech([], { gravityMul: Number.NaN }) })).toThrow(/rules: gravityMul/);
  });

  it('combines: multipliers multiply, wind adds, dive takes the strongest, any EMP wins', () => {
    const mech = MapMechanics.compile(
      withMech(
        [
          { id: 'low', kind: 'lowG', rect: [0, 0, 10, 10] },
          { id: 'wind', kind: 'wind', rect: [0, 0, 10, 10], wind: [3, 1] },
          { id: 'zero', kind: 'zeroG', rect: [5, 0, 10, 10] },
          { id: 'emp', kind: 'emp', rect: [8, 0, 10, 10] },
        ],
        { gravityMul: 0.5, wind: [1, 0], dive: 20 },
      ),
    )!;
    const env = mech.envAt(2, 5, createBodyEnv());
    expect(env.gravityMul).toBe(0.5 * 0.35);
    expect([env.windX, env.windY]).toEqual([4, 1]);
    expect(env.dive).toBe(20);
    expect(env.jetDisabled).toBe(false);
    expect(mech.envAt(6, 5, env).gravityMul).toBe(0);
    expect(mech.envAt(9, 5, env).jetDisabled).toBe(true);
    expect(mech.envAt(20, 5, env).gravityMul).toBe(0.5); // outside every zone: the rules
  });

  it('polygon zones use their outline, not their bounding box', () => {
    const mech = MapMechanics.compile(withMech([{ id: 'tri', kind: 'lowG', points: [0, 0, 10, 0, 0, 10] }]))!;
    const env = createBodyEnv();
    expect(mech.envAt(2, 2, env).gravityMul).toBe(0.35);
    expect(mech.envAt(8, 8, env).gravityMul).toBe(1);
  });
});

describe('no side effects where mechanics do not apply (goldens stay valid)', () => {
  const movementTest = getMap('movement-test');
  for (const file of ['range-combat.replay.json', 'arsenal-guns.replay.json', 'oneway.replay.json']) {
    it(`${file}: a neutral zone over the whole map, and a zone nobody enters, change no hash`, () => {
      const plain = replayOn(file, movementTest);
      const neutral = replayOn(file, withMech([{ id: 'all', kind: 'custom', rect: [-10, -10, 200, 60] }], undefined, movementTest));
      const far = replayOn(file, withMech([{ id: 'far', kind: 'zeroG', rect: [500, 0, 520, 10] }], { moveSpeedMul: 1 }, movementTest));
      expect(neutral).toEqual(plain);
      expect(far).toEqual(plain);
    });
  }
});

describe('map rules', () => {
  it('gravityMul scales falls', () => {
    const fall = (map: MapDef) => {
      const { game, p } = makeGame(map);
      p.x = 20;
      p.y = 20;
      hold(game, p, 0, 20);
      return 20 - p.y;
    };
    expect(fall(withMech([], { gravityMul: 0.5 })) / fall(flatMap())).toBeCloseTo(0.5, 1);
  });

  it('fuelBurnMul and fuelRegenMul scale the tank', () => {
    const burned = (map: MapDef) => {
      const { game, p } = makeGame(map);
      placeOnGround(game, p, 20);
      hold(game, p, Btn.Jet, 30);
      return defaultTuning.fuelMax - p.fuel;
    };
    expect(burned(withMech([], { fuelBurnMul: 0.5 })) / burned(flatMap())).toBeCloseTo(0.5, 2);
    const refilled = (map: MapDef) => {
      const { game, p } = makeGame(map);
      placeOnGround(game, p, 20);
      p.fuel = 0;
      hold(game, p, 0, 60);
      return p.fuel;
    };
    expect(refilled(withMech([], { fuelRegenMul: 2 }))).toBeGreaterThan(1.8 * refilled(flatMap()));
  });

  it('moveSpeedMul scales the walk cap', () => {
    const { game, p } = makeGame(withMech([], { moveSpeedMul: 0.5 }));
    placeOnGround(game, p, 10);
    hold(game, p, Btn.Right, 40);
    expect(p.vx).toBeCloseTo(2.5, 6);
  });

  it('knockbackMul scales blasts (and lifts the speed cap so big ones still grow)', () => {
    const launch = (map: MapDef) => {
      const { game, p } = makeGame(map);
      placeOnGround(game, p, 20);
      const g = game.allocGrenade()!;
      Object.assign(g, { alive: true, owner: 15, x: 18, y: 0.15, vx: 0, vy: 0, fuse: 1 });
      hold(game, p, 0, 1);
      return Math.hypot(p.vx, p.vy);
    };
    const plain = launch(flatMap());
    expect(launch(withMech([], { knockbackMul: 2 }))).toBeGreaterThan(1.6 * plain);
    expect(launch(withMech([], { knockbackMul: 0 }))).toBeLessThan(0.5);
  });
});

describe('zones: players', () => {
  it('zero-g: no gravity, you drift (drag bleeds it slowly), Down dives', () => {
    const { game, p } = makeGame(withMech([{ id: 'z', kind: 'zeroG', rect: [10, 0, 30, 26] }]));
    placeOnGround(game, p, 20);
    hold(game, p, Btn.Jet, 10);
    const vy = p.vy;
    expect(vy).toBeGreaterThan(1);
    hold(game, p, 0, 60);
    expect(p.vy).toBeGreaterThan(0.5 * vy); // 1 s of drag 0.4/s keeps 67 %, and nothing pulls down
    expect(p.vy).toBeLessThan(vy);
    hold(game, p, Btn.Down, 60);
    expect(p.vy).toBeLessThan(-3); // diving
    expect(p.jetting).toBe(false);
  });

  it('low-g: the same jet tap goes much higher', () => {
    const tap = (map: MapDef) => {
      const { game, p } = makeGame(map);
      placeOnGround(game, p, 20);
      hold(game, p, Btn.Jet, 12);
      return apex(game, p, 0, 180);
    };
    const plain = tap(flatMap());
    expect(tap(withMech([{ id: 'l', kind: 'lowG', rect: [10, 0, 30, 26] }]))).toBeGreaterThan(2 * plain);
  });

  it('reversed gravity lifts you off the floor; you bob at the top edge; Down fights it', () => {
    const { game, p } = makeGame(withMech([{ id: 'r', kind: 'reverseG', rect: [10, 0, 30, 8] }]));
    placeOnGround(game, p, 20);
    hold(game, p, 0, 1);
    expect(p.grounded).toBe(false);
    hold(game, p, 0, 300);
    // after 5 s the body centre hovers at the zone's top (8 m): above it gravity is back, below it pulls up
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < 60; i++) {
      hold(game, p, 0, 1);
      low = Math.min(low, p.y + 0.75);
      high = Math.max(high, p.y + 0.75);
    }
    expect(low).toBeGreaterThan(7.5);
    expect(high).toBeLessThan(8.5);
    hold(game, p, Btn.Down, 240);
    expect(p.y).toBeLessThan(0.5);
  });

  it('reversed gravity up against a ceiling: you can still move along it at air speed (no bonk every tick)', () => {
    // the zone reaches the 28 m ceiling: gravity pins you to it
    const { game, p } = makeGame(withMech([{ id: 'r', kind: 'reverseG', rect: [10, 0, 50, 28] }]));
    placeOnGround(game, p, 20);
    hold(game, p, 0, 240);
    expect(p.y + defaultTuning.standHeight).toBeGreaterThan(27.9);
    const x0 = p.x;
    hold(game, p, Btn.Right, 60);
    expect(p.x - x0).toBeGreaterThan(4); // air control: ~6 m/s; bonking every tick held it near 0.7 m/s
  });

  it('a raised knockback cap never lets a launch tunnel through a thin wall (speed limit 36 m/s)', () => {
    const { game, p } = makeGame(withMech([{ id: 'k', kind: 'custom', rect: [0, 0, 60, 28], knockbackMul: 4 }], undefined, flatMap([rect(23, 0, 23.15, 10)])));
    placeOnGround(game, p, 20);
    // thrown sideways at 100 m/s: the ×4 cap (104 m/s) would let it through; move-and-slide's 4
    // substeps of 0.42 m would carry the capsule past a 0.15 m wall
    p.vx = 100;
    p.vy = 2;
    p.grounded = false;
    let fastest = 0;
    for (let i = 0; i < 30; i++) {
      const [x, y] = [p.x, p.y];
      hold(game, p, 0, 1);
      fastest = Math.max(fastest, Math.hypot(p.x - x, p.y - y) * 60);
      expect(p.x + defaultTuning.capsuleRadius).toBeLessThanOrEqual(23 + 1e-3);
    }
    expect(fastest).toBeLessThanOrEqual(SPEED_LIMIT + 1e-6);
  });

  it('long flight: fuel burns at 40 % inside', () => {
    const { game, p } = makeGame(withMech([{ id: 'l', kind: 'longFlight', rect: [10, 0, 30, 26] }]));
    placeOnGround(game, p, 20);
    hold(game, p, Btn.Jet, 30);
    const plain = makeGame(flatMap());
    placeOnGround(plain.game, plain.p, 20);
    hold(plain.game, plain.p, Btn.Jet, 30);
    expect((defaultTuning.fuelMax - p.fuel) / (defaultTuning.fuelMax - plain.p.fuel)).toBeCloseTo(0.4, 2);
  });

  it('wind pushes fliers, not walkers', () => {
    const { game, p } = makeGame(withMech([{ id: 'w', kind: 'wind', rect: [10, 0, 50, 26] }]));
    placeOnGround(game, p, 20);
    hold(game, p, 0, 10);
    const x = p.x;
    hold(game, p, 0, 30);
    expect(p.x).toBe(x);
    hold(game, p, Btn.Jet, 30);
    expect(p.vx).toBeGreaterThan(4);
  });

  it('mud: 45 % speed caps', () => {
    const { game, p } = makeGame(withMech([{ id: 'm', kind: 'slow', rect: [5, 0, 50, 2] }]));
    placeOnGround(game, p, 10);
    hold(game, p, Btn.Right, 40);
    expect(p.vx).toBeCloseTo(5 * 0.45, 6);
  });

  it('EMP field: no jetpack inside, and it cuts out as you fly in', () => {
    const { game, p } = makeGame(withMech([{ id: 'e', kind: 'emp', rect: [10, 0, 30, 26] }]));
    placeOnGround(game, p, 20);
    hold(game, p, Btn.Jet, 30);
    expect(p.y).toBeLessThan(0.01);
    expect(p.fuel).toBe(defaultTuning.fuelMax);
    p.x = 8;
    hold(game, p, Btn.Jet | Btn.Right, 60);
    expect(p.x).toBeGreaterThan(10);
    expect(p.jetting).toBe(false);
  });

  it('jump pad: launches to ~7 m; standing on it bounces, never stacking speed', () => {
    const { game, p } = makeGame(withMech([{ id: 'pad', kind: 'jumpPad', rect: [18, 0, 22, 1.2] }]));
    placeOnGround(game, p, 16);
    let top = 0;
    let fastest = 0;
    for (let i = 0; i < 240; i++) {
      hold(game, p, i < 40 ? Btn.Right : 0, 1);
      top = Math.max(top, p.y);
      fastest = Math.max(fastest, p.vy);
    }
    expect(top).toBeGreaterThan(5.5);
    expect(top).toBeLessThan(8);
    expect(fastest).toBeLessThanOrEqual(16);
  });

  it('boost pad: a long, flat throw forward', () => {
    const { game, p } = makeGame(withMech([{ id: 'pad', kind: 'boostPad', rect: [10, 0, 12, 1.2] }], undefined, flatMap([], [], 120)));
    placeOnGround(game, p, 8);
    while (p.grounded) hold(game, p, Btn.Right, 1); // walk onto it
    const launchX = p.x;
    expect(p.vx).toBeGreaterThan(12);
    for (let i = 0; i < 300 && !p.grounded; i++) hold(game, p, 0, 1);
    expect(p.x - launchX).toBeGreaterThan(10);
  });

  it('knockback zone: blasts throw harder where the target stands', () => {
    const launch = (map: MapDef) => {
      const { game, p } = makeGame(map);
      placeOnGround(game, p, 20);
      const g = game.allocGrenade()!;
      Object.assign(g, { alive: true, owner: 15, x: 18, y: 0.15, vx: 0, vy: 0, fuse: 1 });
      hold(game, p, 0, 1);
      return Math.hypot(p.vx, p.vy);
    };
    expect(launch(withMech([{ id: 'k', kind: 'custom', rect: [19, 0, 21, 2], knockbackMul: 1.5 }]))).toBeGreaterThan(1.4 * launch(flatMap()));
  });
});

describe('zones: grenades', () => {
  /** Drops a grenade at (x, y) with velocity (vx, vy) and returns it after `n` ticks. */
  function fly(map: MapDef, x: number, y: number, vx: number, vy: number, n: number) {
    const { game } = makeGame(map);
    const g = game.allocGrenade()!;
    Object.assign(g, { alive: true, owner: 0, x, y, vx, vy, fuse: 600 });
    for (let i = 0; i < n; i++) game.step([]);
    return g;
  }

  it('zero-g: floats on its throw', () => {
    const g = fly(withMech([{ id: 'z', kind: 'zeroG', rect: [0, 0, 60, 28] }]), 10, 10, 2, 1, 60);
    expect(g.vy).toBeGreaterThan(0.6);
    expect(g.y).toBeGreaterThan(10.6);
  });

  it('water: sinks slowly', () => {
    const inWater = fly(withMech([{ id: 'w', kind: 'water', rect: [0, 0, 60, 20] }]), 10, 15, 0, 0, 30);
    const inAir = fly(flatMap(), 10, 15, 0, 0, 30);
    expect(15 - inWater.y).toBeLessThan(0.4 * (15 - inAir.y));
  });

  it('wind blows it sideways', () => {
    const g = fly(withMech([{ id: 'w', kind: 'wind', rect: [0, 0, 60, 28] }]), 10, 15, 0, 0, 30);
    expect(g.vx).toBeCloseTo(12 * 0.5, 1);
  });

  it('a jump pad throws it back up', () => {
    const g = fly(withMech([{ id: 'p', kind: 'jumpPad', rect: [5, 0, 15, 1] }]), 10, 3, 0, 0, 60);
    expect(g.y).toBeGreaterThan(3);
    expect(FRAG.radius).toBeLessThan(1);
  });
});

describe('zones: bullets', () => {
  const fog = (rect: [number, number, number, number], bulletRangeMul = 0.5): MapZone => ({ id: `fog${rect.join()}`, kind: 'damping', rect, bulletRangeMul });

  it('a damping zone uses the range up faster: reach and the range used at any point', () => {
    const mech = MapMechanics.compile(withMech([fog([10, -5, 20, 5])]))!;
    mech.castBullet(0, 0, 1, 0);
    // 10 m clear, then 2 m of range per metre of fog: 26 m of range reach 18 m
    expect(mech.bulletReach(26)).toBe(18);
    expect(mech.bulletCost(5)).toBe(5);
    expect(mech.bulletCost(18)).toBe(26);
    expect(mech.bulletReach(8)).toBe(8); // runs out before the fog
    mech.castBullet(30, 0, -1, 0); // the other way: 10 m clear, then the fog
    expect(mech.bulletReach(26)).toBe(18);
  });

  it('a bullet fired inside the fog, overlapping zones (they multiply) and a clear map', () => {
    const mech = MapMechanics.compile(withMech([fog([10, -5, 20, 5]), fog([15, -5, 25, 5])]))!;
    mech.castBullet(12, 0, 1, 0);
    // 3 m at ×2 (6), 5 m at ×4 (20): 26 used at 20 m
    expect(mech.bulletCost(8)).toBe(26);
    expect(mech.bulletReach(26)).toBe(8);
    mech.castBullet(12, 10, 1, 0); // above both: nothing in the way
    expect(mech.bulletReach(26)).toBe(26);
  });

  it('map-wide bulletRangeMul shortens every bullet', () => {
    const mech = MapMechanics.compile(withMech([], { bulletRangeMul: 0.5 }))!;
    mech.castBullet(0, 0, 0.6, 0.8);
    expect(mech.bulletReach(26)).toBe(13);
    expect(mech.bulletCost(13)).toBe(26);
  });

  it('a Hammer shot through fog falls short of a dummy it reaches in clear air', () => {
    const shoot = (map: MapDef) => {
      const { game, p } = makeGame(map);
      placeOnGround(game, p, 5);
      const d = dummyAt(game, 27);
      hold(game, p, 0, 5);
      hold(game, p, Btn.Fire, 1, 0);
      const shot = game.events.find((e) => e.type === 'shot')!;
      return { shot, hp: d.hp, from: p.shoulderX(game.tuning) };
    };
    const clear = shoot(withMech([], undefined, flatMap([], [], 60)));
    expect(clear.shot.type === 'shot' && clear.shot.hit).toBe(2);
    const foggy = shoot(withMech([fog([10, -5, 18, 10], 0.35)]));
    expect(foggy.hp).toBe(100);
    if (foggy.shot.type !== 'shot') throw new Error('no shot');
    expect(foggy.shot.hit).toBe(0);
    // ~4.9 m clear, then the rest of the 26 m at 0.35 m per metre: it dies inside the fog
    const clearRun = 10 - foggy.from;
    expect(foggy.shot.ex - foggy.from).toBeCloseTo(clearRun + (HAMMER.range - clearRun) * 0.35, 1);
  });

  /** One Hammer shot from x 5 along the floor at a dummy at x `dummyX`, with a wall face at `wallX`. */
  function shootPastWall(map: MapDef, dummyX: number) {
    const { game, p } = makeGame(map);
    placeOnGround(game, p, 5);
    const d = dummyAt(game, dummyX);
    hold(game, p, 0, 5);
    hold(game, p, Btn.Fire, 1, Math.atan2(0.8 - p.shoulderY(game.tuning), dummyX - p.shoulderX(game.tuning)));
    const shot = game.events.find((e) => e.type === 'shot');
    if (shot?.type !== 'shot') throw new Error('no shot');
    return { shot, hp: d.hp, from: p.shoulderX(game.tuning) };
  }

  it('fog: a wall inside the weapon range but past the shortened reach is never reached (regression)', () => {
    // 5 m clear, then fog: the Hammer's 26 m of range run out ~12 m out; the wall at 20 m is beyond that
    const r = shootPastWall(withMech([fog([10, -5, 18, 10], 0.35)], undefined, flatMap([rect(20, 0, 21, 6)], [], 60)), 30);
    expect(r.shot.hit).toBe(0);
    expect(r.shot.ex - r.from).toBeLessThan(13);
    // and a wall inside the reach still stops it
    const near = shootPastWall(withMech([fog([10, -5, 18, 10], 0.35)], undefined, flatMap([rect(8, 0, 9, 6)], [], 60)), 30);
    expect(near.shot.hit).toBe(1);
    expect(near.shot.ex).toBeCloseTo(8, 2);
  });

  it('range ×2: walls past the nominal range still stop bullets, and nobody behind them is hit (regression)', () => {
    // the Hammer's nominal 26 m end at x ~31; doubled, the bullet reaches 52 m: the wall at 40 must stop it
    const r = shootPastWall(withMech([], { bulletRangeMul: 2 }, flatMap([rect(40, 0, 41, 6)], [], 60)), 45);
    expect(r.shot.hit).toBe(1);
    expect(r.shot.ex).toBeCloseTo(40, 2);
    expect(r.hp).toBe(100);
    // without the wall, the doubled range reaches the dummy at 40 m
    const open = shootPastWall(withMech([], { bulletRangeMul: 2 }, flatMap([], [], 60)), 45);
    expect(open.shot.hit).toBe(2);
  });

  it('damage falls off over the range used up, not the metres flown', () => {
    const hit = (map: MapDef) => {
      const { game, p } = makeGame(map);
      placeOnGround(game, p, 5);
      dummyAt(game, 15);
      hold(game, p, 0, 5);
      // at the torso, under the head
      hold(game, p, Btn.Fire, 1, Math.atan2(0.8 - p.shoulderY(game.tuning), 15 - p.shoulderX(game.tuning)));
      const e = game.events.find((x) => x.type === 'hit');
      return e?.type === 'hit' ? e.damage : 0;
    };
    const clear = hit(flatMap());
    const foggy = hit(withMech([fog([7, -5, 11, 10], 0.25)])); // 4 m of fog cost 16: ~22 m of range used
    expect(clear).toBe(HAMMER.damage); // inside falloffStart
    expect(foggy).toBeGreaterThan(HAMMER.damage * HAMMER.minDamageMul);
    expect(foggy).toBeLessThan(0.8 * HAMMER.damage);
  });
});
