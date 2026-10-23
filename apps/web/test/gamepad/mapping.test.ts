/** Controller → Input (gamepad/mapping.ts, settings.ts): bindings, dead zones, triggers, the dash. */
import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { FULL_FLICK, RETICLE, TRIGGER_HYSTERESIS, dashDirection, heldBits, moveBits, navRepeats, NAV_REPEAT, padDashStrength, padThrowStrength, reticleDistance, shapeAxes, stepAim, stickNavDirection, triggerHeld } from '../../src/gamepad/mapping';
import { DEFAULT_PAD_SETTINGS, MAX_PAD_BINDINGS, PAD_ACTIONS, PAD_PRESETS, PAD_PRESET_ORDER, buttonMap, defaultPadBindings, rebindPad, sanitizePadBindings, sanitizePadSettings, unbindPad } from '../../src/gamepad/settings';
import { B, BUTTON_COUNT, padFamily } from '../../src/gamepad/standard';

const pressing = (...buttons: number[]) => {
  const held = new Array<boolean>(BUTTON_COUNT).fill(false);
  for (const b of buttons) held[b] = true;
  return held;
};

describe('the default layout', () => {
  const map = buttonMap(defaultPadBindings());

  it('Standard: LT and ✕ / A jet, RT fires, LB dashes, B melees, X reloads, Y swaps, L3 crouches, R3 spins up', () => {
    expect(heldBits(pressing(B.R2), map)).toBe(Btn.Fire);
    expect(heldBits(pressing(B.L2), map)).toBe(Btn.Jet);
    expect(heldBits(pressing(B.South), map)).toBe(Btn.Jet);
    expect(heldBits(pressing(B.L1), map)).toBe(Btn.Dash);
    expect(heldBits(pressing(B.West), map)).toBe(Btn.Reload);
    expect(heldBits(pressing(B.North), map)).toBe(Btn.Swap);
    expect(heldBits(pressing(B.East), map)).toBe(Btn.Melee);
    expect(heldBits(pressing(B.R3), map)).toBe(Btn.Fire2);
    expect(heldBits(pressing(B.L3), map)).toBe(Btn.Down);
    expect(heldBits(pressing(B.Up, B.Down, B.Right), map)).toBe(Btn.Dual | Btn.Shield | Btn.CycleGrenade);
  });

  it('Standard takes a gun with a held X (no button of its own); Classic keeps Y', () => {
    expect(DEFAULT_PAD_SETTINGS.holdTake).toBe(true);
    expect(buttonMap(defaultPadBindings(), true).holdTake.has(B.West)).toBe(true);
    expect(buttonMap(defaultPadBindings(), false).holdTake.size).toBe(0);
    const classic = buttonMap(PAD_PRESETS.classic.bindings, PAD_PRESETS.classic.holdTake);
    expect(heldBits(pressing(B.North), classic)).toBe(Btn.Interact);
    expect(heldBits(pressing(B.South), classic)).toBe(Btn.Jet);
    expect(heldBits(pressing(B.L2), classic)).toBe(Btn.Fire2);
    expect(heldBits(pressing(B.East), classic)).toBe(Btn.Swap);
    expect(heldBits(pressing(B.R3), classic)).toBe(Btn.Melee);
    expect(classic.holdTake.size).toBe(0);
  });

  it('the grenade button never reaches the sim held (the throw latch throws on its release)', () => {
    expect(heldBits(pressing(B.R1), map)).toBe(0);
    expect(map.grenade.has(B.R1)).toBe(true);
  });

  it('zoom, the scoreboard, push to talk and the menu are the page’s: no sim bits', () => {
    expect(heldBits(pressing(B.Left, B.Select, B.Extra, B.Start), map)).toBe(0);
    expect(map.zoom.has(B.Left)).toBe(true);
    // the touchpad is voice chat's push to talk (v18); Create / Share / View holds the scoreboard
    expect([...map.scoreboard]).toEqual([B.Select]);
  });

  it('no button does two things in any preset, and Options is never one of them', () => {
    for (const id of PAD_PRESET_ORDER) {
      const used = PAD_ACTIONS.flatMap((a) => PAD_PRESETS[id].bindings[a.id]);
      expect(new Set(used).size).toBe(used.length);
      expect(used).not.toContain(B.Start);
      // every action has a button, except take in a hold-to-take layout
      for (const a of PAD_ACTIONS) if (!(a.id === 'interact' && PAD_PRESETS[id].holdTake)) expect(PAD_PRESETS[id].bindings[a.id].length).toBeGreaterThan(0);
    }
  });
});

describe('sticks: dead zone and response curve', () => {
  it('a stick resting inside its dead zone reads nothing (no drift)', () => {
    expect(shapeAxes(0.1, -0.08, 0.15).mag).toBe(0);
    expect(shapeAxes(0, 0, 0.15).mag).toBe(0);
  });

  it('the dead zone is round, and what is past it is rescaled from 0 to 1', () => {
    const just = shapeAxes(0.16, 0, 0.15);
    expect(just.mag).toBeGreaterThan(0);
    expect(just.mag).toBeLessThan(0.05);
    expect(shapeAxes(0.92, 0, 0.15).mag).toBeCloseTo(1); // the outer dead zone: 0.92 is all the way
    // a diagonal past the zone counts like a straight push of the same length
    const diag = shapeAxes(0.5 / Math.SQRT2, 0.5 / Math.SQRT2, 0.15);
    expect(diag.mag).toBeCloseTo(shapeAxes(0.5, 0, 0.15).mag);
  });

  it('y comes out up-positive (the world’s), the Gamepad API’s is down', () => {
    expect(shapeAxes(0, -1, 0.1).y).toBeCloseTo(1);
    expect(shapeAxes(0, 1, 0.1).y).toBeCloseTo(-1);
  });

  it('a curve above 1 gives finer control near the centre, the same at the rim', () => {
    const lin = shapeAxes(0.5, 0, 0.1, 1).mag;
    const curved = shapeAxes(0.5, 0, 0.1, 2).mag;
    expect(curved).toBeLessThan(lin);
    expect(shapeAxes(1, 0, 0.1, 2).mag).toBeCloseTo(1);
  });

  it('the move stick walks, jets when pushed steeply up (if allowed) and crouches when pulled down', () => {
    expect(moveBits(shapeAxes(0.9, 0, 0.15), true)).toBe(Btn.Right);
    expect(moveBits(shapeAxes(-0.9, 0, 0.15), true)).toBe(Btn.Left);
    expect(moveBits(shapeAxes(0.4, -0.9, 0.15), true)).toBe(Btn.Right | Btn.Jet);
    expect(moveBits(shapeAxes(0.4, -0.9, 0.15), false)).toBe(Btn.Right);
    expect(moveBits(shapeAxes(0, 0.9, 0.15), true)).toBe(Btn.Down);
    expect(moveBits(shapeAxes(0.1, 0.1, 0.15), true)).toBe(0);
  });

  it('the reticle sits as far out as the aim stick is pushed', () => {
    expect(reticleDistance(0)).toBe(RETICLE.near);
    expect(reticleDistance(1)).toBe(RETICLE.far);
    expect(reticleDistance(0.5)).toBeGreaterThan(RETICLE.near);
  });

  it('a held grenade throws as hard as the aim stick is pushed', () => {
    expect(padThrowStrength(0)).toBe(0);
    expect(padThrowStrength(1)).toBe(7);
    expect(padThrowStrength(0.5)).toBe(4);
  });
});

describe('triggers', () => {
  it('count past their threshold and let go a little under it (no chatter)', () => {
    expect(triggerHeld(0.2, false, false, 0.3)).toBe(false);
    expect(triggerHeld(0.31, true, false, 0.3)).toBe(true);
    expect(triggerHeld(0.3 - TRIGGER_HYSTERESIS / 2, true, true, 0.3)).toBe(true);
    expect(triggerHeld(0.3 - TRIGGER_HYSTERESIS - 0.01, true, true, 0.3)).toBe(false);
  });

  it('a digital trigger (pressed, value 0) still counts', () => {
    expect(triggerHeld(0, true, false, 0.3)).toBe(true);
  });
});

describe('the dash', () => {
  it('goes 8 ways with the move stick, along the facing when it rests', () => {
    expect(dashDirection(shapeAxes(0, 0, 0.2))).toBe(0);
    expect(dashDirection(shapeAxes(1, 0, 0.2))).toBe(Btn.Right);
    expect(dashDirection(shapeAxes(-0.7, -0.7, 0.2))).toBe(Btn.Left | Btn.Jet);
    expect(dashDirection(shapeAxes(0, 1, 0.2))).toBe(Btn.Down);
    expect(dashDirection(shapeAxes(0.3, -0.9, 0.2))).toBe(Btn.Jet); // 18° off vertical: straight up
  });

  it('is full with the stick resting (as the keyboard) or flicked; a gentle push dashes softer', () => {
    expect(padDashStrength(0, 0)).toBe(7);
    expect(padDashStrength(1, 0)).toBe(7);
    expect(padDashStrength(0.3, FULL_FLICK)).toBe(7);
    const gentle = padDashStrength(0.3, 0);
    expect(gentle).toBeGreaterThanOrEqual(3);
    expect(gentle).toBeLessThan(7);
    expect(padDashStrength(0.3, FULL_FLICK / 2)).toBeGreaterThan(gentle);
  });
});

describe('the aim', () => {
  it('turns toward the stick at the aim speed; speed 2 is at once', () => {
    const step = stepAim(0, Math.PI / 2, 1);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(Math.PI / 2);
    expect(stepAim(0, Math.PI / 2, 2)).toBeCloseTo(Math.PI / 2);
    expect(stepAim(0, 0.05, 1)).toBeCloseTo(0.05); // a small change lands in one tick
  });

  it('turns the short way round', () => {
    // from 3 rad to −2.5 rad is 0.78 rad anticlockwise (through π), not 5.5 rad back
    expect(stepAim(3, -2.5, 1)).toBeCloseTo(3.35 - 2 * Math.PI);
    expect(stepAim(3, -3, 1)).toBeCloseTo(-3);
  });
});

describe('menus', () => {
  it('the stick moves focus once past half-way, along its stronger axis', () => {
    expect(stickNavDirection(0.3, 0.2)).toBeNull();
    expect(stickNavDirection(0.8, 0.3)).toBe('right');
    expect(stickNavDirection(-0.2, -0.9)).toBe('up');
    expect(stickNavDirection(0.1, 0.7)).toBe('down');
  });

  it('a held direction repeats after a pause, then steadily', () => {
    expect(navRepeats(0, 0, NAV_REPEAT.first - 1)).toBe(false);
    expect(navRepeats(0, 0, NAV_REPEAT.first)).toBe(true);
    expect(navRepeats(0, 500, 500 + NAV_REPEAT.every - 1)).toBe(false);
    expect(navRepeats(0, 500, 500 + NAV_REPEAT.every)).toBe(true);
  });
});

describe('settings', () => {
  it('rebinding a button takes it off the action that had it', () => {
    const { bindings, took } = rebindPad(defaultPadBindings(), 'reload', B.East, 0);
    expect(took).toBe('melee');
    expect(bindings.reload[0]).toBe(B.East);
    expect(bindings.melee).toEqual([]);
  });

  it('Options / Menu is never rebound (always the menu)', () => {
    const before = defaultPadBindings();
    expect(rebindPad(before, 'fire', B.Start, 0).bindings).toBe(before);
  });

  it('a second button can be added, then cleared', () => {
    const { bindings } = rebindPad(defaultPadBindings(), 'dash', B.R3, 1);
    expect(bindings.dash).toEqual([B.L1, B.R3]);
    expect(bindings.fire2).toEqual([]);
    expect(unbindPad(bindings, 'dash', 1).dash).toEqual([B.L1]);
  });

  it('saved bindings are cleaned: unknown buttons, the menu button and duplicates go', () => {
    const b = sanitizePadBindings({ fire: [7, 7, 99], jet: [9, 0], swap: [7], nonsense: [1] });
    expect(b.fire).toEqual([7]);
    expect(b.jet).toEqual([0]);
    expect(b.swap).toEqual([]); // 7 is fire's
    expect(b.reload).toEqual([B.West]); // missing: the default
    for (const a of PAD_ACTIONS) expect(b[a.id].length).toBeLessThanOrEqual(MAX_PAD_BINDINGS);
  });

  it('saved numbers are clamped, wrong types fall back to the defaults', () => {
    const s = sanitizePadSettings({ aimSpeed: 9, moveDeadzone: -1, vibration: 'yes', glyphs: 'sega', fireThreshold: 0.5 });
    expect(s.aimSpeed).toBe(2);
    expect(s.moveDeadzone).toBe(0.05);
    expect(s.vibration).toBe(DEFAULT_PAD_SETTINGS.vibration);
    expect(s.glyphs).toBe('auto');
    expect(s.fireThreshold).toBe(0.5);
    expect(sanitizePadSettings(null)).toEqual(DEFAULT_PAD_SETTINGS);
  });
});

describe('pad families from Gamepad.id', () => {
  it.each([
    ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'playstation'],
    ['054c-0ce6-DualSense Wireless Controller', 'playstation'],
    ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', 'playstation'],
    ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'xbox'],
    ['Xbox Wireless Controller Extended Gamepad', 'xbox'],
    ['Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 'nintendo'],
    ['8BitDo SN30 Pro (Vendor: 2dc8)', 'generic'],
  ])('%s → %s', (id, family) => {
    expect(padFamily(id)).toBe(family);
  });
});
