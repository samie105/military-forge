/** The game's "Suggest a name" (shared guestNames) uses the API's own guest-name parts, which the name rules take. */
import { GUEST_ADJECTIVES, GUEST_NOUNS, guestNickname } from '@military-forge/shared';
import { describe, expect, it } from 'vitest';
import { GUEST_NAME_PARTS, NicknamePolicy } from '../src/nickname/rules';

describe('suggested names', () => {
  it('are made of the same parts as a new guest’s', () => {
    expect([...GUEST_ADJECTIVES]).toEqual([...GUEST_NAME_PARTS.adjectives]);
    expect([...GUEST_NOUNS]).toEqual([...GUEST_NAME_PARTS.nouns]);
  });

  it('pass the name rules', () => {
    const policy = new NicknamePolicy();
    for (const n of [guestNickname((lo) => lo), guestNickname((_lo, hi) => hi - 1)]) expect(policy.check(n).ok).toBe(true);
  });
});
