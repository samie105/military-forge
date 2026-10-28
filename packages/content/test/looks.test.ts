import { describe, expect, it } from 'vitest';
import {
  BOT_COLOURWAYS,
  DEFAULT_COSMETIC_LOADOUT,
  DYE_CHANNELS,
  LOADOUT_SLOTS,
  MAX_LOOK_IDS,
  admitLook,
  allowedLook,
  botLook,
  cosmeticEarnable,
  cosmeticLoadoutHash,
  cosmeticLoadoutWireIds,
  cosmeticUnlocked,
  fitsBody,
  getCosmetic,
  loadoutBody,
  lookSeed,
  type CosmeticLoadout,
} from '../src';

const look = (items: Partial<CosmeticLoadout['items']>, dyes: Partial<CosmeticLoadout['dyes']> = {}): CosmeticLoadout => ({
  items: { ...DEFAULT_COSMETIC_LOADOUT.items, ...items },
  dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes, ...dyes },
});
const ids = (l: CosmeticLoadout) => cosmeticLoadoutWireIds(l);

describe('who may wear what (cosmeticUnlocked)', () => {
  it('starter items for everyone, level items from their level, nothing else yet', () => {
    expect(cosmeticUnlocked(getCosmetic('headgear_field_cap')!, 0)).toBe(true);
    expect(cosmeticUnlocked(getCosmetic('headgear_beret')!, 9)).toBe(false);
    expect(cosmeticUnlocked(getCosmetic('headgear_beret')!, 10)).toBe(true);
    expect(cosmeticUnlocked(getCosmetic('headgear_combat_helmet')!, 99)).toBe(false); // store
    expect(cosmeticUnlocked(getCosmetic('skin_chrome')!, 99)).toBe(false); // battle pass
  });

  it('store items only by an owner grant; the kill-effect tier includes its plain Forged skin', () => {
    const plain = getCosmetic('skin_k47_galaxy_relic')!;
    const fx = getCosmetic('skin_k47_galaxy_relic_fx')!;
    expect(cosmeticUnlocked(plain, 999)).toBe(false);
    expect(cosmeticUnlocked(fx, 999, [])).toBe(false);
    expect(cosmeticUnlocked(plain, 0, ['skin_k47_galaxy_relic'])).toBe(true);
    expect(cosmeticUnlocked(fx, 0, ['skin_k47_galaxy_relic'])).toBe(false);
    expect(cosmeticUnlocked(fx, 0, ['skin_k47_galaxy_relic_fx'])).toBe(true);
    expect(cosmeticUnlocked(plain, 0, ['skin_k47_galaxy_relic_fx'])).toBe(true);
    expect(cosmeticUnlocked(getCosmetic('skin_k47_standard')!, 0)).toBe(true); // everyone's default
    expect(cosmeticUnlocked(plain, 0, ['no_such_item'])).toBe(false);
  });

  it('a look with an ungranted skin plays with the gun as it ships; a vouched (granted) one keeps it', () => {
    const skinned = look({ skin_k47: 'skin_k47_galaxy_relic_fx' });
    expect(admitLook(ids(skinned), { level: 99 })!.items.skin_k47).toBe('skin_k47_standard');
    expect(admitLook(ids(skinned), { level: 0, ids: ids(skinned) })!.items.skin_k47).toBe('skin_k47_galaxy_relic_fx');
  });
});

describe('admitLook: a look from the wire, as the game server takes it (v19)', () => {
  it('no ids: no look (the client sent none)', () => {
    expect(admitLook([], { level: 50 })).toBeNull();
    expect(admitLook(null, { level: 50 })).toBeNull();
  });

  it('keeps an owned look exactly, the female body and her hairstyle included', () => {
    const hers = look({ bodyType: 'body_female', hair: 'hair_braids', headgear: 'headgear_bandana' }, { primary: 'dye_khaki', accent: 'dye_wine' });
    expect(admitLook(ids(hers), { level: 8 })).toEqual(hers);
  });

  it('a part on the wrong body falls back to the slot default (fit), the rest stays', () => {
    const wrong = look({ bodyType: 'body_stocky', hair: 'hair_bun', boots: 'boots_jungle' });
    const got = admitLook(ids(wrong), { level: 1 })!;
    expect(got.items.hair).toBe('hair_body');
    expect(got.items.bodyType).toBe('body_stocky');
    expect(got.items.boots).toBe('boots_jungle');
  });

  it('items the player has not unlocked fall back: store, battle pass, and level items above their level', () => {
    const greedy = look({ headgear: 'headgear_combat_helmet', skinTone: 'skin_chrome', legs: 'legs_cargo_shorts', boots: 'boots_sneakers' }, { primary: 'dye_gold' });
    const got = admitLook(ids(greedy), { level: 5 })!;
    expect(got.items.headgear).toBe(DEFAULT_COSMETIC_LOADOUT.items.headgear);
    expect(got.items.skinTone).toBe(DEFAULT_COSMETIC_LOADOUT.items.skinTone);
    expect(got.items.legs).toBe(DEFAULT_COSMETIC_LOADOUT.items.legs); // level 15
    expect(got.items.boots).toBe('boots_sneakers'); // level 5
    expect(got.dyes.primary).toBe(DEFAULT_COSMETIC_LOADOUT.dyes.primary);
  });

  it('an item the API vouched for (the ticket\'s look) passes whatever the level says', () => {
    const vouched = look({ legs: 'legs_cargo_shorts' });
    const got = admitLook(ids(vouched), { level: 0, ids: ids(vouched) })!;
    expect(got.items.legs).toBe('legs_cargo_shorts');
  });

  it('a refused body takes its fitted parts with it', () => {
    // a level item body (slim, level 5) at level 1, with a hairstyle only the female body wears: both go
    const got = admitLook(ids(look({ bodyType: 'body_slim' })), { level: 1 })!;
    expect(got.items.bodyType).toBe('body_standard');
    const her = allowedLook(look({ bodyType: 'body_female', hair: 'hair_crop' }), (def) => def.id !== 'body_female');
    expect(her.items.bodyType).toBe('body_standard');
    expect(her.items.hair).toBe('hair_body');
  });

  it('junk ids, short lists and long lists are survivable', () => {
    // unknown ids and an id in the wrong slot (1 is a body, sent as the skin tone) draw the defaults
    expect(admitLook([9999, 1, 65535], { level: 0 })).toEqual(DEFAULT_COSMETIC_LOADOUT);
    const long = [...ids(DEFAULT_COSMETIC_LOADOUT), ...Array.from({ length: 40 }, () => 7)];
    expect(admitLook(long, { level: 0 })).toEqual(DEFAULT_COSMETIC_LOADOUT);
    expect(MAX_LOOK_IDS).toBeGreaterThanOrEqual(ids(DEFAULT_COSMETIC_LOADOUT).length);
  });
});

describe('bot looks (v19): seeded, varied, both bodies, earnable only', () => {
  const seeds = Array.from({ length: 200 }, (_, i) => lookSeed(1234, `Bot ${i}`));
  const looks = seeds.map(botLook);

  it('the same seed gives the same look (server and every client agree)', () => {
    expect(botLook(seeds[3]!)).toEqual(looks[3]);
    expect(lookSeed(1, 'Kolo')).toBe(lookSeed(1, 'Kolo'));
    expect(lookSeed(1, 'Kolo')).not.toBe(lookSeed(2, 'Kolo'));
  });

  it('every look is valid, fits its body and holds only earnable items and a curated colourway', () => {
    for (const l of looks) {
      const body = loadoutBody(l);
      for (const slot of LOADOUT_SLOTS) {
        const def = getCosmetic(l.items[slot])!;
        expect(def.slot).toBe(slot);
        expect(cosmeticEarnable(def), def.id).toBe(true);
        expect(fitsBody(def, body), `${def.id} on ${body}`).toBe(true);
      }
      for (const ch of DYE_CHANNELS) expect(cosmeticEarnable(getCosmetic(l.dyes[ch])!)).toBe(true);
      expect(BOT_COLOURWAYS.some(([p, s, a]) => p === l.dyes.primary && s === l.dyes.secondary && a === l.dyes.accent)).toBe(true);
    }
  });

  it('both bodies, many different looks, and the female bots wear her hairstyles', () => {
    const female = looks.filter((l) => loadoutBody(l) === 'female');
    expect(female.length).toBeGreaterThan(60);
    expect(looks.length - female.length).toBeGreaterThan(60);
    expect(new Set(looks.map(cosmeticLoadoutHash)).size).toBeGreaterThan(150);
    expect(new Set(female.map((l) => l.items.hair)).size).toBeGreaterThan(2);
  });
});
