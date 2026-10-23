/**
 * GET /events: the social push channel, Server-Sent Events from the API (the owner's 23 Oct ask:
 * invites must land at once, and a 30 s presence beat is too slow).
 *
 * Why SSE from the API, not the game socket: invites, requests and presence matter most in the
 * menus, where no game connection exists, and the API already owns friends, rooms and presence.
 * It's one long HTTP response through the same Caddy route as every API call (/api/*): no new
 * port, process or service. `Cache-Control: no-transform` keeps Caddy's site-wide `encode` off it,
 * and Caddy's reverse_proxy flushes text/event-stream at once. Phones on 4G keep it alive with a
 * comment every 20 s (carrier NATs drop idle flows after ~30–60 s).
 *
 * Auth is the usual Bearer token in a header (the web client reads the stream with fetch, not
 * EventSource, so the token never goes in a URL). The stream ends when the token expires (15 min)
 * and the client opens a new one with a fresh token; a revoked session ends at its next expiry.
 *
 *   event: hello            data: { at, until }
 *   event: <SocialEvent.type> data: <SocialEvent JSON>   (events/bus.ts)
 *   : ping                  (keep-alive comment)
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AuthService } from '../auth/sessions';
import type { AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import type { EventBus } from './bus';

export const KEEPALIVE_MS = 20_000;
/** streams one player may hold open on one API process (tabs, devices) */
export const MAX_STREAMS = 4;
/** a stream outlives its token by this much, so a client reconnecting a little late misses nothing */
const TOKEN_GRACE_MS = 5_000;

export function eventRoutes(deps: { auth: AuthService; kv: Kv; bus: EventBus; now: () => number }): Hono<AppEnv> {
  const { auth, kv, bus, now } = deps;
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    const claims = m ? auth.verifyAccessToken(m[1]!) : null;
    if (!claims) throw new ApiError(401, 'invalid_token', 'Access token is invalid or expired', {}, { 'WWW-Authenticate': 'Bearer' });
    if (!(await auth.sessionActive(claims.sid, claims.sub))) throw new ApiError(401, 'session_revoked', 'This session has ended');
    const userId = claims.sub;
    await enforceRateLimit(kv, LIMITS.eventsConnect, userId);
    if (bus.listeners(userId) >= MAX_STREAMS) throw new ApiError(429, 'too_many_streams', 'Too many open event streams for this player', { retryAfter: 30 }, { 'Retry-After': '30' });
    const until = claims.exp * 1000 + TOKEN_GRACE_MS;

    const res = streamSSE(c, async (stream) => {
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
      const stop = bus.subscribe(userId, (event) => void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }));
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
      }
    });
    // keep Caddy's `encode` off the stream (it flushes, but a compressor still holds partial frames).
    // Set through the context: Hono copies the context's headers onto the response it returns.
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return res;
  });

  return app;
}
