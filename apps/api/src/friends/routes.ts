/**
 * /friends (the owner's 23 Oct ask; docs/07 §13): the signed-in player's friends, requests and
 * blocks. Every route needs a session; lookups by name or code are rate limited per user and per
 * IP, hits and misses alike, so nobody can sweep the player list.
 *
 *   GET    /friends                      → FriendsList (your code, friends with presence, requests, blocks)
 *   POST   /friends/requests { name } | { code } → { status: 'requested', user } | { status: 'friends', friend }
 *   POST   /friends/requests/:id/accept  → { friend }
 *   POST   /friends/requests/:id/decline → 204
 *   DELETE /friends/requests/:id         → 204 (take back your request)
 *   DELETE /friends/:id                  → 204 (unfriend)
 *   POST   /friends/blocks { id }        → 204 (also ends a friendship and requests)
 *   DELETE /friends/blocks/:id           → 204
 *   POST   /friends/code                 → { code } (a new friend code; the old one stops working)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Config } from '../config';
import { clientRateLimitKey } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import { formatFriendCode } from './code';
import { USER_ID, type FriendsService } from './service';

const RequestBody = z.union([z.strictObject({ name: z.string().min(1).max(64) }), z.strictObject({ code: z.string().min(1).max(32) })]);
const BlockBody = z.strictObject({ id: z.string().regex(USER_ID) });

function userParam(raw: string): string {
  if (!USER_ID.test(raw)) throw new ApiError(400, 'invalid_player_id', 'Not a player id');
  return raw;
}

export function friendRoutes(deps: { config: Config; kv: Kv; auth: AuthService; friends: FriendsService }): Hono<AppEnv> {
  const { config, kv, auth, friends } = deps;
  const app = new Hono<AppEnv>();
  app.use(requireAuth(auth));
  const write = (userId: string) => enforceRateLimit(kv, LIMITS.friendWrite, userId);

  app.get('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.friendsRead, userId);
    return c.json(await friends.list(userId));
  });

  app.post('/requests', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.friendLookup, userId);
    await enforceRateLimit(kv, LIMITS.friendLookupIp, clientRateLimitKey(c, config));
    const body = await readJson(c, RequestBody);
    const result = await friends.request(userId, body);
    c.get('log').info({ userId, status: result.status }, 'friend request');
    return c.json(result);
  });

  app.post('/requests/:id/accept', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    return c.json({ friend: await friends.accept(userId, userParam(c.req.param('id'))) });
  });

  app.post('/requests/:id/decline', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    await friends.decline(userId, userParam(c.req.param('id')));
    return c.body(null, 204);
  });

  app.delete('/requests/:id', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    await friends.cancel(userId, userParam(c.req.param('id')));
    return c.body(null, 204);
  });

  app.post('/blocks', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    const body = await readJson(c, BlockBody);
    await friends.block(userId, body.id);
    return c.body(null, 204);
  });

  app.delete('/blocks/:id', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    await friends.unblock(userId, userParam(c.req.param('id')));
    return c.body(null, 204);
  });

  app.post('/code', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    return c.json({ code: formatFriendCode(await friends.rotateCode(userId)) });
  });

  app.delete('/:id', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    await friends.remove(userId, userParam(c.req.param('id')));
    return c.body(null, 204);
  });

  return app;
}
