import { describe, expect, it } from 'vitest';
import {
  BODIES,
  COSMETIC_ENVELOPE_MUL,
  DEFAULT_COSMETIC_LOADOUT,
  DYE_CHANNELS,
  LOADOUT_SLOTS,
  MIN_BODY_WIDTH_MUL,
  PART_SLOTS,
  RARITIES,
  RARITY_STYLE,
  cosmeticLoadoutFromWireIds,
  cosmeticLoadoutHash,
  cosmeticLoadoutWireIds,
  cosmeticSourceLabel,
  cosmetics,
  cosmeticsForSlot,
  fitsBody,
  getCosmetic,
  getCosmeticByWireId,
  loadoutBody,
  sanitizeCosmeticLoadout,
  type CosmeticLoadout,
} from '../src';

/** The only fields an item may carry. Anything gameplay-shaped (hitbox, speed, scale, loudness...) fails here. */
const ALLOWED_KEYS = new Set(['id', 'wireId', 'slot', 'name', 'rarity', 'assets', 'dyeable', 'source', 'releaseSeason', 'tags', 'colour', 'widthMul', 'body', 'fits']);
const COLOUR_SLOTS = new Set(['skinTone', 'exhaust', 'dye']);

function withItem(slot: string, id: string): CosmeticLoadout {
  return { ...DEFAULT_COSMETIC_LOADOUT, items: { ...DEFAULT_COSMETIC_LOADOUT.items, [slot]: id } };
}

describe('cosmetics: fairness (docs/04 §1)', () => {
  it('items carry no gameplay data: hitboxes, speed, size and loudness are never cosmetic', () => {
    for (const c of cosmetics) {
      for (const key of Object.keys(c)) expect(ALLOWED_KEYS.has(key), `${c.id}.${key}`).toBe(true);
      for (const key of Object.keys(c.assets)) expect(key, c.id).toBe('manifest');
    }
  });

  it('body types only change width, inside the silhouette envelope, and never the head', () => {
    for (const c of cosmetics) {
      if (c.slot !== 'bodyType') {
        expect(c.widthMul, c.id).toBeUndefined();
        continue;
      }
      expect(c.widthMul, c.id).toBeGreaterThanOrEqual(MIN_BODY_WIDTH_MUL);
      expect(c.widthMul, `${c.id}: docs/04 §1.2 forbids shrinking the visual`).toBeGreaterThanOrEqual(1);
      expect(c.widthMul, c.id).toBeLessThanOrEqual(COSMETIC_ENVELOPE_MUL);
    }
    expect(getCosmetic(DEFAULT_COSMETIC_LOADOUT.items.bodyType)?.widthMul).toBe(1);
  });

  it('every slot has a starter default, so a missing part always falls back to something everyone owns', () => {
    for (const slot of LOADOUT_SLOTS) {
      const def = getCosmetic(DEFAULT_COSMETIC_LOADOUT.items[slot]);
      expect(def?.slot, slot).toBe(slot);
      expect(def?.source.kind, slot).toBe('starter');
      // ...and fits every body, so it can replace a part made for another one
      for (const body of BODIES) expect(fitsBody(def!, body), `${slot} on ${body}`).toBe(true);
    }
    for (const ch of DYE_CHANNELS) expect(getCosmetic(DEFAULT_COSMETIC_LOADOUT.dyes[ch])?.source.kind).toBe('starter');
  });
});

describe('cosmetics: data', () => {
  it('ids and wire ids are unique; wire ids fit a u16 and 0 stays free', () => {
    expect(new Set(cosmetics.map((c) => c.id)).size).toBe(cosmetics.length);
    expect(new Set(cosmetics.map((c) => c.wireId)).size).toBe(cosmetics.length);
    for (const c of cosmetics) {
      expect(Number.isInteger(c.wireId) && c.wireId > 0 && c.wireId < 0x10000, c.id).toBe(true);
      expect(c.id, c.id).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('wire ids are frozen: saved and networked loadouts store them, so renumbering is a breaking change', () => {
    // Colour lists number their items by position, so inserting one mid-list would shift the rest.
    // Add new items at the end of a list (or with an explicit id); never edit this snapshot to "fix" it.
    expect(Object.fromEntries(cosmetics.map((c) => [c.id, c.wireId]))).toMatchSnapshot();
  });

  it('colour items have an sRGB hex colour and are not dyeable; parts have no colour', () => {
    for (const c of cosmetics) {
      if (COLOUR_SLOTS.has(c.slot)) {
        expect(c.colour, c.id).toMatch(/^#[0-9a-f]{6}$/);
        expect(c.dyeable, c.id).toBe(false);
      } else {
        expect(c.colour, c.id).toBeUndefined();
      }
    }
  });

  it('art manifests follow W8\'s catalogue layout', () => {
    for (const c of cosmetics) {
      if (c.assets.manifest) expect(c.assets.manifest).toBe(`cosmetics/${c.slot}/${c.id}.json`);
      if (c.assets.manifest) expect((PART_SLOTS as readonly string[]).includes(c.slot), c.id).toBe(true);
    }
  });

  it('the starter set covers the Locker tabs, with locked items to earn in each part slot', () => {
    expect(cosmeticsForSlot('skinTone').filter((c) => c.source.kind === 'starter')).toHaveLength(12);
    expect(cosmeticsForSlot('dye').length).toBeGreaterThanOrEqual(12);
    for (const slot of ['headgear', 'eyewear', 'boots', 'jetpack'] as const) {
      expect(cosmeticsForSlot(slot).some((c) => c.source.kind !== 'starter'), slot).toBe(true);
    }
  });

  it('rarities are colour-blind safe: every tier has its own shape', () => {
    expect(new Set(RARITIES.map((r) => RARITY_STYLE[r].shape)).size).toBe(RARITIES.length);
    for (const c of cosmetics) expect(RARITIES).toContain(c.rarity);
  });

  it('how-to-get labels', () => {
    expect(cosmeticSourceLabel({ kind: 'battlePass', season: 1, tier: 34 })).toBe('Battle pass S1 tier 34');
    expect(cosmeticSourceLabel({ kind: 'achievement', label: '100 headshots' })).toBe('Achievement: 100 headshots');
    expect(cosmeticSourceLabel({ kind: 'level', level: 5 })).toBe('Reach level 5');
    expect(cosmeticSourceLabel({ kind: 'store' })).toBe('Store');
  });
});

describe('bodies (owner, 22 Oct: the female soldier)', () => {
  it('every body type is built on a base body, and there is a female one', () => {
    for (const c of cosmeticsForSlot('bodyType')) expect(BODIES, c.id).toContain(c.body);
    expect(getCosmetic('body_female')).toMatchObject({ slot: 'bodyType', body: 'female', widthMul: 1, source: { kind: 'starter' } });
    expect(loadoutBody(DEFAULT_COSMETIC_LOADOUT)).toBe('male');
  });

  it('only parts carry `fits`, naming real bodies; the hairstyles are made for the female body', () => {
    for (const c of cosmetics) {
      if (!c.fits) continue;
      expect((PART_SLOTS as readonly string[]).includes(c.slot), c.id).toBe(true);
      expect(c.fits.length, c.id).toBeGreaterThan(0);
      for (const b of c.fits) expect(BODIES, c.id).toContain(b);
    }
    const styles = cosmeticsForSlot('hair').filter((c) => c.id !== DEFAULT_COSMETIC_LOADOUT.items.hair);
    expect(styles.length).toBeGreaterThanOrEqual(3);
    for (const c of styles) expect(c.fits, c.id).toEqual(['female']);
  });

  it('a part made for another body falls back to the slot default; on its own body it stays', () => {
    const female = withItem('bodyType', 'body_female');
    const styled = { ...female, items: { ...female.items, hair: 'hair_braids' } };
    expect(sanitizeCosmeticLoadout(styled)).toEqual(styled);
    const onMale = sanitizeCosmeticLoadout(withItem('hair', 'hair_braids'));
    expect(onMale.items.hair).toBe(DEFAULT_COSMETIC_LOADOUT.items.hair);
  });

  it('a loadout saved before `hair` existed loads, with the body\'s own hair', () => {
    const { hair: _, ...old } = DEFAULT_COSMETIC_LOADOUT.items;
    const saved = { items: { ...old, headgear: 'headgear_beret' }, dyes: DEFAULT_COSMETIC_LOADOUT.dyes };
    expect(sanitizeCosmeticLoadout(saved)).toEqual(withItem('headgear', 'headgear_beret'));
  });
});

describe('cosmetic loadouts', () => {
  it('sanitising keeps valid items and replaces unknown or wrong-slot ids with the slot default', () => {
    const good = withItem('headgear', 'headgear_beret');
    expect(sanitizeCosmeticLoadout(good)).toEqual(good);
    const bad = sanitizeCosmeticLoadout({ items: { headgear: 'boots_jungle', eyewear: 'nope', boots: 42 }, dyes: { primary: 'skin_01', accent: 'dye_red' } });
    expect(bad.items.headgear).toBe(DEFAULT_COSMETIC_LOADOUT.items.headgear);
    expect(bad.items.eyewear).toBe(DEFAULT_COSMETIC_LOADOUT.items.eyewear);
    expect(bad.items.boots).toBe(DEFAULT_COSMETIC_LOADOUT.items.boots);
    expect(bad.dyes).toEqual({ ...DEFAULT_COSMETIC_LOADOUT.dyes, accent: 'dye_red' });
    for (const junk of [null, undefined, 7, 'x', [], { items: null }]) expect(sanitizeCosmeticLoadout(junk)).toEqual(DEFAULT_COSMETIC_LOADOUT);
  });

  it('wire ids round-trip with a fixed length', () => {
    const l = { items: { ...withItem('boots', 'boots_jungle').items, skinTone: 'skin_11' }, dyes: { primary: 'dye_red', secondary: 'dye_navy', accent: 'dye_gold' } };
    const ids = cosmeticLoadoutWireIds(l);
    expect(ids).toHaveLength(LOADOUT_SLOTS.length + DYE_CHANNELS.length);
    expect(cosmeticLoadoutFromWireIds(ids)).toEqual(l);
    expect(cosmeticLoadoutFromWireIds([])).toEqual(DEFAULT_COSMETIC_LOADOUT);
    expect(cosmeticLoadoutFromWireIds([9999, 0, 40])).toEqual(DEFAULT_COSMETIC_LOADOUT);
  });

  it('the wire form keeps the first 14 ids in place (11 slots, then the 3 dyes); hair follows', () => {
    const female = { items: { ...DEFAULT_COSMETIC_LOADOUT.items, bodyType: 'body_female', hair: 'hair_bun' }, dyes: { primary: 'dye_red', secondary: 'dye_navy', accent: 'dye_gold' } };
    const ids = cosmeticLoadoutWireIds(female);
    expect(ids).toHaveLength(15);
    expect(getCosmeticByWireId(ids[11]!)?.id).toBe('dye_red');
    expect(getCosmeticByWireId(ids[14]!)?.id).toBe('hair_bun');
    // a 14-id loadout from before `hair`: everything reads as it did, and the hair is the body's own
    const old = cosmeticLoadoutFromWireIds(ids.slice(0, 14));
    expect(old).toEqual({ ...female, items: { ...female.items, hair: DEFAULT_COSMETIC_LOADOUT.items.hair } });
  });

  it('hash is stable, a u32, and sensitive to every slot and dye', () => {
    const base = cosmeticLoadoutHash(DEFAULT_COSMETIC_LOADOUT);
    expect(base).toBe(cosmeticLoadoutHash(sanitizeCosmeticLoadout(JSON.parse(JSON.stringify(DEFAULT_COSMETIC_LOADOUT)))));
    expect(base >>> 0).toBe(base);
    const seen = new Set([base]);
    for (const slot of LOADOUT_SLOTS) {
      const other = cosmeticsForSlot(slot).find((c) => c.id !== DEFAULT_COSMETIC_LOADOUT.items[slot])!;
      seen.add(cosmeticLoadoutHash(withItem(slot, other.id)));
    }
    seen.add(cosmeticLoadoutHash({ ...DEFAULT_COSMETIC_LOADOUT, dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes, accent: 'dye_red' } }));
    expect(seen.size).toBe(LOADOUT_SLOTS.length + 2);
  });
});
