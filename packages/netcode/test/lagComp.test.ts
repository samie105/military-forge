import { BREACHER, HAMMER, RIOT_SHIELD, STANDING_HITBOXES, WIDOW, type MapDef } from '@military-forge/content';
import type { SnapshotMsg, SnapshotPlayer } from '@military-forge/protocol';
import { angleToU16 } from '@military-forge/shared';
import { Btn, Game, SHIELD_RAISE_TICKS, createHitPose, createInput, giveShield, type Input, type PlayerState } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { LagCompensator, bracketSnapshots, lerpPosition, type SnapshotBracket } from '../src';

/** Two players walking/jetting on the test map, history recorded every tick, snapshots every 2nd. */
function recordedGame(ticks: number) {
  const game = new Game({ seed: 4, dummies: false });
  const a = game.addPlayer('a');
  const b = game.addPlayer('b');
  const lc = new LagCompensator({ snapshotEvery: 2 });
  lc.record(game.tick, game.players);
  const snapshots: { msg: SnapshotMsg }[] = [];
  const inputs: Input[] = [];
  for (let t = 0; t < ticks; t++) {
    inputs[a.id] = { ...createInput(), buttons: t % 90 < 45 ? Btn.Right : Btn.Left | (t % 30 < 10 ? Btn.Jet : 0) };
    inputs[b.id] = { ...createInput(), buttons: t % 70 < 20 ? Btn.Down : Btn.Right };
    game.step(inputs);
    lc.record(game.tick, game.players);
    if (game.tick % 2 === 0) snapshots.push({ msg: snapshotOf(game) });
  }
  return { game, a, b, lc, snapshots };
}

function snapshotOf(game: Game): SnapshotMsg {
  const players = game.players
    .filter((p): p is PlayerState => p !== null)
    .map((p) => ({ id: p.id, x: p.x, y: p.y, alive: p.alive, crouched: p.crouched }) as SnapshotPlayer);
  return { serverTick: game.tick, players } as SnapshotMsg;
}

describe('LagCompensator', () => {
  it('rewinds to exactly the pose the client interpolates for the same render tick', () => {
    const { game, a, b, lc, snapshots } = recordedGame(200);
    const br: SnapshotBracket = { a: null!, b: null!, alpha: 0 };
    const client = { x: 0, y: 0 };
    const out = createHitPose();
    let checked = 0;
    lc.begin(game.tick);
    for (let back = 0.25; back < 17; back += 0.37) {
      const renderTick = Math.floor((game.tick - back) * 256) / 256;
      lc.setView(b.id, renderTick);
      expect(lc.pose(a, b, out)).toBe(true);
      bracketSnapshots(snapshots, renderTick, br);
      const p0 = br.a.players.find((p) => p.id === a.id)!;
      const p1 = br.b.players.find((p) => p.id === a.id)!;
      lerpPosition(p0.x, p0.y, p1.x, p1.y, br.alpha, client);
      expect([out.x, out.y]).toEqual([client.x, client.y]);
      expect(out.crouched).toBe((br.alpha < 0.5 ? p0 : p1).crouched);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('caps the rewind, ignores shooters without a view, and falls back past the history', () => {
    const { game, a, b, lc } = recordedGame(120);
    const out = createHitPose();
    lc.begin(game.tick);
    expect(lc.pose(a, b, out)).toBe(false); // no view: current pose
    lc.setView(b.id, game.tick - 40); // 667 ms ago: beyond the 300 ms cap
    expect(lc.pose(a, b, out)).toBe(true);
    expect(lc.clamped).toBe(1);
    const capped = { x: out.x, y: out.y };
    lc.setView(b.id, game.tick - lc.maxRewindTicks);
    lc.pose(a, b, out);
    expect({ x: out.x, y: out.y }).toEqual(capped);
    // a view older than anything recorded (e.g. the target joined since): test the current pose
    const fresh = new LagCompensator({ maxRewindMs: 5000 });
    fresh.record(game.tick, game.players);
    fresh.begin(game.tick + 20);
    fresh.setView(b.id, game.tick - 10);
    expect(fresh.pose(a, b, out)).toBe(false);
  });

  it('hitscan tests the rewound pose: aimed where the target was, it hits; without the rewind it misses', () => {
    const game = new Game({ seed: 9, dummies: false });
    const shooter = game.addPlayer('shooter');
    const target = game.addPlayer('target');
    // shooter at the end of the 12 m tower's ledge (a slab since the 23 Oct QA: the shot clears its
    // end), target walking right on the ground below it, short of the low cover at 154
    shooter.x = 147.7;
    shooter.y = 12;
    target.x = 150.5;
    target.y = 0;
    const lc = new LagCompensator();
    lc.record(game.tick, game.players);
    const inputs: Input[] = [];
    for (let t = 0; t < 30; t++) {
      inputs[target.id] = { ...createInput(), buttons: Btn.Right };
      inputs[shooter.id] = createInput();
      game.step(inputs);
      lc.record(game.tick, game.players);
    }
    const view = game.tick - 12; // the shooter's screen is 200 ms behind
    const seen = createHitPose();
    lc.begin(game.tick);
    lc.setView(shooter.id, view);
    lc.pose(target, shooter, seen);
    expect(target.x - seen.x).toBeGreaterThan(0.8); // it really moved since

    const fire = (rewind: boolean) => {
      const t = game.tuning;
      const torso = (STANDING_HITBOXES.torso.y0 + STANDING_HITBOXES.torso.y1) / 2;
      const aim = angleToU16(Math.atan2(seen.y + torso - shooter.shoulderY(t), seen.x - shooter.shoulderX(t)));
      inputs[shooter.id] = { ...createInput(), buttons: Btn.Fire, aim };
      inputs[target.id] = { ...createInput(), buttons: Btn.Right };
      shooter.prevButtons = 0;
      shooter.weapons[shooter.active]!.cooldown = 0;
      shooter.vx = 0; // the previous shot's recoil slide (docs/02 §12) would move the shooter off this aim
      game.rewind = rewind ? lc : null;
      lc.begin(game.tick);
      lc.setView(shooter.id, view);
      game.step(inputs);
      return game.events.find((e) => e.type === 'shot');
    };
    const withRewind = fire(true);
    expect(withRewind?.type === 'shot' && withRewind.target).toBe(target.id);
    const without = fire(false);
    expect(without?.type === 'shot' && without.target).toBe(-1);
  });

  it('a reused id never inherits the departed player\'s poses', () => {
    // sameWindow: the leave and the join both happen between two record()s (a kick and a HELLO in
    // the same receive window), so the history never saw the joiner
    for (const sameWindow of [false, true]) {
      const game = new Game({ seed: 9, dummies: false });
      const shooter = game.addPlayer('shooter');
      const leaver = game.addPlayer('leaver');
      shooter.x = 147.7;
      shooter.y = 12;
      leaver.x = 151;
      leaver.y = 0;
      const lc = new LagCompensator();
      game.rewind = lc;
      lc.record(game.tick, game.players);
      const inputs: Input[] = [];
      for (let t = 0; t < 20; t++) {
        game.step(inputs);
        lc.record(game.tick, game.players);
      }
      const oldPose = { x: leaver.x, y: leaver.y };
      const id = leaver.id;
      game.removePlayer(id);
      if (!sameWindow) {
        for (let t = 0; t < 3; t++) {
          game.step(inputs);
          lc.record(game.tick, game.players);
        }
      }
      const joiner = game.addPlayer('joiner'); // gets the same id, somewhere else
      expect(joiner.id).toBe(id);
      joiner.x = 120;
      joiner.y = 0;
      const hp = joiner.hp;
      if (!sameWindow) lc.record(game.tick, game.players);
      // a shooter whose screen is 12 ticks behind fires at where the leaver used to stand
      const t = game.tuning;
      const torso = (STANDING_HITBOXES.torso.y0 + STANDING_HITBOXES.torso.y1) / 2;
      inputs[shooter.id] = { ...createInput(), buttons: Btn.Fire, aim: angleToU16(Math.atan2(oldPose.y + torso - shooter.shoulderY(t), oldPose.x - shooter.shoulderX(t))) };
      lc.begin(game.tick);
      lc.setView(shooter.id, game.tick - 12);
      game.step(inputs);
      const shot = game.events.find((e) => e.type === 'shot');
      expect(shot?.type === 'shot' && shot.target, `sameWindow ${sameWindow}`).toBe(-1);
      expect(joiner.hp).toBe(hp);
    }
  });

  it('shotgun pellets are lag-compensated: every pellet tests the rewound pose', () => {
    // flat floor at y = 0, walls at both ends
    const map: MapDef = {
      id: 'lagcomp-flat',
      name: 'Lag comp flat',
      bounds: { minX: -2, minY: -6, maxX: 62, maxY: 30 },
      solids: [
        { points: [-2, -6, 62, -6, 62, 0, -2, 0] },
        { points: [-2, 0, 0, 0, 0, 28, -2, 28] },
        { points: [60, 0, 62, 0, 62, 28, 60, 28] },
      ],
      oneWays: [],
      spawns: [{ x: 5, y: 0 }],
      dummies: [],
      labels: [],
    };
    const game = new Game({ map, seed: 11, dummies: false });
    const shooter = game.addPlayer('shooter');
    const target = game.addPlayer('target');
    game.setLoadout(shooter, [BREACHER.index, HAMMER.index]);
    shooter.x = 5;
    target.x = 8.5; // 3.5 m: inside the Breacher's one-shot range
    shooter.y = target.y = 0.01;
    const lc = new LagCompensator();
    const inputs: Input[] = [];
    const idle = () => {
      inputs[shooter.id] = createInput();
      inputs[target.id] = createInput();
      game.step(inputs);
      lc.record(game.tick, game.players);
    };
    lc.record(game.tick, game.players);
    for (let t = 0; t < 30; t++) idle();
    const view = game.tick - 2; // the shooter's screen shows the target here...
    target.x = 40; // ...but on the server it has since moved 31.5 m away, beyond the Breacher's 13 m range
    for (let t = 0; t < 12; t++) idle();
    expect(game.tick - view).toBeLessThan(lc.maxRewindTicks);

    const seen = createHitPose();
    lc.begin(game.tick);
    lc.setView(shooter.id, view);
    expect(lc.pose(target, shooter, seen)).toBe(true);
    expect(seen.x).toBeCloseTo(8.5, 2);

    const fire = (rewind: boolean) => {
      const t = game.tuning;
      const torso = (STANDING_HITBOXES.torso.y0 + STANDING_HITBOXES.torso.y1) / 2;
      const aim = angleToU16(Math.atan2(seen.y + torso - shooter.shoulderY(t), seen.x - shooter.shoulderX(t)));
      inputs[shooter.id] = { ...createInput(), buttons: Btn.Fire, aim };
      inputs[target.id] = createInput();
      shooter.prevButtons = 0;
      shooter.weapons[shooter.active]!.cooldown = 0;
      shooter.vx = 0; // the previous shot's recoil slide (docs/02 §12) would move the shooter off this aim
      game.rewind = rewind ? lc : null;
      lc.begin(game.tick);
      lc.setView(shooter.id, view);
      const before = lc.rewinds;
      game.step(inputs);
      lc.record(game.tick, game.players);
      const pellets = game.events.filter((e) => e.type === 'shot');
      const hits = game.events.filter((e) => e.type === 'hit' && e.target === target.id);
      return { pellets, hits, rewinds: lc.rewinds - before };
    };

    const without = fire(false);
    expect(without.pellets.length).toBe(BREACHER.pellets);
    expect(without.pellets.every((e) => e.type === 'shot' && e.target === -1)).toBe(true);
    expect(without.hits.length).toBe(0);
    expect(target.hp).toBe(100);

    const withRewind = fire(true);
    expect(withRewind.pellets.length).toBe(BREACHER.pellets);
    expect(withRewind.rewinds).toBe(BREACHER.pellets); // one rewound pose per pellet
    expect(withRewind.pellets.every((e) => e.type === 'shot' && e.target === target.id)).toBe(true);
    expect(withRewind.hits.length).toBe(BREACHER.pellets);
    expect(target.alive).toBe(false); // all five pellets at 3.5 m: one shot kills
  });

  it('a riot shield is rewound with its owner: up and facing the shooter where its screen showed it', () => {
    const game = new Game({ seed: 13, dummies: false });
    const shooter = game.addPlayer('shooter');
    const target = game.addPlayer('target');
    game.setLoadout(shooter, [WIDOW.index, HAMMER.index]);
    shooter.x = 2;
    target.x = 9;
    shooter.y = target.y = 0.01;
    giveShield(target, RIOT_SHIELD.hp);
    const lc = new LagCompensator();
    const inputs: Input[] = [];
    const run = (n: number, targetAim: number) => {
      for (let t = 0; t < n; t++) {
        inputs[shooter.id] = createInput();
        inputs[target.id] = { ...createInput(), aim: targetAim };
        game.step(inputs);
        lc.record(game.tick, game.players);
      }
    };
    lc.record(game.tick, game.players);
    run(SHIELD_RAISE_TICKS + 20, 32768); // shield up, facing the shooter (left)
    const view = game.tick - 2;
    run(12, 0); // since then it turned away: the shield faces right
    expect(target.facing).toBe(1);

    const seen = createHitPose();
    lc.begin(game.tick);
    lc.setView(shooter.id, view);
    expect(lc.pose(target, shooter, seen)).toBe(true);
    expect([seen.facing, seen.shield]).toEqual([-1, true]);

    const fire = (rewind: boolean) => {
      const t = game.tuning;
      const aim = angleToU16(Math.atan2(target.y + 0.8 - shooter.shoulderY(t), target.x - shooter.shoulderX(t)));
      inputs[shooter.id] = { ...createInput(), buttons: Btn.Fire, aim };
      inputs[target.id] = createInput();
      shooter.prevButtons = 0;
      shooter.weapons[shooter.active]!.cooldown = 0;
      game.rewind = rewind ? lc : null;
      lc.begin(game.tick);
      lc.setView(shooter.id, view);
      game.step(inputs);
      lc.record(game.tick, game.players);
      return game.events.find((e) => e.type === 'shot');
    };
    // where the shooter saw it, the shield stops the bullet; now (facing away) it would hit the back
    const blocked = fire(true);
    expect(blocked?.type === 'shot' && [blocked.hit, blocked.target]).toEqual([3, target.id]);
    expect(target.shieldHp).toBe(RIOT_SHIELD.hp - WIDOW.damage);
    expect(target.hp).toBe(100);
    const hit = fire(false);
    expect(hit?.type === 'shot' && [hit.hit, hit.target]).toEqual([2, target.id]);
    expect(target.hp).toBeLessThan(100);
  });

  it('a slung riot shield is recorded and rewound too: it guards the back the shooter saw', () => {
    const game = new Game({ seed: 14, dummies: false });
    const shooter = game.addPlayer('shooter');
    const target = game.addPlayer('target');
    game.setLoadout(shooter, [WIDOW.index, HAMMER.index]);
    shooter.x = 2;
    target.x = 9;
    shooter.y = target.y = 0.01;
    giveShield(target, RIOT_SHIELD.hp);
    target.shieldStowed = true; // slung, facing away from the shooter: its back is covered
    const lc = new LagCompensator();
    const inputs: Input[] = [];
    const run = (n: number, buttons = 0) => {
      for (let t = 0; t < n; t++) {
        inputs[shooter.id] = createInput();
        inputs[target.id] = { ...createInput(), aim: 0, buttons: t === 0 ? buttons : 0 };
        game.step(inputs);
        lc.record(game.tick, game.players);
      }
    };
    lc.record(game.tick, game.players);
    run(20);
    const view = game.tick; // what the shooter's screen shows…
    run(SHIELD_RAISE_TICKS + 1, Btn.Shield); // …and since then it raised it (in front, away from the shooter)
    expect(target.shieldTicks).toBe(SHIELD_RAISE_TICKS);
    expect(game.tick - view).toBeLessThan(lc.maxRewindTicks); // inside the 300 ms cap

    const seen = createHitPose();
    lc.begin(game.tick);
    lc.setView(shooter.id, view);
    expect(lc.pose(target, shooter, seen)).toBe(true);
    expect([seen.facing, seen.shield, seen.shieldBack]).toEqual([1, false, true]);

    const fire = (rewind: boolean) => {
      const t = game.tuning;
      const aim = angleToU16(Math.atan2(target.y + 0.8 - shooter.shoulderY(t), target.x - shooter.shoulderX(t)));
      inputs[shooter.id] = { ...createInput(), buttons: Btn.Fire, aim };
      inputs[target.id] = { ...createInput(), aim: 0 };
      shooter.prevButtons = 0;
      shooter.weapons[shooter.active]!.cooldown = 0;
      game.rewind = rewind ? lc : null;
      lc.begin(game.tick);
      lc.setView(shooter.id, view);
      game.step(inputs);
      lc.record(game.tick, game.players);
      return game.events.find((e) => e.type === 'shot');
    };
    const blocked = fire(true);
    expect(blocked?.type === 'shot' && [blocked.hit, blocked.target]).toEqual([3, target.id]);
    expect(target.hp).toBe(100);
    const hit = fire(false); // now the shield is up in front: the back is bare
    expect(hit?.type === 'shot' && [hit.hit, hit.target]).toEqual([2, target.id]);
    expect(target.hp).toBeLessThan(100);
  });
});
