/**
 * Presence (docs/06 §7 `presence:{userId}`, docs/07 §7): who's around, kept in Valkey with a 60 s
 * life. The web client says it's here every 30 s while its page is visible (PUT /me/presence), and
 * the API notes it whenever a player makes or joins a room; a player whose beats stop goes offline by
 * themselves. Being in Valkey, it survives an API restart.
 *
 *   PUT    /me/presence { room?: CODE | null } → { status, room, lastSeenAt }   (your own view)
 *   DELETE /me/presence                         → 204 (page closed, signed out: offline now)
 *   GET    /players/:id/presence               → { status: offline | online | in_room, lastSeenAt }
 *
 * Others see whether you're in a room, never which: a room code lets anyone in. Friends will see
 * more once friends exist.
 */
import { normalizeRoomCode } from '@military-forge/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { AppEnv } from '../http/context';
import { readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';

export const PRESENCE_TTL_MS = 60_000;

export type PresenceStatus = 'offline' | 'online' | 'in_room';

interface PresenceRecord {
  status: 'online' | 'in_room';
  room: string | null;
  ts: string;
}

export const presenceKey = (userId: string) => `presence:${userId}`;

export class PresenceService {
  constructor(
    private readonly kv: Kv,
    private readonly now: () => number,
  ) {}

  /** `room`: a room code the player is in (only kept when that room exists). */
  async beat(userId: string, room: string | null): Promise<PresenceRecord> {
    const code = room ? normalizeRoomCode(room) : null;
    const inRoom = code !== null && (await this.kv.get(`room:${code}`)) !== null;
    const record: PresenceRecord = { status: inRoom ? 'in_room' : 'online', room: inRoom ? code : null, ts: new Date(this.now()).toISOString() };
    await this.kv.set(presenceKey(userId), JSON.stringify(record), { ttlMs: PRESENCE_TTL_MS });
    return record;
  }

  async clear(userId: string): Promise<void> {
    await this.kv.del(presenceKey(userId));
  }

  async get(userId: string): Promise<{ status: PresenceStatus; room: string | null; lastSeenAt: string | null }> {
    const raw = await this.kv.get(presenceKey(userId));
    if (!raw) return { status: 'offline', room: null, lastSeenAt: null };
    try {
      const r = JSON.parse(raw) as PresenceRecord;
      return { status: r.status === 'in_room' ? 'in_room' : 'online', room: r.room ?? null, lastSeenAt: r.ts ?? null };
    } catch {
      return { status: 'offline', room: null, lastSeenAt: null };
    }
  }
}

const Beat = z.strictObject({ room: z.string().max(16).nullable().optional() });

export function mePresenceRoutes(deps: { auth: AuthService; kv: Kv; presence: PresenceService }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requireAuth(deps.auth));
  app.put('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(deps.kv, LIMITS.presence, userId);
    const body = await readJson(c, Beat);
    const r = await deps.presence.beat(userId, body.room ?? null);
    return c.json({ status: r.status, room: r.room, lastSeenAt: r.ts });
  });
  app.delete('/', async (c) => {
    await deps.presence.clear(c.get('auth')!.userId);
    return c.body(null, 204);
  });
  return app;
}

export function playerPresenceRoute(deps: { auth: AuthService; presence: PresenceService }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requireAuth(deps.auth));
  app.get('/:userId/presence', async (c) => {
    const id = c.req.param('userId');
    const self = c.get('auth')!.userId;
    const p = await deps.presence.get(id === 'me' ? self : id);
    // the room only for yourself: a code is an invitation
    return c.json({ status: p.status, lastSeenAt: p.lastSeenAt, ...(id === 'me' || id === self ? { room: p.room } : {}) });
  });
  return app;
}
