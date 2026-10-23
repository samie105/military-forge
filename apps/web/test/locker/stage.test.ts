import { describe, expect, it } from 'vitest';
import { DRAW, REACTION_SECONDS, SHOTS, changedSlots, easeTravel, reactionFor, reactionWeight, shotForSlot, shotForTab, shouldDraw } from '../../src/locker/stage';

describe('creator stage: shots', () => {
  it('frames each look tab: hair and headwear close, the outfit waist up, gear from behind', () => {
    expect(shotForTab('hair')).toBe('head');
    expect(shotForTab('head')).toBe('head');
    expect(shotForTab('outfit')).toBe('waist');
    expect(shotForTab('gear')).toBe('back');
    expect(shotForTab('anything')).toBe('front');
    expect(SHOTS.head.distance).toBeLessThan(SHOTS.waist.distance);
    expect(SHOTS.waist.distance).toBeLessThan(SHOTS.full.distance);
    expect(SHOTS.back.yaw).toBeCloseTo((150 * Math.PI) / 180, 6);
  });

  it('frames a slot that changed: boots and trousers the whole body lower, the jetpack from behind', () => {
    expect(shotForSlot('boots')).toBe('legs');
    expect(shotForSlot('legs')).toBe('legs');
    expect(shotForSlot('jetpack')).toBe('back');
    expect(shotForSlot('headgear')).toBe('head');
    expect(shotForSlot('gloves')).toBe('waist');
    expect(SHOTS.legs.y).toBeLessThan(SHOTS.full.y - 0.25);
  });

  it('eases cubic in-out: still at both ends, half way at the middle', () => {
    expect(easeTravel(0)).toBe(0);
    expect(easeTravel(1)).toBe(1);
    expect(easeTravel(0.5)).toBeCloseTo(0.5, 9);
    expect(easeTravel(2)).toBe(1);
    const d = 1e-4;
    expect((easeTravel(d) - easeTravel(0)) / d).toBeLessThan(0.01);
    expect((easeTravel(1) - easeTravel(1 - d)) / d).toBeLessThan(0.01);
  });
});

describe('creator stage: equip reactions', () => {
  it('plays a reaction per slot, 0.6–1.0 s', () => {
    expect(reactionFor('headgear')).toBe('helmet');
    expect(reactionFor('gloves')).toBe('gloves');
    expect(reactionFor('boots')).toBe('stamp');
    expect(reactionFor('jetpack')).toBe('shrug');
    expect(reactionFor('jacket')).toBe('sleeve');
    for (const s of Object.values(REACTION_SECONDS)) {
      expect(s).toBeGreaterThanOrEqual(0.6);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('weights a reaction in, holds, and out, smoothly, 0 outside', () => {
    expect(reactionWeight(-0.1, 1)).toBe(0);
    expect(reactionWeight(0, 1)).toBe(0);
    expect(reactionWeight(0.5, 1)).toBe(1);
    expect(reactionWeight(1, 1)).toBe(0);
    let last = 0;
    let most = 0;
    for (let t = 0; t <= 1; t += 1 / 60) {
      const w = reactionWeight(t, 1);
      most = Math.max(most, Math.abs(w - last));
      last = w;
    }
    expect(most).toBeLessThan(0.1); // no pop between frames at 60 fps
  });

  it('finds the slots a look change touched', () => {
    const a = { items: { hair: 'h1', boots: 'b1' }, dyes: { primary: 'd1' } };
    expect(changedSlots(null, a)).toEqual([]);
    expect(changedSlots(a, { items: { hair: 'h1', boots: 'b2' }, dyes: { primary: 'd1' } })).toEqual(['boots']);
    expect(changedSlots(a, { items: { hair: 'h1', boots: 'b1' }, dyes: { primary: 'd2' } })).toEqual(['dyes']);
  });
});

describe('creator stage: when to draw', () => {
  /** frames drawn over `seconds` at 60 Hz, input until `busy` */
  const count = (from: number, seconds: number, busy: number, touch: boolean, reduced: boolean): number => {
    let last = -Infinity;
    let drawn = 0;
    for (let k = 0; k < seconds * 60; k++) {
      const now = from + k / 60;
      if (shouldDraw(now, last, busy, touch, reduced)) {
        drawn++;
        last = now;
      }
    }
    return drawn;
  };

  it('draws every frame while something moves', () => {
    expect(count(0, 1, 1, true, false)).toBe(60);
    expect(count(0, 1, 1, false, true)).toBe(60);
  });

  it('idles at most 30 fps on a phone, at the display rate on desktop', () => {
    expect(count(10, 1, 0, true, false)).toBeLessThanOrEqual(DRAW.touchIdleFps);
    expect(count(10, 1, 0, true, false)).toBeGreaterThanOrEqual(28);
    expect(count(10, 1, 0, false, false)).toBe(60);
  });

  it('under Reduce motion stops drawing 3 s after the last input', () => {
    expect(count(1, 2, 1, true, true)).toBeGreaterThan(0);
    expect(count(1 + DRAW.reducedRestSeconds, 10, 1, false, true)).toBe(0);
  });
});
