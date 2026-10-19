import { cosmeticsForSlot, getCosmetic } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { tileHtml } from '../../src/locker';

describe('Locker items (round two)', () => {
  const hat = cosmeticsForSlot('headgear')[0]!;
  const dye = cosmeticsForSlot('dye').find((d) => d.colour)!;

  it('says On, Owned, or how to get a locked one', () => {
    expect(tileHtml(hat, true, true)).toContain('tag--you');
    expect(tileHtml(hat, true, true)).toContain('is-on');
    expect(tileHtml(hat, false, true)).toContain('>Owned<');
    const locked = tileHtml(hat, false, false);
    expect(locked).toContain('is-locked');
    expect(locked).toContain('#icon-lock');
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
