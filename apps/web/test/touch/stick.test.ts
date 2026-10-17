import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { AIM_STICK, MOVE_STICK, isSwipe, knobOffset, moveButtons, shapeStick, stickAngle, wrapAngle } from '../../src/touch/stick';

const R = 100;

describe('stick maths', () => {
  it('a dead zone around the centre reads as no input', () => {
    expect(shapeStick(0, 0, R, MOVE_STICK).mag).toBe(0);
    expect(shapeStick(10, -5, R, MOVE_STICK).mag).toBe(0); // 11 % of the radius
    expect(shapeStick(16, 0, R, MOVE_STICK).mag).toBeGreaterThan(0);
  });

  it('rescales from the dead zone to full deflection before the rim, and caps there', () => {
    const half = shapeStick((MOVE_STICK.deadZone + MOVE_STICK.outer) / 2 * R, 0, R, MOVE_STICK);
    expect(half.mag).toBeCloseTo(0.5, 9);
    expect(shapeStick(0.9 * R, 0, R, MOVE_STICK).mag).toBeCloseTo(1, 9);
    expect(shapeStick(3 * R, 0, R, MOVE_STICK).mag).toBe(1); // dragged far past the rim
  });

  it('the aim curve is finer near the centre', () => {
    const a = shapeStick(0.4 * R, 0, R, AIM_STICK);
    const linear = (0.4 - AIM_STICK.deadZone) / (AIM_STICK.outer - AIM_STICK.deadZone);
    expect(a.mag).toBeCloseTo(linear ** AIM_STICK.curve, 9);
    expect(a.mag).toBeLessThan(linear);
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

  it('a swipe is a quick, far stroke; a held run is not', () => {
    expect(isSwipe(150, 0.9)).toBe(true);
    expect(isSwipe(400, 1)).toBe(false);
    expect(isSwipe(100, 0.4)).toBe(false);
  });

  it('wrapAngle gives the short way round', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle((3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2, 12);
    expect(wrapAngle((-3 * Math.PI) / 2)).toBeCloseTo(Math.PI / 2, 12);
    expect(wrapAngle(7 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });
});
