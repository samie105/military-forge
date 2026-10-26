/**
 * Saved accounts (email + password) on top of guest accounts (docs/07 §3 "upgrade, don't migrate").
 *
 * - **Save:** a guest adds an email and password to the account they already have: the same user
 *   id, so the name, soldier, loadouts, friends and stats stay as they are. The email is an
 *   `identities` row (provider 'email', normalised), the hash a `password_credentials` row.
 * - **Sign in on another device:** a new session for that account (auth/accountRoutes.ts).
 * - **Emailed links** (`email_tokens`): `<id>.<secret>`, single use, sha256 of the secret at rest;
 *   making a new link of a kind cancels the user's older ones of that kind.
 *
 * Progress, for "never drop a guest that has some" (accountRoutes.ts, the sign-in rule): XP or a
 * level, a name the player chose, a match played, a friend or friend request, or a saved loadout.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { emailTokens, friendRequests, friendships, identities, loadouts, matchPlayers, passwordCredentials, profiles, users, type EmailTokenPurpose, type UserStatus } from '../db/schema';
import { newId } from '../ids';

export const RESET_TTL_MS = 30 * 60_000;
export const SAVE_TTL_MS = 24 * 3_600_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function parseToken(token: string): { id: string; secret: string } | null {
  const m = /^(t_[0-9a-z]{26})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

export interface Credential {
  userId: string;
  passwordHash: string;
  status: UserStatus;
}

export interface UsedToken {
  userId: string;
  email: string | null;
  passwordHash: string | null;
}

export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** The account an email signs in to, with its hash; null when no account has that email. */
  async lookup(email: string): Promise<Credential | null> {
    const [row] = await this.db
      .select({ userId: identities.userId, passwordHash: passwordCredentials.passwordHash, status: users.status })
      .from(identities)
      .innerJoin(passwordCredentials, eq(passwordCredentials.userId, identities.userId))
      .innerJoin(users, eq(users.id, identities.userId))
      .where(and(eq(identities.provider, 'email'), eq(identities.providerUid, email)));
    return row ?? null;
  }

  /** The signed-in player's own email and hash (null: a guest, not saved yet). */
  async credentialOf(userId: string): Promise<{ email: string; passwordHash: string } | null> {
    const [row] = await this.db
      .select({ email: identities.providerUid, passwordHash: passwordCredentials.passwordHash })
      .from(identities)
      .innerJoin(passwordCredentials, eq(passwordCredentials.userId, identities.userId))
      .where(and(eq(identities.userId, userId), eq(identities.provider, 'email')));
    return row ?? null;
  }

  /** Only a guest identity (no email or other sign-in yet). */
  async isGuest(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(identities)
      .where(and(eq(identities.userId, userId), ne(identities.provider, 'guest')));
    return (row?.n ?? 0) === 0;
  }

  /** Anything a player would miss: see the file comment. */
  async hasProgress(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({
        level: profiles.level,
        xp: profiles.xp,
        named: profiles.nicknameChangedAt,
        more: sql<boolean>`(
          exists (select 1 from ${matchPlayers} where ${matchPlayers.userId} = ${userId})
          or exists (select 1 from ${friendships} where ${friendships.userId} = ${userId})
          or exists (select 1 from ${friendRequests} where ${friendRequests.fromId} = ${userId} or ${friendRequests.toId} = ${userId})
          or exists (select 1 from ${loadouts} where ${loadouts.userId} = ${userId})
        )`,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId));
    return !!row && (row.level > 1 || row.xp > 0 || row.named !== null || row.more);
  }

  /**
   * Saves the account: the email identity and the password, together. Throws a unique violation
   * (db/client.ts isUniqueViolation) when the email belongs to another account or this one is saved already.
   */
  async link(userId: string, email: string, passwordHash: string): Promise<void> {
    const at = new Date(this.now());
    await this.db.transaction(async (tx) => {
      await tx.insert(passwordCredentials).values({ userId, passwordHash, createdAt: at, updatedAt: at });
      await tx.insert(identities).values({ provider: 'email', providerUid: email, userId, createdAt: at });
    });
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.update(passwordCredentials).set({ passwordHash, updatedAt: new Date(this.now()) }).where(eq(passwordCredentials.userId, userId));
  }

  /** A guest nobody will miss, removed (cascades to its profile and sessions). Never a saved account. */
  async discardGuest(userId: string): Promise<boolean> {
    const gone = await this.db
      .delete(users)
      .where(and(eq(users.id, userId), sql`not exists (select 1 from ${identities} where ${identities.userId} = ${userId} and ${identities.provider} <> 'guest')`))
      .returning({ id: users.id });
    return gone.length > 0;
  }

  /** A new emailed link; the user's earlier unused links of the same kind stop working. */
  async createToken(userId: string, purpose: EmailTokenPurpose, ttlMs: number, extra: { email?: string; passwordHash?: string } = {}): Promise<string> {
    const at = this.now();
    const id = newId('t', at);
    const secret = randomBytes(32).toString('base64url');
    await this.db.transaction(async (tx) => {
      await this.cancelTokensIn(tx, userId, purpose);
      await tx.insert(emailTokens).values({
        id,
        userId,
        purpose,
        tokenHash: sha256(secret),
        email: extra.email ?? null,
        passwordHash: extra.passwordHash ?? null,
        createdAt: new Date(at),
        expiresAt: new Date(at + ttlMs),
      });
    });
    return `${id}.${secret}`;
  }

  /** The link's user while it is still good (unused, unexpired, the right kind and secret), without using it. */
  async peekToken(token: string, purpose: EmailTokenPurpose): Promise<UsedToken | null> {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const [row] = await this.db.select().from(emailTokens).where(eq(emailTokens.id, parsed.id));
    if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt.getTime() <= this.now()) return null;
    if (!sameHash(sha256(parsed.secret), row.tokenHash)) return null;
    return { userId: row.userId, email: row.email, passwordHash: row.passwordHash };
  }

  /** Uses the link up: null when it isn't good, or another request used it first. */
  async useToken(token: string, purpose: EmailTokenPurpose): Promise<UsedToken | null> {
    const good = await this.peekToken(token, purpose);
    if (!good) return null;
    const at = new Date(this.now());
    const used = await this.db
      .update(emailTokens)
      .set({ usedAt: at })
      .where(and(eq(emailTokens.id, parseToken(token)!.id), isNull(emailTokens.usedAt)))
      .returning({ id: emailTokens.id });
    return used.length ? good : null;
  }

  /** Every unused link of the user's (of one kind, or all) stops working. */
  async cancelTokens(userId: string, purpose?: EmailTokenPurpose): Promise<void> {
    await this.cancelTokensIn(this.db, userId, purpose);
  }

  private async cancelTokensIn(db: Pick<Db, 'update'>, userId: string, purpose?: EmailTokenPurpose): Promise<void> {
    await db
      .update(emailTokens)
      .set({ usedAt: new Date(this.now()) })
      .where(and(eq(emailTokens.userId, userId), isNull(emailTokens.usedAt), purpose ? eq(emailTokens.purpose, purpose) : undefined));
  }
}
