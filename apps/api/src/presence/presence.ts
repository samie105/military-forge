/**
 * Presence (docs/06 §7 `presence:{userId}`, docs/07 §7): who's around, kept in Valkey with a 60 s
 * life. The web client says it's here every 30 s while its page is visible (PUT /me/presence), and
 * the API notes it whenever a player makes or joins a room; a player whose beats stop goes offline by
 * themselves. Being in Valkey, it survives an API restart.
 *
 *   PUT    /me/presence { room?: CODE | null, playing?: boolean } → { status, room, lastSeenAt, playing? }   (your own view)
 *   DELETE /me/presence                         → 204 (page closed, signed out: offline now)
 *   GET    /players/:id/presence               → { status: offline | online | in_room, room, lastSeenAt, playing? }
 *
 * `playing` (31 Oct, audit C-27): in a room, whether a match is on (the countdown to the scoreboard) or
 * the room is in its lobby, so a host waiting for friends doesn't show as "In a match". Pages from
 * before it don't send it, and their room shows without either.
 *
 * Presence is private (23 Oct): only you and your friends see it. Friends see the room's code too
 * (a code is an invitation, and friends are who you'd invite); anyone else gets 403 `not_friends`,
 * so nobody can watch a stranger come and go. The friends list (friends/) reads it in one round trip.
 *
 * Appear offline (Online now, 1 Nov 2026): a player who chose it is still in their room for the
 * rooms' own counts, but everyone else sees them offline (`visible` / `getManyVisible`), and they are
 * left out of the online count. The online count and "played today" are sorted sets of user ids
 * (ONLINE_KEY by last beat, PLAYED_KEY by last time in a room): numbers only, never who.
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
/** who beat lately (score: the beat's time); counted for Online now, never listed */
export const ONLINE_KEY = 'online:people';
/** who was in a room lately (score: when), for "N played today" */
export const PLAYED_KEY = 'online:played';
export const PLAYED_WINDOW_MS = 24 * 3600_000;
/** most ids a count reads (far more players than there are; a cap on the work) */
const COUNT_CAP = 20_000;

export type PresenceStatus = 'offline' | 'online' | 'in_room';

interface PresenceRecord {
  status: 'online' | 'in_room';
  room: string | null;
  ts: string;
  /** in_room: a match is on (absent: the page didn't say) */
  playing?: boolean;
  /** the player chose Appear offline: others see them offline */
  hidden?: true;
}

export const presenceKey = (userId: string) => `presence:${userId}`;

export class PresenceService {
  private changed: ((userId: string, now: PresenceView) => Promise<void> | void) | null = null;

  constructor(
    private readonly kv: Kv,
    private readonly now: () => number,
    /** whether the player chose Appear offline (the profile; null: nobody ever is) */
    private readonly isHidden: ((userId: string) => Promise<boolean>) | null = null,
  ) {}

  /**
   * Called when a player's status or room changes (not on every beat): the push channel tells their
   * friends at once (app.ts). Going offline by silence (the 60 s life running out) isn't seen here;
   * friends' lists catch that up when they next load.
   */
  onChange(listener: (userId: string, now: PresenceView) => Promise<void> | void): void {
    this.changed = listener;
  }

  /** `room`: a room code the player is in (only kept when that room exists); `playing`: a match is on in it. */
  async beat(userId: string, room: string | null, playing?: boolean): Promise<PresenceRecord> {
    const code = room ? normalizeRoomCode(room) : null;
    const inRoom = code !== null && (await this.kv.get(`room:${code}`)) !== null;
    const hidden = this.isHidden ? await this.isHidden(userId).catch(() => false) : false;
    const record: PresenceRecord = {
      status: inRoom ? 'in_room' : 'online',
      room: inRoom ? code : null,
      ts: new Date(this.now()).toISOString(),
      ...(inRoom && playing !== undefined ? { playing } : {}),
      ...(hidden ? { hidden: true as const } : {}),
    };
    const before = this.changed ? visibleView(await this.kv.get(presenceKey(userId))) : null;
    await this.kv.set(presenceKey(userId), JSON.stringify(record), { ttlMs: PRESENCE_TTL_MS });
    const at = this.now();
    if (hidden) await this.kv.zrem(ONLINE_KEY, [userId]);
    else await this.kv.zadd(ONLINE_KEY, [{ member: userId, score: at }]);
    if (inRoom) await this.kv.zadd(PLAYED_KEY, [{ member: userId, score: at }]);
    // what friends see changed (Appear offline shows them an offline friend)
    const after = visibleView(JSON.stringify(record));
    if (before && (before.status !== after.status || before.room !== after.room || before.playing !== after.playing)) await this.tellChange(userId, after);
    return record;
  }

  /** Appear offline turned on or off: friends see the change at once, and the count follows. */
  async refreshHidden(userId: string): Promise<void> {
    const raw = await this.kv.get(presenceKey(userId));
    if (!raw) return;
    const now = parsePresence(raw);
    await this.beat(userId, now.room, now.playing);
  }

  private async tellChange(userId: string, view: PresenceView): Promise<void> {
    try {
      await this.changed?.(userId, view);
    } catch {
      /* presence is a hint: a failed notice never fails the beat */
    }
  }

  async clear(userId: string): Promise<void> {
    await this.kv.zrem(ONLINE_KEY, [userId]);
    if ((await this.kv.del(presenceKey(userId))) && this.changed) await this.tellChange(userId, { status: 'offline', room: null, lastSeenAt: null });
  }

  /** A player's presence as it is (the rooms' own counts: Appear offline still plays in its room). */
  async get(userId: string): Promise<PresenceView> {
    return parsePresence(await this.kv.get(presenceKey(userId)));
  }

  /** Several players' presence in one round trip, in order (as it is: see getManyVisible for what others see). */
  async getMany(userIds: readonly string[]): Promise<PresenceView[]> {
    if (!userIds.length) return [];
    return (await this.kv.mget(userIds.map(presenceKey))).map(parsePresence);
  }

  /** A player's presence as other people see it: offline when they chose Appear offline. */
  async visible(userId: string): Promise<PresenceView> {
    return visibleView(await this.kv.get(presenceKey(userId)));
  }

  /** Several players' presence as other people see it, in order. */
  async getManyVisible(userIds: readonly string[]): Promise<PresenceView[]> {
    if (!userIds.length) return [];
    return (await this.kv.mget(userIds.map(presenceKey))).map(visibleView);
  }

  /** The ids that beat in the last minute and didn't choose Appear offline (never shown: counted, or filtered further). */
  async onlineIds(): Promise<string[]> {
    return liveMembers(this.kv, ONLINE_KEY, this.now() - PRESENCE_TTL_MS);
  }

  /** How many people were in a room in the last 24 hours. */
  async playedToday(): Promise<number> {
    return (await liveMembers(this.kv, PLAYED_KEY, this.now() - PLAYED_WINDOW_MS)).length;
  }
}

/**
 * The members of a sorted set scored at or after `since` (the older ones are dropped from it as they
 * are found): "who's on" without scanning keys.
 */
export async function liveMembers(kv: Kv, key: string, since: number): Promise<string[]> {
  const all = await kv.ztop(key, COUNT_CAP);
  const live: string[] = [];
  const stale: string[] = [];
  for (const e of all) (e.score >= since ? live : stale).push(e.member);
  if (stale.length) await kv.zrem(key, stale);
  return live;
}

export interface PresenceView {
  status: PresenceStatus;
  room: string | null;
  lastSeenAt: string | null;
  /** in_room: a match is on (true) or the room is in its lobby (false); absent when the page didn't say */
  playing?: boolean;
}

/** What others see: an Appear offline player is offline. */
function visibleView(raw: string | null): PresenceView {
  if (raw) {
    try {
      if ((JSON.parse(raw) as PresenceRecord).hidden) return { status: 'offline', room: null, lastSeenAt: null };
    } catch {
      /* parsePresence says offline */
    }
  }
  return parsePresence(raw);
}

function parsePresence(raw: string | null): PresenceView {
  if (!raw) return { status: 'offline', room: null, lastSeenAt: null };
  try {
    const r = JSON.parse(raw) as PresenceRecord;
    const inRoom = r.status === 'in_room';
    return { status: inRoom ? 'in_room' : 'online', room: r.room ?? null, lastSeenAt: r.ts ?? null, ...(inRoom && typeof r.playing === 'boolean' ? { playing: r.playing } : {}) };
  } catch {
    return { status: 'offline', room: null, lastSeenAt: null };
  }
}

const Beat = z.strictObject({ room: z.string().max(16).nullable().optional(), playing: z.boolean().optional() });

export function mePresenceRoutes(deps: { auth: AuthService; kv: Kv; presence: PresenceService }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requireAuth(deps.auth));
  app.put('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(deps.kv, LIMITS.presence, userId);
    const body = await readJson(c, Beat);
    const r = await deps.presence.beat(userId, body.room ?? null, body.playing);
    return c.json({ status: r.status, room: r.room, lastSeenAt: r.ts, ...(r.playing !== undefined ? { playing: r.playing } : {}) });
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
    const p = who === self ? await deps.presence.get(who) : await deps.presence.visible(who);
    return c.json({ status: p.status, room: p.room, lastSeenAt: p.lastSeenAt, ...(p.playing !== undefined ? { playing: p.playing } : {}) });
  });
  return app;
}
