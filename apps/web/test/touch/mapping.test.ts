import { weapons } from '@military-forge/content';
import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { AIM_MIN, ASSIST, AUTO_FIRE, AutoTrigger, FIRE_OFF, FIRE_ON, FIRE_RIM, aimOnTarget, assistAim, autoRange, createTouchState, effectiveFire, dashStrength, desiredAim, flickRate, grenadeStrength, pullFires, throwStrength, touchButtons, updateMove } from '../../src/touch/mapping';
import { AIM_STICK, GRENADE_STICK, MOVE_STICK, shapeStick } from '../../src/touch/stick';

describe('touch → Input mapping', () => {
  it('the move stick gives the keyboard\'s movement bits', () => {
    const s = createTouchState();
    s.moveActive = true;
    shapeStick(80, -80, 100, MOVE_STICK, s.move); // up-right
    updateMove(s);
    expect(touchButtons(s, 'pull')).toBe(Btn.Right | Btn.Jet);
    s.moveActive = false; // the thumb lifted: nothing held over
    expect(touchButtons(s, 'pull')).toBe(0);
  });

  it('Pull fires past 0.40 of the push (27 px on a 66 px stick) and stops under 0.30; nearer the centre it only aims', () => {
    const s = createTouchState();
    s.aimActive = true;
    const push = (px: number) => {
      shapeStick(px, 0, 66, AIM_STICK, s.aim);
      s.aimFire = pullFires(s.aim.mag, s.aimFire);
      return touchButtons(s, 'pull') & Btn.Fire;
    };
    expect(push(26)).toBe(0);
    expect(push(28)).toBe(Btn.Fire); // §4.11: Pull fires at 27 ± 1 px
    expect(push(24)).toBe(Btn.Fire); // still above 0.30: the line has some give
    expect(push(21)).toBe(0); // under 0.30 (≈ 21.5 px): it stops
    expect(push(26)).toBe(0); // and needs 0.40 again
    expect(FIRE_ON).toBeGreaterThan(FIRE_OFF);
    push(60);
    expect(touchButtons(s, 'release') & Btn.Fire).toBe(0); // release mode fires on lift (a pulse)
    s.pulses = Btn.Fire;
    expect(touchButtons(s, 'release') & Btn.Fire).toBe(Btn.Fire);
  });

  it('buttons and pulses: a tap shorter than a tick still reaches the sim', () => {
    const s = createTouchState();
    s.held = Btn.Reload;
    s.pulses = Btn.Swap;
    expect(touchButtons(s, 'pull')).toBe(Btn.Reload | Btn.Swap);
  });

  it('a dash goes the way the stick pointed when it was asked for', () => {
    const s = createTouchState();
    s.moveActive = true;
    shapeStick(90, 0, 100, MOVE_STICK, s.move); // running right…
    s.pulses = Btn.Dash;
    s.dashDir = Btn.Left | Btn.Jet; // …but the swipe was up-left
    expect(touchButtons(s, 'pull')).toBe(Btn.Dash | Btn.Left | Btn.Jet);
  });

  it('a dash is as strong as the stick was pushed, and as fast (the owner: a quick flick, a strong dash)', () => {
    const full = 6; // defaultTuning.dashFlickFull
    expect(dashStrength(1, flickRate(1, 0, 100), full)).toBe(7); // full push in 0.1 s: a flick
    expect(dashStrength(1, flickRate(1, 0, 1000), full)).toBe(Math.round(7 * (0.5 + 0.5 / full))); // full push, slowly
    expect(dashStrength(0.4, flickRate(0.4, 0, 1200), full)).toBeLessThanOrEqual(2); // a gentle push: a short dash
    expect(dashStrength(0, 0, full)).toBe(7); // the stick alone: the way you face, in full
    expect(dashStrength(0.8, flickRate(0.8, 0, 50), full)).toBeGreaterThan(dashStrength(0.8, flickRate(0.8, 0, 600), full));
    expect(createTouchState().dashStrength).toBe(7);
  });

  it('Dash tapped with the move stick idle sends no direction: the sim dashes the way the soldier faces', () => {
    const s = createTouchState();
    s.pulses = Btn.Dash;
    s.dashDir = 0; // the controller's pick when the move stick isn't held
    expect(touchButtons(s, 'pull')).toBe(Btn.Dash);
  });

  it('the grenade button never holds the grenade bit (the throw latch throws on release); its drag aims and sets the strength', () => {
    const s = createTouchState();
    s.grenadeActive = true;
    expect(touchButtons(s, 'pull') & Btn.Grenade).toBe(0); // finger down: no throw
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
    s.aimFire = pullFires(s.aim.mag, false);
    expect(s.aimFire).toBe(true);
    expect(touchButtons(s, 'pull') & Btn.Fire).toBe(0); // aiming a throw, not shooting
    s.grenadeActive = false;
    expect(touchButtons(s, 'pull') & Btn.Fire).toBe(Btn.Fire);
  });

  it('the aim stick sets the aim; let go and the last aim stays', () => {
    const s = createTouchState();
    expect(desiredAim(s)).toBeNull();
    s.aimActive = true;
    shapeStick(-50, 0, 100, AIM_STICK, s.aim);
    expect(Math.cos(desiredAim(s)!)).toBeCloseTo(-1, 12); // straight left (π and −π alike)
    shapeStick(2, 0, 100, AIM_STICK, s.aim); // in the dead zone
    expect(desiredAim(s)).toBeNull();
    // just past the dead zone the aim waits for a 0.15 push: a landing thumb doesn't swing it (§4.3)
    shapeStick(15, 10, 100, AIM_STICK, s.aim);
    expect(s.aim.mag).toBeGreaterThan(0);
    expect(s.aim.mag).toBeLessThan(AIM_MIN);
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

describe('fire modes (controls spec §4.4; the owner\'s shooting styles)', () => {
  const gun = (id: string) => weapons.find((w) => w.id === id)!;

  it('Auto fires while its trigger says so, or with the stick at the rim; never while a throw is aimed', () => {
    const s = createTouchState();
    expect(touchButtons(s, 'auto') & Btn.Fire).toBe(0);
    s.autoFiring = true;
    expect(touchButtons(s, 'auto') & Btn.Fire).toBe(Btn.Fire);
    s.autoFiring = false;
    s.aimActive = true;
    shapeStick(0.7 * 66, 0, 66, AIM_STICK, s.aim); // aiming, not at the rim
    expect(touchButtons(s, 'auto') & Btn.Fire).toBe(0);
    shapeStick(66, 0, 66, AIM_STICK, s.aim);
    expect(s.aim.mag).toBeGreaterThanOrEqual(FIRE_RIM);
    expect(touchButtons(s, 'auto') & Btn.Fire).toBe(Btn.Fire); // the rim: fire anyway
    s.grenadeActive = true;
    expect(touchButtons(s, 'auto') & Btn.Fire).toBe(0);
  });

  it('Fire button: the stick only aims (FIRE is a held button); Release: a pulse on the lift, a charged gun held while aiming', () => {
    const s = createTouchState();
    s.aimActive = true;
    s.aimFire = true;
    shapeStick(66, 0, 66, AIM_STICK, s.aim);
    expect(touchButtons(s, 'button') & Btn.Fire).toBe(0);
    s.held = Btn.Fire; // FIRE down
    expect(touchButtons(s, 'button') & Btn.Fire).toBe(Btn.Fire);
    s.held = 0;
    expect(touchButtons(s, 'release') & Btn.Fire).toBe(0);
    s.chargeHold = true;
    expect(touchButtons(s, 'release') & Btn.Fire).toBe(Btn.Fire);
  });

  it('precision weapons fire on release in Auto and Pull: snipers, DMRs, charged guns, launchers; the rest keep the mode', () => {
    for (const id of ['widow', 'longbow', 'ripper', 'pulse', 'thumper', 'popper']) {
      expect(effectiveFire('auto', gun(id), true)).toBe('release');
      expect(effectiveFire('pull', gun(id), true)).toBe('release');
      expect(effectiveFire('button', gun(id), true)).toBe('button'); // FIRE already separates aiming from firing
      expect(effectiveFire('auto', gun(id), false)).toBe('auto'); // the setting off
    }
    for (const id of ['hammer44', 'buzz', 'k47', 'breacher', 'dragon', 'shredder', 'arc']) expect(effectiveFire('auto', gun(id), true)).toBe('auto');
    // a shotgun auto-fires only to 0.6 of its range (the assist core's test takes 0.8 of what it's given)
    expect(autoRange(gun('breacher')) * 0.8).toBeCloseTo(gun('breacher').range * 0.6, 9);
    expect(autoRange(gun('k47'))).toBe(gun('k47').range);
  });

  it("Auto's trigger: the first shot after 100 ms on target, on for 150 ms after it leaves", () => {
    const t = new AutoTrigger();
    expect(t.step(true, 0)).toBe(false);
    expect(t.step(true, AUTO_FIRE.dwell - 1)).toBe(false);
    expect(t.step(true, AUTO_FIRE.dwell)).toBe(true);
    expect(t.step(false, AUTO_FIRE.dwell + 50)).toBe(true); // lingers
    expect(t.step(false, AUTO_FIRE.dwell + AUTO_FIRE.linger + 1)).toBe(false);
    // a passer-by for less than the dwell: no shot
    expect(t.step(true, 1000)).toBe(false);
    expect(t.step(false, 1060)).toBe(false);
  });
});
