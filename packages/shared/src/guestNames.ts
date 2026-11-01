/**
 * Generated names ("SwiftFalcon482") for the game's "Suggest a name" on Edit name (a controller has
 * no keyboard to type one: UX audit 2, N-05): the same parts as the API's names for a new guest who
 * picks none (apps/api nickname/rules.ts GUEST_NAME_PARTS; apps/api/test/guestNames.test.ts keeps
 * the two the same). 24 × 24 × 900 ≈ 518k names, all ≤ 16 characters.
 */
export const GUEST_ADJECTIVES = [
  'Swift', 'Brave', 'Silent', 'Rapid', 'Lucky', 'Bold', 'Fierce', 'Steady', 'Clever', 'Iron', 'Golden', 'Crimson',
  'Shadow', 'Wild', 'Frosty', 'Sly', 'Mighty', 'Rogue', 'Nimble', 'Stormy', 'Cosmic', 'Turbo', 'Sonic', 'Blazing',
] as const;
export const GUEST_NOUNS = [
  'Falcon', 'Tiger', 'Cobra', 'Jackal', 'Panda', 'Rhino', 'Viper', 'Eagle', 'Wolf', 'Hawk', 'Lion', 'Shark',
  'Bison', 'Otter', 'Raven', 'Lynx', 'Mamba', 'Gecko', 'Fox', 'Bear', 'Puma', 'Orca', 'Comet', 'Rocket',
] as const;

/** A generated name; `randomInt(lo, hi)`: an integer in [lo, hi) (node's crypto.randomInt, or Math.random's). */
export function guestNickname(randomInt: (lo: number, hi: number) => number): string {
  return `${GUEST_ADJECTIVES[randomInt(0, GUEST_ADJECTIVES.length)]}${GUEST_NOUNS[randomInt(0, GUEST_NOUNS.length)]}${randomInt(100, 1000)}`;
}
