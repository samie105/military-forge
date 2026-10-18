/**
 * InputSampler: rebindable keys and mouse buttons, the dash latch (a tap shorter than a tick still
 * dashes, with the direction held; alone, no direction: the sim dashes the way the soldier faces)
 * and double-tap dash (on by default; left, right, down; never the jet key).
 * A tiny DOM stand-in: the sampler only listens on window, document and its target.
 */
import { Btn } from '@military-forge/sim';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Camera } from '../src/camera';
import type { InputSampler as Sampler } from '../src/input';

let InputSampler: typeof Sampler;
let DOUBLE_TAP_MS: number;
let DEFAULT_KEY_BINDINGS: Sampler['bindings'];
const camera = { toWorldX: (x: number) => x, toWorldY: (y: number) => y } as unknown as Camera;

beforeAll(async () => {
  Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true }),
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
  });
  ({ InputSampler, DOUBLE_TAP_MS, DEFAULT_KEY_BINDINGS } = await import('../src/input'));
});

function fire(target: EventTarget, type: string, fields: Record<string, unknown>): void {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(fields)) Object.defineProperty(e, k, { value: v });
  target.dispatchEvent(e);
}
const down = (code: string, at: number) => fire(window, 'keydown', { code, repeat: false, timeStamp: at });
const up = (code: string, at: number) => fire(window, 'keyup', { code, repeat: false, timeStamp: at });
const tap = (code: string, at: number) => {
  down(code, at);
  up(code, at + 30);
};

function setup(): { s: Sampler; target: EventTarget; buttons(): number } {
  const target = new EventTarget();
  const s = new InputSampler(target as HTMLElement);
  return { s, target, buttons: () => s.sample(camera, 0, 0).buttons };
}

describe('InputSampler', () => {
  it('a Shift tap shorter than a tick still dashes, with the direction held at the press', () => {
    const { buttons } = setup();
    down('KeyA', 0);
    tap('ShiftLeft', 10);
    expect(buttons()).toBe(Btn.Left | Btn.Dash);
    expect(buttons()).toBe(Btn.Left); // one sample only
    up('KeyA', 50);
    tap('ShiftRight', 60);
    expect(buttons()).toBe(Btn.Dash); // nothing held: along the facing
  });

  it('double-tap dash is on by default (the owner\'s call); the setting turns it off', () => {
    const { s, buttons } = setup();
    expect(s.doubleTapDash).toBe(true);
    s.doubleTapDash = false;
    tap('KeyD', 0);
    tap('KeyD', 100);
    expect(buttons()).toBe(0);
    s.doubleTapDash = true;
    tap('KeyD', 1000);
    tap('KeyD', 1000 + DOUBLE_TAP_MS - 40);
    expect(buttons()).toBe(Btn.Dash | Btn.Right);
    tap('KeyD', 3000);
    tap('KeyD', 3000 + DOUBLE_TAP_MS + 10); // too slow
    expect(buttons()).toBe(0);
  });

  it('double taps go by direction, not by key: A then ← dashes left; the jet key never dashes', () => {
    const { s, buttons } = setup();
    s.doubleTapDash = true;
    tap('KeyA', 0);
    tap('ArrowLeft', 100);
    expect(buttons()).toBe(Btn.Dash | Btn.Left);
    tap('KeyW', 1000);
    tap('KeyW', 1100); // feathering the jetpack
    tap('Space', 1200);
    expect(buttons()).toBe(0);
    tap('KeyS', 2000);
    tap('ArrowDown', 2100);
    expect(buttons()).toBe(Btn.Dash | Btn.Down);
    tap('KeyA', 3000);
    tap('KeyD', 3100); // two directions: no dash
    expect(buttons()).toBe(0);
  });

  it('follows rebinding: dash and directions on other keys or a mouse button', () => {
    const { s, target, buttons } = setup();
    s.bindings = { keys: { KeyJ: Btn.Left, KeyC: Btn.Dash, KeyK: Btn.Jet }, mouse: { 0: Btn.Fire, 3: Btn.Dash }, slots: { KeyU: 2 } };
    s.doubleTapDash = true;
    tap('ShiftLeft', 0);
    expect(buttons()).toBe(0); // Shift is unbound now
    down('KeyK', 100);
    tap('KeyC', 110);
    expect(buttons()).toBe(Btn.Jet | Btn.Dash); // up-dash
    up('KeyK', 150);
    tap('KeyJ', 1000);
    tap('KeyJ', 1100);
    expect(buttons()).toBe(Btn.Dash | Btn.Left);
    fire(target, 'mousedown', { button: 3, timeStamp: 2000 });
    fire(window, 'mouseup', { button: 3, timeStamp: 2010 });
    expect(buttons()).toBe(Btn.Dash);
    down('KeyU', 3000);
    expect(s.sample(camera, 0, 0).weaponSelect).toBe(2);
  });

  it("Tab, Space and the arrows are the game's during play, the menus' while menus are up (keyboard navigation)", () => {
    // a window of its own: the other tests' samplers (never removed) listen on the shared one
    const shared = globalThis.window;
    const own = new EventTarget();
    Object.assign(globalThis, { window: own });
    const s = new InputSampler(new EventTarget() as HTMLElement);
    Object.assign(globalThis, { window: shared });
    const press = (code: string, extra: Record<string, unknown> = {}) => {
      const e = new Event('keydown', { cancelable: true });
      for (const [k, v] of Object.entries({ code, repeat: false, timeStamp: 0, ...extra })) Object.defineProperty(e, k, { value: v });
      own.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // playing: no focus moves, no scrolling
    expect(['Tab', 'Space', 'ArrowDown'].map((c) => press(c))).toEqual([true, true, true]);
    // an overlay (Settings, the in-match menu) is up
    s.blocked = true;
    expect(['Tab', 'Space', 'ArrowDown'].map((c) => press(c))).toEqual([false, false, false]);
    s.blocked = false;
    // focus on one of the shell's controls, or a menu screen showing (Home, the lobby, results)
    class FakeElement {
      constructor(readonly inShell: boolean) {}
      closest(sel: string) {
        return sel === '#shell' && this.inShell ? this : null;
      }
    }
    const doc = globalThis.document as unknown as { querySelector?: (q: string) => unknown };
    Object.assign(globalThis, { Element: FakeElement });
    try {
      expect(press('Tab', { target: new FakeElement(true) })).toBe(false);
      expect(press('Tab', { target: new FakeElement(false) })).toBe(true);
      doc.querySelector = (q: string) => (q.includes('.screen--menu') ? {} : null);
      expect(press('Tab')).toBe(false);
      expect(press('Space')).toBe(false);
    } finally {
      delete doc.querySelector;
      delete (globalThis as { Element?: unknown }).Element;
    }
    expect(press('Tab')).toBe(true);
  });

  it('dropping input (menus, blur) drops a latched dash too', () => {
    const { s, buttons } = setup();
    tap('ShiftLeft', 0);
    s.releaseAll();
    expect(buttons()).toBe(0);
    expect(DEFAULT_KEY_BINDINGS.keys.ShiftLeft).toBe(Btn.Dash);
  });
});
