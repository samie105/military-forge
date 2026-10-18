import { GAS, SMOKE } from '@military-forge/content';
import { Btn, createInput, Game, spawnCloud, type Input } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Perception, SOUND_CELL } from '../src/perception';
import { dummyAt, flatMap, rect, run } from './helpers';

/** A plain player standing at x looking right, and a Perception for it. */
function observer(game: Game, x: number) {
  const me = game.addPlayer('me');
  me.spawn(x, 0.01, game.tuning);
  run(game, 5);
  return { me, per: new Perception() };
}

/** A player at x holding Fire, aiming at the sky (loud, harmless). */
function shooter(game: Game, x: number) {
  const s = game.addPlayer('shooter');
  s.spawn(x, 0.01, game.tuning);
  const input: Input = { ...createInput(), buttons: Btn.Fire, aim: 16384 };
  const inputs: (Input | undefined)[] = [];
  inputs[s.id] = input;
  return { s, input, inputs };
}

describe('perception: only what a human in its place could know', () => {
  it('sees what a human’s screen shows: players behind a wall too (a side view), not one off screen', () => {
    const game = new Game({ map: flatMap([rect(25, 0, 26, 10)]) });
    const { me, per } = observer(game, 20);
    const behindWall = dummyAt(game, 30);
    const far = dummyAt(game, 75); // 55 m: past the 36 m view and its look-ahead
    per.look(game, me);
    expect(per.contacts[behindWall.id]!.visible).toBe(true);
    expect(per.contacts[far.id]!.visible).toBe(false);
    expect(per.contacts[far.id]!.known).toBe(false);
  });

  it('a smaller view (Easy) misses what the human view would catch at its edge', () => {
    const game = new Game({ map: flatMap() });
    const { me, per } = observer(game, 10);
    const edge = dummyAt(game, 42); // 32 m: inside the human view with its look-ahead
    per.look(game, me);
    expect(per.contacts[edge.id]!.visible).toBe(true);
    const easy = new Perception();
    easy.viewScale = 0.7;
    easy.look(game, me);
    expect(easy.contacts[edge.id]!.visible).toBe(false);
  });

  it('hears gunfire off screen as a SOUND within earshot (35 m): roughly where, never who; knows who hit it', () => {
    const game = new Game({ map: flatMap() });
    const { me, per } = observer(game, 50);
    const near = shooter(game, 25); // behind it, off screen, 25 m away
    let heard = false;
    for (let i = 0; i < 20 && !heard; i++) {
      game.step(near.inputs);
      per.hear(game, me);
      heard = per.noise.tick >= 0;
    }
    expect(heard).toBe(true);
    // on the client's 4 m grid, near the muzzle, and nameless
    expect(per.noise.x % SOUND_CELL).toBe(0);
    expect(per.noise.y % SOUND_CELL).toBe(0);
    expect(Math.abs(per.noise.x - 25)).toBeLessThanOrEqual(SOUND_CELL / 2 + 0.5);
    expect(per.contacts[near.s.id]!.known).toBe(false);
    per.look(game, me);
    expect(per.contacts[near.s.id]!.visible).toBe(false);

    const wide = new Game({ map: flatMap([], [{ x: 10, y: 0 }], 120) });
    const o = observer(wide, 70);
    const far = shooter(wide, 20); // 50 m: out of earshot
    for (let i = 0; i < 20; i++) {
      wide.step(far.inputs);
      o.per.hear(wide, o.me);
    }
    expect(o.per.noise.tick).toBe(-1);
    expect(o.per.contacts[far.s.id]!.known).toBe(false);

    const duel = new Game({ map: flatMap() });
    const v = observer(duel, 20);
    const attacker = shooter(duel, 28);
    attacker.input.aim = 32768; // at the observer
    let hurt = -1;
    for (let i = 0; i < 60 && hurt < 0; i++) {
      duel.step(attacker.inputs);
      v.per.hear(duel, v.me);
      hurt = v.per.contacts[attacker.s.id]!.hurtTick;
    }
    expect(hurt).toBeGreaterThanOrEqual(0);
  });

  it('forgets a player after 6 s without news, and a sound too', () => {
    const game = new Game({ map: flatMap() });
    const { me, per } = observer(game, 20);
    const other = game.addPlayer('other');
    other.spawn(30, 0.01, game.tuning);
    run(game, 2);
    per.look(game, me);
    expect(per.contacts[other.id]!.visible).toBe(true);
    other.x = 76; // off screen
    run(game, 5 * 60);
    per.look(game, me);
    expect(per.contacts[other.id]!.visible).toBe(false);
    expect(per.contacts[other.id]!.known).toBe(true);
    run(game, 70);
    per.look(game, me);
    expect(per.contacts[other.id]!.known).toBe(false);

    per.noise.tick = game.tick;
    run(game, 6 * 60 + 10);
    per.look(game, me);
    expect(per.noise.tick).toBe(-1);
  });

  it('smoke hides a player in it or behind it (the server’s AOI rule), not one in front of it, until it thins out', () => {
    const game = new Game({ map: flatMap() });
    const { me, per } = observer(game, 10);
    const front = dummyAt(game, 17);
    const inside = dummyAt(game, 26);
    const behind = dummyAt(game, 33);
    const cloud = spawnCloud(game, SMOKE.index, 26, 0, -1)!;
    run(game, 90); // grown in
    per.look(game, me);
    expect(per.contacts[front.id]!.visible).toBe(true);
    expect(per.contacts[inside.id]!.visible).toBe(false);
    expect(per.contacts[behind.id]!.visible).toBe(false);
    expect(per.canSee(game, me, inside)).toBe(false);
    // its last 1.25 s are see-through
    run(game, Math.round((SMOKE.cloud.duration - 1) * 60) - 90);
    expect(cloud.alive).toBe(true);
    per.look(game, me);
    expect(per.contacts[inside.id]!.visible).toBe(true);
    expect(per.contacts[behind.id]!.visible).toBe(true);
  });

  it('a shooter hidden in smoke is only a SOUND, tracer or not: a hit names it without placing it', () => {
    const game = new Game({ map: flatMap() });
    const { me, per } = observer(game, 12);
    const sh = shooter(game, 26);
    spawnCloud(game, SMOKE.index, 26, 0, -1);
    run(game, 60);
    sh.input.aim = 32768; // at the observer, through the smoke
    let hurt = false;
    for (let i = 0; i < 90 && !hurt; i++) {
      sh.input.buttons = i % 2 ? 0 : Btn.Fire;
      game.step(sh.inputs);
      per.hear(game, me);
      per.look(game, me);
      expect(per.contacts[sh.s.id]!.visible).toBe(false);
      hurt = per.contacts[sh.s.id]!.hurtTick >= 0;
    }
    expect(hurt).toBe(true);
    expect(per.noise.tick).toBeGreaterThanOrEqual(0);
    // who: the HIT says; where: only the SOUND's 4 m grid
    const c = per.contacts[sh.s.id]!;
    expect(c.known).toBe(true);
    expect(c.x % SOUND_CELL).toBe(0);
    expect(c.vx).toBe(0);
  });

  it('a flashbang’s full white shows nothing and wipes what it knew; it sees again as the white fades', () => {
    const game = new Game({ map: flatMap() });
    const { me, per } = observer(game, 10);
    const d = dummyAt(game, 20);
    per.hear(game, me);
    per.look(game, me);
    expect(per.contacts[d.id]!.visible).toBe(true);
    me.blindTicks = 90;
    me.blindFade = 45; // 45 ticks of white, then 45 fading
    per.hear(game, me);
    per.look(game, me);
    expect(per.blind).toBe(1);
    expect(per.contacts[d.id]!.known).toBe(false);
    expect(per.contacts[d.id]!.visible).toBe(false);
    expect(per.canSee(game, me, d)).toBe(false);
    run(game, 50);
    per.hear(game, me);
    per.look(game, me);
    expect(per.blind).toBeGreaterThan(0);
    expect(per.blind).toBeLessThan(1);
    expect(per.contacts[d.id]!.visible).toBe(true);
  });

  it('knows gas it has seen (and where it’s worst), remembers it off screen, forgets it when it’s gone', () => {
    const game = new Game({ map: flatMap() });
    const { me, per } = observer(game, 10);
    spawnCloud(game, GAS.index, 26, 0, -1);
    run(game, 2);
    expect(per.gasAt(game, 26, 0.9, 0)).toBe(0); // not seen yet
    per.look(game, me);
    expect(per.knowsGas).toBe(true);
    expect(per.gasAt(game, 26, 0.9, 0)).toBeGreaterThan(0.6);
    expect(per.gasAt(game, 26 + GAS.cloud.radius + 0.5, 0.9, 0)).toBe(0);
    // a wall bounds it: the far side isn't in it
    const walled = new Game({ map: flatMap([rect(27, 0, 27.4, 10)]) });
    const w = observer(walled, 10);
    spawnCloud(walled, GAS.index, 26, 0, -1);
    run(walled, 2);
    w.per.look(walled, w.me);
    expect(w.per.gasAt(walled, 25.5, 0.9, 0)).toBeGreaterThan(0);
    expect(w.per.gasAt(walled, 28.5, 0.9, 0)).toBe(0);

    me.x = 75; // off screen: still remembered
    per.look(game, me);
    expect(per.gasAt(game, 26, 0.9, 0)).toBeGreaterThan(0);
    run(game, GAS.cloud.duration * 60);
    per.look(game, me);
    expect(per.knowsGas).toBe(false);
  });

  it('remembers where it saw an item, and forgets it when it sees the spot empty', () => {
    const game = new Game({ map: flatMap(), pickups: true });
    const { me, per } = observer(game, 20);
    const k = game.pickups[0]!;
    Object.assign(k, { alive: true, def: 0, x: 30, y: 0, hp: 300 });
    per.look(game, me);
    expect(per.items[k.id]!.tick).toBeGreaterThanOrEqual(0);
    expect(per.items[k.id]!.x).toBe(30);
    // out of view, it stays remembered; back in view and gone, it's forgotten
    me.x = 75;
    per.look(game, me);
    expect(per.items[k.id]!.tick).toBeGreaterThanOrEqual(0);
    k.alive = false;
    me.x = 20;
    per.look(game, me);
    expect(per.items[k.id]!.tick).toBe(-1);
  });
});
