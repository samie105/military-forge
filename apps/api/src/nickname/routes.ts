/** /nicknames/check: live validation + availability while a player types a name. */
import { Hono } from 'hono';
import { z } from 'zod';
import { optionalAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Config } from '../config';
import { clientRateLimitKey } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import type { ProfileService } from '../me/profiles';

const Query = z.object({ nickname: z.string().max(64) });

export function nicknameRoutes(deps: { config: Config; kv: Kv; auth: AuthService; profiles: ProfileService }): Hono<AppEnv> {
  const { config, kv, auth, profiles } = deps;
  const app = new Hono<AppEnv>();

  app.get('/check', optionalAuth(auth), async (c) => {
    await enforceRateLimit(kv, LIMITS.nicknameCheck, clientRateLimitKey(c, config));
    const query = Query.safeParse(c.req.query());
    if (!query.success) throw new ApiError(400, 'invalid_request', 'Pass ?nickname= (at most 64 characters)');
    // signed in: your own current name counts as available
    return c.json(await profiles.availability(query.data.nickname, c.get('auth')?.userId));
  });

  return app;
}
