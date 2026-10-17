/**
 * Postgres schema, first cut of docs/06 §7: the identity tables only (users, identities,
 * profiles, sessions). Change it, then `pnpm --filter @military-forge/api db:generate` writes the
 * next migration into drizzle/. Timestamps are always written by the app clock, so tests can
 * move time.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const USER_STATUSES = ['active', 'banned', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** guest now; linked providers arrive with account linking (docs/07 §3) */
export const IDENTITY_PROVIDERS = ['guest', 'google', 'discord', 'apple', 'email'] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

const tz = { withTimezone: true } as const;

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
    createdAt: timestamp('created_at', tz).notNull(),
    /** bumped on every token refresh; drives the 30-day cleanup of idle guests (docs/07 §3) */
    lastSeenAt: timestamp('last_seen_at', tz).notNull(),
  },
  (t) => [
    check('users_status_check', sql`${t.status} in ('active', 'banned', 'deleted')`),
    index('users_last_seen_at_idx').on(t.lastSeenAt),
  ],
);

export const identities = pgTable(
  'identities',
  {
    provider: text('provider', { enum: IDENTITY_PROVIDERS }).notNull(),
    /** guests: the user id itself */
    providerUid: text('provider_uid').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerUid] }), index('identities_user_id_idx').on(t.userId)],
);

export const profiles = pgTable('profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** display form (NFKC, trimmed) */
  nickname: text('nickname').notNull(),
  /** confusable skeleton (nickname/normalize.ts): one name per skeleton */
  nicknameNorm: text('nickname_norm').notNull().unique(),
  /** last change the player chose; null = still the generated guest name (first change is free) */
  nicknameChangedAt: timestamp('nickname_changed_at', tz),
  level: integer('level').notNull().default(1),
  xp: integer('xp').notNull().default(0),
});

/** One row per signed-in device: the refresh token family (auth/sessions.ts). */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the current refresh secret */
    refreshHash: text('refresh_hash').notNull(),
    /** sha256 of the previous secret: a replay of it outside the grace window revokes the session */
    prevRefreshHash: text('prev_refresh_hash'),
    rotatedAt: timestamp('rotated_at', tz),
    createdAt: timestamp('created_at', tz).notNull(),
    lastUsedAt: timestamp('last_used_at', tz).notNull(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    revokedAt: timestamp('revoked_at', tz),
    /** truncated sha256 of the User-Agent, and the IP's /24 (v4) or /48 (v6): enough for "your devices", no raw PII */
    uaHash: text('ua_hash'),
    ipPrefix: text('ip_prefix'),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);
