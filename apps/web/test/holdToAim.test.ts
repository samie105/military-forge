import { Btn, createInput } from '@military-forge/sim';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Camera } from '../src/camera';
import { DEFAULT_KEY_BINDINGS, InputSampler, QUICK_THROW, TAP_MS, THROW_FAR, THROW_NEAR, ThrowLatch, throwStrengthAt } from '../src/input';

type Handler = (e: Record<string, unknown>) => void;
const handlers = new Map<string, Handler[]>();
const on = (type: string, f: Handler) => handlers.set(type, [...(handlers.get(type) ?? []), f]);
const fire = (type: string, e: Record<string, unknown> = {}) => {
  for (const f of handlers.get(type) ?? []) f({ repeat: false, target: null, timeStamp: 0, preventDefault: () => {}, ...e });
};

// the sampler listens on window, document and its canvas: minimal stand-ins (no DOM in these tests)
beforeAll(() => {
  vi.stubGlobal('window', { addEventListener: on });
  vi.stubGlobal('document', { addEventListener: () => {}, hasFocus: () => true, hidden: false });
  vi.stubGlobal('HTMLInputElement', class {});
  vi.stubGlobal('HTMLTextAreaElement', class {});
  vi.stubGlobal('HTMLSelectElement', class {});
});
afterAll(() => vi.unstubAllGlobals());
const clock = vi.spyOn(performance, 'now');

/** 10 px per metre, y up, origin at the top left */
const camera = { toWorldX: (x: number) => x / 10, toWorldY: (y: number) => -y / 10 } as unknown as Camera;

function sampler() {
  handlers.clear();
  const canvas = { addEventListener: (t: string, f: Handler) => on(`canvas:${t}`, f), isConnected: true };
  const s = new InputSampler(canvas as unknown as HTMLElement);
  /** the cursor `d` m right of the shoulder at the origin */
  const cursor = (d: number) => fire('canvas:mousemove', { offsetX: d * 10, offsetY: 0 });
  /** one sample at `now` ms */
  const sample = (now: number) => {
    const out = s.sample(camera, 0, 0, createInput(), now);
    return { grenade: (out.buttons & Btn.Grenade) !== 0, strength: out.throwStrength, arc: s.throwAim };
  };
  /** the key at `at` ms on the sample clock (performance.now) */
  const key = (type: 'keydown' | 'keyup', at: number) => {
    clock.mockReturnValue(at);
    fire(type, { code: 'KeyG', timeStamp: at });
  };
  return { s, cursor, sample, key };
}

describe('throw strength by cursor distance', () => {
  it('70 % up to THROW_NEAR, full from THROW_FAR, in the input’s 8 steps', () => {
    expect(throwStrengthAt(0)).toBe(0);
    expect(throwStrengthAt(THROW_NEAR)).toBe(0);
    expect(throwStrengthAt((THROW_NEAR + THROW_FAR) / 2)).toBe(4);
    expect(throwStrengthAt(THROW_FAR)).toBe(7);
    expect(throwStrengthAt(40)).toBe(7);
  });
});

describe('the grenade key: tap to throw, hold to aim (the default; owner, 18 Oct)', () => {
  it('a tap is a quick throw at 70 % on the release, with no arc', () => {
    const { cursor, sample, key } = sampler();
    cursor(9);
    key('keydown', 1000);
    expect(sample(1016)).toEqual({ grenade: false, strength: 7, arc: -1 }); // held: nothing yet, no arc
    key('keyup', 1000 + TAP_MS - 20);
    expect(sample(1150)).toEqual({ grenade: true, strength: QUICK_THROW, arc: -1 });
    expect(sample(1166).grenade).toBe(false); // once
  });

  it('a hold shows the arc with the cursor’s strength and throws on release, once', () => {
    const { cursor, sample, key } = sampler();
    cursor(6);
    key('keydown', 1000);
    expect(sample(1000 + TAP_MS + 10)).toEqual({ grenade: false, strength: 7, arc: throwStrengthAt(6) });
    cursor(12);
    expect(sample(1300)).toEqual({ grenade: false, strength: 7, arc: 7 });
    key('keyup', 1310);
    expect(sample(1316)).toEqual({ grenade: true, strength: 7, arc: -1 });
    expect(sample(1332).grenade).toBe(false);
  });

  it('a tap shorter than a tick still throws', () => {
    const { sample, key } = sampler();
    key('keydown', 1000);
    key('keyup', 1004);
    expect(sample(1010)).toEqual({ grenade: true, strength: QUICK_THROW, arc: -1 });
  });

  it('losing focus while aiming cancels the throw', () => {
    const { s, cursor, sample, key } = sampler();
    cursor(6);
    key('keydown', 1000);
    sample(1300);
    s.releaseAll();
    key('keyup', 1310); // the key was already let go with the focus
    expect(sample(1316)).toEqual({ grenade: false, strength: 7, arc: -1 });
  });

  it('with hold-to-aim off (a setting) every press is a quick throw, and the arc goes away', () => {
    const { s, cursor, sample, key } = sampler();
    cursor(6);
    key('keydown', 1000);
    expect(sample(1300).arc).toBe(throwStrengthAt(6));
    s.holdToAim = false; // switched off mid-aim: no arc left behind
    expect(s.throwAim).toBe(-1);
    key('keyup', 1310);
    expect(sample(1316).grenade).toBe(false);
    key('keydown', 2000);
    expect(sample(2001)).toEqual({ grenade: true, strength: QUICK_THROW, arc: -1 }); // on the press
  });
});

describe('the grenade bound to a mouse button (Controls settings)', () => {
  it('holds and throws the same way', () => {
    const { s, cursor, sample } = sampler();
    s.bindings = { ...DEFAULT_KEY_BINDINGS, mouse: { ...DEFAULT_KEY_BINDINGS.mouse, 3: Btn.Grenade } };
    cursor(12);
    clock.mockReturnValue(1000);
    fire('canvas:mousedown', { button: 3 });
    expect(sample(1300)).toEqual({ grenade: false, strength: 7, arc: 7 });
    clock.mockReturnValue(1310);
    fire('mouseup', { button: 3 });
    expect(sample(1316)).toEqual({ grenade: true, strength: 7, arc: -1 });
  });
});

describe('ThrowLatch (shared by the G key and the touch button)', () => {
  it('the touch hold: the stick’s push is the strength, lifting throws it', () => {
    const latch = new ThrowLatch();
    latch.press(0);
    latch.aimWith(5, 100);
    expect(latch.aim).toBe(-1); // still a tap
    latch.aimWith(6, 200);
    expect(latch.aim).toBe(6);
    latch.release(260);
    const out = createInput();
    latch.take(out);
    expect([out.buttons & Btn.Grenade, out.throwStrength]).toEqual([Btn.Grenade, 6]);
    latch.press(1000);
    latch.cancel(); // dragged off the screen
    const none = createInput();
    latch.take(none);
    expect(none.buttons & Btn.Grenade).toBe(0);
  });
});
