/**
 * /invites and /party (docs/07 §13):
 *
 *   GET  /invites                    → { incoming: Invite[], sent: Invite[], now }  (the last 2 minutes; `now` = the server's clock)
 *   POST /invites { to, room? }      → 201 { invite }  (room: default the one you're in)
 *   POST /invites/:id/accept         → { invite, room, party }  (then join `room` the usual way)
 *   POST /invites/:id/decline        → 204
 *   GET  /party                      → { party: PartyView | null }
 *   POST /party/leave                → 204
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import { USER_ID } from '../friends/service';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import type { PartyService } from './party';
import type { InviteService } from './service';

const SendBody = z.strictObject({ to: z.string().regex(USER_ID), room: z.string().max(16).nullable().optional() });
const INVITE_ID = /^i_[\w-]{12}$/;

function inviteParam(raw: string): string {
  if (!INVITE_ID.test(raw)) throw new ApiError(400, 'invalid_invite_id', 'Not an invite id');
  return raw;
}

export function inviteRoutes(deps: { kv: Kv; auth: AuthService; invites: InviteService; now: () => number }): Hono<AppEnv> {
  const { kv, auth, invites, now } = deps;
  const app = new Hono<AppEnv>();
  app.use(requireAuth(auth));

  app.get('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.friendsRead, userId);
    const [incoming, sent] = await Promise.all([invites.incoming(userId), invites.sent(userId)]);
    // the server's clock: a phone whose clock is off still counts the 2 minutes down right
    return c.json({ incoming, sent, now: new Date(now()).toISOString() });
  });

  app.post('/', async (c) => {
    const { userId } = c.get('auth')!;
    const body = await readJson(c, SendBody);
    await enforceRateLimit(kv, LIMITS.inviteSend, userId);
    const invite = await invites.send(userId, body.to, body.room ?? null);
    c.get('log').info({ userId, to: body.to, room: invite.room }, 'invite sent');
    return c.json({ invite }, 201);
  });

  app.post('/:id/accept', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.friendWrite, userId);
    return c.json(await invites.accept(userId, inviteParam(c.req.param('id'))));
  });

  app.post('/:id/decline', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.friendWrite, userId);
    await invites.decline(userId, inviteParam(c.req.param('id')));
    return c.body(null, 204);
  });

  return app;
}

export function partyRoutes(deps: { kv: Kv; auth: AuthService; party: PartyService }): Hono<AppEnv> {
  const { kv, auth, party } = deps;
  const app = new Hono<AppEnv>();
  app.use(requireAuth(auth));

  app.get('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.friendsRead, userId);
    return c.json({ party: await party.view(userId) });
  });

  app.post('/leave', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.friendWrite, userId);
    await party.leave(userId);
    return c.body(null, 204);
  });

  return app;
}
