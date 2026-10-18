import { BREACHER, FRAG, K47, MACHETE, RIOT_SHIELD, defaultTuning, weapons } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { statsCard } from '../../src/armory/stats';

const row = (id: string, label: string) => statsCard(id)!.rows.find((r) => r.label.startsWith(label));

describe('Armory stats card', () => {
  it('has a card for every weapon in packages/content', () => {
    for (const w of weapons) expect(statsCard(w.id)?.title).toBe(w.name);
  });

  it('reads fire rate, range and weight from content', () => {
    expect(row('k47', 'Fire rate')!.value).toBe(`${Math.round(60 / K47.interval)} rpm · auto`);
    expect(row('k47', 'Range')!.value).toContain(`${K47.range} m`);
    expect(row('k47', 'Move speed')!.value).toBe(`${Math.round(K47.moveSpeedMul * 100)} %`);
    expect(row('k47', `Time to kill (${defaultTuning.healthMax} HP)`)).toBeDefined();
  });

  it('shows shotgun damage per pellet', () => {
    expect(row('breacher', 'Damage per shot')!.value).toBe(`${BREACHER.damage * BREACHER.pellets} (${BREACHER.pellets} × ${BREACHER.damage})`);
  });

  it('gives melee a swing card with no magazine', () => {
    expect(row('machete', 'Damage per swing')!.value).toBe(`${MACHETE.meleeDamage}`);
    expect(row('machete', 'Magazine')).toBeUndefined();
  });

  it('describes the frag blast', () => {
    expect(row('frag', 'Blast radius')!.value).toContain(`${FRAG.explosion.radius} m`);
  });

  it('reads the riot shield from content (review L12: it was labelled "not in content yet")', () => {
    expect(statsCard('riot_shield')!.title).toBe(RIOT_SHIELD.name);
    expect(row('riot_shield', 'Shield HP')!.value).toBe(`${RIOT_SHIELD.hp}`);
    expect(row('riot_shield', 'Move speed')!.value).toBe(`${Math.round(RIOT_SHIELD.moveSpeedMul * 100)} % raised · 100 % slung`);
  });

  it('keeps bars in 0..1', () => {
    for (const id of [...weapons.map((w) => w.id), 'frag', 'riot_shield']) {
      for (const r of statsCard(id)!.rows) {
        if (r.bar === undefined) continue;
        expect(r.bar).toBeGreaterThanOrEqual(0);
        expect(r.bar).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns null for a model with no content entry yet', () => {
    expect(statsCard('not-a-weapon')).toBeNull();
  });
});
