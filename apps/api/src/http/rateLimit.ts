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
  /** loadout saves per user (the web client batches a Locker session's changes into one) */
  loadoutSave: { name: 'loadout', limit: 60, windowMs: 10 * 60_000 },
  /** presence beats per user (the web client sends one every 30 s) */
  presence: { name: 'presence', limit: 12, windowMs: 60_000 },
  /** custom rooms created, per user and per IP (docs/07 §5.1) */
  roomCreate: { name: 'roomnew', limit: 10, windowMs: 10 * 60_000 },
  roomCreateIp: { name: 'roomnewip', limit: 30, windowMs: 10 * 60_000 },
  /** joins with a code that doesn't exist, per IP (docs/07 §5.1: brute-forcing codes is pointless) */
  roomJoinMiss: { name: 'roommiss', limit: 5, windowMs: 60_000 },
  /**
   * friend requests by name or code, hits and misses alike, per user and per IP: finding out who
   * exists by name stays slow (the friends panel's Add a friend)
   */
  friendLookup: { name: 'friendlook', limit: 20, windowMs: 10 * 60_000 },
  friendLookupIp: { name: 'friendlookip', limit: 60, windowMs: 10 * 60_000 },
  /** reading the friends list, per user (the panel refreshes every 30 s while open) */
  friendsRead: { name: 'friends', limit: 60, windowMs: 60_000 },
  /** accept, decline, cancel, remove, block, unblock, a new code, invite answers, leaving a party: per user */
  friendWrite: { name: 'friendwrite', limit: 120, windowMs: 10 * 60_000 },
  /** invites sent, per user (the same invite again waits 5 s: invites/service.ts) */
  inviteSend: { name: 'invite', limit: 40, windowMs: 10 * 60_000 },
  /** push-channel connects per user (GET /events; one per tab every ~15 min, more on a bad network) */
  eventsConnect: { name: 'events', limit: 30, windowMs: 60_000 },
  /** problem reports per IP (Send a report, and the automatic one a failed connection sends) */
  report: { name: 'report', limit: 6, windowMs: 10 * 60_000 },
  /**
   * Saved accounts (auth/accountRoutes.ts). Wrong passwords also back off per account and per IP
   * (auth/throttle.ts); these cap the requests themselves, right or wrong.
   */
  /** sign-ins per IP */
  login: { name: 'login', limit: 30, windowMs: 10 * 60_000 },
  /** "Save your account" tries, per user and per IP */
  accountSave: { name: 'acctsave', limit: 5, windowMs: 60 * 60_000 },
  accountSaveIp: { name: 'acctsaveip', limit: 20, windowMs: 60 * 60_000 },
  /** password changes per user */
  passwordChange: { name: 'pwchange', limit: 10, windowMs: 60 * 60_000 },
  /** "Forgot password?" per IP (per email: at most 3 emails an hour, silently) */
  forgot: { name: 'forgot', limit: 5, windowMs: 10 * 60_000 },
  /** an emailed link opened (reset, confirm) per IP */
  emailLink: { name: 'emaillink', limit: 20, windowMs: 10 * 60_000 },
} as const satisfies Record<string, RateRule>;

export async function enforceRateLimit(kv: Kv, rule: RateRule, key: string): Promise<void> {
  const { value, ttlMs } = await kv.incr(`rl:${rule.name}:${key}`, rule.windowMs);
  if (value <= rule.limit) return;
  const retryAfter = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : rule.windowMs) / 1000));
  throw new ApiError(429, 'rate_limited', 'Too many requests, try again later', { retryAfter }, { 'Retry-After': String(retryAfter) });
}
