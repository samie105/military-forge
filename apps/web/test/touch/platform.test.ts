import { describe, expect, it, vi } from 'vitest';
import { BackToPause, EDGE_BAND, WakeLockKeeper, canVibrate, inEdgeBand } from '../../src/touch/platform';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the phone platform around a match (spec §4.9)', () => {
  it('the iOS edge band: 24 px at either physical side, nothing in between', () => {
    expect(EDGE_BAND).toBe(24);
    expect(inEdgeBand(0, 812)).toBe(true);
    expect(inEdgeBand(24, 812)).toBe(true);
    expect(inEdgeBand(25, 812)).toBe(false);
    expect(inEdgeBand(400, 812)).toBe(false);
    expect(inEdgeBand(787, 812)).toBe(false);
    expect(inEdgeBand(788, 812)).toBe(true);
  });

  it('haptic settings only where the phone can buzz (iOS Safari has no Vibration API)', () => {
    expect(canVibrate({ vibrate: () => true })).toBe(true);
    expect(canVibrate({})).toBe(false);
    expect(canVibrate(undefined)).toBe(false);
  });

  it('the wake lock: asked for once in play, again when the page comes back, let go after', async () => {
    const sentinels: { released: boolean; release: () => Promise<void> }[] = [];
    const request = vi.fn(async () => {
      const s = { released: false, release: async () => void (s.released = true) };
      sentinels.push(s);
      return s;
    });
    const keep = new WakeLockKeeper({ request });
    keep.want(true);
    keep.want(true); // a second tap while asking: one request
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(keep.held).toBe(true);
    // hidden: the browser drops it; visible again: asked again
    sentinels[0]!.released = true;
    keep.visible();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(keep.held).toBe(true);
    keep.want(false);
    expect(sentinels[1]!.released).toBe(true);
    expect(keep.held).toBe(false);
    keep.visible(); // not wanted: no request
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('the wake lock refused, or no API: play goes on', async () => {
    const request = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
    const keep = new WakeLockKeeper({ request });
    keep.want(true);
    await flush();
    expect(keep.held).toBe(false);
    // taps right after a refusal don't ask again; the page coming back does
    keep.want(true);
    keep.want(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    keep.visible();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    const none = new WakeLockKeeper(undefined);
    expect(() => none.want(true)).not.toThrow();
  });

  it('a back gesture in play pauses, once per arming; out of play it is the browser\'s', () => {
    const made: { onclose: ((e: Event) => void) | null; destroyed: boolean; destroy(): void }[] = [];
    class FakeWatcher {
      onclose: ((e: Event) => void) | null = null;
      destroyed = false;
      constructor() {
        made.push(this);
      }
      destroy(): void {
        this.destroyed = true;
      }
    }
    const paused = vi.fn();
    const back = new BackToPause(paused, FakeWatcher);
    back.arm(true);
    back.arm(true); // armed already: no second watcher
    expect(made).toHaveLength(1);
    made[0]!.onclose!(new Event('close'));
    expect(paused).toHaveBeenCalledTimes(1);
    expect(back.armed).toBe(false); // used up
    back.arm(true);
    expect(made).toHaveLength(2);
    back.arm(false);
    expect(made[1]!.destroyed).toBe(true);
    // no CloseWatcher (iOS): nothing armed, nothing thrown
    const none = new BackToPause(paused, undefined);
    none.arm(true);
    expect(none.armed).toBe(false);
  });
});
