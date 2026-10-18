import { HAMMER, RIOT_SHIELD_PICKUP, WIDOW, weaponPickup } from '@military-forge/content';
import { Box3, Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AvatarKit } from '../avatar';
import { toonRamp } from '../character';
import { WeaponItems } from '../weaponItems';

describe('weapon crates in 3D (more guns)', () => {
  it('one gun per weapon item, upright over its spot, gone when the item goes; other pickups are not its business', () => {
    const items = new WeaponItems(new AvatarKit(toonRamp()));
    const widow = { id: 3, def: weaponPickup(WIDOW.index)!.index, x: 12, y: 4 };
    items.sync([widow, { id: 4, def: RIOT_SHIELD_PICKUP.index, x: 0, y: 0 }, { id: 5, def: weaponPickup(HAMMER.index)!.index, x: 30, y: 0 }], 1 / 60);
    expect(items.count).toBe(2);
    items.group.updateMatrixWorld(true);
    const gun = items.group.children[0]!.children.find((c) => c instanceof Mesh && c.geometry.type !== 'CircleGeometry')!;
    const box = new Box3().setFromObject(gun);
    const size = box.getSize(new Vector3());
    const mid = box.getCenter(new Vector3());
    expect(size.y).toBeGreaterThan(Math.max(size.x, size.z)); // standing up, muzzle up
    expect(size.x).toBeGreaterThan(size.z); // its side to the camera
    expect(Math.abs(mid.x - widow.x)).toBeLessThan(0.3); // over the spot
    expect(box.min.y).toBeGreaterThan(widow.y); // above the floor
    items.sync([widow], 1 / 60);
    expect(items.count).toBe(1);
    items.sync([], 1 / 60);
    expect([items.count, items.group.children.length]).toEqual([0, 0]);
    items.dispose();
  });
});
