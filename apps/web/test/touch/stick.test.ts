import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { AIM_STICK, FLICK, MOVE_STICK, STICK_FOLLOW, TOUCH_MOVE, followOrigin, isFlick, knobOffset, moveButtons, shapeStick, stickAngle, touchMoveButtons, wrapAngle, type StickVector } from '../../src/touch/stick';

const R = 100;

describe('stick maths', () => {
  it('a dead zone around the centre reads as no input', () => {
    expect(shapeStick(0, 0, R, MOVE_STICK).mag).toBe(0);
    expect(shapeStick(6, -4, R, MOVE_STICK).mag).toBe(0); // 7 % of the radius: inside 8 %
    expect(shapeStick(9, 0, R, MOVE_STICK).mag).toBeGreaterThan(0);
  });

  it('rescales from the dead zone to full deflection before the rim, and caps there', () => {
    const half = shapeStick((MOVE_STICK.deadZone + MOVE_STICK.outer) / 2 * R, 0, R, MOVE_STICK);
    expect(half.mag).toBeCloseTo(0.5, 9);
    expect(shapeStick(0.9 * R, 0, R, MOVE_STICK).mag).toBeCloseTo(1, 9);
    expect(shapeStick(3 * R, 0, R, MOVE_STICK).mag).toBe(1); // dragged far past the rim
  });

  it('both sticks: 8 % dead zone, full at 90 %, linear (§4.3)', () => {
    for (const shape of [MOVE_STICK, AIM_STICK]) {
      expect(shape).toEqual({ deadZone: 0.08, outer: 0.9, curve: 1 });
      expect(shapeStick(0.4 * R, 0, R, shape).mag).toBeCloseTo((0.4 - 0.08) / 0.82, 9);
    }
  });

  it('screen y is down, world y is up, and the direction survives shaping', () => {
    const up = shapeStick(0, -80, R, MOVE_STICK);
    expect(up.y).toBeGreaterThan(0);
    expect(up.x).toBeCloseTo(0, 12);
    const v = shapeStick(60, -60, R, AIM_STICK);
    expect(stickAngle(v)).toBeCloseTo(Math.PI / 4, 12);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(v.mag, 12);
  });

  it('the knob follows the finger and stops at the rim', () => {
    expect(knobOffset(30, 40, R)).toEqual({ x: 30, y: 40 });
    const k = knobOffset(300, 400, R);
    expect(Math.hypot(k.x, k.y)).toBeCloseTo(R, 9);
    expect(k.x / k.y).toBeCloseTo(0.75, 9);
  });

  it('movement buttons: walk past 30 %, jet half-way up, crouch 60 % down, diagonals combine', () => {
    const at = (deg: number, r = 0.9) => shapeStick(Math.cos((deg * Math.PI) / 180) * r * R, -Math.sin((deg * Math.PI) / 180) * r * R, R, MOVE_STICK);
    expect(moveButtons(at(0))).toBe(Btn.Right);
    expect(moveButtons(at(180))).toBe(Btn.Left);
    expect(moveButtons(at(20))).toBe(Btn.Right); // running right with a wandering thumb: no jet
    expect(moveButtons(at(45))).toBe(Btn.Right | Btn.Jet);
    expect(moveButtons(at(90))).toBe(Btn.Jet);
    expect(moveButtons(at(-90))).toBe(Btn.Down);
    expect(moveButtons(at(-135))).toBe(Btn.Left | Btn.Down);
    expect(moveButtons(at(0, 0.3))).toBe(0); // a light touch: under the walk threshold
  });

  it('a flick is quick, full, sharp and still going out at the lift; a nudge that stops is not (§4.6)', () => {
    const flick = { durationMs: 120, peak: 1, riseMs: 50, outSpeed: 1.2 };
    expect(isFlick(flick)).toBe(true);
    expect(isFlick({ ...flick, durationMs: FLICK.maxMs + 1 })).toBe(false); // held: a run
    expect(isFlick({ ...flick, peak: 0.8 })).toBe(false); // not pushed home
    expect(isFlick({ ...flick, riseMs: 120 })).toBe(false); // a slow push
    expect(isFlick({ ...flick, outSpeed: 0.1 })).toBe(false); // pushed, stopped, lifted: the nudges that used to dash
  });

  it('wrapAngle gives the short way round', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle((3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2, 12);
    expect(wrapAngle((-3 * Math.PI) / 2)).toBeCloseTo(Math.PI / 2, 12);
    expect(wrapAngle(7 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });
});

/** A reading at `deg` (0 = right, 90 = up) and push `push` (after the dead zone), as on the 66 px stick. */
const at = (deg: number, push: number): StickVector => {
  const r = (0.08 + push * 0.82) * 66;
  return shapeStick(Math.cos((deg * Math.PI) / 180) * r, -Math.sin((deg * Math.PI) / 180) * r, 66, MOVE_STICK);
};
const px = (dx: number, dy: number) => shapeStick(dx, -dy, 66, MOVE_STICK);

describe('the touch move stick (§4.3): thresholds, cones, hysteresis', () => {
  it('runs at 16 ± 1 px, jets at 30 ± 1 px straight up, crouches at 38 ± 1 px straight down', () => {
    expect(touchMoveButtons(px(15, 0), 0)).toBe(0);
    expect(touchMoveButtons(px(17, 0), 0)).toBe(Btn.Right);
    expect(touchMoveButtons(px(-17, 0), 0)).toBe(Btn.Left);
    expect(touchMoveButtons(px(0, 29), 0)).toBe(0);
    expect(touchMoveButtons(px(0, 31), 0)).toBe(Btn.Jet);
    expect(touchMoveButtons(px(0, -37), 0)).toBe(0);
    expect(touchMoveButtons(px(0, -39), 0)).toBe(Btn.Down);
  });

  it('a run that drifts up stays a run: no jet at 25° or 40°, a jet from 45°, and once jetting down to 15°', () => {
    expect(touchMoveButtons(at(25, 1), 0)).toBe(Btn.Right);
    expect(touchMoveButtons(at(40, 1), 0)).toBe(Btn.Right);
    expect(touchMoveButtons(at(50, 1), 0)).toBe(Btn.Right | Btn.Jet);
    let b = touchMoveButtons(at(80, 1), 0);
    for (let deg = 80; deg >= 16; deg -= 4) {
      b = touchMoveButtons(at(deg, 1), b);
      expect(b & Btn.Jet).toBe(Btn.Jet);
    }
    expect(touchMoveButtons(at(12, 1), b) & Btn.Jet).toBe(0);
    // a full push runs within ±78° of left or right: up-right is jet and run
    expect(touchMoveButtons(at(75, 1), 0)).toBe(Btn.Right | Btn.Jet);
    expect(touchMoveButtons(at(85, 1), 0)).toBe(Btn.Jet);
  });

  it('hysteresis: a run holds down to 0.14, a jet to 0.30, a crouch to 0.45; starting needs the higher line', () => {
    expect(touchMoveButtons(at(0, 0.17), Btn.Right)).toBe(Btn.Right);
    expect(touchMoveButtons(at(0, 0.17), 0)).toBe(0);
    expect(touchMoveButtons(at(0, 0.12), Btn.Right)).toBe(0);
    expect(touchMoveButtons(at(90, 0.35), Btn.Jet)).toBe(Btn.Jet);
    expect(touchMoveButtons(at(90, 0.35), 0)).toBe(0);
    expect(touchMoveButtons(at(-90, 0.5), Btn.Down)).toBe(Btn.Down);
    expect(touchMoveButtons(at(-90, 0.5), 0)).toBe(0);
    // crouch starts only within ±30° of straight down
    expect(touchMoveButtons(at(-55, 0.9), 0) & Btn.Down).toBe(0);
    expect(touchMoveButtons(at(-65, 0.9), 0) & Btn.Down).toBe(Btn.Down);
    expect(TOUCH_MOVE.runOff).toBeLessThan(TOUCH_MOVE.runOn);
  });

  it('dynamic follow: past 1.2 radii the origin slides after the thumb; reversing costs the same as from the centre', () => {
    const r = 66;
    expect(followOrigin(0, 0, 70, 0, r)).toEqual({ x: 0, y: 0 });
    const o = followOrigin(0, 0, 120, 0, r);
    expect(o.x).toBeCloseTo(120 - STICK_FOLLOW * r, 9);
    // reversing from there: Left 17 px past the origin, after 1.2 radii + 17 px of travel (not 120 + 17)
    const thumb = o.x - 17;
    expect(touchMoveButtons(px(thumb - o.x, 0), Btn.Right)).toBe(Btn.Left);
    expect(120 - thumb).toBeCloseTo(STICK_FOLLOW * r + 17, 9);
  });
});
