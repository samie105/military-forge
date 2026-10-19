import { describe, expect, it } from 'vitest';
import { DEFAULT_COSMETIC_LOADOUT, LOADOUT_SLOTS, getCosmetic } from '@military-forge/content';
import { tileHtml } from '../../src/locker';
import { LocalLoadoutStore, ownedOnly, randomLoadout, starterInventory, withDye, withItem } from '../../src/locker/loadouts';

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('LocalLoadoutStore', () => {
  it('round-trips a loadout and sanitises what it reads', async () => {
    const storage = memoryStorage();
    const store = new LocalLoadoutStore(storage, 'k');
    expect(await store.load()).toBeNull();
    const look = withDye(withItem(DEFAULT_COSMETIC_LOADOUT, 'boots', 'boots_jungle'), 'primary', 'dye_red');
    await store.save(look);
    expect(await store.load()).toEqual(look);
    storage.data.set('k', JSON.stringify({ version: 1, loadout: { items: { boots: 'not_an_item' } } }));
    expect(await store.load()).toEqual(DEFAULT_COSMETIC_LOADOUT);
  });

  it('survives corrupt data, other versions and storage that throws or is missing', async () => {
    const storage = memoryStorage();
    storage.data.set('k', '{not json');
    expect(await new LocalLoadoutStore(storage, 'k').load()).toBeNull();
    storage.data.set('k', JSON.stringify({ version: 2, loadout: DEFAULT_COSMETIC_LOADOUT }));
    expect(await new LocalLoadoutStore(storage, 'k').load()).toBeNull();
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
    const store = new LocalLoadoutStore(throwing);
    expect(await store.load()).toBeNull();
    expect(await new LocalLoadoutStore(null).load()).toBeNull();
  });

  it('save() rejects when nothing was stored, so the Locker never claims "Saved" falsely', async () => {
    const throwing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    await expect(new LocalLoadoutStore(throwing).save(DEFAULT_COSMETIC_LOADOUT)).rejects.toThrow('storage unavailable');
    await expect(new LocalLoadoutStore(null).save(DEFAULT_COSMETIC_LOADOUT)).rejects.toThrow('storage unavailable');
    await expect(new LocalLoadoutStore(memoryStorage()).save(DEFAULT_COSMETIC_LOADOUT)).resolves.toBeUndefined();
  });
});

describe('ownership and randomise', () => {
  it('replaces items the player does not own with slot defaults', () => {
    const look = withDye(withItem(DEFAULT_COSMETIC_LOADOUT, 'headgear', 'headgear_combat_helmet'), 'accent', 'dye_gold');
    expect(ownedOnly(look, starterInventory)).toEqual(DEFAULT_COSMETIC_LOADOUT);
    const owned = withItem(DEFAULT_COSMETIC_LOADOUT, 'headgear', 'headgear_bandana');
    expect(ownedOnly(owned, starterInventory)).toEqual(owned);
  });

  it('randomises across owned items only', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const look = randomLoadout(starterInventory, random);
      for (const slot of LOADOUT_SLOTS) {
        expect(getCosmetic(look.items[slot])?.slot).toBe(slot);
        expect(starterInventory.owns(look.items[slot])).toBe(true);
        seen.add(look.items[slot]);
      }
      for (const id of Object.values(look.dyes)) expect(starterInventory.owns(id)).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(LOADOUT_SLOTS.length * 2);
  });
});

describe('item tiles', () => {
  it('locked tiles say how to get the item; rarity has a shape and a label', () => {
    const html = tileHtml(getCosmetic('eyewear_gas_mask')!, false, false);
    expect(html).toContain('mm-locked');
    expect(html).toContain('Battle pass S1 tier 34');
    expect(html).toContain('aria-label="Rare"');
    expect(html).toContain('aria-pressed="false"');
    const owned = tileHtml(getCosmetic('dye_red')!, true, true, 'primary');
    expect(owned).toContain('data-channel="primary"');
    expect(owned).toContain('--sw:#c8332b'); // the kit's swatch (.item__sw)
    expect(owned).not.toContain('mm-how');
  });
});
