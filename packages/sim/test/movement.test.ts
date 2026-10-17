import { defaultTuning as T } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, SKIN, overlaps } from '../src';
import { flatMap, hill, hold, makeGame, placeOnGround, rect } from './helpers';

describe('ground movement', () => {
  it('falls, lands and rests a skin above the floor', () => {
    const { game, p } = makeGame(flatMap());
    p.y = 3;
    hold(game, p, 0, 90);
    expect(p.grounded).toBe(true);
    expect(p.y).toBeGreaterThan(0);
    expect(p.y).toBeLessThan(SKIN * 2);
    expect(p.vy).toBe(0);
  });

  it('accelerates to walk speed in ~0.11 s and holds it', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    hold(game, p, Btn.Right, 7);
    expect(p.vx).toBeCloseTo(T.walkMax, 1);
    const x0 = p.x;
    hold(game, p, Btn.Right, 60);
    // one second at walk speed (quantisation keeps the error well under 1%)
    expect(p.x - x0).toBeGreaterThan(T.walkMax * 0.99);
    expect(p.x - x0).toBeLessThan(T.walkMax * 1.01);
  });

  it('decelerates to a stop and reverses quickly', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    hold(game, p, Btn.Right, 30);
    hold(game, p, 0, 10);
    expect(p.vx).toBe(0);
    hold(game, p, Btn.Right, 30);
    hold(game, p, Btn.Left, 5);
    expect(p.vx).toBeLessThan(0);
  });

  it('crouch-walks slower', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    hold(game, p, Btn.Right | Btn.Down, 30);
    expect(p.crouched).toBe(true);
    expect(p.vx).toBeCloseTo(T.crouchMax, 3); // 1/1024 velocity quantum
  });
});

describe('jetpack & fuel', () => {
  it('burns fuel at fuelBurn/s (kick ticks at the kick rate), caps climb speed, and runs dry on schedule', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    hold(game, p, Btn.Jet, 60);
    const kickBurn = (T.fuelBurn * (T.jetKick - 1) * T.jetKickTicks) / 60;
    expect(p.fuel).toBeCloseTo(T.fuelMax - T.fuelBurn - kickBurn, 0);
    expect(p.vy).toBeLessThanOrEqual(T.jetMaxVy + 1e-9);
    // at the cap, thrust is tapered to balance gravity: vy settles where the taper equals g/thrust
    expect(p.vy).toBeGreaterThan(T.jetMaxVy - T.jetTaperBand);
    const emptyTick = Math.ceil(((T.fuelMax + T.fuelBurn * (1 - T.jetKick) * (T.jetKickTicks / 60)) / T.fuelBurn) * 60);
    hold(game, p, Btn.Jet, emptyTick - 62);
    expect(p.fuel).toBeGreaterThan(0);
    hold(game, p, Btn.Jet, 4);
    expect(p.fuel).toBe(0);
    expect(p.jetting).toBe(false);
  });

  it('tapping the jet gets no more climb per tank than holding it (kick exploit)', () => {
    const climb = (pattern: (tick: number) => boolean) => {
      const { game, p } = makeGame(flatMap());
      placeOnGround(game, p, 5);
      let best = 0;
      for (let t = 0; t < 900 && (t < 30 || !p.grounded); t++) {
        hold(game, p, pattern(t) && p.fuel > 0 ? Btn.Jet : 0, 1);
        best = Math.max(best, p.y);
        if (p.fuel <= 0 && p.vy < 0 && p.y < best - 1) break;
      }
      return best;
    };
    const held = climb(() => true);
    // tap rhythms that re-trigger the kick as often as possible (1-tick release resets jetTicks)
    for (const [on, off] of [
      [3, 1],
      [6, 1],
      [6, 2],
    ] as const) {
      expect(climb((t) => t % (on + off) < on)).toBeLessThanOrEqual(held * 1.02);
    }
  });

  it('needs the minimum fuel to re-ignite (no micro-tap hover)', () => {
    const { game, p } = makeGame(flatMap());
    p.y = 20;
    p.fuel = T.fuelMinIgnite - 1;
    p.fuelRegenDelay = 999;
    hold(game, p, Btn.Jet, 1);
    expect(p.jetting).toBe(false);
  });

  it('regenerates on the ground after the delay', () => {
    const { game, p } = makeGame(flatMap());
    placeOnGround(game, p, 5);
    p.fuel = 30;
    p.fuelRegenDelay = 999; // as if we just landed from a burn: clamped to the ground delay
    hold(game, p, 0, 60);
    const regenTicks = 60 - Math.round(T.fuelRegenDelayGround * 60);
    expect(p.fuel).toBeCloseTo(30 + (T.fuelRegenGround * regenTicks) / 60, 1);
  });
});

describe('collision edge cases (docs/02 §10)', () => {
  it('flying into a ceiling at full thrust never tunnels', () => {
    const { game, p } = makeGame(flatMap([rect(2, 4, 10, 5)]));
    placeOnGround(game, p, 5);
    for (let i = 0; i < 120; i++) {
      hold(game, p, Btn.Jet, 1);
      expect(p.y + T.standHeight).toBeLessThanOrEqual(4 + 1e-6);
    }
  });

  it('settles in a 60° wedge without jitter', () => {
    const map = flatMap([]);
    // carve a 60° wedge pit into the floor
    map.solids[0] = { points: [-2, -6, 62, -6, 62, 0, 23, 0, 21.5, -2.598, 20, 0, -2, 0] };
    const { game, p } = makeGame(map);
    p.x = 21.3;
    p.y = 1;
    hold(game, p, 0, 180);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 60; i++) {
      hold(game, p, 0, 1);
      xs.push(p.x);
      ys.push(p.y);
    }
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1e-6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-6);
    expect(p.y).toBeLessThan(0);
  });

  it('walks up 49° but not 51°', () => {
    for (const [deg, climbs] of [
      [49, true],
      [51, false],
    ] as const) {
      const { game, p } = makeGame(flatMap([hill(10, deg, 3, 2)]));
      placeOnGround(game, p, 5);
      let maxY = 0;
      for (let i = 0; i < 240; i++) {
        hold(game, p, Btn.Right, 1);
        maxY = Math.max(maxY, p.y);
      }
      expect(maxY > 2.5, `${deg}°`).toBe(climbs);
    }
  });

  it('stands still on a 45° slope without creeping', () => {
    const { game, p } = makeGame(flatMap([hill(10, 45, 6, 2)]));
    p.x = 12;
    p.y = 2.5;
    hold(game, p, 0, 60);
    expect(p.grounded).toBe(true);
    const x0 = p.x;
    const y0 = p.y;
    hold(game, p, 0, 120);
    expect(p.x).toBe(x0);
    expect(p.y).toBe(y0);
  });

  it('keeps walking speed on the slope and stays glued going down', () => {
    const { game, p } = makeGame(flatMap([hill(10, 30, 3, 2)]));
    placeOnGround(game, p, 5);
    let airborneTicks = 0;
    for (let i = 0; i < 300; i++) {
      hold(game, p, Btn.Right, 1);
      if (!p.grounded) airborneTicks++;
    }
    expect(p.x).toBeGreaterThan(23); // crossed the whole hill (ends at x ≈ 22.4)
    expect(airborneTicks).toBe(0);
  });

  it('steps up a 0.2 m ledge but not a 0.5 m one', () => {
    for (const [height, passes] of [
      [0.2, true],
      [0.5, false],
    ] as const) {
      const { game, p } = makeGame(flatMap([rect(10, 0, 14, height)]));
      placeOnGround(game, p, 5);
      hold(game, p, Btn.Right, 120);
      expect(p.x > 11, `${height} m`).toBe(passes);
    }
  });

  it('one-way platforms: fly up through, land on top, hold down to drop through', () => {
    const { game, p } = makeGame(flatMap([], [{ ax: 3, ay: 3, bx: 9, by: 3 }]));
    placeOnGround(game, p, 5);
    hold(game, p, Btn.Jet, 45);
    expect(p.y).toBeGreaterThan(3);
    hold(game, p, 0, 120);
    expect(p.grounded).toBe(true);
    expect(p.y).toBeGreaterThan(3 - 1e-6);
    expect(p.y).toBeLessThan(3.01);
    hold(game, p, Btn.Down, 30);
    hold(game, p, 0, 60);
    expect(p.y).toBeLessThan(0.01);
    expect(p.grounded).toBe(true);
  });

  it('crouches into a 1.25 m corridor and only stands when there is room', () => {
    const { game, p } = makeGame(flatMap([rect(10, 1.25, 16, 4)]));
    placeOnGround(game, p, 6);
    hold(game, p, Btn.Right, 60);
    expect(p.x).toBeLessThan(10); // blocked standing up
    hold(game, p, Btn.Right | Btn.Down, 60);
    expect(p.x).toBeGreaterThan(10.5);
    hold(game, p, 0, 10); // release crouch inside: no room to stand
    expect(p.crouched).toBe(true);
    hold(game, p, Btn.Right | Btn.Down, 180);
    hold(game, p, 0, 5);
    expect(p.x).toBeGreaterThan(16.5);
    expect(p.crouched).toBe(false);
  });

  it('crouch-walking off a ledge stands up in the air', () => {
    const { game, p } = makeGame(flatMap([rect(2, 0, 8, 3)]));
    p.x = 6;
    p.y = 3.05;
    hold(game, p, Btn.Down, 10);
    expect(p.crouched).toBe(true);
    hold(game, p, Btn.Right | Btn.Down, 70);
    expect(p.crouched).toBe(false);
  });

  it('corner correction: a ledge corner ≤ 0.12 m into the capsule is slipped past without losing climb speed', () => {
    // capsule spans 5.28..5.92; the overhang's corner sits 0.10 m inside it
    const { game, p } = makeGame(flatMap([rect(0, 4, 5.38, 5)]));
    placeOnGround(game, p, 5.6);
    let lostSpeed = false;
    for (let i = 0; i < 120 && p.y < 5; i++) {
      hold(game, p, Btn.Jet, 1);
      if (i > 10 && p.vy <= 0) lostSpeed = true;
    }
    expect(p.y).toBeGreaterThanOrEqual(5);
    expect(lostSpeed).toBe(false);
  });

  it('a full ceiling stops the climb', () => {
    const { game, p } = makeGame(flatMap([rect(0, 4, 8, 5)]));
    placeOnGround(game, p, 5.6);
    let maxY = 0;
    for (let i = 0; i < 120; i++) {
      hold(game, p, Btn.Jet, 1);
      maxY = Math.max(maxY, p.y);
    }
    expect(maxY + T.standHeight).toBeLessThanOrEqual(4);
  });

  it('lands after a fast diagonal fall (regression: float residue kept the player airborne forever)', () => {
    for (const [vx, vy] of [
      [6, -16],
      [5, -16],
      [-6.5, -12],
      [6, -2],
    ] as const) {
      const { game, p } = makeGame(flatMap());
      p.x = 30;
      p.y = 1;
      p.vx = vx;
      p.vy = vy;
      p.grounded = false;
      p.fuel = 0;
      hold(game, p, vx > 0 ? Btn.Right : Btn.Left, 20);
      expect(p.grounded, `vx=${vx} vy=${vy}`).toBe(true);
      expect(Math.abs(p.vx)).toBeLessThanOrEqual(T.walkMax + 1e-9); // ground speed rules apply again
    }
  });

  it('jetting up against a wall never pops the player through a ledge corner (regression: 0.6 m teleport)', () => {
    for (const height of [1, 2]) {
      const { game, p } = makeGame(flatMap([rect(10, 0, 13, height)]));
      placeOnGround(game, p, 8);
      hold(game, p, Btn.Right, 40); // pressed against the ledge wall
      let prevY = p.y;
      for (let i = 0; i < 40; i++) {
        hold(game, p, Btn.Right | Btn.Jet, 1);
        // per-tick rise can't exceed the climb cap (+ tiny resolve slack)
        expect(p.y - prevY, `${height} m ledge, tick ${i}`).toBeLessThan(T.jetMaxVy / 60 + 0.01);
        prevY = p.y;
      }
      expect(p.y).toBeGreaterThan(height); // and the player still gets over the ledge
    }
  });

  it('depenetrates a spawn inside geometry', () => {
    const { game, p } = makeGame(flatMap([rect(10, 0, 12, 2)]));
    p.x = 10.1;
    p.y = 1;
    hold(game, p, 0, 2);
    expect(overlaps(game.world, p.x, p.y, p.height(T), T.capsuleRadius, p.y)).toBe(false);
  });

  it('dies when falling out of the map', () => {
    const map = flatMap();
    map.solids[0] = rect(30, -6, 62, 0); // hole on the left
    const { game, p } = makeGame(map);
    p.x = 10;
    p.y = 2;
    hold(game, p, 0, 120);
    expect(p.deaths).toBe(1);
    expect(p.kills).toBe(-1);
  });
});
