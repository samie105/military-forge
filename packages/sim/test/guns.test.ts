/**
 * The owner's "more guns" (docs/03 §5): the new fire modes (burst, spin-up, beam), weapon crates
 * with `E` to swap, and the test armory's rack.
 */
import {
  ARC,
  BREACHER,
  BUZZ,
  HAMMER,
  K47,
  SHREDDER,
  TRIDENT,
  WIDOW,
  defaultTuning as T,
  maps,
  weaponPickup,
  weapons,
} from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { ARMORY_RESPAWN, Btn, Game, SPIN_FULL, SegFlag, createRayHit, type SimEvent } from '../src';
import { dummyAt, flatMap, hold, makeGame, placeOnGround } from './helpers';

function shots(game: Game): Extract<SimEvent, { type: 'shot' }>[] {
  return game.events.filter((e): e is Extract<SimEvent, { type: 'shot' }> => e.type === 'shot');
}

/** Ticks (from 0) on which `p` fired while holding `buttons` for `n` ticks. */
function fireTicks(game: Game, p: { id: number }, buttons: number, n: number, aim = 0): number[] {
  const out: number[] = [];
  for (let t = 0; t < n; t++) {
    hold(game, game.players[p.id]!, buttons, 1, aim);
    if (shots(game).some((e) => e.shooter === p.id)) out.push(t);
  }
  return out;
}

function armed(loadout: [number, number]) {
  const { game, p } = makeGame(flatMap([], [], 200));
  game.setLoadout(p, loadout);
  placeOnGround(game, p, 10);
  return { game, p };
}

describe('burst, spin-up and beam (more guns)', () => {
  it('Trident: a press fires three rounds 0.07 s apart; held, the next burst starts 0.5 s after the first', () => {
    const { game, p } = armed([TRIDENT.index, HAMMER.index]);
    expect(fireTicks(game, p, Btn.Fire, 1)).toEqual([0]); // a one-tick press…
    expect(fireTicks(game, p, 0, 40)).toEqual([3, 7]); // …finishes its burst by itself (rounds at 4 and 8 ticks from the start)
    expect(p.weapons[0].mag).toBe(TRIDENT.mag - 3);
    const held = fireTicks(game, p, Btn.Fire, 90);
    // bursts every 30 ticks (0.5 s), rounds 4 ticks (0.07 s) apart
    expect(held.slice(0, 6)).toEqual([0, 4, 8, 30, 34, 38]);
    expect(p.weapons[0].burst).toBe(0);
  });

  it('Shredder: nothing until 0.8 s of spin-up, then a stream; the second fire button pre-spins; it winds down', () => {
    const { game, p } = armed([SHREDDER.index, HAMMER.index]);
    const fired = fireTicks(game, p, Btn.Fire, 70);
    expect(fired[0]).toBeGreaterThanOrEqual(47);
    expect(fired[0]).toBeLessThanOrEqual(49);
    expect(fired.length).toBeGreaterThanOrEqual(4);
    hold(game, p, 0, 70); // let go: spun down in a second
    expect(p.weapons[0].spin).toBe(0);
    hold(game, p, Btn.Fire2, 50); // pre-spin, no shots
    expect(shots(game)).toHaveLength(0);
    expect(p.weapons[0].spin).toBe(SPIN_FULL);
    expect(fireTicks(game, p, Btn.Fire | Btn.Fire2, 1)).toEqual([0]); // fires at once
    // heavy: ×0.7 speed while held
    expect(SHREDDER.moveSpeedMul).toBe(0.7);
  });

  it('Arc: a ray every 0.15 s with no falloff; the cell runs dry and refills by itself, never a reload', () => {
    const { game, p } = armed([ARC.index, HAMMER.index]);
    const near = dummyAt(game, 13);
    hold(game, p, Btn.Fire, 1);
    const hitNear = game.events.find((e) => e.type === 'hit' && e.target === near.id) as { damage: number } | undefined;
    expect(hitNear?.damage).toBeCloseTo(ARC.damage, 6);
    near.x = 60; // 50 m out: still full damage
    near.hp = T.healthMax;
    hold(game, p, 0, 10);
    hold(game, p, Btn.Fire, 1);
    const hitFar = game.events.find((e) => e.type === 'hit' && e.target === near.id) as { damage: number } | undefined;
    expect(hitFar?.damage).toBeCloseTo(ARC.damage, 6);
    near.x = 150; // out of the way
    const fired: number[] = [];
    for (let t = 0; t < 600 && p.weapons[0].mag > 0; t++) fired.push(...fireTicks(game, p, Btn.Fire, 1, Math.PI / 2).map(() => t));
    expect(fired[1]! - fired[0]!).toBe(9);
    expect(p.weapons[0].mag).toBe(0);
    hold(game, p, Btn.Fire, 60, Math.PI / 2); // held on an empty cell: it waits, no reload, nothing fires
    expect([p.weapons[0].mag, p.weapons[0].reloadTicks]).toEqual([0, 0]);
    hold(game, p, 0, 1);
    p.weapons[0].ticksSinceShot = 0; // as if the last ray had just gone
    hold(game, p, 0, 28);
    expect(p.weapons[0].mag).toBe(0); // half a second off the trigger first
    hold(game, p, 0, 61);
    expect(p.weapons[0].mag).toBeGreaterThanOrEqual(9);
    expect(p.weapons[0].mag).toBeLessThanOrEqual(11); // ~10 a second
  });
});

describe('weapon crates (more guns)', () => {
  /** A flat map with one crate spawner at x 20 holding `weapon`. */
  function crate(weapon: number) {
    const map = { ...flatMap([], [], 120), spawners: [{ id: 'w', pool: weaponPickup(weapon)!.id, spots: [{ x: 20, y: 0 }], first: [0, 0] as [number, number], respawn: [600, 600] as [number, number] }] };
    const game = new Game({ map, seed: 4, pickups: true });
    const p = game.addPlayer('p');
    game.setLoadout(p, [HAMMER.index, BUZZ.index]);
    placeOnGround(game, p, 30);
    return { game, p, item: () => game.pickups.filter((k) => k.alive) };
  }

  it('a gun you hold tops its reserve up and is spent; when it is full the crate stays', () => {
    const { game, p, item } = crate(HAMMER.index);
    p.x = 20;
    hold(game, p, 0, 1);
    expect(item()).toHaveLength(1); // full already
    p.weapons[0].reserve = 3;
    hold(game, p, 0, 1);
    expect(p.weapons[0].reserve).toBe(HAMMER.reserve);
    expect(item()).toHaveLength(0);
  });

  it('another gun takes E: into the slot in hand with the crate\'s ammo; the old gun drops with its ammo for 30 s', () => {
    const { game, p, item } = crate(WIDOW.index);
    p.x = 20;
    hold(game, p, 0, 3);
    expect(p.weapons[0].def).toBe(HAMMER.index); // walking over it doesn't swap
    p.weapons[0].mag = 2; // a used Hammer
    hold(game, p, Btn.Interact, 1);
    expect([p.weapons[0].def, p.weapons[0].mag, p.weapons[0].reserve]).toEqual([WIDOW.index, WIDOW.mag, WIDOW.reserve]);
    expect(p.swapTicks).toBeGreaterThan(0);
    expect(game.events).toContainEqual(expect.objectContaining({ type: 'pickup', player: p.id, item: weaponPickup(WIDOW.index)!.index }));
    const dropped = item();
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ def: weaponPickup(HAMMER.index)!.index, mag: 2, reserve: HAMMER.reserve, spawner: -1 });
    expect(dropped[0]!.ttl).toBe(30 * 60);
    // E again on the same spot: the Hammer back, as it was; the Widow on the floor in its place
    hold(game, p, 0, 1);
    hold(game, p, Btn.Interact, 1);
    expect([p.weapons[0].def, p.weapons[0].mag]).toEqual([HAMMER.index, 2]);
    expect(item().map((k) => k.def)).toEqual([weaponPickup(WIDOW.index)!.index]);
  });

  it('on a one-way platform, the gun swapped out lands on the platform', () => {
    const map = {
      ...flatMap([], [{ ax: 15, ay: 4, bx: 25, by: 4 }], 120),
      spawners: [{ id: 'w', pool: weaponPickup(WIDOW.index)!.id, spots: [{ x: 20, y: 4 }], first: [0, 0] as [number, number], respawn: [600, 600] as [number, number] }],
    };
    const game = new Game({ map, seed: 4, pickups: true });
    const p = game.addPlayer('p');
    game.setLoadout(p, [HAMMER.index, BUZZ.index]);
    placeOnGround(game, p, 20, 4);
    hold(game, p, Btn.Interact, 1);
    expect(p.weapons[0].def).toBe(WIDOW.index);
    const dropped = game.pickups.filter((k) => k.alive);
    expect(dropped.map((k) => [k.def, k.y])).toEqual([[weaponPickup(HAMMER.index)!.index, 4]]);
  });

  it('a gun you hold takes only the item\'s rounds: an empty one is no ammo box (review Low)', () => {
    const { game, p, item } = crate(HAMMER.index);
    const k = item()[0]!;
    Object.assign(k, { mag: 0, reserve: 0 }); // a Hammer dropped empty
    p.weapons[0].reserve = 3;
    p.x = 20;
    hold(game, p, 0, 2);
    expect([p.weapons[0].reserve, item().length]).toEqual([3, 1]);
    Object.assign(k, { mag: 2, reserve: 5 });
    hold(game, p, 0, 1);
    expect([p.weapons[0].reserve, item().length]).toEqual([10, 0]);
  });

  it('fire, E, E: the gun taken back keeps the rest of its interval (review H1); so does a gun taken right after a shot', () => {
    const { game, p, item } = crate(WIDOW.index);
    game.setLoadout(p, [BREACHER.index, BUZZ.index]);
    p.x = 20;
    hold(game, p, 0, 40);
    expect(item()).toHaveLength(1);
    hold(game, p, Btn.Fire, 1);
    const fired = game.tick;
    const interval = Math.ceil(BREACHER.interval * 60);
    hold(game, p, Btn.Interact, 1); // the Widow in hand, the Breacher on the floor
    expect(p.weapons[0].def).toBe(WIDOW.index);
    expect(p.weapons[0].cooldown).toBeGreaterThan(interval - 5); // the Breacher's wait carries over
    hold(game, p, 0, 1);
    hold(game, p, Btn.Interact, 1); // the Breacher back
    expect(p.weapons[0].def).toBe(BREACHER.index);
    // spam the trigger: the next shot only once its interval since the last one is up (not after the equip)
    let next = -1;
    for (let t = 0; t < 120 && next < 0; t++) {
      hold(game, p, t % 2 ? Btn.Fire : 0, 1);
      if (game.events.some((e) => e.type === 'shot' && e.shooter === p.id)) next = game.tick;
    }
    expect(next - fired).toBeGreaterThanOrEqual(interval - 1);
    // and over 10 s of fire-E-E, no more pulls than its rate allows
    let pulls = 1;
    for (let t = 0; t < 600; t++) {
      const b = t % 6 === 0 ? Btn.Fire : t % 6 === 2 || t % 6 === 4 ? Btn.Interact : 0;
      hold(game, p, b, 1);
      if (game.events.some((e) => e.type === 'shot' && e.shooter === p.id)) pulls++;
      p.weapons[0].mag = 5; // whichever gun is in hand, never empty
    }
    expect(pulls).toBeLessThanOrEqual(Math.floor(600 / interval) + 2);
  });

  it('taking a two-handed gun ends dual-wielding', () => {
    const { game, p } = crate(K47.index);
    hold(game, p, Btn.Dual, 1);
    expect(p.dual).toBe(true);
    p.x = 20;
    hold(game, p, 0, 30);
    hold(game, p, Btn.Interact, 1);
    expect(p.dual).toBe(false);
    expect(p.weapons[p.active]!.def).toBe(K47.index);
  });
});

describe('the test armory (GameOptions.armory)', () => {
  it('a rack of one of every gun by the spawns; a gun taken is back in 2 s and the old one is not dropped', () => {
    const game = new Game({ mapId: 'movement-test', seed: 1, pickups: true, armory: true });
    const p = game.addPlayer('p');
    game.step([]);
    const rack = game.pickups.filter((k) => k.alive && game.spawners[k.spawner]?.def.id.startsWith('armory-'));
    expect(rack.map((k) => k.def).sort((a, b) => a - b)).toEqual(weapons.map((w) => weaponPickup(w.index)!.index));
    const widow = rack.find((k) => k.def === weaponPickup(WIDOW.index)!.index)!;
    placeOnGround(game, p, widow.x, widow.y);
    hold(game, p, Btn.Interact, 1);
    expect(p.weapons[p.active]!.def).toBe(WIDOW.index);
    expect(game.pickups.filter((k) => k.alive && k.spawner < 0)).toHaveLength(0); // nothing dropped
    hold(game, p, 0, ARMORY_RESPAWN * 60 + 1);
    expect(game.pickups.some((k) => k.alive && k.def === widow.def)).toBe(true);
  });

  it('off by default, and off without pickups', () => {
    const count = (o: ConstructorParameters<typeof Game>[0]) => new Game(o).spawners.filter((s) => s.def.id.startsWith('armory-')).length;
    expect(count({ mapId: 'movement-test', pickups: true })).toBe(0);
    expect(count({ mapId: 'movement-test', armory: true })).toBe(0);
    expect(count({ mapId: 'movement-test', pickups: true, armory: true })).toBe(weapons.length);
  });

  it('every map: its spawner spots and its rack sit on a floor, and the rack holds every gun', () => {
    const ray = createRayHit();
    for (const map of Object.values(maps)) {
      const game = new Game({ map, pickups: true, armory: true });
      const rack = game.spawners.filter((s) => s.def.id.startsWith('armory-'));
      expect(rack.length, map.id).toBe(weapons.length);
      for (const s of game.spawners) {
        for (const spot of s.def.spots) {
          const where = `${map.id} ${s.def.id} (${spot.x}, ${spot.y})`;
          // something to stand on just below the spot (one-way platforms count), nothing solid at it
          expect(game.world.raycast(spot.x, spot.y + 0.3, 0, -1, 0.6, 0, ray), where).toBe(true);
          expect(game.world.raycast(spot.x, spot.y + 1.2, 0, -1, 1.1, SegFlag.OneWay | SegFlag.BulletPass, ray), `${where}: in a wall`).toBe(false);
        }
      }
    }
  });
});
