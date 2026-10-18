/**
 * One-way platforms that stop bullets (`MapOneWay.blocksBullets`): a floor or roof slab you still
 * fly up through, stand on and drop through, but that stops bullets, ricochet legs, grenades,
 * blasts, gas and sight like a wall. A plain one-way lets all of those through, as a railing does.
 */
import { FRAG, GAS, HAMMER, RIOT_SHIELD, WIDOW, defaultTuning as T, type MapOneWay } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { describe, expect, it } from 'vitest';
import {
  Btn,
  CollisionWorld,
  DamageSource,
  Game,
  SHIELD_RAISE_TICKS,
  SegFlag,
  createInput,
  explode,
  giveShield,
  lineOfSight,
  shieldRaised,
  spawnCloud,
  type Input,
  type PlayerState,
  type SimEvent,
} from '../src';
import { dummyAt, flatMap, hold, makeGame, placeOnGround, rect } from './helpers';

type Ev<K extends SimEvent['type']> = Extract<SimEvent, { type: K }>;
const events = <K extends SimEvent['type']>(list: readonly SimEvent[], type: K): Ev<K>[] => list.filter((e): e is Ev<K> => e.type === type);

/** A level one-way from ax to bx at height y; `blocksBullets` makes it a slab. */
const platform = (ax: number, bx: number, y: number, blocksBullets?: boolean): MapOneWay => ({ ax, ay: y, bx, by: y, ...(blocksBullets === undefined ? {} : { blocksBullets }) });

/** Each player's input for the next steps (aim in radians). */
type Plan = Map<PlayerState, { buttons: number; aim: number }>;

function step(game: Game, plan: Plan, n = 1): SimEvent[] {
  const inputs: Input[] = [];
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    for (const [p, { buttons, aim }] of plan) inputs[p.id] = { ...createInput(), buttons, aim: angleToU16(aim) };
    game.step(inputs);
    all.push(...game.events);
  }
  return all;
}

/** One trigger pull by `p` aimed from its shoulder at (tx, ty). */
function fireAt(game: Game, plan: Plan, p: PlayerState, tx: number, ty: number): SimEvent[] {
  const sx = p.x + (tx >= p.x ? 1 : -1) * T.shoulderForward;
  plan.get(p)!.aim = Math.atan2(ty - (p.y + T.shoulderStand), tx - sx);
  plan.get(p)!.buttons = Btn.Fire;
  const out = step(game, plan);
  plan.get(p)!.buttons = 0;
  out.push(...step(game, plan, 30));
  return out;
}

describe('one-way slabs that stop bullets (blocksBullets)', () => {
  it('compile as one-way without BulletPass; a plain one-way (no flag, or false) lets bullets through', () => {
    const world = new CollisionWorld(flatMap([], [platform(10, 20, 4), platform(25, 35, 4, false), platform(40, 50, 4, true)]));
    const oneWays: number[] = [];
    for (let s = 0; s < world.segCount; s++) if (world.flags[s]! & SegFlag.OneWay) oneWays.push(world.flags[s]!);
    expect(oneWays).toEqual([SegFlag.OneWay | SegFlag.BulletPass, SegFlag.OneWay | SegFlag.BulletPass, SegFlag.OneWay]);
  });

  it('stop bullets from below and from above; a plain one-way doesn’t', () => {
    for (const blocks of [false, true]) {
      // from below: A on the floor shoots up at a dummy standing on the platform (the line crosses it at x ≈ 10)
      const below = new Game({ map: flatMap([], [platform(8, 16, 4, blocks)]), seed: 3 });
      const a = below.addPlayer('a');
      below.setLoadout(a, [WIDOW.index, HAMMER.index]);
      placeOnGround(below, a, 5);
      const up = dummyAt(below, 12, 4);
      step(below, new Map([[a, { buttons: 0, aim: 0 }]]), 10);
      const shotUp = events(fireAt(below, new Map([[a, { buttons: 0, aim: 0 }]]), a, 12, 5), 'shot')[0]!;
      // from above: A on the platform shoots down at a dummy on the floor
      const above = new Game({ map: flatMap([], [platform(8, 16, 4, blocks)]), seed: 3 });
      const b = above.addPlayer('b');
      above.setLoadout(b, [WIDOW.index, HAMMER.index]);
      placeOnGround(above, b, 12, 4);
      const down = dummyAt(above, 5, 0);
      step(above, new Map([[b, { buttons: 0, aim: Math.PI }]]), 10);
      const shotDown = events(fireAt(above, new Map([[b, { buttons: 0, aim: Math.PI }]]), b, 5, 1), 'shot')[0]!;
      if (blocks) {
        for (const [shot, target] of [[shotUp, up], [shotDown, down]] as const) {
          expect(shot.hit).toBe(1);
          expect(shot.ey).toBeCloseTo(4, 3);
          expect(shot.ex).toBeGreaterThan(9);
          expect(shot.ex).toBeLessThan(11);
          expect(target.hp).toBe(T.healthMax);
        }
      } else {
        expect([shotUp.hit, shotUp.target]).toEqual([2, up.id]);
        expect([shotDown.hit, shotDown.target]).toEqual([2, down.id]);
        expect(up.hp).toBeLessThan(T.healthMax);
        expect(down.hp).toBeLessThan(T.healthMax);
      }
    }
  });

  it('stop a ricochet leg off a riot shield; a plain one-way doesn’t', () => {
    // B stands on a 0.6 m block with its shield up, facing A on the floor: A's shot rises into the
    // shield and the ricochet goes back up and left over A's head, to the left wall
    const duel = (oneWays: MapOneWay[]) => {
      const game = new Game({ map: flatMap([rect(10.5, 0, 13.5, 0.6)], oneWays), seed: 3 });
      const a = game.addPlayer('a');
      const b = game.addPlayer('b');
      game.setLoadout(a, [WIDOW.index, HAMMER.index]);
      placeOnGround(game, a, 5);
      placeOnGround(game, b, 12, 0.6);
      giveShield(b, RIOT_SHIELD.hp);
      const plan: Plan = new Map([
        [a, { buttons: 0, aim: 0 }],
        [b, { buttons: 0, aim: Math.PI }],
      ]);
      step(game, plan, SHIELD_RAISE_TICKS + 5);
      expect(shieldRaised(b)).toBe(true);
      const ev = fireAt(game, plan, a, b.x - RIOT_SHIELD.forward, b.y + 1.1);
      expect(events(ev, 'shot')[0]!.hit).toBe(3); // the shield
      return events(ev, 'ricochet')[0]!;
    };
    const free = duel([]);
    expect(free.ey).toBeGreaterThan(free.y);
    expect(free.ex).toBeLessThan(0.1); // the left wall
    // a platform across the leg's middle, well over A's head (the shot passes under it)
    const mx = (free.x + free.ex) / 2;
    const my = (free.y + free.ey) / 2;
    expect(my).toBeGreaterThan(2);
    const plain = duel([platform(mx - 1.5, mx + 1.5, my, false)]);
    expect([plain.hit, plain.ex, plain.ey]).toEqual([free.hit, free.ex, free.ey]);
    const stopped = duel([platform(mx - 1.5, mx + 1.5, my, true)]);
    expect(stopped.hit).toBe(1);
    expect(stopped.ey).toBeCloseTo(my, 3);
    expect(stopped.ex).toBeCloseTo(mx, 1);
  });

  it('send a grenade thrown up from below back down; through a plain one-way it flies up and lands on top', () => {
    for (const blocks of [false, true]) {
      const { game, p } = makeGame(flatMap([], [platform(4, 16, 4, blocks)]));
      placeOnGround(game, p, 10);
      hold(game, p, Btn.Grenade, 1, Math.PI / 2); // a frag, straight up
      const g = game.grenades.find((x) => x.alive)!;
      expect(g.type).toBe(FRAG.index);
      let top = -Infinity;
      for (let i = 0; i < FRAG.fuse * 60 - 10; i++) {
        hold(game, p, 0, 1);
        top = Math.max(top, g.y);
      }
      if (blocks) {
        expect(top).toBeLessThan(4);
        expect(g.y).toBeLessThan(0.5); // back on the floor
      } else {
        expect(top).toBeGreaterThan(5);
        expect(g.y).toBeGreaterThan(4); // resting on the platform
        expect(g.y).toBeLessThan(4.5);
      }
    }
  });

  it('keep blasts, gas and sight from reaching through; a plain one-way doesn’t', () => {
    for (const blocks of [false, true]) {
      const map = flatMap([], [platform(5, 15, 2.2, blocks)]);
      // a frag going off just above the platform, over a dummy standing under it
      const blast = new Game({ map, seed: 3 });
      const under = dummyAt(blast, 10, 0);
      blast.step([]);
      explode(blast, 10, 2.45, -1, FRAG.explosion);
      expect(under.hp < T.healthMax, `blast, blocksBullets ${blocks}`).toBe(!blocks);
      // gas popping under it, by a dummy standing on it
      const gas = new Game({ map, seed: 3 });
      const on = dummyAt(gas, 10, 2.2);
      gas.step([]);
      spawnCloud(gas, GAS.index, 10, 0, -1);
      let gassed = 0;
      for (let i = 0; i < 90; i++) {
        gas.step([]);
        gassed += gas.events.filter((e) => e.type === 'hit' && e.target === on.id && e.source === DamageSource.Gas).length;
      }
      expect(gassed > 0, `gas, blocksBullets ${blocks}`).toBe(!blocks);
      // sight from under it to over it
      expect(lineOfSight(gas, 8, 1.2, 8, 3.5), `sight, blocksBullets ${blocks}`).toBe(!blocks);
    }
  });

  it('are still one-way for bodies: fly up through one, stand on it, hold Down to drop through', () => {
    const { game, p } = makeGame(flatMap([], [platform(5, 15, 3, true)]));
    placeOnGround(game, p, 10);
    hold(game, p, Btn.Jet, 40, Math.PI / 2);
    hold(game, p, 0, 60);
    expect(p.grounded).toBe(true);
    expect(p.y).toBeCloseTo(3, 1);
    hold(game, p, Btn.Down, 30);
    hold(game, p, 0, 60);
    expect(p.grounded).toBe(true);
    expect(p.y).toBeLessThan(0.05);
  });
});
