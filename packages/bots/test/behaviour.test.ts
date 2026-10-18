import { GAS, HAMMER, MINE, SMOKE } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { Btn, DamageSource, Game, Match, MatchPhase, MineState, createInput, giveShield, spawnCloud, type Input } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { addBot, addBots } from '../src';
import { smokeSight } from '../src/perception';
import { botAt, brainOf, dummyAt, flatMap, rect, run } from './helpers';

/** A human in the game who holds `input` (fire into the sky by default: loud and harmless). */
function human(game: Game, x: number) {
  const p = game.addPlayer('human');
  p.spawn(x, 0.01, game.tuning);
  const input: Input = createInput();
  input.aim = angleToU16(Math.PI / 2);
  const inputs: (Input | undefined)[] = [];
  inputs[p.id] = input;
  return { p, input, step: (n = 1) => { for (let i = 0; i < n; i++) game.step(inputs); } };
}

describe('behaviour tree (10 Hz): roam, fight, hunt, fall back', () => {
  it('roams with nobody about, fights what it sees, hunts what it only hears', () => {
    const game = new Game({ map: flatMap([rect(40, 0, 41, 12)]), seed: 2 });
    const bot = botAt(game, 10);
    run(game, 120);
    expect(brainOf(bot).mode).toBe('roam');
    expect(Math.abs(bot.x - 10)).toBeGreaterThan(1);

    const seen = new Game({ map: flatMap(), seed: 2 });
    const b2 = botAt(seen, 10);
    const d = dummyAt(seen, 22);
    run(seen, 30);
    expect(brainOf(b2).mode).toBe('fight');
    expect(brainOf(b2).target).toBe(d.id);

    // gunfire off screen behind it (25 m, within earshot): it goes after the sound
    const heard = new Game({ map: flatMap(), seed: 2 });
    const b3 = botAt(heard, 55);
    const h = human(heard, 30);
    h.input.buttons = Btn.Fire;
    let hunting = false;
    for (let i = 0; i < 60 && !hunting; i++) {
      h.input.buttons = i % 2 ? 0 : Btn.Fire;
      h.step();
      hunting = brainOf(b3).mode === 'hunt';
    }
    expect(hunting).toBe(true);
  });

  it('never fires into a wall: a target in view but out of line gets closed in on, not shot at', () => {
    const game = new Game({ map: flatMap([rect(25, 0, 26, 27)]), seed: 5 });
    const bot = botAt(game, 20);
    const target = dummyAt(game, 32);
    const events = run(game, 90);
    expect(brainOf(bot).perception.contacts[target.id]!.visible).toBe(true);
    expect(events.some((e) => e.type === 'shot' && e.shooter === bot.id)).toBe(false);
  });

  it('grabs a shield it has seen, raises it for a fight with a one-handed gun, slings it otherwise', () => {
    const game = new Game({ map: flatMap(), seed: 9, pickups: true });
    const bot = botAt(game, 20);
    game.setLoadout(bot, [HAMMER.index, HAMMER.index]);
    Object.assign(game.pickups[0]!, { alive: true, def: 0, x: 30, y: 0, hp: 300 });
    const modes = new Set<string>();
    for (let i = 0; i < 6 * 60 && bot.shieldHp === 0; i++) {
      game.step([]);
      modes.add(brainOf(bot).mode);
    }
    expect(modes.has('grab')).toBe(true);
    expect(bot.shieldHp).toBe(300);
    // roaming with nobody about: on the back
    run(game, 90);
    expect(brainOf(bot).mode).toBe('roam');
    expect(bot.shieldTicks).toBe(0);
    // an enemy in sight: up in front
    dummyAt(game, bot.x + (bot.x < 40 ? 10 : -10));
    let raised = false;
    for (let i = 0; i < 90 && !raised; i++) {
      game.step([]);
      raised = brainOf(bot).mode === 'fight' && bot.shieldTicks > 0;
    }
    expect(raised).toBe(true);
  });

  it('falls back out of sight to regenerate when hurt, then fights again', () => {
    const game = new Game({ map: flatMap([rect(30, 0, 31, 6)]), seed: 4 });
    const bot = botAt(game, 40, { level: 'normal' });
    const h = human(game, 52);
    h.input.aim = angleToU16(Math.PI);
    h.step(20);
    bot.hp = 20;
    h.step(60);
    expect(brainOf(bot).mode).toBe('retreat');
    // cover: the wall at x 30–31 is the obvious place; it gets out of the human's line of fire
    let hidden = false;
    for (let i = 0; i < 6 * 60 && !hidden; i++) {
      h.step();
      hidden = bot.x < 30;
    }
    expect(hidden).toBe(true);
    h.step(14 * 60); // 6 HP/s back past 80
    expect(bot.hp).toBeGreaterThanOrEqual(80);
    expect(brainOf(bot).mode).not.toBe('retreat');
  });

  it('a Hard bot dashes out of the way of a stream of hits (dash cooldown and fuel permitting)', () => {
    const game = new Game({ map: flatMap(), seed: 6 });
    const bot = botAt(game, 30, { level: 'hard' });
    const h = human(game, 38);
    h.input.aim = angleToU16(Math.PI);
    let dashes = 0;
    for (let i = 0; i < 4 * 60; i++) {
      h.input.buttons = i % 2 ? 0 : Btn.Fire;
      h.step();
      for (const e of game.events) if (e.type === 'dash' && e.player === bot.id) dashes++;
    }
    expect(dashes).toBeGreaterThan(0);
  });

  it('stays put through a Match countdown like the humans, and plays at GO', () => {
    const game = new Game({ map: flatMap([], [{ x: 10, y: 0 }, { x: 40, y: 0 }, { x: 70, y: 0 }]), seed: 8 });
    const me = game.addPlayer('me');
    const bots = addBots(game, 2, 'normal');
    const match = new Match(game, { countdown: 3 });
    match.setReady(me.id);
    const inputs: (Input | undefined)[] = [];
    inputs[me.id] = createInput();
    match.step(inputs);
    expect(match.phase).toBe(MatchPhase.Countdown);
    const at = bots.map((b) => [b.x, b.y]);
    for (let i = 0; i < 2 * 60; i++) match.step(inputs);
    expect(match.phase).toBe(MatchPhase.Countdown);
    bots.forEach((b, i) => {
      expect(b.x).toBe(at[i]![0]);
      expect(b.input.buttons).toBe(0);
    });
    for (let i = 0; i < 3 * 60; i++) match.step(inputs);
    expect(match.phase).toBe(MatchPhase.InProgress);
    expect(bots.some((b, i) => Math.abs(b.x - at[i]![0]!) > 1)).toBe(true);
  });

  it('respawns at the map’s spawn points like a human (dummies keep their home)', () => {
    const spawns = [{ x: 12, y: 0 }, { x: 60, y: 0 }];
    const game = new Game({ map: flatMap([], spawns), seed: 1 });
    const bot = addBot(game);
    bot.spawn(35, 0.01, game.tuning);
    game.damage(bot, 999, bot.id, 0, 0);
    run(game, Math.round(game.tuning.respawnDelay * 60) + 2);
    expect(bot.alive).toBe(true);
    expect(spawns.some((s) => Math.abs(s.x - bot.x) < 0.5)).toBe(true);
  });

  it('crosses a reversed-gravity zone on the flight it planned (the way out of one doesn’t turn it back)', () => {
    const map = flatMap([], [{ x: 10, y: 0 }]);
    map.zones = [{ id: 'flip', kind: 'reverseG', rect: [30, 0, 44, 8] }];
    for (const seed of [3, 4, 5]) {
      const game = new Game({ map, seed });
      const bot = botAt(game, 26);
      run(game, 6);
      const brain = brainOf(bot);
      expect(brain.nav.plan(bot, brain.graph.nearest(52, 0, 1.5))).toBe(true);
      let across = false;
      for (let i = 0; i < 8 * 60 && !across; i++) {
        game.step([]);
        across = bot.x > 46 && bot.grounded;
      }
      expect(across, `seed ${seed}`).toBe(true);
    }
  });

  it('flies out of a reversed-gravity zone sideways instead of hanging in it', () => {
    const map = flatMap([], [{ x: 10, y: 0 }]);
    map.zones = [{ id: 'flip', kind: 'reverseG', rect: [30, 0, 44, 8] }];
    const game = new Game({ map, seed: 3 });
    const bot = addBot(game);
    bot.spawn(37, 0.01, game.tuning);
    let out = false;
    for (let i = 0; i < 6 * 60 && !out; i++) {
      game.step([]);
      out = bot.x < 30 || bot.x > 44;
    }
    expect(out).toBe(true);
  });
});

describe('arsenal B (v10): smoke, flashbangs, gas and EMP', () => {
  it('never sees, aims at or shoots a player smoke hides from it; fights it once the smoke thins out', () => {
    const game = new Game({ map: flatMap(), seed: 11 });
    const d = dummyAt(game, 30);
    spawnCloud(game, SMOKE.index, 30, 0, -1);
    run(game, 30);
    const bot = botAt(game, 16);
    const brain = brainOf(bot);
    let hiddenTicks = 0;
    let shotsWhileHidden = 0;
    let seenWhileHidden = 0;
    let shots = 0;
    for (let i = 0; i < (SMOKE.cloud.duration + 2) * 60; i++) {
      // what the brain gets to see this tick (it thinks first, on this state)
      const hidden = smokeSight(game).hides(bot.id, d.id);
      game.step([]);
      if (hidden) hiddenTicks++;
      if (hidden && (brain.perception.contacts[d.id]!.visible || brain.aim.target === d.id)) seenWhileHidden++;
      for (const e of game.events) {
        if (e.type !== 'shot' || e.shooter !== bot.id) continue;
        shots++;
        if (hidden) shotsWhileHidden++;
      }
    }
    expect(hiddenTicks).toBeGreaterThan(5 * 60);
    expect(seenWhileHidden).toBe(0);
    expect(shotsWhileHidden).toBe(0);
    expect(shots).toBeGreaterThan(0);
  });

  it('a flashbang’s full white stops its fire and loses its target (it waits it out); it fights again after', () => {
    const game = new Game({ map: flatMap(), seed: 12 });
    const bot = botAt(game, 20, { level: 'hard' });
    const d = dummyAt(game, 32);
    run(game, 60);
    const brain = brainOf(bot);
    expect(brain.mode).toBe('fight');
    bot.blindTicks = 150;
    bot.blindFade = 90; // 1 s of white, then 1.5 s fading
    const white = run(game, 60);
    expect(white.some((e) => e.type === 'shot' && e.shooter === bot.id)).toBe(false);
    expect(brain.perception.contacts[d.id]!.known).toBe(false);
    expect(brain.mode).toBe('blind');
    const after = run(game, 4 * 60);
    expect(after.some((e) => e.type === 'shot' && e.shooter === bot.id)).toBe(true);
  });

  it('walks out of a gas cloud that pops on it mid-fight, before it costs much HP, and stays out', () => {
    for (const seed of [21, 22, 23, 24]) {
      for (const level of ['easy', 'normal', 'hard'] as const) {
        const game = new Game({ map: flatMap(), seed });
        const bot = botAt(game, 30, { level });
        dummyAt(game, 42);
        run(game, 60);
        expect(brainOf(bot).mode).toBe('fight');
        const x0 = bot.x;
        spawnCloud(game, GAS.index, x0, 0, -1);
        let out = -1;
        for (let i = 0; i < 4 * 60 && out < 0; i++) {
          game.step([]);
          if (Math.abs(bot.x - x0) > GAS.cloud.radius + 0.5) out = i;
        }
        const where = `seed ${seed}, ${level}`;
        expect(out, where).toBeGreaterThanOrEqual(0);
        expect(out, where).toBeLessThan(100); // about a second (it'd hold its fighting spot for longer)
        expect(bot.hp, where).toBeGreaterThan(82);
        if (seed !== 21) continue;
        let back = 0;
        for (let i = 0; i < 6 * 60; i++) {
          game.step([]);
          if (Math.abs(bot.x - x0) < GAS.cloud.radius) back++;
        }
        expect(back, where).toBe(0);
      }
    }
  });

  it('goes around gas it has seen: over the top on a platform rather than through it', () => {
    const map = flatMap();
    map.oneWays = [{ ax: 33, ay: 5, bx: 47, by: 5 }];
    const game = new Game({ map, seed: 14 });
    const bot = botAt(game, 20);
    spawnCloud(game, GAS.index, 40, 0, -1);
    run(game, 12); // it has looked around and seen the cloud
    const brain = brainOf(bot);
    expect(brain.perception.knowsGas).toBe(true);
    const goal = brain.graph.nearest(60, 0, 1.5);
    expect(brain.nav.plan(bot, goal)).toBe(true);
    let gassed = 0;
    let arrived = false;
    let topY = 0;
    for (let i = 0; i < 10 * 60 && !arrived; i++) {
      game.step([]);
      for (const e of game.events) if (e.type === 'hit' && e.target === bot.id && e.source === DamageSource.Gas) gassed++;
      if (bot.x > 36 && bot.x < 44) topY = Math.max(topY, bot.y);
      arrived = bot.x > 58;
    }
    expect(arrived).toBe(true);
    expect(gassed).toBe(0);
    expect(topY).toBeGreaterThan(4.5); // over the cloud, on the platform
  });

  it('leaves gas by the cheapest way, not the nearest: off a balcony with an empty tank, not hopping at the roof', () => {
    // the review's Street Market case: a balcony 8 m up a 12 m house. The street is 8 m down (exits
    // were looked for 6 m up and down), the roof a jet away: it hopped at the wall in the gas
    const map = flatMap([rect(18, 0, 30, 12)]);
    map.oneWays = [{ ax: 30, ay: 8, bx: 36, by: 8 }];
    for (const seed of [31, 32, 33]) {
      const game = new Game({ map, seed });
      const bot = botAt(game, 33, {}, 8);
      run(game, 6);
      bot.fuel = 0;
      spawnCloud(game, GAS.index, bot.x, bot.y, -1);
      let down = -1;
      for (let i = 0; i < 4 * 60 && down < 0; i++) {
        game.step([]);
        if (bot.y < 1) down = i;
      }
      expect(down, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(down, `seed ${seed}`).toBeLessThan(2.5 * 60); // a walk to the end and an 8 m fall: 1.8 s
      expect(bot.hp, `seed ${seed}`).toBeGreaterThan(75);
    }
  });

  it('low on fuel in a pit only a jet gets out of, it waits on the ground for the fuel the jet needs (not hopping in the gas)', () => {
    const map = flatMap([rect(20, 0, 34, 4), rect(40, 0, 54, 4)]);
    for (const seed of [41, 42, 43]) {
      const game = new Game({ map, seed });
      const bot = botAt(game, 37);
      run(game, 6);
      bot.fuel = 5;
      spawnCloud(game, GAS.index, bot.x, 0, -1);
      let out = -1;
      for (let i = 0; i < 5 * 60 && out < 0; i++) {
        game.step([]);
        if (bot.y > 3.9 && bot.grounded) out = i;
      }
      expect(out, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(out, `seed ${seed}`).toBeLessThan(3 * 60);
      expect(bot.hp, `seed ${seed}`).toBeGreaterThan(65);
    }
  });

  it('doesn’t walk into gas it’s clear of: with every way on through a cloud it waits it out, then goes', () => {
    const game = new Game({ map: flatMap(), seed: 16 });
    const bot = botAt(game, 4);
    spawnCloud(game, GAS.index, 10, 0, -1);
    const brain = brainOf(bot);
    let gassed = 0;
    let waited = 0;
    for (let i = 0; i < GAS.cloud.duration * 60; i++) {
      game.step([]);
      for (const e of game.events) if (e.type === 'hit' && e.target === bot.id && e.source === DamageSource.Gas) gassed++;
      if (brain.mode === 'wait') waited++;
    }
    expect(gassed).toBe(0);
    expect(waited).toBeGreaterThan(60); // between paces up and down its side of the cloud
    let past = false;
    for (let i = 0; i < 5 * 60 && !past; i++) {
      game.step([]);
      past = bot.x > 15;
    }
    expect(past).toBe(true);
  });

  it('with its jetpack dead (an EMP grenade) it keeps off jet links, and takes them again once it’s back', () => {
    const map = flatMap();
    map.oneWays = [{ ax: 33, ay: 5, bx: 47, by: 5 }];
    const game = new Game({ map, seed: 15 });
    const bot = botAt(game, 20);
    run(game, 6);
    const brain = brainOf(bot);
    const up = brain.graph.nearest(40, 5, 1.5);
    expect(up).toBeGreaterThanOrEqual(0);
    bot.jetDisabledTicks = 150;
    run(game, 6);
    expect(brain.nav.jetBlocked).toBe(true);
    expect(brain.nav.plan(bot, up)).toBe(false);
    let jets = 0;
    for (let i = 0; i < 120; i++) {
      game.step([]);
      if (bot.jetDisabledTicks > 0 && (bot.input.buttons & Btn.Jet) !== 0) jets++;
    }
    expect(jets).toBe(0);
    run(game, 40);
    expect(bot.jetDisabledTicks).toBe(0);
    expect(brain.nav.jetBlocked).toBe(false);
    expect(brain.nav.plan(bot, up)).toBe(true);
  });

  it('goes around a mine it has seen: over the top on a platform rather than past it', () => {
    const map = flatMap();
    map.oneWays = [{ ax: 33, ay: 5, bx: 47, by: 5 }];
    const game = new Game({ map, seed: 14 });
    const bot = botAt(game, 20);
    Object.assign(game.grenades[0]!, { alive: true, type: MINE.index, state: MineState.Armed, x: 40, y: 0.12, vx: 0, vy: 0, fuse: 1e6, owner: -1 });
    run(game, 12); // it has looked around and seen it
    const brain = brainOf(bot);
    expect(brain.perception.knowsMines).toBe(true);
    expect(brain.nav.plan(bot, brain.graph.nearest(60, 0, 1.5))).toBe(true);
    let arrived = false;
    let boom = false;
    let topY = 0;
    for (let i = 0; i < 10 * 60 && !arrived; i++) {
      game.step([]);
      boom ||= game.events.some((e) => e.type === 'explosion');
      if (bot.x > 37 && bot.x < 43) topY = Math.max(topY, bot.y);
      arrived = bot.x > 58;
    }
    expect(arrived).toBe(true);
    expect(boom).toBe(false);
    expect(game.grenades[0]!.state).toBe(MineState.Armed);
    expect(topY).toBeGreaterThan(4.5);
  });
});

describe('the rest of the #70 review', () => {
  it('a shield on the floor: wanted with none or a worn one of its own (a dropped one’s HP isn’t sent); one it stood on and couldn’t take is left be', () => {
    const game = new Game({ map: flatMap(), seed: 9, pickups: true });
    const bot = botAt(game, 20);
    game.setLoadout(bot, [HAMMER.index, HAMMER.index]);
    giveShield(bot, 120); // worn: worth a look
    Object.assign(game.pickups[0]!, { alive: true, def: 0, x: 30, y: 0, hp: 60 }); // worse: touching it does nothing
    let stoodAt = -1;
    let grabsAfter = 0;
    for (let i = 0; i < 12 * 60; i++) {
      game.step([]);
      if (stoodAt < 0 && Math.abs(bot.x - 30) < 1) stoodAt = i;
      if (stoodAt >= 0 && i > stoodAt + 30 && brainOf(bot).mode === 'grab') grabsAfter++;
    }
    expect(stoodAt).toBeGreaterThanOrEqual(0); // it went for it once
    expect(grabsAfter).toBe(0); // and then left it be
    expect(bot.shieldHp).toBe(120);
    expect(game.pickups[0]!.alive).toBe(true);

    // with a shield in good shape, one on the floor isn't worth the detour
    const fresh = new Game({ map: flatMap(), seed: 9, pickups: true });
    const b2 = botAt(fresh, 20);
    fresh.setLoadout(b2, [HAMMER.index, HAMMER.index]);
    giveShield(b2, 300);
    Object.assign(fresh.pickups[0]!, { alive: true, def: 0, x: 30, y: 0, hp: 300 });
    const modes = new Set<string>();
    for (let i = 0; i < 4 * 60; i++) {
      fresh.step([]);
      modes.add(brainOf(b2).mode);
    }
    expect(modes.has('grab')).toBe(false);
  });

  it('a countdown freeze isn’t a link that failed: after GO it carries on along the same way', () => {
    const game = new Game({ map: flatMap(), seed: 3 });
    const bot = botAt(game, 10);
    const brain = brainOf(bot);
    run(game, 12);
    expect(brain.nav.plan(bot, brain.graph.nearest(60, 0, 1.5))).toBe(true);
    run(game, 20); // on its way
    game.inputsFrozen = true; // as Match.step sets it outside the match
    run(game, 4 * 60);
    game.inputsFrozen = false;
    run(game, 60);
    expect(brain.nav.failures).toBe(0);
  });
});

