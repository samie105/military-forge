/**
 * Sessions and tokens (docs/07 §3, docs/10 §2.6).
 *
 * - **Access token:** Ed25519 JWT `{sub, sid}`, 15 min by default, held in memory by the client.
 *   Every authenticated request also checks the session row, so logout, logout-all and bans
 *   take effect at once rather than when the token expires.
 * - **Refresh token:** `<sessionId>.<secret>`, single use. The database keeps only sha256 hashes
 *   of the current and previous secrets. Each refresh rotates the secret and slides the expiry.
 *   The next secret is derived from the presented one with a server-side HMAC key, so the server
 *   can say again which secret followed a given one without storing it.
 * - **Reuse detection:** presenting the *previous* secret means it was copied, or two tabs raced.
 *   Within {@link REUSE_GRACE_MS} of the rotation it is treated as a race: nothing rotates and the
 *   caller gets the *current* token again, the very one the winning tab got. Both tabs end up with
 *   the same token, whichever one's cookie or localStorage write lands last, so neither holds a
 *   token that was demoted behind its back. After the window the whole session is revoked.
 *   Clients must keep the refresh token in storage shared by their tabs (the cookie, or
 *   localStorage) and read it again right before refreshing.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { sessions, users } from '../db/schema';
import { newId } from '../ids';
import type { SigningKey } from './keys';
import { ACCESS_AUDIENCE, ACCESS_ISSUER, signJwt, verifyJwt, type AccessClaims } from './tokens';

/** two tabs refreshing on load at the same moment must not log each other out */
export const REUSE_GRACE_MS = 30_000;

export interface DeviceInfo {
  userAgent: string | null;
  ipPrefix: string | null;
}

export interface IssuedRefresh {
  userId: string;
  sessionId: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export type RotateResult = ({ ok: true } & IssuedRefresh) | { ok: false; error: 'invalid_refresh_token' | 'session_revoked' | 'account_disabled' };

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const uaHash = (ua: string | null) => (ua ? createHash('sha256').update(ua).digest('hex').slice(0, 16) : null);

function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const m = /^(s_[0-9a-z]{26})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return m ? { sessionId: m[1]!, secret: m[2]! } : null;
}

export class AuthService {
  /** HMAC key for {@link successorSecret}, derived from the signing key so there is no extra secret to deploy */
  private readonly refreshKey: Buffer;

  constructor(
    private readonly db: Db,
    private readonly key: SigningKey,
    private readonly config: Pick<Config, 'accessToken' | 'refreshTokenTtlDays'>,
    private readonly now: () => number,
  ) {
    this.refreshKey = createHash('sha256')
      .update('military-forge refresh-token successor v1\0')
      .update(key.privateKey.export({ type: 'pkcs8', format: 'der' }))
      .digest();
  }

  /** The secret that replaces `secret` when it is rotated. Unguessable without the server key. */
  private successorSecret(sessionId: string, secret: string): string {
    return createHmac('sha256', this.refreshKey).update(`${sessionId}.${secret}`).digest('base64url');
  }

  private get refreshTtlMs(): number {
    return this.config.refreshTokenTtlDays * 86_400_000;
  }

  issueAccessToken(userId: string, sessionId: string): { accessToken: string; accessTokenExpiresAt: Date } {
    const iat = Math.floor(this.now() / 1000);
    const exp = iat + this.config.accessToken.ttlSeconds;
    const claims: AccessClaims = { iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: userId, sid: sessionId, iat, exp };
    return { accessToken: signJwt(claims, this.key.privateKey), accessTokenExpiresAt: new Date(exp * 1000) };
  }

  /** Signature and expiry only; see {@link sessionActive} for revocation. */
  verifyAccessToken(token: string): AccessClaims | null {
    const res = verifyJwt<AccessClaims>(token, this.key.publicKey, {
      iss: ACCESS_ISSUER,
      aud: ACCESS_AUDIENCE,
      nowSeconds: Math.floor(this.now() / 1000),
    });
    return res.ok && typeof res.claims.sid === 'string' ? res.claims : null;
  }

  /** The session exists, isn't revoked or expired, and its user is active. */
  async sessionActive(sessionId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ expiresAt: sessions.expiresAt, status: users.status })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    return !!row && row.status === 'active' && row.expiresAt.getTime() > this.now();
  }

  /** New session for a user, inside the caller's transaction (account creation). */
  async createSession(tx: Tx, userId: string, device: DeviceInfo): Promise<IssuedRefresh> {
    const now = new Date(this.now());
    const sessionId = newId('s', now.getTime());
    const secret = randomBytes(32).toString('base64url');
    const refreshTokenExpiresAt = new Date(now.getTime() + this.refreshTtlMs);
    await tx.insert(sessions).values({
      id: sessionId,
      userId,
      refreshHash: sha256(secret),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: refreshTokenExpiresAt,
      uaHash: uaHash(device.userAgent),
      ipPrefix: device.ipPrefix,
    });
    return { userId, sessionId, refreshToken: `${sessionId}.${secret}`, refreshTokenExpiresAt };
  }

  async rotate(refreshToken: string, device: DeviceInfo): Promise<RotateResult> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return { ok: false, error: 'invalid_refresh_token' };
    return this.db.transaction(async (tx): Promise<RotateResult> => {
      const [s] = await tx
        .select({ session: sessions, status: users.status })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.id, parsed.sessionId))
        .for('update', { of: sessions });
      if (!s) return { ok: false, error: 'invalid_refresh_token' };
      const { session } = s;
      const now = this.now();
      if (session.revokedAt) return { ok: false, error: 'session_revoked' };
      if (session.expiresAt.getTime() <= now) return { ok: false, error: 'invalid_refresh_token' };

      const presented = sha256(parsed.secret);
      const current = sameHash(presented, session.refreshHash);
      const previous = !current && session.prevRefreshHash !== null && sameHash(presented, session.prevRefreshHash);
      if (!current && !previous) return { ok: false, error: 'invalid_refresh_token' };
      if (previous && (!session.rotatedAt || now - session.rotatedAt.getTime() > REUSE_GRACE_MS)) {
        await tx.update(sessions).set({ revokedAt: new Date(now) }).where(eq(sessions.id, session.id));
        return { ok: false, error: 'session_revoked' };
      }
      if (s.status !== 'active') return { ok: false, error: 'account_disabled' };

      if (previous) {
        // two tabs raced: hand back the token the winner got, and leave the session as it is
        const winner = this.successorSecret(session.id, parsed.secret);
        if (!sameHash(sha256(winner), session.refreshHash)) return { ok: false, error: 'invalid_refresh_token' }; // key changed since
        return { ok: true, userId: session.userId, sessionId: session.id, refreshToken: `${session.id}.${winner}`, refreshTokenExpiresAt: session.expiresAt };
      }

      const secret = this.successorSecret(session.id, parsed.secret);
      const refreshTokenExpiresAt = new Date(now + this.refreshTtlMs);
      await tx
        .update(sessions)
        .set({
          refreshHash: sha256(secret),
          prevRefreshHash: session.refreshHash,
          rotatedAt: new Date(now),
          lastUsedAt: new Date(now),
          expiresAt: refreshTokenExpiresAt,
          uaHash: uaHash(device.userAgent),
          ipPrefix: device.ipPrefix,
        })
        .where(eq(sessions.id, session.id));
      await tx.update(users).set({ lastSeenAt: new Date(now) }).where(eq(users.id, session.userId));
      return { ok: true, userId: session.userId, sessionId: session.id, refreshToken: `${session.id}.${secret}`, refreshTokenExpiresAt };
    });
  }

  /** Logout with a refresh token: only its rightful holder (current or previous secret) can revoke it. */
  async revokeByRefreshToken(refreshToken: string): Promise<boolean> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return false;
    const [session] = await this.db.select().from(sessions).where(eq(sessions.id, parsed.sessionId));
    if (!session) return false;
    const presented = sha256(parsed.secret);
    const matches = sameHash(presented, session.refreshHash) || (session.prevRefreshHash !== null && sameHash(presented, session.prevRefreshHash));
    if (!matches) return false;
    await this.revokeSession(session.id);
    return true;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date(this.now()) })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date(this.now()) })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }
}
