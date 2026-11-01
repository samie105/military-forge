/**
 * /lobby: the Lobby feed on Home (feed.ts stores it; @military-forge/shared lobbyFeed.ts is the
 * contract). Every route needs a session and is adults only: an under-18 account sees nothing.
 * Guests read and send quick chat.
 *
 *   GET  /lobby           { entries, now, lastMatchAt, fightNight, me: { mute, freeText } }
 *                         the newest 100 lines, oldest first; `me.mute` is the owner's chat mute
 *                         ({ until, reason }) shown to the muted player; `me.freeText.on` false =
 *                         no text box (CHAT_FREE_TEXT off)
 *   GET  /lobby/head      { id, at }  the newest line (Home's unread dot; cheap)
 *   POST /lobby/messages  { quick, replyTo? } | { text, replyTo? }
 *                         201 { entry } · 200 { dropped: 'repeat' } (the same words again within a
 *                         minute) · 403 chat_muted { until, reason } · 403 free_text_off ·
 *                         403 free_text_locked { needs } · 400 empty|too_long|link|digits|refused ·
 *                         429 slow_down (one every 3 s) / rate_limited (10 a minute, 100 an hour)
 *   POST /lobby/rules     free text's rules accepted (only while CHAT_FREE_TEXT is on)
 *   GET  /lobby/events    SSE, the `lobby` topic: `lobby_entry` { entry }, `lobby_remove` { id }.
 *                         The web opens it only while the feed panel is open (phones' data).
 */
import { createHash } from 'node:crypto';
import { LOBBY_CHANNEL, LOBBY_LIMITS, fightNightWindow, isQuickChatId, type QuickChatId } from '@military-forge/shared';
import { and, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { adultsOnly, requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { chatMutes, profiles, users } from '../db/schema';
import type { EventBus } from '../events/bus';
import { KEEPALIVE_MS } from '../events/routes';
import { clientRateLimitKey } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import { LobbyFeed } from './feed';
import { checkChatText, cleanChatText } from './filter';
import { freeTextGate } from './gate';

/** live streams one player may hold open on one API process */
export const MAX_LOBBY_STREAMS = 2;
const TOKEN_GRACE_MS = 5_000;

const ReplyTo = z.string().regex(/^\d{1,18}$/).optional();
const MessageBody = z.union([
  z.strictObject({ quick: z.string().max(32), replyTo: ReplyTo }),
  z.strictObject({ text: z.string().max(LOBBY_LIMITS.textMax * 4), replyTo: ReplyTo }),
]);

export interface LobbyDeps {
  config: Config;
  db: Db;
  kv: Kv;
  auth: AuthService;
  bus: EventBus;
  feed: LobbyFeed;
  now: () => number;
}

/** The owner's chat mute on this player, if it's still running. */
export async function activeChatMute(db: Db, userId: string, now: number): Promise<{ until: string; reason: string } | null> {
  const [row] = await db
    .select({ until: chatMutes.until, reason: chatMutes.reason })
    .from(chatMutes)
    .where(and(eq(chatMutes.userId, userId), gt(chatMutes.until, new Date(now))));
  return row ? { until: row.until.toISOString(), reason: row.reason } : null;
}

export function lobbyRoutes(deps: LobbyDeps): Hono<AppEnv> {
  const { config, db, kv, auth, bus, feed, now } = deps;
  const app = new Hono<AppEnv>();
  const streams = new Map<string, number>();

  // the live stream reads its token itself (below): the usual middleware for the rest
  app.use('/', requireAuth(auth), adultsOnly(db));
  app.use('/head', requireAuth(auth), adultsOnly(db));
  app.use('/messages', requireAuth(auth), adultsOnly(db));
  app.use('/rules', requireAuth(auth), adultsOnly(db));

  app.get('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.lobbyRead, userId);
    const at = now();
    const [entries, lastMatchAt, mute, freeText] = await Promise.all([feed.list(userId), feed.lastMatchAt(), activeChatMute(db, userId, at), freeTextGate(db, config, userId, at)]);
    const fn = fightNightWindow(at);
    return c.json({
      entries,
      now: new Date(at).toISOString(),
      lastMatchAt,
      fightNight: { kind: 'fight_night', startsAt: new Date(fn.startsAt).toISOString(), endsAt: new Date(fn.endsAt).toISOString(), live: fn.live, at: new Date(fn.startsAt).toISOString() },
      me: { mute, freeText },
    });
  });

  app.get('/head', async (c) => {
    await enforceRateLimit(kv, LIMITS.lobbyRead, c.get('auth')!.userId);
    return c.json(await feed.head());
  });

  app.post('/messages', async (c) => {
    const { userId } = c.get('auth')!;
    const body = await readJson(c, MessageBody);
    const at = now();
    const mute = await activeChatMute(db, userId, at);
    if (mute) throw new ApiError(403, 'chat_muted', `You can't post in the Lobby until ${mute.until}: ${mute.reason}`, mute);

    let say: { quick: QuickChatId } | { text: string };
    let repeatKey: string;
    if ('quick' in body) {
      if (!isQuickChatId(body.quick)) throw new ApiError(400, 'unknown_phrase', 'Pick a phrase from the list');
      say = { quick: body.quick };
      repeatKey = body.quick;
    } else {
      const gate = await freeTextGate(db, config, userId, at);
      if (!gate.on) throw new ApiError(403, 'free_text_off', 'The Lobby takes quick chat only');
      if (!gate.allowed) throw new ApiError(403, 'free_text_locked', 'You can’t type in the Lobby yet', { needs: gate.needs });
      const verdict = checkChatText(body.text);
      if (!verdict.ok) throw new ApiError(400, verdict.code, verdict.message);
      say = { text: verdict.text };
      repeatKey = createHash('sha256').update(cleanChatText(body.text).toLowerCase()).digest('base64url').slice(0, 22);
    }

    // the same words again inside a minute go nowhere (and cost nothing)
    const rep = `lobby:rep:${userId}:${repeatKey}`;
    if ((await kv.get(rep)) !== null) return c.json({ dropped: 'repeat' });
    // one every 3 s: a key that outlives the gap, not a window that resets
    if (!(await kv.set(`lobby:gap:${userId}`, '1', { ttlMs: LOBBY_LIMITS.gapMs, onlyIfAbsent: true }))) {
      throw new ApiError(429, 'slow_down', 'One message every 3 seconds', { retryAfter: Math.ceil(LOBBY_LIMITS.gapMs / 1000) }, { 'Retry-After': String(Math.ceil(LOBBY_LIMITS.gapMs / 1000)) });
    }
    await enforceRateLimit(kv, LIMITS.lobbyMinute, userId);
    await enforceRateLimit(kv, LIMITS.lobbyHour, userId);
    await enforceRateLimit(kv, LIMITS.lobbyIp, clientRateLimitKey(c, config));
    await kv.set(rep, '1', { ttlMs: LOBBY_LIMITS.repeatMs });

    const [me] = await db.select({ nickname: profiles.nickname }).from(profiles).where(eq(profiles.userId, userId));
    if (!me) throw new ApiError(404, 'not_found', 'Account not found');
    const entry = await feed.say({ id: userId, name: me.nickname }, say, body.replyTo ?? null);
    c.get('log').info({ userId, quick: 'quick' in say ? say.quick : null }, 'lobby message');
    return c.json({ entry }, 201);
  });

  app.post('/rules', async (c) => {
    const { userId } = c.get('auth')!;
    if (!config.chat.freeText) throw new ApiError(403, 'free_text_off', 'The Lobby takes quick chat only');
    await db.update(users).set({ chatRulesAt: new Date(now()) }).where(eq(users.id, userId));
    return c.json(await freeTextGate(db, config, userId, now()));
  });

  app.get('/events', async (c) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    const claims = m ? auth.verifyAccessToken(m[1]!) : null;
    if (!claims) throw new ApiError(401, 'invalid_token', 'Access token is invalid or expired', {}, { 'WWW-Authenticate': 'Bearer' });
    if (!(await auth.sessionActive(claims.sid, claims.sub))) throw new ApiError(401, 'session_revoked', 'This session has ended');
    const userId = claims.sub;
    const [u] = await db.select({ minor: users.minor }).from(users).where(eq(users.id, userId));
    if (u?.minor) throw new ApiError(403, 'adults_only', 'The Lobby is for players 18 and over.');
    await enforceRateLimit(kv, LIMITS.lobbyConnect, userId);
    if ((streams.get(userId) ?? 0) >= MAX_LOBBY_STREAMS) throw new ApiError(429, 'too_many_streams', 'Too many open Lobby streams', { retryAfter: 30 }, { 'Retry-After': '30' });
    const until = claims.exp * 1000 + TOKEN_GRACE_MS;
    const hidden = await feed.blockedBetween(userId);

    const res = streamSSE(c, async (stream) => {
      streams.set(userId, (streams.get(userId) ?? 0) + 1);
      let wake: (() => void) | null = null;
      const nap = (ms: number) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
      stream.onAbort(() => wake?.());
      const stop = bus.subscribeTopic(LOBBY_CHANNEL, (event) => {
        if (event.type === 'entry' && !LobbyFeed.visibleTo(event.entry, hidden)) return;
        void stream.writeSSE({ event: `lobby_${event.type}`, data: JSON.stringify(event) });
      });
      try {
        await stream.writeSSE({ event: 'hello', data: JSON.stringify({ at: new Date(now()).toISOString(), until: new Date(until).toISOString() }), retry: 3000 });
        while (!stream.aborted) {
          const left = until - now();
          if (left <= 0) break;
          await nap(Math.min(KEEPALIVE_MS, left));
          if (!stream.aborted) await stream.write(': ping\n\n');
        }
      } finally {
        stop();
        const n = (streams.get(userId) ?? 1) - 1;
        if (n > 0) streams.set(userId, n);
        else streams.delete(userId);
      }
    });
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return res;
  });

  return app;
}
