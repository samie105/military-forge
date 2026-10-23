/**
 * The Standard preset's movement zones and their hysteresis (gamepad/mapping.ts), from the controls
 * spec's §5.9 table (docs/design/controls-research.md), plus the trigger, aim and layout rules.
 */
import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { AIM_TURN, FLIP_TICKS, MOVE_ZONES, STICK_OUTER, createAimState, createMoveState, dashDirection, moveBits, moveStep, shapeAxes, stepAim, triggerHeld, type StickVector } from '../../src/gamepad/mapping';
import { DEFAULT_PAD_SETTINGS, PAD_PRESETS, PAD_PRESET_ORDER, PAD_REV, applyPadPreset, buttonMap, padLayoutOf, rebindPad, sanitizePadSettings } from '../../src/gamepad/settings';
import { heldBits } from '../../src/gamepad/mapping';
import { B } from '../../src/gamepad/standard';

const DZ = DEFAULT_PAD_SETTINGS.moveDeadzone;
/** A move-stick reading: `push` of the raw throw at `deg` (0 = right, 90 = up), as the manager shapes it. */
const at = (deg: number, push = 1): StickVector => {
  const r = (deg * Math.PI) / 180;
  return shapeAxes(Math.cos(r) * push, -Math.sin(r) * push, DZ, 1, undefined, MOVE_ZONES.snapDeg);
};
const raw = (x: number, y = 0): StickVector => shapeAxes(x, y, DZ, 1, undefined, MOVE_ZONES.snapDeg);
const MOVE = Btn.Left | Btn.Right | Btn.Jet | Btn.Down;

describe('the spec’s table (§5.9)', () => {
  it('runs from 0.30 of the raw throw, not from 0.25', () => {
    expect(DZ).toBe(0.15);
    expect(STICK_OUTER).toBe(0.92);
    expect(moveBits(raw(0.3), true)).toBe(Btn.Right);
    expect(moveBits(raw(-0.3), true)).toBe(Btn.Left);
    expect(moveBits(raw(0.25), true)).toBe(0);
  });

  it('a full push at 40° runs without jetting; at 60° it jets (and runs)', () => {
    expect(moveBits(at(40), true) & MOVE).toBe(Btn.Right);
    expect(moveBits(at(60), true) & MOVE).toBe(Btn.Right | Btn.Jet);
    expect(moveBits(at(90), true) & MOVE).toBe(Btn.Jet);
    expect(moveBits(at(140), true) & MOVE).toBe(Btn.Left);
    expect(moveBits(at(120), true) & MOVE).toBe(Btn.Left | Btn.Jet);
  });

  it('once jetting, the stick keeps jetting down to 20° (hysteresis), and stops below', () => {
    const st = createMoveState();
    expect(moveStep(st, at(80), true) & Btn.Jet).toBe(Btn.Jet);
    expect(moveStep(st, at(25), true) & Btn.Jet).toBe(Btn.Jet);
    expect(moveStep(st, at(21), true) & Btn.Jet).toBe(Btn.Jet);
    expect(moveStep(st, at(15), true) & Btn.Jet).toBe(0);
    // and it takes the steep cone to start again
    expect(moveStep(st, at(40), true) & Btn.Jet).toBe(0);
    expect(moveStep(st, at(56), true) & Btn.Jet).toBe(Btn.Jet);
  });

  it('the jet starts with a push of 0.60 and holds to 0.40', () => {
    const st = createMoveState();
    // raw push p → shaped (p − 0.15) / 0.77
    expect(moveStep(st, at(90, 0.55), true) & Btn.Jet).toBe(0); // 0.52
    expect(moveStep(st, at(90, 0.65), true) & Btn.Jet).toBe(Btn.Jet); // 0.65
    expect(moveStep(st, at(90, 0.5), true) & Btn.Jet).toBe(Btn.Jet); // 0.45: held
    expect(moveStep(st, at(90, 0.4), true) & Btn.Jet).toBe(0); // 0.32: let go
  });

  it('no stick jet at all with "Push up to jet" off (Bumper Jet)', () => {
    expect(moveBits(at(90), false) & Btn.Jet).toBe(0);
  });

  it('a full push 15° below horizontal runs without crouching; at −80° it crouches', () => {
    expect(moveBits(at(-15), true) & MOVE).toBe(Btn.Right);
    expect(moveBits(at(-80), true) & MOVE).toBe(Btn.Down);
    expect(moveBits(at(-90), true) & MOVE).toBe(Btn.Down);
  });

  it('crouch is only within ±30° of straight down, with a push of 0.70 (held to 0.55)', () => {
    expect(moveBits(at(-55), true) & Btn.Down).toBe(0);
    expect(moveBits(at(-61), true) & Btn.Down).toBe(Btn.Down);
    expect(moveBits(at(-90, 0.65), true) & Btn.Down).toBe(0); // 0.65 shaped
    const st = createMoveState();
    expect(moveStep(st, at(-90, 0.8), true) & Btn.Down).toBe(Btn.Down);
    expect(moveStep(st, at(-90, 0.62), true) & Btn.Down).toBe(Btn.Down); // 0.61: held
    expect(moveStep(st, at(-90, 0.55), true) & Btn.Down).toBe(0); // 0.52: let go
  });

  it('dashes at 25° and 30° go right only; at 50° up-right; at 80° up', () => {
    expect(dashDirection(at(25))).toBe(Btn.Right);
    expect(dashDirection(at(30))).toBe(Btn.Right);
    expect(dashDirection(at(50))).toBe(Btn.Right | Btn.Jet);
    expect(dashDirection(at(80))).toBe(Btn.Jet);
    expect(dashDirection(at(-80))).toBe(Btn.Down);
    expect(dashDirection(at(-140))).toBe(Btn.Left | Btn.Down);
    expect(dashDirection(at(180))).toBe(Btn.Left);
  });

  it('the dash zones match movement’s: up dashes start where the stick jet starts', () => {
    for (const deg of [56, 70, 90, 110, 124]) expect(dashDirection(at(deg)) & Btn.Jet).toBe(Btn.Jet);
    for (const deg of [56, 90, 124]) expect(moveBits(at(deg), true) & Btn.Jet).toBe(Btn.Jet);
    // a resting stick (or one under a run's push) dashes the way the soldier faces
    expect(dashDirection(raw(0.2))).toBe(0);
  });

  it('LT at 0.35 jets, and lets go only under 0.20', () => {
    expect(triggerHeld(0.35, true, false, DEFAULT_PAD_SETTINGS.aimThreshold)).toBe(true);
    expect(triggerHeld(0.25, true, false, DEFAULT_PAD_SETTINGS.aimThreshold)).toBe(false);
    expect(triggerHeld(0.21, true, true, DEFAULT_PAD_SETTINGS.aimThreshold)).toBe(true);
    expect(triggerHeld(0.19, true, true, DEFAULT_PAD_SETTINGS.aimThreshold)).toBe(false);
  });

  it('the aim turns from 0° to 180° in no more than 3 ticks', () => {
    for (const speed of [0.3, 1, 1.5]) {
      const st = createAimState();
      let a = 0;
      let ticks = 0;
      while (Math.abs(Math.abs(a) - Math.PI) > 1e-9 && ticks < 20) {
        a = stepAim(a, Math.PI, speed, st);
        ticks++;
      }
      expect(ticks).toBeLessThanOrEqual(FLIP_TICKS);
      expect(st.flipRate).toBe(0);
    }
  });

  it('small corrections keep the turn cap; a flip then ends and the cap is back', () => {
    const st = createAimState();
    expect(stepAim(0, 1, 1, st)).toBeCloseTo(AIM_TURN);
    expect(st.flipRate).toBe(0);
    // 100° is a flip: three equal steps
    const target = (100 * Math.PI) / 180;
    const first = stepAim(0, target, 1, st);
    expect(first).toBeCloseTo(target / 3);
    expect(stepAim(first, target, 1, st)).toBeCloseTo((2 * target) / 3);
  });
});

describe('the run’s hysteresis and the angular snap', () => {
  it('a run starts at 0.18 shaped and lets go under 0.12', () => {
    const st = createMoveState();
    expect(moveStep(st, raw(0.28), true)).toBe(0); // 0.17
    expect(moveStep(st, raw(0.3), true)).toBe(Btn.Right); // 0.19
    expect(moveStep(st, raw(0.26), true)).toBe(Btn.Right); // 0.14: held
    expect(moveStep(st, raw(0.23), true)).toBe(0); // 0.10: let go
  });

  it('a reversal runs the other way at once', () => {
    const st = createMoveState();
    expect(moveStep(st, raw(0.9), true)).toBe(Btn.Right);
    expect(moveStep(st, raw(-0.9), true)).toBe(Btn.Left);
    // a light push the other way (under the start, over the stop) stops rather than holding the old run
    expect(moveStep(st, raw(0.26), true)).toBe(0);
  });

  it('within ±12° of horizontal the move stick is snapped level', () => {
    const v = at(10);
    expect(v.y).toBe(0);
    expect(v.x).toBeCloseTo(1);
    expect(at(14).y).toBeGreaterThan(0);
  });

  it('the y axis never stops a run (a steep diagonal still runs)', () => {
    expect(moveBits(at(70), true) & Btn.Right).toBe(Btn.Right);
    expect(moveBits(at(-70), true) & Btn.Right).toBe(Btn.Right);
  });
});

describe('layouts', () => {
  it('Standard is the default; a remap is Custom; picking a preset brings its buttons back', () => {
    expect(padLayoutOf(DEFAULT_PAD_SETTINGS)).toBe('standard');
    const remapped = { ...DEFAULT_PAD_SETTINGS, bindings: rebindPad(DEFAULT_PAD_SETTINGS.bindings, 'reload', B.East, 0).bindings };
    expect(padLayoutOf(remapped)).toBe('custom');
    expect(padLayoutOf(applyPadPreset(remapped, 'standard'))).toBe('standard');
    const classic = applyPadPreset(DEFAULT_PAD_SETTINGS, 'classic');
    expect(padLayoutOf(classic)).toBe('classic');
    expect(classic.holdTake).toBe(false);
    // the feel settings stay the player's
    expect(applyPadPreset({ ...DEFAULT_PAD_SETTINGS, aimSpeed: 1.4 }, 'classic').aimSpeed).toBe(1.4);
  });

  it('a save from before the presets: untouched buttons become Standard, a remap stays (Custom)', () => {
    const oldDefaults = { enabled: true, bindings: PAD_PRESETS.classic.bindings, moveDeadzone: 0.2, aimAssist: true };
    const migrated = sanitizePadSettings(oldDefaults);
    expect(migrated.rev).toBe(PAD_REV);
    expect(padLayoutOf(migrated)).toBe('standard');
    expect(migrated.moveDeadzone).toBe(0.15);
    const remap = { ...PAD_PRESETS.classic.bindings, reload: [B.R3], melee: [] };
    const kept = sanitizePadSettings({ bindings: remap, moveDeadzone: 0.3 });
    expect(kept.bindings.reload).toEqual([B.R3]);
    expect(kept.holdTake).toBe(false);
    expect(kept.moveDeadzone).toBe(0.3);
    expect(padLayoutOf(kept)).toBe('custom');
    // a current save is left as it is
    const classicNow = sanitizePadSettings({ ...applyPadPreset(DEFAULT_PAD_SETTINGS, 'classic') });
    expect(padLayoutOf(classicNow)).toBe('classic');
  });
});

describe('the other layouts (spec §5.6)', () => {
  const press = (...b: number[]) => {
    const held = new Array<boolean>(18).fill(false);
    for (const i of b) held[i] = true;
    return held;
  };
  const mapOf = (id: keyof typeof PAD_PRESETS) => buttonMap(PAD_PRESETS[id].bindings, PAD_PRESETS[id].holdTake);

  it('Bumper Jet: LB (and A) jet, LT dashes, the stick never jets', () => {
    const m = mapOf('bumperJet');
    expect(heldBits(press(B.L1), m)).toBe(Btn.Jet);
    expect(heldBits(press(B.South), m)).toBe(Btn.Jet);
    expect(heldBits(press(B.L2), m)).toBe(Btn.Dash);
    expect(PAD_PRESETS.bumperJet.stickJet).toBe(false);
  });

  it('Southpaw: sticks swapped, triggers and bumpers swapped', () => {
    const m = mapOf('southpaw');
    expect(PAD_PRESETS.southpaw.swapSticks).toBe(true);
    expect(heldBits(press(B.L2), m)).toBe(Btn.Fire);
    expect(heldBits(press(B.R2), m)).toBe(Btn.Jet);
    expect(heldBits(press(B.R1), m)).toBe(Btn.Dash);
    expect(m.grenade.has(B.L1)).toBe(true);
  });

  it('One-stick: aims and fires for you with Strong assist; B swaps, Y melees', () => {
    const p = PAD_PRESETS.oneStick;
    expect([p.autoAim, p.autoFire, p.assist]).toEqual([true, true, 'strong']);
    const m = mapOf('oneStick');
    expect(heldBits(press(B.East), m)).toBe(Btn.Swap);
    expect(heldBits(press(B.North), m)).toBe(Btn.Melee);
  });

  it('every layout reads as itself, and One-stick’s Strong assist goes when you leave it', () => {
    for (const id of PAD_PRESET_ORDER) expect(padLayoutOf(applyPadPreset(DEFAULT_PAD_SETTINGS, id))).toBe(id);
    const one = applyPadPreset(DEFAULT_PAD_SETTINGS, 'oneStick');
    expect(one.assist).toBe('strong');
    expect(applyPadPreset(one, 'standard').assist).toBe('standard');
    // a player's own level stays when switching between the others
    expect(applyPadPreset({ ...DEFAULT_PAD_SETTINGS, assist: 'light' }, 'classic').assist).toBe('light');
  });
});

