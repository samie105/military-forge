/** The shared aim-assist core (input/assist.ts) and sight (input/sight.ts): controls spec §4.5, §5.4. */
import { describe, expect, it } from 'vitest';
import { ASSIST, AimAssist, inCone, nearestTarget, onTarget, pickTarget, projectedMiss, rangeFalloff, type AssistInput, type AssistTarget } from '../../src/input/assist';
import { Sight, segmentDistance } from '../../src/input/sight';

const DEG = Math.PI / 180;
/** A target `dist` m out along `deg` from the origin. */
const at = (id: number, dist: number, deg: number): AssistTarget => ({ id, x: Math.cos(deg * DEG) * dist, y: Math.sin(deg * DEG) * dist });
const base = (over: Partial<AssistInput>): AssistInput => ({ level: 'standard', current: 0, desired: 0, stick: 1, pullMinPush: 0.5, sx: 0, sy: 0, range: 30, targets: [], ...over });

describe('magnetism (Standard)', () => {
  it('a target at 10 m, the stick 3° off: the aim moves toward it, at most 3° a tick', () => {
    const a = new AimAssist();
    const t = at(1, 10, 3);
    const aim = a.step(base({ targets: [t] }));
    expect(aim).toBeGreaterThan(0);
    expect(aim).toBeLessThanOrEqual(3 * DEG + 1e-9);
    // 25% of the error per tick
    expect(aim).toBeCloseTo(0.75 * DEG, 6);
    expect(a.target).toBe(1);
  });

  it('never more than 3° a tick, however far off the target is', () => {
    const a = new AimAssist();
    // 20° off at 3 m: the projected miss (1.04 m) is outside the cone; at 10° (0.52 m) it's in
    expect(a.step(base({ targets: [at(1, 3, 20)] }))).toBe(0);
    const aim = a.step(base({ targets: [at(1, 3, 10)] }));
    expect(aim).toBeCloseTo(2.5 * DEG, 6);
    const far = new AimAssist().step(base({ targets: [at(1, 2, 18)] })); // 0.63 m miss: in; 25% of 18° = 4.5° → capped
    expect(far).toBeCloseTo(3 * DEG, 6);
  });

  it('no pull with the stick let go, or pushed under the threshold', () => {
    const t = at(1, 10, 3);
    expect(new AimAssist().step(base({ targets: [t], stick: 0 }))).toBe(0);
    expect(new AimAssist().step(base({ targets: [t], stick: 0.4 }))).toBe(0);
  });

  it('fades with range: full to 0.7 × the weapon’s range, nothing past 0.9 ×', () => {
    expect(rangeFalloff(10, 30)).toBe(1);
    expect(rangeFalloff(21, 30)).toBe(1);
    expect(rangeFalloff(24, 30)).toBeCloseTo(0.5);
    expect(rangeFalloff(27, 30)).toBe(0);
    expect(rangeFalloff(5, 0)).toBe(0);
    const near = new AimAssist().step(base({ targets: [at(1, 20, 1)] }));
    const mid = new AimAssist().step(base({ targets: [at(1, 24, 1)] }));
    expect(mid).toBeCloseTo(near / 2, 6);
    expect(new AimAssist().step(base({ targets: [at(1, 28, 1)] }))).toBe(0); // out of reach
  });

  it('never over 40 m, whatever the gun', () => {
    expect(new AimAssist().step(base({ range: 100, targets: [at(1, 45, 1)] }))).toBe(0);
  });

  it('the cone is tested after projecting the stick out to the target [C12]', () => {
    // up close a wide angle still counts; far away the same angle doesn't
    expect(inCone(projectedMiss(0, 0, 0, 2 * Math.cos(15 * DEG), 2 * Math.sin(15 * DEG)).miss, 15 * DEG)).toBe(true);
    const far = projectedMiss(0, 0, 0, 35 * Math.cos(5 * DEG), 35 * Math.sin(5 * DEG));
    expect(inCone(far.miss, far.err)).toBe(false);
    // within 2.5° always counts
    const tiny = projectedMiss(0, 0, 0, 39 * Math.cos(2 * DEG), 39 * Math.sin(2 * DEG));
    expect(inCone(tiny.miss, tiny.err)).toBe(true);
    // behind you never counts
    expect(projectedMiss(0, 0, 0, -5, 0).miss).toBe(Infinity);
  });

  it('picks the smallest miss and keeps its target unless another is 30% better', () => {
    const a = at(1, 10, 2);
    const b = at(2, 10, -1.8);
    expect(pickTarget(0, 0, 0, [a, b], 30, null)?.target.id).toBe(2);
    expect(pickTarget(0, 0, 0, [a, b], 30, 1)?.target.id).toBe(1); // b only 10% better: stay on a
    const c = at(3, 10, 0.5);
    expect(pickTarget(0, 0, 0, [a, c], 30, 1)?.target.id).toBe(3); // c is 4× better: switch
  });
});

describe('the levels', () => {
  const t = at(1, 10, 3);

  it('Off: the aim is the device’s own', () => {
    expect(new AimAssist().step(base({ level: 'off', desired: 0.2, targets: [t] }))).toBe(0.2);
  });

  it('Light: friction on a target (0.45× of the stick’s turn), no pull', () => {
    const a = new AimAssist();
    // on the target, the stick turning 10° away: the aim takes 45% of it
    expect(a.step(base({ level: 'light', current: 3 * DEG, desired: 13 * DEG, targets: [t] }))).toBeCloseTo(3 * DEG + 0.45 * 10 * DEG, 6);
    // off the target, nothing
    expect(a.step(base({ level: 'light', current: 40 * DEG, desired: 50 * DEG, targets: [t] }))).toBeCloseTo(50 * DEG, 6);
    // near a target but not on it: no pull
    expect(a.step(base({ level: 'light', current: 0, desired: 0, targets: [at(1, 10, 6)] }))).toBe(0);
  });

  it('Strong: with the stick let go the aim stays on the chosen target as it moves', () => {
    const a = new AimAssist();
    a.step(base({ level: 'strong', targets: [at(7, 10, 3)] })); // chosen while aiming
    let aim = 0.75 * DEG;
    for (let i = 0; i < 12; i++) aim = a.step(base({ level: 'strong', current: aim, desired: aim, stick: 0, targets: [at(7, 10, 8)] }));
    expect(aim).toBeCloseTo(8 * DEG, 3);
    expect(a.target).toBe(7);
    // out of sight (not in the list): the lock lets go
    expect(a.step(base({ level: 'strong', current: aim, desired: aim, stick: 0, targets: [] }))).toBe(aim);
    expect(a.target).toBeNull();
  });

  it('Strong + auto-acquire (One-stick): takes the nearest target in reach', () => {
    const a = new AimAssist();
    const aim = a.step(base({ level: 'strong', stick: 0, autoAcquire: true, targets: [at(1, 20, 90), at(2, 8, 40)] }));
    expect(a.target).toBe(2);
    expect(aim).toBeGreaterThan(0);
    expect(nearestTarget(0, 0, [at(1, 50, 0)], 30)).toBeNull();
  });

  it('Standard forgets its target when the stick is let go', () => {
    const a = new AimAssist();
    a.step(base({ targets: [t] }));
    a.step(base({ stick: 0, targets: [t] }));
    expect(a.target).toBeNull();
  });
});

describe('auto-fire’s test', () => {
  it('fires when the projected miss is within a body’s half-width, out to 0.8 × range', () => {
    expect(onTarget(0, 0, 0, [at(1, 10, 2)], 30)).toBe(true); // 0.35 m
    expect(onTarget(0, 0, 0, [at(1, 10, 4)], 30)).toBe(false); // 0.70 m
    expect(onTarget(0, 0, 0, [at(1, 23, 0.5)], 30)).toBe(true); // 23 ≤ 24
    expect(onTarget(0, 0, 0, [at(1, 25, 0.5)], 30)).toBe(false);
    // a 48 m rifle reaches past today's fixed 22 m (but never past 40 m)
    expect(onTarget(0, 0, 0, [at(1, 35, 0.3)], 48)).toBe(true);
    expect(onTarget(0, 0, 0, [at(1, 41, 0.3)], 60)).toBe(false);
  });

  it('ASSIST numbers are the spec’s', () => {
    expect(ASSIST.pullFrac).toBe(0.25);
    expect(ASSIST.pullMaxDeg).toBe(3);
    expect(ASSIST.bodyHalf + ASSIST.slack).toBeCloseTo(0.8);
    expect(ASSIST.minConeDeg).toBe(2.5);
    expect([ASSIST.rangeFull, ASSIST.rangeZero, ASSIST.maxRange, ASSIST.sticky]).toEqual([0.7, 0.9, 40, 1.3]);
  });
});

describe('sight', () => {
  it('smoke across the line hides a target; beside it doesn’t', () => {
    const s = new Sight();
    const players = [
      { id: 0, alive: true, x: 0, y: 0 },
      { id: 1, alive: true, x: 10, y: -0.7 },
      { id: 2, alive: false, x: 5, y: 0 },
    ];
    expect(s.targets(players, 0, 0, 0).map((t) => t.id)).toEqual([1]);
    expect(s.targets(players, 0, 0, 0, [{ x: 5, y: 0, opaque: 1.5 }])).toEqual([]);
    expect(s.targets(players, 0, 0, 0, [{ x: 5, y: 4, opaque: 1.5 }]).map((t) => t.id)).toEqual([1]);
    expect(s.targets(players, 0, 0, 0, [{ x: 5, y: 0, opaque: 0 }]).map((t) => t.id)).toEqual([1]); // thinned out: see-through
  });

  it('a target whose torso is hidden but whose head shows is still in sight, aimed at the head', () => {
    const s = new Sight();
    // smoke over the torso line only (the eye at 0, 0; the torso at 0, the head at 0.54)
    const players = [{ id: 1, alive: true, x: 10, y: -0.7 }];
    const t = s.targets(players, 0, 0, 0, [{ x: 9.5, y: -0.1, opaque: 0.3 }]);
    expect(t).toHaveLength(1);
    expect(t[0]!.y).toBeCloseTo(-0.7 + 1.24);
  });

  it('segment distance', () => {
    expect(segmentDistance(5, 3, 0, 0, 10, 0)).toBeCloseTo(3);
    expect(segmentDistance(-4, 3, 0, 0, 10, 0)).toBeCloseTo(5);
  });
});
