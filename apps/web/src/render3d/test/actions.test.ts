import { describe, expect, it } from 'vitest';
import { ACTIONS, actionTime, reloadClip } from '../actions';
import { DEATH, collapseAt, deathSeconds, type CollapsePose } from '../death';

describe('actionTime: a clip fitted to its time', () => {
  it('starts at the clip’s start and ends at its end, whatever the time', () => {
    for (const [duration, seconds] of [
      [1.6, 2],
      [1.6, 1.2],
      [1, 2],
      [1, 4.25],
      [0.6, 0.6],
    ] as const) {
      expect(actionTime(0, duration, seconds)).toBeCloseTo(0, 9);
      expect(actionTime(seconds, duration, seconds)).toBeCloseTo(duration, 6);
    }
  });

  it('fits by speed within its rates (a K-47 reload: the 1.6 s clip over 2 s at 0.8×)', () => {
    expect(actionTime(1, 1.6, 2)).toBeCloseTo(0.8, 9);
    // too short a time: the clip plays at its fastest and is cut short
    expect(actionTime(0.5, 1.6, 0.5)).toBeCloseTo(0.5 * ACTIONS.maxRate, 9);
  });

  it('a long reload plays the ends at speed and goes back and forth through the middle, without a jump', () => {
    const duration = 1;
    const seconds = 4.25; // a 4.25 s reload (the Shredder's) on a 1 s clip: far slower than minRate
    let last = 0;
    let turns = 0;
    let dir = 1;
    for (let t = 1 / 60; t <= seconds + 1e-9; t += 1 / 60) {
      const c = actionTime(t, duration, seconds);
      const step = c - last;
      expect(Math.abs(step), `t ${t.toFixed(3)}`).toBeLessThan((1 / 60) * 1.6); // never faster than ~1.6×
      if (Math.sign(step) !== dir && Math.abs(step) > 1e-9) {
        turns++;
        dir = Math.sign(step);
      }
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(duration);
      last = c;
    }
    expect(turns).toBeGreaterThanOrEqual(2); // back and forth through the middle, leaving forwards
  });

  it('picks the two-handed reload for two-handed guns', () => {
    expect(reloadClip(2)).toBe('reload_rifle');
    expect(reloadClip(1)).toBe('reload_pistol');
  });
});

describe('the death beat', () => {
  const at = (t: number) => collapseAt(t, {} as CollapsePose);

  it('knees first, then the torso, the head trailing; whole until the fade; gone by 0.65 s', () => {
    expect(at(0.1).kneel).toBeGreaterThan(at(0.1).slump);
    expect(at(0.2).slump).toBeGreaterThan(at(0.2).head);
    expect(at(DEATH.collapse).kneel).toBeCloseTo(1, 1);
    expect(at(DEATH.collapse - 1e-3).fade).toBe(0);
    expect(at(DEATH.collapse + DEATH.fade).fade).toBe(1);
    expect(deathSeconds('collapse')).toBeLessThanOrEqual(0.7);
    expect(deathSeconds('vanish')).toBe(0);
  });

  it('settles: dips a little past and comes back, smoothly', () => {
    let peak = 0;
    let last = at(0);
    for (let t = 1 / 60; t <= DEATH.collapse + 1e-9; t += 1 / 60) {
      const c = at(t);
      peak = Math.max(peak, c.slump);
      for (const k of ['kneel', 'slump', 'head', 'arms'] as const) expect(Math.abs(c[k] - last[k]), `${k} at ${t.toFixed(3)}`).toBeLessThan(0.2);
      last = c;
    }
    expect(peak).toBeGreaterThan(1.03);
    expect(at(DEATH.collapse).slump).toBeCloseTo(1, 6);
  });
});
