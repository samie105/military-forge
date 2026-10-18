import { HAMMER, LONGBOW, RIOT_SHIELD_PICKUP, WIDOW, weaponPickup } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import type { PlayerView } from '../src/view';
import { crateColor, weaponUnderfoot } from '../src/weaponItems';

const player = (x: number, y: number, held: number[]): PlayerView => ({ x, y, weapons: held.map((def) => ({ def })) }) as unknown as PlayerView;

describe('weapon crates on the HUD (more guns)', () => {
  const widow = { id: 1, def: weaponPickup(WIDOW.index)!.index, x: 10, y: 2 };
  const items = [{ id: 0, def: RIOT_SHIELD_PICKUP.index, x: 10, y: 2 }, widow];

  it('finds the gun the player stands on, and whether they hold it already', () => {
    expect(weaponUnderfoot(items, player(10.2, 2, [HAMMER.index]))).toMatchObject({ item: widow, weapon: WIDOW, held: false });
    expect(weaponUnderfoot(items, player(10, 2, [WIDOW.index]))?.held).toBe(true);
    expect(weaponUnderfoot(items, player(11, 2, []))).toBeNull(); // out of reach
    expect(weaponUnderfoot(items, player(10, 5, []))).toBeNull(); // on a floor above it
    expect(weaponUnderfoot(undefined, player(10, 2, []))).toBeNull();
  });

  it('power weapons get the gold crate', () => {
    expect(crateColor(LONGBOW)).not.toBe(crateColor(HAMMER));
    expect(crateColor(WIDOW)).toBe(crateColor(LONGBOW));
  });
});
