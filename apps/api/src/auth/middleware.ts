/** Bearer-token middleware. */
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import type { AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import type { AuthService } from './sessions';

function bearer(header: string | undefined): string | null {
  const m = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return m ? m[1]! : null;
}

/** 401 unless the request carries a valid access token for a live session. */
export function requireAuth(auth: AuthService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) throw new ApiError(401, 'unauthorized', 'Missing bearer token', {}, { 'WWW-Authenticate': 'Bearer' });
    const claims = auth.verifyAccessToken(token);
    if (!claims) throw new ApiError(401, 'invalid_token', 'Access token is invalid or expired', {}, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    if (!(await auth.sessionActive(claims.sid, claims.sub))) throw new ApiError(401, 'session_revoked', 'This session has ended');
    c.set('auth', { userId: claims.sub, sessionId: claims.sid });
    await next();
  };
}

/** Sets `auth` when a validly signed, unexpired token is present; never rejects. */
export function optionalAuth(auth: AuthService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    const claims = token ? auth.verifyAccessToken(token) : null;
    c.set('auth', claims ? { userId: claims.sub, sessionId: claims.sid } : null);
    await next();
  };
}

/**
 * 403 `adults_only` for an account whose device said under 18 (users.minor, audit-2 L-03): friends,
 * requests, invites, the party and online rooms are for adults; training needs none of them. After
 * requireAuth.
 */
export function adultsOnly(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const userId = c.get('auth')?.userId;
    if (userId) {
      const [row] = await db.select({ minor: users.minor }).from(users).where(eq(users.id, userId));
      if (row?.minor) throw new ApiError(403, 'adults_only', 'Online play and friends are for players 18 and over. Training against bots is open to everyone.');
    }
    await next();
  };
}
