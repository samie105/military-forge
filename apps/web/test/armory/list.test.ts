import { describe, expect, it } from 'vitest';
import { attachIcon, weaponList } from '../../src/armory';

describe('Armory list (round two)', () => {
  it('groups the weapons by family in the kit order, each with its glyph', () => {
    const html = weaponList({ k47: { name: 'K-47', family: 'rifle' }, hawk50: { name: 'Hawk .50', family: 'pistol' }, odd: { name: 'Odd', family: 'prop' } });
    const labels = [...html.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1]);
    // the content's slot name, as the HUD and the Locker say it (audit 28 Oct)
    expect(labels).toEqual(['Sidearm', 'Rifle', 'prop']);
    expect(html).toContain('data-weapon="k47"');
    expect(html).toContain('#icon-wpn-k47');
  });

  it('picks an attachment glyph by what it is or where it mounts', () => {
    expect(attachIcon('suppressor', 'muzzle')).toBe('att-suppressor');
    expect(attachIcon('laser_sight', 'rail_bottom')).toBe('att-laser');
    expect(attachIcon('foregrip', 'rail_bottom')).toBe('att-foregrip');
    expect(attachIcon('ext_mag', 'mag')).toBe('att-extmag');
    expect(attachIcon('red_dot', 'rail_top')).toBe('att-scope');
  });
});
