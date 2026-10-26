/**
 * Passwords and emails for saved accounts (auth/accounts.ts).
 *
 * - **Hashing:** Argon2id (memory-hard), OWASP's baseline for a small box: 19 MiB, 2 passes, 1 lane.
 *   About 20 ms on one core, and it runs on libuv's thread pool, so the event loop never waits.
 *   The PHC string keeps its own salt and parameters, so they can be raised later: an older hash
 *   still verifies, and {@link needsRehash} says when to store a fresh one at the next sign-in.
 * - **Unknown emails** verify against a dummy hash with the same parameters, so a sign-in with an
 *   email that has no account takes as long as one with a wrong password.
 * - **Rules:** 10 to 128 characters; not a common password, not one short run repeated
 *   ("aaaaaaaaaa", "abcabcabca"), not the email itself.
 * - Passwords are never logged or returned; only this module sees them.
 */
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const EMAIL_MAX = 254;

/** Argon2id parameters (KiB, passes, lanes). Tests may pass cheaper ones. */
export interface HashParams {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}
/** `Algorithm.Argon2id` (a const enum the library declares, which isolated modules can't read) */
const ARGON2ID = 2 as Algorithm;

export const ARGON2_PARAMS: HashParams = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export type PasswordReason = 'too_short' | 'too_long' | 'common' | 'repeats' | 'same_as_email';

/** Plain words for each reason (the web client shows its own, these go in the error message). */
export const PASSWORD_REASON_TEXT: Record<PasswordReason, string> = {
  too_short: `Use at least ${PASSWORD_MIN} characters`,
  too_long: `Use at most ${PASSWORD_MAX} characters`,
  common: 'That password is too common',
  repeats: 'That password just repeats itself',
  same_as_email: "Don't use your email as the password",
};

/**
 * Common passwords of 10 or more characters (shorter ones fail the length rule anyway), lowercase.
 * A short list on purpose: the length rule and the sign-in limits do most of the work.
 */
const COMMON = new Set([
  '1234567890',
  '0123456789',
  '0987654321',
  '9876543210',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'qwertyuiop',
  'asdfghjkl;',
  'zxcvbnm,./',
  'qwerty1234',
  'qwerty12345',
  'qwerty123456',
  'qwertyuiop1',
  'password12',
  'password123',
  'password1234',
  'password!!',
  'passw0rd12',
  'p@ssw0rd12',
  'p@ssword123',
  'iloveyou12',
  'iloveyou123',
  'letmein123',
  'welcome123',
  'welcome1234',
  'abc1234567',
  'abcdefghij',
  'abcdefg123',
  'abcd123456',
  'a123456789',
  'football12',
  'football123',
  'baseball123',
  'basketball',
  'basketball1',
  'princess12',
  'sunshine12',
  'starwars12',
  'superman12',
  'monkey1234',
  'dragon1234',
  'master1234',
  'trustno1234',
  'changeme123',
  'administrator',
  'admin12345',
  'admin123456',
  'useruser12',
  'computer12',
  'whatever12',
  'qazwsxedcrfv',
  'q1w2e3r4t5',
  'zaq12wsxcde',
  'militaryforge',
  'militaryforge1',
  'militaryforge123',
]);

/** True when `pw` is one run of at most 3 characters repeated ("aaaaaaaaaa", "121212…", "abcabc…"). */
function repeats(pw: string): boolean {
  for (let n = 1; n <= 3; n++) {
    const unit = pw.slice(0, n);
    if (unit.repeat(Math.ceil(pw.length / n)).slice(0, pw.length) === pw) return true;
  }
  return false;
}

/** Counts code points, so an emoji is one character, as the player sees it. */
const length = (s: string) => [...s].length;

/** The rule a new password breaks, or null when it is fine. */
export function passwordProblem(password: string, email?: string): PasswordReason | null {
  const n = length(password);
  if (n < PASSWORD_MIN) return 'too_short';
  if (n > PASSWORD_MAX) return 'too_long';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'common';
  if (repeats(lower)) return 'repeats';
  if (email && lower.trim() === email) return 'same_as_email';
  return null;
}

/** Trimmed and lowercase: the one form an email is stored, looked up and limited under. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const EmailShape = z.email().max(EMAIL_MAX);

/** The normalised email, or null when it isn't one. */
export function parseEmail(raw: string): string | null {
  const email = normalizeEmail(raw);
  return EmailShape.safeParse(email).success ? email : null;
}

/**
 * Hashing with a fixed set of parameters, and the dummy hash that unknown emails are checked
 * against. One per app (tests use cheap parameters so suites stay fast).
 */
export class PasswordHasher {
  private dummy: Promise<string> | null = null;

  constructor(private readonly params: HashParams = ARGON2_PARAMS) {}

  hash(password: string): Promise<string> {
    return hash(password, { algorithm: ARGON2ID, ...this.params });
  }

  /** False for a wrong password or a hash that can't be read (never throws on bad input). */
  async verify(stored: string, password: string): Promise<boolean> {
    try {
      return await verify(stored, password);
    } catch {
      return false;
    }
  }

  /**
   * The same work as {@link verify} for an account that doesn't exist: a hash with the same
   * parameters, of a random password nobody knows. Always false.
   */
  async verifyDummy(password: string): Promise<false> {
    await this.verify(await this.warm(), password);
    return false;
  }

  /** Makes the dummy hash now (at start), so the first unknown email isn't the one slower answer. */
  warm(): Promise<string> {
    this.dummy ??= this.hash(randomBytes(32).toString('base64url'));
    return this.dummy;
  }

  /** The stored hash was made with other parameters (older, cheaper): store a fresh one. */
  needsRehash(stored: string): boolean {
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
    return !m || Number(m[1]) !== this.params.memoryCost || Number(m[2]) !== this.params.timeCost || Number(m[3]) !== this.params.parallelism;
  }
}
