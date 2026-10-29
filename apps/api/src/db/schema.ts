/**
 * Postgres schema, first cut of docs/06 §7: the identity tables (users, identities, profiles,
 * sessions), the players' saved loadouts, match results with lifetime stats, and friends (friend
 * codes, friendships, requests, blocks). Change it, then `pnpm --filter @military-forge/api db:generate` writes the
 * next migration into drizzle/. Timestamps are always written by the app clock, so tests can
 * move time.
 */
import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const USER_STATUSES = ['active', 'banned', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * How a player signs in (docs/07 §3). Every account starts as a guest; `email` is a saved account
 * (email + password, auth/accounts.ts): its `provider_uid` is the normalised email (trimmed,
 * lowercase), so the primary key keeps each email on one account.
 */
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
    /**
     * The game is 18+ (shared/age.ts): when the player's 18+ answer (the web's age step) came with
     * saving the account or a claim (auth/accountRoutes.ts). null = not yet (a guest: the web keeps
     * the answer on the device).
     */
    adultConfirmedAt: timestamp('adult_confirmed_at', tz),
    /** the birth year they gave with it: never a full date of birth (data minimisation) */
    birthYear: smallint('birth_year'),
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
  /**
   * The short code friends add you by (friends/code.ts: 8 letters and digits, no lookalikes), made
   * the first time it's needed; null until then. A new code (rotate) retires the old one.
   */
  friendCode: text('friend_code').unique(),
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

/**
 * A saved account's password (auth/passwords.ts): Argon2id, PHC string with its own salt and
 * parameters. One per user; the email it goes with is the user's `identities` row (provider 'email').
 */
export const passwordCredentials = pgTable('password_credentials', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', tz).notNull(),
  /** the last change (save, change, reset) */
  updatedAt: timestamp('updated_at', tz).notNull(),
});

export const EMAIL_TOKEN_PURPOSES = ['reset', 'save'] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

/**
 * Single-use links sent by email (auth/accounts.ts): `reset` (forgot password, 30 minutes) and
 * `save` (confirm the email a guest is saving their account with, 24 hours). The link carries
 * `<id>.<secret>`; only sha256 of the secret is kept. A `save` row also holds the email and the
 * Argon2id hash of the password chosen, which become the account's once the link is opened.
 */
export const emailTokens = pgTable(
  'email_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: EMAIL_TOKEN_PURPOSES }).notNull(),
    tokenHash: text('token_hash').notNull(),
    /** save: the normalised email being confirmed */
    email: text('email'),
    /** save: the password's Argon2id hash */
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', tz).notNull(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    /** set once: used, or replaced by a newer link, or cancelled by a password change */
    usedAt: timestamp('used_at', tz),
  },
  (t) => [index('email_tokens_user_id_idx').on(t.userId), check('email_tokens_purpose_check', sql`${t.purpose} in ('reset', 'save')`)],
);

/** How many saved loadouts a player has (docs/04 §6: three presets); the game uses slot 0 for now. */
export const LOADOUT_SLOT_COUNT = 3;

/** What a loadout row holds (validated against @military-forge/content on every write: loadouts/validate.ts). */
export interface LoadoutData {
  /** the Locker look: one cosmetic id per slot, one dye id per channel */
  look: { items: Record<string, string>; dyes: Record<string, string> };
  /** the two guns the player spawns with, by weapon id (not index: indices may move) */
  guns: [string, string];
}

/** A player's saved loadouts (docs/06 §7 `loadouts(user_id, slot, data jsonb)`), one row per preset slot. */
export const loadouts = pgTable(
  'loadouts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slot: smallint('slot').notNull(),
    data: jsonb('data').$type<LoadoutData>().notNull(),
    updatedAt: timestamp('updated_at', tz).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.slot] }), check('loadouts_slot_check', sql`${t.slot} between 0 and ${sql.raw(String(LOADOUT_SLOT_COUNT - 1))}`)],
);

/**
 * One row per finished match, written once (the game server's match id is the key: a retried
 * report changes nothing). `result` keeps the whole report as sent, bots' counts included.
 */
export const matches = pgTable(
  'matches',
  {
    id: text('id').primaryKey(),
    mode: text('mode').notNull(),
    map: text('map').notNull(),
    room: text('room').notNull(),
    startedAt: timestamp('started_at', tz).notNull(),
    endedAt: timestamp('ended_at', tz).notNull(),
    durationS: integer('duration_s').notNull(),
    serverBuild: text('server_build').notNull(),
    result: jsonb('result').notNull(),
    recordedAt: timestamp('recorded_at', tz).notNull(),
  },
  (t) => [index('matches_ended_at_idx').on(t.endedAt)],
);

/** A person's line in a match (bots never get one). */
export const matchPlayers = pgTable(
  'match_players',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    placement: smallint('placement').notNull(),
    score: integer('score').notNull(),
    kills: integer('kills').notNull(),
    deaths: integer('deaths').notNull(),
    assists: integer('assists').notNull(),
    damage: integer('damage').notNull(),
    damageTaken: integer('damage_taken').notNull(),
    headshots: integer('headshots').notNull(),
    bestStreak: integer('best_streak').notNull(),
    left: boolean('left').notNull(),
    mvp: boolean('mvp').notNull(),
    xpGained: integer('xp_gained').notNull(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.userId] }), index('match_players_user_id_idx').on(t.userId)],
);

/** `weapon_id` for the all-weapons totals row in stats_lifetime. */
export const ALL_WEAPONS = '*';

/**
 * Lifetime totals per player (docs/06 §7): one `*` row with everything, plus one row per kill
 * source (a weapon id, or melee / grenade / mine / gas / world) with its kills.
 */
export const statsLifetime = pgTable(
  'stats_lifetime',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    weaponId: text('weapon_id').notNull(),
    matches: integer('matches').notNull().default(0),
    wins: integer('wins').notNull().default(0),
    kills: integer('kills').notNull().default(0),
    deaths: integer('deaths').notNull().default(0),
    assists: integer('assists').notNull().default(0),
    damage: integer('damage').notNull().default(0),
    headshots: integer('headshots').notNull().default(0),
    bestStreak: integer('best_streak').notNull().default(0),
    playtimeS: integer('playtime_s').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.weaponId] })],
);

/**
 * Friendships, stored both ways (one row per side), so "my friends" is one indexed lookup and
 * either side removing it deletes both rows (friends/service.ts).
 */
export const friendships = pgTable(
  'friendships',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    friendId: text('friend_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.friendId] }), index('friendships_friend_id_idx').on(t.friendId), check('friendships_not_self', sql`${t.userId} <> ${t.friendId}`)],
);

/** A friend request waiting for an answer (from → to). Accepting turns it into a friendship. */
export const friendRequests = pgTable(
  'friend_requests',
  {
    fromId: text('from_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toId: text('to_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [primaryKey({ columns: [t.fromId, t.toId] }), index('friend_requests_to_id_idx').on(t.toId), check('friend_requests_not_self', sql`${t.fromId} <> ${t.toId}`)],
);

/**
 * Blocks (one way: `userId` blocked `blockedId`). A block ends any friendship and request between
 * the two; the blocked player is never told, and their requests and invites go nowhere.
 */
export const blocks = pgTable(
  'blocks',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: text('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.blockedId] }), index('blocks_blocked_id_idx').on(t.blockedId), check('blocks_not_self', sql`${t.userId} <> ${t.blockedId}`)],
);

// ---------------------------------------------------------------- the store (docs/17 §2, docs/06 §7)

/** The currency's two pools (docs/17 §2.5): bought with money, or given (grants). Kept apart for refunds and revenue. */
export const LEDGER_POOLS = ['paid', 'earned'] as const;
export type LedgerPool = (typeof LEDGER_POOLS)[number];

/**
 * Why currency moved: `purchase` (money in, paid pool, ref = the payment), `grant` (given, earned pool), `spend`
 * (an item bought, ref = the order), `refund` (paid currency taken back as its money goes back, ref = the payment's
 * refund attempt), `reversal` (undoes an earlier row: a refund the provider refused), `adjust` (the owner, with a reason).
 */
export const LEDGER_KINDS = ['purchase', 'grant', 'spend', 'refund', 'reversal', 'adjust'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/**
 * One row per account with its balance per pool: a cache of the ledger, written in the same transaction as the
 * ledger rows and locked (`for update`) while they're written. Never negative (checks). `monthly_cap_cents` is the
 * spending limit in USD-tier cents (docs/17 §2.6); a raise waits in `cap_raise_*` until `cap_raise_at`.
 * `flagged_*`: a mint alarm (store/wallet.ts) for the owner to look at.
 */
export const wallets = pgTable(
  'wallets',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    paid: integer('paid').notNull().default(0),
    earned: integer('earned').notNull().default(0),
    version: integer('version').notNull().default(0),
    monthlyCapCents: integer('monthly_cap_cents').notNull().default(10_000),
    capRaiseCents: integer('cap_raise_cents'),
    capRaiseAt: timestamp('cap_raise_at', tz),
    flaggedAt: timestamp('flagged_at', tz),
    flagReason: text('flag_reason'),
    updatedAt: timestamp('updated_at', tz).notNull(),
  },
  (t) => [check('wallets_paid_check', sql`${t.paid} >= 0`), check('wallets_earned_check', sql`${t.earned} >= 0`), index('wallets_flagged_at_idx').on(t.flaggedAt)],
);

/**
 * The currency ledger (docs/17 §2.5): append-only (a trigger refuses UPDATE, and DELETE except the cascade of an
 * account's deletion). `balance_after` is the pool's balance after the row, so the latest row per pool equals the
 * wallet and the rows sum to it (store/wallet.ts reconcile). `ref` is unique per kind and pool: a replayed webhook,
 * a double redirect or a retried buy can't move currency twice.
 */
export const ledger = pgTable(
  'ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pool: text('pool', { enum: LEDGER_POOLS }).notNull(),
    kind: text('kind', { enum: LEDGER_KINDS }).notNull(),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    ref: text('ref').notNull(),
    /** the item bought, the bundle, or the owner's reason */
    note: text('note'),
    /** who moved it: player, flutterwave, owner, system */
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [
    uniqueIndex('ledger_kind_pool_ref_idx').on(t.kind, t.pool, t.ref),
    index('ledger_user_id_idx').on(t.userId, t.id),
    check('ledger_pool_check', sql`${t.pool} in ('paid', 'earned')`),
    check('ledger_kind_check', sql`${t.kind} in ('purchase', 'grant', 'spend', 'refund', 'reversal', 'adjust')`),
    check('ledger_delta_check', sql`${t.delta} <> 0`),
    check('ledger_balance_after_check', sql`${t.balanceAfter} >= 0`),
  ],
);

export const PAYMENT_STATUSES = ['created', 'paid', 'failed', 'refund_pending', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Money in (docs/06 §7 `purchases`): one row per checkout. Its id is the provider's `tx_ref`, made here, so a
 * payment is only ever matched to the checkout the server opened. `amount_minor` and `currency` are what the
 * provider must report before anything is credited; `cap_cents` is the bundle's USD-tier price, what the
 * spending limit counts. Kept when the account is deleted (user_id goes null): the money record outlives it.
 */
export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    bundleId: text('bundle_id').notNull(),
    brass: integer('brass').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    capCents: integer('cap_cents').notNull(),
    status: text('status', { enum: PAYMENT_STATUSES }).notNull(),
    /** the provider's transaction id, once it reported one */
    providerTxId: text('provider_tx_id').unique(),
    createdAt: timestamp('created_at', tz).notNull(),
    paidAt: timestamp('paid_at', tz),
    refundedAt: timestamp('refunded_at', tz),
    refundAttempts: smallint('refund_attempts').notNull().default(0),
    /** the provider's refund id */
    refundRef: text('refund_ref'),
  },
  (t) => [
    index('payments_user_id_idx').on(t.userId, t.createdAt),
    index('payments_status_idx').on(t.status, t.createdAt),
    check('payments_status_check', sql`${t.status} in ('created', 'paid', 'failed', 'refund_pending', 'refunded')`),
    check('payments_amount_check', sql`${t.amountMinor} > 0 and ${t.brass} > 0`),
  ],
);

/**
 * What an account owns (docs/06 §7 `inventory`): store items bought or granted. Unlocks exactly like the owner's
 * COSMETIC_GRANTS (content's cosmeticUnlocked with the ids, `includes` and all): the Locker, the saved loadout
 * and the join ticket read the two together (store/wallet.ts owned()).
 */
export const inventory = pgTable(
  'inventory',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(),
    /** purchase (ref = the order) or grant (ref = the owner's action) */
    source: text('source').notNull(),
    ref: text('ref').notNull(),
    acquiredAt: timestamp('acquired_at', tz).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemId] })],
);

/**
 * The owner's store actions (grants, adjustments, refunds, cleared flags), each with its reason: append-only like
 * the ledger, and kept when the account goes (user_id is plain text, no foreign key).
 */
export const storeAudit = pgTable(
  'store_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', tz).notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    userId: text('user_id'),
    reason: text('reason').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index('store_audit_user_id_idx').on(t.userId, t.id)],
);
