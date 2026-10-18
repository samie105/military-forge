import { DEFAULT_COSMETIC_LOADOUT, getCosmetic, sanitizeCosmeticLoadout, type CosmeticLoadout } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import type { LoadoutStore } from '../../locker/loadouts';
import { LoadoutDirectory, PLACEHOLDER_DYES, placeholderLoadout } from '../character';

class MemoryStore implements LoadoutStore {
  readonly label = 'memory';
  constructor(private readonly saved: CosmeticLoadout | null) {}
  load = async () => this.saved;
  save = async () => {};
}

describe('in-game looks', () => {
  it('PLACEHOLDER: remote players wear the default Rookie, dyed by player id with starter dyes (never the default dyes)', () => {
    const seen = new Set<string>([JSON.stringify(DEFAULT_COSMETIC_LOADOUT.dyes)]);
    for (let id = 0; id < PLACEHOLDER_DYES.length; id++) {
      const l = placeholderLoadout(id);
      expect(sanitizeCosmeticLoadout(l)).toEqual(l); // every id is a real dye
      expect(l.items).toEqual(DEFAULT_COSMETIC_LOADOUT.items);
      for (const id of Object.values(l.dyes)) expect(getCosmetic(id)!.source.kind).toBe('starter');
      seen.add(JSON.stringify(l.dyes));
    }
    expect(seen.size).toBe(PLACEHOLDER_DYES.length + 1);
    expect(placeholderLoadout(PLACEHOLDER_DYES.length + 3)).toEqual(placeholderLoadout(3));
  });

  it("the local player wears the Locker's saved look (owned items only) once it has loaded", async () => {
    const saved = sanitizeCosmeticLoadout({ items: { headgear: 'headgear_field_cap', eyewear: 'eyewear_gas_mask' }, dyes: { primary: 'dye_red' } });
    const looks = new LoadoutDirectory(new MemoryStore(saved));
    expect(looks.for({ id: 4, isLocal: true })).toEqual(DEFAULT_COSMETIC_LOADOUT);
    let changed = 0;
    looks.onChange = () => changed++;
    await new Promise((r) => setTimeout(r, 0));
    expect(changed).toBe(1);
    const mine = looks.for({ id: 4, isLocal: true });
    expect(mine.items.headgear).toBe('headgear_field_cap');
    expect(mine.items.eyewear).toBe('eyewear_none'); // the gas mask isn't a starter item
    expect(mine.dyes.primary).toBe('dye_red');
    expect(looks.for({ id: 4, isLocal: false })).toEqual(placeholderLoadout(4));
  });
});
