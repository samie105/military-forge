/**
 * Friend codes: 8 characters from a 30-symbol alphabet with no lookalikes (no 0/O, 1/I/L, U),
 * shown as `7KQ4-M9XP`. About 6.6 × 10¹¹ codes, handed out at random, so guessing one gets
 * nowhere under the lookup rate limits. Typed codes are read loosely: any case, with or without
 * the dash or spaces. A lookalike (O, I, L, 0, 1, U) is never part of a code, so it can't match.
 */
import { randomInt } from 'node:crypto';

export const FRIEND_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const FRIEND_CODE_LENGTH = 8;

export function newFriendCode(rand: (max: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < FRIEND_CODE_LENGTH; i++) code += FRIEND_CODE_ALPHABET[rand(FRIEND_CODE_ALPHABET.length)];
  return code;
}

/** `7KQ4M9XP` → `7KQ4-M9XP` (how the code is shown). */
export function formatFriendCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What a player typed → the stored form, or null when it can't be a friend code. */
export function normalizeFriendCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]+/g, '');
  if (code.length !== FRIEND_CODE_LENGTH) return null;
  for (const ch of code) if (!FRIEND_CODE_ALPHABET.includes(ch)) return null;
  return code;
}
