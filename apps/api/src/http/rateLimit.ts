/**
 * Fixed-window rate limits in the KV store (`rl:{rule}:{key}`, docs/06 §7, docs/10 §2.6).
 * Over the limit → 429 `rate_limited` with `Retry-After`.
 */
import type { Kv } from '../kv/kv';
import { ApiError } from './errors';

export interface RateRule {
  name: string;
  limit: number;
  windowMs: number;
}

/** Every limit the API applies, in one place. IP limits stay loose: carrier-grade NAT puts many players on one address. */
export const LIMITS = {
  /** new guest accounts per IP */
  guestCreate: { name: 'guest', limit: 30, windowMs: 10 * 60_000 },
  /** token refreshes per IP */
  refresh: { name: 'refresh', limit: 60, windowMs: 60_000 },
  /** nickname availability checks per IP (typing in a form) */
  nicknameCheck: { name: 'nickcheck', limit: 60, windowMs: 60_000 },
  /** profile updates per user */
  profileUpdate: { name: 'profile', limit: 20, windowMs: 10 * 60_000 },
  /** custom rooms created, per user and per IP (docs/07 §5.1) */
  roomCreate: { name: 'roomnew', limit: 10, windowMs: 10 * 60_000 },
  roomCreateIp: { name: 'roomnewip', limit: 30, windowMs: 10 * 60_000 },
  /** joins with a code that doesn't exist, per IP (docs/07 §5.1: brute-forcing codes is pointless) */
  roomJoinMiss: { name: 'roommiss', limit: 5, windowMs: 60_000 },
} as const satisfies Record<string, RateRule>;

export async function enforceRateLimit(kv: Kv, rule: RateRule, key: string): Promise<void> {
  const { value, ttlMs } = await kv.incr(`rl:${rule.name}:${key}`, rule.windowMs);
  if (value <= rule.limit) return;
  const retryAfter = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : rule.windowMs) / 1000));
  throw new ApiError(429, 'rate_limited', 'Too many requests, try again later', { retryAfter }, { 'Retry-After': String(retryAfter) });
}
