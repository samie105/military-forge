/** The pad at run time (gamepad/manager.ts) with a fake Gamepad: play input, taps, the dash, menus → play. */
import { Btn, createInput } from '@military-forge/sim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThrowLatch } from '../../src/input';
import { PadManager } from '../../src/gamepad/manager';
import { B } from '../../src/gamepad/standard';

interface FakePad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
}

let pad: FakePad;
/** a menu with nothing to focus (the DOM side is menus.ts; spatial.test.ts covers the moves) */
const emptyMenu = { querySelectorAll: () => [], querySelector: () => null, contains: () => false } as unknown as Element;
const press = (i: number, on = true, value = on ? 1 : 0) => (pad.buttons[i] = { pressed: on, touched: on, value });

function setup(menu: { open: boolean } = { open: false }) {
  const sampler = { mouseX: 0, mouseY: 0, blocked: false, throwLatch: new ThrowLatch() };
  const calls = { back: 0, pause: 0, scoreboard: [] as boolean[] };
  const m = new PadManager({
    sampler,
    camera: null,
    menuScope: () => (menu.open ? emptyMenu : null),
    back: () => calls.back++,
    pause: () => calls.pause++,
    scoreboard: (down) => calls.scoreboard.push(down),
  });
  let now = 1000;
  const sample = () => {
    now += 1000 / 60;
    const out = createInput();
    m.apply(out, 0, 0, now);
    return out;
  };
  return { m, sampler, calls, sample, poll: () => m.poll((now += 5)) };
}

beforeEach(() => {
  pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 })) };
  vi.stubGlobal('navigator', { getGamepads: () => [pad] });
  vi.stubGlobal('document', { activeElement: null, body: null, documentElement: { dataset: {} } });
});
afterEach(() => vi.unstubAllGlobals());

describe('the pad in play', () => {
  it('held buttons and the move stick become the keyboard’s bits', () => {
    const { sample } = setup();
    press(B.R2, true, 0.9);
    pad.axes = [0.9, 0, 0, 0];
    expect(sample().buttons).toBe(Btn.Fire | Btn.Right);
    press(B.R2, false);
    pad.axes = [0, 0, 0, 0];
    expect(sample().buttons).toBe(0);
  });

  it('a press and release between two samples still reaches the sim', () => {
    const { sample, poll } = setup();
    sample();
    press(B.West);
    poll();
    press(B.West, false);
    poll();
    expect(sample().buttons & Btn.Reload).toBe(Btn.Reload);
    expect(sample().buttons & Btn.Reload).toBe(0);
  });

  it('a dash takes the move stick’s direction at the press', () => {
    const { sample } = setup();
    pad.axes = [-0.7, -0.7, 0, 0];
    sample();
    press(B.L1);
    const out = sample();
    expect(out.buttons & (Btn.Dash | Btn.Left | Btn.Jet)).toBe(Btn.Dash | Btn.Left | Btn.Jet);
  });

  it('writes a dash strength where the Input carries one (v14), and nothing where it doesn’t', () => {
    const { m } = setup();
    pad.axes = [0.4, 0, 0, 0];
    m.poll(1000);
    press(B.L1);
    m.poll(1300);
    const withField = { ...createInput(), dashStrength: 7 };
    m.apply(withField, 0, 0, 1310);
    expect(withField.buttons & Btn.Dash).toBe(Btn.Dash);
    expect(withField.dashStrength).toBeLessThan(7);
    press(B.L1, false);
    m.poll(1400);
    press(B.L1);
    m.poll(1500);
    const without = createInput();
    m.apply(without, 0, 0, 1510);
    expect('dashStrength' in without).toBe('dashStrength' in createInput());
  });

  it('the grenade button taps a quick throw through the throw latch, never held', () => {
    const { sample, poll } = setup();
    press(B.R1);
    expect(sample().buttons & Btn.Grenade).toBe(0);
    press(B.R1, false);
    poll();
    const out = sample();
    expect(out.buttons & Btn.Grenade).toBe(Btn.Grenade);
    expect(out.throwStrength).toBe(0); // a tap: the quick throw (70 %)
  });

  it('the right stick aims (and keeps the aim when let go)', () => {
    const { sample } = setup();
    pad.axes = [0, 0, 0, -1]; // up
    expect(sample().aim).toBe(16384);
    pad.axes = [0, 0, 0, 0];
    expect(sample().aim).toBe(16384);
  });

  it('Options opens the menu; the scoreboard button holds the scoreboard', () => {
    const { sample, calls } = setup();
    press(B.Start);
    sample();
    expect(calls.pause).toBe(1);
    press(B.Select);
    sample();
    press(B.Select, false);
    sample();
    expect(calls.scoreboard).toEqual([true, false]);
  });
});

describe('menus and play', () => {
  it('in a menu nothing reaches the sim; ○ / B goes back', () => {
    const menu = { open: true };
    const { sample, calls } = setup(menu);
    press(B.R2);
    expect(sample().buttons).toBe(0);
    press(B.R2, false);
    press(B.East);
    sample();
    expect(calls.back).toBe(1);
  });

  it('the ✕ that pressed Start doesn’t jet when play begins: held-over buttons wait to be let go', () => {
    const menu = { open: true };
    const { sample } = setup(menu);
    press(B.South);
    sample();
    menu.open = false; // the button started the match
    expect(sample().buttons & Btn.Jet).toBe(0);
    press(B.South, false);
    sample();
    press(B.South);
    expect(sample().buttons & Btn.Jet).toBe(Btn.Jet);
  });

  it('settings off: the pad is ignored', () => {
    const { m, sample } = setup();
    m.applySettings({ ...m.settings, enabled: false }, false);
    press(B.R2);
    expect(sample().buttons).toBe(0);
  });

  it('a rebind listens for the next button and keeps it from the menus', () => {
    const menu = { open: true };
    const { m, poll, calls } = setup(menu);
    let got = -1;
    m.captureNext((b) => (got = b));
    poll();
    press(B.East);
    poll();
    expect(got).toBe(B.East);
    expect(calls.back).toBe(0);
  });
});
