/** /me: the signed-in player's own account (docs/07 §11). */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { clearRefreshCookie } from '../auth/cookie';
import { requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import type { ProfileService } from './profiles';

const PatchMe = z.object({ nickname: z.string().max(64) });

export function meRoutes(deps: { config: Config; db: Db; kv: Kv; auth: AuthService; profiles: ProfileService }): Hono<AppEnv> {
  const { config, db, kv, auth, profiles } = deps;
  const app = new Hono<AppEnv>();
  app.use(requireAuth(auth));

  app.get('/', async (c) => {
    const me = await profiles.me(c.get('auth')!.userId);
    if (!me) throw new ApiError(404, 'not_found', 'Account not found');
    return c.json(me);
  });

  app.patch('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.profileUpdate, userId);
    const body = await readJson(c, PatchMe);
    return c.json(await profiles.changeNickname(userId, body.nickname));
  });

  /** Account deletion (docs/10 §7 data rights): the user row cascades to identities, profile and sessions. */
  app.delete('/', async (c) => {
    const { userId } = c.get('auth')!;
    await db.delete(users).where(eq(users.id, userId));
    c.get('log').info({ userId }, 'account deleted');
    clearRefreshCookie(c, config.cookie);
    return c.body(null, 204);
  });

  return app;
}
