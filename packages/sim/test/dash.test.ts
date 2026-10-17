/**
 * Dash (docs/02 §21): a brief 8-way jetpack burst on its own button. Distances per direction,
 * walls, the cooldown, one air dash per flight, fuel and EMP, knockback, one-way platforms, the
 * exit speed, and the dash event.
 */
import { BREACHER, defaultTuning } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { describe, expect, it } from 'vitest';
import { Btn, DASH_DX, DASH_DY, DASH_UP_FRESH_TICKS, createInput, type Game, type Input, type PlayerState, type SimEvent } from '../src';
import { flatMap, hold, makeGame, placeOnGround, rect } from './helpers';

const BURST = defaultTuning.dashBurstTicks;
const BURST_M = (defaultTuning.dashSpeed * BURST) / 60; // 1.87 m

/** One tick with `buttons` (the dash needs a press: the tick before must not hold Dash). */
function tap(game: Game, p: PlayerState, buttons: number): SimEvent[] {
  hold(game, p, buttons, 1);
  return game.events.slice();
}

function standing(x = 20) {
  const { game, p } = makeGame(flatMap([], [], 120));
  placeOnGround(game, p, x);
  return { game, p };
}

describe('dash', () => {
  it('goes 8 ways for a fixed burst; with no direction, along the facing', () => {
    const dirs: [number, number][] = [
      [Btn.Right, 0],
      [Btn.Right | Btn.Jet, 1],
      [Btn.Jet, 2],
      [Btn.Left | Btn.Jet, 3],
      [Btn.Left, 4],
    ];
    for (const [buttons, dir] of dirs) {
      const { game, p } = standing();
      const x0 = p.x;
      const y0 = p.y;
      tap(game, p, Btn.Dash | buttons);
      expect(p.dashDir).toBe(dir);
      hold(game, p, buttons & ~Btn.Jet, BURST - 1); // finish the burst (no jet afterwards)
      expect(p.dashTicks).toBe(0);
      expect(p.x - x0).toBeCloseTo(DASH_DX[dir]! * BURST_M, 1);
      expect(p.y - y0).toBeCloseTo(DASH_DY[dir]! * BURST_M, 1);
    }
    // no direction: along the facing (aiming left faces left)
    const { game, p } = standing();
    hold(game, p, Btn.Dash, 1, Math.PI);
    expect(p.dashDir).toBe(4);
  });

  it('flying on a held jet, a dash goes flat; a fresh W press still makes it go up', () => {
    const { game, p } = standing();
    hold(game, p, Btn.Jet, 30); // flying for 0.5 s
    expect(p.jetTicks).toBeGreaterThan(DASH_UP_FRESH_TICKS);
    tap(game, p, Btn.Dash | Btn.Jet | Btn.Right);
    expect(p.dashDir).toBe(0); // the held jet doesn't tilt it
    const fresh = standing();
    hold(fresh.game, fresh.p, Btn.Jet, 30);
    hold(fresh.game, fresh.p, 0, 1); // let go of W…
    hold(fresh.game, fresh.p, Btn.Jet, 3); // …and press it again just before the dash
    tap(fresh.game, fresh.p, Btn.Dash | Btn.Jet | Btn.Right);
    expect(fresh.p.dashDir).toBe(1); // up-right
  });

  it('down-dashes in the air are a quick drop that ends on landing (a slam)', () => {
    const { game, p } = standing();
    p.y = 6;
    p.grounded = false;
    const events = tap(game, p, Btn.Dash | Btn.Down);
    expect(events.find((e) => e.type === 'dash')).toMatchObject({ dir: 6 });
    expect(p.vy).toBe(-defaultTuning.dashSpeed);
    let t = 1;
    while (!p.grounded && t < 60) {
      hold(game, p, 0, 1);
      t++;
    }
    expect(t).toBeLessThan(30); // a fall from 6 m takes ~46 ticks
    hold(game, p, 0, 1);
    expect(p.dashTicks).toBe(0);
    expect(p.vx).toBe(0);
  });

  it('on the ground: down-sideways dashes along the floor, straight down does nothing and costs nothing', () => {
    const { game, p } = standing();
    tap(game, p, Btn.Dash | Btn.Down | Btn.Right);
    expect(p.dashDir).toBe(0);
    const solid = standing();
    tap(solid.game, solid.p, Btn.Dash | Btn.Down);
    expect(solid.p.dashTicks).toBe(0);
    expect(solid.p.dashCooldown).toBe(0);
    expect(solid.p.fuel).toBe(100);
  });

  it('a straight-down dash on a one-way platform goes through it', () => {
    const { game, p } = makeGame(flatMap([], [{ ax: 10, ay: 4, bx: 30, by: 4 }]));
    placeOnGround(game, p, 20, 4);
    expect(p.y).toBeCloseTo(4, 2);
    tap(game, p, Btn.Dash | Btn.Down);
    expect(p.airDashUsed).toBe(false); // started on the platform: not the air dash
    hold(game, p, 0, 40);
    expect(p.y).toBeLessThan(0.01);
    expect(p.grounded).toBe(true);
  });

  it('stops at walls: move-and-slide, no tunnelling (even through a 2 cm wall)', () => {
    for (const [x0, x1] of [
      [21.32 + 0.6, 24],
      [21, 21.15],
      [21, 21.02],
    ] as const) {
      const { game, p } = makeGame(flatMap([rect(x0, 0, x1, 6)], [], 120));
      placeOnGround(game, p, x0 - 1 - 0.32 + (x1 - x0 < 1 ? 0.6 : 0));
      tap(game, p, Btn.Dash | Btn.Right);
      hold(game, p, 0, BURST + 20);
      expect(p.x + 0.32).toBeLessThanOrEqual(x0 + 1e-3);
    }
  });

  it('a 1 s cooldown: a fresh press 59 ticks later does nothing, one 60 ticks later dashes', () => {
    const pressAfter = (k: number) => {
      const { game, p } = standing();
      tap(game, p, Btn.Dash | Btn.Right);
      hold(game, p, 0, k - 1);
      tap(game, p, Btn.Dash | Btn.Left);
      return p.dashTicks;
    };
    expect(pressAfter(21)).toBe(0);
    expect(pressAfter(59)).toBe(0);
    expect(pressAfter(60)).toBe(BURST - 1);
  });

  it('one air dash per flight; landing gives it back (a dash from the ground is not the air one)', () => {
    const { game, p } = standing();
    tap(game, p, Btn.Dash | Btn.Jet); // from the ground: up
    expect(p.airDashUsed).toBe(false);
    hold(game, p, Btn.Jet, 70); // stay up past the cooldown
    expect(p.grounded).toBe(false);
    tap(game, p, Btn.Dash | Btn.Right); // the air dash
    expect(p.dashTicks).toBe(BURST - 1);
    expect(p.airDashUsed).toBe(true);
    hold(game, p, Btn.Jet, 70);
    tap(game, p, Btn.Dash | Btn.Right); // spent: nothing
    expect(p.dashTicks).toBe(0);
    while (!p.grounded) hold(game, p, 0, 1);
    hold(game, p, 0, 1);
    expect(p.airDashUsed).toBe(false);
    hold(game, p, 0, 240); // refuel
    hold(game, p, Btn.Jet, 20);
    tap(game, p, Btn.Dash | Btn.Left); // a new flight, a new air dash
    expect(p.dashTicks).toBe(BURST - 1);
    expect(p.airDashUsed).toBe(true);
  });

  it('costs fuel, needs it, and an EMP blocks it (it is a jetpack burst)', () => {
    const { game, p } = standing();
    tap(game, p, Btn.Dash);
    expect(p.fuel).toBeCloseTo(100 - defaultTuning.dashFuelCost, 6);
    const dry = standing();
    dry.p.fuel = defaultTuning.dashFuelCost - 1;
    tap(dry.game, dry.p, Btn.Dash);
    expect(dry.p.dashTicks).toBe(0);
    const { game: g2, p: p2 } = makeGame({ ...flatMap(), zones: [{ id: 'emp', kind: 'emp', rect: [0, 0, 60, 28] }] });
    placeOnGround(g2, p2, 20);
    tap(g2, p2, Btn.Dash);
    expect(p2.dashTicks).toBe(0);
  });

  it('a blast knocks you out of a dash: no invulnerability frames', () => {
    const { game, p } = standing();
    tap(game, p, Btn.Dash | Btn.Right);
    const g = game.allocGrenade()!;
    Object.assign(g, { alive: true, owner: 15, x: p.x + 1.5, y: 0.15, vx: 0, vy: 0, fuse: 1 });
    hold(game, p, 0, 1);
    expect(p.dashTicks).toBe(0);
    expect(p.vx).toBeLessThan(0); // thrown back the other way
  });

  it('a small push (Breacher pellets) also ends it, from the exit speed, not the burst speed', () => {
    const { game, p } = makeGame(flatMap([], [], 120));
    placeOnGround(game, p, 20);
    const shooter = game.addPlayer('shooter');
    shooter.spawn(27, 0, game.tuning);
    game.setLoadout(shooter, [BREACHER.index, BREACHER.index]);
    const inputs: Input[] = [];
    inputs[p.id] = { ...createInput(), buttons: 0 };
    inputs[shooter.id] = { ...createInput(), buttons: 0, aim: angleToU16(Math.PI) };
    for (let i = 0; i < 5; i++) game.step(inputs);
    inputs[p.id] = { ...createInput(), buttons: Btn.Dash | Btn.Right };
    game.step(inputs); // the burst starts: 14 m/s toward the shooter
    expect(p.dashTicks).toBe(BURST - 1);
    inputs[p.id] = { ...createInput(), buttons: Btn.Right };
    inputs[shooter.id] = { ...createInput(), buttons: Btn.Fire, aim: angleToU16(Math.PI) };
    game.step(inputs);
    const hits = game.events.filter((e) => e.type === 'hit' && e.target === p.id).length;
    expect(hits).toBeGreaterThan(0);
    expect(p.dashTicks).toBe(0);
    // walk cap, minus the pellets' 0.6 m/s pushes: nowhere near the 14 m/s burst
    expect(p.vx).toBeLessThanOrEqual(defaultTuning.walkMax);
    expect(p.vx).toBeGreaterThan(defaultTuning.walkMax - 0.6 * hits - 0.01);
  });

  it('on a fast map the exit never exceeds launchSpeedX (so a dash never becomes a slow-bleeding launch)', () => {
    const { game, p } = makeGame({ ...flatMap([], [], 120), rules: { moveSpeedMul: 3 } });
    placeOnGround(game, p, 20);
    tap(game, p, Btn.Dash | Btn.Right);
    hold(game, p, 0, BURST - 1);
    expect(p.dashTicks).toBe(0);
    expect(p.vx).toBe(defaultTuning.launchSpeedX);
  });

  it('leaves you within the walk or air caps, and at most dashExitUp going up', () => {
    const { game, p } = standing();
    tap(game, p, Btn.Dash | Btn.Right);
    hold(game, p, 0, BURST - 1);
    expect(Math.abs(p.vx)).toBeLessThanOrEqual(defaultTuning.walkMax);
    const up = standing();
    tap(up.game, up.p, Btn.Dash | Btn.Jet);
    hold(up.game, up.p, 0, BURST - 1);
    expect(up.p.vy).toBeLessThanOrEqual(defaultTuning.dashExitUp);
    expect(up.p.vy).toBeGreaterThan(0);
  });

  it('announces itself: start position and direction', () => {
    const { game, p } = standing();
    const x0 = p.x;
    const events = tap(game, p, Btn.Dash | Btn.Left | Btn.Jet);
    expect(events.filter((e) => e.type === 'dash')).toEqual([{ type: 'dash', player: p.id, x: x0, y: p.prevY, dir: 3 }]);
    hold(game, p, 0, 1);
    expect(game.events.some((e) => e.type === 'dash')).toBe(false);
  });

  it('map zones apply: in zero-g the dash keeps drifting after the burst', () => {
    const { game, p } = makeGame({ ...flatMap(), zones: [{ id: 'z', kind: 'zeroG', rect: [0, 0, 60, 28] }] });
    p.x = 20;
    p.y = 10;
    p.grounded = false;
    tap(game, p, Btn.Dash | Btn.Jet);
    hold(game, p, 0, BURST - 1);
    const vy = p.vy;
    expect(vy).toBeCloseTo(defaultTuning.dashExitUp, 6);
    hold(game, p, 0, 60);
    expect(p.vy).toBeGreaterThan(0.5 * vy); // nothing pulls it back down (drag only)
  });
});
