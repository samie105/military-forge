import { weaponPickup, weapons } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { RACK_NEAR, planTags, tagWords } from './worldTags';

const crate = (id: number, w: number, x: number, y = 0) => ({ id, def: weaponPickup(weapons[w]!.index)!.index, x, y });

describe('world tags', () => {
  it('tags a lone crate always, and a rack only near you, on two rows', () => {
    const rack = Array.from({ length: 10 }, (_, i) => crate(100 + i, i, 20 + i * 0.8));
    const lone = crate(1, 3, 0);
    const far = planTags([lone, ...rack], { x: -5, y: 0 });
    expect(far.tags.map((t) => [t.id, t.kind])).toEqual([[1, 'crate']]);
    expect(far.sign).toBeNull();
    const near = planTags([lone, ...rack], { x: 23, y: 0 });
    const tagged = near.tags.filter((t) => t.kind === 'rack');
    expect(tagged.length).toBeGreaterThanOrEqual(3);
    for (const t of tagged) expect(Math.abs(t.x - 23)).toBeLessThanOrEqual(RACK_NEAR);
    expect(new Set(tagged.map((t) => t.row))).toEqual(new Set([0, 1]));
    expect(near.sign).not.toBeNull();
    // not the crate you stand on: the swap card says it
    expect(near.tags.some((t) => t.id === 104)).toBe(false);
    expect(planTags([lone], { x: 0.2, y: 0 }).tags).toEqual([]);
  });

  it("words a gun by name and family", () => {
    const def = weaponPickup(weapons.find((w) => w.id === 'k47')!.index)!;
    expect(tagWords(def)).toMatchObject({ name: 'K-47', family: 'Rifle' });
  });
});
