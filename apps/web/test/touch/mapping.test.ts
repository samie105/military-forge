import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { ASSIST, FIRE_AT, aimOnTarget, assistAim, createTouchState, desiredAim, grenadeStrength, throwStrength, touchButtons } from '../../src/touch/mapping';
import { AIM_STICK, GRENADE_STICK, MOVE_STICK, shapeStick } from '../../src/touch/stick';

describe('touch → Input mapping', () => {
  it('the move stick gives the keyboard\'s movement bits', () => {
    const s = createTouchState();
    s.moveActive = true;
    shapeStick(80, -80, 100, MOVE_STICK, s.move); // up-right
    expect(touchButtons(s, 'hold')).toBe(Btn.Right | Btn.Jet);
    s.moveActive = false; // the thumb lifted: nothing held over
    expect(touchButtons(s, 'hold')).toBe(0);
  });

  it('hold mode fires once the aim stick is past half-way; nearer the centre it only aims', () => {
    const s = createTouchState();
    s.aimActive = true;
    shapeStick(30, 0, 100, AIM_STICK, s.aim);
    expect(s.aim.mag).toBeLessThan(FIRE_AT);
    expect(touchButtons(s, 'hold') & Btn.Fire).toBe(0);
    shapeStick(90, 0, 100, AIM_STICK, s.aim);
    expect(touchButtons(s, 'hold') & Btn.Fire).toBe(Btn.Fire);
    expect(touchButtons(s, 'release') & Btn.Fire).toBe(0); // release mode fires on lift (a pulse)
    s.pulses = Btn.Fire;
    expect(touchButtons(s, 'release') & Btn.Fire).toBe(Btn.Fire);
  });

  it('buttons and pulses: a tap shorter than a tick still reaches the sim', () => {
    const s = createTouchState();
    s.held = Btn.Reload;
    s.pulses = Btn.Swap;
    expect(touchButtons(s, 'hold')).toBe(Btn.Reload | Btn.Swap);
  });

  it('a dash goes the way the stick pointed when it was asked for', () => {
    const s = createTouchState();
    s.moveActive = true;
    shapeStick(90, 0, 100, MOVE_STICK, s.move); // running right…
    s.pulses = Btn.Dash;
    s.dashDir = Btn.Left | Btn.Jet; // …but the swipe was up-left
    expect(touchButtons(s, 'hold')).toBe(Btn.Dash | Btn.Left | Btn.Jet);
  });

  it('Dash tapped with the move stick idle sends no direction: the sim dashes the way the soldier faces', () => {
    const s = createTouchState();
    s.pulses = Btn.Dash;
    s.dashDir = 0; // the controller's pick when the move stick isn't held
    expect(touchButtons(s, 'hold')).toBe(Btn.Dash);
  });

  it('the grenade button never holds the grenade bit (the throw latch throws on release); its drag aims and sets the strength', () => {
    const s = createTouchState();
    s.grenadeActive = true;
    expect(touchButtons(s, 'hold') & Btn.Grenade).toBe(0); // finger down: no throw
    expect(throwStrength(s.grenade)).toBe(0); // no push: 70 %
    shapeStick(0, -40, 100, GRENADE_STICK, s.grenade);
    expect(throwStrength(s.grenade)).toBeGreaterThanOrEqual(1);
    expect(throwStrength(s.grenade)).toBeLessThan(7);
    expect(desiredAim(s)).toBeCloseTo(Math.PI / 2, 12); // straight up
    shapeStick(200, 0, 100, GRENADE_STICK, s.grenade);
    expect(throwStrength(s.grenade)).toBe(7);
  });

  it('holding the grenade button, the right stick aims the throw and its push sets the strength, without firing', () => {
    const s = createTouchState();
    s.grenadeActive = true;
    s.aimActive = true;
    shapeStick(-60, -60, 100, AIM_STICK, s.aim); // up-left, pushed most of the way
    expect(desiredAim(s)).toBeCloseTo((3 * Math.PI) / 4, 6);
    expect(grenadeStrength(s)).toBe(throwStrength(s.aim));
    expect(grenadeStrength(s)).toBeGreaterThan(3);
    expect(s.aim.mag).toBeGreaterThanOrEqual(FIRE_AT);
    expect(touchButtons(s, 'hold') & Btn.Fire).toBe(0); // aiming a throw, not shooting
    s.grenadeActive = false;
    expect(touchButtons(s, 'hold') & Btn.Fire).toBe(Btn.Fire);
  });

  it('the aim stick sets the aim; let go and the last aim stays', () => {
    const s = createTouchState();
    expect(desiredAim(s)).toBeNull();
    s.aimActive = true;
    shapeStick(-50, 0, 100, AIM_STICK, s.aim);
    expect(Math.cos(desiredAim(s)!)).toBeCloseTo(-1, 12); // straight left (π and −π alike)
    shapeStick(2, 0, 100, AIM_STICK, s.aim); // in the dead zone
    expect(desiredAim(s)).toBeNull();
  });
});

describe('aim assist (touch only, light)', () => {
  const target = [{ x: 10, y: 0 }];

  it('only counts targets the aim lies on, within range', () => {
    expect(aimOnTarget(0, 0, 0, target)).toBe(true);
    expect(aimOnTarget(Math.atan2(ASSIST.radius * 1.5, 10), 0, 0, target)).toBe(false);
    expect(aimOnTarget(0, 0, 0, [{ x: ASSIST.range + 5, y: 0 }])).toBe(false);
  });

  it('slows the turn while on a target, never pulls toward one, and still gets there', () => {
    const desired = 0.6;
    const slowed = assistAim(0, desired, 0, 0, target, true);
    expect(slowed).toBeCloseTo(desired * ASSIST.slow, 12);
    expect(assistAim(0, desired, 0, 0, target, false)).toBe(desired); // off
    expect(assistAim(1, 1.4, 0, 0, target, true)).toBe(1.4); // off target: untouched, no pull back to it
    let aim = 0;
    for (let i = 0; i < 12; i++) aim = assistAim(aim, desired, 0, 0, target, true);
    expect(aim).toBeCloseTo(desired, 2);
  });

  it('takes the short way across ±π', () => {
    const aim = assistAim(Math.PI - 0.01, -Math.PI + 0.05, 0, 0, [{ x: -10, y: 0 }], true);
    expect(Math.abs(aim)).toBeGreaterThan(Math.PI - 0.02);
  });
});
