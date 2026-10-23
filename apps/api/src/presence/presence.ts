/**
 * Presence (docs/06 §7 `presence:{userId}`, docs/07 §7): who's around, kept in Valkey with a 60 s
 * life. The web client says it's here every 30 s while its page is visible (PUT /me/presence), and
 * the API notes it whenever a player makes or joins a room; a player whose beats stop goes offline by
 * themselves. Being in Valkey, it survives an API restart.
 *
 *   PUT    /me/presence { room?: CODE | null } → { status, room, lastSeenAt }   (your own view)
 *   DELETE /me/presence                         → 204 (page closed, signed out: offline now)
 *   GET    /players/:id/presence               → { status: offline | online | in_room, room, lastSeenAt }
 *
 * Presence is private (23 Oct): only you and your friends see it. Friends see the room's code too
 * (a code is an invitation, and friends are who you'd invite); anyone else gets 403 `not_friends`,
 * so nobody can watch a stranger come and go. The friends list (friends/) reads it in one round trip.
 */
import { normalizeRoomCode } from '@military-forge/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
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
  private changed: ((userId: string, now: PresenceView) => Promise<void> | void) | null = null;

  constructor(
    private readonly kv: Kv,
    private readonly now: () => number,
  ) {}

  /**
   * Called when a player's status or room changes (not on every beat): the push channel tells their
   * friends at once (app.ts). Going offline by silence (the 60 s life running out) isn't seen here;
   * friends' lists catch that up when they next load.
   */
  onChange(listener: (userId: string, now: PresenceView) => Promise<void> | void): void {
    this.changed = listener;
  }

  /** `room`: a room code the player is in (only kept when that room exists). */
  async beat(userId: string, room: string | null): Promise<PresenceRecord> {
    const code = room ? normalizeRoomCode(room) : null;
    const inRoom = code !== null && (await this.kv.get(`room:${code}`)) !== null;
    const record: PresenceRecord = { status: inRoom ? 'in_room' : 'online', room: inRoom ? code : null, ts: new Date(this.now()).toISOString() };
    const before = this.changed ? await this.get(userId) : null;
    await this.kv.set(presenceKey(userId), JSON.stringify(record), { ttlMs: PRESENCE_TTL_MS });
    if (before && (before.status !== record.status || before.room !== record.room)) await this.tellChange(userId, { status: record.status, room: record.room, lastSeenAt: record.ts });
    return record;
  }

  private async tellChange(userId: string, view: PresenceView): Promise<void> {
    try {
      await this.changed?.(userId, view);
    } catch {
      /* presence is a hint: a failed notice never fails the beat */
    }
  }

  async clear(userId: string): Promise<void> {
    if ((await this.kv.del(presenceKey(userId))) && this.changed) await this.tellChange(userId, { status: 'offline', room: null, lastSeenAt: null });
  }

  async get(userId: string): Promise<PresenceView> {
    return parsePresence(await this.kv.get(presenceKey(userId)));
  }

  /** Several players' presence in one round trip, in order. */
  async getMany(userIds: readonly string[]): Promise<PresenceView[]> {
    if (!userIds.length) return [];
    return (await this.kv.mget(userIds.map(presenceKey))).map(parsePresence);
  }
}

export interface PresenceView {
  status: PresenceStatus;
  room: string | null;
  lastSeenAt: string | null;
}

function parsePresence(raw: string | null): PresenceView {
  if (!raw) return { status: 'offline', room: null, lastSeenAt: null };
  try {
    const r = JSON.parse(raw) as PresenceRecord;
    return { status: r.status === 'in_room' ? 'in_room' : 'online', room: r.room ?? null, lastSeenAt: r.ts ?? null };
  } catch {
    return { status: 'offline', room: null, lastSeenAt: null };
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

export function playerPresenceRoute(deps: { auth: AuthService; presence: PresenceService; areFriends: (a: string, b: string) => Promise<boolean> }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requireAuth(deps.auth));
  app.get('/:userId/presence', async (c) => {
    const id = c.req.param('userId');
    const self = c.get('auth')!.userId;
    const who = id === 'me' ? self : id;
    // private: yourself and your friends only (a stranger can't tell whether you exist, either)
    if (who !== self && !(await deps.areFriends(self, who))) throw new ApiError(403, 'not_friends', "Only friends see each other's status");
    const p = await deps.presence.get(who);
    return c.json({ status: p.status, room: p.room, lastSeenAt: p.lastSeenAt });
  });
  return app;
}
