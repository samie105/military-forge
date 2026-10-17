import { describe, expect, it } from 'vitest';
import { ATTACHMENTS, getAttachment } from '../src';

describe('attachments', () => {
  it('have unique ids and resolve by id', () => {
    expect(new Set(ATTACHMENTS.map((a) => a.id)).size).toBe(ATTACHMENTS.length);
    for (const a of ATTACHMENTS) expect(getAttachment(a.id)).toBe(a);
  });

  it('are in-match pickups only and never sold (the fairness default)', () => {
    for (const a of ATTACHMENTS) {
      expect(a.acquisition).toBe('pickup');
      expect(a.sellable).toBe(false);
    }
  });

  it('carry identity and fit only: the arsenal stream adds stats', () => {
    const allowed = new Set(['id', 'name', 'kind', 'mount', 'sightLevel', 'acquisition', 'sellable']);
    for (const a of ATTACHMENTS) for (const key of Object.keys(a)) expect(allowed.has(key), `${a.id}.${key}`).toBe(true);
  });

  it('give the two sights two levels', () => {
    const sights = ATTACHMENTS.filter((a) => a.kind === 'sight').map((a) => a.sightLevel).sort();
    expect(sights).toEqual([1, 2]);
  });
});
