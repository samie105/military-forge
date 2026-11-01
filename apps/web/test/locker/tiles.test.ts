import { cosmeticsForSlot, getCosmetic } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { tileHtml } from '../../src/locker';
import { lockedLine } from '../../src/locker/tiles';

describe('Locker items (round two)', () => {
  const hat = cosmeticsForSlot('headgear')[0]!;
  const dye = cosmeticsForSlot('dye').find((d) => d.colour)!;

  it('says On, Free (a starter item), Owned, or how to get a locked one', () => {
    expect(tileHtml(hat, true, true)).toContain('tag--you');
    expect(tileHtml(hat, true, true)).toContain('is-on');
    // everyone has a starter item: it reads Free, not Owned (audit 31 Oct, A-07)
    expect(hat.source.kind).toBe('starter');
    expect(tileHtml(hat, false, true)).toContain('>Free<');
    expect(tileHtml(getCosmetic('skin_k47_galaxy_relic')!, false, true)).toContain('>Owned<');
    const locked = tileHtml(hat, false, false);
    expect(locked).toContain('is-locked');
    expect(locked).toContain('#icon-lock');
  });

  it('a locked item names only what the game has: no levels, battle pass or events (A-07, C-10)', () => {
    for (const id of ['body_slim', 'skin_chrome', 'skin_zombie', 'eyewear_gas_mask', 'headgear_crown']) {
      const html = tileHtml(getCosmetic(id)!, false, false);
      expect(html, id).toContain('Coming soon');
      expect(html, id).not.toMatch(/level|battle pass|tier|event|undead|achievement/i);
    }
    expect(tileHtml(getCosmetic('skin_k47_galaxy_relic')!, false, false)).toContain('In the Store');
  });

  it("a store item the Store doesn't sell says it's coming, and one not drawn yet says why it looks like the standard issue (C-09)", () => {
    const jacket = getCosmetic('top_track_jacket')!;
    expect(tileHtml(jacket, false, false)).toContain('Coming soon');
    expect(lockedLine(jacket)).toBe('Locked. Coming to the Store. Not drawn yet: the soldier shows the standard issue.');
    expect(lockedLine(getCosmetic('skin_k47_galaxy_relic')!)).toBe('Locked. Sold in the Store.');
  });

  it("shows a colour's swatch, else the section's glyph, with the rarity's shape", () => {
    expect(tileHtml(dye, false, true, 'primary')).toContain('item__sw');
    expect(tileHtml(dye, false, true, 'primary')).toContain('data-channel="primary"');
    expect(tileHtml(hat, false, true, undefined, false, 'helmet')).toContain('#icon-helmet');
    expect(tileHtml(hat, false, true)).toContain('class="mm-rarity"');
  });

  it('marks the item being tried on', () => {
    expect(tileHtml(getCosmetic(hat.id)!, false, true, undefined, true)).toContain('aria-checked="true"');
  });
});

describe('gun tiles (the Locker Guns tab)', () => {
  it("mark the slot's gun On, the other slot's gun as a swap, and the rest by class", async () => {
    const { gunTileHtml } = await import('../../src/locker');
    const { weapons } = await import('@military-forge/content');
    const k47 = weapons.find((w) => w.id === 'k47')!;
    const widow = weapons.find((w) => w.id === 'widow')!;
    const buzz = weapons.find((w) => w.id === 'buzz')!;
    const pair: [number, number] = [k47.index, widow.index];
    expect(gunTileHtml(k47, 0, pair)).toMatch(/is-on[\s\S]*aria-checked="true"[\s\S]*data-gun="k47" data-gslot="0"[\s\S]*On/);
    expect(gunTileHtml(widow, 0, pair)).toMatch(/Gun 2/);
    expect(gunTileHtml(buzz, 1, pair)).toMatch(/SMG/);
  });
});
