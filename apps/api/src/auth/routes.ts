/**
 * /auth: guest-first identity (docs/07 §3, §11). `POST /auth/guest` creates users +
 * identities(provider='guest') + profiles + a session in one transaction and returns tokens.
 * Linking Google/Discord/etc. to the same user id comes later (`POST /auth/link/{provider}`).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Config } from '../config';
import { isUniqueViolation, type Db } from '../db/client';
import { identities, profiles as profileTable, users } from '../db/schema';
import { clientIp, clientRateLimitKey, ipPrefix } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import { ApiError, errorResponse, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import { newId } from '../ids';
import type { Kv } from '../kv/kv';
import type { ProfileService } from '../me/profiles';
import { randomGuestNickname } from '../nickname/rules';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './cookie';
import { optionalAuth, requireAuth } from './middleware';
import type { AuthService, DeviceInfo, IssuedRefresh } from './sessions';

export interface AuthRouteDeps {
  config: Config;
  db: Db;
  kv: Kv;
  auth: AuthService;
  profiles: ProfileService;
  now: () => number;
}

const GuestBody = z.object({ nickname: z.string().max(64).optional() });
const RefreshBody = z.object({ refreshToken: z.string().max(256).optional() });
/** retries when a generated guest name collides at insert time */
const GUEST_INSERT_ATTEMPTS = 5;

export function authRoutes(deps: AuthRouteDeps): Hono<AppEnv> {
  const { config, db, kv, auth, profiles, now } = deps;
  const app = new Hono<AppEnv>();

  const device = (c: Context<AppEnv>): DeviceInfo => ({
    userAgent: c.req.header('user-agent') ?? null,
    ipPrefix: ipPrefix(clientIp(c, config)),
  });

  /** The `Session` response: tokens + the user, and the refresh cookie. */
  async function sessionResponse(c: Context<AppEnv>, issued: IssuedRefresh, status: 200 | 201) {
    const me = await profiles.me(issued.userId);
    if (!me) throw new ApiError(500, 'internal_error', 'Session user has no profile');
    setRefreshCookie(c, config.cookie, issued.refreshToken, issued.refreshTokenExpiresAt);
    const access = auth.issueAccessToken(issued.userId, issued.sessionId);
    return c.json(
      {
        accessToken: access.accessToken,
        accessTokenExpiresAt: access.accessTokenExpiresAt.toISOString(),
        refreshToken: issued.refreshToken,
        refreshTokenExpiresAt: issued.refreshTokenExpiresAt.toISOString(),
        user: me,
      },
      status,
    );
  }

  /** A generated name that is free right now (a collision at insert time just retries). */
  async function freeGuestNickname(): Promise<{ nickname: string; norm: string }> {
    const candidates = Array.from({ length: 5 }, () => profiles.policy.check(randomGuestNickname())).flatMap((c) => (c.ok ? [c] : []));
    const taken = await profiles.takenNorms(candidates.map((c) => c.norm));
    const pick = candidates.find((c) => !taken.has(c.norm)) ?? candidates[0];
    if (!pick) throw new Error('guest nickname generator produced no valid name');
    return pick;
  }

  app.post('/guest', async (c) => {
    await enforceRateLimit(kv, LIMITS.guestCreate, clientRateLimitKey(c, config));
    const body = await readJson(c, GuestBody);
    const chosen = body.nickname !== undefined ? await profiles.requireAvailable(body.nickname) : null;

    for (let attempt = 1; ; attempt++) {
      const name = chosen ?? (await freeGuestNickname());
      const at = new Date(now());
      const userId = newId('u', at.getTime());
      try {
        const issued = await db.transaction(async (tx) => {
          await tx.insert(users).values({ id: userId, createdAt: at, lastSeenAt: at });
          await tx.insert(identities).values({ provider: 'guest', providerUid: userId, userId, createdAt: at });
          // a name the player typed counts as their choice (starts the cooldown); a generated one doesn't
          await tx.insert(profileTable).values({ userId, nickname: name.nickname, nicknameNorm: name.norm, nicknameChangedAt: chosen ? at : null });
          return auth.createSession(tx, userId, device(c));
        });
        c.get('log').info({ userId }, 'guest account created');
        return sessionResponse(c, issued, 201);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (chosen) throw await profiles.takenError(chosen.nickname);
        if (attempt >= GUEST_INSERT_ATTEMPTS) throw err;
      }
    }
  });

  app.post('/refresh', async (c) => {
    await enforceRateLimit(kv, LIMITS.refresh, clientRateLimitKey(c, config));
    const body = await readJson(c, RefreshBody);
    const token = body.refreshToken ?? readRefreshCookie(c);
    if (!token) return errorResponse(c, 401, 'invalid_refresh_token', 'No refresh token in the cookie or body');
    const result = await auth.rotate(token, device(c));
    if (!result.ok) {
      clearRefreshCookie(c, config.cookie);
      c.get('log').info({ reason: result.error }, 'refresh rejected');
      return errorResponse(c, result.error === 'account_disabled' ? 403 : 401, result.error, 'Refresh token rejected; sign in again');
    }
    return sessionResponse(c, result, 200);
  });

  app.post('/logout', optionalAuth(auth), async (c) => {
    const body = await readJson(c, RefreshBody);
    const token = body.refreshToken ?? readRefreshCookie(c);
    const revoked = token ? await auth.revokeByRefreshToken(token) : false;
    const bearer = c.get('auth');
    if (!revoked && bearer) await auth.revokeSession(bearer.sessionId);
    clearRefreshCookie(c, config.cookie);
    return c.body(null, 204);
  });

  app.post('/logout-all', requireAuth(auth), async (c) => {
    await auth.revokeAllSessions(c.get('auth')!.userId);
    clearRefreshCookie(c, config.cookie);
    return c.body(null, 204);
  });

  return app;
}
