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
let typingInto: (target: EventTarget | null) => boolean;
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
  ({ InputSampler, DOUBLE_TAP_MS, DEFAULT_KEY_BINDINGS, typingInto } = await import('../src/input'));
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

  // the taps themselves reach the sim for a tick now (latched presses, audit 28 Oct): these check the dash
  it('double-tap dash is on by default (the owner\'s call); the setting turns it off (the taps still step: latched)', () => {
    const { s, buttons } = setup();
    expect(s.doubleTapDash).toBe(true);
    s.doubleTapDash = false;
    tap('KeyD', 0);
    tap('KeyD', 100);
    expect(buttons()).toBe(Btn.Right);
    s.doubleTapDash = true;
    tap('KeyD', 1000);
    tap('KeyD', 1000 + DOUBLE_TAP_MS - 40);
    expect(buttons()).toBe(Btn.Dash | Btn.Right);
    tap('KeyD', 3000);
    tap('KeyD', 3000 + DOUBLE_TAP_MS + 10); // too slow
    expect(buttons()).toBe(Btn.Right);
  });

  it('double taps go by direction, not by key: A then ← dashes left; the jet key never dashes (taps latched)', () => {
    const { s, buttons } = setup();
    s.doubleTapDash = true;
    tap('KeyA', 0);
    tap('ArrowLeft', 100);
    expect(buttons()).toBe(Btn.Dash | Btn.Left);
    tap('KeyW', 1000);
    tap('KeyW', 1100); // feathering the jetpack
    tap('Space', 1200);
    expect(buttons()).toBe(Btn.Jet);
    tap('KeyS', 2000);
    tap('ArrowDown', 2100);
    expect(buttons()).toBe(Btn.Dash | Btn.Down);
    tap('KeyA', 3000);
    tap('KeyD', 3100); // two directions: no dash
    expect(buttons()).toBe(Btn.Left | Btn.Right);
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

  it('a field being typed in keeps its keys; a read-only box, a checkbox or a slider leaves them to the game', () => {
    const make = (cls: new () => object, fields: Record<string, unknown>) => Object.assign(new cls(), fields) as unknown as EventTarget;
    const Input = globalThis.HTMLInputElement as unknown as new () => object;
    const TextArea = globalThis.HTMLTextAreaElement as unknown as new () => object;
    const Select = globalThis.HTMLSelectElement as unknown as new () => object;
    expect(typingInto(make(Input, { type: 'text', readOnly: false }))).toBe(true);
    expect(typingInto(make(Input, { type: 'number', readOnly: false }))).toBe(true);
    expect(typingInto(make(Input, { type: 'checkbox', readOnly: false }))).toBe(false);
    expect(typingInto(make(Input, { type: 'range', readOnly: false }))).toBe(false);
    expect(typingInto(make(TextArea, { readOnly: false }))).toBe(true);
    expect(typingInto(make(TextArea, { readOnly: true }))).toBe(false);
    expect(typingInto(make(Select, {}))).toBe(true);
    expect(typingInto(null)).toBe(false);
    // the tuning panel's Copy values box (read-only, focused for Ctrl+C): W still jets
    const { s, buttons } = setup();
    fire(window, 'keydown', { code: 'KeyW', repeat: false, timeStamp: 0, target: make(TextArea, { readOnly: true }) });
    expect(buttons() & Btn.Jet).toBe(Btn.Jet);
    fire(window, 'keyup', { code: 'KeyW', repeat: false, timeStamp: 10 });
    // typing a value: not the game's
    fire(window, 'keydown', { code: 'KeyW', repeat: false, timeStamp: 20, target: make(Input, { type: 'text', readOnly: false }) });
    expect(buttons() & Btn.Jet).toBe(0);
    s.releaseAll();
  });

  it('a quick tap between two samples still reaches the sim for one tick: R, 1, 2, a click (audit 28 Oct)', () => {
    const { s, target, buttons } = setup();
    tap('KeyR', 0);
    expect(buttons()).toBe(Btn.Reload);
    expect(buttons()).toBe(0); // one sample only
    tap('Digit2', 100);
    expect(s.sample(camera, 0, 0).weaponSelect).toBe(2);
    expect(s.sample(camera, 0, 0).weaponSelect).toBe(0);
    tap('Digit1', 200);
    expect(s.sample(camera, 0, 0).weaponSelect).toBe(1);
    fire(target, 'mousedown', { button: 0, timeStamp: 300 });
    fire(window, 'mouseup', { button: 0, timeStamp: 305 });
    expect(buttons()).toBe(Btn.Fire);
    expect(buttons()).toBe(0);
  });

  it('held keys are unchanged by the latch: held, they stay; let go after a sample, they stop', () => {
    const { buttons } = setup();
    down('KeyR', 0);
    expect(buttons()).toBe(Btn.Reload);
    expect(buttons()).toBe(Btn.Reload);
    up('KeyR', 40);
    expect(buttons()).toBe(0);
    down('Digit1', 100);
    down('KeyD', 100);
    expect(buttons()).toBe(Btn.Right);
    expect(buttons()).toBe(Btn.Right);
  });

  it('presses while the menus hold the input never fire once they close', () => {
    const { s, buttons } = setup();
    s.blocked = true;
    tap('KeyR', 0);
    s.blocked = false;
    expect(buttons()).toBe(0);
    tap('KeyR', 100);
    s.releaseAll();
    expect(buttons()).toBe(0);
  });

  it('dropping input (menus, blur) drops a latched dash too', () => {
    const { s, buttons } = setup();
    tap('ShiftLeft', 0);
    s.releaseAll();
    expect(buttons()).toBe(0);
    expect(DEFAULT_KEY_BINDINGS.keys.ShiftLeft).toBe(Btn.Dash);
  });
});
