import { describe, expect, it } from 'vitest';
import { DEFAULT_COSMETIC_LOADOUT, fitsBody, getCosmetic, loadoutBody, type CosmeticLoadout } from '@military-forge/content';
import { bodyCardsHtml } from '../../src/creator';
import { BODY_SLOTS, CREATOR_SEEN_KEY, bodyCards, bodyTypesFor, creatorSeen, itemsFor, lookTabs, markCreatorSeen, withBody } from '../../src/creator/model';
import { randomLoadout, starterInventory } from '../../src/locker/loadouts';

const female = withBody(DEFAULT_COSMETIC_LOADOUT, 'female');

describe('the creator: bodies (content #172)', () => {
  it('has a card per body, each with its builds', () => {
    expect(bodyCards().map((c) => [c.body, c.builds])).toEqual([
      ['male', 3],
      ['female', 1],
    ]);
    expect(bodyTypesFor('female').map((c) => c.id)).toEqual(['body_female']);
  });

  it('switching body takes its build and drops parts made for the other body', () => {
    expect(female.items.bodyType).toBe('body_female');
    expect(loadoutBody(female)).toBe('female');
    const braids: CosmeticLoadout = { ...female, items: { ...female.items, hair: 'hair_braids' } };
    const back = withBody(braids, 'male');
    expect(back.items.bodyType).toBe('body_standard');
    expect(back.items.hair).toBe('hair_body');
    expect(withBody(back, 'male', 'body_stocky').items.bodyType).toBe('body_stocky');
  });

  it('the body step offers the body\'s own builds and every skin tone', () => {
    expect(BODY_SLOTS.map((s) => s.slot)).toEqual(['bodyType', 'skinTone']);
    expect(itemsFor('bodyType', 'male').map((c) => c.id)).toEqual(['body_standard', 'body_stocky', 'body_slim']);
    expect(itemsFor('skinTone', 'female').length).toBe(itemsFor('skinTone', 'male').length);
  });
});

describe('the creator: the look', () => {
  it('a Hair tab for the female body (her hairstyles), none for the male body (his own hair only)', () => {
    expect(lookTabs('female').map((t) => t.id)).toEqual(['hair', 'head', 'outfit', 'gear', 'colours']);
    expect(lookTabs('male').map((t) => t.id)).toEqual(['head', 'outfit', 'gear', 'colours']);
    expect(itemsFor('hair', 'female').map((c) => c.id)).toEqual(['hair_body', 'hair_bun', 'hair_braids', 'hair_crop']);
  });

  it('lists only what fits the body, and only slots that are in the loadout', () => {
    for (const body of ['male', 'female'] as const)
      for (const tab of lookTabs(body))
        for (const { slot } of tab.slots) {
          const items = itemsFor(slot, body);
          expect(items.length, `${body} ${slot}`).toBeGreaterThan(1);
          for (const item of items) expect(fitsBody(item, body)).toBe(true);
        }
    expect(itemsFor('jacket' as never, 'male')).toEqual([]); // not a slot yet: no tab, no items
    expect(lookTabs('male').flatMap((t) => t.slots.map((s) => s.slot))).not.toContain('jacket');
  });

  it('the colourways include #172\'s outfit tones', () => {
    const dyes = itemsFor('dye', 'female').map((c) => c.id);
    for (const id of ['dye_khaki', 'dye_stone', 'dye_gunmetal', 'dye_indigo', 'dye_terracotta', 'dye_mustard', 'dye_wine', 'dye_denim']) expect(dyes).toContain(id);
  });

  it('randomise keeps the body and picks what fits it', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < 20; i++) {
      const look = randomLoadout(starterInventory, random, 'female');
      expect(loadoutBody(look)).toBe('female');
      for (const id of Object.values(look.items)) expect(fitsBody(getCosmetic(id)!, 'female')).toBe(true);
      expect(loadoutBody(randomLoadout(starterInventory, random, 'male'))).toBe('male');
    }
  });
});

describe('the creator: body cards and the first-run flag', () => {
  it('marks the chosen body, and a body whose 3D art is still coming', () => {
    const html = bodyCardsHtml(bodyCards(), 'male', new Set(['female']));
    expect(html).toMatch(/aria-checked="true" data-body="male"/);
    expect(html).toContain('Art coming');
    expect(html).toContain('Her 3D art is being made: shown on the male body for now');
    expect(html).toContain('3 builds');
    // chosen, she's On, and her card still says why she looks like him
    const chosen = bodyCardsHtml(bodyCards(), 'female', new Set(['female']));
    expect(chosen).toMatch(/aria-checked="true" data-body="female"/);
    expect(chosen).toContain('shown on the male body for now');
  });

  it('shows once per device, after Save or Skip', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    expect(creatorSeen(storage)).toBe(false);
    markCreatorSeen(storage);
    expect(map.get(CREATOR_SEEN_KEY)).toBe('1');
    expect(creatorSeen(storage)).toBe(true);
    expect(creatorSeen(null)).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); } };
    expect(creatorSeen(broken)).toBe(true); // no storage: never pushed on every visit
  });
});
