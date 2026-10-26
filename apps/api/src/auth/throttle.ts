/**
 * Password guessing limits, in the KV store (Valkey in production), with exponential backoff.
 *
 * Every wrong password counts against two subjects: the account (the email's hash, or the user id
 * when a signed-in player retypes their password) and the client's IP (per address, IPv6 per /64).
 * Each subject gets some free misses inside its window; after that every miss locks it for
 * 1 s, 2 s, 4 s … up to 15 minutes. While a subject is locked, sign-in is refused before any
 * password is checked, even the right one. Emails without an account are counted exactly like
 * real ones, so the limits never tell an attacker which emails exist.
 *
 * A right password clears the account's misses, not the IP's: one attacker signing in to their
 * own account between guesses must not reset the IP's count.
 *
 * Keys: `af:{subject}` (misses in the window) and `al:{subject}` (locked until, ms since the epoch).
 */
import { createHash } from 'node:crypto';
import type { Kv } from '../kv/kv';
import { ApiError } from '../http/errors';

export interface BackoffRule {
  /** misses allowed in the window before backoff starts */
  free: number;
  windowMs: number;
  baseMs: number;
  maxMs: number;
}

export const BACKOFF = {
  /** per account: 5 misses, then 1 s, 2 s, 4 s … 15 min; the count lasts a day */
  account: { free: 5, windowMs: 24 * 3_600_000, baseMs: 1_000, maxMs: 15 * 60_000 },
  /** per IP: looser (carrier-grade NAT puts many players on one address) */
  ip: { free: 20, windowMs: 3_600_000, baseMs: 1_000, maxMs: 15 * 60_000 },
} as const satisfies Record<string, BackoffRule>;

/** How long the `n`th miss locks the subject (0 while misses are still free). */
export function lockMsFor(rule: BackoffRule, misses: number): number {
  const over = misses - rule.free;
  if (over <= 0) return 0;
  return Math.min(rule.maxMs, rule.baseMs * 2 ** Math.min(over - 1, 30));
}

/** The account subject for an email: its hash, so raw emails never become KV keys. */
export function emailSubject(email: string): string {
  return `e:${createHash('sha256').update(`military-forge login\0${email}`).digest('hex').slice(0, 32)}`;
}

export interface Subject {
  key: string;
  rule: BackoffRule;
}

export class Throttle {
  constructor(
    private readonly kv: Kv,
    private readonly now: () => number,
  ) {}

  /** 429 `too_many_attempts` (with Retry-After) while any of `subjects` is locked. */
  async check(subjects: readonly Subject[]): Promise<void> {
    const until = await this.kv.mget(subjects.map((s) => `al:${s.key}`));
    const wait = Math.max(0, ...until.map((u) => (u ? Number(u) - this.now() : 0)));
    if (wait > 0) {
      const retryAfter = Math.max(1, Math.ceil(wait / 1000));
      throw new ApiError(429, 'too_many_attempts', 'Too many tries. Wait a moment, then try again.', { retryAfter }, { 'Retry-After': String(retryAfter) });
    }
  }

  /** Counts a miss against each subject and locks the ones past their free misses. */
  async miss(subjects: readonly Subject[]): Promise<void> {
    await Promise.all(
      subjects.map(async ({ key, rule }) => {
        const { value } = await this.kv.incr(`af:${key}`, rule.windowMs);
        const lockMs = lockMsFor(rule, value);
        if (lockMs > 0) await this.kv.set(`al:${key}`, String(this.now() + lockMs), { ttlMs: lockMs });
      }),
    );
  }

  /** A right password: the account starts over. */
  async clear(subject: Subject): Promise<void> {
    await Promise.all([this.kv.del(`af:${subject.key}`), this.kv.del(`al:${subject.key}`)]);
  }
}
