/** Unlocking: the context is made on the first gesture, nudged with a silent sample, and resumed after interruptions. */
import { describe, expect, it } from 'vitest';
import { FakeContext } from './fakeContext.test-util';
import { createUnlocker } from './unlock';

function setup(start: FakeContext['state'] = 'suspended') {
  const target = new EventTarget();
  const ctx = new FakeContext();
  ctx.state = start;
  let made = 0;
  const seen: AudioContext[] = [];
  let hidden = false;
  const u = createUnlocker({
    target,
    create: () => {
      made++;
      return ctx.asAudioContext();
    },
    onContext: (c) => seen.push(c),
    hidden: () => hidden,
  });
  return { target, ctx, u, seen, made: () => made, hide: (h: boolean) => (hidden = h) };
}

const key = (k: string) => Object.assign(new Event('keydown'), { key: k });

describe('unlock', () => {
  it('nothing is made before a gesture', () => {
    const { made, u } = setup();
    expect(made()).toBe(0);
    expect(u.ctx).toBeNull();
  });

  it('the first tap makes the context once, plays a silent sample in it, and resumes it', async () => {
    const { target, ctx, u, seen, made } = setup();
    target.dispatchEvent(new Event('pointerdown'));
    target.dispatchEvent(new Event('pointerup'));
    expect(made()).toBe(1);
    expect(seen).toHaveLength(1);
    // the silent sample (iOS) started inside the gesture
    expect(ctx.started.length).toBeGreaterThanOrEqual(1);
    expect(ctx.started[0]!.buffer!.length).toBe(1);
    expect(ctx.resumes).toBeGreaterThanOrEqual(1);
    await Promise.resolve();
    expect(u.unlocked).toBe(true);
  });

  it('a modifier key alone isn\'t a gesture; a real key is', () => {
    const { target, made } = setup();
    target.dispatchEvent(key('Shift'));
    expect(made()).toBe(0);
    target.dispatchEvent(key('a'));
    expect(made()).toBe(1);
  });

  it('after an interruption (a call, Siri) the next gesture resumes it, but not while hidden', () => {
    const { target, ctx, hide } = setup('running');
    target.dispatchEvent(new Event('click'));
    const before = ctx.resumes;
    ctx.state = 'interrupted';
    hide(true);
    target.dispatchEvent(new Event('touchend'));
    expect(ctx.resumes).toBe(before);
    hide(false);
    target.dispatchEvent(new Event('touchend'));
    expect(ctx.resumes).toBe(before + 1);
    expect(ctx.state).toBe('running');
  });

  it('no Web Audio: it gives up quietly', () => {
    const target = new EventTarget();
    let tries = 0;
    createUnlocker({ target, create: () => (tries++, null), onContext: () => {} });
    target.dispatchEvent(new Event('click'));
    target.dispatchEvent(new Event('click'));
    expect(tries).toBe(1);
  });
});
