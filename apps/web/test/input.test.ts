/**
 * InputSampler: rebindable keys and mouse buttons, the dash latch (a tap shorter than a tick still
 * dashes, with the direction held) and double-tap dash (left, right, down; never the jet key).
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

  it('double-tap dash is off until the setting turns it on', () => {
    const { s, buttons } = setup();
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

  it('dropping input (menus, blur) drops a latched dash too', () => {
    const { s, buttons } = setup();
    tap('ShiftLeft', 0);
    s.releaseAll();
    expect(buttons()).toBe(0);
    expect(DEFAULT_KEY_BINDINGS.keys.ShiftLeft).toBe(Btn.Dash);
  });
});
