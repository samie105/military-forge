import { Group, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { LIGHT_POOL_SIZE, LightPool } from '../../src/armory/lights';

describe('LightPool (review L11: firing never changes the light count)', () => {
  it('puts its lights in the scene once, dark', () => {
    const parent = new Group();
    const pool = new LightPool(parent);
    expect(parent.children).toHaveLength(LIGHT_POOL_SIZE);
    expect(pool.lights.every((l) => l.intensity === 0)).toBe(true);
  });

  it('lights one where asked and darkens it on return, without adding or removing lights', () => {
    const parent = new Group();
    const pool = new LightPool(parent);
    const l = pool.take({ color: '#ffaa33', intensity: 3, rangeM: 1.5 }, new Vector3(0.1, 0.2, 0.3))!;
    expect(l.intensity).toBe(3);
    expect(l.distance).toBe(1.5);
    expect(l.position.toArray()).toEqual([0.1, 0.2, 0.3]);
    expect(l.color.getHexString()).toBe('ffaa33');
    expect(pool.busy()).toBe(1);
    pool.give(l);
    pool.give(l); // twice is harmless
    expect(l.intensity).toBe(0);
    expect(pool.busy()).toBe(0);
    expect(parent.children).toHaveLength(LIGHT_POOL_SIZE);
  });

  it('plays an effect unlit when every light is busy, and ignores a style without a light', () => {
    const pool = new LightPool(new Group(), 1);
    const def = { color: '#ffffff', intensity: 1, rangeM: 1 };
    expect(pool.take(def, new Vector3())).not.toBeNull();
    expect(pool.take(def, new Vector3())).toBeNull();
    expect(pool.take(undefined, new Vector3())).toBeNull();
    pool.give(null);
    expect(pool.busy()).toBe(1);
  });
});
