/**
 * Unlocking: the context is made on the first gesture, nudged with a silent sample, and kept going:
 * resumed on every gesture and on coming back to the page, after the system interrupts it, and
 * restarted when its clock stops while it says it runs.
 */
import { describe, expect, it } from 'vitest';
import { FakeContext } from './fakeContext.test-util';
import { createUnlocker, WATCH_MS, type AudioHealth, type UnlockOptions } from './unlock';

function setup(start: FakeContext['state'] = 'suspended', over: Partial<UnlockOptions> = {}) {
  const target = new EventTarget();
  const doc = new EventTarget();
  const ctx = new FakeContext();
  ctx.state = start;
  let made = 0;
  const seen: AudioContext[] = [];
  let hidden = false;
  let wall = 0;
  const health: AudioHealth[] = [];
  const log: string[] = [];
  let watching = 0;
  const u = createUnlocker({
    target,
    doc,
    create: () => {
      made++;
      return ctx.asAudioContext();
    },
    onContext: (c) => seen.push(c),
    hidden: () => hidden,
    trusted: (e) => !(e as Event & { synthetic?: boolean }).synthetic,
    clock: () => wall,
    every: () => {
      watching++;
      return () => watching--;
    },
    onHealth: (h) => health.push(h),
    log: (l) => log.push(l),
    ...over,
  });
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  /** time passes: the wall clock always, the audio clock only if `audio` */
  const pass = (ms: number, audio = true) => {
    wall += ms;
    if (audio) ctx.currentTime += ms / 1000;
  };
  return { target, doc, ctx, u, seen, made: () => made, hide: (h: boolean) => (hidden = h), health, log, settle, pass, watching: () => watching };
}

const key = (k: string) => Object.assign(new Event('keydown'), { key: k });
const synthetic = (type: string) => Object.assign(new Event(type), { synthetic: true });

describe('the first gesture', () => {
  it('nothing is made before a gesture, and coming back to the page makes nothing either', () => {
    const { made, u, target, doc } = setup();
    target.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(made()).toBe(0);
    expect(u.ctx).toBeNull();
    expect(u.health).toBe('none');
  });

  it('the first tap makes the context once, plays a silent sample in it, and resumes it', async () => {
    const { target, ctx, u, seen, made, settle, watching } = setup();
    target.dispatchEvent(new Event('pointerdown'));
    target.dispatchEvent(new Event('pointerup'));
    expect(made()).toBe(1);
    expect(seen).toHaveLength(1);
    // the silent sample (iOS) started inside the gesture
    expect(ctx.started.length).toBeGreaterThanOrEqual(1);
    expect(ctx.started[0]!.buffer!.length).toBe(1);
    expect(ctx.resumes).toBeGreaterThanOrEqual(1);
    await settle();
    expect(u.unlocked).toBe(true);
    expect(u.health).toBe('running');
    // the clock's watchdog runs once there's a context
    expect(watching()).toBe(1);
  });

  it('a phone: the finger landing isn\'t enough for the browser, its lift is, and every gesture tries again', async () => {
    const { target, ctx, u, settle, health } = setup();
    ctx.refuseResume = true;
    target.dispatchEvent(new Event('pointerdown'));
    target.dispatchEvent(new Event('touchstart'));
    await settle();
    expect(u.health).toBe('starting');
    expect(ctx.state).toBe('suspended');
    const tries = ctx.resumes;
    ctx.refuseResume = false;
    target.dispatchEvent(new Event('pointerup'));
    await settle();
    expect(ctx.resumes).toBe(tries + 1);
    expect(u.health).toBe('running');
    expect(health).toEqual(['starting', 'running']);
  });

  it('a script\'s event (the pause key the touch controls send) is no gesture; a modifier key alone isn\'t either', () => {
    const { target, made } = setup();
    target.dispatchEvent(synthetic('keydown'));
    target.dispatchEvent(synthetic('pointerup'));
    target.dispatchEvent(key('Shift'));
    expect(made()).toBe(0);
    target.dispatchEvent(key('a'));
    expect(made()).toBe(1);
  });

  it('heard in the capture phase, before the page\'s own listeners (which could use the gesture up)', () => {
    const order: string[] = [];
    const { target } = setup('suspended', { onContext: () => order.push('audio') });
    // a listener armed after the unlocker, like the full-screen request on a finger lift
    target.addEventListener('pointerup', () => order.push('page'), { capture: true });
    target.dispatchEvent(new Event('pointerup'));
    expect(order).toEqual(['audio', 'page']);
  });

  it('no Web Audio: it gives up quietly', () => {
    const target = new EventTarget();
    let tries = 0;
    createUnlocker({ target, create: () => (tries++, null), onContext: () => {}, trusted: () => true });
    target.dispatchEvent(new Event('click'));
    target.dispatchEvent(new Event('click'));
    expect(tries).toBe(1);
  });
});

describe('keeping it going', () => {
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

  it('the system suspends it while the page is in view: resumed at once, no gesture needed', async () => {
    const { target, ctx, u, settle } = setup('running');
    target.dispatchEvent(new Event('pointerup'));
    await settle();
    const before = ctx.resumes;
    ctx.setState('interrupted');
    expect(u.health).toBe('interrupted');
    await settle();
    expect(ctx.resumes).toBe(before + 1);
    expect(u.health).toBe('running');
  });

  it('suspended for a hidden tab: left alone until the page is back (visibilitychange, pageshow or focus)', async () => {
    const { target, doc, ctx, u, hide, settle } = setup('running');
    target.dispatchEvent(new Event('pointerup'));
    await settle();
    hide(true);
    ctx.setState('suspended'); // the engine's hidden-tab pause
    await settle();
    const before = ctx.resumes;
    expect(u.health).toBe('suspended');
    let backs = 0;
    for (const [where, type] of [
      [doc, 'visibilitychange'],
      [target, 'pageshow'],
      [target, 'focus'],
    ] as const) {
      hide(true);
      ctx.state = 'suspended';
      where.dispatchEvent(new Event(type));
      expect(ctx.resumes).toBe(before + backs);
      hide(false);
      where.dispatchEvent(new Event(type));
      backs++;
      await settle();
      expect(ctx.state).toBe('running');
    }
    expect(ctx.resumes).toBe(before + 3);
    expect(u.health).toBe('running');
  });

  it('a resume the browser refuses waits for the next gesture, and says why in the log', async () => {
    const { target, ctx, u, settle, log } = setup('running');
    target.dispatchEvent(new Event('pointerup'));
    await settle();
    ctx.refuseResume = true;
    ctx.setState('suspended');
    await settle();
    expect(u.health).toBe('suspended');
    expect(log.some((l) => l.includes('refused'))).toBe(true);
    ctx.refuseResume = false;
    target.dispatchEvent(new Event('touchend'));
    await settle();
    expect(u.health).toBe('running');
  });
});

describe('a clock that stopped', () => {
  it('"running" with a clock that doesn\'t move is stalled, and the output is restarted (suspend, resume)', async () => {
    const { target, ctx, u, settle, pass, health } = setup('running');
    target.dispatchEvent(new Event('pointerup'));
    await settle();
    // a healthy clock: nothing happens
    for (let i = 0; i < 4; i++) {
      pass(WATCH_MS);
      u.check();
    }
    expect(u.health).toBe('running');
    expect(ctx.suspends).toBe(0);
    // the output stops: the wall clock moves, the audio clock doesn't
    for (let i = 0; i < 3; i++) {
      pass(WATCH_MS, false);
      u.check();
    }
    expect(health).toContain('stalled');
    await settle();
    expect(ctx.suspends).toBe(1);
    expect(ctx.state).toBe('running');
    // the clock moves again: running
    for (let i = 0; i < 3; i++) {
      pass(WATCH_MS);
      u.check();
    }
    expect(u.health).toBe('running');
  });

  it('restarts at most every few seconds by itself; a gesture may try sooner', async () => {
    const { target, ctx, u, settle, pass } = setup('running');
    target.dispatchEvent(new Event('pointerup'));
    await settle();
    const stall = (n: number) => {
      for (let i = 0; i < n; i++) {
        pass(WATCH_MS, false);
        u.check();
      }
    };
    stall(3);
    await settle();
    expect(ctx.suspends).toBe(1);
    stall(3); // 1.5 s later: still stopped, too soon for another restart
    await settle();
    expect(u.health).toBe('stalled');
    expect(ctx.suspends).toBe(1);
    target.dispatchEvent(new Event('pointerup')); // the player taps: try now
    await settle();
    expect(ctx.suspends).toBe(2);
  });

  it('a hidden page isn\'t watched (its timers and clock may sleep)', () => {
    const { target, ctx, u, pass, hide } = setup('running');
    target.dispatchEvent(new Event('pointerup'));
    hide(true);
    for (let i = 0; i < 6; i++) {
      pass(WATCH_MS, false);
      u.check();
    }
    expect(u.health).not.toBe('stalled');
    expect(ctx.suspends).toBe(0);
  });
});
