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
 *   POST   /friends/blocks { id } | { name } → 204 (anyone, friend or not; also ends a friendship and requests)
 *   DELETE /friends/blocks/:id           → 204
 *   POST   /friends/code                 → { code } (a new friend code; the old one stops working)
 *   GET    /friends/search?q=            → { players: FoundPlayer[] } (names starting with q, closest first, at most 8)
 *   GET    /friends/recent               → { players: FoundPlayer[] } (played with recently, not friends yet)
 *   PUT    /friends/settings { findable?, requestsFrom? } → { findable, requestsFrom }
 *          ("Let players find me by name"; who may send you requests: 'anyone' | 'played' | 'code')
 *
 * An account whose device said under 18 gets 403 `adults_only` from every route (audit-2 L-03).
 *
 * Search (31 Oct) answers as you type, so its limits are wider than Add a friend's, but they still
 * stop a sweep: a few dozen searches a minute and a couple of hundred an hour per player, more per IP
 * (many players share one behind a carrier's NAT), at most 8 names each, and only players who let
 * themselves be found.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { adultsOnly, requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { REQUESTS_FROM } from '../db/schema';
import { clientRateLimitKey } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import { formatFriendCode } from './code';
import { USER_ID, searchKey, type FriendsService } from './service';

const RequestBody = z.union([z.strictObject({ name: z.string().min(1).max(64) }), z.strictObject({ code: z.string().min(1).max(32) })]);
/** a block by id (the friends panel's rows), or by exact name (a room's rows: the scoreboard, the lobby, voice) */
const BlockBody = z.union([z.strictObject({ id: z.string().regex(USER_ID) }), z.strictObject({ name: z.string().min(1).max(64) })]);
const SettingsBody = z
  .strictObject({ findable: z.boolean().optional(), requestsFrom: z.enum(REQUESTS_FROM).optional() })
  .refine((b) => b.findable !== undefined || b.requestsFrom !== undefined, 'Nothing to change');

function userParam(raw: string): string {
  if (!USER_ID.test(raw)) throw new ApiError(400, 'invalid_player_id', 'Not a player id');
  return raw;
}

export function friendRoutes(deps: { config: Config; db: Db; kv: Kv; auth: AuthService; friends: FriendsService }): Hono<AppEnv> {
  const { config, db, kv, auth, friends } = deps;
  const app = new Hono<AppEnv>();
  app.use(requireAuth(auth));
  app.use(adultsOnly(db));
  const write = (userId: string) => enforceRateLimit(kv, LIMITS.friendWrite, userId);

  app.get('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.friendsRead, userId);
    return c.json(await friends.list(userId));
  });

  app.get('/search', async (c) => {
    const { userId } = c.get('auth')!;
    const q = (c.req.query('q') ?? '').trim();
    if (q.length > 32) throw new ApiError(400, 'invalid_query', 'Search for at most 32 letters');
    // too short to search: answered without a lookup, so it costs nothing
    if (!searchKey(q)) return c.json({ players: [] });
    await enforceRateLimit(kv, LIMITS.friendSearch, userId);
    await enforceRateLimit(kv, LIMITS.friendSearchHour, userId);
    await enforceRateLimit(kv, LIMITS.friendSearchIp, clientRateLimitKey(c, config));
    return c.json({ players: await friends.search(userId, q) });
  });

  app.get('/recent', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.friendsRead, userId);
    return c.json({ players: await friends.recent(userId) });
  });

  app.put('/settings', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    const body = await readJson(c, SettingsBody);
    return c.json(await friends.setSettings(userId, body));
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
    let id: string;
    if ('id' in body) id = body.id;
    else {
      // by name: the same lookup (and limits) as a request by name, so it can't sweep the player list
      await enforceRateLimit(kv, LIMITS.friendLookup, userId);
      const found = await friends.find({ name: body.name });
      if (!found) throw new ApiError(404, 'player_not_found', 'No player has that name');
      id = found.id;
    }
    await friends.block(userId, id);
    c.get('log').info({ userId, by: 'id' in body ? 'id' : 'name' }, 'player blocked');
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
